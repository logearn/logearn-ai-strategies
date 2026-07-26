import assert from 'node:assert';
import { applyFilter, normalizeConditions, rowMatches } from '../src/lib/filter.js';

const R = (i, f) => ({ id: 'i' + i, symbol: 'S' + i, tokenAddress: 'CA' + i, returnMax: 1 + i, features: f });

export function run(test) {
  test('applyFilter: 多条件之间是与关系', () => {
    const rows = [R(0, { a: 10, b: 1 }), R(1, { a: 10, b: 9 }), R(2, { a: 1, b: 9 })];
    const r = applyFilter(rows, [{ field: 'a', op: '>=', threshold: '5' }, { field: 'b', op: '>=', threshold: '5' }]);
    assert.deepStrictEqual(r.rows.map(x => x.id), ['i1']);
  });

  test('applyFilter: 字段缺值应不命中，不能当成 0', () => {
    // "没有这个数据"和"这个数据是 0"在筛选语义上完全不同
    const rows = [R(0, { a: 0 }), R(1, {}), R(2, { a: null })];
    const r = applyFilter(rows, [{ field: 'a', op: '<=', threshold: '1' }]);
    assert.deepStrictEqual(r.rows.map(x => x.id), ['i0'], '只有真的等于 0 的那条命中');
  });

  test('applyFilter: 没有有效条件时应返回全量而不是空集', () => {
    const rows = [R(0, { a: 1 }), R(1, { a: 2 })];
    assert.strictEqual(applyFilter(rows, []).rows.length, 2);
    assert.strictEqual(applyFilter(rows, [{ field: '', op: '>=', threshold: '1' }]).rows.length, 2);
    assert.strictEqual(applyFilter(rows, [{ field: 'a', op: '>=', threshold: '' }]).rows.length, 2, '阈值为空的条件应被忽略');
  });

  test('normalizeConditions: 应分类记账被忽略的原因', () => {
    const r = normalizeConditions(
      [{ field: 'good', threshold: '1' }, { field: 'bogus', threshold: '1' }, { field: 'good', threshold: '' }, { field: '' }],
      f => f === 'good');
    assert.strictEqual(r.conditions.length, 1);
    assert.deepStrictEqual(r.invalidFields, ['bogus'], '字段名不存在');
    assert.deepStrictEqual(r.emptyThresholds, ['good'], '阈值为空');
  });

  test('rowMatches: 字符串字段支持包含/不包含', () => {
    const row = R(0, { sym: 'PumpFun' });
    assert.ok(rowMatches(row, [{ field: 'sym', op: 'contains', threshold: 'pump' }]), '应大小写不敏感');
    assert.ok(!rowMatches(row, [{ field: 'sym', op: 'not_contains', threshold: 'pump' }]));
    // 非数字字段用 > < 无意义，应不命中而不是抛错
    assert.ok(!rowMatches(row, [{ field: 'sym', op: '>', threshold: '5' }]));
  });

  test('applyFilter: 应算出命中集的平均 returnMax，空集时为 null', () => {
    const rows = [R(0, { a: 9 }), R(1, { a: 9 })];  // returnMax = 1, 2
    const r = applyFilter(rows, [{ field: 'a', op: '>=', threshold: '1' }]);
    assert.strictEqual(r.avgReturn, 1.5);
    assert.strictEqual(applyFilter(rows, [{ field: 'a', op: '>', threshold: '999' }]).avgReturn, null);
  });
}
