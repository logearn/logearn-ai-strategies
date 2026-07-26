// 因子发现候选表的"移除"清单：手动判定某个字段不适合某个阵营，记下来以后扫描/勾选时都不再
// 出现，不用每次重新扫描都再把同一批字段挑出去一遍。按 camp+field 记——同一字段完全可能
// 适合勇者阵营（比如高倍盘常见的取值区间）但不适合邪恶阵营，两边独立判定、互不影响。

const STORAGE_KEY = 'chart_factor_exclusions_v1';

export function loadFactorExclusions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveFactorExclusions(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* 隐私模式 */ }
}

export function excludeFactor(list, { camp, field }) {
  if (list.some(x => x.camp === camp && x.field === field)) return list; // 已经排除过，不重复加
  return [...list, { camp, field, excludedAt: Date.now() }];
}

export function unexcludeFactor(list, { camp, field }) {
  return list.filter(x => !(x.camp === camp && x.field === field));
}

export function isFactorExcluded(list, camp, field) {
  return list.some(x => x.camp === camp && x.field === field);
}

// 从候选/字段数组里滤掉已排除的——扫描前过滤字段列表、扫描后过滤候选表两处都用得上，
// getField 取每个元素对应的字段名（普通字符串数组传恒等函数，候选对象数组传 c => c.field）。
export function filterExcluded(items, exclusions, camp, getField = x => x) {
  if (!exclusions.length) return items;
  const excludedSet = new Set(exclusions.filter(x => x.camp === camp).map(x => x.field));
  if (!excludedSet.size) return items;
  return items.filter(item => !excludedSet.has(getField(item)));
}
