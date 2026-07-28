// ========== 回测·因子：高倍区间挖掘 + 梯形打分 + 回测 + 策略代码生成 ==========
//
// 目标：把"20 条硬条件 AND"式策略改造成"加权梯形打分"。流程是——
//   1) 逐字段找出高倍盘（returnMax > 阈值）集中的取值区间（findHotInterval）；
//   2) 由区间推导梯形打分函数（deriveTrapezoid），按 |AUC-0.5| 自动配权（autoWeights）；
//   3) 对样本打分回测：十分位、阈值扫描、时间外推验证（runOOSBacktest）；
//   4) 把因子映射回原始 ctx 路径，生成可直接粘贴进实盘策略的打分代码（generateStrategyCode）。
//
// 口径约定（与库内其它模块保持一致，改动前先看清依赖）：
//   - "高倍" = returnMax > winThreshold，严格大于——collectAucSamples/winRateOf/buildBins 全是 >，
//     这里若用 >= 会在阈值恰好落在样本值上时与 AUC 面板对不上。
//   - 缺失值（字段值为 null/undefined/空串/非数值）一律记 0 分，不做均值填充——
//     生成的策略代码必须复刻同一语义（见 generateStrategyCode 里的 V()）。
import { percentile, wilsonInterval, spearman, splitTrainTest, median, WIN_THRESHOLD, benjaminiHochbergAdjust, mulberry32 } from './utils.js';
import { collectAucSamples, scanFieldsAuc } from './auc.js';
import { getFeature, isAssembledField, isKlineVolumeField, PERCENT_FRACTION_FIELDS } from './data.js';

export const FACTOR_WIN_THRESHOLDS = [2, 3, 5, 10];
export const DEFAULT_FACTOR_WIN_THRESHOLD = 5;

// ---------- 时间切分 ----------
// 镜像 analytics.js mineBreakpointsOOS 的锚点语义：优先开仓时间，退回买入时刻，都没有的排最后。
// 不用 utils.splitTrainTest——它只认单一 timeField，没有这条回退链。
function timeAnchor(r) {
  return Number.isFinite(r.swapBeginTime) ? r.swapBeginTime
       : (Number.isFinite(r.buyTimestamp) ? r.buyTimestamp : Infinity);
}

export function splitRowsByTime(rows, trainRatio = 0.7) {
  const ordered = rows.slice().sort((a, b) => timeAnchor(a) - timeAnchor(b));
  const splitAt = Math.floor(ordered.length * trainRatio);
  return { train: ordered.slice(0, splitAt), test: ordered.slice(splitAt) };
}

// ---------- 目标类集中区间挖掘（勇者阵营用"赢"、邪恶阵营用"输"共用这套核心） ----------
// 在分位数网格（含 ±Infinity 端点）上扫所有连续窗口，找"目标类的 Wilson 下界 / 基准率"最高的窗口。
// 用 Wilson 下界而不是裸比率做评分：窗口小时裸比率容易被三五个样本抬到 100%，下界会把这种
// 不确定性压回去，避免推荐出"n=6 全是目标类"的伪区间。
// labels 是外部传入的 0/1 数组：findHotInterval 传"赢"标签，findColdInterval 传"输"标签
// （对同一份 values 取反），两者共用这一份窗口扫描逻辑，评分/输出字段含义完全对称。
function scanIntervalCore(values, labels, opts = {}) {
  const { minCoverage = 0.3, minN, targetLabel = '目标类', permB = 200 } = opts;
  const n = values.length;
  const posTotal = labels.reduce((a, b) => a + b, 0);
  if (n < 20) return { error: `有效样本仅 ${n} 条（<20）` };
  if (posTotal < 5) return { error: `${targetLabel}仅 ${posTotal} 个（<5），区间不可信` };
  if (posTotal === n) return { error: `样本全部是${targetLabel}，无需区间` };
  const base = posTotal / n;
  const minGroup = minN != null ? minN : Math.max(10, Math.ceil(n * 0.08));

  const sortedX = values.slice().sort((a, b) => a - b);
  if (new Set(sortedX).size < 4) return { error: '取值种类太少（<4）' };

  // 分位数网格去重后作为窗口边界，两端补 ±Infinity 覆盖单边开区间——只依赖 values，跟 labels
  // 无关，置换检验时反复复用，不用每次重算
  const edgeSet = new Set();
  for (let q = 5; q <= 95; q += 5) edgeSet.add(percentile(sortedX, q / 100));
  const edges = [-Infinity, ...[...edgeSet].sort((a, b) => a - b), Infinity];
  const numSeg = edges.length - 1;

  // 每个样本落进哪个分位段同样只取决于 values，算一次，置换检验反复复用；
  // 真正随 labels 变的只是"这个段里有几个目标类"这个聚合，每次置换重新聚合即可
  const segIdx = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    while (s < numSeg - 1 && values[i] >= edges[s + 1]) s++;
    segIdx[i] = s;
  }

  // 给一份 labels（真实的或置换后的）算出"能搜到的最优窗口"——真实调用与下面的置换检验
  // 共用同一套逻辑，保证零假设分布和观测值是同一把尺子量出来的，这是置换检验有效的前提
  function bestScoreFor(labelsArr) {
    const segN = new Array(numSeg).fill(0);
    const segPos = new Array(numSeg).fill(0);
    for (let i = 0; i < n; i++) { segN[segIdx[i]]++; segPos[segIdx[i]] += labelsArr[i]; }
    const cumN = [0], cumPos = [0];
    for (let i = 0; i < numSeg; i++) { cumN.push(cumN[i] + segN[i]); cumPos.push(cumPos[i] + segPos[i]); }
    const scan = (covReq) => {
      let best = null;
      for (let i = 0; i < numSeg; i++) {
        for (let j = i + 1; j <= numSeg; j++) {
          const wN = cumN[j] - cumN[i];
          const wPos = cumPos[j] - cumPos[i];
          if (wN < minGroup) continue;
          const coverage = wPos / posTotal;
          if (coverage < covReq) continue;
          const rate = wPos / wN;
          if (rate <= base) continue;
          const wilsonLo = wilsonInterval(wPos, wN).lo;
          // 评分乘 √coverage：不加的话，随机波动会让"只圈住信号密集段一小截"的窄窗口胜出，
          // 挖出的区间比真实目标类集中区窄一圈；捕获率加权把这种 cherry-pick 压回去
          const score = (wilsonLo / base) * Math.sqrt(coverage);
          if (!best || score > best.score
            || (score === best.score && (coverage > best.coverage || (coverage === best.coverage && wN > best.n)))) {
            best = { lo: edges[i], hi: edges[j], n: wN, pos: wPos, winRate: rate, lift: rate / base,
                     coverage, wilsonLo, score };
          }
        }
      }
      return best;
    };
    // 找不到满足捕获率的窗口时放宽一次再试——宁可给个窄区间让用户自己判断，也别直接空手而归
    return scan(minCoverage) || scan(minCoverage / 2);
  }

  const best = bestScoreFor(labels);
  if (!best) return { error: `没有${targetLabel}比率高于基准且样本量达标的区间` };

  // 置换检验：观测到的这个"最优窗口"分数，是从 O(边界数²) 个候选窗口里挑出来的赢家——
  // 直接对它做"假装区间是提前定好的"检验（比如两比例检验）会系统性低估巧合概率
  // （look-elsewhere/winner's curse）。做法：labels 完全随机洗牌 permB 次，每次都用同一套
  // bestScoreFor 重新搜一遍"这次洗牌能凑出的最高分数"，得到一个"纯靠搜索本身就能凑多高"的
  // 零假设分布，观测分数在这个分布里排第几，才是这次搜索本身的显著性。种子固定
  // （跟 bootstrapAucCI 同一套 mulberry32 模式）保证同一份数据反复扫结果可复现。
  const rand = mulberry32(0x2545F491);
  const shuffled = labels.slice();
  let geCount = 0;
  for (let b = 0; b < permB; b++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
    }
    const permBest = bestScoreFor(shuffled);
    if (permBest && permBest.score >= best.score) geCount++;
  }
  const pPermutation = (geCount + 1) / (permB + 1);

  // score=(wilsonLo/base)×√coverage 是区间感知、自带小样本抗噪声保护的判别力统计量——
  // 候选粗筛排序/初始配权改用它（而不是假设方向单调的AUC）时要读这个字段，不能再丢弃
  return { ...best, base, posTotal, total: n, pPermutation };
}

// 高倍盘（"赢"）集中区间——勇者阵营用：值落在这个区间 = 好迹象，用来加分。
export function findHotInterval(rows, field, opts = {}) {
  const { winThreshold = WIN_THRESHOLD, ...rest } = opts;
  const { values, labels } = collectAucSamples(rows, field, winThreshold);
  return scanIntervalCore(values, labels, { targetLabel: '高倍盘', ...rest });
}

// 输家（未达高倍阈值，"赢"标签取反）集中区间——邪恶阵营用：值落在这个区间 = 危险迹象，用来减分。
// 复用与 findHotInterval 完全相同的窗口扫描算法，只是把标签从"赢"换成"输"——
// 两个阵营的区间在数学上是对称的，输家集中区不是另一套指标，只是同一个统计口径换个目标类。
export function findColdInterval(rows, field, opts = {}) {
  const { winThreshold = WIN_THRESHOLD, ...rest } = opts;
  const { values, labels } = collectAucSamples(rows, field, winThreshold);
  return scanIntervalCore(values, labels.map(l => 1 - l), { targetLabel: '输家', ...rest });
}

// ---------- 梯形打分 ----------
// [lo1,hi1] 满分核，[lo0,lo1]/[hi1,hi0] 线性过渡，界外 0；±Infinity 表示该侧不收敛。
// 非有限输入（缺失）一律 0 分。
export function trapScore(x, lo0, lo1, hi1, hi0) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  if (v >= lo1 && v <= hi1) return 1;
  if (v <= lo0 || v >= hi0) return 0;
  if (v < lo1) {
    const w = lo1 - lo0;
    return Number.isFinite(w) && w > 0 ? (v - lo0) / w : 0;
  }
  const w = hi0 - hi1;
  return Number.isFinite(w) && w > 0 ? (hi0 - v) / w : 0;
}

// 由挖出的区间推导梯形四点：满分核 = 区间内目标类取值的 P25~P75（打分应画在目标类密集处，
// 不是整个区间均匀给分）；硬界 = 区间向外扩 10% 的稳健跨度（P95-P5），不超过观测范围。
// 单边开区间（±Infinity）该侧不设过渡：lo0=lo1=-Infinity / hi1=hi0=Infinity。
// labels 是外部传入的 0/1 目标类标签：deriveTrapezoid 传"赢"（勇者阵营，核心=高倍盘密集处），
// deriveColdTrapezoid 传"输"（邪恶阵营，核心=输家密集处，即最危险的取值区）。
function deriveTrapezoidCore(values, labels, interval, targetLabel) {
  const inWin = (x) => x >= interval.lo && (interval.hi === Infinity ? true : x < interval.hi);
  const targets = [];
  for (let i = 0; i < values.length; i++) if (labels[i] === 1 && inWin(values[i])) targets.push(values[i]);
  if (targets.length < 3) return { error: `区间内${targetLabel}仅 ${targets.length} 个（<3），无法推导满分核` };
  targets.sort((a, b) => a - b);
  const allSorted = values.slice().sort((a, b) => a - b);
  const ext = 0.1 * Math.max(percentile(allSorted, 0.95) - percentile(allSorted, 0.05), 1e-12);
  const obsMin = allSorted[0], obsMax = allSorted[allSorted.length - 1];

  let lo0, lo1, hi1, hi0;
  if (interval.lo === -Infinity) { lo0 = -Infinity; lo1 = -Infinity; }
  else { lo1 = percentile(targets, 0.25); lo0 = Math.max(interval.lo - ext, obsMin - ext); }
  if (interval.hi === Infinity) { hi1 = Infinity; hi0 = Infinity; }
  else { hi1 = percentile(targets, 0.75); hi0 = Math.min(interval.hi + ext, obsMax + ext); }
  if (Number.isFinite(lo1) && Number.isFinite(hi1) && lo1 > hi1) { const m = (lo1 + hi1) / 2; lo1 = m; hi1 = m; }
  if (Number.isFinite(lo0) && Number.isFinite(lo1)) lo0 = Math.min(lo0, lo1);
  if (Number.isFinite(hi0) && Number.isFinite(hi1)) hi0 = Math.max(hi0, hi1);
  return { lo0, lo1, hi1, hi0 };
}

export function deriveTrapezoid(rows, field, interval, winThreshold = WIN_THRESHOLD) {
  const { values, labels } = collectAucSamples(rows, field, winThreshold);
  return deriveTrapezoidCore(values, labels, interval, '高倍盘');
}

// 邪恶阵营版：满分核画在【输家】密集处——命中这个核心区 = 危险信号最强，打分时按 -weight 记分
export function deriveColdTrapezoid(rows, field, interval, winThreshold = WIN_THRESHOLD) {
  const { values, labels } = collectAucSamples(rows, field, winThreshold);
  return deriveTrapezoidCore(values, labels.map(l => 1 - l), interval, '输家');
}

export function missingRate(rows, field) {
  if (!rows.length) return 0;
  let miss = 0;
  for (const r of rows) {
    const raw = getFeature(r, field);
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(Number(raw))) miss++;
  }
  return miss / rows.length;
}

// ---------- 因子发现（全字段扫描） ----------
// AUC 部分直接复用 scanFieldsAuc（含 BH 校正、目标变量排除），再逐字段附加区间。
// camp='hero'（勇者阵营，默认）挖高倍盘集中区，用来加分；camp='evil'（邪恶阵营）挖输家
// 集中区，用来减分。两个阵营各自独立扫描（同一批字段可以分别喂两次，各自选出自己的候选池），
// 每个候选对象都带上 camp 标记，供 buildFactors/打分阶段区分正负号。
// 异步分块：区间挖掘本身很快（前缀和），但 100+ 字段 × bootstrap 的 AUC 已经先卡一下了，
// 区间这步每 20 个字段让一次事件循环，避免叠加成长冻结。
export async function scanFactorCandidates(rows, fields, opts = {}) {
  const { winThreshold = WIN_THRESHOLD, bootstrapB = 200, minCoverage = 0.3, camp = 'hero' } = opts;
  const { results, usable } = scanFieldsAuc(rows, fields, { winThreshold, bootstrapB });
  const findInterval = camp === 'evil' ? findColdInterval : findHotInterval;
  const out = [];
  for (let i = 0; i < usable.length; i++) {
    if (i % 20 === 19) await new Promise(r => setTimeout(r, 0));
    const a = usable[i];
    const interval = findInterval(rows, a.field, { winThreshold, minCoverage });
    out.push({
      field: a.field, n: a.n, pos: a.pos, auc: a.auc, ci: a.ci, direction: a.direction,
      significant: a.significant, significantAdj: a.significantAdj, pAdj: a.pAdj,
      interval: interval.error ? null : interval,
      intervalError: interval.error || null,
      missRate: missingRate(rows, a.field),
      camp,
    });
  }
  // 区间显著性：pPermutation（scanIntervalCore 内部置换检验算出的，已经为"从很多候选窗口里
  // 挑最优"这件事做了校正，不是简单的两比例检验）+ BH 多重比较校正——跟上面 AUC 的
  // significant/significantAdj 同一套纪律，只是检验对象换成区间（区间是判据实际吃的
  // 东西，AUC 假设方向单调、区间不假设，两者可能给出相反结论，见候选粗筛/配权改用 interval.score
  // 处的注释）。挂在 interval 上而不是候选顶层，避免跟 AUC 那两个同名字段混淆。
  const pRaw = out.map(c => c.interval ? c.interval.pPermutation : NaN);
  const pAdjArr = benjaminiHochbergAdjust(pRaw);
  out.forEach((c, i) => {
    if (c.interval) {
      c.interval.pAdj = pAdjArr[i];
      c.interval.significantAdj = Number.isFinite(pAdjArr[i]) && pAdjArr[i] < 0.05;
    }
  });
  const skipped = results.filter(r => r.reason).map(r => ({ field: r.field, reason: r.reason }));
  return { candidates: out, skipped };
}

// 从扫描结果构建可编辑的因子集（区间→打分形状，含权重与阵营）。fieldSpecs 里推导失败的进 skipped。
// candidates 可以是勇者阵营和邪恶阵营两次扫描结果的合并数组——每个候选自带 camp，
// 这里按各自的 camp 选用对应的区间/梯形推导（hero 走高倍盘密集核，evil 走输家密集核）。
//
// fieldSpecs 支持两种写法：字符串数组（向后兼容，全部当勇者阵营处理），
// 或 {field, camp} 对象数组。camp 是查找候选时的一部分 key（'camp:field'）而不是
// 只按 field 查——因为 UI 通常会对同一批字段【同时】跑勇者/邪恶两次扫描（每个字段两个
// 阵营各有一份候选），如果只按 field 查，同一字段在两个阵营都有候选时，选哪个纯粹取决于
// candidates 数组的拼接顺序，跟用户到底在哪张表里勾选的完全无关——这是真实踩过的 bug
// （在两张扫描表里分别勾选不同字段，因子表却把两个都标成了同一个阵营）。
//
// OOS 验证也走这条路（用训练段 rows），保证"自动推导"在两处口径完全一致。
//
// shape 两种打分形状：
//   'trap'（默认）——梯形：目标类密集核满分，向硬界线性衰减，区间边缘拿部分分；
//   'interval'——区间命中：值落在挖出的可信区间就拿满该因子权重，区间外 0 分。
//     实现上就是把梯形退化成矩形（lo0=lo1=lo, hi1=hi0=hi），trapScore 及下游
//     回测/OOS/代码生成不需要任何特殊分支。
export function buildFactors(rows, candidates, fieldSpecs, winThreshold = WIN_THRESHOLD, opts = {}) {
  const { shape = 'trap' } = opts;
  const specs = fieldSpecs.map(s => (typeof s === 'string' ? { field: s, camp: 'hero' } : s));
  const campKey = c => (c.camp === 'evil' ? 'evil' : 'hero') + ':' + c.field;
  const byKey = new Map(candidates.map(c => [campKey(c), c]));
  const factors = [], skipped = [];
  for (const spec of specs) {
    const camp = spec.camp === 'evil' ? 'evil' : 'hero';
    const field = spec.field;
    const c = byKey.get(camp + ':' + field);
    if (!c) { skipped.push({ field, reason: `不在${camp === 'evil' ? '邪恶' : '勇者'}阵营的扫描结果中` }); continue; }
    if (!c.interval) { skipped.push({ field, reason: c.intervalError || '无推荐区间' }); continue; }
    let bounds;
    if (shape === 'interval') {
      bounds = { lo0: c.interval.lo, lo1: c.interval.lo, hi1: c.interval.hi, hi0: c.interval.hi };
    } else {
      bounds = camp === 'evil'
        ? deriveColdTrapezoid(rows, field, c.interval, winThreshold)
        : deriveTrapezoid(rows, field, c.interval, winThreshold);
      if (bounds.error) { skipped.push({ field, reason: bounds.error }); continue; }
    }
    factors.push({ field, camp, auc: c.auc, direction: c.direction, interval: c.interval,
                   missRate: c.missRate, weight: 0, ...bounds });
  }
  return { factors: autoWeights(factors), skipped };
}

// 权重 ∝ interval.score（区间感知、Wilson下界×√coverage，见scanIntervalCore），四舍五入到
// 1 位小数后用最大余数法修正，总和恰为 100。之前是 |AUC-0.5|——AUC 假设方向单调，"驼峰型"
// 字段（比如中段区间命中率最高、两头都低）在AUC上会显得没区分度，但区间打分可能很强，两者
// 会给出相反结论，改用interval.score才能跟下游打分（也是区间/梯形，不假设方向）口径一致。
// 全部为 0（理论上不会进到这）时退化为均分。
export function autoWeights(factors) {
  if (!factors.length) return factors;
  const raw = factors.map(f => Number(f.interval?.score) || 0);
  const sum = raw.reduce((a, b) => a + b, 0);
  const shares = sum > 0 ? raw.map(x => x / sum * 100) : raw.map(() => 100 / factors.length);
  const floored = shares.map(x => Math.floor(x * 10) / 10);
  let remain = Math.round((100 - floored.reduce((a, b) => a + b, 0)) * 10);
  const order = shares.map((x, i) => [x - floored[i], i]).sort((a, b) => b[0] - a[0]);
  const weights = floored.slice();
  for (let k = 0; remain > 0; k = (k + 1) % order.length, remain--) weights[order[k][1]] += 0.1;
  return factors.map((f, i) => ({ ...f, weight: Math.round(weights[i] * 10) / 10 }));
}

// ---------- 已选因子的两两相关性 ----------
// 权重按 interval.score 各自独立分配，两个高度相关的因子（如 新钱包% 与 新钱包率%）会把
// 同一份信息收两次钱。这里用 Spearman（秩相关，抗离群值）扫一遍已选组合，超阈值的
// 对子交给界面挂提醒——合并成一个或手动降权，由使用者决定。
export function factorCorrelations(rows, fields, { threshold = 0.7, minN = 20 } = {}) {
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const pairs = [];
      for (const r of rows) {
        const a = getFeatureValue(r, fields[i]);
        const b = getFeatureValue(r, fields[j]);
        if (Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b]);
      }
      if (pairs.length < minN) continue;
      const rho = spearman(pairs);
      if (Number.isFinite(rho) && Math.abs(rho) >= threshold) {
        out.push({ a: fields[i], b: fields[j], rho, n: pairs.length });
      }
    }
  }
  return out.sort((x, y) => Math.abs(y.rho) - Math.abs(x.rho));
}

// ---------- 候选因子的边际 ρ 贡献 ----------
// 北极星指标是 score↔returnMax 的 Spearman ρ（策略调参页同一口径），而不是单字段 AUC——
// AUC 只看"这个字段自己"，没回答"把它加进当前打分池，对最终排序能力有没有增量"。
// 这里把候选字段临时并入当前已选因子池（自动配权），对比加入前后 rows 整体 score 与
// returnMax 的 ρ，差值就是"进池后的边际贡献"——可能出现"单字段 AUC 不错但边际贡献接近 0"
// （信息与已选因子高度重叠，见 factorCorrelations）或反过来的情况。
function scorePoolRho(rows, factorSet, missingPolicy) {
  if (!factorSet.length) return NaN;
  const scored = scoreRows(rows, factorSet, { missingPolicy });
  const pairs = [];
  for (const s of scored) {
    const ret = Number(s.row.returnMax);
    if (Number.isFinite(s.score) && Number.isFinite(ret)) pairs.push([s.score, ret]);
  }
  return pairs.length >= 8 ? spearman(pairs) : NaN;
}

// 分层增益：以"筛垃圾"为第一目标的策略，北极星从"全程 ρ 单调"降为"分段台阶"
// （见项目北极星笔记的例外条款）。最早版本只拿 cutoff 二分的台阶差(above.length×Δ命中率)当
// 目标函数——这是纯"计数阈值"函数，不是像 ρ 那样看全排序的平滑目标，坐标上升会找到"角点解"：
// 哪个因子单独对这一刀最敏感就把权重全堆过去、其它因子推到 0（实测复现：2 因子池退化成
// 100/0）。这不是"配权"，是"挑单一分界因子"。
// 用户订正："应该先排序，然后再分层，只是不需要要求每个粒度单调"——即分段台阶该看的是
// "先按 score 排序、切成粗粒度的若干档，档位越高命中率越高这个粗趋势"，不要求 decile 级细粒度
// 处处爬升。于是改成两部分加权（"秩相关 + cutoff 主台阶"）：
//   ① 主台阶 tierGap（权重 0.7）：仍是 cutoff 天然切出的"过线/未过线"两层命中率差，∈[-1,1]——
//      这是笔记里的核心判据，权重给高，保证 cutoff 处的台阶差仍是主导信号；
//   ② 粗粒度秩相关 tierRho（权重 0.3）：仿 computeScoreBuckets 的做法——按 score 排序切
//      K=3~5 档（样本不够多就少切，同分样本绝不跨档），算 spearman(档序号, 档命中率)，∈[-1,1]。
//      它是"多点约束"：因子必须在好几个档位上都排得对才能拿到高分，单一因子很难同时喂饱
//      cutoff 这一刀 + 好几个档位的排序，逼着坐标上升保留多个因子而不是清零到只剩一个。
// 触发数(above.length)默认仍作规模因子——同样的台阶差，覆盖更多触发样本更有价值（呼应
// recommendCutoff 的"净超额命中数"思路），这贴合"筛垃圾"策略（尽量多留好币、只踢真垃圾）。
// 但"推荐"类策略（想要少而精的候选名单）用同一个乘数会反向起作用：坐标上升会为了拉高
// above.length 而把权重往"谁都容易触发"的方向偏，实测过（2026-07-28）：同一因子池，ρ最优配权
// 在 cutoff 下触发率79%，分层增益（带该乘数）配权触发率飙到92%，过滤能力形同虚设。
// opts.volumeWeighted=false 时去掉这个乘数，
// 只留台阶差+粗粒度秩相关的方向性分数（不奖励触发量大小），配权时不会再被"放量"牵着走。
// 但这样也去掉了它的一个副作用——above.length 越小、乘出来的分数天然越小，客观上在惩罚
// "过线组样本太少、统计上不可信"的情况。实测过（2026-07-28）：去掉乘数后，held-out test 台阶差
// 直接翻车（train 涨、test 从正变负），比默认版更容易过拟合——因为坐标上升不再需要顾忌"过线组
// 够不够大"，会在 train 上找一个"过线组恰好差异很大"的权重组合，哪怕这个组在 train 上样本很少、
// 纯属抽样运气。minGroupN（默认 20，呼应 computeScoreBuckets"每桶~20条才有统计意义"的口径）就是
// 补回这层保护：不管 volumeWeighted 开不开，过线/未过线两层都必须达到这个样本量才评估台阶差，
// 逼着搜索只能在统计上站得住脚的分组上找权重，不能靠小样本噪声投机取巧。
// 垃圾/高倍标签口径跟"找因子"体系一致：直接用 returnMax > winThreshold，不引入独立的垃圾标签字段。
//
// 共享核心：给已排好分数的 pairs 按分位数切 K 档（同分不跨档，仿 computeScoreBuckets），
// 算"档序号 vs 档统计量"的 spearman——cutoff-free，是 scorePoolTierGain 的"②粗粒度秩相关"
// 和下面 scorePoolBucketRho（"推荐"场景独立北极星）共用的逻辑，不写两遍。
//
// 2026-07-28 订正（用户订正："K=3~5 不可以，相当于原本要几百个桶直接变成3~5个"）：
// 最早版本 K 固定 3~5、档内统计量用命中率，实测直接踩坑——真实数据里 frequent_volume 单独一个
// 因子就跑出 Δ=+1.000（理论最大值），贪心只推一步就停。根因：K=3~5 时秩相关只有 3~5 个点参与
// 计算，"这几个粗糙数字凑巧排对顺序"的概率远高于全局ρ（几百个点）"整条序列都排对"的概率，是
// 离散网格效应/统计巧合，不是真信号——全局ρ与分层秩相关的核心区别就是参与计算的点数差两个
// 数量级，这直接决定了两者对巧合的抵抗力天差地别。
// 第一版改法（按"每档期望命中数≥3"算档大小=max(15,ceil(3/baseWinRate))）上线后，真实数据里
// 又在另一处撞出同样的 +1.000（这次是 followed_tx_analysis.sell_amount，held-out涨到顶格但
// 样本内只有+0.200）——回查发现：test 段样本量小、局部命中率一旦比全局基准更低（抽样波动，
// 完全正常），ceil(3/baseWinRate)会把档点数顶得很大，K 又被压回3（数值上"没跌破K<3的检查"，
// 但K=3本身就是最初那个问题的原始网格，检查形同虚设）。根子问题：档内统计量早就换成了中位数
// （连续值，不需要"够3个命中"才稳），"按命中数定档大小"这条逻辑从改中位数那一刻起就已经是
// 过时的历史包袱，没必要再跟着命中率走——这次直接删掉，档大小固定用中位数稳定所需的点数
// （15），不再随局部命中率的抽样波动而忽大忽小。同时把"K太小就拒绝评估"的门槛从3提到5——
// K=3~4 时数值网格依然粗糙（比如n=5时spearman网格步长才0.1，n=3~4时明显更粗），涨到5起步，
// 网格才算真正跳出"随手一凑就顶格"的危险区。
//
// 2026-07-28 再订正（用户诊断："推荐时少算了一个维度，把一个维度算到了极致，导致高度集中在一起——
// 目标其实是低倍率尽量分散在低分值、高倍率在高分值，这样阈值右侧赚率才高"）：上面这些订正堵住的
// 是"点数太少导致巧合顶格"，但还有一条完全不同的路能制造出虚高分数——秩相关只看"桶与桶之间"
// 中位数排得对不对，完全不管"桶内部"混杂成什么样。真实撞过：单独用 max_up_duration 推出的梯形
// 下界形同虚设（几乎所有样本不管好坏都落在满分区），散点图上score=100那一竖排从1x到200x全挤在
// 一起——桶间中位数排序看着还行（+0.964），但顶格那个桶把大部分样本饱和堆在同一个分数上，桶内部
// 完全没有区分度，对实盘"cutoff右侧赚率"这个真实目标没有意义，贪心却因为桶间排序过关就停手，
// 不会再找下一个因子去把这坨样本摊开。
// 加一层"饱和度惩罚"：算出最大单桶样本占比 maxBucketFrac，最终值 = 秩相关 × (1 − maxBucketFrac)。
// 分布均匀时（K个桶均分，各桶占比≈1/K）几乎不打折；出现某个桶吃掉大半样本这种饱和情况时，
// 狠狠打折——逼着贪心/配权继续找能把饱和样本摊开的因子，而不是满足于"桶间排序对、桶内一锅粥"
// 的解。scorePoolTierGain 的"②粗粒度秩相关"分量共用这条逻辑，同样受益（筛垃圾也不该允许
// 大部分样本堆在同一个分数上）。
// 2026-07-28 三订正（用户诊断："中位数对右偏分布不敏感——倍数分布是一大坨1~3x的普通盘+一小撮
// 10~200x的尾部，不管总分高低，中位数都被这一大坨普通盘钉死在差不多的位置，尾部涨得再猛中位数
// 感受不到；Spearman又只看顺序对不对，于是曲线视觉上像噪声带、案例中位数线基本走平，但秩相关
// 却能算出0.5~0.7——这是数值上技术性满足单调，不是真信号"）：档内统计量从中位数换成命中率
// （命中率 = 该档 returnMax > winThreshold 的比例），这才是跟十分位表"高倍率5.5%→20.0%一路爬升"
// 同一个口径的东西，也是用户真正在意的"阈值右侧赚率"。
// 代价（同样是用户指出的）：命中率在小分桶下方差更大——bucketSize固定15、真实命中率~15%时
// 每档期望只有2~3个命中，噪声会比中位数明显。防护手段是 bucketSize 按命中率自适应放大：
// max(15, ceil(minHitCount/rate))，rate 用当前这份 pairs 自己的整体命中率估计（不是历史上踩过坑的
// "跨 train/test 用不同局部估计"，这里只在这一次调用内部自洽），确保每档期望命中数不至于太可怜。
// 注意：不能反过来按"某档实际命中数<3就剔除该档"过滤——这是试过又踩的坑：一个 n=65 的大档
// 实际命中数=0，恰恰是"该档命中率确信地很低（大概率在0~5%附近，样本量摆在那）"，是真信号的一部分，
// 不是噪声；按绝对命中数剔除会把两端本该确信为低/高命中率的大档一起滤掉，破坏序列完整性，
// 反而更容易在真实数据上把好因子的分层秩相关判成 NaN。噪声只能靠"分档时保证期望命中数"这层
// 事前防护来控制，不能靠"看到命中数少就事后剔除"来滤——那等于是拿实现结果去筛统计假设。
// winThreshold 不是 finite（老调用点没传）时退回旧的中位数口径，保证向后兼容。
//
// 按分位数切档的共享核心，拆出来单独导出——bucketRankRho 算 rho 用得到，UI 也想把"档边界/档命中率"
// 画到散点图上给用户肉眼判断分层是否单调，两边不该各写一份切档逻辑。
// 返回 null（档数不足，网格太粗不可信）或
// { buckets: [{loScore,hiScore,medianRet,hitRate,hitCount,n}], maxBucketFrac }。
export function computeRankBuckets(pairs, winThreshold) {
  const n = pairs.length;
  if (n < 10) return null;
  const minK = 5; // K/实际分档数低于此值，网格太粗，宁可算不出来也不要给一个不可信的数
  const minBucketSize = 15; // 固定下限：中位数稳定估计所需的最少点数
  const minHitCount = 3;
  const useHitRate = Number.isFinite(winThreshold);
  let bucketSize = minBucketSize;
  if (useHitRate) {
    const rate = pairs.filter(p => p.ret > winThreshold).length / n;
    if (rate > 0) bucketSize = Math.max(minBucketSize, Math.ceil(minHitCount / rate));
    // rate===0（全员未中）：命中率统计本来就没有意义，退回 minBucketSize——
    // 下面每档命中数检查会自然把所有档滤掉，最终 bucketRankRho 返回 NaN，不会硬造数字。
  }
  const K = Math.floor(n / bucketSize);
  if (K < minK) return null;
  const sorted = pairs.slice().sort((a, b) => a.score - b.score);
  const buckets = [];
  let maxBucketSize = 0;
  let start = 0;
  for (let k = 1; k <= K && start < n; k++) {
    let end = Math.floor(k * n / K);
    if (end <= start) continue;                                     // 上一档已把这段吃掉
    while (end < n && sorted[end].score === sorted[end - 1].score) end++;  // 别在同分处切开
    const chunk = sorted.slice(start, end);
    start = end;
    if (!chunk.length) continue;
    const hitCount = useHitRate ? chunk.filter(p => p.ret > winThreshold).length : NaN;
    buckets.push({
      loScore: chunk[0].score, hiScore: chunk[chunk.length - 1].score,
      medianRet: median(chunk.map(p => p.ret)), n: chunk.length,
      hitRate: useHitRate ? hitCount / chunk.length : NaN, hitCount,
    });
    maxBucketSize = Math.max(maxBucketSize, chunk.length);
  }
  if (buckets.length < minK) return null;   // 同分合并（"别在同分处切开"）可能把实际档数压得比 K 少，这里按实际档数再查一次
  return { buckets, maxBucketFrac: maxBucketSize / n };
}

// 诊断用：从一组档（computeRankBuckets 的输出）里挑出"打架"（命中率比前一档还低）的位置，
// 不用把所有档摊开来人工目测——inversions 数组每项标出具体是哪两档、命中率差多少、
// 那个分数区间在哪，方便直接定位"贪心这一步加的因子，是不是把哪一段分数区间的排序搅乱了"。
export function bucketZigzag(buckets) {
  if (!buckets || buckets.length < 2) return { inversionCount: 0, worstDrop: 0, inversions: [] };
  const inversions = [];
  let worstDrop = 0;
  for (let i = 1; i < buckets.length; i++) {
    const prev = buckets[i - 1], cur = buckets[i];
    const drop = prev.hitRate - cur.hitRate;
    if (drop > 1e-9) {
      inversions.push({ fromIdx: i - 1, toIdx: i, scoreRange: [prev.loScore, cur.hiScore],
        fromHitRate: prev.hitRate, toHitRate: cur.hitRate, drop });
      worstDrop = Math.max(worstDrop, drop);
    }
  }
  return { inversionCount: inversions.length, worstDrop, inversions };
}

// 2026-07-28 四订正（用户看回测图发现："紫线（档命中率）锯齿很重，这个锯齿程度应该是参数里
// 重要的衡量指标"）：饱和度惩罚堵住了"桶间排对、桶内一锅粥"，但没堵住另一种虚高——spearman
// 只看整条序列"大体上"排没排对，一条整体爬升但中间反复倒挂（比如第40档比第39档命中率还低）的
// 曲线，照样能换出一个不算差的秩相关。`bucketZigzag` 这个诊断函数早就写好了（数相邻档倒挂的
// 次数/幅度），但之前只在 recommendFactorPath 贪心路径的导出诊断里用，从没接进任何目标函数——
// 配权时优化器对锯齿完全"失明"。
// 第一版（用"总跨度"range 归一）在真实数据上直接踩坑：真实数据 K 常有 40+ 档（n=679 时
// bucketSize 固定至少15，K=floor(679/15)≈45），倒挂次数只要有十几次，totalDrop 累加起来就
// 轻松超过 range 这个固定值——导致几乎所有候选的锯齿惩罚都封顶在1，边际贡献列几乎全部塌成
// 0.000、因子推荐只挑得出1个字段。根子问题：totalDrop 是"累加量"，会随档数增多线性变大，
// 但 range 是跟档数无关的固定常数，两者除出来的比值天然会随档数增多而发散，不该拿一个会随
// 输入规模变化的分子去除一个不会变的分母。
// 改用"总变差"（totalVariation = 所有相邻档差值的绝对值之和，涨跌都算）归一：
// zigzagPenalty = 倒挂步长之和 / 总变差。totalDrop 天然是 totalVariation 的一个子集（只数
// 跌的部分），比值永远落在 [0,1]，不需要额外封顶，也不会随档数增多而发散——它衡量的是"整条
// 序列的涨涨跌跌里，有多少比例是在往回跌"，跟档数无关，只跟"跌的部分占涨跌总量的比例"有关。
function bucketRankRho(pairs, winThreshold) {
  const built = computeRankBuckets(pairs, winThreshold);
  if (!built) return NaN;
  const series = Number.isFinite(winThreshold)
    ? built.buckets.map((b, i) => [i, b.hitRate])
    : built.buckets.map((b, i) => [i, b.medianRet]);
  const rho = spearman(series);
  if (!Number.isFinite(rho)) return NaN;
  let zigzagPenalty = 0;
  if (Number.isFinite(winThreshold)) {
    const hitRates = built.buckets.map(b => b.hitRate);
    let totalVariation = 0;
    for (let i = 1; i < hitRates.length; i++) totalVariation += Math.abs(hitRates[i] - hitRates[i - 1]);
    if (totalVariation > 0) {
      const totalDrop = bucketZigzag(built.buckets).inversions.reduce((s, x) => s + x.drop, 0);
      zigzagPenalty = totalDrop / totalVariation;
    }
  }
  return rho * (1 - built.maxBucketFrac) * (1 - zigzagPenalty);
}

function scorePoolTierGain(rows, factorSet, cutoff, missingPolicy, winThreshold, volumeWeighted = true, minGroupN = 20) {
  if (!factorSet.length) return NaN;
  const scored = scoreRows(rows, factorSet, { missingPolicy });
  const pairs = [];
  for (const s of scored) {
    const ret = Number(s.row.returnMax);
    if (Number.isFinite(s.score) && Number.isFinite(ret)) pairs.push({ score: s.score, ret });
  }
  const n = pairs.length;
  if (n < 10) return NaN;

  // ① 主台阶：cutoff 二分的命中率差
  const above = pairs.filter(p => p.score >= cutoff);
  const below = pairs.filter(p => p.score < cutoff);
  if (above.length < minGroupN || below.length < minGroupN) return NaN;   // 两层都要有起码的统计意义才评估台阶差
  const hitRateOf = arr => arr.filter(p => p.ret > winThreshold).length / arr.length;
  const tierGap = hitRateOf(above) - hitRateOf(below);

  // ② 粗粒度秩相关：跟 cutoff 无关，见 bucketRankRho；档内统计量用命中率（跟①同一把 winThreshold），
  // 不用中位数——原因见 bucketRankRho 上方 2026-07-28 三订正的注释。
  const rawTierRho = bucketRankRho(pairs, winThreshold);
  const tierRho = Number.isFinite(rawTierRho) ? rawTierRho : 0;

  const gapScore = 0.7 * tierGap + 0.3 * tierRho;
  return volumeWeighted ? above.length * gapScore : gapScore;
}

// ---------- 分层秩相关（cutoff-free，"推荐"场景独立北极星）----------
// 用户订正（2026-07-28）："围绕 cutoff 判定"这个方向本身就不对——应该先排序，按整体单调性
// （不要求逐点严格单调，只要求粗粒度分层递增）配好权重，cutoff 是排序定下来之后【从结果里读出来
// 的一个点】（用现成的「推荐阈值」/recommendCutoff，按净超额命中数找），不该反过来先猜一个 cutoff
// 去当配权目标函数的输入。上面 scorePoolTierGain 把"cutoff 台阶差"当主判据（权重 0.7）正是这个
// 本末倒置的来源——cutoff 一变，配权就要整个重来，还牵出触发量乘数是否该奖励、held-out 在固定
// 切分点两侧样本失衡（甚至算出 NaN）等一串连带问题，这些坑本质上都是"cutoff 绑定"这个设计缺陷的
// 表现，不是碰巧。
// scorePoolBucketRho 完全不吃 cutoff：只用 bucketRankRho（自适应分位档，同分不跨档，
// 档内统计量用命中率）算"档序号 vs 档命中率"的秩相关，∈[-1,1]。适用场景：策略以"推荐"
// （挑出一批候选，不是卡一条硬线）为第一目标——配完权重后再用「推荐阈值」单独定 cutoff，两件事
// 彻底解耦，不会因为换 cutoff 就要重新配权。"筛垃圾"场景仍用 scorePoolTierGain（那边确实需要
// 一条硬过线，cutoff 绑定是合理的）。
// winThreshold 传给 bucketRankRho 用来算每档命中率——见 2026-07-28 三订正：中位数对右偏的
// 倍数分布不敏感（一大坨低倍盘钉死中位数，尾部涨多猛都感受不到），命中率才是真正对应
// "阈值右侧赚率"的统计量。
export function scorePoolBucketRho(rows, factorSet, missingPolicy, winThreshold) {
  if (!factorSet.length) return NaN;
  const scored = scoreRows(rows, factorSet, { missingPolicy });
  const pairs = [];
  for (const s of scored) {
    const ret = Number(s.row.returnMax);
    if (Number.isFinite(s.score) && Number.isFinite(ret)) pairs.push({ score: s.score, ret });
  }
  if (pairs.length < 10) return NaN;
  return bucketRankRho(pairs, winThreshold);
}

// currentFactors：当前已选因子池（不含候选自己）；candidate：来自扫描结果的候选行
// （需带 .interval，否则无法推导打分边界）；camp：候选所属阵营。rows 用于评估目标函数（通常是
// 全体样本，因为最终是要在全体样本上打分）；opts.buildRows 用于推导梯形边界，默认等于 rows——
// 如果候选的 .interval 是在另一份子集（如残差子集）上挖出来的，应传入同一份子集，保证区间与
// 梯形边界口径一致。opts.scoreFn 是"打分池→目标值"的评估函数，默认 scorePoolRho（全程强单调）；
// 不写死在函数体里，是为了让"评估用哪个目标函数"这件事可以从调用侧决定，而不是散落在各处改字面量。
export function factorMarginalRho(rows, currentFactors, candidate, camp, winThreshold = WIN_THRESHOLD, opts = {}) {
  const { shape = 'trap', missingPolicy = 'zero', buildRows = rows, scoreFn = scorePoolRho } = opts;
  if (!candidate || !candidate.interval) return { error: '该字段无可信区间，无法评估' };
  const { factors: withOne } = buildFactors(buildRows, [candidate], [{ field: candidate.field, camp }], winThreshold, { shape });
  if (!withOne.length) return { error: '无法推导打分边界' };
  const baseline = scoreFn(rows, autoWeights(currentFactors), missingPolicy);
  const merged = autoWeights([...currentFactors, ...withOne]);
  const withCandidate = scoreFn(rows, merged, missingPolicy);
  const delta = Number.isFinite(withCandidate) && Number.isFinite(baseline) ? withCandidate - baseline
    : Number.isFinite(withCandidate) ? withCandidate : NaN;
  return { baseline, withCandidate, delta };
}

// 计算 held-out（验证段）与样本内（训练段/全样本） 目标函数的增量对照。
// - 在训练段推导区间/梯形边界（build on train），在验证段计算目标函数的增量（held-out Δ）
// - 同时返回训练段内的 Δ 供对照（样本内 Δ），帮助识别过拟合（两者背离大）
// opts.scoreFn 同 factorMarginalRho，默认 scorePoolRho。
// 返回 { baselineTrain, withTrain, deltaTrain, baselineTest, withTest, deltaTest, nTrain, nTest }
export function computeHeldOutDeltaRho(rows, currentFactors, candidate, camp, winThreshold = WIN_THRESHOLD, opts = {}) {
  const { shape = 'trap', missingPolicy = 'zero', trainRatio = 0.7, timeField = 'swapBeginTime', splitMethod = 'time',
          scoreFn = scorePoolRho } = opts;
  if (!candidate || !candidate.interval) return { error: '该字段无可信区间，无法评估' };
  const { train, test } = splitTrainTest(rows, splitMethod, trainRatio, timeField);
  if (!train.length || !test.length) return { error: '训练/验证分割后样本不足' };

  // 构造只含 candidate 的因子（在 train 上推导梯形/界限）
  const built = buildFactors(train, [candidate], [{ field: candidate.field, camp }], winThreshold, { shape }).factors;
  if (!built || !built.length) return { error: '无法在训练段推导出 candidate 的打分边界' };

  // baseline 用当前因子池（假定为已推导好的因子对象数组）
  const baselineTrain = scoreFn(train, autoWeights(currentFactors || []), missingPolicy);
  const withTrain = scoreFn(train, autoWeights([...(currentFactors || []), ...built]), missingPolicy);
  const deltaTrain = Number.isFinite(withTrain) && Number.isFinite(baselineTrain) ? withTrain - baselineTrain
    : Number.isFinite(withTrain) ? withTrain : NaN;

  // 验证段（held-out）：注意因子边界来自训练段，因此用 built 推到 test 上
  const baselineTest = scoreFn(test, autoWeights(currentFactors || []), missingPolicy);
  const withTest = scoreFn(test, autoWeights([...(currentFactors || []), ...built]), missingPolicy);
  const deltaTest = Number.isFinite(withTest) && Number.isFinite(baselineTest) ? withTest - baselineTest
    : Number.isFinite(withTest) ? withTest : NaN;

  return {
    baselineTrain, withTrain, deltaTrain,
    baselineTest, withTest, deltaTest,
    nTrain: train.length, nTest: test.length,
  };
}

// ---------- ρ 驱动配权（北极星直接优化，默认口径：全程强单调）----------
// autoWeights 按 interval.score 分权，那是单字段区间判别力，跟"总分↔returnMax 单调(Spearman ρ)"这个
// 唯一目标只是相关、不是一回事。这里直接搜非负权重最大化 ρ：
//   - ρ 只由 score 的秩序决定，score=Σ(±w·s)/Σw×100 的分母对所有样本同值（zero 口径），
//     所以优化的就是分子 Σ(±w·s) 的排序；每个因子的 ±s 与权重无关（scorePoolRho 内部现算）。
//   - 无梯度（ρ 对权重分段常数）→ 乘法坐标上升：每个因子试 ×(1±δ) 和"置 0（丢弃）"，ρ 变好就留，
//     扫完一轮 δ 减半，直到无改进/δ 过小。两个初值（autoWeights + 等权）各跑一次取 train ρ 最优，
//     降低卡局部最优的概率。确定性，无随机种子。
// 防过拟合：用 splitTrainTest 在 train 上拟合、test 上验证（跟 OOS 面板同口径 swapBeginTime/0.7）。
// 返回 { factors(带新权重,归一到100), rhoTrainBefore/After, rhoTestBefore/After, zeroedFields, n* }
// 或 { error }。before 用【当前】权重，让用户看到相对现状的提升。
const applyWeights = (factors, weights) => factors.map((f, i) => ({ ...f, weight: weights[i] }));

// 通用乘法坐标上升：给一个"打分函数"objFn(rowsSet, weightedFactors, missingPolicy)->越大越好的目标值，
// 搜非负权重最大化它。ρ 最优配权、分层增益配权共用这一套搜索外壳，只是 objFn 换了——
// 前者塞 scorePoolRho（可由调用方注入别的目标函数），后者塞 scorePoolTierGain（多绑一个 cutoff/winThreshold）。
function coordinateAscentGeneric(objFn, rowsSet, factors, start, missingPolicy, maxRounds) {
  const valueOf = w => objFn(rowsSet, applyWeights(factors, w), missingPolicy);
  let w = start.map(x => (Number.isFinite(x) && x > 0 ? x : 0));
  if (w.every(x => x === 0)) w = w.map(() => 1);   // 全 0 起点退化成等权
  let val = valueOf(w);
  if (!Number.isFinite(val)) return { w, rho: -Infinity };
  let delta = 0.5;
  for (let round = 0; round < maxRounds; round++) {
    let improved = false;
    for (let i = 0; i < w.length; i++) {
      // 候选动作：放大、缩小、直接丢弃（置 0，让目标值无贡献/有害的因子能被彻底剔除）
      for (const cand of [w[i] * (1 + delta), w[i] * (1 - delta), 0]) {
        if (cand === w[i]) continue;
        const w2 = w.slice(); w2[i] = cand;
        if (w2.every(x => x === 0)) continue;        // 不允许全 0
        const r = valueOf(w2);
        if (Number.isFinite(r) && r > val + 1e-9) { w = w2; val = r; improved = true; }
      }
    }
    if (!improved) { delta *= 0.5; if (delta < 1e-3) break; }
  }
  return { w, rho: val };
}

// opts.scoreFn 是注入的目标函数（同 factorMarginalRho/computeHeldOutDeltaRho），默认 scorePoolRho；
// 不写死在函数体里，跟 coordinateAscentGeneric(objFn, ...) 是同一个原则——"该用哪个目标函数"由
// 调用方决定，避免同一套逻辑改个目标就要在多处复制粘贴。
export function optimizeWeightsForRho(rows, factors, opts = {}) {
  const { missingPolicy = 'zero', trainRatio = 0.7, timeField = 'swapBeginTime',
          splitMethod = 'time', maxRounds = 40, zeroEps = 0.05, scoreFn = scorePoolRho } = opts;
  if (!Array.isArray(factors) || factors.length < 2) return { error: '至少要有 2 个因子才谈得上配权' };
  const { train, test } = splitTrainTest(rows, splitMethod, trainRatio, timeField);
  const curWeights = factors.map(f => Number(f.weight) || 0);
  const rhoTrainBefore = scoreFn(train, factors, missingPolicy);
  if (!Number.isFinite(rhoTrainBefore)) return { error: 'train 集有效样本不足（<8 对），无法评估 ρ' };

  // 两个初值各跑一次坐标上升，取 train ρ 最优
  const starts = [autoWeights(factors).map(f => f.weight), factors.map(() => 1)];
  let best = null;
  for (const s of starts) {
    const r = coordinateAscentGeneric(scoreFn, train, factors, s, missingPolicy, maxRounds);
    if (!best || r.rho > best.rho) best = r;
  }
  // 归一到 100（ρ 尺度不变，纯为展示/与手工权重口径一致）
  const sum = best.w.reduce((a, b) => a + b, 0);
  const normW = sum > 0 ? best.w.map(x => Math.round(x / sum * 1000) / 10) : best.w.map(() => Math.round(1000 / best.w.length) / 10);
  const newFactors = applyWeights(factors, normW);
  const zeroedFields = newFactors.filter(f => f.weight <= zeroEps).map(f => f.field);

  return {
    factors: newFactors,
    rhoTrainBefore, rhoTrainAfter: best.rho,
    rhoTestBefore: scoreFn(test, applyWeights(factors, curWeights), missingPolicy),
    rhoTestAfter: scoreFn(test, newFactors, missingPolicy),
    zeroedFields, nTrain: train.length, nTest: test.length,
  };
}

// ---------- 分层增益配权（筛垃圾类策略的北极星例外：分段台阶）----------
// 跟 optimizeWeightsForRho 是同一套框架（train 拟合 δ 坐标上升、两个起点各跑一次取 train 最优、
// test 段只验证不参与搜索），只是目标函数换成 scorePoolTierGain：
//   触发数(score>=cutoff) × (0.7×台阶差_过线vs未过线 + 0.3×粗粒度秩相关_档位vs档命中率)
// "秩相关 + cutoff 主台阶加权"——见 scorePoolTierGain 内部注释：早期纯 cutoff 二分版本会让坐标
// 上升退化成"单因子全权重"的角点解，加一个粗粒度排序约束能堵住这个漏洞，同时不要求全程细粒度
// 单调（只切 3~5 档，不逼 decile 级处处爬升）。
// 适用场景：策略以"过滤垃圾/防踩雷"为第一目标（用户明确说明），而不是要全程精细单调——
// 此时按 ρ 最优配权会去追逐"处处爬升"，容易被小样本噪声牵着走；分层增益只要求粗粒度的
// 台阶式区分，更贴合"区分垃圾"本身。返回结构与 optimizeWeightsForRho 对齐（字段名沿用 rho* 前缀
// 是为了复用同一套展示/报告代码——这里的数值语义是"分层增益"而不是 Spearman ρ）。
// opts.volumeWeighted（默认 true）：筛垃圾场景要"覆盖更多触发样本"，保持默认。策略若是
// "推荐"类想要少而精的候选名单，传 false——去掉触发数乘数，配权不再被"放量"牵着走
// （见 scorePoolTierGain 内部注释，2026-07-28 因"分层增益版触发率飙到92%、形同虚设"而加）。
// opts.minGroupN（默认 20）：过线/未过线两层各自的最小样本量门槛，volumeWeighted:false 时
// 尤其关键——去掉触发数乘数后失去了"样本越少分数天然越小"这层隐式正则化，minGroupN 补回来，
// 见 scorePoolTierGain 内部注释（2026-07-28 因 volumeWeighted:false 版 held-out test 台阶差
// 翻车、从正变负而加）。
export function optimizeWeightsForTierGain(rows, factors, cutoff, opts = {}) {
  const { missingPolicy = 'zero', trainRatio = 0.7, timeField = 'swapBeginTime',
          splitMethod = 'time', maxRounds = 40, zeroEps = 0.05, winThreshold = DEFAULT_FACTOR_WIN_THRESHOLD,
          volumeWeighted = true, minGroupN = 20 } = opts;
  if (!Array.isArray(factors) || factors.length < 2) return { error: '至少要有 2 个因子才谈得上配权' };
  const { train, test } = splitTrainTest(rows, splitMethod, trainRatio, timeField);
  const curWeights = factors.map(f => Number(f.weight) || 0);
  const objFn = (rowsSet, factorSet, mp) => scorePoolTierGain(rowsSet, factorSet, cutoff, mp, winThreshold, volumeWeighted, minGroupN);
  const gainTrainBefore = objFn(train, factors, missingPolicy);
  if (!Number.isFinite(gainTrainBefore)) return { error: `train 集在该 cutoff 下两层样本不足（各需 ≥${minGroupN}），无法评估分层增益` };

  const starts = [autoWeights(factors).map(f => f.weight), factors.map(() => 1)];
  let best = null;
  for (const s of starts) {
    const r = coordinateAscentGeneric(objFn, train, factors, s, missingPolicy, maxRounds);
    if (!best || r.rho > best.rho) best = r;
  }
  const sum = best.w.reduce((a, b) => a + b, 0);
  const normW = sum > 0 ? best.w.map(x => Math.round(x / sum * 1000) / 10) : best.w.map(() => Math.round(1000 / best.w.length) / 10);
  const newFactors = applyWeights(factors, normW);
  const zeroedFields = newFactors.filter(f => f.weight <= zeroEps).map(f => f.field);

  return {
    factors: newFactors,
    rhoTrainBefore: gainTrainBefore, rhoTrainAfter: best.rho,
    rhoTestBefore: objFn(test, applyWeights(factors, curWeights), missingPolicy),
    rhoTestAfter: objFn(test, newFactors, missingPolicy),
    zeroedFields, nTrain: train.length, nTest: test.length,
  };
}

// ---------- 分层秩相关配权（"推荐"场景的独立北极星：不需要 cutoff）----------
// 跟 optimizeWeightsForRho/TierGain 同一套框架（train 拟合 δ 坐标上升、两个起点各跑一次取 train
// 最优、test 段只验证不参与搜索），目标函数换成 scorePoolBucketRho——完全不吃 cutoff，只要求
// K=3~5 粗粒度分档递增，不追全程精细单调（避免被小样本噪声牵着走），也不绑定任何具体 cutoff
// （避免 cutoff 一变、配权就要重来，见 scorePoolBucketRho 内部注释）。
// 配完权重后，cutoff 用「推荐阈值」（recommendCutoff，按净超额命中数找）另外去定，不在这里定。
export function optimizeWeightsForBucketRho(rows, factors, opts = {}) {
  const { missingPolicy = 'zero', trainRatio = 0.7, timeField = 'swapBeginTime',
          splitMethod = 'time', maxRounds = 40, zeroEps = 0.05, winThreshold = DEFAULT_FACTOR_WIN_THRESHOLD } = opts;
  if (!Array.isArray(factors) || factors.length < 2) return { error: '至少要有 2 个因子才谈得上配权' };
  const { train, test } = splitTrainTest(rows, splitMethod, trainRatio, timeField);
  const curWeights = factors.map(f => Number(f.weight) || 0);
  const objFn = (rowsSet, factorSet, mp) => scorePoolBucketRho(rowsSet, factorSet, mp, winThreshold);
  const rhoTrainBefore = objFn(train, factors, missingPolicy);
  if (!Number.isFinite(rhoTrainBefore)) return { error: 'train 集样本不足，切不出至少 3 个有效分位档，无法评估分层秩相关' };

  const starts = [autoWeights(factors).map(f => f.weight), factors.map(() => 1)];
  let best = null;
  for (const s of starts) {
    const r = coordinateAscentGeneric(objFn, train, factors, s, missingPolicy, maxRounds);
    if (!best || r.rho > best.rho) best = r;
  }
  const sum = best.w.reduce((a, b) => a + b, 0);
  const normW = sum > 0 ? best.w.map(x => Math.round(x / sum * 1000) / 10) : best.w.map(() => Math.round(1000 / best.w.length) / 10);
  const newFactors = applyWeights(factors, normW);
  const zeroedFields = newFactors.filter(f => f.weight <= zeroEps).map(f => f.field);

  return {
    factors: newFactors,
    rhoTrainBefore, rhoTrainAfter: best.rho,
    rhoTestBefore: objFn(test, applyWeights(factors, curWeights), missingPolicy),
    rhoTestAfter: objFn(test, newFactors, missingPolicy),
    zeroedFields, nTrain: train.length, nTest: test.length,
  };
}

// ---------- 因子推荐：贪心前向，按 held-out 边际 ρ 排（抗过拟合）----------
// 从 startFactors 出发（组合路径模式）或从空（探索全路径模式，startFactors=[]），每步选
// 「加进去让验证段 ρ 涨最多」的候选，加入，再算下一步 → 一条 a→b→c 路径。
// 口径：区间/边界在【训练段】推导（减少泄漏），权重 autoWeights，目标函数在【验证段】评估；
// 同时给样本内 Δ 供对照（两者背离大=过拟合迹象）。候选先按 interval.score（区间感知，见
// scanIntervalCore/autoWeights 注释）预筛控算力——2026-07-28 从 |AUC−0.5| 换过来，AUC 假设
// 方向单调会漏掉"驼峰型"字段，interval.score 才跟下游打分（区间/梯形）口径一致。
// candidates: [{ field, camp, interval, auc }]（两阵营合并，需带 interval）。
// opts.scoreFn 同 factorMarginalRho，默认 scorePoolRho——注入而不是写死，避免"换目标函数"要在
// 多处复制这条贪心搜索逻辑。
// 返回 { path:[{field,camp,deltaTest,deltaIn,testRho,inRho,overfit}], baseTestRho, nTrain, nTest }。
export function recommendFactorPath(rows, startFactors, candidates, opts = {}) {
  const { threshold = WIN_THRESHOLD, missingPolicy = 'zero', shape = 'trap',
    maxSteps = 6, minGain = 0.003, trainRatio = 0.7, timeField = 'swapBeginTime',
    splitMethod = 'time', candLimit = 50, batchSize = 10, scoreFn = scorePoolRho } = opts;
  const { train, test } = splitTrainTest(rows, splitMethod, trainRatio, timeField);
  const scoreOf = (rowsSet, factorSet) => scoreFn(rowsSet, factorSet, missingPolicy);
  // 候选：必须有区间；按 interval.score（区间感知，见 scanIntervalCore/autoWeights 注释）
  // 预筛到 candLimit 个控算力——之前用 |AUC−0.5|，会误伤"驼峰型"字段（AUC假设方向单调，
  // 区间打分不假设，两者可能反着来）；排除已在起点池里的。
  // 2026-07-28 试过又撤销：曾经在这里加过"区间显著性不能明确为false"的硬过滤，真实数据上
  // 单字段AUC普遍贴着0.5（这套系统本来就是靠很多个体弱信号加权组合，不是靠单字段自证清白），
  // 硬门槛会把候选池筛空、因子推荐直接变成"没有可推荐的候选"——比偶尔推荐一个不够严谨的
  // 字段更糟。区间显著性现在只在UI候选表里当展示/参考（跟AUC的判定列待遇一样），不再拿它
  // 砍候选池——recommendFactorPath 自己的train/test held-out验证已经是足够的把关。
  const startKeys = new Set((startFactors || []).map(f => f.camp + ':' + f.field));
  const pool = (candidates || [])
    .filter(c => c && c.interval && !startKeys.has(c.camp + ':' + c.field))
    .sort((a, b) => (b.interval?.score ?? 0) - (a.interval?.score ?? 0))
    .slice(0, candLimit);
  if (!pool.length) return { path: [], baseTestRho: NaN, nTrain: train.length, nTest: test.length, error: '没有可推荐的候选（先扫描）' };

  const buildOf = (specs, rowsForBuild) => buildFactors(rowsForBuild, candidates, specs, threshold, { shape }).factors;
  let pathSpecs = (startFactors || []).map(f => ({ field: f.field, camp: f.camp }));
  const chosen = new Set(startKeys);
  let baseTestRho = pathSpecs.length ? scoreOf(test, autoWeights(buildOf(pathSpecs, train))) : NaN;
  let baseInRho = pathSpecs.length ? scoreOf(rows, autoWeights(buildOf(pathSpecs, train))) : NaN;
  const path = [];

  for (let step = 0; step < maxSteps; step++) {
    let best = null;
    // evaluate pool in batches to avoid blocking the event loop
    for (let i = 0; i < pool.length; i += batchSize) {
      const batch = pool.slice(i, i + batchSize);
      for (const c of batch) {
        const key = c.camp + ':' + c.field;
        if (chosen.has(key)) continue;
        const specs = [...pathSpecs, { field: c.field, camp: c.camp }];
        const built = autoWeights(buildOf(specs, train));
        const testRho = scoreOf(test, built);
        if (!Number.isFinite(testRho)) continue;
        const deltaTest = Number.isFinite(baseTestRho) ? testRho - baseTestRho : testRho;
        if (!best || deltaTest > best.deltaTest) {
          const inRho = scoreOf(rows, built);
          best = { field: c.field, camp: c.camp, testRho, inRho, deltaTest,
                   deltaIn: Number.isFinite(baseInRho) ? inRho - baseInRho : inRho, built };
        }
      }
      // synchronous version for Node tests: no yielding
    }
    if (!best || !(best.deltaTest > minGain)) break;
    best.overfit = Number.isFinite(best.deltaIn) && best.deltaIn > 0 && best.deltaTest < best.deltaIn * 0.4;
    // 诊断日志：这一步选中因子之后，held-out(test) 和样本内(全量 rows) 各自的分档命中率剖面
    // （跟 UI 散点图紫线同一套 computeRankBuckets/threshold 口径）。目的：定位"贪心某一步选中的
    // 因子，是不是让中段分数区间命中率打架(锯齿)"，不用再靠人工在 UI 上逐步点 onAdopt 对照图，
    // 这份数据直接导出就能看出是哪一步、哪个字段引入的锯齿。
    const bucketsOn = rowsSet => {
      const scored = scoreRows(rowsSet, best.built, { missingPolicy });
      const pairs = [];
      for (const s of scored) {
        const ret = Number(s.row.returnMax);
        if (Number.isFinite(s.score) && Number.isFinite(ret)) pairs.push({ score: s.score, ret });
      }
      return computeRankBuckets(pairs, threshold)?.buckets ?? null;
    };
    best.testBuckets = bucketsOn(test);
    best.inBuckets = bucketsOn(rows);
    best.testZigzag = bucketZigzag(best.testBuckets);
    best.inZigzag = bucketZigzag(best.inBuckets);
    delete best.built;
    path.push(best);
    pathSpecs = [...pathSpecs, { field: best.field, camp: best.camp }];
    chosen.add(best.camp + ':' + best.field);
    baseTestRho = best.testRho; baseInRho = best.inRho;
  }
  return { path, baseTestRho, nTrain: train.length, nTest: test.length };
}

// Mode A: 从当前池出发（动态组合路径）
export function buildPathFromPool(rows, currentFactors, candidates, opts = {}) {
  return recommendFactorPath(rows, currentFactors, candidates, opts);
}

// Mode B: 从空池出发（独立探索从零最优路径）
export function buildPathFromZero(rows, candidates, opts = {}) {
  return recommendFactorPath(rows, [], candidates, opts);
}

// ---------- 打分与回测 ----------
// 总分归一到 -100~100：Σ(±w·s)/Σw × 100。按权重和归一而不是假设 Σw=100——用户手动改权重后
// 总和可能不是 100，归一保证 cutoff 的含义（"满分的百分之几"）不随之漂移。
//
// 两阵营符号：勇者阵营（camp!=='evil'）命中自己的区间 = +weight·s（加分）；
// 邪恶阵营（camp==='evil'）命中自己的区间（输家密集/危险区）= -weight·s（减分）。
// 纯勇者阵营场景下（没有 evil 因子）行为与之前完全一致，分数仍落在 0~100。
//
// missingPolicy 两种缺失口径：
//   'zero'（默认）——缺失记 0 分（不加不减）。惩罚的是数据覆盖不是盘质量，但保守。
//   'renorm'——缺失因子不参与，按【在场因子】的权重和归一（score = Σᵢ±wᵢsᵢ / Σ_{有值}wᵢ ×100）。
//     防走样约束：在场权重 < minCoverage（默认 50%）时判 0 分——只剩一两个字段有值的盘
//     不该靠单因子拿高分。
export function scoreRow(row, factors, opts = {}) {
  const { missingPolicy = 'zero', minCoverage = 0.5 } = opts;
  let total = 0, wsum = 0, wPresent = 0;
  const perFactor = factors.map(f => {
    const v = getFeatureValue(row, f.field);
    if (Number.isFinite(v)) wPresent += f.weight;
    const hit = trapScore(v, f.lo0, f.lo1, f.hi1, f.hi0);
    const s = f.camp === 'evil' ? -hit : hit;   // 邪恶阵营命中危险区 → 负分
    total += s * f.weight; wsum += f.weight;
    return s;
  });
  if (missingPolicy === 'renorm') {
    if (wsum <= 0 || wPresent <= 0 || wPresent < wsum * minCoverage) {
      return { score: 0, perFactor, lowCoverage: wPresent < wsum * minCoverage };
    }
    return { score: total / wPresent * 100, perFactor };
  }
  return { score: wsum > 0 ? total / wsum * 100 : 0, perFactor };
}

function getFeatureValue(row, field) {
  const raw = getFeature(row, field);
  if (raw === undefined || raw === null || raw === '') return NaN;
  return Number(raw);
}

export function scoreRows(rows, factors, opts = {}) {
  return rows.map(row => ({ row, ...scoreRow(row, factors, opts) }));
}

export function baseStats(rows, winThreshold = WIN_THRESHOLD) {
  const n = rows.length;
  const pos = rows.filter(r => Number(r.returnMax) > winThreshold).length;
  return { n, pos, baseRate: n ? pos / n : NaN, wilson: wilsonInterval(pos, n) };
}

// 十分位表：按分数升序切 10 个等量段（样本 <30 时减少段数保证每段 ≥3 条）
export function buildScoreDeciles(scored, winThreshold = WIN_THRESHOLD, bins = 10) {
  const sorted = scored.slice().sort((a, b) => a.score - b.score);
  const n = sorted.length;
  if (!n) return [];
  const k = Math.max(1, Math.min(bins, Math.floor(n / 3)));
  const out = [];
  for (let b = 0; b < k; b++) {
    const from = Math.floor(b * n / k), to = Math.floor((b + 1) * n / k);
    const seg = sorted.slice(from, to);
    if (!seg.length) continue;
    const rets = seg.map(s => Number(s.row.returnMax)).sort((x, y) => x - y);
    const pos = seg.filter(s => Number(s.row.returnMax) > winThreshold).length;
    out.push({
      bin: b + 1,
      scoreLo: seg[0].score, scoreHi: seg[seg.length - 1].score,
      n: seg.length, pos, hiRate: pos / seg.length,
      wilson: wilsonInterval(pos, seg.length),
      avgRet: rets.reduce((a, x) => a + x, 0) / rets.length,
      medRet: percentile(rets, 0.5),
    });
  }
  return out;
}

// 阈值扫描：cutoff 网格默认 0~100，每档统计 触发数 / 命中率(精确率) / 捕获率(高倍盘召回) / lift。
// 下界跟着实际分数走：纯勇者阵营时分数不会低于 0，网格保持 0~100 不变（行为与之前完全一致）；
// 一旦有邪恶阵营因子命中把分数拉到负数，下界自动下探到覆盖最低分（按 step 取整），
// 否则阈值扫描会漏掉负分段——那些负分样本会一直"触发"到 cut<=分数的所有档位都看不出来。
export function sweepScoreCutoffs(scored, winThreshold = WIN_THRESHOLD, step = 2) {
  const base = baseStats(scored.map(s => s.row), winThreshold);
  // 用 reduce 而不是 Math.min(0, ...scores)：样本量大时展开成参数列表可能撞 JS 引擎的参数数量上限
  const rawLo = scored.reduce((m, s) => Math.min(m, s.score), 0);
  const rawHi = scored.reduce((m, s) => Math.max(m, s.score), 100);
  const lo = Math.floor(rawLo / step) * step;
  const hi = Math.ceil(rawHi / step) * step;
  const points = [];
  for (let cut = lo; cut <= hi; cut += step) {
    let triggered = 0, hit = 0;
    for (const s of scored) {
      if (s.score >= cut) {
        triggered++;
        if (Number(s.row.returnMax) > winThreshold) hit++;
      }
    }
    points.push({
      cut, triggered,
      hitRate: triggered ? hit / triggered : NaN,
      capture: base.pos ? hit / base.pos : NaN,
      lift: triggered && base.baseRate > 0 ? (hit / triggered) / base.baseRate : NaN,
    });
  }
  return { points, base };
}

// 推荐触发阈值：在扫描网格里找"净超额命中数"最大的 cut——
// 净超额命中数 = 触发数 × (命中率 − 基准命中率) = 比随机抓同样多样本多命中了多少个高倍盘。
// 这个指标天然在"命中率"和"捕获率"之间做权衡，不用像 F1 那样瞎猜权重；
// 只对触发数 ≥ minN 的档位候选，避免顶部样本量太小（几十个）时的噪声档位被选中。
export function recommendCutoff(sweep, opts = {}) {
  const { minTriggered = 20, minFrac = 0.05 } = opts;
  const { points, base } = sweep || {};
  if (!points?.length || !base?.n) return null;
  const minN = Math.max(minTriggered, Math.ceil(base.n * minFrac));
  let best = null;
  for (const p of points) {
    if (!Number.isFinite(p.hitRate) || p.triggered < minN) continue;
    const excess = p.triggered * (p.hitRate - base.baseRate);
    if (!best || excess > best.excess + 1e-9) best = { ...p, excess };
  }
  return best;
}

export function backtestFactors(rows, factors, winThreshold = WIN_THRESHOLD, scoreOpts = {}) {
  const scored = scoreRows(rows, factors, scoreOpts);
  return {
    scored,
    deciles: buildScoreDeciles(scored, winThreshold),
    sweep: sweepScoreCutoffs(scored, winThreshold),
    base: baseStats(rows, winThreshold),
  };
}

// 时间外推验证：区间/梯形/权重【只】在训练段推导，原样套到验证段。
// 验证段指标明显低于训练段 = 参数过拟合了训练期的行情，别直接上实盘。
//
// fieldSpecs 支持两种写法：字符串数组（向后兼容，全部当勇者阵营处理，行为与改动前完全一致），
// 或 {field, camp} 对象数组（camp='hero'|'evil'，两阵营各自在训练段用各自的区间挖掘重新扫描）。
export async function runOOSBacktest(rows, fieldSpecs, winThreshold = WIN_THRESHOLD, opts = {}) {
  const { trainRatio = 0.7, bootstrapB = 100, minCoverage = 0.3, shape = 'trap', missingPolicy = 'zero' } = opts;
  const { train, test } = splitRowsByTime(rows, trainRatio);
  if (train.length < 30 || test.length < 15) {
    return { error: `样本太少：训练段 ${train.length} / 验证段 ${test.length}，至少需要 30/15` };
  }
  const specs = fieldSpecs.map(s => (typeof s === 'string' ? { field: s, camp: 'hero' } : s));
  const heroFields = specs.filter(s => s.camp !== 'evil').map(s => s.field);
  const evilFields = specs.filter(s => s.camp === 'evil').map(s => s.field);
  const scanOpts = { winThreshold, bootstrapB, minCoverage };
  const scans = await Promise.all([
    heroFields.length ? scanFactorCandidates(train, heroFields, { ...scanOpts, camp: 'hero' }) : null,
    evilFields.length ? scanFactorCandidates(train, evilFields, { ...scanOpts, camp: 'evil' }) : null,
  ]);
  const candidates = scans.filter(Boolean).flatMap(s => s.candidates);
  const { factors, skipped } = buildFactors(train, candidates, specs, winThreshold, { shape });
  if (!factors.length) return { error: '训练段推导不出任何有效因子', skipped };
  return {
    trainFactors: factors, skipped,
    trainSize: train.length, testSize: test.length,
    train: backtestFactors(train, factors, winThreshold, { missingPolicy }),
    test: backtestFactors(test, factors, winThreshold, { missingPolicy }),
  };
}

// ---------- 与现有硬门槛策略对比 ----------
export function compareWithHardGate(scored, hardHitIds, cutoff, winThreshold = WIN_THRESHOLD) {
  const all = scored.map(s => s.row);
  const base = baseStats(all, winThreshold);
  const groupStats = (subset) => {
    const rets = subset.map(s => Number(s.row.returnMax)).filter(Number.isFinite).sort((a, b) => a - b);
    const pos = subset.filter(s => Number(s.row.returnMax) > winThreshold).length;
    return {
      n: subset.length, pos,
      hiRate: subset.length ? pos / subset.length : NaN,
      capture: base.pos ? pos / base.pos : NaN,
      medRet: rets.length ? percentile(rets, 0.5) : NaN,
      maxRet: rets.length ? rets[rets.length - 1] : NaN,
    };
  };
  const oldSet = scored.filter(s => hardHitIds.has(s.row.id));
  const newSet = scored.filter(s => s.score >= cutoff);
  const both = scored.filter(s => hardHitIds.has(s.row.id) && s.score >= cutoff);
  return { base, old: groupStats(oldSet), neu: groupStats(newSet), both: groupStats(both) };
}

// ---------- 拍平字段 → 原始 ctx 访问路径 ----------
// 经验法解析：不维护静态映射表，直接抽样本核对"按候选路径取原始值（含 ×100/布尔转换）
// 是否与拍平后的 features 值完全一致"。这样布尔→0/1、数字字符串强转都自动覆盖，
// 而组装字段（原始 ctx 里不存在）会解析失败并给出明确原因，不会生成一段取不到值的代码。
function getPath(obj, path) {
  return path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);
}

// 与 data.js flattenObject 的取值口径一致：布尔→0/1，null/undefined/空串→缺失(null)。
// 注意 null 必须显式判：Number(null) === 0，漏判会把"字段缺失"当成合法的 0——
// 真实快照里缺失字段就是显式 null，这个坑在真实数据回放里踩过（缺失被打成满分）。
function coerceRaw(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const nearlyEqual = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

// 字段来源分类：原字段 = 数据源 ctx 里直接存在、能映射回实盘策略代码的；
// 组装字段 = 本工具聚合/派生出来的（K线量能、holder_* 聚合、信号加工、自定义字段等），
// 实盘 ctx 里没有对应值，进不了生成代码。这里是唯一的分类出口——
// 面板的「原字段/组装字段」筛选和 resolveCtxAccessor 的拒绝逻辑都走它，保证口径一致。
export function classifyFieldOrigin(field) {
  // mcap 是 buildRows 里合并出来的（mcap → current_mcap → fdv 按缺失回退），可映射，算原字段
  if (field === 'mcap') return { original: true };
  if (isAssembledField(field)) {
    return { original: false, reason: isKlineVolumeField(field) ? 'K线量能组装字段，原始 ctx 中不存在' : '组装/派生字段，原始 ctx 中不存在' };
  }
  if (field.startsWith('holder_') || field.startsWith('chip_analysis.')) {
    return { original: false, reason: '持仓/筹码聚合字段，原始 ctx 中不存在' };
  }
  return { original: true };
}

export function resolveCtxAccessor(rows, field) {
  const origin = classifyFieldOrigin(field);
  if (!origin.original) return { ok: false, reason: origin.reason };
  const isMcap = field === 'mcap';
  const mul = PERCENT_FRACTION_FIELDS.has(field) ? 100 : 1;
  // signal 在 buildRows 里是无前缀拍平的，而 ctx.logearn 与 signal 同源——
  // 所以无前缀字段对应 ctx.logearn.<field>；带前缀的（gmgn.* 等）直接对应 ctx.<field>
  const candidates = isMcap ? ['__effMcap__'] : [`logearn.${field}`, field];

  for (const path of candidates) {
    let probed = 0, allMatch = true;
    for (const r of rows) {
      if (!r.rawCtx) continue;
      const featVal = Number(getFeature(r, field));
      if (!Number.isFinite(featVal)) continue;
      const raw = path === '__effMcap__'
        ? (coerceRaw(getPath(r.rawCtx, 'logearn.mcap'))
           ?? coerceRaw(getPath(r.rawCtx, 'logearn.current_mcap'))
           ?? coerceRaw(getPath(r.rawCtx, 'logearn.fdv')))
        : coerceRaw(getPath(r.rawCtx, path));
      if (raw === null) { allMatch = false; break; }
      if (!nearlyEqual(raw * mul, featVal)) { allMatch = false; break; }
      if (++probed >= 30) break;
    }
    if (probed > 0 && allMatch) return { ok: true, path, mul, probed };
  }
  const anyCtx = rows.some(r => r.rawCtx);
  return { ok: false, reason: anyCtx ? '原始 ctx 中找不到与该字段数值一致的路径' : '样本缺少原始 ctx，无法核对' };
}

// ---------- 策略打分代码生成 ----------
// 生成强势盘 code.js 风格的自包含函数体：checks 契约兼容 StrategyReplay 回放。
// 数值序列化要能表达 ±Infinity（JSON 做不到），所以用自定义格式化。
function fmtNum(v) {
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  if (!Number.isFinite(v)) return '0';
  return String(Number(v.toPrecision(8)));
}

export function generateStrategyCode({ factors, resolved, cutoff, winThreshold = WIN_THRESHOLD, sampleN = 0,
                                       missingPolicy = 'zero', minCoverage = 0.5 }) {
  const included = [], excluded = [];
  factors.forEach((f, i) => {
    const r = resolved[i];
    if (r && r.ok) included.push({ f, r });
    else excluded.push({ field: f.field, reason: (r && r.reason) || '未解析' });
  });
  if (!included.length) return { code: null, excluded, error: '没有可映射回原始 ctx 的因子' };

  const lines = [];
  lines.push(`// 打分策略（review 回测·因子面板生成）`);
  lines.push(`// 高倍口径: returnMax > ${winThreshold}x；样本 n=${sampleN}；触发阈值: 总分 >= ${cutoff}`);
  if (excluded.length) {
    lines.push(`// ⚠️ 以下因子无法映射回原始 ctx，已排除（权重未参与归一）：`);
    for (const e of excluded) lines.push(`//    ${e.field}: ${e.reason}`);
  }
  lines.push(`const VERSION = 'factor-score-v1'`);
  lines.push(`const CUTOFF = ${fmtNum(cutoff)}`);
  lines.push(`// 按点号路径取原始 ctx 值`);
  lines.push(`const P = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o)`);
  lines.push(`// 取值口径与回测面板一致：布尔→0/1；null/undefined/空串/非数值视为缺失(null)。缺失记 0 分——`);
  lines.push(`// null 必须显式判（Number(null)===0），否则满分区间含 0 或开区间的因子会把缺失误打成满分。`);
  lines.push(`const V = (x) => { if (x === null || x === undefined) return null; if (typeof x === 'boolean') return x ? 1 : 0; if (typeof x === 'string' && x.trim() === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null }`);
  lines.push(`// 梯形打分：[lo1,hi1] 满分 1，[lo0,lo1]/[hi1,hi0] 线性过渡，界外与缺失为 0`);
  lines.push(`const trap = (x, lo0, lo1, hi1, hi0) => {`);
  lines.push(`  if (x === null || !Number.isFinite(Number(x))) return 0`);
  lines.push(`  const v = Number(x)`);
  lines.push(`  if (v >= lo1 && v <= hi1) return 1`);
  lines.push(`  if (v <= lo0 || v >= hi0) return 0`);
  lines.push(`  if (v < lo1) { const w = lo1 - lo0; return Number.isFinite(w) && w > 0 ? (v - lo0) / w : 0 }`);
  lines.push(`  const w = hi0 - hi1; return Number.isFinite(w) && w > 0 ? (hi0 - v) / w : 0`);
  lines.push(`}`);
  const needEffMcap = included.some(({ r }) => r.path === '__effMcap__');
  if (needEffMcap) {
    lines.push(`// mcap 合并口径与回测数据构建一致：mcap → current_mcap → fdv 按缺失回退`);
    lines.push(`const effMcap = (() => { const a = V(P(ctx, 'logearn.mcap')); if (a !== null) return a; const b = V(P(ctx, 'logearn.current_mcap')); if (b !== null) return b; return V(P(ctx, 'logearn.fdv')) })()`);
  }
  lines.push(`// [名称, 路径, 倍率, 阵营符号(1=勇者阵营加分/-1=邪恶阵营减分), 权重, lo0, lo1, hi1, hi0]`);
  lines.push(`// （倍率：gmgn 的 0-1 占比字段 ×100 成百分比，与面板一致）`);
  lines.push(`const FACTORS = [`);
  for (const { f, r } of included) {
    const b = [f.lo0, f.lo1, f.hi1, f.hi0].map(fmtNum).join(', ');
    const sign = f.camp === 'evil' ? -1 : 1;
    lines.push(`  ['${f.field}', '${r.path}', ${r.mul}, ${sign}, ${fmtNum(f.weight)}, ${b}],`);
  }
  lines.push(`]`);
  lines.push(`let total = 0, wsum = 0, wpres = 0`);
  lines.push(`const checks = FACTORS.map(fc => {`);
  lines.push(`  const raw = fc[1] === '__effMcap__' ? effMcap : V(P(ctx, fc[1]))`);
  lines.push(`  const val = raw === null ? null : raw * fc[2]`);
  lines.push(`  const hit = trap(val, fc[5], fc[6], fc[7], fc[8])`);
  lines.push(`  const s = fc[3] * hit   // 邪恶阵营(fc[3]=-1)命中危险区 → 负分`);
  lines.push(`  total += s * fc[4]; wsum += fc[4]; if (val !== null) wpres += fc[4]`);
  lines.push(`  const label = fc[3] < 0 ? '危险区 ' : '满分 '`);
  lines.push(`  return [fc[0], hit > 0, (val === null ? '缺失' : String(Number(val.toFixed(4)))) + ' → ' + (s * fc[4]).toFixed(1) + '分', label + fc[6] + '~' + fc[7] + ' 权重 ' + fc[4]]`);
  lines.push(`})`);
  if (missingPolicy === 'renorm') {
    lines.push(`// 缺失口径=重归一：缺失因子不参与，按在场因子权重和归一；`);
    lines.push(`// 在场权重不足 ${Math.round(minCoverage * 100)}% 时判 0 分（数据太残缺的盘不靠单因子拿高分）。与回测面板一致`);
    lines.push(`const score = (wsum > 0 && wpres > 0 && wpres >= wsum * ${fmtNum(minCoverage)}) ? total / wpres * 100 : 0`);
  } else {
    lines.push(`// 缺失口径=记0分；总分按权重和归一到 0~100，cutoff 的含义（满分的百分之几）不随权重编辑漂移`);
    lines.push(`const score = wsum > 0 ? total / wsum * 100 : 0`);
  }
  lines.push(`checks.push(['总分', score >= CUTOFF, score.toFixed(1), '>= ' + CUTOFF])`);
  lines.push(`const head = VERSION + ' [' + ((ctx.logearn && ctx.logearn.symbol) || 'UNKNOWN') + '] 总分 ' + score.toFixed(1)`);
  lines.push(`const detail = checks.map(c => c[0] + '(' + c[1] + '): ' + c[2] + ' [' + c[3] + ']').join('  |  ')`);
  lines.push(`if (score < CUTOFF) { ctx.log.error('未命中 ' + head + '  ||  ' + detail); return false }`);
  lines.push(`ctx.log.success('命中<打分> ' + head + '  ||  ' + detail)`);
  lines.push(`return true`);
  return { code: lines.join('\n'), excluded, includedCount: included.length };
}
