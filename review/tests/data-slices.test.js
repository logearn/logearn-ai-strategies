import assert from 'node:assert';
import { dayOf, groupRowsByDay, sliceKeyOf, categoryOfDay, assignDays, dayInRange,
         daysInRange, selectRowsBySlice, summarizeSlices, UNKNOWN_DAY } from '../src/lib/dataSlices.js';

// 用本地时区构造某天中午的 buyTimestamp（秒），避免 UTC 跨天
const tsOf = (y, m, d) => Math.floor(new Date(y, m - 1, d, 12, 0, 0).getTime() / 1000);
const row = (y, m, d, extra = {}) => ({ buyTimestamp: tsOf(y, m, d), ...extra });

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

  test('dayInRange / daysInRange: 闭区间，字典序，未知日永不入', () => {
    assert.strictEqual(dayInRange('2026-07-25', '2026-07-24', '2026-07-26'), true);
    assert.strictEqual(dayInRange('2026-07-23', '2026-07-24', '2026-07-26'), false);
    assert.strictEqual(dayInRange(UNKNOWN_DAY, null, null), false);
    const rows = [row(2026, 7, 23), row(2026, 7, 24), row(2026, 7, 25), row(2026, 7, 26)];
    assert.deepStrictEqual(daysInRange(rows, '2026-07-24', '2026-07-25'), ['2026-07-24', '2026-07-25']);
  });

  test('selectRowsBySlice: all / day / range / 类别 各口径', () => {
    const rows = [row(2026, 7, 24, { id: 'a' }), row(2026, 7, 25, { id: 'b' }), row(2026, 7, 26, { id: 'c' })];
    const map = assignDays(assignDays({}, 'S1', ['2026-07-24'], 'train'), 'S1', ['2026-07-26'], 'baseline');
    assert.strictEqual(selectRowsBySlice(rows, 'S1', map, { mode: 'all' }).length, 3);
    assert.deepStrictEqual(selectRowsBySlice(rows, 'S1', map, { mode: 'day', day: '2026-07-25' }).map(r => r.id), ['b']);
    assert.deepStrictEqual(selectRowsBySlice(rows, 'S1', map, { mode: 'range', start: '2026-07-25', end: '2026-07-26' }).map(r => r.id), ['b', 'c']);
    assert.deepStrictEqual(selectRowsBySlice(rows, 'S1', map, { mode: 'train' }).map(r => r.id), ['a']);
    assert.deepStrictEqual(selectRowsBySlice(rows, 'S1', map, { mode: 'baseline' }).map(r => r.id), ['c']);
  });

  test('summarizeSlices: 每天带类别 + 各桶天数/样本数汇总', () => {
    const rows = [row(2026, 7, 24), row(2026, 7, 24), row(2026, 7, 25), row(2026, 7, 26)];
    const map = assignDays({}, 'S1', ['2026-07-24'], 'train');
    const { days, tally } = summarizeSlices(rows, 'S1', map);
    assert.strictEqual(days.find(d => d.day === '2026-07-24').category, 'train');
    assert.strictEqual(days.find(d => d.day === '2026-07-25').category, null);
    assert.deepStrictEqual(tally.train, { days: 1, count: 2 });
    assert.deepStrictEqual(tally.unassigned, { days: 2, count: 2 });
    assert.deepStrictEqual(tally.baseline, { days: 0, count: 0 });
  });
}
