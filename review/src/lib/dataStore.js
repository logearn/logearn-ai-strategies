// IndexedDB 数据批次存储：每天上传的 calls/snapshots 按批次存进浏览器，刷新页面还在。
// 设计要点：
//   - meta 与 data 分成两个 store——列表页只读 meta（几百字节/条），不用把几十 MB 的
//     records 全部拉进内存才知道有哪些批次。
//   - 只存原始数组，不存 buildRows 的结果：合并去重（mergeDaily）永远在读取后现做，
//     同一条 call 在多天导出里重复时保留导出更晚的，这个逻辑不能被"存过就不动了"绕过。
//   - 所有 API 返回 Promise；IndexedDB 不可用（隐私模式等）时明确 reject，由 UI 降级提示。
import { extractStrategyInfo } from './dataArchive.js';

const DB_NAME = 'review_data_store';
const DB_VER = 1;
const META = 'batch_meta';
const DATA = 'batch_data';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('当前环境不支持 IndexedDB')); return; }
    const rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'id' });
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error || new Error('IndexedDB 打开失败'));
  });
}

function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => resolve(out && out.__val !== undefined ? out.__val : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('事务中止'));
  });
}

// kind: 'calls' | 'snaps'
// 存批次时顺手从记录里抽 strategyName/strategyId（calls/snapshots 每条都自带这俩顶层字段），
// 归档就靠它——列表页按【策略名→策略id】分组、分析时按策略/id 选范围都读 meta 里这两个字段。
export async function saveBatch({ name, kind, records }) {
  const db = await openDb();
  const { strategyName, strategyId } = extractStrategyInfo(records);
  return new Promise((resolve, reject) => {
    const t = db.transaction([META, DATA], 'readwrite');
    const meta = { name, kind, count: Array.isArray(records) ? records.length : 0, addedAt: Date.now(), strategyName, strategyId };
    const rq = t.objectStore(META).add(meta);
    rq.onsuccess = () => { t.objectStore(DATA).put({ id: rq.result, records }); };
    t.oncomplete = () => resolve(rq.result);
    t.onerror = () => reject(t.error);
  });
}

// 回填旧批次的 strategyName/strategyId：早先存的批次 meta 里没有这两个字段，读一次它的 records
// 抽出来补进 meta（一次性，补完就永久带着了）。返回补了几条。records 可能很大，逐批读、逐批更新。
export async function backfillStrategyInfo() {
  const db = await openDb();
  const metas = await listBatches();
  const need = metas.filter(m => m.strategyName == null && m.strategyId == null);
  let updated = 0;
  for (const m of need) {
    const records = await new Promise((resolve) => {
      const t = db.transaction(DATA, 'readonly');
      const rq = t.objectStore(DATA).get(m.id);
      rq.onsuccess = () => resolve(rq.result && rq.result.records);
      rq.onerror = () => resolve(null);
    });
    const { strategyName, strategyId } = extractStrategyInfo(records);
    if (strategyName == null && strategyId == null) continue;
    await new Promise((resolve, reject) => {
      const t = db.transaction(META, 'readwrite');
      const store = t.objectStore(META);
      const gq = store.get(m.id);
      gq.onsuccess = () => {
        const cur = gq.result; if (!cur) { resolve(); return; }
        store.put({ ...cur, strategyName, strategyId });
      };
      t.oncomplete = () => { updated++; resolve(); };
      t.onerror = () => reject(t.error);
    });
  }
  return updated;
}

export async function listBatches() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(META, 'readonly');
    const rq = t.objectStore(META).getAll();
    rq.onsuccess = () => resolve(rq.result || []);
    rq.onerror = () => reject(rq.error);
  });
}

// 读出批次的原始数组，按 kind 分组，供 mergeDaily 合并。
// opts.ids（Set<batch.id>）可选：只读这些批次（分析时按策略/id 选范围就靠它），不传则读全部。
export async function loadAllData(opts) {
  const db = await openDb();
  const all = await listBatches();
  const metas = opts && opts.ids ? all.filter(m => opts.ids.has(m.id)) : all;
  return new Promise((resolve, reject) => {
    const t = db.transaction(DATA, 'readonly');
    const store = t.objectStore(DATA);
    const callsArrays = [], snapsArrays = [];
    let pending = metas.length;
    if (!pending) { resolve({ callsArrays, snapsArrays }); return; }
    for (const m of metas) {
      const rq = store.get(m.id);
      rq.onsuccess = () => {
        const rec = rq.result;
        if (rec && Array.isArray(rec.records)) {
          (m.kind === 'calls' ? callsArrays : snapsArrays).push(rec.records);
        }
        if (--pending === 0) resolve({ callsArrays, snapsArrays });
      };
      rq.onerror = () => reject(rq.error);
    }
  });
}

// 改批次的 meta——目前只用来设/清 folder（手动归档：把批次挪进自定义文件夹，覆盖自动策略分组）。
// patch.folder = 文件夹名 表示挪进该文件夹；folder = null 表示移出、回到按 strategy_name 自动分组。
// records 一个字节不动，只改 meta（几百字节），所以很轻。
export async function updateBatchMeta(id, patch) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(META, 'readwrite');
    const store = t.objectStore(META);
    const gq = store.get(id);
    gq.onsuccess = () => { const cur = gq.result; if (cur) store.put({ ...cur, ...patch }); };
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  });
}

export async function deleteBatch(id) {
  const db = await openDb();
  return tx(db, [META, DATA], 'readwrite', t => {
    t.objectStore(META).delete(id);
    t.objectStore(DATA).delete(id);
  });
}

export async function clearAll() {
  const db = await openDb();
  return tx(db, [META, DATA], 'readwrite', t => {
    t.objectStore(META).clear();
    t.objectStore(DATA).clear();
  });
}
