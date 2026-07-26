// 轻量文件系统存储：数据以 JSON 文件的形式存在用户选择的本地文件夹里，不是不透明的浏览器数据库——
// 可以在文件管理器里直接看到、复制、拿 git 追踪、拷给别人。
// 只有"记得选过哪个文件夹"这一个指针存进 IndexedDB（结构化克隆 FileSystemDirectoryHandle 是
// 唯一能让它跨刷新存活的办法），数据本身完全在文件系统里，不进任何数据库。
//
// 依赖 File System Access API（Chrome/Edge 等 Chromium 内核浏览器，且需 https/localhost
// 安全上下文；file:// 双击打开的场景可能不可用）。isSupported() 由调用方检测，
// 不支持或调用失败时应回退到 dataStore.js 的 IndexedDB 版——两者导出的函数签名刻意保持一致
// （saveBatch/listBatches/loadAllData/deleteBatch/clearAll），调用方按需切换即可。
//
// 权限模型：浏览器对目录句柄的授权不保证跨会话保留（尤其是重启浏览器后），刷新页面时必须
// queryPermission 静默检查，不是 granted 就不能直接读写——requestPermission 只能在用户手势
// （点击）里调用，所以"重新授权"必须做成一个按钮，不能在 useEffect 里自动弹。

import { extractStrategyInfo } from './dataArchive.js';

const HANDLE_DB = 'review_fs_handle';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'dataDir';
const INDEX_FILE = '_index.json';

export function isSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

function openHandleDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('当前环境不支持 IndexedDB（用于记住文件夹位置）')); return; }
    const rq = indexedDB.open(HANDLE_DB, 1);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error || new Error('打开句柄库失败'));
  });
}

async function getSavedHandle() {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(HANDLE_STORE, 'readonly');
    const rq = t.objectStore(HANDLE_STORE).get(HANDLE_KEY);
    rq.onsuccess = () => resolve(rq.result || null);
    rq.onerror = () => reject(rq.error);
  });
}

async function persistHandle(handle) {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(HANDLE_STORE, 'readwrite');
    t.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// 忘记这个文件夹（只清"记住的指针"，不删文件夹里的任何东西）
export async function forgetDirectory() {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(HANDLE_STORE, 'readwrite');
    t.objectStore(HANDLE_STORE).delete(HANDLE_KEY);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getDirectoryName() {
  try { const h = await getSavedHandle(); return h ? h.name : null; } catch { return null; }
}

// 静默查询权限状态（不弹窗）：'granted' | 'prompt' | 'denied' | 'none'（还没选过文件夹）
export async function checkPermission() {
  const h = await getSavedHandle().catch(() => null);
  if (!h) return 'none';
  try { return await h.queryPermission({ mode: 'readwrite' }); } catch { return 'denied'; }
}

// 重新申请权限——必须在用户点击事件的调用栈里执行，否则浏览器会静默拒绝
export async function requestPermission() {
  const h = await getSavedHandle();
  if (!h) throw new Error('还没选择过数据文件夹');
  const perm = await h.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new Error('未授权访问该文件夹');
}

// 弹出系统文件夹选择框；选中后立刻记住句柄，下次刷新页面靠 checkPermission/requestPermission 恢复
export async function pickDirectory() {
  if (!isSupported()) throw new Error('当前浏览器不支持文件系统访问（建议用 Chrome / Edge，且不是隐私模式）');
  const handle = await window.showDirectoryPicker({ id: 'review-data', mode: 'readwrite' });
  await persistHandle(handle);
  return handle;
}

async function getReadyHandle() {
  const h = await getSavedHandle();
  if (!h) throw new Error('还没选择数据文件夹');
  const perm = await h.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') throw new Error('文件夹访问权限未就绪，请点击"授权文件夹"后重试');
  return h;
}

// 索引文件损坏或缺失时当空索引处理，不阻断使用——用户手滑删了 _index.json，
// 顶多是"看起来没存过数据"，不该让整个存储功能报错崩掉
async function readIndex(dir) {
  try {
    const fh = await dir.getFileHandle(INDEX_FILE);
    const arr = JSON.parse(await (await fh.getFile()).text());
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function writeIndex(dir, list) {
  const fh = await dir.getFileHandle(INDEX_FILE, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(list));
  await w.close();
}

// 文件名只允许安全字符，避免用户上传文件名里的奇怪符号在某些文件系统上写入失败
function safeFileName(name) {
  return String(name).replace(/[^\w.-]/g, '_').slice(0, 80);
}

// kind: 'calls' | 'snaps'。id 用文件名本身（字符串），不像 IndexedDB 版是自增数字，
// 但两边都只要求"在当前批次列表里唯一"，调用方（DataLoader）按 id 增删查即可
export async function saveBatch({ name, kind, records }) {
  const dir = await getReadyHandle();
  // 上传的文件名本身通常已带 .json（如 calls_day1.json），不再重复追加后缀，
  // 避免存出 calls_day1.json.json 这种双扩展名
  const safe = safeFileName(name);
  const fileName = `${kind}_${Date.now()}_${/\.json$/i.test(safe) ? safe : safe + '.json'}`;
  const fh = await dir.getFileHandle(fileName, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(records));
  await w.close();
  const { strategyName, strategyId } = extractStrategyInfo(records);
  const list = await readIndex(dir);
  list.push({ id: fileName, file: fileName, name, kind,
              count: Array.isArray(records) ? records.length : 0, addedAt: Date.now(), strategyName, strategyId });
  await writeIndex(dir, list);
  return fileName;
}

// 回填旧批次的 strategyName/strategyId：读一次每个缺字段批次的文件，抽出来写回索引。返回补了几条。
export async function backfillStrategyInfo() {
  const dir = await getReadyHandle();
  const list = await readIndex(dir);
  let updated = 0;
  for (const m of list) {
    if (m.strategyName != null || m.strategyId != null) continue;
    try {
      const fh = await dir.getFileHandle(m.file);
      const data = JSON.parse(await (await fh.getFile()).text());
      const { strategyName, strategyId } = extractStrategyInfo(data);
      if (strategyName == null && strategyId == null) continue;
      m.strategyName = strategyName; m.strategyId = strategyId; updated++;
    } catch { /* 文件被挪走/删了：跳过 */ }
  }
  if (updated) await writeIndex(dir, list);
  return updated;
}

export async function listBatches() {
  const dir = await getReadyHandle();
  return readIndex(dir);
}

// 读出批次的原始数组，按 kind 分组，供 mergeDaily 合并。
// opts.ids（Set<batch.id>）可选：只读这些批次；不传则读全部。
export async function loadAllData(opts) {
  const dir = await getReadyHandle();
  const all = await readIndex(dir);
  const list = opts && opts.ids ? all.filter(m => opts.ids.has(m.id)) : all;
  const callsArrays = [], snapsArrays = [];
  for (const m of list) {
    try {
      const fh = await dir.getFileHandle(m.file);
      const data = JSON.parse(await (await fh.getFile()).text());
      if (Array.isArray(data)) (m.kind === 'calls' ? callsArrays : snapsArrays).push(data);
    } catch { /* 文件被用户在文件管理器里删了/挪了：跳过这一批，别拖累其余批次 */ }
  }
  return { callsArrays, snapsArrays };
}

// 改批次索引里的 meta——目前只用来设/清 folder（手动归档，覆盖自动策略分组）。folder=null 移出。
// 只改 _index.json 里那条记录，数据文件本身不动。
export async function updateBatchMeta(id, patch) {
  const dir = await getReadyHandle();
  const list = await readIndex(dir);
  const entry = list.find(x => x.id === id);
  if (!entry) return false;
  Object.assign(entry, patch);
  await writeIndex(dir, list);
  return true;
}

export async function deleteBatch(id) {
  const dir = await getReadyHandle();
  const list = await readIndex(dir);
  const entry = list.find(x => x.id === id);
  if (entry) { try { await dir.removeEntry(entry.file); } catch { /* 文件已经不在也无所谓 */ } }
  await writeIndex(dir, list.filter(x => x.id !== id));
}

export async function clearAll() {
  const dir = await getReadyHandle();
  const list = await readIndex(dir);
  for (const entry of list) { try { await dir.removeEntry(entry.file); } catch { /* 忽略 */ } }
  await writeIndex(dir, []);
}
