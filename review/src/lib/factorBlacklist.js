// 因子推荐黑名单：手动判定某个字段【不许被贪心算法选中】，但它仍然照常扫描、照常在候选表里
// 显示 AUC/边际ρ/区间等全部指标，也仍然可以手动勾选进因子池。
//
// 跟 factorExclusions（候选表的"移除"）的区别不是强弱，是【作用的环节不同】，别合并成一个：
//   - 移除(exclusions)：扫描【前】就把字段从 scopedFields 里剔掉——它连 AUC 都不会算，候选表里
//     彻底看不见。语义是"这个字段对这个阵营根本不该考虑"。
//   - 黑名单(blacklist)：只在 recommendFactorPath 挑候选那一步跳过。语义是"我要继续盯着这个
//     字段的指标，但不许推荐算法替我做主选它"——典型场景是 holder_sniper_ratio 那种在
//     held-out 上抢到第一名、全样本精配权后又被压到 0 的字段，删了看不到、留着又会霸占贪心第一步。
//
// 跟 exclusions 一样按 camp+field 记：同一字段完全可能允许当勇者因子、但不许当邪恶因子。
// 黑名单【不】影响起点池：组合路径模式下已经在因子池里的字段是用户采信过的，拉黑只挡新增挑选，
// 不会把它从池子里踢出去（要踢请直接在因子池里删）。

import { readJsonLS, writeJsonLS } from './localStorageStore.js';

const STORAGE_KEY = 'chart_factor_blacklist_v1';

export function loadFactorBlacklist() {
  const arr = readJsonLS(STORAGE_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

export function saveFactorBlacklist(list) {
  writeJsonLS(STORAGE_KEY, list);
}

export function blacklistFactor(list, { camp, field }) {
  if (list.some(x => x.camp === camp && x.field === field)) return list; // 已在黑名单，不重复加
  return [...list, { camp, field, blacklistedAt: Date.now() }];
}

export function unblacklistFactor(list, { camp, field }) {
  return list.filter(x => !(x.camp === camp && x.field === field));
}

// 清空整份黑名单（不分阵营）——跟 exclusions 的 restoreAllExcluded 按阵营清不同：黑名单是在
// 推荐卡片这一处集中管理的（不像候选表天然分成两张），一张列表里放两个阵营的"一键清空"更直观。
export function clearFactorBlacklist() {
  return [];
}

export function isFactorBlacklisted(list, camp, field) {
  return (list || []).some(x => x.camp === camp && x.field === field);
}

// 按拉黑时间【新→旧】排序（最近拉黑的排最前，方便找到刚手滑拉黑的字段解除）。
export function sortBlacklistByRecency(list) {
  return [...list].sort((a, b) => (b.blacklistedAt ?? 0) - (a.blacklistedAt ?? 0));
}

// 给 recommendFactorPath 用的 key 集合：camp:field。
// 注意这里【不能】直接拿去 filter candidates 数组——candidates 同时还是 buildWithBase/
// heldOutFactorCurve 重建因子区间的字典，从数组里删掉会让起点池里的同名因子退化成"用全样本
// 推出来的旧区间"（轻微泄漏）。所以黑名单只在贪心的候选池那一步生效，candidates 始终全量传下去。
export function blacklistKeySet(list) {
  return new Set((list || []).map(x => x.camp + ':' + x.field));
}
