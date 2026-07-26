import assert from 'node:assert';
import { extractStrategyInfo, strategyIdFromName, deriveBatchStrategy, groupBatches, selectBatchIds, groupKeyOf, UNNAMED, UNKNOWN_ID } from '../src/lib/dataArchive.js';

export function run(test) {
  test('extractStrategyInfo: 从记录首条抽 strategy_name/strategy_id', () => {
    const r = extractStrategyInfo([{ strategy_name: '1.5段策略', strategy_id: 'abc', x: 1 }, { strategy_name: '1.5段策略' }]);
    assert.deepStrictEqual(r, { strategyName: '1.5段策略', strategyId: 'abc' });
  });

  test('extractStrategyInfo: 首条缺字段时从后续记录补齐', () => {
    const r = extractStrategyInfo([{ x: 1 }, { strategy_id: 'id2' }, { strategy_name: 'S' }]);
    assert.deepStrictEqual(r, { strategyName: 'S', strategyId: 'id2' });
  });

  test('extractStrategyInfo: 空/非数组/无字段 → null', () => {
    assert.deepStrictEqual(extractStrategyInfo([]), { strategyName: null, strategyId: null });
    assert.deepStrictEqual(extractStrategyInfo(null), { strategyName: null, strategyId: null });
    assert.deepStrictEqual(extractStrategyInfo([{ a: 1 }]), { strategyName: null, strategyId: null });
  });

  test('strategyIdFromName: 从文件名解析 UUID（旧批次兜底）', () => {
    assert.strictEqual(strategyIdFromName('snapshots_cd41f1b7-a168-427a-b48d-9cbf28ccad05.json'), 'cd41f1b7-a168-427a-b48d-9cbf28ccad05');
    assert.strictEqual(strategyIdFromName('calls_day1.json'), null);
  });

  test('deriveBatchStrategy: 优先 meta 字段，缺 id 时从文件名兜底', () => {
    assert.deepStrictEqual(deriveBatchStrategy({ name: 'x', strategyName: 'S', strategyId: 'i1' }), { strategyId: 'i1', strategyName: 'S' });
    // 旧批次没存 strategyId，但文件名里有 UUID
    const d = deriveBatchStrategy({ name: 'snapshots_cd41f1b7-a168-427a-b48d-9cbf28ccad05.json' });
    assert.strictEqual(d.strategyId, 'cd41f1b7-a168-427a-b48d-9cbf28ccad05');
    assert.strictEqual(d.strategyName, null);
  });

  const sample = [
    { id: 1, name: 'calls_A.json', kind: 'calls', count: 100, addedAt: 1, strategyName: 'S1', strategyId: 'id-a' },
    { id: 2, name: 'snaps_A.json', kind: 'snaps', count: 90, addedAt: 2, strategyName: 'S1', strategyId: 'id-a' },
    { id: 3, name: 'calls_B.json', kind: 'calls', count: 50, addedAt: 3, strategyName: 'S1', strategyId: 'id-b' },
    { id: 4, name: 'calls_C.json', kind: 'calls', count: 200, addedAt: 4, strategyName: 'S2', strategyId: 'id-c' },
    { id: 5, name: 'old_no_meta.json', kind: 'snaps', count: 10, addedAt: 5 }, // 旧批次，无策略字段、文件名也没 UUID
  ];

  test('groupBatches: 按 策略名→id 两级归档，汇总 calls/snaps/count', () => {
    const g = groupBatches(sample);
    // S1(190+90+50=... calls190+... ) count = 100+90+50=240; S2=200; 未命名=10 → 按 count 降序 S1,S2,未命名
    assert.strictEqual(g.length, 3);
    assert.strictEqual(g[0].strategyName, 'S1');
    assert.strictEqual(g[0].count, 240);
    assert.strictEqual(g[0].ids.length, 2, 'S1 下有 id-a / id-b 两个 id');
    const idA = g[0].ids.find(x => x.strategyId === 'id-a');
    assert.strictEqual(idA.count, 190);
    assert.strictEqual(idA.calls, 1);
    assert.strictEqual(idA.snaps, 1);
    assert.strictEqual(g[1].strategyName, 'S2');
    const unnamed = g.find(x => x.strategyName === UNNAMED);
    assert.ok(unnamed, '无策略字段的批次归到未命名策略');
    assert.strictEqual(unnamed.ids[0].strategyId, UNKNOWN_ID);
  });

  test('selectBatchIds: level=all 全选', () => {
    const ids = selectBatchIds(sample, { level: 'all' });
    assert.strictEqual(ids.size, 5);
  });

  test('selectBatchIds: level=strategy 只选某策略名下所有 id', () => {
    const ids = selectBatchIds(sample, { level: 'strategy', strategyName: 'S1' });
    assert.deepStrictEqual([...ids].sort(), [1, 2, 3]);
  });

  test('selectBatchIds: level=id 精确到某策略某 id', () => {
    const ids = selectBatchIds(sample, { level: 'id', strategyName: 'S1', strategyId: 'id-a' });
    assert.deepStrictEqual([...ids].sort(), [1, 2]);
  });

  // ---------- 自定义文件夹（覆盖策略分组）----------
  test('groupKeyOf: 设了 folder 用 folder，否则退回 strategy_name，再没有是未命名', () => {
    assert.strictEqual(groupKeyOf({ folder: '测试中', strategyName: 'S1' }), '测试中');
    assert.strictEqual(groupKeyOf({ strategyName: 'S1' }), 'S1');
    assert.strictEqual(groupKeyOf({ folder: '  ', strategyName: 'S1' }), 'S1', '空白 folder 不算数');
    assert.strictEqual(groupKeyOf({}), UNNAMED);
  });

  test('groupBatches: folder 覆盖策略分组——挪进文件夹的批次归到文件夹名下，可跨策略同处一个文件夹', () => {
    const withFolder = [
      { id: 1, name: 'a', kind: 'calls', count: 100, addedAt: 1, strategyName: 'S1', strategyId: 'id-a', folder: '已上线' },
      { id: 2, name: 'b', kind: 'calls', count: 200, addedAt: 2, strategyName: 'S2', strategyId: 'id-c', folder: '已上线' },
      { id: 3, name: 'c', kind: 'calls', count: 50, addedAt: 3, strategyName: 'S1', strategyId: 'id-b' }, // 没挪，留在 S1
    ];
    const g = groupBatches(withFolder, ['已上线']);
    const online = g.find(x => x.strategyName === '已上线');
    assert.ok(online, '应有「已上线」文件夹分组');
    assert.strictEqual(online.isFolder, true);
    assert.strictEqual(online.count, 300, '两个不同策略的批次都归到这个文件夹');
    assert.strictEqual(online.ids.length, 2, '文件夹下按 strategy_id 仍分两个 id');
    const s1 = g.find(x => x.strategyName === 'S1');
    assert.strictEqual(s1.count, 50, 'S1 只剩没挪走的那个批次');
    assert.strictEqual(s1.isFolder, false);
  });

  test('groupBatches: 空文件夹（名单里有、还没批次）也列出来，count=0，好让用户往里挪', () => {
    const g = groupBatches([{ id: 1, name: 'a', kind: 'calls', count: 10, addedAt: 1, strategyName: 'S1', strategyId: 'id-a' }], ['空文件夹']);
    const empty = g.find(x => x.strategyName === '空文件夹');
    assert.ok(empty, '空文件夹应出现在分组里');
    assert.strictEqual(empty.isFolder, true);
    assert.strictEqual(empty.count, 0);
    assert.deepStrictEqual(empty.ids, []);
  });

  test('selectBatchIds: level=strategy 用文件夹名也能选中（folder 覆盖后按文件夹选范围）', () => {
    const withFolder = [
      { id: 1, name: 'a', kind: 'calls', count: 100, addedAt: 1, strategyName: 'S1', strategyId: 'id-a', folder: '已上线' },
      { id: 2, name: 'b', kind: 'calls', count: 200, addedAt: 2, strategyName: 'S2', strategyId: 'id-c', folder: '已上线' },
      { id: 3, name: 'c', kind: 'calls', count: 50, addedAt: 3, strategyName: 'S1', strategyId: 'id-b' },
    ];
    const ids = selectBatchIds(withFolder, { level: 'strategy', strategyName: '已上线' });
    assert.deepStrictEqual([...ids].sort(), [1, 2], '按文件夹选中的是挪进去的两个批次，不含没挪的 S1 批次');
  });
}
