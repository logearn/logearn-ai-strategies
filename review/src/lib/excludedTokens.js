// 手动删除清单：跟"标垃圾"（labels.js）不是一回事——标垃圾是把 returnMax 降级成保本(1.0x)，
// 样本还在，样本量 n 不变，统计口径最干净；这里是真的把这条样本从当前工作集里整条拿掉，n 会变小。
// 用途：同一笔交易被多天导入批次重复记录、或明显是脏数据的样本，留着不管标不标垃圾都会让
// 样本数/AUC/lift 这些统计失真，得整条剔除才对。
// 按 CA（小写）存 localStorage，跨会话保留；连 symbol 一起存一份快照——排除之后这条样本就不在
// 工作集里了，回头在管理面板里看"删的是哪个"不能再指望从当前 rows 里查回来。

import { readJsonLS, writeJsonLS } from './localStorageStore.js';

const STORAGE_KEY = 'chart_excluded_tokens_v1';

const norm = ca => String(ca || '').toLowerCase();

export function loadExcludedTokens() {
  const arr = readJsonLS(STORAGE_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

export function saveExcludedTokens(list) {
  writeJsonLS(STORAGE_KEY, list);
}

export function excludeToken(list, { ca, symbol }) {
  const k = norm(ca);
  if (list.some(x => x.ca === k)) return list; // 已经删过，不重复加
  return [...list, { ca: k, symbol: symbol || '', excludedAt: Date.now() }];
}

export function unexcludeToken(list, ca) {
  const k = norm(ca);
  return list.filter(x => x.ca !== k);
}

export function isExcludedToken(list, ca) {
  return list.some(x => x.ca === norm(ca));
}

// 真正从行数组里剔除（跟 applyLabels 不同，这个会改变数组长度）。
export function filterExcludedTokens(rows, list) {
  if (!list.length) return rows;
  const set = new Set(list.map(x => x.ca));
  return rows.filter(r => !set.has(norm(r.tokenAddress)));
}
