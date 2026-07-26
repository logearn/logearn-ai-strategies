import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Upload, Button, Space, Typography, Alert, Progress, Tag, Checkbox, Popconfirm, Table, Select, Modal, Input, message } from 'antd';
import { UploadOutlined, DeleteOutlined, FolderOpenOutlined, FolderAddOutlined, EditOutlined } from '@ant-design/icons';
import { buildRows, readJson, detectFileKind } from '../lib/data.js';
import { mergeDaily } from '../lib/mergeDaily.js';
import { groupBatches, deriveBatchStrategy, groupKeyOf, UNNAMED, UNKNOWN_ID } from '../lib/dataArchive.js';
import { loadFolders, saveFolders, addFolder, removeFolder, renameFolder } from '../lib/dataFolders.js';
import { loadSliceCategories, saveSliceCategories, assignDays, daysInRange,
         selectRowsBySlice, summarizeSlices, CATEGORIES, loadSliceSel, saveSliceSel, groupRowsByDay,
         loadSliceScope, saveSliceScope, dayOf } from '../lib/dataSlices.js';
import * as idbStore from '../lib/dataStore.js';
import * as fsStore from '../lib/fsStore.js';

const MOVE_OUT = '__none__';   // "移出文件夹（回自动策略分组）" 的哨兵 value

const shortId = id => (id && id !== UNKNOWN_ID && id.length > 12 ? id.slice(0, 8) + '…' + id.slice(-4) : id);

const storageLabel = backend => (backend === 'fs' ? '本地文件夹' : '浏览器内置数据库');

export default function DataLoader({ onRows }) {
  // 只留一个上传入口——calls/snapshots 不用用户自己分拣，靠 detectFileKind 看 JSON 内容形状识别。
  // files 存 antd Upload 自己的 UploadFile 对象（{uid, name, originFileObj, ...}），走官方推荐的
  // onChange 受控写法。
  const [files, setFiles] = useState([]);
  // AntD Upload 内部自己维护一份文件登记，光靠受控 fileList 属性改小（甚至清空）它不一定会同步
  // 反映到界面——真实踩过：analyze() 把 files 过滤/清空后，state 确实变了（打点验证过 setFiles
  // 的 updater 算出来是空数组），但上传区里处理完的文件死活还留着。换 key 强制整个 Upload
  // 组件重新挂载，不去猜/修 AntD 内部那份状态到底哪里没同步，直接绕过它。
  const [uploadKey, setUploadKey] = useState(0);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [batches, setBatches] = useState([]);          // 已存批次元数据
  const [storeOk, setStoreOk] = useState(true);        // 当前后端可用性（隐私模式/权限撤销等）
  const [includeSaved, setIncludeSaved] = useState(true);
  const [persist, setPersist] = useState(true);
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
  // ── 时间切片 ──
  const [allRows, setAllRows] = useState([]);              // 上次分析出的全量样本（切片从它现分）
  const [sliceKey, setSliceKey] = useState('__all__');     // 切片作用域（策略名；混合时 __all__）
  const [sliceCats, setSliceCats] = useState(loadSliceCategories); // 天→类别 归类表（持久化）
  const [sliceSel, setSliceSel] = useState(loadSliceSel); // 当前分析范围（切片，持久化）
  const [sliceSelectedDays, setSliceSelectedDays] = useState([]); // 切片表勾选的天
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  // 数据源管理（批次/文件夹归档）默认折叠——有持久化作用域时会自动载入训练集/基准库，让切片成为主体；
  // 没有作用域（首次使用）则展开，方便选数据。
  const [showArchive, setShowArchive] = useState(() => !loadSliceScope());

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
      setStatus({ type: 'error', text: '选择文件夹失败：' + (e?.message || e) });
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
      setStatus({ type: 'error', text: '授权失败：' + (e?.message || e) });
    }
  }
  async function handleForgetDirectory() {
    await fsStore.forgetDirectory().catch(() => {});
    setFsDirName(null); setFsPendingAuth(false); setBackend('idb'); setStoreOk(true);
    idbStore.listBatches().then(setBatches).catch(() => setStoreOk(false));
  }

  async function analyze() {
    const hasSaved = includeSaved && batches.length > 0;
    if (!files.length && !hasSaved) {
      setStatus({ type: 'warning', text: '请选择 calls / snapshots JSON 文件（可多选、可混选，一天一对，自动识别类型），或勾选「包含已存数据」' });
      return;
    }
    setBusy(true); setPct(0);
    setStatus({ type: 'info', text: '解析中…' });
    try {
      // 一个入口混着传：逐个解析后按内容形状（有没有 signal/ctx，还是有没有 *_mcap）分成
      // calls/snapshots 两桶，不用用户自己把文件分拣进两个按钮。认不出类型的文件不静默丢弃，
      // 也不瞎猜塞进某一桶（猜错了会把 calls 当 snapshots 存，后面匹配全部为 0，比直接报错更难查），
      // 而是收集起来在结果里明确点名，人工确认文件本身是不是导出坏了。
      const newCalls = [], newSnaps = [], unrecognizedUids = new Set(), unrecognizedMsgs = [];
      for (const item of files) {
        const uid = item.uid;
        const f = item.originFileObj || item;
        const data = await readJson(f);
        if (!Array.isArray(data)) { unrecognizedUids.add(uid); unrecognizedMsgs.push(`${f.name}（不是数组）`); continue; }
        const kind = detectFileKind(data);
        if (kind === 'calls') newCalls.push({ name: f.name, data });
        else if (kind === 'snaps') newSnaps.push({ name: f.name, data });
        else { unrecognizedUids.add(uid); unrecognizedMsgs.push(`${f.name}（认不出是 calls 还是 snapshots）`); }
      }
      let callsArrays = newCalls.map(x => x.data);
      let snapsArrays = newSnaps.map(x => x.data);
      let savedNote = '';
      let analyzedIds = null;   // 供切片作用域推断用（这次分析到底纳入了哪些已存批次）
      if (hasSaved) {
        // 分析范围直接由上面的【勾选】决定：勾了哪些批次就只分析哪些——这才符合直觉（勾了 1.5段
        // 就只看 1.5段）。一个都没勾才退回"全部"（多策略混算通常没意义，界面上有黄色警告提示）。
        const useSel = selectedBatchIds.length > 0;
        const ids = useSel ? new Set(selectedBatchIds) : new Set(batches.map(b => b.id));
        analyzedIds = ids;
        const saved = await store.loadAllData({ ids });
        callsArrays = [...saved.callsArrays, ...callsArrays];
        snapsArrays = [...saved.snapsArrays, ...snapsArrays];
        const label = useSel ? `勾选：${selectionGroupLabel}` : (multiStrategy ? '全部·混合' : '全部');
        savedNote = `含已存 ${ids.size} 个批次（${label}）；`;
      }
      const merged = mergeDaily(callsArrays, snapsArrays);
      const rows = await buildRows(merged.calls, merged.snapshots, (done, total) => {
        if (total) setPct(Math.round(done / total * 100));
      });
      // 时间切片：作用域 key = 这次分析纳入的已存批次若同属一个分组名就用它，否则算"混合"（__all__）。
      let key = '__all__';
      if (analyzedIds) {
        const names = new Set(batches.filter(b => analyzedIds.has(b.id)).map(b => groupKeyOf(b)));
        if (names.size === 1) key = [...names][0];
      }
      emitRows(rows, key);
      // 分析成功后再入库：坏文件（解析失败/格式不对）不应该被存下来，否则以后每次都炸
      let persistNote = '';
      if (persist && storeOk && (newCalls.length || newSnaps.length)) {
        try {
          for (const x of newCalls) await store.saveBatch({ name: x.name, kind: 'calls', records: x.data });
          for (const x of newSnaps) await store.saveBatch({ name: x.name, kind: 'snaps', records: x.data });
          // 认不出类型的文件留在待上传区，让用户能看到还剩什么没处理，不能连同已识别的一起清空。
          // 按 uid（antd 给每个文件分配的那个，不是文件名字符串）过滤，两个文件重名时也不会误删。
          setFiles(prev => prev.filter(x => unrecognizedUids.has(x.uid)));
          setUploadKey(k => k + 1); // 强制 Upload 重新挂载，绕开它内部登记跟受控 fileList 对不上的问题
          refreshBatches();
          persistNote = `；本次 ${newCalls.length + newSnaps.length} 个文件已存入${storageLabel(backend)}`;
        } catch (e) {
          persistNote = `；⚠️ 存入${storageLabel(backend)}失败（${e?.message || e}），本次仅内存分析`;
        }
      }
      // 匹配为 0 时必须说清楚原因。旧版把跳过数记在 buildRows.lastSkippedByTimeDiff 上却从不展示，
      // 用户只能看到"0 条样本"，无从判断是文件配错了、字段名不对、还是时间对不上。
      const skipped = Number(buildRows.lastSkippedByTimeDiff) || 0;
      const parts = [];
      if (unrecognizedMsgs.length) parts.push(`⚠️ ${unrecognizedMsgs.length} 个文件${unrecognizedMsgs.join('、')}未识别类型，已跳过`);
      if (savedNote || newCalls.length > 1 || newSnaps.length > 1) {
        parts.push(`${savedNote}合并 ${callsArrays.length} 个 calls / ${snapsArrays.length} 个 snapshots 批次`);
      }
      if (merged.dupCalls) parts.push(`去重剔除 ${merged.dupCalls} 条重复 call（保留导出更晚的）`);
      if (merged.dupSnaps) parts.push(`剔除 ${merged.dupSnaps} 条重复快照`);
      parts.push(`匹配到 ${rows.length} 条样本`);
      if (skipped) parts.push(`另有 ${skipped} 条因 calls 与 snapshots 的时间戳相差过大被跳过`);
      if (!rows.length) parts.push('请检查：两个文件是否同一批导出、calls 里是否有 timestamp 字段（匹配用的是它而不是 swap_begin_time）');
      setStatus({ type: rows.length ? 'success' : (unrecognizedMsgs.length ? 'warning' : 'error'), text: parts.join('；') + persistNote });
    } catch (e) {
      setStatus({ type: 'error', text: '解析失败：' + (e?.message || e) });
    } finally { setBusy(false); setPct(100); }
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

  // ── 时间切片：归类 + 按切片选分析范围 ──
  // 分析/自动载入的共同收尾：留住全量样本、记作用域、恢复上次的分析范围（切片）、把切好片的样本发下游。
  function emitRows(rows, key) {
    setAllRows(rows);
    setSliceKey(key); saveSliceScope(key);
    let sel = loadSliceSel();
    if (sel.mode === 'day' && !new Set(groupRowsByDay(rows).map(d => d.day)).has(sel.day)) sel = { mode: 'all' };
    setSliceSel(sel); saveSliceSel(sel); setSliceSelectedDays([]);
    onRows(selectRowsBySlice(rows, key, sliceCats, sel));
  }
  // 启动自动载入"上次规划好的训练集/基准库"——不用再选批次点分析。只读已存批次，不碰上传/入库。
  const autoLoadedRef = useRef(false);
  async function autoLoad(scope) {
    const ids = scope === '__all__'
      ? new Set(batches.map(b => b.id))
      : new Set(batches.filter(b => groupKeyOf(b) === scope).map(b => b.id));
    if (!ids.size) return;
    setBusy(true);
    try {
      const saved = await store.loadAllData({ ids });
      const merged = mergeDaily(saved.callsArrays, saved.snapsArrays);
      const rows = await buildRows(merged.calls, merged.snapshots);
      emitRows(rows, scope);
      setStatus({ type: 'success', text: `已自动载入「${scope === '__all__' ? '全部' : scope}」的训练集/基准库：${rows.length} 条样本（如需纳入新数据源，选文件后点「分析」）` });
    } catch (e) {
      setStatus({ type: 'warning', text: '自动载入失败，请手动点「分析」：' + (e?.message || e) });
    } finally { setBusy(false); }
  }
  // 批次就绪后自动载入一次上次的作用域（仅一次；用户手动分析过就不再自动覆盖）
  useEffect(() => {
    if (autoLoadedRef.current || allRows.length || !batches.length) return;
    const scope = loadSliceScope();
    if (!scope) return;
    autoLoadedRef.current = true;
    autoLoad(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches]);

  const sliceSummary = useMemo(() => summarizeSlices(allRows, sliceKey, sliceCats), [allRows, sliceKey, sliceCats]);
  // 归类一批天到某类别（cat=null 移出）；若当前分析范围按类别选，改完立刻重过滤重发
  function assignSliceDays(days, cat) {
    if (!days.length) return;
    const next = assignDays(sliceCats, sliceKey, days, cat);
    setSliceCats(next); saveSliceCategories(next); setSliceSelectedDays([]);
    // 归类后勾选清空 → 视图回到「分析范围」下拉的口径（用新归类表重算，基准库/训练集计数会跟着变）
    onRows(selectRowsBySlice(allRows, sliceKey, next, sliceSel));
    const label = cat ? CATEGORIES[cat] : '未分配';
    message.success(`已把 ${days.length} 天转入「${label}」`);
  }
  function assignRange(cat) {
    const days = daysInRange(allRows, rangeStart.trim(), rangeEnd.trim());
    if (!days.length) { message.warning('该区间内没有样本天'); return; }
    assignSliceDays(days, cat);
  }
  // 一键把【当前工作集里所有天】归到某类（跨分页，不用逐天勾）。数据少的阶段：全部先进训练集。
  function assignAllDays(cat) {
    const days = sliceSummary.days.map(d => d.day).filter(d => d !== '未知');
    if (!days.length) return;
    assignSliceDays(days, cat);
  }
  // 切换分析范围（切片）→ 清掉逐天勾选（下拉优先）、持久化、重新过滤重发
  function changeSliceSel(sel) {
    setSliceSel(sel); saveSliceSel(sel); setSliceSelectedDays([]);
    onRows(selectRowsBySlice(allRows, sliceKey, sliceCats, sel));
  }
  // 勾选表里的天 = 分析就用这些天（总览/下游立即跟着变）；取消全部勾选则回到「分析范围」下拉的口径。
  // 勾选同时也是"批量归类"的选择对象（下方转入基准库/训练集按钮用的就是它）。
  const rowsOfDays = (days) => allRows.filter(r => days.includes(dayOf(r.buyTimestamp) || '未知'));
  function selectDays(days) {
    setSliceSelectedDays(days);
    onRows(days.length ? rowsOfDays(days) : selectRowsBySlice(allRows, sliceKey, sliceCats, sliceSel));
  }
  // 当前实际分析的样本数：勾了天就按勾选，否则按分析范围下拉
  const effectiveCount = sliceSelectedDays.length
    ? rowsOfDays(sliceSelectedDays).length
    : selectRowsBySlice(allRows, sliceKey, sliceCats, sliceSel).length;

  async function deleteBatchIds(ids) {
    for (const id of ids) await store.deleteBatch(id).catch(() => {});
    refreshBatches();
  }
  async function handleBackfill() {
    setBackfilling(true);
    try {
      const n = await store.backfillStrategyInfo();
      await refreshBatches();
      setStatus({ type: 'success', text: n > 0 ? `已补全 ${n} 个旧批次的策略名` : '没有需要补全的批次（或旧批次记录里也没有策略名）' });
    } catch (e) {
      setStatus({ type: 'error', text: '补全失败：' + (e?.message || e) });
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

  return (
    <Card size="small" title={<Space size={8}>数据源{batches.length > 0 &&
        <Tag color="blue">已存 {savedCalls.length} + {savedSnaps.length} 个批次</Tag>}</Space>}
      extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>
        可多选多天的 calls/snapshots 文件混在一起选（自动识别类型、按 call id 去重）；
        数据只存在本地（{storageLabel(backend)}），不会上传
      </Typography.Text>}>
      <Space align="start" wrap size={24}>
        <Upload key={uploadKey} multiple maxCount={60} accept=".json"
                beforeUpload={() => false}
                fileList={files}
                onChange={({ fileList }) => setFiles(fileList)}>
          <Button icon={<UploadOutlined />}>选择数据文件（可多选，自动识别 calls/snapshots）</Button>
        </Upload>
        <Button type="primary" loading={busy} onClick={analyze}>分析</Button>
      </Space>

      {fsStore.isSupported() && (
        <div style={{ marginTop: 8 }}>
          {backend === 'fs' ? (
            <Space size={8} wrap>
              <Tag color="green" icon={<FolderOpenOutlined />}>本地文件夹：{fsDirName}</Tag>
              <Button size="small" onClick={handlePickDirectory}>更换文件夹</Button>
              <Button size="small" onClick={handleForgetDirectory}>改用浏览器内置数据库</Button>
            </Space>
          ) : fsPendingAuth ? (
            <Alert type="warning" showIcon message={
              <Space wrap>
                <span style={{ fontSize: 12 }}>文件夹「{fsDirName}」需要重新授权才能继续使用（浏览器重启后权限会失效）</span>
                <Button size="small" type="primary" onClick={handleAuthorize}>点击授权</Button>
                <Button size="small" onClick={handleForgetDirectory}>改用浏览器内置数据库</Button>
              </Space>} />
          ) : (
            <Button size="small" icon={<FolderOpenOutlined />} onClick={handlePickDirectory}>
              选择本地文件夹存数据（推荐：比浏览器数据库更透明轻量，文件可直接在文件管理器里看到）
            </Button>
          )}
        </div>
      )}

      <Space style={{ marginTop: 8 }} size={16} wrap>
        {storeOk && <Checkbox checked={persist} onChange={e => setPersist(e.target.checked)}>
          <span style={{ fontSize: 12 }}>本次上传存入{storageLabel(backend)}（逐天积累）</span></Checkbox>}
        {batches.length > 0 && <Checkbox checked={includeSaved} onChange={e => setIncludeSaved(e.target.checked)}>
          <span style={{ fontSize: 12 }}>分析时包含已存数据</span></Checkbox>}
        {batches.length > 0 && includeSaved && (
          <Tag color={selectedBatchIds.length ? 'blue' : 'default'} style={{ fontSize: 12 }}>
            {selectedBatchIds.length
              ? `分析范围：勾选的 ${selectedBatchIds.length} 个批次（${selectionGroupLabel}）`
              : '分析范围：全部（下方勾选某策略/文件夹可只分析它）'}
          </Tag>
        )}
        {!storeOk && <Typography.Text type="warning" style={{ fontSize: 12 }}>
          当前存储方式不可用（可能是隐私模式或权限被撤销），仅本次会话有效</Typography.Text>}
      </Space>
      {batches.length > 0 && includeSaved && multiStrategy && selectedBatchIds.length === 0 && (
        <Alert style={{ marginTop: 8 }} type="warning" showIcon
          message={<span style={{ fontSize: 12 }}>已存 {groups.filter(g => !g.isFolder || g.count).length} 个策略/文件夹，没勾选=分析【全部混合】——不同策略一起算通常没意义。想只看某个策略，请在下方表格里勾选它（勾策略行会连它下面的批次一起选中）。</span>} />
      )}
      {batches.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <Space style={{ marginBottom: 6 }} size={8} wrap>
            <Typography.Text strong style={{ fontSize: 12 }}>数据源管理 · 按文件夹/策略归档（添加/归档/删除）</Typography.Text>
            <Button size="small" type="text" onClick={() => setShowArchive(v => !v)}>
              {showArchive ? '收起' : `展开管理（${batches.length} 批次）`}
            </Button>
            {showArchive && (
              <Button size="small" icon={<FolderAddOutlined />} onClick={() => setFolderModal({ mode: 'new', value: '' })}>
                新建文件夹
              </Button>
            )}
            {showArchive && needsBackfill && (
              <Button size="small" loading={backfilling} onClick={handleBackfill}>
                补全策略名（读取旧批次里的 strategy_name）
              </Button>
            )}
          </Space>
          {showArchive && (<>
          {selectedBatchIds.length > 0 && (
            <Space style={{ marginBottom: 6 }} size={8} wrap>
              <Tag color="blue">已选 {selectedBatchIds.length} 个批次</Tag>
              <span style={{ fontSize: 12, color: 'var(--muted,#8e8e93)' }}>移动到</span>
              <Select size="small" style={{ minWidth: 200 }} placeholder="选择目标文件夹" value={null}
                onChange={v => moveBatchesToFolder(selectedBatchIds, v)}
                options={[
                  ...folders.map(f => ({ value: f, label: '📁 ' + f })),
                  { value: MOVE_OUT, label: '移出文件夹（回自动策略分组）' },
                ]}
                notFoundContent="还没有文件夹，先点上面「新建文件夹」" />
              <Button size="small" type="text" onClick={() => setSelectedKeys([])}>取消选择</Button>
            </Space>
          )}
          <Table size="small" rowKey="key" pagination={false}
            defaultExpandAllRows={groups.length <= 3}
            dataSource={treeData}
            rowSelection={{
              // checkStrictly=false：勾父节点自动带上所有子节点，符合"选整个策略/id 一起挪"的直觉
              checkStrictly: false, selectedRowKeys: selectedKeys, onChange: setSelectedKeys,
            }}
            columns={[
              { title: '策略 / 文件夹 / id / 批次文件', dataIndex: 'label',
                render: (v, r) => {
                  if (r.rowType === 'strategy') return (
                    <Typography.Text strong>{r.isFolder ? '📁' : '📊'} {v}
                      {r.isFolder && <Tag style={{ marginLeft: 6 }} color="geekblue">文件夹</Tag>}</Typography.Text>);
                  if (r.rowType === 'id') return <code style={{ fontSize: 11 }} title={v}>🆔 {shortId(v)}</code>;
                  return <code style={{ fontSize: 11 }}>{v}</code>;
                } },
              { title: '类型', width: 130,
                render: (_, r) => r.rowType === 'batch'
                  ? <Tag>{r.kind === 'calls' ? 'calls' : 'snapshots'}</Tag>
                  : <span style={{ fontSize: 11, color: 'var(--muted,#8e8e93)' }}>calls {r.calls} · snap {r.snaps}</span> },
              { title: '记录数', dataIndex: 'count', width: 90, align: 'right' },
              { title: '存入时间', width: 160,
                render: (_, r) => r.rowType === 'batch' ? new Date(r.addedAt).toLocaleString('zh-CN', { hour12: false }) : '' },
              { title: '', width: 90, render: (_, r) => {
                if (r.rowType === 'batch') return (
                  <Space size={2}>
                    <Popconfirm title={`删除批次 ${r.label}？`} okText="删除" cancelText="取消"
                      onConfirm={() => store.deleteBatch(r.batch.id).then(refreshBatches)}>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>);
                const ids = [];
                const collect = node => { for (const c of node.children || []) { if (c.rowType === 'batch') ids.push(c.batch.id); else collect(c); } };
                collect(r);
                // 文件夹行：可改名 + 删文件夹（删文件夹=把里面批次移回自动分组，不删数据）
                if (r.rowType === 'strategy' && r.isFolder) return (
                  <Space size={2}>
                    <Button size="small" type="text" icon={<EditOutlined />}
                      title="文件夹改名" onClick={() => setFolderModal({ mode: 'rename', from: r.label, value: r.label })} />
                    <Popconfirm title={`删除文件夹「${r.label}」？里面 ${ids.length} 个批次会移回自动分组（数据不删）`}
                      okText="删除文件夹" cancelText="取消" onConfirm={() => deleteFolder(r.label)}>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} title="删除文件夹" />
                    </Popconfirm>
                  </Space>);
                const label = r.rowType === 'strategy' ? `「${r.label}」的全部 ${ids.length} 个批次` : `这个 id 下的 ${ids.length} 个批次`;
                return (
                  <Popconfirm title={`删除${label}？`} okText="删除" cancelText="取消"
                    onConfirm={() => deleteBatchIds(ids)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>);
              } },
            ]} />
          <Popconfirm title="清空全部已存数据？此操作不可恢复" okText="清空" cancelText="取消"
            onConfirm={() => store.clearAll().then(refreshBatches)}>
            <Button size="small" danger style={{ marginTop: 8 }}>清空全部已存数据</Button>
          </Popconfirm>
          </>)}
          <Modal open={!!folderModal} onCancel={() => setFolderModal(null)} onOk={submitFolderModal}
            okText={folderModal?.mode === 'new' ? '新建' : '改名'} cancelText="取消"
            title={folderModal?.mode === 'new' ? '新建文件夹' : `文件夹改名：${folderModal?.from || ''}`}>
            <Input autoFocus value={folderModal?.value || ''} placeholder="文件夹名称"
              onChange={e => setFolderModal(m => ({ ...m, value: e.target.value }))}
              onPressEnter={submitFolderModal} />
          </Modal>
        </div>
      )}
      {allRows.length > 0 && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--border,#303030)', paddingTop: 12 }}>
          <Space style={{ marginBottom: 6 }} size={8} wrap>
            <Typography.Text strong style={{ fontSize: 12 }}>时间切片（按信号买入时刻分天；训练集调参、基准库做样本外验证）</Typography.Text>
            <Tag color="blue">🟦 基准库 {sliceSummary.tally.baseline.days}天/{sliceSummary.tally.baseline.count}条</Tag>
            <Tag color="green">🟩 训练集 {sliceSummary.tally.train.days}天/{sliceSummary.tally.train.count}条</Tag>
            <Tag>未分配 {sliceSummary.tally.unassigned.days}天/{sliceSummary.tally.unassigned.count}条</Tag>
            {sliceKey === '__all__'
              ? <Tag color="warning">混合策略：切片归类不区分策略</Tag>
              : <Tag>作用域：{sliceKey}</Tag>}
            {/* 数据少的阶段：一键把所有天先归进训练集，基准库以后慢慢攒 */}
            <Button size="small" onClick={() => assignAllDays('train')}>全部→训练集</Button>
            <Button size="small" onClick={() => assignAllDays('baseline')}>全部→基准库</Button>
          </Space>

          {/* 分析范围（切片）：选完下游所有面板立即跟着变 */}
          <Space style={{ marginBottom: 6 }} size={8} wrap>
            <span style={{ fontSize: 12, color: 'var(--muted,#8e8e93)' }}>分析范围（切片）</span>
            <Select size="small" style={{ width: 140 }} value={sliceSel.mode === 'range' ? 'range' : sliceSel.mode}
              onChange={m => {
                if (m === 'day') changeSliceSel({ mode: 'day', day: sliceSummary.days[0] && sliceSummary.days[0].day });
                else if (m === 'range') changeSliceSel({ mode: 'range', start: rangeStart.trim(), end: rangeEnd.trim() });
                else changeSliceSel({ mode: m });
              }}
              options={[
                { value: 'all', label: '全部' },
                { value: 'baseline', label: '🟦 基准库' },
                { value: 'train', label: '🟩 训练集' },
                { value: 'day', label: '某一天' },
                { value: 'range', label: '自定义区间（用下方区间框）' },
              ]} />
            {sliceSel.mode === 'day' && (
              <Select size="small" style={{ width: 160 }} value={sliceSel.day} showSearch
                onChange={day => changeSliceSel({ mode: 'day', day })}
                options={sliceSummary.days.filter(d => d.day !== '未知').map(d => ({ value: d.day, label: `${d.day}（${d.count}）` }))} />
            )}
            <Tag color="blue" style={{ fontSize: 12 }}>当前分析 {effectiveCount} 条</Tag>
            {sliceSelectedDays.length > 0 && (
              <span style={{ fontSize: 12, color: '#faad14' }}>（按勾选的 {sliceSelectedDays.length} 天，取消勾选回到上面的范围）</span>
            )}
          </Space>

          {/* 归类操作条（勾选天后出现）*/}
          {sliceSelectedDays.length > 0 && (
            <Space style={{ marginBottom: 6 }} size={8} wrap>
              <Tag color="blue">已选 {sliceSelectedDays.length} 天</Tag>
              <span style={{ fontSize: 12 }}>转入</span>
              <Button size="small" onClick={() => assignSliceDays(sliceSelectedDays, 'baseline')}>🟦 基准库</Button>
              <Button size="small" onClick={() => assignSliceDays(sliceSelectedDays, 'train')}>🟩 训练集</Button>
              <Button size="small" onClick={() => assignSliceDays(sliceSelectedDays, null)}>移出</Button>
              <Button size="small" type="text" onClick={() => setSliceSelectedDays([])}>取消选择</Button>
            </Space>
          )}

          {/* 区间：一次选一段——可设为分析范围，或批量归类 */}
          <Space style={{ marginBottom: 6 }} size={4} wrap>
            <span style={{ fontSize: 12, color: 'var(--muted,#8e8e93)' }}>区间</span>
            <Input size="small" style={{ width: 118 }} placeholder="起 2026-07-24" value={rangeStart} onChange={e => setRangeStart(e.target.value)} />
            <span>~</span>
            <Input size="small" style={{ width: 118 }} placeholder="止 2026-07-26" value={rangeEnd} onChange={e => setRangeEnd(e.target.value)} />
            <Button size="small" onClick={() => changeSliceSel({ mode: 'range', start: rangeStart.trim(), end: rangeEnd.trim() })}>设为分析范围</Button>
            <Button size="small" onClick={() => assignRange('baseline')}>转入基准库</Button>
            <Button size="small" onClick={() => assignRange('train')}>转入训练集</Button>
          </Space>

          <Table size="small" rowKey="day" pagination={{ pageSize: 10, size: 'small' }}
            dataSource={sliceSummary.days}
            rowSelection={{
              selectedRowKeys: sliceSelectedDays, onChange: selectDays,
              getCheckboxProps: r => ({ disabled: r.day === '未知' }),
            }}
            columns={[
              { title: '日期', dataIndex: 'day', width: 150 },
              { title: '样本数', dataIndex: 'count', width: 90, align: 'right' },
              { title: '类别', width: 120, render: (_, r) => r.category === 'baseline'
                ? <Tag color="blue">🟦 基准库</Tag> : r.category === 'train'
                ? <Tag color="green">🟩 训练集</Tag> : <span style={{ opacity: .5 }}>未分配</span> },
              { title: '', width: 190, render: (_, r) => r.day === '未知' ? null : (
                <Space size={2}>
                  <Button size="small" type="link" onClick={() => assignSliceDays([r.day], 'baseline')}>基准库</Button>
                  <Button size="small" type="link" onClick={() => assignSliceDays([r.day], 'train')}>训练集</Button>
                  {r.category && <Button size="small" type="link" onClick={() => assignSliceDays([r.day], null)}>移出</Button>}
                </Space>
              ) },
            ]} />
        </div>
      )}

      {busy && pct > 0 && <Progress percent={pct} size="small" style={{ marginTop: 12 }} />}
      {status && <Alert style={{ marginTop: 12 }} type={status.type} message={status.text} showIcon />}
    </Card>
  );
}
