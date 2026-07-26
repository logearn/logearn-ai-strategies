import assert from 'node:assert';
import { compareGroups } from '../src/lib/compare.js';

const rows = arr => arr.map((v, i) => ({ id: i, returnMax: v }));

export function run(test) {
  test('compareGroups: 应给出中位数和各档胜率对比', () => {
    const a = rows([1, 1.5, 2.5, 3, 8]);
    const b = rows([0.5, 0.8, 1.2, 1.5, 2.1]);
    const r = compareGroups(a, b, { labelA: '旧', labelB: '新' });
    assert.strictEqual(r.nA, 5);
    assert.strictEqual(r.medianA, 2.5);
    assert.strictEqual(r.medianB, 1.2);
    assert.ok(r.medianDiff < 0, '新组更差，差值应为负');
    const w2 = r.rates.find(x => x.threshold === 2);
    assert.strictEqual(w2.kA, 3);
    assert.strictEqual(w2.kB, 1);
  });

  test('compareGroups: 小样本应标记检验能力不足，而不是给一个虚假的显著结论', () => {
    // 12 vs 12 条，即使胜率看着差一截，也远达不到可检出的差异
    const a = rows([1, 1, 1, 1, 1, 1, 3, 3, 3, 3, 3, 3]);
    const b = rows([1, 1, 1, 1, 1, 1, 1, 3, 3, 3, 3, 3]);
    const r = compareGroups(a, b);
    assert.ok(Number.isFinite(r.mde), '应算出 MDE');
    assert.ok(r.mde > 0.2, `小样本的 MDE 应该很大，实际 ${r.mde}`);
    assert.strictEqual(r.underpowered, true, '观察到的差异小于 MDE，应标记为看不出来');
  });

  test('compareGroups: 差异足够大且样本足够时不应误标为能力不足', () => {
    const a = rows(Array.from({ length: 200 }, (_, i) => (i < 20 ? 5 : 1)));   // 10% 胜率
    const b = rows(Array.from({ length: 200 }, (_, i) => (i < 160 ? 5 : 1)));  // 80% 胜率
    const r = compareGroups(a, b);
    assert.strictEqual(r.underpowered, false);
    assert.ok(r.rates[0].p < 0.001, '这么大的差异应当显著');
  });

  test('compareGroups: 空组应返回错误而不是崩溃', () => {
    assert.ok(compareGroups([], rows([1, 2])).error);
    assert.ok(compareGroups(rows([1, 2]), []).error);
  });

  test('compareGroups: 胜率应带 Wilson 区间', () => {
    const r = compareGroups(rows([5, 5, 5]), rows([1, 1, 1]));
    const w = r.rates[0];
    assert.ok(w.ciA.lo > 0 && w.ciA.lo < 1, '3/3 的下界应在 (0,1) 内而不是 1');
    assert.ok(w.ciB.hi > 0, '0/3 的上界应大于 0');
  });
}
