import assert from 'node:assert';
import { dayOf, groupRowsByDay, strategyOf, groupRowsByStrategyAndDay, sliceKeyOf, categoryOfDay,
         assignDays, dayInRange, daysInRange, selectRowsBySlice, summarizeSlices, UNKNOWN_DAY,
         loadDeletedDays, saveDeletedDays, filterDeletedRows } from '../src/lib/dataSlices.js';

// Node 测试环境没有 localStorage，loadDeletedDays/saveDeletedDays 全部逻辑都是围绕它做 I/O，
// 用一份最小内存实现顶上（跟 factor-pool-store.test.js 同一个套路）。
class MemoryStorage {
  constructor() { this.store = new Map(); }
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }
  setItem(k, v) { this.store.set(k, String(v)); }
  removeItem(k) { this.store.delete(k); }
  clear() { this.store.clear(); }
}

// 用本地时区构造某天中午的 buyTimestamp（秒），避免 UTC 跨天
const tsOf = (y, m, d) => Math.floor(new Date(y, m - 1, d, 12, 0, 0).getTime() / 1000);
// 默认带 strategyName:'S1'——新版 selectRowsBySlice/summarizeSlices 都按样本自带的 strategyName 归类，
// 不再靠调用方传入的全局 strategyKey。
const row = (y, m, d, extra = {}) => ({ buyTimestamp: tsOf(y, m, d), strategyName: 'S1', ...extra });

export function run(test) {
  test('dayOf: 秒级 buyTimestamp → 本地日历日；非法值 → null', () => {
    assert.strictEqual(dayOf(tsOf(2026, 7, 25)), '2026-07-25');
    assert.strictEqual(dayOf(null), null);
    assert.strictEqual(dayOf(NaN), null);
  });

  test('groupRowsByDay: 按天分组、日期升序、未知日排最后', () => {
    const rows = [row(2026, 7, 25), row(2026, 7, 24), row(2026, 7, 25), { buyTimestamp: null }];
    const g = groupRowsByDay(rows);
    assert.deepStrictEqual(g, [
      { day: '2026-07-24', count: 1 },
      { day: '2026-07-25', count: 2 },
      { day: UNKNOWN_DAY, count: 1 },
    ]);
  });

  test('assignDays / categoryOfDay: 互斥归类，每策略各一套，cat=null 移出', () => {
    let map = {};
    map = assignDays(map, 'S1', ['2026-07-24', '2026-07-25'], 'train');
    map = assignDays(map, 'S1', ['2026-07-26'], 'baseline');
    assert.strictEqual(categoryOfDay(map, 'S1', '2026-07-24'), 'train');
    assert.strictEqual(categoryOfDay(map, 'S1', '2026-07-26'), 'baseline');
    // 互斥：改成 baseline 会覆盖 train
    map = assignDays(map, 'S1', ['2026-07-24'], 'baseline');
    assert.strictEqual(categoryOfDay(map, 'S1', '2026-07-24'), 'baseline');
    // 每策略隔离：S2 的同一天不受影响
    assert.strictEqual(categoryOfDay(map, 'S2', '2026-07-24'), null);
    // 移出
    map = assignDays(map, 'S1', ['2026-07-24'], null);
    assert.strictEqual(categoryOfDay(map, 'S1', '2026-07-24'), null);
  });

  test('assignDays: 未知日不参与归类', () => {
    const map = assignDays({}, 'S1', [UNKNOWN_DAY], 'train');
    assert.strictEqual(categoryOfDay(map, 'S1', UNKNOWN_DAY), null);
    assert.deepStrictEqual(map, {});
  });

  test('strategyOf: 没 strategyName 就归到「未命名策略」，跟数据源管理归档树同口径', () => {
    assert.strictEqual(strategyOf({ strategyName: '1.5段策略' }), '1.5段策略');
    assert.strictEqual(strategyOf({ strategyName: '' }), '未命名策略');
    assert.strictEqual(strategyOf({}), '未命名策略');
  });

  test('groupRowsByStrategyAndDay: 先按策略（样本数降序）再按天（日期升序）分组', () => {
    const rows = [
      row(2026, 7, 24, { strategyName: 'A' }), row(2026, 7, 25, { strategyName: 'A' }),
      row(2026, 7, 24, { strategyName: 'B' }), row(2026, 7, 24, { strategyName: 'B' }), row(2026, 7, 25, { strategyName: 'B' }),
    ];
    const groups = groupRowsByStrategyAndDay(rows);
    assert.deepStrictEqual(groups.map(g => g.strategyName), ['B', 'A']);
    assert.strictEqual(groups[0].count, 3);
    assert.deepStrictEqual(groups[0].days, [{ day: '2026-07-24', count: 2 }, { day: '2026-07-25', count: 1 }]);
    assert.deepStrictEqual(groups[1].days, [{ day: '2026-07-24', count: 1 }, { day: '2026-07-25', count: 1 }]);
  });

  test('dayInRange / daysInRange: 闭区间，字典序，未知日永不入', () => {
    assert.strictEqual(dayInRange('2026-07-25', '2026-07-24', '2026-07-26'), true);
    assert.strictEqual(dayInRange('2026-07-23', '2026-07-24', '2026-07-26'), false);
    assert.strictEqual(dayInRange(UNKNOWN_DAY, null, null), false);
    const rows = [row(2026, 7, 23), row(2026, 7, 24), row(2026, 7, 25), row(2026, 7, 26)];
    assert.deepStrictEqual(daysInRange(rows, '2026-07-24', '2026-07-25'), ['2026-07-24', '2026-07-25']);
  });

  test('selectRowsBySlice: all / day / range / 类别 各口径（按样本自带 strategyName 归类）', () => {
    const rows = [row(2026, 7, 24, { id: 'a' }), row(2026, 7, 25, { id: 'b' }), row(2026, 7, 26, { id: 'c' })];
    const map = assignDays(assignDays({}, 'S1', ['2026-07-24'], 'train'), 'S1', ['2026-07-26'], 'baseline');
    assert.strictEqual(selectRowsBySlice(rows, map, { mode: 'all' }).length, 3);
    assert.deepStrictEqual(selectRowsBySlice(rows, map, { mode: 'day', day: '2026-07-25' }).map(r => r.id), ['b']);
    assert.deepStrictEqual(selectRowsBySlice(rows, map, { mode: 'range', start: '2026-07-25', end: '2026-07-26' }).map(r => r.id), ['b', 'c']);
    assert.deepStrictEqual(selectRowsBySlice(rows, map, { mode: 'train' }).map(r => r.id), ['a']);
    assert.deepStrictEqual(selectRowsBySlice(rows, map, { mode: 'baseline' }).map(r => r.id), ['c']);
  });

  test('selectRowsBySlice: day 模式带 strategyName 只要该策略那天的，不会串策略', () => {
    const rows = [row(2026, 7, 24, { id: 'a', strategyName: 'A' }), row(2026, 7, 24, { id: 'b', strategyName: 'B' })];
    assert.deepStrictEqual(selectRowsBySlice(rows, {}, { mode: 'day', day: '2026-07-24', strategyName: 'A' }).map(r => r.id), ['a']);
    assert.deepStrictEqual(selectRowsBySlice(rows, {}, { mode: 'day', day: '2026-07-24' }).map(r => r.id), ['a', 'b']);
  });

  test('selectRowsBySlice: 多策略混在一起时，基准库/训练集归类互不干扰', () => {
    const rows = [
      row(2026, 7, 24, { id: 'a', strategyName: 'A' }), row(2026, 7, 24, { id: 'b', strategyName: 'B' }),
    ];
    // 同一天，A 归训练集，B 归基准库——结果不能互相污染
    const map = assignDays(assignDays({}, 'A', ['2026-07-24'], 'train'), 'B', ['2026-07-24'], 'baseline');
    assert.deepStrictEqual(selectRowsBySlice(rows, map, { mode: 'train' }).map(r => r.id), ['a']);
    assert.deepStrictEqual(selectRowsBySlice(rows, map, { mode: 'baseline' }).map(r => r.id), ['b']);
  });

  test('selectRowsBySlice: 未选择（none）/ 缺省 sel → 不出数据，逼用户先选分析范围', () => {
    const rows = [row(2026, 7, 24, { id: 'a' })];
    assert.strictEqual(selectRowsBySlice(rows, {}, { mode: 'none' }).length, 0);
    assert.strictEqual(selectRowsBySlice(rows, {}, null).length, 0);
    assert.strictEqual(selectRowsBySlice(rows, {}, undefined).length, 0);
  });

  test('summarizeSlices: 先按策略分组，每组再按天带类别 + 各自/全局汇总', () => {
    const rows = [
      row(2026, 7, 24, { strategyName: 'A' }), row(2026, 7, 24, { strategyName: 'A' }), row(2026, 7, 25, { strategyName: 'A' }),
      row(2026, 7, 26, { strategyName: 'B' }),
    ];
    const map = assignDays({}, 'A', ['2026-07-24'], 'train');
    const { strategies, tally } = summarizeSlices(rows, map);
    const a = strategies.find(s => s.strategyName === 'A');
    const b = strategies.find(s => s.strategyName === 'B');
    assert.strictEqual(a.days.find(d => d.day === '2026-07-24').category, 'train');
    assert.strictEqual(a.days.find(d => d.day === '2026-07-25').category, null);
    assert.deepStrictEqual(a.tally.train, { days: 1, count: 2 });
    assert.deepStrictEqual(b.tally.unassigned, { days: 1, count: 1 });
    // 全局 tally 跨策略汇总
    assert.deepStrictEqual(tally.train, { days: 1, count: 2 });
    assert.deepStrictEqual(tally.unassigned, { days: 2, count: 2 });
    assert.deepStrictEqual(tally.baseline, { days: 0, count: 0 });
  });

  test('loadDeletedDays/saveDeletedDays: 持久化往返 + 异常兜底', () => {
    const original = globalThis.localStorage;
    const mem = new MemoryStorage();
    globalThis.localStorage = mem;

    assert.deepStrictEqual(loadDeletedDays(), []);
    saveDeletedDays(['S1|2026-07-22']);
    assert.deepStrictEqual(loadDeletedDays(), ['S1|2026-07-22']);
    mem.setItem('review_slice_deleted_v1', '{not valid json');
    assert.deepStrictEqual(loadDeletedDays(), []);

    globalThis.localStorage = original;
  });

  test('filterDeletedRows: 按【策略×天】名单剔除样本，删除是持久性的，重新分析也过滤得掉', () => {
    const rows = [
      row(2026, 7, 22, { id: 'a', strategyName: 'A' }),
      row(2026, 7, 23, { id: 'b', strategyName: 'A' }),
      row(2026, 7, 22, { id: 'c', strategyName: 'B' }),
    ];
    // 只删 A 策略的 2026-07-22，B 策略同一天不受影响
    const deleted = [sliceKeyOf('A', '2026-07-22')];
    assert.deepStrictEqual(filterDeletedRows(rows, deleted).map(r => r.id), ['b', 'c']);
    assert.deepStrictEqual(filterDeletedRows(rows, []), rows);
    assert.deepStrictEqual(filterDeletedRows(rows, null), rows);
  });
}
