// 总览统计。做成纯函数返回结构化数据（卡片 + 警告），渲染交给组件。
// 旧版 updateSummary 是 55 行拼 HTML 字符串，还在里面顺手 addEventListener 绑去重按钮——
// 每次重算都会重新绑一次，且没有一行可测。
import { calcStats, percentile, WIN_THRESHOLD } from './utils.js';

export function formatDuration(s) {
  if (!Number.isFinite(s)) return '-';
  if (s >= 86400) return (s / 86400).toFixed(1) + '天';
  if (s >= 3600) return (s / 3600).toFixed(1) + '小时';
  return Math.round(s / 60) + '分钟';
}

export function buildSummary(activeRows, allRows) {
  const total = (allRows || activeRows).length;
  if (!activeRows.length) {
    return { empty: true, total, tiles: [{ label: '匹配样本数', value: '0' }], warnings: [], uniqueTokens: 0 };
  }

  const stats = calcStats(activeRows.map(r => r.returnMax), WIN_THRESHOLD);
  const uniqueTokens = new Set(
    activeRows.map(r => String(r.tokenAddress || '').toLowerCase()).filter(Boolean)
  ).size;

  const tiles = [
    { label: '匹配样本数', value: String(activeRows.length), accent: true },
    { label: '去重 token 数', value: uniqueTokens || '-',
      tip: '和样本数差距大说明存在同一 token 的重复信号' },
    { label: 'returnMax 平均倍数', value: stats.mean.toFixed(4) + 'x' },
    { label: `胜率（倍数>${WIN_THRESHOLD}）`, value: (stats.winRate * 100).toFixed(1) + '%' },
    { label: '最大倍数', value: stats.max.toFixed(4) + 'x' },
  ];

  // 【已移除：观察窗口偏差警告】
  // 旧版会算 exportTimestamp - buyTimestamp，不足 6 小时就警告"returnMax 可能尚未定型"。
  // 用真实数据核对后发现这个检测在结构上不可能成立：
  //   1) calls 里没有导出时间字段，exportTimestamp 取的是 call.timestamp，
  //      而它其实是【信号时刻】（真实样本：call.timestamp 与 swap_begin_time 只差 107 秒）；
  //   2) 匹配逻辑强制 |call.timestamp − snapshot.timestamp| ≤ MAX_SNAPSHOT_MATCH_DIFF_SECONDS(3600)，
  //      而观察窗口正是这两者之差 —— 于是窗口恒 ≤ 1 小时，永远小于 6 小时的警告阈值。
  // 结果就是这条警告对 100% 的样本无条件触发，纯噪声。要真正做这个偏差检测，
  // 需要数据源提供真实的导出/统计截止时刻，当前的 calls JSON 里没有。
  const warnings = [];

  // 非独立样本：同一 token 多次触发信号，收益高度相关，但所有检验都当独立样本算，会虚增显著性。
  if (uniqueTokens > 0 && activeRows.length > uniqueTokens * 1.2) {
    warnings.push({
      kind: 'dup',
      text: `${activeRows.length} 条样本里只有 ${uniqueTokens} 个不同 token（同一 token 的多次信号收益高度相关，会虚增所有统计检验的显著性）。`,
      canDedup: true,
    });
  }

  return { empty: false, total, tiles, warnings, uniqueTokens, stats,
    filtered: allRows && activeRows.length !== allRows.length };
}

// 每个 token 只保留首条信号（按买入时间最早）。用于消除上面的非独立样本问题。
export function dedupPerToken(rows) {
  const byToken = new Map();
  for (const r of rows) {
    const key = String(r.tokenAddress || '').toLowerCase() || r.id;
    const prev = byToken.get(key);
    const t = Number(r.buyTimestamp);
    if (!prev || (Number.isFinite(t) && t < Number(prev.buyTimestamp))) byToken.set(key, r);
  }
  return [...byToken.values()];
}
