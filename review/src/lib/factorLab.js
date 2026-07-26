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
import { percentile, wilsonInterval, spearman, WIN_THRESHOLD } from './utils.js';
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
  const { minCoverage = 0.3, minN, targetLabel = '目标类' } = opts;
  const n = values.length;
  const posTotal = labels.reduce((a, b) => a + b, 0);
  if (n < 20) return { error: `有效样本仅 ${n} 条（<20）` };
  if (posTotal < 5) return { error: `${targetLabel}仅 ${posTotal} 个（<5），区间不可信` };
  if (posTotal === n) return { error: `样本全部是${targetLabel}，无需区间` };
  const base = posTotal / n;
  const minGroup = minN != null ? minN : Math.max(10, Math.ceil(n * 0.08));

  const sortedX = values.slice().sort((a, b) => a - b);
  if (new Set(sortedX).size < 4) return { error: '取值种类太少（<4）' };

  // 分位数网格去重后作为窗口边界，两端补 ±Infinity 覆盖单边开区间
  const edgeSet = new Set();
  for (let q = 5; q <= 95; q += 5) edgeSet.add(percentile(sortedX, q / 100));
  const edges = [-Infinity, ...[...edgeSet].sort((a, b) => a - b), Infinity];

  // 每个样本归入 [edges[i], edges[i+1]) 段，做前缀和后任意窗口计数 O(1)
  const segN = new Array(edges.length - 1).fill(0);
  const segPos = new Array(edges.length - 1).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    while (s < edges.length - 2 && values[i] >= edges[s + 1]) s++;
    segN[s]++; segPos[s] += labels[i];
  }
  const cumN = [0], cumPos = [0];
  for (let i = 0; i < segN.length; i++) { cumN.push(cumN[i] + segN[i]); cumPos.push(cumPos[i] + segPos[i]); }

  const scan = (covReq) => {
    let best = null;
    for (let i = 0; i < edges.length - 1; i++) {
      for (let j = i + 1; j < edges.length; j++) {
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
  const best = scan(minCoverage) || scan(minCoverage / 2);
  if (!best) return { error: `没有${targetLabel}比率高于基准且样本量达标的区间` };
  const { score: _s, ...interval } = best;
  return { ...interval, base, posTotal, total: n };
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

// 权重 ∝ |AUC-0.5|，四舍五入到 1 位小数后用最大余数法修正，总和恰为 100。
// 全部 AUC 恰为 0.5（理论上不会进到这）时退化为均分。
export function autoWeights(factors) {
  if (!factors.length) return factors;
  const raw = factors.map(f => Math.abs((Number(f.auc) || 0.5) - 0.5));
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
// 权重按 |AUC-0.5| 各自独立分配，两个高度相关的因子（如 新钱包% 与 新钱包率%）会把
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

// currentFactors：当前已选因子池（不含候选自己）；candidate：来自扫描结果的候选行
// （需带 .interval，否则无法推导打分边界）；camp：候选所属阵营。
export function factorMarginalRho(rows, currentFactors, candidate, camp, winThreshold = WIN_THRESHOLD, opts = {}) {
  const { shape = 'trap', missingPolicy = 'zero' } = opts;
  if (!candidate || !candidate.interval) return { error: '该字段无可信区间，无法评估' };
  const { factors: withOne } = buildFactors(rows, [candidate], [{ field: candidate.field, camp }], winThreshold, { shape });
  if (!withOne.length) return { error: '无法推导打分边界' };
  const baseline = scorePoolRho(rows, autoWeights(currentFactors), missingPolicy);
  const merged = autoWeights([...currentFactors, ...withOne]);
  const withCandidate = scorePoolRho(rows, merged, missingPolicy);
  const delta = Number.isFinite(withCandidate) && Number.isFinite(baseline) ? withCandidate - baseline
    : Number.isFinite(withCandidate) ? withCandidate : NaN;
  return { baseline, withCandidate, delta };
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
