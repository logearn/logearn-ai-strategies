// 已删因子"回收站"：从策略代码里删掉一条打分因子（调权建议判它真反向、降到 ≤1）之后，
// 把这条 check 的原文存一份，方便"加回来"——删错了、或者攒了几天数据发现它其实有用，
// 能一键把它塞回策略代码，不用手抄那一长串 ['字段', f('字段'), 权重, lo0, lo1, ...]。
// 按 localStorage 存，跟 labels.js / excludedTokens.js 一个路子。不跟具体某份策略绑定——
// 存的是 check 行原文，加回来时插进当前策略的数组即可（只要还是 ALL_CHECKS / checks 架构）。

import { readJsonLS, writeJsonLS } from './localStorageStore.js';

const STORAGE_KEY = 'chart_removed_factors_v1';

export function loadRemovedFactors() {
  const arr = readJsonLS(STORAGE_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

export function saveRemovedFactors(list) {
  writeJsonLS(STORAGE_KEY, list);
}

// 记一条被删的因子。同名的旧记录先去掉再插到最前——同一个因子反复删/加时不堆积重复条目，
// 保留最近一次删掉时的原文（区间/权重可能在两次删除之间被改过，以最新的为准）。
export function addRemovedFactor(list, { name, line }) {
  const rest = list.filter(x => x.name !== name);
  return [{ id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name, line, removedAt: Date.now() }, ...rest];
}

export function dropRemovedFactor(list, id) {
  return list.filter(x => x.id !== id);
}
