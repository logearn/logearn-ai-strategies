// 每日回测报告存档：手动把"策略回放看板"当前这次跑出来的核心统计存一份快照，
// 方便以后跟别的日子对比"这版策略/这批数据的效果有没有变化"。
// 只存聚合后的统计量 + 这次用的策略代码，不存逐样本明细——明细本来就能从"策略版本库"里的
// 代码原样重新跑一遍拿到，没必要把大量重复数据再搬进一个 localStorage key。

const STORAGE_KEY = 'chart_backtest_reports_v1';

export function loadBacktestReports() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveBacktestReports(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* 隐私模式 */ }
}

// 本地日历日 YYYY-MM-DD——不用 toISOString()（那是 UTC，凌晨时段会跳到前一天，
// "今天存档"这种按本地日历日算的场景用 UTC 会算错）。
export function localDateStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayDateStr() {
  return localDateStr(new Date());
}

export function addBacktestReport(list, { date, code, note, metrics, kind = 'daily', pairId = null, changeSummary = null }) {
  const item = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    date,
    code,
    note: note || '',
    metrics,
    savedAt: Date.now(),
    kind,          // 'daily'（手动存的日报）| 'optimized'（应用调权/优化建议时自动存）
    pairId,        // 'optimized' 报告成对出现（优化前/优化后），同一次优化共享此 id
    changeSummary, // 优化报告的改动摘要，如「调整3个权重、删除1个因子（xxx）」
  };
  return [item, ...list];
}

// 应用一次"调权/优化建议"时，把 before/after 两份指标打包存成一对报告（同一个 pairId）。
// 直接复用 openPreview/confirmPreview 里已经算好的 before/after 指标（转换成报告口径），
// 不用用户额外点一次"存报告"——试算→确认这个动作本身就该留痕，方便日后跟别的天对比看这次优化到底有没有用。
export function addOptimizationReportPair(list, { date, beforeCode, afterCode, beforeMetrics, afterMetrics, changeSummary }) {
  const pairId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let next = addBacktestReport(list, {
    date, code: beforeCode, note: `优化前 · ${changeSummary}`, metrics: beforeMetrics,
    kind: 'optimized', pairId, changeSummary,
  });
  next = addBacktestReport(next, {
    date, code: afterCode, note: `优化后 · ${changeSummary}`, metrics: afterMetrics,
    kind: 'optimized', pairId, changeSummary,
  });
  return next;
}

export function removeBacktestReport(list, id) {
  return list.filter(r => r.id !== id);
}
