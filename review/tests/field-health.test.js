import assert from 'node:assert';
import { collinearityReport } from '../src/lib/proAnalytics.js';
import { scanFieldsForPeaks } from '../src/lib/analytics.js';

const mk = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

export function run(test) {
  test('collinearityReport: 近乎重复的字段应给出极高 VIF，独立字段接近 1', () => {
    let s = 3;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const rows = mk(250, () => { const g = rnd();
      return { returnMax: 1 + rnd() * 5, features: { a: g * 100, dup: g * 100 + rnd() * 0.01, indep: rnd() * 100 } }; });
    const r = collinearityReport(rows, ['a', 'dup', 'indep']);
    const by = Object.fromEntries(r.results.map(x => [x.field, x.vif]));
    assert.ok(by.a > 50 || by.a === Infinity, `重复字段 VIF 应很大，实际 ${by.a}`);
    assert.ok(by.indep < 2, `独立字段 VIF 应接近 1，实际 ${by.indep}`);
  });

  test('collinearityReport: 零方差字段必须先剔除，否则标准化会除零把方程组搞崩', () => {
    let s = 9;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const rows = mk(120, () => ({ returnMax: 1 + rnd(), features: { a: rnd(), b: rnd(), flat: 7 } }));
    const r = collinearityReport(rows, ['a', 'b', 'flat']);
    assert.deepStrictEqual(r.dropped, ['flat']);
    assert.ok(r.results.every(x => Number.isFinite(x.vif)), '剔除后不应出现 NaN/未定义');
  });

  test('collinearityReport: 只用完整个案，样本不足时给出可读错误', () => {
    // 每行都缺一个字段 → 完整个案为 0
    const rows = mk(50, i => ({ returnMax: 1, features: i % 2 ? { a: 1 } : { b: 2 } }));
    const r = collinearityReport(rows, ['a', 'b']);
    assert.ok(r.error && /完整个案/.test(r.error));
    assert.strictEqual(r.n, 0);
  });

  test('scanFieldsForPeaks: 应找出真实的"甜蜜区间"，噪声字段不显著', () => {
    let s = 3;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    // g 落在 0.5~0.75 区间时收益高——这是一个真实存在的中段波峰
    const rows = mk(250, () => { const g = rnd();
      return { returnMax: (g > 0.5 && g < 0.75) ? (2 + rnd() * 10) : (0.3 + rnd() * 1.8),
               features: { sweet: g * 100, noise: rnd() * 100 } }; });
    const r = scanFieldsForPeaks(rows, ['sweet', 'noise'], 'returnMax', 200, 2);
    const by = Object.fromEntries(r.rows.map(x => [x.field, x]));
    assert.ok(by.sweet.adjP < 0.05, `真实波峰应显著，实际 adjP=${by.sweet.adjP}`);
    assert.ok(by.noise.adjP > 0.5, `噪声不应显著，实际 adjP=${by.noise.adjP}`);
    assert.ok(by.sweet.seg, '应给出波峰所在区间');
  });
}
