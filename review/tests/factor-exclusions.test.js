import assert from 'node:assert';
import { excludeFactor, unexcludeFactor, isFactorExcluded, filterExcluded,
         restoreAllExcluded, sortExclusionsByRecency } from '../src/lib/factorExclusions.js';

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

  test('restoreAllExcluded: 一键恢复只清空指定阵营，不影响另一阵营', () => {
    let list = excludeFactor([], { camp: 'hero', field: 'a' });
    list = excludeFactor(list, { camp: 'hero', field: 'b' });
    list = excludeFactor(list, { camp: 'evil', field: 'c' });
    const next = restoreAllExcluded(list, 'hero');
    assert.strictEqual(next.length, 1);
    assert.strictEqual(next[0].field, 'c');
    assert.strictEqual(next[0].camp, 'evil');
  });

  test('restoreAllExcluded: 该阵营本来就没有排除项时应原样返回空结果，不报错', () => {
    const list = excludeFactor([], { camp: 'evil', field: 'x' });
    assert.deepStrictEqual(restoreAllExcluded(list, 'hero'), list, '恢复一个没有排除项的阵营不该动到别的阵营');
  });

  test('sortExclusionsByRecency: 按排除时间新→旧排序，最近排除的排最前', () => {
    const list = [
      { camp: 'hero', field: 'old', excludedAt: 1000 },
      { camp: 'hero', field: 'newest', excludedAt: 3000 },
      { camp: 'hero', field: 'mid', excludedAt: 2000 },
    ];
    const sorted = sortExclusionsByRecency(list);
    assert.deepStrictEqual(sorted.map(x => x.field), ['newest', 'mid', 'old']);
  });

  test('sortExclusionsByRecency: 不改动原数组（返回新数组）', () => {
    const list = [{ camp: 'hero', field: 'a', excludedAt: 1 }, { camp: 'hero', field: 'b', excludedAt: 2 }];
    const original = [...list];
    sortExclusionsByRecency(list);
    assert.deepStrictEqual(list, original, '排序不该 mutate 传入的原数组');
  });

  test('sortExclusionsByRecency: 真实场景——先排除 a 再排除 b，b(更晚)应排在 a 前面', () => {
    let list = excludeFactor([], { camp: 'hero', field: 'a' });
    // 模拟时间流逝：确保第二条的 excludedAt 严格更大（真实场景里 Date.now() 两次调用间隔够长）
    list = list.map(x => ({ ...x, excludedAt: 1000 }));
    list = excludeFactor(list, { camp: 'hero', field: 'b' }).map(x => x.field === 'b' ? { ...x, excludedAt: 2000 } : x);
    const sorted = sortExclusionsByRecency(list);
    assert.deepStrictEqual(sorted.map(x => x.field), ['b', 'a'], '后排除的 b 应该排在先排除的 a 前面');
  });
}
