// ⚠️ 由 js/custom-fields.js 机械移植而来：公式编译/执行 + 聚合函数库逻辑一行未改。
// 老版本里依赖 ui.js 全局变量（matchedRows/allNumericKeys/renderCustomFieldList/
// updateScatterSelects/refreshAnalysisViews/showToast/showConfirm/浏览器 prompt()）的
// 面板管理代码（增删字段、导入导出、依赖分析）在 React 化后已被 customFieldsRuntime.js
// 的纯函数版本取代，且从未接入过 React UI（调用会直接 ReferenceError），2026-07-29 清理删除。
// 这里只保留仍在被 data.js / customFieldsRuntime.js / run-tests.js 实际使用的部分：
// 字段定义的加载持久化、公式编译执行、以及公式里可调用的聚合/公共函数库。

const CUSTOM_FIELDS_STORAGE_KEY = 'chart_custom_fields';
let customFields = []; // [{ name, code }]，按定义顺序计算，后面的可引用前面的

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

// zscore(x, field)：把 x 按 field 这个字段在当前 rows（同一批 applyDefs 调用范围内）里的
// 均值/标准差做标准化，公式里不用自己现算全数据集的均值方差。因为依赖当前数据集，不能是纯函数，
// 每次求值调用时用 buildZscoreFn(rows) 现场构造一个绑定了该批 rows 的闭包函数。
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

// customFields 是 data.js 的 isAssembledField 判断"某字段是不是自定义字段"的依据（决定它在
// 字段浏览器里的分组），customFieldsRuntime.js 的 saveDefs 写完 localStorage 后会调这个函数
// 把模块状态同步过来——这是它暴露出来的唯一入口。
function loadCustomFields() {
  try {
    const raw = localStorage.getItem(CUSTOM_FIELDS_STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) customFields = arr.filter(c => c && typeof c.name === 'string' && typeof c.code === 'string');
    }
  } catch (e) { console.warn('加载自定义字段失败', e); }
}

// 编译用户代码：没有 return 关键字时按单表达式处理，自动包一层 return (...)
// 额外注入聚合函数（countWhere/avgField/...）+ 公共函数库（safeDiv/pct/clamp/log1p，design doc §13.1）+
// zscore 作为形参，公式里可以直接按函数名调用，比如 safeDiv(f['a'], f['b']) 或 countWhere(row.arrays.holders, ...)
function compileCustomField(code) {
  const body = /\breturn\b/.test(code) ? code : `return (\n${code}\n);`;
  return new Function('f', 'row', ...CUSTOM_FN_NAMES, `"use strict";\n${body}`);
}
// zscoreFn：由调用方（applyDefs/试算）用 buildZscoreFn(rows) 现场构造并传入，
// 因为 zscore 依赖当前这批行的均值/标准差，不能像其它函数一样是固定不变的纯函数
function invokeCustomField(fn, features, meta, zscoreFn) {
  return fn(features, meta, ...AGGREGATE_FNS, ...PURE_FNS, zscoreFn);
}

function customRowMeta(r) {
  return {
    id: r.id, symbol: r.symbol, token_address: r.tokenAddress, signalType: r.signalType,
    returnMax: r.returnMax,
    initialMcap: r.initialMcap, currentMcap: r.currentMcap, maxMcap: r.maxMcap,
    // 原始数组字段（如 holders/kline_bars/v_breakout_volume_list），配合聚合函数使用（design doc §20.0）
    arrays: r.arrays || {},
  };
}

export {
  AGGREGATE_FNS,
  AGGREGATE_FN_NAMES,
  CUSTOM_FIELDS_STORAGE_KEY,
  CUSTOM_FN_NAMES,
  PURE_FNS,
  PURE_FN_NAMES,
  avgField,
  buildZscoreFn,
  clamp,
  compileCustomField,
  countWhere,
  customFields,
  customRowMeta,
  giniCoefficient,
  invokeCustomField,
  loadCustomFields,
  log1p,
  maxField,
  minField,
  pct,
  resolveArrValue,
  safeDiv,
  sumField,
};
