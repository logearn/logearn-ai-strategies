// 「筛选 CA」条件预设：按方案名存一组过滤条件，方便反复用同一套筛选条件。
// 之前内联在 FilterPanel.jsx 里，跟其它持久化状态（因子池/已删因子/已排除因子等）
// 都各自有独立 lib/*.js 模块的惯例不一致，2026-07-29 挪出来对齐。

import { readJsonLS, writeJsonLS } from './localStorageStore.js';

const STORAGE_KEY = 'chart_filter_presets_v2';

export function loadFilterPresets() {
  const o = readJsonLS(STORAGE_KEY, {});
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
}

export function saveFilterPresets(presets) {
  writeJsonLS(STORAGE_KEY, presets || {});
}
