import assert from 'node:assert';
import { excludeFactor, unexcludeFactor, isFactorExcluded, filterExcluded } from '../src/lib/factorExclusions.js';

export function run(test) {
  test('excludeFactor: 加入排除清单，重复排除同一 camp+field 不产生重复条目', () => {
    let list = excludeFactor([], { camp: 'hero', field: 'shit_volume' });
    assert.strictEqual(list.length, 1);
    list = excludeFactor(list, { camp: 'hero', field: 'shit_volume' });
    assert.strictEqual(list.length, 1, '重复排除同一项不应产生第二条');
  });

  test('excludeFactor: 同一字段在不同阵营各自独立，互不影响', () => {
    let list = excludeFactor([], { camp: 'hero', field: 'x' });
    list = excludeFactor(list, { camp: 'evil', field: 'x' });
    assert.strictEqual(list.length, 2, '同一字段两个阵营应各占一条');
    assert.ok(isFactorExcluded(list, 'hero', 'x'));
    assert.ok(isFactorExcluded(list, 'evil', 'x'));
  });

  test('unexcludeFactor: 按 camp+field 精确移出排除清单，不影响其它条目', () => {
    let list = excludeFactor([], { camp: 'hero', field: 'a' });
    list = excludeFactor(list, { camp: 'hero', field: 'b' });
    list = unexcludeFactor(list, { camp: 'hero', field: 'a' });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].field, 'b');
  });

  test('isFactorExcluded: 未排除的字段应返回 false', () => {
    const list = excludeFactor([], { camp: 'hero', field: 'a' });
    assert.strictEqual(isFactorExcluded(list, 'hero', 'z'), false);
    assert.strictEqual(isFactorExcluded(list, 'evil', 'a'), false, '阵营不对也不算排除');
  });

  test('filterExcluded: 字符串数组（扫描前过滤候选字段名）应按 camp 剔除已排除的', () => {
    const fields = ['a', 'b', 'c'];
    const exclusions = excludeFactor([], { camp: 'hero', field: 'b' });
    assert.deepStrictEqual(filterExcluded(fields, exclusions, 'hero'), ['a', 'c']);
    assert.deepStrictEqual(filterExcluded(fields, exclusions, 'evil'), ['a', 'b', 'c'], '邪恶阵营没排除过，应原样保留');
  });

  test('filterExcluded: 候选对象数组（扫描后过滤候选表）应按 getField 取字段名剔除', () => {
    const candidates = [{ field: 'a', auc: 0.6 }, { field: 'b', auc: 0.7 }];
    const exclusions = excludeFactor([], { camp: 'hero', field: 'a' });
    const kept = filterExcluded(candidates, exclusions, 'hero', c => c.field);
    assert.deepStrictEqual(kept.map(c => c.field), ['b']);
  });

  test('filterExcluded: 排除清单为空时应原样返回（不做无意义的数组拷贝判断影响正确性）', () => {
    const fields = ['a', 'b'];
    assert.deepStrictEqual(filterExcluded(fields, [], 'hero'), fields);
  });
}
