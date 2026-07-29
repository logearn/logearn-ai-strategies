// ⚠️ 由 js/utils.js 机械移植而来，逻辑基本未改（122 个既有测试全部改为从这里 import，
// 测试通过即证明移植是忠实的），只删掉了两个零调用方且依赖旧版 ui.js 全局函数
// （showLoading/hideLoading）的死函数：withLoading、csvEscape（2026-07-29）。

// ========== 通用纯函数工具（无 DOM 依赖，无状态） ==========

// 更直观的数值展示：普通范围（如百分比、倍数）用定点小数，只有极小/极大的值才退化成科学计数法，
// 避免像 gmgn.stat.top_bundler_trader_percentage=7.98 这种值被显示成 "7.980e+0" 造成"数值有问题"的误解
function formatNumberSmart(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v === undefined || v === null ? '' : String(v);
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e6)) return v.toExponential(3);
  return Number(v.toPrecision(6)).toString();
}

// 通用比较：两侧都能解析为有限数字且运算符不是 contains 类时按数字比较，否则按字符串比较（支持 symbol/tokenAddress 等字符串字段）
function compareGeneric(v, op, tRaw) {
  const nv = Number(v), nt = Number(tRaw);
  const numeric = Number.isFinite(nv) && Number.isFinite(nt) && op !== 'contains' && op !== 'not_contains';
  if (numeric) {
    switch(op) {
      case '>=': return nv >= nt;
      case '<=': return nv <= nt;
      case '>': return nv > nt;
      case '<': return nv < nt;
      case '==': return nv === nt;
      case '!=': return nv !== nt;
      default: return false;
    }
  }
  const sv = (v === undefined || v === null) ? '' : String(v);
  const st = String(tRaw);
  switch(op) {
    case '==': return sv === st;
    case '!=': return sv !== st;
    case 'contains': return sv.toLowerCase().includes(st.toLowerCase());
    case 'not_contains': return !sv.toLowerCase().includes(st.toLowerCase());
    default: return false; // 对于无法数字化的字段，>,<,>=,<= 无意义，直接不命中
  }
}

function pearson(pairs) {
  const n = pairs.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (const [x, y] of pairs) {
    sx += x; sy += y; sxy += x * y; sx2 += x * x; sy2 += y * y;
  }
  const numerator = sxy - (sx * sy) / n;
  const denominator = Math.sqrt((sx2 - (sx * sx) / n) * (sy2 - (sy * sy) / n));
  return denominator ? numerator / denominator : 0;
}

// "赢"的统一口径：returnMax > 2，即期间最高点相对买入至少翻倍（+100%）。
// 为什么不是 > 1：returnMax 是【期间最大倍数】，只要买入后任何一刻高于买入价就 > 1，
// 几乎所有样本都能满足，胜率会虚高到没有区分度。翻倍才算赢，胜率这个指标才有信息量。
// 改这个值会同时影响：总览胜率、分类字段分析的分组胜率、基准库对比、CA 定位里"好样本"的定义。
const WIN_THRESHOLD = 2;

function calcStats(arr, winThreshold = 0) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const q = p => sorted[Math.min(n - 1, Math.max(0, Math.floor((n - 1) * p)))];
  const positive = sorted.filter(x => x > winThreshold).length;
  return { count: n, mean, min: sorted[0], q25: q(0.25), median: q(0.5), q75: q(0.75), max: sorted[n - 1], positive, winRate: positive / n };
}

function median(arr) {
  if (!arr.length) return NaN;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function linearRegression(pairs) {
  const n = pairs.length;
  if (n < 2) return { slope: 0, intercept: 0 };
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; sxy += x * y; sx2 += x * x; }
  const den = sx2 - (sx * sx) / n;
  const slope = den ? (sxy - (sx * sy) / n) / den : 0;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return NaN;
  const idx = (sortedArr.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

// Tukey IQR 围栏：基于四分位距识别主体数据范围，不受少数极端离群点（如 132k vs 主体<5k）影响
// k 越大，容忍的范围越宽；k=1.5 是常用的"温和离群点"阈值
function tukeyFence(sortedArr, k = 1.5) {
  if (!sortedArr.length) return { lo: NaN, hi: NaN };
  const q1 = percentile(sortedArr, 0.25);
  const q3 = percentile(sortedArr, 0.75);
  const iqr = q3 - q1;
  let lo = q1 - k * iqr;
  let hi = q3 + k * iqr;
  // 不超过实际数据范围
  lo = Math.max(lo, sortedArr[0]);
  hi = Math.min(hi, sortedArr[sortedArr.length - 1]);
  if (!(hi > lo)) { lo = sortedArr[0]; hi = sortedArr[sortedArr.length - 1]; }
  return { lo, hi };
}

// 基于 tukeyFence 计算坐标轴裁剪范围；围栏退化（IQR=0，如某字段绝大多数取值相同）时
// 退回完整数据范围+padding，避免真实数据被裁出可视范围或贴边显示被裁一半
function computeClipRange(sortedArr) {
  if (!sortedArr.length) return { lo: NaN, hi: NaN, fenceLo: NaN, fenceHi: NaN, degenerate: true };
  const f = tukeyFence(sortedArr, 1.5);
  const spread = sortedArr[sortedArr.length - 1] - sortedArr[0];
  const degenerate = !(f.hi > f.lo);
  const pad = degenerate ? (spread * 0.05 || Math.abs(sortedArr[0]) * 0.05 || 1) : (f.hi - f.lo) * 0.05;
  const lo = degenerate ? sortedArr[0] - pad : f.lo - pad;
  const hi = degenerate ? sortedArr[sortedArr.length - 1] + pad : f.hi + pad;
  return { lo, hi, fenceLo: f.lo, fenceHi: f.hi, degenerate };
}

// Abramowitz-Stegun erf 近似
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

// 把数组转成排名（1-based），并列值取平均排名（标准 tied rank 处理），
// 是 Spearman 秩相关的基础：把两列数据分别转成排名后再对排名做 Pearson 相关，就是 Spearman ρ
function rankTransform(arr) {
  const n = arr.length;
  const idx = arr.map((_, i) => i).sort((a, b) => arr[a] - arr[b]);
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && arr[idx[j + 1]] === arr[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k]] = avgRank;
    i = j + 1;
  }
  return ranks;
}

// Spearman 秩相关：衡量单调关系（不要求线性），能捕捉 Pearson r 会低估甚至掩盖的 U 型/对数型等非线性但单调的关系
function spearman(pairs) {
  if (pairs.length < 2) return NaN;
  const rx = rankTransform(pairs.map(p => p[0]));
  const ry = rankTransform(pairs.map(p => p[1]));
  return pearson(rx.map((r, i) => [r, ry[i]]));
}

// 用 Fisher z 变换近似计算 Pearson r 的双侧 p 值（大样本近似）
function pearsonPValue(r, n) {
  if (n < 4) return NaN;
  const rr = Math.max(-0.999999, Math.min(0.999999, r));
  const z = 0.5 * Math.log((1 + rr) / (1 - rr));
  const se = 1 / Math.sqrt(n - 3);
  const zscore = z / se;
  return 2 * (1 - normalCdf(Math.abs(zscore)));
}

// mulberry32：轻量确定性伪随机数生成器（同一个种子产生完全相同的随机序列），
// 用于"锁定切分"——随机切分若每次都用 Math.random()，同一份数据反复分析会得到漂移的训练/测试划分，
// 结论（训练/测试 r、样本外 R² 等）跟着漂移，用户无法区分"结论变了"和"切分变了"。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 样本外验证的训练/测试集切分：时间序列数据用随机切分容易泄露未来信息（训练集里混入了测试集"未来"的样本），
// 默认按时间顺序切分（前 trainRatio 作训练集，后面作测试集）；随机切分模式洗牌后按比例切，
// 更适合非时间序列场景（比如用户明确知道数据没有时间上的漂移，只是想看结果对随机子集是否稳健）。
// seed 为有限数字时启用锁定切分：先按 时间+token 稳定排序消除输入顺序差异，再用种子化 RNG 洗牌，
// 保证同一份数据 + 同一个种子的切分结果 100% 可复现；改种子即可检验结论对切分的稳健性。
function splitTrainTest(rows, method, trainRatio, timeField, seed) {
  let ordered;
  if (method === 'random') {
    ordered = rows.slice();
    const rand = Number.isFinite(seed) ? mulberry32(seed) : Math.random;
    if (Number.isFinite(seed)) {
      ordered.sort((a, b) => ((a[timeField] ?? 0) - (b[timeField] ?? 0))
        || String(a.tokenAddress || '').localeCompare(String(b.tokenAddress || '')));
    }
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }
  } else {
    ordered = rows.slice().sort((a, b) => (a[timeField] ?? 0) - (b[timeField] ?? 0));
  }
  const splitIdx = Math.round(ordered.length * trainRatio);
  return { train: ordered.slice(0, splitIdx), test: ordered.slice(splitIdx) };
}

// 候选切点降采样：连续型字段唯一值可能有几百上千个，全量计算 ROC 每个候选点都要扫一遍全部样本，
// 开销较大；按等距分位数降采样到 maxPoints 个候选点不会明显影响 ROC 曲线整体形状，但能大幅降低计算量，
// 这里作为默认行为而不是可选项。
function downsampleQuantiles(values, maxPoints) {
  const uniq = [...new Set(values)].sort((a, b) => a - b);
  if (uniq.length <= maxPoints) return uniq;
  const result = [];
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.floor(i * (uniq.length - 1) / (maxPoints - 1));
    result.push(uniq[idx]);
  }
  return [...new Set(result)];
}

// 方向词汇归一：本项目里同时存在两套写法——utils 内部（含 js/pro-analytics.js 旧版）用
// 'higher'/'lower'，而 auc.js 产出、UI 展示、持久化进因子池的是 'high'/'low'。两边都要认。
//
// 【2026-07-29 修复的真实 bug】rankAuc 原来只判 `direction === 'lower'`，auc.js 传进来的
// 'low' 落进 else 按正向算 —— 而 auc.js 的点估计已经翻转成 1-aucHigh 了。结果是
// 「点估计翻转了、CI 没翻转」，所有"值小更好"的字段（＝整个邪恶阵营）的置信区间被整体镜像到
// 0.5 以下，proAnalytics 的 aucVerdict 把真正有效的因子标成"反向有效"，文案意思完全相反。
// 实测：auc=0.7984 而 ci=[0.144, 0.269]，点估计落在自己的 CI 之外。
//
// 为什么在这里归一、而不是把 auc.js 改成 'lower'：direction 会随因子池存进 localStorage，
// 改词汇会让存量数据的方向反转。归一函数只认这两个词，其余一律按 higher（与原行为一致）。
const isLowerDirection = d => d === 'lower' || d === 'low';

// ROC 曲线 + AUC：direction='higher'/'high' 表示"字段值 >= 阈值"判定为预测阳性（更可能盈利），
// 'lower'/'low' 表示"字段值 <= 阈值"判定为预测阳性。AUC 用梯形法则对曲线下面积做数值积分；
// Youden's J（TPR - FPR 最大化）对应的切点作为"综合来看最优"的推荐阈值，只在真实候选阈值里找（不含人工补的端点）。
function computeROC(values, labels, direction) {
  const n = values.length;
  const positives = labels.reduce((a, b) => a + b, 0);
  const negatives = n - positives;
  const thresholds = downsampleQuantiles(values, 100);
  const rocPoints = thresholds.map(th => {
    let tp = 0, fp = 0;
    for (let i = 0; i < n; i++) {
      const predPos = isLowerDirection(direction) ? values[i] <= th : values[i] >= th;
      if (predPos) { if (labels[i] === 1) tp++; else fp++; }
    }
    const tpr = positives > 0 ? tp / positives : 0;
    const fpr = negatives > 0 ? fp / negatives : 0;
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : NaN;
    return { threshold: th, tpr, fpr, precision, tp, fp };
  });
  let best = rocPoints[0], bestJ = -Infinity;
  for (const p of rocPoints) {
    const j = p.tpr - p.fpr;
    if (j > bestJ) { bestJ = j; best = p; }
  }
  // AUC：加两个人工端点 (0,0)/(1,1) 闭合曲线，按 fpr（同 fpr 时按 tpr）排序后做梯形积分
  const curvePoints = [...rocPoints, { fpr: 0, tpr: 0 }, { fpr: 1, tpr: 1 }].sort((a, b) => a.fpr - b.fpr || a.tpr - b.tpr);
  let auc = 0;
  for (let i = 1; i < curvePoints.length; i++) {
    const dx = curvePoints[i].fpr - curvePoints[i - 1].fpr;
    const avgY = (curvePoints[i].tpr + curvePoints[i - 1].tpr) / 2;
    auc += dx * avgY;
  }
  return { points: rocPoints, auc, best, positives, negatives };
}

// AUC 的 bootstrap 95% 置信区间。
// 为什么必须有：AUC 的点估计极容易被误读——n 小的时候 0.53 和 0.5 在统计上根本分不开，但光看
// "AUC=0.528"很像"比随机好一点点"。区间跨过 0.5 就说明这个字段和随机猜测没有可分辨的差别。
//
// 重抽样口径：按【样本对】(value, label) 整体有放回抽，不固定正负样本各自的数量——这样重抽样
// 的随机性同时包含了"类别比例本身也是抽样得来的"这部分不确定性，区间不会偏窄。
// 抽出来正负样本只剩一类的那few次直接丢弃（AUC 无定义），不计入分位数。
//
// 注意 direction 固定用外面已定好的方向，不在每次重抽样里重新自动检测：否则每次都取
// max(auc, 1-auc)，AUC 会被系统性地推高到 0.5 以上，区间下界永远够不到 0.5，
// "是否显著优于随机"这个问题就自动变成"是"了——这正是要避免的偏差。
// seed：用固定种子的确定性 RNG（mulberry32）代替 Math.random，让"是否显著"每次扫描完全可复现——
// 否则同一批数据反复扫，边界字段的显著性判定会随 bootstrap 抽样小幅抖动，用户会误以为"ρ/结论在变"
// （其实变的只是这个抖动的判定标签、进而影响了挑因子）。种子给个常数即可；统计意义不变（依然是合法的
// bootstrap 重采样），只是从"每次不同的随机序列"变成"固定的随机序列"。改种子可检验结论对抽样的稳健性。
function bootstrapAucCI(values, labels, direction, B, seed = 0x9E3779B9) {
  const n = values.length;
  if (n < 2) return { lo: NaN, hi: NaN };
  const rand = mulberry32(seed);
  const aucs = [];
  const sv = new Array(n), sl = new Array(n);
  for (let b = 0; b < B; b++) {
    let pos = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rand() * n);
      sv[i] = values[idx]; sl[i] = labels[idx];
      pos += labels[idx];
    }
    if (pos === 0 || pos === n) continue;
    const a = rankAuc(sv, sl, direction);
    if (Number.isFinite(a)) aucs.push(a);
  }
  if (aucs.length < 20) return { lo: NaN, hi: NaN };
  aucs.sort((a, b) => a - b);
  return { lo: percentile(aucs, 0.025), hi: percentile(aucs, 0.975) };
}

// 秩和（Mann-Whitney U）公式算 AUC：AUC = (正样本秩和 - n1(n1+1)/2) / (n1·n2)。
// 与 computeROC 里的梯形积分在数学上等价，但复杂度是 O(n log n) 而不是 O(阈值数 × n)，
// bootstrap 要重复上千次，必须用这个版本，否则批量对比几十个字段会直接把页面卡死。
// 并列值用平均秩（midrank）处理——大量重复值（比如布尔字段、被截断的比例字段）时，
// 不做 midrank 会让 AUC 系统性偏离。
function rankAuc(values, labels, direction) {
  const n = values.length;
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  // direction='lower'/'low'（越小越可能盈利）等价于把值取反后按 'higher' 算。
  // 两套词汇都要认，理由见 isLowerDirection 的注释（原来只认 'lower' 是一个真实 bug）。
  const sign = isLowerDirection(direction) ? -1 : 1;
  idx.sort((a, b) => sign * (values[a] - values[b]));
  const rank = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[idx[j + 1]] === values[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1; // 秩从 1 开始，并列取平均
    for (let k = i; k <= j; k++) rank[idx[k]] = avgRank;
    i = j + 1;
  }
  let rankSumPos = 0, n1 = 0;
  for (let k = 0; k < n; k++) {
    if (labels[k] === 1) { rankSumPos += rank[k]; n1++; }
  }
  const n2 = n - n1;
  if (n1 === 0 || n2 === 0) return NaN;
  return (rankSumPos - n1 * (n1 + 1) / 2) / (n1 * n2);
}

// Wilson-Hilferty 近似：把卡方分布 CDF 用正态分布近似，避免引入专门的卡方分布实现
function chiSquareCdfApprox(x, k) {
  if (x <= 0) return 0;
  const term = Math.pow(x / k, 1 / 3);
  const z = (term - (1 - 2 / (9 * k))) / Math.sqrt(2 / (9 * k));
  return normalCdf(z);
}

// 二项检验（正态近似）：某个子集里的胜率 pSub（k/n）与基准胜率 p0 是否有显著差异。
// 用途：区间挖掘里判断"这一档的胜率比全样本高"是真信号还是抽样波动。
// 返回双尾 p 值；n 太小或 p0 退化（0/1）时返回 NaN——此时正态近似本身就不成立，
// 与其给个不可信的 p 值，不如明确标为无法判断。
function binomTestP(k, n, p0) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || !Number.isFinite(p0)) return NaN;
  if (n < 5 || p0 <= 0 || p0 >= 1) return NaN;
  const se = Math.sqrt(p0 * (1 - p0) / n);
  if (se <= 0) return NaN;
  const z = (k / n - p0) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

// Wilson score 区间：比例的置信区间。比"p ± 1.96·sqrt(p(1-p)/n)"这个正态近似稳健得多——
// 后者在 p 接近 0 或 1 时会给出越界（负数或 >1）的区间，样本小的时候尤其离谱（比如 0/7 会
// 得到 [0,0]，看起来像"确定不会赢"，实际只是样本太少）。Wilson 在这些边界情况下仍然合理。
// 用途：滑动窗口胜率曲线的置信带——带子宽不宽，直接决定那个"波峰"值不值得信。
function wilsonInterval(k, n, z = 1.96) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0) return { lo: NaN, hi: NaN };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

// 两比例 z 检验（正态近似）：两个独立子集的胜率 k1/n1 与 k2/n2 是否有显著差异。
// 与 binomTestP 的区别：那个是"子集 vs 已知基准"，这个是"两个子集互相比"——断点挖掘要问的是
// "在这里切一刀，左右两边的胜率差异是不是真的"，两边都是估计值，必须用合并比例算标准误。
function twoProportionTestP(k1, n1, k2, n2) {
  if (![k1, n1, k2, n2].every(Number.isFinite)) return NaN;
  if (n1 < 5 || n2 < 5) return NaN; // 样本太小时正态近似不成立，宁可不给 p 值
  const pPool = (k1 + k2) / (n1 + n2);
  if (pPool <= 0 || pPool >= 1) return NaN; // 全赢或全输，没有可比较的差异
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se <= 0) return NaN;
  const z = (k1 / n1 - k2 / n2) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

// BH-FDR（Benjamini-Hochberg）：比 Bonferroni 宽松，是行业推荐默认值——
// 把 p 值升序排列，adjusted_p(i) = min_{j>=i} { p(j) * m / j }（从最大 j 往回取累计最小值），
// 与 R 语言 p.adjust(method="BH") 结果一致，不需要引入统计库。
function benjaminiHochbergAdjust(pValues) {
  const idx = pValues.map((_, i) => i).filter(i => Number.isFinite(pValues[i])).sort((a, b) => pValues[a] - pValues[b]);
  const adjusted = pValues.map(() => NaN);
  let runningMin = 1;
  for (let rank = idx.length; rank >= 1; rank--) {
    const i = idx[rank - 1];
    const val = Math.min(1, pValues[i] * idx.length / rank);
    runningMin = Math.min(runningMin, val);
    adjusted[i] = runningMin;
  }
  return adjusted;
}

// logearn 的 token 详情页 URL。链前缀必须按地址格式判断：0x 开头是 BSC，否则是 Solana。
// 漏掉链前缀会 404——URL 是 /cn/{chain}/tokens/{addr}，不是 /token/{addr}。
function logearnUrl(addr) {
  if (!addr) return '';
  const chainSlug = String(addr).startsWith('0x') ? 'bsc' : 'solana';
  return `https://logearn.com/cn/${chainSlug}/tokens/${addr}`;
}

export {
  logearnUrl,
  WIN_THRESHOLD,
  benjaminiHochbergAdjust,
  binomTestP,
  bootstrapAucCI,
  calcStats,
  chiSquareCdfApprox,
  compareGeneric,
  computeClipRange,
  computeROC,
  downsampleQuantiles,
  erf,
  formatNumberSmart,
  linearRegression,
  median,
  mulberry32,
  normalCdf,
  pearson,
  pearsonPValue,
  percentile,
  rankAuc,
  rankTransform,
  spearman,
  splitTrainTest,
  tukeyFence,
  twoProportionTestP,
  wilsonInterval,
};
