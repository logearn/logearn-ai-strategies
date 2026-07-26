import assert from 'node:assert';
import { loadLabels, setLabel, getLabel, applyLabels, junkList, JUNK_RETURN } from '../src/lib/labels.js';

const R = (ca, ret) => ({ id: ca, tokenAddress: ca, symbol: ca, returnMax: ret, features: {} });

export function run(test) {
  test('setLabel/getLabel: 大小写不敏感，传空清除', () => {
    let L = {};
    L = setLabel(L, 'ABC', 'junk');
    assert.strictEqual(getLabel(L, 'abc'), 'junk', 'CA 匹配应大小写不敏感');
    L = setLabel(L, 'abc', null);
    assert.strictEqual(getLabel(L, 'ABC'), null, '传空应清除');
  });

  test('applyLabels: junk 应把 returnMax 降级成保本，原值留在 returnMaxRaw', () => {
    // 核心场景：一个 10x 的扎针，人工标垃圾后不能再算作赢家
    const rows = [R('CA1', 10), R('CA2', 3)];
    const L = setLabel({}, 'CA1', 'junk');
    const out = applyLabels(rows, L);
    assert.strictEqual(out[0].returnMax, JUNK_RETURN, 'junk 的 returnMax 应降级');
    assert.strictEqual(out[0].returnMaxRaw, 10, '原值应保留');
    assert.strictEqual(out[0].label, 'junk');
    assert.strictEqual(out[1].returnMax, 3, '没标的不动');
  });

  test('applyLabels: junk 降级后不再算作赢家（>2x）', () => {
    const rows = [R('CA1', 10)];
    const out = applyLabels(rows, setLabel({}, 'CA1', 'junk'));
    assert.ok(out[0].returnMax <= 2, '降级后应 ≤2x，不再是赢家');
  });

  test('applyLabels: good 只标注不改 returnMax', () => {
    const rows = [R('CA1', 8)];
    const out = applyLabels(rows, setLabel({}, 'CA1', 'good'));
    assert.strictEqual(out[0].returnMax, 8, 'good 不改收益');
    assert.strictEqual(out[0].label, 'good');
  });

  test('applyLabels: 不改动原数组', () => {
    const rows = [R('CA1', 10)];
    applyLabels(rows, setLabel({}, 'CA1', 'junk'));
    assert.strictEqual(rows[0].returnMax, 10, '原数组不应被改');
  });

  test('junkList: 只返回 junk 的 CA', () => {
    let L = {};
    L = setLabel(L, 'A', 'junk'); L = setLabel(L, 'B', 'good'); L = setLabel(L, 'C', 'junk');
    assert.deepStrictEqual(junkList(L).sort(), ['a', 'c']);
  });
}
