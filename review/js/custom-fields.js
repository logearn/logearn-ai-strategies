// ========== 自定义组装字段（用户写 JS） ==========
// 依赖 data.js（DERIVED_KEYS）、dictionary.js（FIELD_DESC）、ui.js（renderBatchTags/refreshAnalysisViews/
// updateScatterSelects/matchedRows/activeRows/allNumericKeys/batchXSelected）——均在函数体内读取，加载顺序无要求。

const CUSTOM_FIELDS_STORAGE_KEY = 'chart_custom_fields';
let customFields = []; // [{ name, code }]，按定义顺序计算，后面的可引用前面的
const customFieldStats = new Map(); // name -> { ok, err, total, firstError, min, max }

// 数组聚合函数（design doc §20.0）：holders/kline_bars/各类事件 _list 等数组字段单条元素没有直接分析意义，
// 必须先聚合成标量才能进相关性/回归框架。这几个函数在自定义字段公式里通过 countWhere(arr, ...)/avgField(arr, field) 直接调用，
// 第二个参数支持"字段名字符串"（取 item[field]）或"回调函数"（自定义取值/判断逻辑），覆盖大多数聚合场景。
function resolveArrValue(item, field) {
  if (item === null || item === undefined) return undefined;
  return typeof field === 'function' ? field(item) : item[field];
}
function countWhere(arr, predicate) {
  if (!Array.isArray(arr)) return null;
  if (predicate === undefined) return arr.length;
  let c = 0;
  for (const item of arr) {
    try {
      const v = typeof predicate === 'function' ? predicate(item) : item === predicate;
      if (v) c++;
    } catch (e) { /* 单条元素取值出错，跳过不计入 */ }
  }
  return c;
}
function avgField(arr, field) {
  if (!Array.isArray(arr) || !arr.length) return null;
  let sum = 0, n = 0;
  for (const item of arr) {
    const v = Number(resolveArrValue(item, field));
    if (Number.isFinite(v)) { sum += v; n++; }
  }
  return n ? sum / n : null;
}
function sumField(arr, field) {
  if (!Array.isArray(arr)) return null;
  let sum = 0;
  for (const item of arr) {
    const v = Number(resolveArrValue(item, field));
    if (Number.isFinite(v)) sum += v;
  }
  return sum;
}
function maxField(arr, field) {
  if (!Array.isArray(arr) || !arr.length) return null;
  let m = -Infinity;
  for (const item of arr) {
    const v = Number(resolveArrValue(item, field));
    if (Number.isFinite(v) && v > m) m = v;
  }
  return Number.isFinite(m) ? m : null;
}
function minField(arr, field) {
  if (!Array.isArray(arr) || !arr.length) return null;
  let m = Infinity;
  for (const item of arr) {
    const v = Number(resolveArrValue(item, field));
    if (Number.isFinite(v) && v < m) m = v;
  }
  return Number.isFinite(m) ? m : null;
}
// 基尼系数：衡量数组某个数值字段的分布不平等程度，0=完全平均，1=完全集中（design doc §20.4，
// 比如用在 holders 数组的 amount_percentage 上衡量持仓集中度，比单一的"前N大占比"更完整）
function giniCoefficient(arr, field) {
  if (!Array.isArray(arr)) return null;
  const vals = arr.map(item => Number(resolveArrValue(item, field))).filter(Number.isFinite).sort((a, b) => a - b);
  const n = vals.length;
  if (n < 2) return null;
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  let cumWeighted = 0;
  for (let i = 0; i < n; i++) cumWeighted += (2 * (i + 1) - n - 1) * vals[i];
  return cumWeighted / (n * sum);
}
// 自定义字段公式里可直接调用的聚合函数集合，编译/执行时作为额外参数注入 Function 作用域
const AGGREGATE_FN_NAMES = ['countWhere', 'avgField', 'sumField', 'maxField', 'minField', 'giniCoefficient'];
const AGGREGATE_FNS = [countWhere, avgField, sumField, maxField, minField, giniCoefficient];

function loadCustomFields() {
  try {
    const raw = localStorage.getItem(CUSTOM_FIELDS_STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) customFields = arr.filter(c => c && typeof c.name === 'string' && typeof c.code === 'string');
    }
  } catch (e) { console.warn('加载自定义字段失败', e); }
}
function saveCustomFields() {
  try { localStorage.setItem(CUSTOM_FIELDS_STORAGE_KEY, JSON.stringify(customFields)); } catch (e) {}
}

// 编译用户代码：没有 return 关键字时按单表达式处理，自动包一层 return (...)
// 额外注入 countWhere/avgField/sumField/maxField/minField/giniCoefficient 六个聚合函数作为形参，
// 公式里可以直接按函数名调用，比如 countWhere(row.arrays.holders, h => h.amount_percentage > 1)
function compileCustomField(code) {
  const body = /\breturn\b/.test(code) ? code : `return (\n${code}\n);`;
  return new Function('f', 'row', ...AGGREGATE_FN_NAMES, `"use strict";\n${body}`);
}
function invokeCustomField(fn, features, meta) {
  return fn(features, meta, ...AGGREGATE_FNS);
}

function customRowMeta(r) {
  return {
    id: r.id, symbol: r.symbol, token_address: r.tokenAddress, signalType: r.signalType,
    returnCurrent: r.returnCurrent, returnMax: r.returnMax,
    initialMcap: r.initialMcap, currentMcap: r.currentMcap, maxMcap: r.maxMcap,
    // 原始数组字段（如 holders/kline_bars/v_breakout_volume_list），配合聚合函数使用（design doc §20.0）
    arrays: r.arrays || {},
  };
}

// 对所有行按定义顺序计算全部自定义字段；写入 row.features，供图表/过滤/相关性直接使用
function applyCustomFields(rows) {
  customFieldStats.clear();
  for (const cf of customFields) {
    const stat = { ok: 0, err: 0, total: rows.length, firstError: '', min: Infinity, max: -Infinity };
    let fn = null;
    try { fn = compileCustomField(cf.code); }
    catch (e) { stat.firstError = '编译失败: ' + e.message; stat.err = rows.length; }
    if (fn) {
      for (const r of rows) {
        try {
          const v = invokeCustomField(fn, r.features, customRowMeta(r));
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
    customFieldStats.set(cf.name, stat);
    FIELD_DESC[cf.name] = '自定义字段: ' + cf.code.replace(/\s+/g, ' ').trim();
  }
}

// 从所有行中移除某个自定义字段的值
function removeCustomFieldValues(name) {
  for (const r of matchedRows) delete r.features[name];
  delete FIELD_DESC[name];
  customFieldStats.delete(name);
}

// 重算自定义字段并刷新所有下游（候选字段/相关性/散点图）
function refreshAfterCustomFieldChange() {
  if (!matchedRows.length) { renderCustomFieldList(); return; }
  applyCustomFields(matchedRows);
  allNumericKeys = [...new Set([
    ...matchedRows.flatMap(r => Object.keys(r.features)),
    ...DERIVED_KEYS,
    ...customFields.map(c => c.name),
  ])].sort();
  updateScatterSelects();
  renderCustomFieldList();
  refreshAnalysisViews();
}

function renderCustomFieldList() {
  const box = document.getElementById('customFieldList');
  if (!customFields.length) {
    box.innerHTML = '<p class="hint" style="margin: 0;">还没有自定义字段。在下方填写字段名和 JS 代码后保存。</p>';
    return;
  }
  box.innerHTML = customFields.map((cf, i) => {
    const stat = customFieldStats.get(cf.name);
    let statHtml = '';
    if (stat) {
      if (stat.firstError && stat.ok === 0) {
        statHtml = `<div class="cf-stat err">⚠️ ${escapeHtml(stat.firstError)}</div>`;
      } else {
        const range = stat.ok ? `　min=${formatNumberSmart(stat.min)}　max=${formatNumberSmart(stat.max)}` : '';
        const errPart = stat.err ? `　<span class="err">⚠️ ${stat.err} 行报错: ${escapeHtml(stat.firstError)}</span>` : '';
        statHtml = `<div class="cf-stat">✅ ${stat.ok}/${stat.total} 行有值${range}${errPart}</div>`;
      }
    } else {
      statHtml = '<div class="cf-stat">尚未计算（点击"分析"后生效）</div>';
    }
    return `<div class="cf-card">
      <div class="cf-head">
        <span class="cf-name">${escapeHtml(cf.name)}</span>
        <button type="button" class="secondary cf-edit" data-idx="${i}">编辑</button>
        <button type="button" class="secondary cf-del" data-idx="${i}">删除</button>
      </div>
      <div class="cf-code">${escapeHtml(cf.code)}</div>
      ${statHtml}
    </div>`;
  }).join('');
  box.querySelectorAll('.cf-edit').forEach(btn => btn.addEventListener('click', () => startEditCustomField(+btn.dataset.idx)));
  box.querySelectorAll('.cf-del').forEach(btn => btn.addEventListener('click', () => deleteCustomField(+btn.dataset.idx)));
}

let editingCustomFieldIdx = -1; // -1 = 新建

function startEditCustomField(idx) {
  const cf = customFields[idx];
  if (!cf) return;
  editingCustomFieldIdx = idx;
  document.getElementById('customFieldName').value = cf.name.replace(/^custom\./, '');
  document.getElementById('customFieldCode').value = cf.code;
  document.getElementById('customFieldSaveBtn').textContent = '保存修改';
  document.getElementById('customFieldCancelBtn').classList.remove('hidden');
  document.getElementById('customFieldResult').textContent = `正在编辑 ${cf.name}`;
}

function cancelEditCustomField() {
  editingCustomFieldIdx = -1;
  document.getElementById('customFieldName').value = '';
  document.getElementById('customFieldCode').value = '';
  document.getElementById('customFieldSaveBtn').textContent = '保存字段';
  document.getElementById('customFieldCancelBtn').classList.add('hidden');
  document.getElementById('customFieldResult').textContent = '';
}

function deleteCustomField(idx) {
  const cf = customFields[idx];
  if (!cf) return;
  if (!confirm(`确定删除自定义字段 ${cf.name}？`)) return;
  customFields.splice(idx, 1);
  saveCustomFields();
  removeCustomFieldValues(cf.name);
  // 清理正在使用该字段的地方
  batchXSelected = batchXSelected.filter(f => f !== cf.name);
  renderBatchTags();
  const yEl = document.getElementById('yField');
  if (yEl.value.trim() === cf.name) yEl.value = 'returnMax';
  const cEl = document.getElementById('colorField');
  if (cEl.value.trim() === cf.name) cEl.value = '';
  if (editingCustomFieldIdx === idx) cancelEditCustomField();
  refreshAfterCustomFieldChange();
}

function validateCustomFieldName(rawName) {
  const trimmed = rawName.trim().replace(/^custom\./, '');
  if (!trimmed) return { error: '请填写字段名' };
  if (!/^[a-zA-Z0-9_.]+$/.test(trimmed)) return { error: '字段名只允许字母、数字、下划线和点' };
  const name = 'custom.' + trimmed;
  const conflictIdx = customFields.findIndex(c => c.name === name);
  if (conflictIdx !== -1 && conflictIdx !== editingCustomFieldIdx) return { error: `字段 ${name} 已存在` };
  if (allNumericKeys.includes(name) && conflictIdx === -1) return { error: `字段 ${name} 与数据中已有字段重名` };
  return { name };
}

function saveCustomFieldFromForm() {
  const resultEl = document.getElementById('customFieldResult');
  const check = validateCustomFieldName(document.getElementById('customFieldName').value);
  if (check.error) { resultEl.textContent = '❌ ' + check.error; return; }
  const code = document.getElementById('customFieldCode').value.trim();
  if (!code) { resultEl.textContent = '❌ 请填写 JS 代码'; return; }
  try { compileCustomField(code); }
  catch (e) { resultEl.textContent = '❌ 编译失败: ' + e.message; return; }
  if (editingCustomFieldIdx >= 0) {
    const old = customFields[editingCustomFieldIdx];
    if (old.name !== check.name) removeCustomFieldValues(old.name);
    customFields[editingCustomFieldIdx] = { name: check.name, code };
  } else {
    customFields.push({ name: check.name, code });
  }
  saveCustomFields();
  cancelEditCustomField();
  resultEl.textContent = `✅ 已保存 ${check.name}`;
  refreshAfterCustomFieldChange();
}

function testCustomFieldFromForm() {
  const resultEl = document.getElementById('customFieldResult');
  const code = document.getElementById('customFieldCode').value.trim();
  if (!code) { resultEl.textContent = '❌ 请填写 JS 代码'; return; }
  let fn;
  try { fn = compileCustomField(code); }
  catch (e) { resultEl.textContent = '❌ 编译失败: ' + e.message; return; }
  const rows = activeRows.length ? activeRows : matchedRows;
  if (!rows.length) { resultEl.textContent = '✅ 编译通过（还没有数据，点"分析"后可试算）'; return; }
  const outputs = [];
  let errMsg = '';
  for (const r of rows.slice(0, 5)) {
    try {
      const v = invokeCustomField(fn, r.features, customRowMeta(r));
      outputs.push(typeof v === 'number' && Number.isFinite(v) ? formatNumberSmart(v) : String(v));
    } catch (e) {
      outputs.push('<err>');
      if (!errMsg) errMsg = e.message;
    }
  }
  resultEl.textContent = `前 ${outputs.length} 行输出: [${outputs.join(', ')}]` + (errMsg ? `　⚠️ ${errMsg}` : '');
}

function initCustomFieldPanel() {
  loadCustomFields();
  renderCustomFieldList();
  document.getElementById('customFieldSaveBtn').addEventListener('click', saveCustomFieldFromForm);
  document.getElementById('customFieldTestBtn').addEventListener('click', testCustomFieldFromForm);
  document.getElementById('customFieldCancelBtn').addEventListener('click', cancelEditCustomField);
}
