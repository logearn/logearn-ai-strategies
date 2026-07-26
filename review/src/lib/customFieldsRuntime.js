// 自定义字段的纯运行时。
//
// custom-fields.js 里的 applyCustomFields 依赖模块级的 customFields 数组和 customFieldStats，
// React 组件没法直接改这些（import 绑定是只读的）。这里提供一份"定义作为入参"的等价实现，
// 组件持有定义、这里只负责算，算完的统计一并返回。
//
// 但有一处必须同步回模块状态：data.js 的 isAssembledField 会查 custom-fields.js 的
// customFields 来判断某字段是不是自定义字段（决定它在字段浏览器里的分组）。
// 所以保存时要走 syncToModule —— 写 localStorage 再调 loadCustomFields()，
// 这是模块暴露出来的唯一入口。
import { compileCustomField, invokeCustomField, customRowMeta, buildZscoreFn, loadCustomFields } from './custom-fields.js';

const STORAGE_KEY = 'chart_custom_fields';

export function loadDefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(c => c && typeof c.name === 'string' && typeof c.code === 'string') : [];
  } catch { return []; }
}

export function saveDefs(defs) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(defs)); } catch { /* 隐私模式 */ }
  // 同步给模块，否则 isAssembledField 认不出这些字段，字段浏览器会把它们归到"未分组"
  try { loadCustomFields(); } catch { /* 无 localStorage 时忽略 */ }
}

export function validateName(rawName, defs, existingFields, editingIdx = -1) {
  const trimmed = String(rawName || '').trim().replace(/^custom\./, '');
  if (!trimmed) return { error: '请填写字段名' };
  if (!/^[a-zA-Z0-9_.]+$/.test(trimmed)) return { error: '字段名只允许字母、数字、下划线和点' };
  const name = 'custom.' + trimmed;
  const idx = defs.findIndex(c => c.name === name);
  if (idx !== -1 && idx !== editingIdx) return { error: `字段 ${name} 已存在` };
  if (idx === -1 && existingFields.includes(name)) return { error: `字段 ${name} 与数据中已有字段重名` };
  return { name };
}

// 在 rows 上求值全部自定义字段。定义顺序即计算顺序——后面的可以引用前面的结果。
// 返回每个字段的成功/失败计数和取值范围，让用户一眼看出公式是不是大面积报错。
export function applyDefs(rows, defs) {
  const zscoreFn = buildZscoreFn(rows);
  const stats = new Map();
  for (const cf of defs) {
    const stat = { name: cf.name, ok: 0, err: 0, total: rows.length, firstError: '', min: Infinity, max: -Infinity };
    let fn = null;
    try { fn = compileCustomField(cf.code); }
    catch (e) { stat.firstError = '编译失败: ' + e.message; stat.err = rows.length; }
    if (fn) {
      for (const r of rows) {
        try {
          const v = invokeCustomField(fn, r.features, customRowMeta(r), zscoreFn);
          // 只接受有限数值。返回 undefined/NaN 的样本视为"该字段无值"而删掉，
          // 不能写成 0——缺值和 0 在后续筛选、分箱、AUC 里语义完全不同。
          if (typeof v === 'number' && Number.isFinite(v)) {
            r.features[cf.name] = v;
            stat.ok++;
            if (v < stat.min) stat.min = v;
            if (v > stat.max) stat.max = v;
          } else {
            delete r.features[cf.name];
          }
        } catch (e) {
          delete r.features[cf.name];
          stat.err++;
          if (!stat.firstError) stat.firstError = e.message;
        }
      }
    }
    if (!stat.ok) { stat.min = NaN; stat.max = NaN; }
    stats.set(cf.name, stat);
  }
  return stats;
}

// 试算：在最多 N 条样本上跑一遍，返回前几条的结果供用户确认公式对不对。
export function testDef(rows, code, sampleN = 5) {
  let fn;
  try { fn = compileCustomField(code); }
  catch (e) { return { error: '编译失败: ' + e.message }; }
  const zscoreFn = buildZscoreFn(rows);
  const samples = [], errors = [];
  let ok = 0;
  for (const r of rows) {
    try {
      const v = invokeCustomField(fn, r.features, customRowMeta(r), zscoreFn);
      if (typeof v === 'number' && Number.isFinite(v)) {
        ok++;
        if (samples.length < sampleN) samples.push({ symbol: r.symbol || '', value: v, returnMax: r.returnMax });
      }
    } catch (e) { if (errors.length < 3) errors.push(e.message); }
  }
  return { ok, total: rows.length, samples, errors };
}
