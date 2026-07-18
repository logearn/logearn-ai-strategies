// ========== 通用纯函数工具（无 DOM 依赖，无状态） ==========

// HTML 转义：所有从上传 JSON 中读取、拼接进 innerHTML 的字符串（symbol、字段名、地址等）
// 都必须经过转义，避免数据里含有 <, >, ", ' 等字符破坏 DOM 结构或引发脚本注入
function escapeHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 通用 CSV 下载：任意二维数组数据都能复用，不用每个面板各写一套 Blob/下载逻辑
function downloadCsvGeneric(filename, headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

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

function calcStats(arr, winThreshold = 0) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const q = p => sorted[Math.min(n - 1, Math.max(0, Math.floor((n - 1) * p)))];
  const positive = sorted.filter(x => x > winThreshold).length;
  return { count: n, mean, min: sorted[0], q25: q(0.25), median: q(0.5), q75: q(0.75), max: sorted[n - 1], positive, winRate: positive / n };
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

// 样本外验证的训练/测试集切分：时间序列数据用随机切分容易泄露未来信息（训练集里混入了测试集"未来"的样本），
// 默认按时间顺序切分（前 trainRatio 作训练集，后面作测试集）；随机切分模式直接洗牌后按比例切，
// 更适合非时间序列场景（比如用户明确知道数据没有时间上的漂移，只是想看结果对随机子集是否稳健）。
function splitTrainTest(rows, method, trainRatio, timeField) {
  let ordered;
  if (method === 'random') {
    ordered = rows.slice();
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
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

// ROC 曲线 + AUC：direction='higher' 表示"字段值 >= 阈值"判定为预测阳性（更可能盈利），
// 'lower' 表示"字段值 <= 阈值"判定为预测阳性。AUC 用梯形法则对曲线下面积做数值积分；
// Youden's J（TPR - FPR 最大化）对应的切点作为"综合来看最优"的推荐阈值，只在真实候选阈值里找（不含人工补的端点）。
function computeROC(values, labels, direction) {
  const n = values.length;
  const positives = labels.reduce((a, b) => a + b, 0);
  const negatives = n - positives;
  const thresholds = downsampleQuantiles(values, 100);
  const rocPoints = thresholds.map(th => {
    let tp = 0, fp = 0;
    for (let i = 0; i < n; i++) {
      const predPos = direction === 'higher' ? values[i] >= th : values[i] <= th;
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

// Welch's t 检验：不假设两组方差相等，比标准 t 检验更稳健，适合分类字段两组均值对比场景。
// p 值用正态近似（大样本近似，简化处理，n 较小时结果仅供参考）；自由度用 Welch–Satterthwaite 近似，仅用于展示参考。
function welchTTest(a, b) {
  const n1 = a.length, n2 = b.length;
  const mean1 = a.reduce((s, v) => s + v, 0) / n1;
  const mean2 = b.reduce((s, v) => s + v, 0) / n2;
  const var1 = n1 > 1 ? a.reduce((s, v) => s + (v - mean1) ** 2, 0) / (n1 - 1) : 0;
  const var2 = n2 > 1 ? b.reduce((s, v) => s + (v - mean2) ** 2, 0) / (n2 - 1) : 0;
  const se2 = var1 / n1 + var2 / n2;
  const se = Math.sqrt(se2);
  const t = se > 1e-12 ? (mean1 - mean2) / se : 0;
  const df = se2 > 1e-12 && n1 > 1 && n2 > 1
    ? se2 ** 2 / ((var1 / n1) ** 2 / (n1 - 1) + (var2 / n2) ** 2 / (n2 - 1))
    : NaN;
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return { t, df, p, mean1, mean2 };
}

// Wilson-Hilferty 近似：把卡方分布 CDF 用正态分布近似，避免引入专门的卡方分布实现
function chiSquareCdfApprox(x, k) {
  if (x <= 0) return 0;
  const term = Math.pow(x / k, 1 / 3);
  const z = (term - (1 - 2 / (9 * k))) / Math.sqrt(2 / (9 * k));
  return normalCdf(z);
}

// 简化单因素 ANOVA：算组间/组内方差得到 F 统计量，再用 F ≈ chi²(df1)/df1（df2 较大时的近似）
// 配合 Wilson-Hilferty 换算成正态近似求 p 值——不追求和专业统计软件完全一致，
// 目标是给用户一个大致的显著性方向感，文案上需要明确这是简化版。
function anovaFTest(groups) {
  const k = groups.length;
  const allValues = groups.flat();
  const N = allValues.length;
  const grandMean = allValues.reduce((s, v) => s + v, 0) / N;
  let ssBetween = 0, ssWithin = 0;
  for (const g of groups) {
    const n = g.length;
    const mean = g.reduce((s, v) => s + v, 0) / n;
    ssBetween += n * (mean - grandMean) ** 2;
    for (const v of g) ssWithin += (v - mean) ** 2;
  }
  const df1 = k - 1;
  const df2 = N - k;
  if (df1 <= 0 || df2 <= 0) return { F: NaN, p: NaN, df1, df2 };
  const msBetween = ssBetween / df1;
  const msWithin = ssWithin / df2;
  const F = msWithin > 1e-12 ? msBetween / msWithin : Infinity;
  const chi2Approx = df1 * F;
  const p = Number.isFinite(chi2Approx) ? 1 - chiSquareCdfApprox(chi2Approx, df1) : 0;
  return { F, p, df1, df2 };
}

// 多重比较校正：同时检验 m 个假设时，单个 p<0.05 的"显著性"含义会被稀释——
// 纯靠运气也会有约 5% 的字段显示 p<0.05，需要校正后才能判断"真正显著"的字段数量。
// Bonferroni：最简单但偏保守，等价于把显著性阈值除以 m。
function bonferroniAdjust(pValues) {
  const m = pValues.length;
  return pValues.map(p => Number.isFinite(p) ? Math.min(1, p * m) : NaN);
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
