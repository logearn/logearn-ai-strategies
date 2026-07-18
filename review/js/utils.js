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
