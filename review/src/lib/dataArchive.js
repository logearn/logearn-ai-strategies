// 数据归档：把"已存批次"按【策略名 → 策略id → 批次】两级归档，避免多个策略/多个 strategy_id
// 的 calls/snapshots 混在一张平铺列表里，分析时也能只挑某个策略（或某个 id）跑，不再一锅乱炖。
// calls 和 snapshots 的每条记录都自带 strategy_name / strategy_id（顶层字段），导出文件名也形如
// snapshots_<strategy_id>.json —— 所以归档信息不用用户手填，从数据里自动抽即可。
// 纯函数，不依赖 IndexedDB / 文件系统 / React，方便直接单测。

// UUID（strategy_id 的形态）——用于从文件名兜底解析 strategy_id（旧批次 meta 里没存策略字段时）
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// 从一批记录里抽策略名 + 策略id：取第一条带这两个字段的记录（同一批文件必然同属一个策略，
// 首条就够；个别记录缺字段也能被后面的补上）。抽不到返回 null，调用方兜底。
export function extractStrategyInfo(records) {
  if (!Array.isArray(records)) return { strategyName: null, strategyId: null };
  let strategyName = null, strategyId = null;
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (strategyName == null && r.strategy_name != null && r.strategy_name !== '') strategyName = String(r.strategy_name);
    if (strategyId == null && r.strategy_id != null && r.strategy_id !== '') strategyId = String(r.strategy_id);
    if (strategyName != null && strategyId != null) break;
  }
  return { strategyName, strategyId };
}

// 从文件名兜底解析 strategy_id（旧批次 meta 里没存 strategyId 时）——文件名形如
// calls_<uuid>.json / snapshots_<uuid>.json，取里面的 UUID。
export function strategyIdFromName(name) {
  const m = String(name || '').match(UUID_RE);
  return m ? m[0] : null;
}

// 单个批次的归档归属：优先用 meta 里存的 strategyId/strategyName，没有就从文件名兜底解析 id
// （名字兜不出，只能是 null，界面显示成"未命名策略"）。
export function deriveBatchStrategy(batch) {
  return {
    strategyId: batch.strategyId || strategyIdFromName(batch.name) || null,
    strategyName: batch.strategyName || null,
  };
}

export const UNNAMED = '未命名策略';
export const UNKNOWN_ID = '未知ID';

// 一个批次的【顶层分组名】：手动设了 folder 就用 folder（覆盖自动策略分组），否则退回自动的
// strategy_name（再没有就是"未命名策略"）。新建文件夹/挪动批次改的就是 batch.meta.folder。
export function groupKeyOf(batch) {
  const folder = batch && batch.folder;
  if (folder != null && String(folder).trim() !== '') return String(folder);
  return deriveBatchStrategy(batch).strategyName || UNNAMED;
}

// 把批次数组归成【分组名 → 策略id → 批次】两级结构，给界面渲染树/分组表用。分组名 = groupKeyOf
// （手动文件夹优先，否则自动策略名）。每级都带 calls/snaps/count/batchCount 汇总。
// folders 传进已知的自定义文件夹名单：用来 (1) 标记哪些分组是文件夹（可改名/移出，图标不同）；
// (2) 把"新建了但还没放批次的空文件夹"也列出来，好让用户能往里挪。
// 返回按 count 降序（数据多的排前面）；同分组下 id 也按 count 降序。
export function groupBatches(batches, folders = []) {
  const folderSet = new Set(folders);
  const usedFolder = new Set();   // 实际被批次引用到的文件夹名（这些分组也算文件夹）
  const byName = new Map();
  for (const b of batches || []) {
    const { strategyId } = deriveBatchStrategy(b);
    const nameKey = groupKeyOf(b);
    if (b && b.folder != null && String(b.folder).trim() !== '') usedFolder.add(nameKey);
    if (!byName.has(nameKey)) byName.set(nameKey, { strategyName: nameKey, idMap: new Map(), calls: 0, snaps: 0, count: 0, batchCount: 0 });
    const g = byName.get(nameKey);
    const idKey = strategyId || UNKNOWN_ID;
    if (!g.idMap.has(idKey)) g.idMap.set(idKey, { strategyId: idKey, batches: [], calls: 0, snaps: 0, count: 0 });
    const ig = g.idMap.get(idKey);
    ig.batches.push(b);
    const isCalls = b.kind === 'calls';
    const cnt = Number(b.count) || 0;
    ig.calls += isCalls ? 1 : 0; ig.snaps += isCalls ? 0 : 1; ig.count += cnt;
    g.calls += isCalls ? 1 : 0; g.snaps += isCalls ? 0 : 1; g.count += cnt; g.batchCount += 1;
  }
  const groups = [...byName.values()].map(g => ({
    strategyName: g.strategyName, calls: g.calls, snaps: g.snaps, count: g.count, batchCount: g.batchCount,
    isFolder: folderSet.has(g.strategyName) || usedFolder.has(g.strategyName),
    ids: [...g.idMap.values()].sort((a, b) => b.count - a.count),
  }));
  // 空文件夹（名单里有、但还没批次）也列出来，count=0，好让用户把批次挪进去
  for (const f of folders) {
    if (!byName.has(f)) groups.push({ strategyName: f, calls: 0, snaps: 0, count: 0, batchCount: 0, isFolder: true, ids: [] });
  }
  return groups.sort((a, b) => b.count - a.count);
}

// 按"分析范围选择"筛出要纳入分析的批次 id 集合。
// selection: { level: 'all' } → 全部；{ level: 'strategy', strategyName } → 该策略名下所有 id；
//            { level: 'id', strategyName, strategyId } → 精确到某个策略的某个 id。
// 返回 Set<batch.id>，供 store.loadAllData({ ids }) 只读这些批次。
export function selectBatchIds(batches, selection) {
  const out = new Set();
  if (!selection || selection.level === 'all') { for (const b of batches || []) out.add(b.id); return out; }
  for (const b of batches || []) {
    const { strategyId } = deriveBatchStrategy(b);
    const nameKey = groupKeyOf(b);   // 顶层分组名（文件夹优先），跟 groupBatches 一致
    const idKey = strategyId || UNKNOWN_ID;
    if (selection.level === 'strategy' && nameKey === selection.strategyName) out.add(b.id);
    else if (selection.level === 'id' && nameKey === selection.strategyName && idKey === selection.strategyId) out.add(b.id);
  }
  return out;
}
