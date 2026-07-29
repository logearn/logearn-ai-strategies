import { useEffect, useMemo, useState } from 'react';
import { message } from 'antd';
import { groupBatches, deriveBatchStrategy, groupKeyOf, UNNAMED } from '../../lib/dataArchive.js';
import { loadFolders, saveFolders, addFolder, removeFolder, renameFolder } from '../../lib/dataFolders.js';
import * as idbStore from '../../lib/dataStore.js';
import * as fsStore from '../../lib/fsStore.js';

export const MOVE_OUT = '__none__';   // "移出文件夹（回自动策略分组）" 的哨兵 value

export const storageLabel = backend => (backend === 'fs' ? '本地文件夹' : '浏览器内置数据库');

// 存储后端 + 批次/文件夹归档管理：从 DataLoader.jsx 抽出来的第一块状态（2026-07-29，
// 拆"上帝组件"第四步）。上传解析（files/analyze）和时间切片（allRows/sliceCats）两块还留在
// DataLoader.jsx——analyze() 要跨读这个 hook 的 store/selectedBatchIds/selectionGroupLabel
// 等好几样，是天然的"胶水函数"，不适合塞进任何一个单一关注点的 hook 里；时间切片下一步再拆。
// onStatus：极少数分支（选文件夹/授权失败、补全策略名结果）要往上抛一条状态提示，复用
// DataLoader.jsx 现有的 status 展示条，不在这个 hook 里另开一套 UI 反馈通道。
export function useArchiveManager({ onStatus }) {
  const [batches, setBatches] = useState([]);          // 已存批次元数据
  const [storeOk, setStoreOk] = useState(true);        // 当前后端可用性（隐私模式/权限撤销等）
  const [backfilling, setBackfilling] = useState(false);
  // 存储后端：'fs' = 用户选的本地文件夹（轻量、透明、可用文件管理器直接看）；
  // 'idb' = 浏览器内置 IndexedDB（兜底，Safari/Firefox 等不支持文件系统访问的浏览器走这条）
  const [backend, setBackend] = useState('idb');
  const [fsDirName, setFsDirName] = useState(null);     // 记住过的文件夹名（用于展示）
  const [fsPendingAuth, setFsPendingAuth] = useState(false); // 记得文件夹但权限需要用户点击重新确认
  // 自定义文件夹（手动归档，覆盖自动策略分组）
  const [folders, setFolders] = useState(loadFolders);
  const [selectedKeys, setSelectedKeys] = useState([]);  // 树表勾选（含策略/id/批次行的 key）
  // 新建/重命名文件夹的弹窗：{ mode:'new'|'rename', from, value }
  const [folderModal, setFolderModal] = useState(null);

  const store = backend === 'fs' ? fsStore : idbStore;
  const refreshBatches = () => store.listBatches().then(setBatches).catch(() => setStoreOk(false));

  // 启动时判断走哪个后端：没记住过文件夹 → idb；记住了但权限还没就绪 → 停在 idb，
  // 界面上给一个"点击授权"入口（不能在这里自动弹权限框，requestPermission 必须在用户手势里调用）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!fsStore.isSupported()) { idbStore.listBatches().then(b => !cancelled && setBatches(b)).catch(() => setStoreOk(false)); return; }
      const dirName = await fsStore.getDirectoryName();
      if (!dirName) { idbStore.listBatches().then(b => !cancelled && setBatches(b)).catch(() => setStoreOk(false)); return; }
      if (cancelled) return;
      setFsDirName(dirName);
      const perm = await fsStore.checkPermission();
      if (cancelled) return;
      if (perm === 'granted') {
        setBackend('fs');
        fsStore.listBatches().then(b => !cancelled && setBatches(b)).catch(() => {});
      } else {
        setFsPendingAuth(true);
        idbStore.listBatches().then(b => !cancelled && setBatches(b)).catch(() => setStoreOk(false));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handlePickDirectory() {
    try {
      await fsStore.pickDirectory();
      setFsDirName(await fsStore.getDirectoryName());
      setFsPendingAuth(false);
      setBackend('fs');
      setStoreOk(true);
      fsStore.listBatches().then(setBatches).catch(() => {});
    } catch (e) {
      onStatus?.({ type: 'error', text: '选择文件夹失败：' + (e?.message || e) });
    }
  }
  async function handleAuthorize() {
    try {
      await fsStore.requestPermission();
      setFsPendingAuth(false);
      setBackend('fs');
      setStoreOk(true);
      fsStore.listBatches().then(setBatches).catch(() => {});
    } catch (e) {
      onStatus?.({ type: 'error', text: '授权失败：' + (e?.message || e) });
    }
  }
  async function handleForgetDirectory() {
    await fsStore.forgetDirectory().catch(() => {});
    setFsDirName(null); setFsPendingAuth(false); setBackend('idb'); setStoreOk(true);
    idbStore.listBatches().then(setBatches).catch(() => setStoreOk(false));
  }

  const savedCalls = batches.filter(b => b.kind === 'calls');
  const savedSnaps = batches.filter(b => b.kind === 'snaps');

  // 按【分组名（文件夹优先，否则策略名）→ 策略id → 批次】归档
  const groups = useMemo(() => groupBatches(batches, folders), [batches, folders]);
  const multiStrategy = groups.length > 1;
  const needsBackfill = batches.some(b => !b.strategyName);

  // 勾选行 → 选中的批次 id 列表。批次行 key = 'b:'+b.id；idb 的 b.id 是数字、fs 是字符串，
  // IndexedDB 的 get 对 key 类型敏感（get('5') ≠ get(5)），所以必须用这张表映射回原始类型的 id，
  // 不能直接 key.slice(2) 拿字符串去调 store。
  const batchKeyToId = useMemo(() => {
    const m = new Map();
    for (const b of batches) m.set('b:' + b.id, b.id);
    return m;
  }, [batches]);
  const selectedBatchIds = useMemo(
    () => selectedKeys.filter(k => typeof k === 'string' && k.startsWith('b:'))
      .map(k => batchKeyToId.get(k)).filter(id => id !== undefined),
    [selectedKeys, batchKeyToId]);
  // 勾选涉及哪些分组（文件夹/策略名）——用于分析状态里说清"这次只分析了哪些"
  const selectionGroupLabel = useMemo(() => {
    if (!selectedBatchIds.length) return '';
    const set = new Set(selectedBatchIds);
    const names = new Set();
    for (const b of batches) {
      if (!set.has(b.id)) continue;
      names.add((b.folder && String(b.folder).trim()) || deriveBatchStrategy(b).strategyName || UNNAMED);
    }
    const arr = [...names];
    return arr.length <= 2 ? arr.join('、') : `${arr[0]} 等 ${arr.length} 组`;
  }, [selectedBatchIds, batches]);

  // 把一批批次挪进某个文件夹（target=MOVE_OUT 表示移出、回到自动策略分组）
  async function moveBatchesToFolder(ids, target) {
    const folder = target === MOVE_OUT ? null : target;
    for (const id of ids) await store.updateBatchMeta(id, { folder }).catch(() => {});
    setSelectedKeys([]);
    await refreshBatches();
    message.success(folder ? `已挪 ${ids.length} 个批次到「${folder}」` : `已把 ${ids.length} 个批次移出文件夹`);
  }
  // 新建空文件夹（还没批次也先建着，后面往里挪）
  function createFolder(name) {
    const n = String(name || '').trim();
    if (!n) return;
    const next = addFolder(folders, n);
    setFolders(next); saveFolders(next);
  }
  // 文件夹改名：名单里改 + 把所有 folder===from 的批次 meta 改成 to
  async function renameFolderTo(from, to) {
    const t = String(to || '').trim();
    if (!t || t === from) return;
    const next = renameFolder(folders, from, t);
    setFolders(next); saveFolders(next);
    const affected = batches.filter(b => b.folder === from).map(b => b.id);
    for (const id of affected) await store.updateBatchMeta(id, { folder: t }).catch(() => {});
    await refreshBatches();
    message.success(`文件夹「${from}」已改名为「${t}」`);
  }
  // 删文件夹：先把里面的批次移出（不删数据），再从名单里去掉这个空文件夹
  async function deleteFolder(name) {
    const inside = batches.filter(b => b.folder === name).map(b => b.id);
    for (const id of inside) await store.updateBatchMeta(id, { folder: null }).catch(() => {});
    const next = removeFolder(folders, name);
    setFolders(next); saveFolders(next);
    await refreshBatches();
    message.success(inside.length ? `已删除文件夹「${name}」，里面 ${inside.length} 个批次移回自动分组` : `已删除空文件夹「${name}」`);
  }
  function submitFolderModal() {
    if (!folderModal) return;
    if (folderModal.mode === 'new') createFolder(folderModal.value);
    else renameFolderTo(folderModal.from, folderModal.value);
    setFolderModal(null);
  }

  async function deleteBatchIds(ids) {
    for (const id of ids) await store.deleteBatch(id).catch(() => {});
    refreshBatches();
  }
  async function handleBackfill() {
    setBackfilling(true);
    try {
      const n = await store.backfillStrategyInfo();
      await refreshBatches();
      onStatus?.({ type: 'success', text: n > 0 ? `已补全 ${n} 个旧批次的策略名` : '没有需要补全的批次（或旧批次记录里也没有策略名）' });
    } catch (e) {
      onStatus?.({ type: 'error', text: '补全失败：' + (e?.message || e) });
    } finally { setBackfilling(false); }
  }

  // 归档树：策略名 → 策略id → 批次，供 Table 的 children 展开
  const treeData = useMemo(() => groups.map(g => ({
    key: 's:' + g.strategyName, rowType: 'strategy', label: g.strategyName, isFolder: g.isFolder,
    calls: g.calls, snaps: g.snaps, count: g.count,
    // 空文件夹（还没批次）不给 children，免得展开出一个空箭头
    children: g.ids.length ? g.ids.map(id => ({
      key: `i:${g.strategyName}|${id.strategyId}`, rowType: 'id', label: id.strategyId,
      calls: id.calls, snaps: id.snaps, count: id.count, strategyName: g.strategyName,
      children: id.batches.slice().sort((a, b) => b.addedAt - a.addedAt).map(b => ({
        key: 'b:' + b.id, rowType: 'batch', label: b.name, kind: b.kind, count: b.count, addedAt: b.addedAt, batch: b,
      })),
    })) : undefined,
  })), [groups]);

  return {
    batches, storeOk, backfilling, backend, fsDirName, fsPendingAuth,
    folders, selectedKeys, setSelectedKeys, folderModal, setFolderModal,
    store, refreshBatches, handlePickDirectory, handleAuthorize, handleForgetDirectory,
    savedCalls, savedSnaps, groups, multiStrategy, needsBackfill,
    batchKeyToId, selectedBatchIds, selectionGroupLabel,
    moveBatchesToFolder, createFolder, renameFolderTo, deleteFolder, submitFolderModal,
    deleteBatchIds, handleBackfill, treeData,
  };
}
