// 策略版本库：跟具体数据源无关的、按名字手动存档的策略代码历史。
// 手动存（不是每次回放自动存）——自动存会让还没调好的中间态也进列表，噪声太大；
// "存为新版本"只在你觉得这版调好了、想留个存档/方便切换回去时才点。
// 同名允许重复保存（不强制唯一），保留完整历史而不是"新的覆盖旧的"。

const STORAGE_KEY = 'chart_strategy_versions_v1';

export function loadStrategyVersions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveStrategyVersions(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* 隐私模式 */ }
}

// 从策略代码里抓一个版本号做默认名字建议——约定见 code-score.js 的 VERSION = '...' 这行；
// 抓不到就返回 null，调用方自己兜底（比如留空让用户自己填）。
export function extractVersionHint(code) {
  const m = String(code).match(/VERSION\s*=\s*['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

export function addStrategyVersion(list, { name, code }) {
  const item = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: String(name).trim(),
    code,
    savedAt: Date.now(),
  };
  return [item, ...list];
}

export function removeStrategyVersion(list, id) {
  return list.filter(v => v.id !== id);
}

// 就地更新某个版本：用编辑框当前代码覆盖它的 code，刷新存入时间（名字不变）。
// 场景：在某版基础上改了几处，不想新增一条，直接把这版更到最新。
export function updateStrategyVersion(list, id, code) {
  return (list || []).map(v => (v.id === id ? { ...v, code, savedAt: Date.now() } : v));
}

// 复制一个版本：克隆代码、名字加"副本"后缀、给新 id/时间，插到最前面。
// 场景：想在某版基础上另起一个分支调，先复制一份再改，不动原版。
export function duplicateStrategyVersion(list, id) {
  const src = (list || []).find(v => v.id === id);
  if (!src) return list;
  const copy = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: `${src.name} 副本`,
    code: src.code,
    savedAt: Date.now(),
  };
  return [copy, ...list];
}
