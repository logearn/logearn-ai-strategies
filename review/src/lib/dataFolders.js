// 自定义文件夹（档案）名单：默认归档是按数据里的 strategy_name 自动分组，但用户可以【手动】
// 新建文件夹、把批次挪进去、给文件夹改名——这些手动动作把批次的归属从"自动策略名"改成
// "自定义文件夹名"（存在批次 meta 的 folder 字段里，见 dataStore/fsStore 的 updateBatchMeta）。
// 唯独"新建了一个还没放任何批次的空文件夹"这种，没有批次引用它，得单独记一份名单，否则刷新就没了。
// 用 localStorage 存这份空文件夹名单（跟具体后端无关，轻量），跟 labels.js 一个路子。

const STORAGE_KEY = 'review_data_folders_v1';

export function loadFolders() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}

export function saveFolders(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...new Set(list)])); } catch { /* 隐私模式 */ }
}

export function addFolder(list, name) {
  const n = String(name || '').trim();
  if (!n) return list;
  return list.includes(n) ? list : [...list, n];
}

export function removeFolder(list, name) {
  return list.filter(x => x !== name);
}

// 改名：名单里把 from 换成 to（保持位置），批次侧的 folder 字段由调用方另外批量改（updateBatchMeta）
export function renameFolder(list, from, to) {
  const t = String(to || '').trim();
  if (!t) return list;
  return [...new Set(list.map(x => (x === from ? t : x)))];
}
