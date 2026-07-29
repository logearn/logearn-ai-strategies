// 统一的 localStorage 读写：JSON.parse/stringify + try/catch（隐私模式/配额超限时静默降级）。
// 这套 try/catch 边界在 ~14 个 lib 文件（labels.js/campLibrary.js/dataFolders.js/dataSlices.js/
// factorPoolStore.js/todoList.js 等）里各自重复过。每个 store 自己的形状校验（是不是数组/
// 字段够不够）不属于"样板"，留在各自文件里，这里只收公共的取值/解析/异常吞掉这层。
// 2026-07-29 从各 lib 文件抽出。

export function readJsonLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJsonLS(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 隐私模式/配额超限 */ }
}

export function readRawLS(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}

export function writeRawLS(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 隐私模式/配额超限 */ }
}

export function removeLS(key) {
  try { localStorage.removeItem(key); } catch { /* 隐私模式 */ }
}
