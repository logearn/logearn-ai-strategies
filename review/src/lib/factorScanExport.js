// 因子扫描候选表导出：把「因子发现」扫出来的候选（勇者+邪恶两阵营）拍平成一张制表符分隔的表，
// 直接粘进 Excel/飞书表格，或整段发给 AI 帮忙挑因子。相比 UI 表格，这里刻意把「方向（值大/值小
// 更好）」「coverage」「CI」这些挑因子必看、但表格里为省地方省略/藏起来的列都补齐。
//
// 纯函数、不碰 DOM：入参用回调拿字段含义/边际ρ，方便单测与复用。

const fmtBound = v => (v === -Infinity ? '-∞' : v === Infinity ? '∞' : (Number.isFinite(v) ? formatNum(v) : '-'));
function formatNum(v) {
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e7)) return v.toExponential(3);
  return String(Math.round(v * 1e4) / 1e4);
}
const fmtInterval = iv => (iv ? `[${fmtBound(iv.lo)}, ${fmtBound(iv.hi)})` : '无');
// AUC 的 bootstrap 置信区间：bootstrapAucCI 返回的是 **{lo, hi} 对象**（不是数组），
// 候选一路从 assembleCampScan 原样透传过来。这里原本写的是 Array.isArray(c.ci) ? c.ci[0] : '-'，
// 对象永远不是数组 → 「CI下/CI上」两列自打有这个导出起就恒为 '-'（2026-07-29 修）。
// 而这个导出存在的全部理由就是补齐 UI 表格里省掉的 方向/coverage/**CI** 三列。
// 兼容数组写法：老版本导出/手写 fixture 里有 [lo, hi] 这种形态，不值得为此让导出报错。
const ciBounds = ci => {
  if (Array.isArray(ci)) return [ci[0], ci[1]];
  if (ci && typeof ci === 'object') return [ci.lo, ci.hi];
  return [undefined, undefined];
};
const fmtPct = v => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-');
const verdictText = c => (c.significantAdj ? '校正后显著' : c.significant ? '仅未校正显著' : '不显著');
const directionText = d => (d === 'high' ? '值大更好' : d === 'low' ? '值小更好' : '-');

// 边际ρ 导出两列而不是一列：test 是挑因子的判据，train 单独列出来是为了让"train 涨、test 不涨"
// 这种过拟合候选在表格/AI 眼里也一眼可辨——只给一个数看不出这层。
const COLUMNS = [
  '阵营', '字段', '含义', '方向', 'AUC', 'CI下', 'CI上', '判定', 'pAdj', '边际ρ(test)', '边际ρ(train)',
  '集中区间', 'lift', 'coverage', '区间n', 'pos', '总n', '缺失率',
];

// 单条候选 → 一行（数组），camp 决定阵营中文名
function candidateRow(c, camp, { getDesc, getMarginal }) {
  // 带 camp 取：同一字段在两个阵营各有一份边际贡献（见 useFactorScan 的 getMarginal），
  // 只按字段名取会把邪恶那份的数导进勇者那几行。
  const m = getMarginal ? getMarginal(c.field, camp) : undefined;
  const fmtDelta = v => (Number.isFinite(v) ? v.toFixed(3) : '');
  const marginalTest = fmtDelta(m?.deltaTest);
  const marginalTrain = fmtDelta(m?.deltaTrain);
  const iv = c.interval;
  const [ciLo, ciHi] = ciBounds(c.ci);
  return [
    camp === 'evil' ? '邪恶' : '勇者',
    c.field,
    (getDesc ? getDesc(c.field) : '') || '',
    directionText(c.direction),
    Number.isFinite(c.auc) ? c.auc.toFixed(3) : '-',
    fmtBound(ciLo),
    fmtBound(ciHi),
    verdictText(c),
    Number.isFinite(c.pAdj) ? c.pAdj.toExponential(2) : '-',
    marginalTest,
    marginalTrain,
    fmtInterval(iv),
    iv && Number.isFinite(iv.lift) ? iv.lift.toFixed(2) : '-',
    iv && Number.isFinite(iv.coverage) ? fmtPct(iv.coverage) : '-',
    iv && Number.isFinite(iv.n) ? iv.n : '-',
    Number.isFinite(c.pos) ? c.pos : '-',
    Number.isFinite(c.n) ? c.n : '-',
    fmtPct(c.missRate),
  ];
}

// 把若干阵营的候选清单合并导出成 TSV。
// camps: [{ camp: 'hero'|'evil', list: candidate[] }, ...]
// opts: { getDesc(field)->string, getMarginal(field,camp)->{deltaTest,deltaTrain}|undefined, meta?: string }
// meta 会作为顶部注释行（# 开头），比如"高倍阈值=3x，样本=1234"，方便留档/发给 AI 时带上下文。
export function buildCandidateExportTsv(camps, opts = {}) {
  const { getDesc, getMarginal, meta } = opts;
  const rows = [];
  for (const { camp, list } of camps) {
    if (!Array.isArray(list)) continue;
    for (const c of list) rows.push(candidateRow(c, camp, { getDesc, getMarginal }));
  }
  const body = [COLUMNS.join('\t'), ...rows.map(r => r.join('\t'))].join('\n');
  const head = meta ? `# ${meta}\n` : '';
  return { text: head + body, count: rows.length };
}

export { COLUMNS as CANDIDATE_EXPORT_COLUMNS };
