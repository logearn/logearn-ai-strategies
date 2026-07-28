import assert from 'node:assert';
import { isNumericLike } from '../src/lib/dataHelpers.js';

const row = (features) => ({ features });

export function run(test) {
  test('isNumericLike: 全部有效值都是数字应返回 true', () => {
    const rows = [row({ f: 1 }), row({ f: 2.5 }), row({ f: '3' })];
    assert.strictEqual(isNumericLike(rows, 'f'), true, '数字字符串也应算数值型');
  });

  test('isNumericLike: 出现一个非数值就应返回 false', () => {
    const rows = [row({ f: 1 }), row({ f: 'abc' }), row({ f: 2 })];
    assert.strictEqual(isNumericLike(rows, 'f'), false);
  });

  test('isNumericLike: undefined/null/空字符串应跳过，不计入判定', () => {
    const rows = [row({ f: undefined }), row({ f: null }), row({ f: '' }), row({ f: 5 })];
    assert.strictEqual(isNumericLike(rows, 'f'), true, '唯一一个有效值是数字，应判定为数值型');
  });

  test('isNumericLike: 所有值都缺失（没有任何有效值）应返回 false', () => {
    const rows = [row({}), row({ f: undefined }), row({ f: null })];
    assert.strictEqual(isNumericLike(rows, 'f'), false);
  });

  test('isNumericLike: 空行数组应返回 false', () => {
    assert.strictEqual(isNumericLike([], 'f'), false);
  });

  test('isNumericLike: returnMax 这类行级字段（不在 features 里）也应正确判定', () => {
    const rows = [{ returnMax: 1.2, features: {} }, { returnMax: 3.4, features: {} }];
    assert.strictEqual(isNumericLike(rows, 'returnMax'), true);
  });
}
