// 按字段分箱统计。旧版 renderBinBarChart 是 156 行，读 DOM、算统计、画 Plotly 混在一起。
// 这里只保留"分箱 + 每箱统计"，返回结构化结果。
import { WIN_THRESHOLD, wilsonInterval } from './utils.js';
import { getFeature } from './data.js';
import { binLabel, parseBreakpoints, minDetectableDiff } from './analytics.js';
import { getFieldDesc } from './dictionary.js';
import { calcStats, percentile } from './utils.js';

export { binLabel, parseBreakpoints };

// 按分位数自动切分箱边界。样本不足时返回空数组（调用方退回等宽或提示）。
export function quantileEdges(values, binCount) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length < binCount * 3) return [];
  const edges = [];
  for (let i = 1; i < binCount; i++) {
    const q = v[Math.floor(v.length * i / binCount)];
    // 相同取值不能重复做边界，否则会切出空箱
    if (!edges.includes(q)) edges.push(q);
  }
  return edges;
}

export function buildBins({ rows, binField, valueField = 'returnMax', breakpoints, winThreshold = WIN_THRESHOLD }) {
  const bps = (breakpoints || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  const edges = [-Infinity, ...bps, Infinity];
  const bins = [];
  for (let i = 0; i < edges.length - 1; i++) {
    bins.push({ lo: edges[i], hi: edges[i + 1], label: binLabel(edges[i], edges[i + 1]), values: [] });
  }

  // 缺值判定必须先看【原始值】再转数字：getFeature 对"字段存在但值为 null / 空串"
  // 返回 null / ''，而 Number(null) === 0、Number('') === 0 都能通过 isFinite ——
  // 于是缺值样本会被当成 0 塞进最低那一箱，并以 0 参与均值/中位数/胜率。
  const raw = (row, f) => { const v = getFeature(row, f); return (v === undefined || v === null || v === '') ? null : Number(v); };
  let skipped = 0;
  for (const row of rows) {
    const bv = raw(row, binField);
    const vv = raw(row, valueField);
    // 缺值样本跳过并记账——静默丢弃会让"总数对不上"变成悬案
    if (bv === null || vv === null || !Number.isFinite(bv) || !Number.isFinite(vv)) { skipped++; continue; }
    for (const b of bins) {
      if (bv >= b.lo && bv < b.hi) { b.values.push(vv); break; }
    }
  }

  const total = rows.length - skipped;
  const overallWin = total
    ? bins.reduce((a, b) => a + b.values.filter(v => v > winThreshold).length, 0) / total
    : NaN;

  const stats = bins.map(b => {
    const vals = b.values, n = vals.length;
    if (!n) return { ...b, n: 0, mean: NaN, median: NaN, std: NaN, ci95: NaN, winRate: NaN, winCI: null };
    const mean = vals.reduce((a, c) => a + c, 0) / n;
    const std = n > 1 ? Math.sqrt(vals.reduce((a, c) => a + (c - mean) ** 2, 0) / (n - 1)) : 0;
    const sorted = vals.slice().sort((a, c) => a - c);
    const mid = n >> 1;
    const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const wins = vals.filter(v => v > winThreshold).length;
    return {
      ...b, n, mean, median, std,
      ci95: 1.96 * std / Math.sqrt(n),
      winRate: wins / n,
      // 胜率用 Wilson 区间而不是正态近似：小样本（每箱可能只有十几条）下正态近似会给出
      // 超出 [0,1] 的荒谬区间，Wilson 不会。
      winCI: wilsonInterval(wins, n),
    };
  });

  return { bins: stats, skipped, total, overallWin, breakpoints: bps };
}

// 导出一份给 AI 看的分箱分析报告。原版读三个模块级全局
// （lastBinBarResult / activeRows / lastBreakpointMineResult），这里全改成入参——
// 报告正文一个字没动，只是数据来源从全局变量换成参数。
export function buildBinBarAiReport(R, rows, mineResult = null) {
  if (!R) return null;
  const L = [];
  const pct = v => Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-';
  const num = v => Number.isFinite(v) ? Number(v.toPrecision(6)) : '-';

  L.push('# 分箱分析数据（供 AI 诊断）');
  L.push('');
  L.push('## 我想要什么');
  L.push('这是一份 meme 币交易策略的历史回测数据。请基于下面的数据回答：');
  L.push('1. 这个字段值不值得用作策略的过滤条件？依据是什么？');
  L.push('2. 如果值得，断点应该设在哪里？如果不值得，说明理由。');
  L.push('3. 当前这套分析在方法上有什么问题、结论有多大可信度？');
  L.push('4. 下一步应该看什么、或者需要补什么数据？');
  L.push('');
  L.push('**请特别注意下面"统计能力边界"和"已知局限"两节，不要对达不到检出门槛的差异做过度解读。**');
  L.push('');

  L.push('## 分析设置');
  L.push(`- 分箱字段：\`${R.binField}\` —— ${getFieldDesc(R.binField) || '（无字段说明）'}`);
  L.push(`- 目标字段：\`${R.valueField}\` —— ${getFieldDesc(R.valueField) || '（无字段说明）'}`);
  L.push(`- "赢"的判定：${R.valueField} > ${WIN_THRESHOLD}（即相对买入至少翻倍）`);
  L.push(`- 分箱断点：${R.breakpoints.join(', ')}`);
  L.push('');

  // 全样本基准
  const allVals = rows.map(r => Number(getFeature(r, R.valueField))).filter(Number.isFinite);
  const st = allVals.length ? calcStats(allVals, WIN_THRESHOLD) : null;
  L.push('## 全样本基准');
  L.push(`- 工作集样本数：${rows.length}（该目标字段有效值 ${allVals.length} 条）`);
  if (st) {
    L.push(`- 基准胜率（>${WIN_THRESHOLD}倍）：${pct(st.winRate)}`);
    L.push(`- ${R.valueField} 分布：中位数 ${num(st.median)}，均值 ${num(st.mean)}，P25 ${num(st.q25)}，P75 ${num(st.q75)}，最大 ${num(st.max)}`);
    if (st.mean > st.median * 1.5) {
      L.push(`- ⚠️ 该目标是重尾右偏分布（均值是中位数的 ${(st.mean / st.median).toFixed(1)} 倍），**均值类指标会被少数极端样本主导，请以胜率和中位数为准**。`);
    }
  }
  L.push('');

  // 统计能力边界
  const mde = st ? minDetectableDiff(allVals.length, st.winRate) : NaN;
  L.push('## ⚠️ 统计能力边界（重要）');
  if (Number.isFinite(mde)) {
    L.push(`按 α=0.05 双尾、power=0.8 估算，当前样本量能可靠检出的**最小胜率差异约 ${(mde * 100).toFixed(1)} 个百分点**。`);
    L.push(`也就是说：任何小于 ${(mde * 100).toFixed(0)}pp 的档间差异，都无法与抽样波动区分开，即使它是真的也测不出来。`);
    L.push('**请不要基于低于这个幅度的差异给出"某区间更好"的结论。**');
  } else {
    L.push('样本量过小，无法估算检出能力。');
  }
  L.push('');

  L.push('## 分箱结果');
  L.push('| 区间 | n | 胜率 | 中位数 | 均值 | 标准差 | 95%CI | 备注 |');
  L.push('|---|---|---|---|---|---|---|---|');
  R.bins.forEach((b, i) => {
    const notes = [];
    if (i === R.bestIdx) notes.push('当前主指标最优');
    if (b.n > 0 && b.n < 10) notes.push('样本<10，不可信');
    if (Number.isFinite(b.mean) && Number.isFinite(b.median) && b.median > 0 && b.mean > b.median * 2) {
      notes.push(`均值被极端值拉高(${(b.mean / b.median).toFixed(1)}×中位数)`);
    }
    L.push(`| ${b.label} | ${b.n} | ${pct(b.winRate)} | ${num(b.median)} | ${num(b.mean)} | ${num(b.std)} | ${Number.isFinite(b.ci) ? '±' + num(b.ci) : '-'} | ${notes.join('；') || ''} |`);
  });
  L.push('');

  // 样本外验证（如果跑过且是同一个字段）
  if (mineResult && mineResult.field === R.binField) {
    const M = mineResult;
    L.push('## 样本外验证（同一字段）');
    L.push(`按时间把样本切成前 70%（训练 ${M.trainSize} 条，胜率 ${pct(M.trainBase)}）和后 30%（验证 ${M.testSize} 条，胜率 ${pct(M.testBase)}）。`);
    L.push('只在训练段搜索切点，再原样拿到验证段套用——过拟合的规则在验证段会失效或反向。');
    L.push('');
    L.push('| 切分点 | 选中侧 | 训练段 n/胜率/提升 | 验证段 n/胜率/提升 | 两段是否同向 |');
    L.push('|---|---|---|---|---|');
    M.rows.slice(0, 15).forEach(r => {
      L.push(`| ${num(r.cut)} | ${r.better === 'right' ? '>=切点' : '<切点'} | ${r.trainN} / ${pct(r.trainWin)} / ${Number.isFinite(r.trainLift) ? r.trainLift.toFixed(2) + '×' : '-'} | ${r.testN} / ${pct(r.testWin)} / ${Number.isFinite(r.testLift) ? r.testLift.toFixed(2) + '×' : '-'} | ${r.consistent ? '是' : '否'} |`);
    });
    const holds = M.rows.filter(r => r.consistent).length;
    L.push('');
    L.push(`共 ${M.rows.length} 个候选切点，其中 ${holds} 个在训练段和验证段都跑赢各自基准。`);
    L.push('');
  } else {
    L.push('## 样本外验证');
    L.push('（未对该字段运行断点挖掘，因此没有样本外验证结果。仅凭单段数据挑出的最优区间天然偏乐观。）');
    L.push('');
  }

  L.push('## 已知局限（这些数据本身的问题，请纳入判断）');
  L.push('1. **幸存者偏差**：所有样本都是策略已经命中的信号，被策略过滤条件挡掉的样本不在数据里。因此本分析只能回答"在已命中的样本内部该字段有无区分度"，**不能**回答"这个字段作为过滤条件是否有价值"——后者需要未过滤的对照组。');
  L.push('2. **信号类型混合**：数据可能同时包含回撤反弹/早期精选/休眠苏醒等多类信号，不同信号的字段分布和过滤条件都不同，混在一起分析可能出现子群效应互相抵消。');
  L.push('3. **最优区间是挑出来的**：表中"最优"是在若干候选区间里选最大值，天然偏乐观；样本越少偏得越多。');
  L.push('4. **字段缺失非随机**：不同字段缺失率差异很大（部分字段仅在特定信号类型下才有值），各字段的有效样本集并不相同。');
  L.push('');
  L.push(`（导出时间：${new Date().toLocaleString()}）`);
  return L.join('\n');
}
