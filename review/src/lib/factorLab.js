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
import { percentile, wilsonInterval, spearman, splitTrainTest, median, WIN_THRESHOLD, benjaminiHochbergAdjust, mulberry32, twoProportionTestP } from './utils.js';
import { collectAucSamples, aucForField, finalizeAucScan, isUsableAuc, AUC_TARGET_FIELDS } from './auc.js';
import { getFeature, isAssembledField, isKlineVolumeField, PERCENT_FRACTION_FIELDS } from './data.js';
import { fieldMcapRho } from './fieldAudit.js';

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
  // 上界【先】判、且取右开（v >= hi0 → 0）：挖区间/算 lift 的口径是 [lo, hi)（见 scanIntervalCore
  // 的 inWin），shape='interval' 退化成矩形时 hi1===hi0===hi，若还按 v<=hi1 判满分，落在右端点上的
  // 样本就会"统计上不算命中、打分却给满分"。连续字段几乎看不出来，但离散字段（布尔 0/1、计数、
  // 被截断的比例）大量样本恰好压在端点上，差异是成片的。
  // 梯形形状不受影响：lo0<lo1<hi1<hi0 时 v>=hi0 本来就该是 0。
  // 下界仍留在核心判定【之后】：矩形时 lo0===lo1===lo，左端点属于区间内（左闭），不能提前判 0。
  if (v >= hi0) return 0;
  if (v >= lo1 && v <= hi1) return 1;
  if (v <= lo0) return 0;
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
// camp='hero'（勇者阵营，默认）挖高倍盘集中区，用来加分；camp='evil'（邪恶阵营）挖输家
// 集中区，用来减分。两个阵营各自独立扫描（同一批字段可以分别喂两次，各自选出自己的候选池），
// 每个候选对象都带上 camp 标记，供 buildFactors/打分阶段区分正负号。
// 拆成三层复用：computeFieldRaw（逐字段纯计算，可并行）→ assembleCampScan（全量汇齐后统一做 BH）
// → scanFactorCandidates（主线程串行版，把两者串起来）。worker 并行路径（ui/factorLab/scanWorker.js
// + workerPool.js）跳过中间的串行循环，直接 computeFieldRaw 分批并行、再 assembleCampScan，
// 结果与串行版逐字段一致（factorlab.test.js 的既有用例守着这份等价性）。
// 单字段原始扫描（一个阵营）：算 AUC（含 bootstrap CI）+ 仅对"可用"字段顺带挖区间/算缺失率。
// 纯计算、无 BH、无跨字段依赖——所以能安全丢进 worker 逐字段并行跑（见 ui/factorLab/scanWorker.js）。
// 不可用字段（样本太少/全同类）不挖区间，跟旧版 scanFactorCandidates 里"只对 usable 循环挖区间"一致。
// AUC_TARGET_FIELDS（returnMax 及其变换）由调用方在派发前过滤掉，这里不再重复判断。
export function computeFieldRaw(rows, field, opts = {}) {
  const { winThreshold = WIN_THRESHOLD, bootstrapB = 200, minCoverage = 0.3, camp = 'hero' } = opts;
  const auc = aucForField(rows, field, { winThreshold, bootstrapB });
  if (!isUsableAuc(auc)) return { field, auc, interval: null, missRate: undefined };
  const findInterval = camp === 'evil' ? findColdInterval : findHotInterval;
  const interval = findInterval(rows, field, { winThreshold, minCoverage });
  // 与进场市值的秩相关跟着扫描一起算（O(n log n)，相对 AUC bootstrap + 区间置换检验可以忽略），
  // 这样候选表一出来就带着"是不是进场市值的影子"这个判据，不用再点一次按钮。
  return { field, auc, interval, missRate: missingRate(rows, field),
           mcapRho: fieldMcapRho(rows, field) };
}

// 把一批 computeFieldRaw 的结果（某个阵营的全部非目标字段）组装成 { candidates, skipped }——
// AUC 的 BH 校正/排序（finalizeAucScan）和区间的 BH 校正都在这里、在【全量汇齐后】做一次，
// 保证不管上游是主线程串行还是 worker 分批并行算出来的 raw，最终口径完全一致。
export function assembleCampScan(rawList, camp = 'hero') {
  const { results, usable } = finalizeAucScan(rawList.map(r => r.auc));
  const rawByField = new Map(rawList.map(r => [r.field, r]));
  const out = usable.map(a => {
    const raw = rawByField.get(a.field);
    const interval = raw ? raw.interval : null;
    return {
      field: a.field, n: a.n, pos: a.pos, auc: a.auc, ci: a.ci, direction: a.direction,
      significant: a.significant, significantAdj: a.significantAdj, pAdj: a.pAdj,
      interval: interval && !interval.error ? interval : null,
      intervalError: (interval && interval.error) || null,
      missRate: raw ? raw.missRate : undefined,
      mcapRho: raw ? raw.mcapRho : undefined,
      camp,
    };
  });
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

export async function scanFactorCandidates(rows, fields, opts = {}) {
  const { winThreshold = WIN_THRESHOLD, bootstrapB = 200, minCoverage = 0.3, camp = 'hero' } = opts;
  const scanned = fields.filter(f => !AUC_TARGET_FIELDS.has(f));
  const rawList = [];
  for (let i = 0; i < scanned.length; i++) {
    if (i % 20 === 19) await new Promise(r => setTimeout(r, 0)); // 让出一帧，避免长任务卡死主线程
    rawList.push(computeFieldRaw(rows, scanned[i], { winThreshold, bootstrapB, minCoverage, camp }));
  }
  return assembleCampScan(rawList, camp);
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
// 打分形状只有梯形（trap）：目标类密集核满分，向硬界线性衰减，区间边缘拿部分分。
//
// 2026-07-29 删除了 shape:'interval'（区间命中＝把梯形退化成矩形 lo0=lo1=lo, hi1=hi0=hi）。
// 梯形是它的超集：区间边界本来就是从 O(边界数²) 个窗口里搜出来的最优窗口，边缘那段线性衰减
// 正是对"边界不可能刚好卡准"的软化；退回硬矩形只会让边界附近的样本被非黑即白地判定。
// 注意 **矩形因子本身仍然合法**——从策略导入时 checks 文案只编码了核心区 [lo1,hi1]，就是按
// lo0=lo1/hi1=hi0 近似导入的，trapScore 对矩形的处理（见其右端点注释）不能删。
// 删的只是"扫描完按矩形建因子"这个选项，opts.shape 参数保留但当前唯一取值是 'trap'。
export function buildFactors(rows, candidates, fieldSpecs, winThreshold = WIN_THRESHOLD, opts = {}) {
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
    const bounds = camp === 'evil'
      ? deriveColdTrapezoid(rows, field, c.interval, winThreshold)
      : deriveTrapezoid(rows, field, c.interval, winThreshold);
    if (bounds.error) { skipped.push({ field, reason: bounds.error }); continue; }
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
// 把一组非负 raw 归一成"总和恰为 100、保留 1 位小数"的权重（最大余数法修尾差）。
function normalizeTo100(factors, raw) {
  const sum = raw.reduce((a, b) => a + b, 0);
  const shares = sum > 0 ? raw.map(x => x / sum * 100) : raw.map(() => 100 / factors.length);
  const floored = shares.map(x => Math.floor(x * 10) / 10);
  let remain = Math.round((100 - floored.reduce((a, b) => a + b, 0)) * 10);
  const order = shares.map((x, i) => [x - floored[i], i]).sort((a, b) => b[0] - a[0]);
  const weights = floored.slice();
  for (let k = 0; remain > 0; k = (k + 1) % order.length, remain--) weights[order[k][1]] += 0.1;
  return factors.map((f, i) => ({ ...f, weight: Math.round(weights[i] * 10) / 10 }));
}

export function autoWeights(factors) {
  if (!factors.length) return factors;
  const scored = factors.map(f => Number(f.interval?.score) || 0);
  const hasScore = scored.map(s => s > 0);

  // 一个因子都没有区间分数：典型是"从策略代码导入的因子池"（importFromStrategy 造出来的因子
  // interval=null）或全手工建的池。这时没有任何自动配权的依据——有现成权重就按现成权重的相对
  // 比例归一（导入策略里的权重是真实信息，抹成均分等于把用户的策略改了），全都没权重才退化成均分
  // （保持旧行为：新建/占位因子）。
  if (!hasScore.some(Boolean)) {
    const ws = factors.map(f => Math.max(0, Number(f.weight) || 0));
    return normalizeTo100(factors, ws.some(w => w > 0) ? ws : factors.map(() => 1));
  }

  // 混合池（一部分有区间分数、一部分没有——比如导入池之后又扫出新因子，或跨字段范围保留下来的
  // 老因子）：无分数的那批按【它们现有权重的相对比例】参与分配，规模对齐到有分数那批的平均分。
  // 不能直接拿 weight 当 raw：权重是 0~100 量纲、interval.score 通常在 0.5~2，混在一起归一会让
  // 无分数的因子吃掉几乎全部权重。也不能像原来那样记 0——那会把导入/手工因子的权重静默清零
  // （真实事故：导入策略后随便点一次扫描或删一个因子，导入的因子就全变 0 权重了）。
  const scoreVals = scored.filter((s, i) => hasScore[i]);
  const avgScore = scoreVals.reduce((a, b) => a + b, 0) / scoreVals.length;
  const noScoreW = factors.filter((f, i) => !hasScore[i]).map(f => Math.max(0, Number(f.weight) || 0));
  const avgNoScoreW = noScoreW.length ? noScoreW.reduce((a, b) => a + b, 0) / noScoreW.length : 0;
  const raw = factors.map((f, i) => {
    if (hasScore[i]) return scored[i];
    const w = Math.max(0, Number(f.weight) || 0);
    return avgNoScoreW > 0 ? (w / avgNoScoreW) * avgScore : avgScore;
  });
  return normalizeTo100(factors, raw);
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

// 按 score 排序后切成粗粒度分档：给已排好分数的 pairs 按分位数切 K 档（同分绝不跨档，
// 仿 computeScoreBuckets），供散点图画"档边界/档命中率"，以及 bucketZigzag 数锯齿。
//
// 下面这几条参数选择都是真实数据上踩出来的，改之前先读（2026-07-28 那一串订正的结论浓缩版；
// 当时它还给一个叫 bucketRankRho 的目标函数供数，那条线 2026-07-29 已整体删除，见 readme 第 11 节，
// 但这些关于"怎么切档才不会切出假信号"的教训对现在的诊断用途一样成立）：
//
// · **K 不能小（minK=5）**：最早 K 固定 3~5，秩相关只有 3~5 个点参与计算，"凑巧排对顺序"的概率
//   远高于全局 ρ（几百个点）"整条序列都排对"。真实数据里 frequent_volume 单独一个因子就跑出过
//   Δ=+1.000 的顶格值——那是离散网格效应，不是真信号。
// · **档大小固定下限 15，不按命中率反推**：曾按"每档期望命中数≥3"算档大小，test 段样本少、
//   局部命中率一低，ceil(3/rate) 会把档点数顶得很大、K 又被压回 3，等于绕回最初那个坑。
// · **档内统计量用命中率不用中位数**：倍数分布是一大坨 1~3x 普通盘 + 一小撮尾部，中位数被普通盘
//   钉死，尾部涨多猛都感受不到；命中率才跟十分位表"高倍率一路爬升"同一个口径。
//   代价是小分桶下方差更大，靠 bucketSize 自适应放大（max(15, ceil(minHitCount/rate))）兜。
// · **不能"某档实际命中数<3 就剔除该档"**：试过又踩的坑——一个 n=65 的大档实际命中数=0，恰恰是
//   "该档命中率确信地很低"这个真信号的一部分；按绝对命中数剔除会把两端本该确信的大档一起滤掉，
//   破坏序列完整性。噪声只能靠分档时的事前防护控制，不能拿实现结果去筛统计假设。
// winThreshold 不是 finite 时退回中位数口径，保证向后兼容。
// 返回 null（档数不足，网格太粗不可信）或 { buckets: [{loScore,hiScore,medianRet,hitRate,hitCount,n}] }。
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
  return { buckets };
}

// 诊断用：从一组档（computeRankBuckets 的输出）里挑出"打架"（命中率比前一档还低）的位置，
// 不用把所有档摊开来人工目测——inversions 数组每项标出具体是哪两档、命中率差多少、
// 那个分数区间在哪，方便直接定位"贪心这一步加的因子，是不是把哪一段分数区间的排序搅乱了"。
// 锯齿诊断：spearman 只看整条序列"大体上"排没排对，一条整体爬升但中间反复倒挂的曲线照样能
// 换出不算差的秩相关。这个函数数相邻档命中率倒挂的次数与幅度，接在 recommendFactorPath 每一步的
// 导出诊断上（UI 路径标签的 🌀N）。它曾被接进一个目标函数当惩罚项（bucketRankRho），那条线已删除
// ——它现在纯粹是给人看的诊断，不参与任何优化，这样也更合适：锯齿该由人判断严不严重。
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

// ---------- 边际ρ 的置换零分布（"这个增量算不算超出噪声"的经验标尺）----------
// 边际ρ 不是教科书统计量，没有现成的 p 值可查，SOP 里"≥0.005 才算有正贡献"那条线是拍出来的。
// 这里给它一个经验零分布：把 returnMax 在样本间【完全打乱】（字段值原样不动，只切断字段与
// 收益的对应关系），再把整条流水线原样重跑一遍——重挖区间、重推梯形、重算 Δρ。
// 必须整条重跑而不是复用真标签挖出的区间：边际ρ 的水分有很大一部分正是"从几百个候选窗口里
// 挑最优"挑出来的，只打乱标签却沿用旧区间，等于把这部分搜索自由度藏起来，零分布会偏低。
//
// 得到的分布回答两个问题：
//   · 这批数据、这个池子下，纯噪声能凑出多大的边际ρ（q95/q99 就是"阈值该设多少"的依据）；
//   · 某个候选的 Δρ 在零分布里排第几（经验 p 值）。
//
// 量的必须是【跟候选表同一个统计量】：候选表显示的是 computeHeldOutDeltaRho 的 deltaTest
// （held-out 增量），所以零分布也必须用 deltaTest 去凑，不能用样本内增量——两者的噪声量级不是
// 一回事（held-out 更散），拿样本内的 q95 去卡 held-out 的观测值，这把尺子就是错的。
//
// 成本 = permutations × candidates 次"挖区间 + 切分 + 四次打分"（held-out 要 train/test 各评
// baseline 与 with 两次，比样本内版本贵一倍左右），所以：
//   · 区间挖掘的内部置换检验关掉（permB:0）——那是给单区间显著性用的，这里只要区间本身；
//   · 候选由调用方抽样传入（UI 默认等间隔抽一批），不必也不该跑满全表。
// 种子固定（mulberry32，跟 bootstrapAucCI/scanIntervalCore 同一套），同一份数据结果可复现。
export function permutationNullMarginalRho(rows, currentFactors, candidates, winThreshold = WIN_THRESHOLD, opts = {}) {
  const { shape = 'trap', missingPolicy = 'zero', buildRows = rows, minCoverage = 0.3,
          trainRatio = 0.7, timeField = 'swapBeginTime', splitMethod = 'time',
          permutations = 20, seed = 0x5EED1234, onProgress } = opts;
  const cands = (candidates || []).filter(c => c && c.field);
  if (!cands.length) return { error: '没有可用于置换检验的候选' };
  if (!rows || rows.length < 20) return { error: '样本太少，置换零分布没有意义' };

  const rand = mulberry32(seed);
  const deltas = [];
  let attempted = 0;
  for (let b = 0; b < permutations; b++) {
    // 打乱 returnMax：行对象浅拷贝（features/ctx 仍是引用，不额外占内存），只把收益换成别人的。
    // 同时记下"原行 → 置换行"的映射，好让 buildRows（候选实际挖自的那份行集，通常就是 rows）跟着换成
    // 同一批置换行——否则挖区间用的是打乱后的标签、打分用的是原标签，零分布就不干净了。
    const rets = rows.map(r => r.returnMax);
    for (let i = rets.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = rets[i]; rets[i] = rets[j]; rets[j] = t;
    }
    const permMap = new Map();
    const permRows = rows.map((r, i) => { const p = { ...r, returnMax: rets[i] }; permMap.set(r, p); return p; });
    const permBuild = buildRows === rows ? permRows : buildRows.map(r => permMap.get(r)).filter(Boolean);
    if (!permBuild.length) continue;

    for (const c of cands) {
      attempted++;
      const camp = c.camp === 'evil' ? 'evil' : 'hero';
      const findInterval = camp === 'evil' ? findColdInterval : findHotInterval;
      // 区间仍在【全量】permBuild 上挖，不切训练段——观测侧的候选 .interval 也是全样本扫描
      // 挖出来的，零分布必须复刻同一条流水线（切了反而比观测值少一层搜索自由度，尺子偏松）。
      // 真正的 held-out 只发生在下一步：梯形边界只看 train，Δρ 只在 test 上读。
      const interval = findInterval(permBuild, c.field, { winThreshold, minCoverage, permB: 0 });
      if (!interval || interval.error) continue;   // 打乱后挖不出区间 = 这一次没有候选可加，不计入分布
      const r = computeHeldOutDeltaRho(permRows, currentFactors || [], { field: c.field, camp, interval }, camp,
        winThreshold, { shape, missingPolicy, buildRows: permBuild, trainRatio, timeField, splitMethod });
      if (r && Number.isFinite(r.deltaTest)) deltas.push(r.deltaTest);
    }
    if (onProgress) onProgress({ completed: b + 1, total: permutations });
  }
  return summarizeNullDistribution(deltas, { permutations, candidates: cands.length, attempted });
}

// 把置换出来的一堆 Δρ 汇总成零分布描述。单独一个函数是为了让"分片并行跑置换、主线程合并"
// 这条路径（workerPool.runPermutationNullWithWorkers）用同一套分位数口径，而不是各算各的。
export function summarizeNullDistribution(deltas, meta = {}) {
  const vals = (deltas || []).filter(Number.isFinite);
  const sorted = vals.slice().sort((a, b) => a - b);
  // 样本不够时仍然把 deltas 原样带回：分片并行跑置换时，单片可能不够 10 个，
  // 但几片合起来往往够——调用方要能把碎片拼起来再汇总一次。
  if (sorted.length < 10) return { error: `置换后只得到 ${sorted.length} 个有效样本，无法给出零分布`, deltas: sorted, ...meta };
  const q = p => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
  return {
    n: sorted.length,
    // 挖不出区间的那部分（attempted - n）本身也是信息：打乱后压根找不到区间，说明该字段的
    // 区间强依赖真实标签，这是好事；但比例过高会让分布只由少数字段贡献，所以一并报出来
    ...meta,
    q50: q(0.50), q90: q(0.90), q95: q(0.95), q99: q(0.99), max: sorted[sorted.length - 1],
    deltas: sorted,
  };
}

// 某个观测到的边际ρ 在零分布里的经验 p 值（有多大比例的纯噪声能达到或超过它）。
// +1/+1 是置换检验的标准修正，保证 p 永远 > 0（跑 N 次置换最多只能说"p < 1/(N+1)"）。
export function permutationPValue(nullDist, delta) {
  if (!nullDist || !nullDist.deltas || !Number.isFinite(delta)) return NaN;
  const ge = nullDist.deltas.reduce((a, d) => a + (d >= delta ? 1 : 0), 0);
  return (ge + 1) / (nullDist.deltas.length + 1);
}

// 【边际ρ 的唯一口径】候选字段进池后对目标函数的增量，train 拟合 / test 验证。
// - 在训练段推导梯形边界（build on train），在验证段计算目标函数的增量（held-out Δ）
// - 同时返回训练段内的 Δ 供对照，帮助识别过拟合（deltaTrain 涨而 deltaTest 不涨）
// 2026-07-29 起「计算候选边际ρ贡献」按钮、「算推荐」的候选预筛、置换零分布三处全部走这一个
// 函数——此前按钮走的是样本内版 factorMarginalRho（无 train/test 切分），"挑因子"这一步因此
// 没有任何过拟合防护，噪声候选可以带着虚高的增量直接进池，而下游 train/test 对比只看得见
// "权重组合"层面的过拟合、看不见这层。那个函数已删除，避免两套口径再次分叉。
//
// opts.buildRows：候选的 .interval 是在哪份数据上挖出来的（默认就是 rows；rows 换过而候选还是老那批时不同），边界就得在
// 同一份数据上推——但同样只取它的 train 段，否则边界看过验证段，deltaTest 就不是 held-out 了。
// opts.scoreFn：目标函数，默认 scorePoolRho（全程 spearman）；注入而不写死，见 optimizeWeightsForRho。
// 返回 { baselineTrain, withTrain, deltaTrain, baselineTest, withTest, deltaTest, nTrain, nTest }
export function computeHeldOutDeltaRho(rows, currentFactors, candidate, camp, winThreshold = WIN_THRESHOLD, opts = {}) {
  const { shape = 'trap', missingPolicy = 'zero', trainRatio = 0.7, timeField = 'swapBeginTime', splitMethod = 'time',
          buildRows = null, scoreFn = scorePoolRho } = opts;
  if (!candidate || !candidate.interval) return { error: '该字段无可信区间，无法评估' };
  const { train, test } = splitTrainTest(rows, splitMethod, trainRatio, timeField);
  if (!train.length || !test.length) return { error: '训练/验证分割后样本不足' };

  // 构造只含 candidate 的因子（在 train 上推导梯形/界限）；传了 buildRows 就改用那份行集的 train 段
  const deriveRows = buildRows && buildRows !== rows
    ? splitTrainTest(buildRows, splitMethod, trainRatio, timeField).train
    : train;
  if (!deriveRows.length) return { error: '训练段没有可用于推导边界的样本' };
  const built = buildFactors(deriveRows, [candidate], [{ field: candidate.field, camp }], winThreshold, { shape }).factors;
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
// 搜非负权重最大化它。ρ 最优配权、recommendFactorPool 的精配权与影子权重共用这一套搜索外壳——
// 目前唯一的 objFn 是 scorePoolRho（可由调用方注入别的目标函数）。
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

// opts.scoreFn 是注入的目标函数（同 computeHeldOutDeltaRho），默认 scorePoolRho；
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

// 起点池（"组合路径"模式）+ 新增字段一起建因子。
// 为什么不能直接 buildFactors(rows, candidates, [...起点spec, ...新增spec])：起点池里的因子未必
// 能从【本次】candidates 重建——勾了"只看勇者阵营"会把 evil 候选整个滤掉、换过字段范围
// 后候选集也会变、上一轮扫描没挖出区间的字段同样不在里面。buildFactors 对查不到候选的 spec 是
// 【静默跳过】的，于是起点池会悄悄少几个因子，后果有两层：① 基线目标值按残缺池算，新增字段的 Δ
// 虚高；② UI 的"采用"是整体替换因子池，用户池子里那几个因子就这么没了（真实可复现：combo 模式
// + 只看勇者，池里的邪恶因子采用一次就消失）。
// 这里统一兜底：能从候选重建的照常重建（保住"边界在 train 段推导"这条纪律），重建不出来的直接
// 沿用传进来的因子对象本身（它自带边界，只是这次不重新推导）——起点池只增不减。
function buildWithBase(baseFactors, rowsForBuild, candidates, addSpecs, threshold, shape) {
  const base = baseFactors || [];
  const specs = [...base.map(f => ({ field: f.field, camp: f.camp })), ...addSpecs];
  const built = buildFactors(rowsForBuild, candidates, specs, threshold, { shape }).factors;
  const builtKeys = new Set(built.map(f => f.camp + ':' + f.field));
  const kept = base.filter(f => !builtKeys.has(f.camp + ':' + f.field));
  return [...kept, ...built];
}

// ---------- 因子推荐：贪心前向，按 held-out 边际 ρ 排（抗过拟合）----------
// 从 startFactors 出发（组合路径模式）或从空（探索全路径模式，startFactors=[]），每步选
// 「加进去让验证段 ρ 涨最多」的候选，加入，再算下一步 → 一条 a→b→c 路径。
// 口径：区间/边界在【训练段】推导（减少泄漏），权重 autoWeights，目标函数在【验证段】评估；
// 同时给样本内 Δ 供对照（两者背离大=过拟合迹象）。候选按 interval.score（区间感知，见
// scanIntervalCore/autoWeights 注释）降序排（2026-07-28 从 |AUC−0.5| 换过来，AUC 假设方向
// 单调会漏掉"驼峰型"字段，interval.score 才跟下游打分（区间/梯形）口径一致），排序只影响
// 同一步内候选评估的先后顺序，不截断——2026-07-28 又订正：曾经在这里加过 candLimit=50 只取
// 排名前50的候选控算力，真实数据上会漏掉排名靠后但组合起来有用的字段，用户明确要求去掉这道截断。
//
// 2026-07-29：本函数现在是【唯一】的选字段引擎——`recommendFactorPool`（UI 那张合并后的
// 「因子推荐」卡片）直接调它选字段，再接自己的收尾（精配权/影子权重/K折 k*）。此前还有一条
// `recommendFactorPoolFull` 的平行实现在【全样本内】贪心选字段（靠事后校验兜底），已删除：
// 那正是 computeHeldOutDeltaRho 那次统一要修的毛病——在同一批样本上挖边界又评估增量，
// 等于自己给自己判卷，事后校验只能说"整体过不过拟合"，改变不了选的时候就被噪声带偏。
// candidates: [{ field, camp, interval, auc }]（两阵营合并，需带 interval）。
// opts.scoreFn 同 computeHeldOutDeltaRho，默认 scorePoolRho——注入而不是写死，避免"换目标函数"要在
// 多处复制这条贪心搜索逻辑。
// 返回 { path:[{field,camp,deltaTest,deltaIn,testRho,inRho,overfit}], baseTestRho, nTrain, nTest }。
export function recommendFactorPath(rows, startFactors, candidates, opts = {}) {
  const { threshold = WIN_THRESHOLD, missingPolicy = 'zero', shape = 'trap',
    maxSteps = 6, minGain = 0.003, trainRatio = 0.7, timeField = 'swapBeginTime',
    splitMethod = 'time', candLimit = Infinity, batchSize = 10, scoreFn = scorePoolRho } = opts;
  const { train, test } = splitTrainTest(rows, splitMethod, trainRatio, timeField);
  const scoreOf = (rowsSet, factorSet) => scoreFn(rowsSet, factorSet, missingPolicy);
  // 候选：必须有区间；按 interval.score 降序排（不截断，见上方注释）；排除已在起点池里的。
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

  const buildOf = (addSpecs, rowsForBuild) => buildWithBase(startFactors, rowsForBuild, candidates, addSpecs, threshold, shape);
  let pathSpecs = [];          // 只记【新增】的 spec，起点池由 buildWithBase 兜底（见其注释）
  const chosen = new Set(startKeys);
  const hasBase = !!(startFactors && startFactors.length);
  let baseTestRho = hasBase ? scoreOf(test, autoWeights(buildOf([], train))) : NaN;
  let baseInRho = hasBase ? scoreOf(rows, autoWeights(buildOf([], train))) : NaN;
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

// ---------- 因子推荐：选字段（held-out 贪心）→ 精配权 → 过拟合校验 → K折定因子数 ----------
// 2026-07-29 合并：此前这里是两个并列的推荐函数——`recommendFactorPath`（选字段做 train/test
// 切分，抗过拟合，但不配权、不给因子数建议）和 `recommendFactorPoolFull`（选字段在全样本内做，
// 靠事后校验兜底，但会精配权 + 给 K折 k*），UI 上是两张卡片。并列的代价不是多几行代码，是
// 【同一个问题两个答案】，用户还得判断信哪个。
// 合并取的是各自的长处：**选字段用 held-out**（跟 computeHeldOutDeltaRho 那次统一同一套纪律——
// 边界是从这批样本里搜出来的，就不能在同一批样本上评估它的增量），**收尾用原来因子推荐2 那三件套**：
//   ① 全样本坐标上升精配权（采用即用，不必再手动点「🎯按ρ最优配权」）；
//   ② 影子权重过拟合校验（只用 train 拟合、对 test 全盲，见下方注释）；
//   ③ heldOutFactorCurve K折曲线 + 1-SE 推荐因子数 k*（甩掉过拟合尾巴）。
//
// candidates: [{ field, camp, interval, auc }]（两阵营合并，需带 interval；字段范围由调用方决定）。
// opts.startFactors（"组合路径"模式）：非空时贪心从这份起点池出发，只找【新增】字段——起点池不
// 重复挑选、也不计入 held-out 曲线的因子数 k（视为用户已采信，见 heldOutFactorCurve 的 baseFactors）。
// 返回 { path, factors, rhoBefore, rhoAfter, rhoTrain, rhoTest, overfit, nTrain, nTest,
//        zeroedFields, n, heldoutCurve, recommendedCount, factorsTrimmed } 或 { path: [], error }。
// path 每项来自 recommendFactorPath，带 deltaTest/deltaIn/overfit/testZigzag 等逐步诊断。
export function recommendFactorPool(rows, candidates, opts = {}) {
  const { threshold = WIN_THRESHOLD, missingPolicy = 'zero', shape = 'trap',
    // maxSteps 从原「因子推荐」的 6 放宽到 12：后面还有 K折 k* 兜底截断长尾，与其在贪心阶段
    // 就保守停手（可能漏掉组合起来才有用的字段），不如多走几步、由 held-out 曲线决定砍在哪。
    // minGain 维持 0.003（原「因子推荐」的值），没跟着放宽——本来想收到 0.001，实测被打脸：
    // 概念漂移那条用例里，一个验证段上其实已经没有信号的字段拿到 deltaTest=+0.009，两个阈值
    // 都拦不住。说明 minGain 只是个"别把 0 也算进来"的地板，**它不是过拟合防线**；真正认得出
    // 这种字段的是每步的 overfit 标记（deltaIn 0.249 vs deltaTest 0.009）和影子权重校验。
    // 既然拦不住，就没有理由为它放宽——保持原值。
    maxSteps = 12, minGain = 0.003, maxRounds = 40,
    trainRatio = 0.7, timeField = 'swapBeginTime', splitMethod = 'time',
    startFactors: startPool = [] } = opts;
  const scoreOf = (rowsSet, factorSet) => scorePoolRho(rowsSet, factorSet, missingPolicy);
  if (!(candidates || []).some(c => c && c.interval)) return { path: [], error: '没有可推荐的候选（先扫描）' };

  // ① 选字段：held-out 贪心。边界在 train 段推、增量在 test 段读，只收验证段真涨的候选。
  const sel = recommendFactorPath(rows, startPool, candidates,
    { threshold, missingPolicy, shape, maxSteps, minGain, trainRatio, timeField, splitMethod });
  const path = sel.path || [];
  if (!path.length) {
    return { path: [], baseTestRho: sel.baseTestRho, nTrain: sel.nTrain, nTest: sel.nTest,
      error: sel.error || (startPool.length
        ? '当前池子已经不错——没有候选能让验证段ρ再提升（或都是负贡献）。'
        : '没有候选能让验证段ρ提升（先降低阈值或多攒数据）') };
  }

  // buildWithBase 而不是裸 buildFactors：起点池里重建不出来的因子（heroOnly 滤掉了 evil 候选、
  // 换过字段范围等）原样保留，不会被静默丢掉——见 buildWithBase 注释。
  const buildOf = addSpecs => buildWithBase(startPool, rows, candidates, addSpecs, threshold, shape);
  const pathSpecs = path.map(p => ({ field: p.field, camp: p.camp }));

  // 坐标上升配权的公共外壳：两个初值（autoWeights + 等权）各跑一次取目标值更优的。
  // 精配权/影子权重/截断池三处都要，抽出来免得三份复制粘贴各自漂移。
  const fitWeights = (rowsSet, factorList) => {
    const starts = [autoWeights(factorList).map(f => f.weight), factorList.map(() => 1)];
    let best = null;
    for (const st of starts) {
      const r = coordinateAscentGeneric(scoreOf, rowsSet, factorList, st, missingPolicy, maxRounds);
      if (!best || r.rho > best.rho) best = r;
    }
    return best;
  };
  const normalizeWeights = w => {
    const sum = w.reduce((a, b) => a + b, 0);
    return sum > 0 ? w.map(x => Math.round(x / sum * 1000) / 10)
                   : w.map(() => Math.round(1000 / w.length) / 10);
  };

  // ② 精配权：路径定下来后在全样本上配一次权重，这份才是返回给用户"采用即用"的。
  // 全样本而不是只用 train——最终就是要在全体样本上打分，物尽其用；它是否过拟合由 ③ 单独校验。
  const fullFactors = buildOf(pathSpecs);
  const rhoBefore = scoreOf(rows, autoWeights(fullFactors));   // 精配权前：区间打分自动权重
  const bestW = fitWeights(rows, fullFactors);
  const newFactors = applyWeights(fullFactors, normalizeWeights(bestW.w));
  const zeroedFields = newFactors.filter(f => f.weight <= 0.05).map(f => f.field);

  // ③ 事后过拟合校验：另配一份"影子权重"——只用 train 拟合（对 test 完全盲），拿去 test 上打分。
  // 不能直接拿上面已经用全样本配好的 newFactors 去两边打分：那份权重配权时已经见过 test，
  // 事后怎么切都显得稳，等于拿抄过答案的卷子对答案（2026-07-28 真实数据上现过原形，见 readme）。
  // 影子权重只用于诊断数字，不影响返回给用户的 factors。
  const { train, test } = splitTrainTest(rows, splitMethod, trainRatio, timeField);
  const bestShadow = fitWeights(train, fullFactors);
  const rhoTrain = bestShadow.rho;   // = scoreOf(train, shadowFactors)，坐标上升内部已经算过
  const rhoTest = scoreOf(test, applyWeights(fullFactors, bestShadow.w));
  const overfit = Number.isFinite(rhoTrain) && rhoTrain > 0 && Number.isFinite(rhoTest) && rhoTest < rhoTrain * 0.4;

  // ④ held-out 因子数验证曲线（K折）+ 1-SE 推荐因子数 k*：回答"这次新推荐的 N 个里几个能泛化"。
  // 选字段已经是 held-out 的了，为什么还要这条？两者管的不是同一件事：贪心的 test 段是【固定的
  // 那一刀】，逐步累加时同一段验证数据被反复用来做选择决策，走到后面几步难免开始贴着它；这条曲线
  // 换成 K 折、每折重新推边界+配权，专门回答"加到第几个开始不泛化"。③ 只校验【配权】那一层，
  // 对"因子数是不是太多"几乎失明。只对【新增路径】做前缀扫描，起点池当固定基座不参与 k 的计数。
  const heldoutCurve = heldOutFactorCurve(rows, candidates, pathSpecs,
    { threshold, missingPolicy, shape, K: opts.K ?? 5, baseFactors: startPool });
  let factorsTrimmed = newFactors, recommendedCount = path.length;
  if (heldoutCurve && heldoutCurve.recommendedCount < path.length) {
    recommendedCount = heldoutCurve.recommendedCount;
    // 截断到 k* 后同样在全样本上精配一次权重（跟整条路径一个纪律）；基座原样保留，只截新增的尾巴。
    const trimStart = buildOf(pathSpecs.slice(0, recommendedCount));
    factorsTrimmed = applyWeights(trimStart, normalizeWeights(fitWeights(rows, trimStart).w));
  }

  return { path, factors: newFactors, rhoBefore, rhoAfter: bestW.rho,
    rhoTrain, rhoTest, overfit, nTrain: train.length, nTest: test.length,
    baseTestRho: sel.baseTestRho, zeroedFields, n: rows.length,
    heldoutCurve, recommendedCount, factorsTrimmed };
}

// held-out 因子数验证曲线：固定贪心选出来的因子顺序 pathSpecs，用 K 折随机交叉验证逐前缀评估——
// 每折在 train 上【重新推导区间/梯形边界 + 自动配权】（buildFactors(train,...)，边界不碰 test），再去
// test 折上打全程 ρ，K 折平均得到"test ρ 随因子数 k"的曲线。噪声因子在 held-out 上平均贡献≈0，曲线会走平。
// 用 1-SE 规则挑最省的 k*：先找均值最高的 kBest，再取"均值 ≥ 峰值 − 1个标准误"的最小 k（宁可少几个）。
// 说明：因子的【选择顺序】沿用 recommendFactorPath 那一刀固定切分下选出来的顺序（没在每折重做贪心，
// 避免 K×贪心 的开销）；但每个前缀的边界/权重都在本折 train 上重新拟合，足以暴露"加到后面不再
// 泛化"的过拟合尾巴——也正好补上"贪心一直对着同一段 test 做选择决策"这个盲区。样本太少（< K×4）返回 null。
// opts.baseFactors（配合 recommendFactorPool 的"组合路径"模式；原名 baseSpecs，现在收的是
// 【因子对象】而不是 spec）：非空时视为固定基座，每折都跟当前前缀一起建，但不参与 k 的扫描——
// kMax 仍然只数 pathSpecs（新增路径）的长度。用途：起点池已经是用户采信过的因子，"这次新推荐的
// N 个该留几个"这个诊断不该把起点池也算进"因子数"里连带判定。收因子对象是为了走 buildWithBase：
// 基座里从本次 candidates 重建不出来的因子能原样保留，不会被静默丢掉（见 buildWithBase 注释）。
// 固定种子分 K 折，但按 **token 分组**：同一个 token 的所有信号整组进同一折，返回 foldOf[i]。
// 按行分折是错的：同一 token 的多条信号收益高度相关（summary.js 那条"非独立样本"警告说的就是这件
// 事，而找因子默认并不去重），兄弟样本被分到 train/test 两边时，test 折上考的其实是已经见过的题——
// held-out ρ 被系统性抬高，1-SE 选出来的 k* 跟着偏大，噪声因子看起来"还在涨"。
// 分组键优先 tokenAddress，缺失时退回 id / 下标（自成一组，退化成按行分折）。
export function assignFoldsByToken(rows, K, seed = 0x1234567) {
  const n = rows.length;
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const key = String(rows[i]?.tokenAddress || rows[i]?.id || i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const groupKeys = [...groups.keys()];
  const rand = mulberry32(seed);
  for (let i = groupKeys.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = groupKeys[i]; groupKeys[i] = groupKeys[j]; groupKeys[j] = t;
  }
  // 分配用 LPT 装箱（按组大小降序，每组放进"当前累计样本最少"的那一折），不是 pos % K 轮转。
  //
  // 【2026-07-29 改】轮转只保证每折拿到差不多**多少个 token**，不管每个 token 带几条信号。
  // meme 场景里这个差别很大：一个热门币一天可以有几十条信号，而长尾币只有一两条。轮转下
  // 某一折可能吃到远超 1/K 的样本量，另一折少到被下面 heldOutFactorCurve 的
  // `test.length < 5` 直接整折丢掉 —— 各 k 的 nFolds 因此不齐，而 1-SE 用的是
  // testStd/√nFolds，分母不一样的两个 k 根本不可比，选出来的 k*（推荐因子数）跟着偏。
  // LPT 是经典的多路装箱贪心，实现只多一次排序，仍然完全确定性（同一 seed 结果可复现）。
  //
  // 注意排序要**稳定**：先按组大小降序，同大小时按洗牌后的顺序（groupKeys 的下标）——
  // 直接对 groupKeys 排序会让同大小的组退回到 Map 插入顺序，白费上面那次种子洗牌。
  const order = groupKeys.map((key, pos) => ({ key, pos, size: groups.get(key).length }));
  order.sort((a, b) => b.size - a.size || a.pos - b.pos);
  const foldSizes = new Array(K).fill(0);
  const foldOf = new Array(n);
  for (const { key } of order) {
    let target = 0;
    for (let f = 1; f < K; f++) if (foldSizes[f] < foldSizes[target]) target = f;
    for (const idx of groups.get(key)) foldOf[idx] = target;
    foldSizes[target] += groups.get(key).length;
  }
  return foldOf;
}

export function heldOutFactorCurve(rows, candidates, pathSpecs, opts = {}) {
  const { threshold = WIN_THRESHOLD, missingPolicy = 'zero', shape = 'trap', K = 5, seed = 0x1234567,
          baseFactors = [] } = opts;
  const n = rows.length;
  if (!pathSpecs || pathSpecs.length < 1 || n < K * 4) return null;
  const kMax = pathSpecs.length;

  const foldOf = assignFoldsByToken(rows, K, seed);

  const perK = Array.from({ length: kMax }, () => []);   // 每个前缀 k 收集 K 折的 test ρ
  for (let f = 0; f < K; f++) {
    const train = [], test = [];
    for (let i = 0; i < n; i++) (foldOf[i] === f ? test : train).push(rows[i]);
    if (train.length < 10 || test.length < 5) continue;
    for (let k = 1; k <= kMax; k++) {
      const built = autoWeights(buildWithBase(baseFactors, train, candidates, pathSpecs.slice(0, k), threshold, shape));
      if (!built.length) continue;
      const rho = scorePoolRho(test, built, missingPolicy);
      if (Number.isFinite(rho)) perK[k - 1].push(rho);
    }
  }

  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  // 顺带算一条"样本内"曲线做对照（全样本 build+autoWeights、全样本打分）——它会一路爬，
  // 跟 held-out 走平之间的缝就是过拟合量，画一张图上最直观。
  const curve = perK.map((arr, i) => {
    const inBuilt = autoWeights(buildWithBase(baseFactors, rows, candidates, pathSpecs.slice(0, i + 1), threshold, shape));
    const inRho = inBuilt.length ? scorePoolRho(rows, inBuilt, missingPolicy) : NaN;
    if (!arr.length) return { k: i + 1, testRho: NaN, testStd: NaN, nFolds: 0, inRho };
    const m = mean(arr);
    const variance = arr.length > 1 ? mean(arr.map(x => (x - m) ** 2)) : 0;
    return { k: i + 1, testRho: m, testStd: Math.sqrt(variance), nFolds: arr.length, inRho };
  });

  // 1-SE 规则：峰值 kBest → 取"均值 ≥ 峰值 − 峰值处1个标准误"的最小 k
  let kBestIdx = 0, best = -Infinity;
  curve.forEach((c, i) => { if (Number.isFinite(c.testRho) && c.testRho > best) { best = c.testRho; kBestIdx = i; } });
  if (!Number.isFinite(best)) return { curve, recommendedCount: kMax, kBest: kMax, kMax, K, bestTestRho: NaN };
  const seBest = curve[kBestIdx].nFolds > 1 ? curve[kBestIdx].testStd / Math.sqrt(curve[kBestIdx].nFolds) : 0;
  let recommendedCount = kBestIdx + 1;
  for (let i = 0; i <= kBestIdx; i++) {
    if (Number.isFinite(curve[i].testRho) && curve[i].testRho >= best - seBest) { recommendedCount = i + 1; break; }
  }
  return { curve, recommendedCount, kBest: kBestIdx + 1, kMax, K, bestTestRho: best };
}

// ---------- 打分与回测 ----------
// 总分归一到 -100~100：Σ(±w·s)/Σw × 100。按权重和归一而不是假设 Σw=100——用户手动改权重后
// 总和可能不是 100，归一保证 cutoff 的含义（"满分的百分之几"）不随之漂移。
//
// 两阵营符号：勇者阵营（camp!=='evil'）命中自己的区间 = +weight·s（加分）；
// 邪恶阵营（camp==='evil'）命中自己的区间（输家密集/危险区）= -weight·s（减分）。
// 纯勇者阵营场景下（没有 evil 因子）行为与之前完全一致，分数仍落在 0~100。
//
// 缺失口径只有一种：**缺失记 0 分**（不加不减）。惩罚的是数据覆盖而不是盘质量，偏保守，
// 但它跟策略侧「生成上线代码」(lib/onlineExport.js) 的行为一致——这是不能变的约束，
// 回测分数和线上分数必须同一个尺度，否则面板上选出来的 cutoff 搬到线上就是错的。
//
// 2026-07-29 删除了 'renorm' 口径（缺失因子不参与、按在场权重重归一，在场权重 <50% 判 0 分）。
// 它的算法没问题，问题是 onlineExport 里【没有】对应实现，选中它就等于让回测和线上系统性错位——
// 这不是一个选项，是一个陷阱。UI 上的开关同时删除。
// opts.missingPolicy 仍在整条调用链里传递（scoreRow → 回测 → 边际ρ → 配权 → worker），
// 只是当前唯一取值是 'zero'；真要再加第二种口径，先在 onlineExport 里实现对应分支。
export function scoreRow(row, factors, opts = {}) {
  let total = 0, wsum = 0;
  const perFactor = factors.map(f => {
    const v = getFeatureValue(row, f.field);
    const hit = trapScore(v, f.lo0, f.lo1, f.hi1, f.hi0);
    const s = f.camp === 'evil' ? -hit : hit;   // 邪恶阵营命中危险区 → 负分
    total += s * f.weight; wsum += f.weight;
    return s;
  });
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
      cut, triggered, hit,
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

// 时间外推验证的单段核心逻辑：区间/梯形/权重【只】在 train 上推导，原样套到 test。
// runOOSBacktest（单次70/30）和 runWalkForwardBacktest（多段滚动）共用这一份，避免逻辑分叉。
//
// fieldSpecs 支持两种写法：字符串数组（向后兼容，全部当勇者阵营处理，行为与改动前完全一致），
// 或 {field, camp} 对象数组（camp='hero'|'evil'，两阵营各自在训练段用各自的区间挖掘重新扫描）。
//
// 2026-07-28 新增 factorDecay（逐因子归因）：训练段每个因子的 AUC（c.auc）扫描时已经算好，这里
// 补一份该字段在验证段独立重算的 AUC，两者差值大的就是"验证段失效"的候选嫌疑字段——用于回答
// "总分lift塌了，是哪个字段拖累的"，是粗略的诊断线索，不是严格统计检验（两段各自的最优方向
// 都是独立选出来的，不排除方向翻转；仅供定位排查，不作为下线某字段的唯一依据）。
async function backtestOneSplit(train, test, fieldSpecs, winThreshold, opts) {
  const { bootstrapB = 100, minCoverage = 0.3, shape = 'trap', missingPolicy = 'zero' } = opts;
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
  if (!factors.length) {
    return { error: '训练段推导不出任何有效因子', skipped, trainSize: train.length, testSize: test.length };
  }
  // testN/testPos：验证段这次独立AUC计算依据的样本量/正类数——这两个数字很小时（尤其 walk-forward
  // 切了多段、每段验证窗口本来就小时），AUC 估计本身方差很大，跌/涨看着夸张多半是噪声，不是真信号
  // 变化。归因表/导出报告都该把这两个数字带出去，不能只给一个孤零零的 AUC 差值让人误判。
  const factorDecay = factors.map(f => {
    const t = aucForField(test, f.field, { winThreshold, bootstrapB: Math.min(bootstrapB, 100) });
    return { field: f.field, camp: f.camp, trainAuc: f.auc, testAuc: t.auc, testN: t.n, testPos: t.pos,
             aucDrop: Number.isFinite(f.auc) && Number.isFinite(t.auc) ? f.auc - t.auc : NaN };
  });
  return {
    trainFactors: factors, skipped, factorDecay,
    trainSize: train.length, testSize: test.length,
    train: backtestFactors(train, factors, winThreshold, { missingPolicy }),
    test: backtestFactors(test, factors, winThreshold, { missingPolicy }),
  };
}

// 时间外推验证：单次 70/30 切分（保留原样，向后兼容——返回形状没变，`backtestReportExport.js`
// 和既有测试都直接读 trainFactors/trainSize/testSize/train/test 这几个顶层字段）。
// 验证段指标明显低于训练段 = 参数过拟合了训练期的行情，别直接上实盘。
export async function runOOSBacktest(rows, fieldSpecs, winThreshold = WIN_THRESHOLD, opts = {}) {
  const { trainRatio = 0.7 } = opts;
  const { train, test } = splitRowsByTime(rows, trainRatio);
  if (train.length < 30 || test.length < 15) {
    return { error: `样本太少：训练段 ${train.length} / 验证段 ${test.length}，至少需要 30/15` };
  }
  return backtestOneSplit(train, test, fieldSpecs, winThreshold, opts);
}

// 时间外推验证（walk-forward 多段滚动，2026-07-28 新增）：单次 70/30 切分只看"这一刀"的运气——
// 如果恰好切在行情转折点附近，结果可能纯粹是运气好/坏，不代表参数真的稳。这里训练段固定用最早
// trainRatio 比例做"起步窗口"（跟 runOOSBacktest 同一个默认值，第 0 段跟单次切分完全等价），
// 剩下的验证池切成 splits 段连续时间窗、扩张窗口滚动（每段训练集 = 从最早到该段验证窗口开始
// 为止的全部历史，不是只用起步窗口）——逐段各自独立推导区间/权重、套到该段验证。多段都稳定，
// 比单次切分可信得多；只有某几段衰减，也能看出是不是特定行情阶段的问题，而不是参数本身坏了。
// opts.onProgress({completed,total}) 供 UI 显示"验证 2/5 段"这类进度。
export async function runWalkForwardBacktest(rows, fieldSpecs, winThreshold = WIN_THRESHOLD, opts = {}) {
  const { trainRatio = 0.7, splits = 5, onProgress, ...restOpts } = opts;
  const ordered = rows.slice().sort((a, b) => timeAnchor(a) - timeAnchor(b));
  const n = ordered.length;
  const burnIn = Math.floor(n * trainRatio);
  const poolSize = n - burnIn;
  if (burnIn < 30 || poolSize < 15) {
    return { error: `样本太少：训练段 ${burnIn} / 验证池 ${poolSize}，至少需要 30/15` };
  }
  // 每段验证窗口至少 15 条：验证池不够切出 splits 段时自动减少段数，宁可少切几段也不给不可信的小段。
  const nSplits = Math.max(1, Math.min(splits, Math.floor(poolSize / 15)));
  const perTest = Math.floor(poolSize / nSplits);

  const folds = [];
  for (let i = 0; i < nSplits; i++) {
    const trainEnd = burnIn + i * perTest;
    const testEnd = i === nSplits - 1 ? n : trainEnd + perTest; // 最后一段吃掉除不尽的余数
    const train = ordered.slice(0, trainEnd), test = ordered.slice(trainEnd, testEnd);
    const res = await backtestOneSplit(train, test, fieldSpecs, winThreshold, restOpts);
    folds.push({ splitIndex: i, testStart: timeAnchor(test[0]), testEnd: timeAnchor(test[test.length - 1]), ...res });
    if (typeof onProgress === 'function') onProgress({ completed: i + 1, total: nSplits });
  }
  if (!folds.some(f => !f.error)) return { error: folds[0]?.error || '所有切分段都推导不出有效因子' };
  return { folds, splits: nSplits, trainRatio, burnIn };
}

// 用两比例检验判断"验证段命中率是否显著低于训练段"，替代"lift<训练段60%"这种固定阈值——
// 那条固定阈值跟样本量无关：触发数少时正常抽样噪声就能把 lift 打到 60% 以下（假警报），
// 触发数很大时哪怕只跌了 20% 也可能是真实衰减（漏报）。trainPoint/testPoint 是 sweepScoreCutoffs
// 某个 cutoff 对应的 point（需要 hit/triggered 字段）。
// 返回 { p, decayed, significant, insufficientN }：decayed=验证段命中率是否比训练段低（不看显著性）；
// significant=差异是否统计显著（p<0.05）且方向是衰减；insufficientN=两段任一触发数<5，
// 正态近似不成立，p 是 NaN，前端该提示"样本不足，不下结论"而不是硬套一个判定。
export function assessSplitDecay(trainPoint, testPoint) {
  if (!trainPoint || !testPoint) return { p: NaN, decayed: false, significant: false, insufficientN: true };
  const p = twoProportionTestP(trainPoint.hit, trainPoint.triggered, testPoint.hit, testPoint.triggered);
  const decayed = Number.isFinite(trainPoint.hitRate) && Number.isFinite(testPoint.hitRate) && testPoint.hitRate < trainPoint.hitRate;
  return { p, decayed, significant: Number.isFinite(p) && p < 0.05 && decayed, insufficientN: !Number.isFinite(p) };
}

// 用【当前因子池】原样打分，对比若干组样本 vs 一个参照组——2026-07-28 新增，服务"基线库(整体)
// vs 训练集(按天)"这个场景：不重新推导任何区间/权重（跟 runWalkForwardBacktest 不一样，那个是
// 每段都重新训练评估过拟合；这个是监控"现成、已经在用的策略"在不同数据来源/时间上表现是否
// 一致），纯粹拿现成 factors 去打分对比。groups 用通用命名（不叫"day"）——这个函数不需要知道
// "天"/"基线库"这些概念从哪来，调用方（FactorLab.jsx）负责用 dataSlices.js 把训练集样本按天分组
// 后传进来，保持这个模块跟"数据按天怎么归类"解耦。
// baselineRows：参照整体（比如基准库全部样本，不切分）；groups: [{label, rows}]（比如训练集按天）。
// 返回 { baseline:{n,...point}, groups:[{label,n,...point,decay}] } 或 { error }。
// decay 用跟 runWalkForwardBacktest 同一套 assessSplitDecay（两比例检验，不是固定阈值）——
// 这里把 baseline 当"预期基准"、group 当"观察值"，group 命中率显著低于 baseline = 判定偏离。
export function compareGroupsAgainstBaseline(baselineRows, groups, factors, winThreshold = WIN_THRESHOLD, opts = {}) {
  const { missingPolicy = 'zero', cutoff = 0 } = opts;
  if (!factors?.length) return { error: '因子池为空，先建好因子池再对比' };
  if (!baselineRows?.length) return { error: '基准库没有样本（先在「数据与过滤」把部分天归为基准库）' };
  if (!groups?.length || !groups.some(g => g.rows?.length)) {
    return { error: '训练集没有样本（先在「数据与过滤」把部分天归为训练集）' };
  }
  const pointAt = rows => {
    const bt = backtestFactors(rows, factors, winThreshold, { missingPolicy });
    return bt.sweep.points.reduce((best, p) => (p.cut <= cutoff ? p : best), bt.sweep.points[0]);
  };
  const baselinePoint = pointAt(baselineRows);
  const groupResults = groups.map(g => {
    if (!g.rows?.length) return { label: g.label, n: 0, error: '无样本' };
    const point = pointAt(g.rows);
    return { label: g.label, n: g.rows.length, ...point, decay: assessSplitDecay(baselinePoint, point) };
  });
  return { baseline: { n: baselineRows.length, ...baselinePoint }, groups: groupResults };
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
// ---------- 策略打分代码生成：已删除（2026-07-29）----------
// 这里原本是 `generateStrategyCode` + 它的 `fmtNum` 序列化辅助（约 85 行），把因子池渲染成一段
// 自包含的实盘打分函数体。FactorLab 侧的「生成代码」卡片早就撤了——上线代码统一由策略侧的
// 「生成上线代码」(lib/onlineExport.js) 出，那条路把 f('字段') 翻译成纯 native ctx 取值并逐字段自检。
// 留着第二个生成器的代价是"缺失语义 / VETO 保留 / cutoff 同步"这三份一致性要在两处各维护一遍，
// 而它已经无人调用（本次删除前，全项目只有它自己的两条测试在调）。
//
// 注意别一起删掉的：`classifyFieldOrigin` / `resolveCtxAccessor` 仍在用——FactorLab 的
// 「有 N 个因子映射不回原始 ctx，上线后取不到值」那条上线尺度告警就靠它们，跟代码生成无关。
