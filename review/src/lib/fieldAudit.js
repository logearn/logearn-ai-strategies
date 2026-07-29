// ========== 字段质量审核：与目标（进场市值）的机械耦合 ==========
//
// returnMax = max_mcap / initial_mcap，分母就是进场市值。任何跟进场市值高度相关的字段，
// 它那点"预测力"可能只是"小盘天生更容易翻倍"这条恒等式的投影，不是新规律。这类字段能用
// （买入时刻确实拿得到，不是泄漏），但必须知道自己买的其实是"小盘"。
//
// 只依赖 rows + 字段名，不依赖因子池，所以单独成模块；factorLab.js 在扫描时逐字段调用。
//
// 【曾经在这里、已按需求移除的两项】
//   · 时点标记（事后字段 / 市值同源 Tag）与缺失非随机检查（缺失组 vs 非缺失组赢率）——
//     2026-07-29 按用户判断移除：这两件事看字段名和缺失率就能人肉判断，不值得占候选表的列宽
//     和扫描开销。留这行注释是为了让后来者知道它们是被主动砍掉的，不是漏做的。
//   · 观察期偏差——【别再加回来】：returnMax 的统计截止时刻需要真实的导出时间，而 calls JSON
//     里没有；row.exportTimestamp 取的是 call.timestamp，它实际是【信号时刻】（真实样本里与
//     swap_begin_time 只差 107 秒），且匹配逻辑强制它与快照时刻相差 ≤1 小时。于是"观察窗口"
//     恒 ≤1 小时，基于它的任何检测都对 100% 样本无条件触发。summary.js 里那条同样思路的警告
//     已经因为这个原因被删过一次（见 summary.js「已移除：观察窗口偏差警告」）。
import { spearman } from './utils.js';
import { getFeature } from './data.js';

// 数据集级：ρ(进场市值, returnMax)。这个 ρ 显著为负是常态（小盘更容易翻倍），
// 但它有多强决定了"市值影子"这个问题该被多认真地对待——ρ 越强，越多看似无关的字段
// 其实只是市值的另一种写法。
export function auditMcapCoupling(rows) {
  const pairs = [];
  for (const r of rows || []) {
    const m = Number(r && r.initialMcap), ret = Number(r && r.returnMax);
    if (Number.isFinite(m) && m > 0 && Number.isFinite(ret)) pairs.push([m, ret]);
  }
  if (pairs.length < 10) return { n: pairs.length, error: '样本没有可用的进场市值，无法评估市值耦合' };
  const ms = pairs.map(p => p[0]).sort((a, b) => a - b);
  const at = q => ms[Math.min(ms.length - 1, Math.max(0, Math.floor(q * (ms.length - 1))))];
  return {
    n: pairs.length,
    p10Mcap: at(0.10), medianMcap: at(0.50), p90Mcap: at(0.90),
    rhoMcapReturn: spearman(pairs),
  };
}

// 单字段版：这个字段跟【进场市值】的秩相关有多强。
// |ρ| 大 = 它很大程度只是进场市值的代理，它对 returnMax 的预测力可能全是"小盘效应"借给它的。
// 字段名带 mcap/fdv 的一眼就能看出来，这一列真正的价值是抓住名字上看不出来的那些——
// total_supply、流动性、持有人数这类跟盘子大小同涨同落的字段。
export function fieldMcapRho(rows, field) {
  const pairs = [];
  for (const r of rows || []) {
    const m = Number(r && r.initialMcap);
    if (!Number.isFinite(m) || m <= 0) continue;
    const raw = getFeature(r, field);
    if (raw === undefined || raw === null || raw === '') continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    pairs.push([v, m]);
  }
  if (pairs.length < 10) return NaN;
  return spearman(pairs);
}
