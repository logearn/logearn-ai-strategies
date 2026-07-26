import assert from 'node:assert';
import { addHidden, removeHidden, filterHidden } from '../src/lib/tableHiddenFields.js';

export function run(test) {
  test('addHidden: 加入且去重', () => {
    assert.deepStrictEqual(addHidden([], 'a'), ['a']);
    assert.deepStrictEqual(addHidden(['a'], 'b'), ['a', 'b']);
    assert.deepStrictEqual(addHidden(['a'], 'a'), ['a'], '重复不再加');
  });

  test('removeHidden: 移除指定字段', () => {
    assert.deepStrictEqual(removeHidden(['a', 'b'], 'a'), ['b']);
    assert.deepStrictEqual(removeHidden(['a'], 'x'), ['a'], '不存在原样返回');
  });

  test('filterHidden: 按字段滤掉隐藏行（默认 r.field，可自定义取键）', () => {
    const rows = [{ field: 'a' }, { field: 'b' }, { field: 'c' }];
    assert.deepStrictEqual(filterHidden(rows, ['b']).map(r => r.field), ['a', 'c']);
    assert.deepStrictEqual(filterHidden(rows, []), rows, '无隐藏原样返回');
    const corr = [{ feature: 'x' }, { feature: 'y' }];
    assert.deepStrictEqual(filterHidden(corr, ['x'], r => r.feature).map(r => r.feature), ['y']);
  });
}
