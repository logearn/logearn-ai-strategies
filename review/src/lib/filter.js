// 全局过滤：从 matchedRows 产出 activeRows。后面所有面板（相关性/散点/分箱/AUC）都消费它。
//
// 旧版 applyFilter 是 80 行，把"读 DOM 取条件""判定""写结果表格""改全局 activeRows"
// 四件事揉在一起，一行都测不了。这里只保留判定，其余交给组件。
import { compareGeneric } from './utils.js';
import { getFeature } from './data.js';

export const FILTER_OPS = [
  { value: '>=', label: '≥' },
  { value: '>', label: '>' },
  { value: '<=', label: '≤' },
  { value: '<', label: '<' },
  { value: '==', label: '=' },
  { value: '!=', label: '≠' },
  { value: 'contains', label: '包含' },
  { value: 'not_contains', label: '不包含' },
];

// 把界面上的条件行整理成可用条件，并把"为什么被忽略"分类记账。
// 旧版这里是静默丢弃 + 弹 toast，用户很难对上号；分类返回让组件能就地标红。
export function normalizeConditions(rawConditions, isValidField) {
  const conditions = [], invalidFields = [], emptyThresholds = [];
  for (const c of rawConditions || []) {
    const field = String(c.field || '').trim();
    if (!field) continue;                       // 完全空行：忽略，不算错误
    if (isValidField && !isValidField(field)) { invalidFields.push(field); continue; }
    const threshold = String(c.threshold ?? '').trim();
    if (threshold === '') { emptyThresholds.push(field); continue; }
    conditions.push({ field, op: c.op || '>=', threshold });
  }
  return { conditions, invalidFields, emptyThresholds };
}

// 条件之间是【与】关系。字段缺值直接不命中——不能当成 0，
// "没有这个数据"和"这个数据是 0"在筛选语义上完全不同。
export function rowMatches(row, conditions) {
  for (const c of conditions) {
    const v = getFeature(row, c.field);
    if (v === undefined || v === null) return false;
    if (!compareGeneric(v, c.op, c.threshold)) return false;
  }
  return true;
}

export function applyFilter(rows, rawConditions, isValidField) {
  const { conditions, invalidFields, emptyThresholds } = normalizeConditions(rawConditions, isValidField);
  // 没有任何有效条件 = 不过滤，回到全量（而不是过滤出空集）
  const matched = conditions.length ? rows.filter(r => rowMatches(r, conditions)) : rows;
  const avgReturn = matched.length
    ? matched.reduce((a, r) => a + (Number(r.returnMax) || 0), 0) / matched.length
    : null;
  return { rows: matched, conditions, invalidFields, emptyThresholds, avgReturn, total: rows.length };
}
