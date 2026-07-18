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

// 公共函数库（design doc §13.1）：把用户重复手写的"避免除以0"这类边界判断收进几个白名单函数，
// 降低自定义字段的上手门槛，不需要每次都自己拼 `b !== 0 ? a/b : null` 这种条件判断。
// b 为 0/缺失时返回 null 而不是 Infinity/NaN，避免这类"坏值"悄悄混进后续统计
function safeDiv(a, b) {
  const an = Number(a), bn = Number(b);
  if (!Number.isFinite(an) || !Number.isFinite(bn) || bn === 0) return null;
  return an / bn;
}
// 占比类组合专用，等价于 safeDiv(a, b) * 100，语义比裸写乘除更清楚
function pct(a, b) {
  const v = safeDiv(a, b);
  return v === null ? null : v * 100;
}
// 把值限制在区间内，防止个别极端值把后续相关性/图表拉爆；min/max 任一非有限数时视为该侧不限制
function clamp(x, min, max) {
  const xn = Number(x);
  if (!Number.isFinite(xn)) return null;
  let v = xn;
  if (Number.isFinite(min) && v < min) v = min;
  if (Number.isFinite(max) && v > max) v = max;
  return v;
}
// log(1+x)，给长尾分布字段（mcap/volume等）做压缩变换时常用；x <= -1 时 log 无意义，返回 null
function log1p(x) {
  const xn = Number(x);
  if (!Number.isFinite(xn) || xn <= -1) return null;
  return Math.log1p(xn);
}
const PURE_FN_NAMES = ['safeDiv', 'pct', 'clamp', 'log1p'];
const PURE_FNS = [safeDiv, pct, clamp, log1p];

// zscore(x, field)：把 x 按 field 这个字段在当前 rows（同一批 applyCustomFields 调用范围内）里的
// 均值/标准差做标准化，公式里不用自己现算全数据集的均值方差。因为依赖当前数据集，不能是纯函数，
// 每次 applyCustomFields/试算调用时用 buildZscoreFn(rows) 现场构造一个绑定了该批 rows 的闭包函数。
function buildZscoreFn(rows) {
  const statsCache = new Map();
  function fieldStats(field) {
    if (statsCache.has(field)) return statsCache.get(field);
    const vals = [];
    for (const r of rows) {
      const v = r.features[field];
      if (Number.isFinite(v)) vals.push(v);
    }
    let stat = { mean: NaN, std: NaN };
    if (vals.length) {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vals.length;
      stat = { mean, std: Math.sqrt(variance) };
    }
    statsCache.set(field, stat);
    return stat;
  }
  return function zscore(x, field) {
    const xn = Number(x);
    const { mean, std } = fieldStats(field);
    if (!Number.isFinite(xn) || !Number.isFinite(mean) || !Number.isFinite(std) || std === 0) return null;
    return (xn - mean) / std;
  };
}
// 公式编译时需要知道全部可调用函数名（含动态构造的 zscore），聚合函数 + 公共函数 + zscore 三组合并
const CUSTOM_FN_NAMES = [...AGGREGATE_FN_NAMES, ...PURE_FN_NAMES, 'zscore'];

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
// 额外注入聚合函数（countWhere/avgField/...）+ 公共函数库（safeDiv/pct/clamp/log1p，design doc §13.1）+
// zscore 作为形参，公式里可以直接按函数名调用，比如 safeDiv(f['a'], f['b']) 或 countWhere(row.arrays.holders, ...)
function compileCustomField(code) {
  const body = /\breturn\b/.test(code) ? code : `return (\n${code}\n);`;
  return new Function('f', 'row', ...CUSTOM_FN_NAMES, `"use strict";\n${body}`);
}
// zscoreFn：由调用方（applyCustomFields/试算）用 buildZscoreFn(rows) 现场构造并传入，
// 因为 zscore 依赖当前这批行的均值/标准差，不能像其它函数一样是固定不变的纯函数
function invokeCustomField(fn, features, meta, zscoreFn) {
  return fn(features, meta, ...AGGREGATE_FNS, ...PURE_FNS, zscoreFn);
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
  const zscoreFn = buildZscoreFn(rows);
  for (const cf of customFields) {
    const stat = { ok: 0, err: 0, total: rows.length, firstError: '', min: Infinity, max: -Infinity };
    let fn = null;
    try { fn = compileCustomField(cf.code); }
    catch (e) { stat.firstError = '编译失败: ' + e.message; stat.err = rows.length; }
    if (fn) {
      for (const r of rows) {
        try {
          const v = invokeCustomField(fn, r.features, customRowMeta(r), zscoreFn);
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

// 字段依赖分析（design doc §13.3）：扫描每个自定义字段的公式里引用到哪些其他自定义字段（通过 f['custom.xxx'] 读取方式扫描，
// 和面板里现有的占位写法一致），维护一张 Map<被依赖的字段名, Set<依赖它的字段名>>，
// 同时检测"引用了不存在的字段"（比如依赖的字段已经被删除但公式没同步改）。
function extractFieldRefs(code) {
  const refs = new Set();
  const re = /f\[\s*['"]([^'"]+)['"]\s*\]/g;
  let m;
  while ((m = re.exec(code))) refs.add(m[1]);
  return refs;
}
function computeCustomFieldDependencies() {
  const dependents = new Map(); // 被依赖的字段名 -> Set(依赖它的字段名)
  const brokenRefs = new Map(); // 字段名 -> Set(引用了但已不存在的 custom 字段名)
  const namesSet = new Set(customFields.map(c => c.name));
  for (const cf of customFields) dependents.set(cf.name, new Set());
  for (const cf of customFields) {
    for (const ref of extractFieldRefs(cf.code)) {
      if (!ref.startsWith('custom.') || ref === cf.name) continue;
      if (namesSet.has(ref)) dependents.get(ref).add(cf.name);
      else {
        if (!brokenRefs.has(cf.name)) brokenRefs.set(cf.name, new Set());
        brokenRefs.get(cf.name).add(ref);
      }
    }
  }
  return { dependents, brokenRefs };
}

function renderCustomFieldList() {
  const box = document.getElementById('customFieldList');
  if (!customFields.length) {
    box.innerHTML = '<p class="hint" style="margin: 0;">还没有自定义字段。在下方填写字段名和 JS 代码后保存。</p>';
    return;
  }
  const { dependents, brokenRefs } = computeCustomFieldDependencies();
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
    const deps = dependents.get(cf.name);
    const depBadge = deps && deps.size
      ? ` <span class="cf-badge" title="${escapeHtml([...deps].join('\u3001'))}">🔗 被${deps.size}个字段依赖</span>` : '';
    const broken = brokenRefs.get(cf.name);
    const brokenHtml = broken && broken.size
      ? `<div class="cf-stat err">⚠️ 引用了不存在的字段：${escapeHtml([...broken].join('\u3001'))}，计算结果将为空</div>` : '';
    return `<div class="cf-card">
      <div class="cf-head">
        <span class="cf-name">${escapeHtml(cf.name)}</span>${depBadge}
        <button type="button" class="secondary cf-edit" data-idx="${i}">编辑</button>
        <button type="button" class="secondary cf-del" data-idx="${i}">删除</button>
      </div>
      <div class="cf-code">${escapeHtml(cf.code)}</div>
      ${statHtml}
      ${brokenHtml}
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
  // 删除保护（design doc §13.3）：删除前先检测是否有其他字段依赖它，有的话明确警告具体会影响哪些字段，
  // 而不是现在这种无声无息的"删了就删了"；不做级联自动删除，避免连锁误删
  const { dependents } = computeCustomFieldDependencies();
  const dependentNames = [...(dependents.get(cf.name) || [])];
  const msg = dependentNames.length
    ? `删除 ${cf.name} 后，依赖它的字段 ${dependentNames.join('\u3001')} 将无法正常计算（会显示为空），是否继续？`
    : `确定删除自定义字段 ${cf.name}？`;
  if (!confirm(msg)) return;
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
  const zscoreFn = buildZscoreFn(rows);
  const outputs = [];
  let errMsg = '';
  for (const r of rows.slice(0, 5)) {
    try {
      const v = invokeCustomField(fn, r.features, customRowMeta(r), zscoreFn);
      outputs.push(typeof v === 'number' && Number.isFinite(v) ? formatNumberSmart(v) : String(v));
    } catch (e) {
      outputs.push('<err>');
      if (!errMsg) errMsg = e.message;
    }
  }
  resultEl.textContent = `前 ${outputs.length} 行输出: [${outputs.join(', ')}]` + (errMsg ? `　⚠️ ${errMsg}` : '');
}

// 导入/导出自定义字段配置（design doc §13.2）：现在只存在 localStorage，换浏览器/设备/团队共享都会丢失，
// 导出成 JSON 文件后可以在其他设备/给同事导入，version 字段用于以后格式升级时做向后兼容检查。
const CUSTOM_FIELDS_CONFIG_VERSION = 1;

function exportCustomFieldsToJson() {
  if (!customFields.length) { alert('还没有自定义字段可导出'); return; }
  const payload = { version: CUSTOM_FIELDS_CONFIG_VERSION, exportedAt: new Date().toISOString(), fields: customFields };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'custom_fields.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// 冲突处理用简单的 prompt 交互（覆盖/跳过/重命名后导入），和现有删除字段用 confirm() 的风格保持一致，
// 不为这个低频操作单独设计一套弹窗组件
function promptImportConflict(name) {
  const choice = (prompt(`字段 "${name}" 已存在，如何处理？输入 overwrite（覆盖）/ skip（跳过）/ rename（重命名后导入），默认 skip`, 'skip') || '').trim().toLowerCase();
  if (choice === 'overwrite' || choice === 'rename') return choice;
  return 'skip';
}

async function importCustomFieldsFromFile(file) {
  let payload;
  try { payload = await readJson(file); } catch (e) { alert('文件解析失败：' + e.message); return; }
  const list = Array.isArray(payload) ? payload : payload && payload.fields;
  if (!Array.isArray(list)) { alert('文件里没有找到自定义字段列表，请确认是本工具导出的配置文件'); return; }
  if (!Array.isArray(payload) && payload.version !== undefined && payload.version !== CUSTOM_FIELDS_CONFIG_VERSION) {
    if (!confirm(`该配置文件版本号(${payload.version})与当前工具（v${CUSTOM_FIELDS_CONFIG_VERSION}）不一致，部分设置可能无法正确导入，是否继续？`)) return;
  }
  // 校验：字段名格式合法 + 公式能编译通过，两者都复用现有的校验/编译逻辑，不重新写一套
  const valid = [];
  const invalidMsgs = [];
  for (const item of list) {
    if (!item || typeof item.name !== 'string' || typeof item.code !== 'string') { invalidMsgs.push(`${item && item.name || '(未命名)'}：缺少 name/code`); continue; }
    const trimmed = item.name.replace(/^custom\./, '');
    if (!/^[a-zA-Z0-9_.]+$/.test(trimmed)) { invalidMsgs.push(`${item.name}：字段名含非法字符`); continue; }
    try { compileCustomField(item.code); } catch (e) { invalidMsgs.push(`${item.name}：编译失败 - ${e.message}`); continue; }
    valid.push({ name: item.name.startsWith('custom.') ? item.name : 'custom.' + trimmed, code: item.code });
  }
  if (invalidMsgs.length) alert(`以下字段校验未通过，已跳过：\n${invalidMsgs.join('\n')}`);
  if (!valid.length) return;

  let importCount = 0, skipCount = 0, overwriteCount = 0, renameCount = 0;
  for (const item of valid) {
    const existingIdx = customFields.findIndex(c => c.name === item.name);
    if (existingIdx === -1) {
      customFields.push({ name: item.name, code: item.code });
      importCount++;
      continue;
    }
    const choice = promptImportConflict(item.name);
    if (choice === 'skip') { skipCount++; continue; }
    if (choice === 'overwrite') { customFields[existingIdx] = { name: item.name, code: item.code }; overwriteCount++; continue; }
    let newName = item.name + '_imported', suffix = 2;
    while (customFields.some(c => c.name === newName)) { newName = item.name + '_imported' + suffix; suffix++; }
    customFields.push({ name: newName, code: item.code });
    renameCount++;
  }
  saveCustomFields();
  refreshAfterCustomFieldChange();
  alert(`导入完成：新增 ${importCount} 个，覆盖 ${overwriteCount} 个，重命名导入 ${renameCount} 个，跳过 ${skipCount} 个。`);
}

function initCustomFieldPanel() {
  loadCustomFields();
  renderCustomFieldList();
  document.getElementById('customFieldSaveBtn').addEventListener('click', saveCustomFieldFromForm);
  document.getElementById('customFieldTestBtn').addEventListener('click', testCustomFieldFromForm);
  document.getElementById('customFieldCancelBtn').addEventListener('click', cancelEditCustomField);
  document.getElementById('exportCustomFieldsBtn').addEventListener('click', exportCustomFieldsToJson);
  const importFileInput = document.getElementById('importCustomFieldsFile');
  document.getElementById('importCustomFieldsBtn').addEventListener('click', () => importFileInput.click());
  importFileInput.addEventListener('change', () => {
    const file = importFileInput.files[0];
    if (file) importCustomFieldsFromFile(file);
    importFileInput.value = '';
  });
}
