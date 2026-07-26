// 表内隐藏字段：相关性排行 / AUC / 字段体检 三张表各自独立维护一份"已移除字段"名单
// （只在本表隐藏，不影响其它表和散点图/策略——按用户选择「只在当前表隐藏」）。
// 每张表一个 localStorage key，纯函数便于单测。
const keyOf = (tableId) => `review_hidden_fields_${tableId}`;

export function loadHiddenFields(tableId) {
  try { const a = JSON.parse(localStorage.getItem(keyOf(tableId)) || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
export function saveHiddenFields(tableId, list) {
  try { localStorage.setItem(keyOf(tableId), JSON.stringify(list || [])); } catch { /* 隐私模式 */ }
}
export function addHidden(list, field) {
  return (list || []).includes(field) ? (list || []) : [...(list || []), field];
}
export function removeHidden(list, field) {
  return (list || []).filter(f => f !== field);
}
// 从数据行里滤掉被隐藏的字段（getField 默认取 r.field；相关性表用 r.feature）。
export function filterHidden(rows, hidden, getField = r => r.field) {
  if (!hidden || !hidden.length) return rows || [];
  const set = new Set(hidden);
  return (rows || []).filter(r => !set.has(getField(r)));
}
