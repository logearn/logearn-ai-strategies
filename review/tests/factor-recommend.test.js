import assert from 'node:assert';
import { recommendFactorPath } from '../src/lib/factorLab.js';

function mkRows(n = 120) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ret = ((i * 37) % 100) / 10; // 0~9.9，与 i 顺序去相关
    rows.push({ tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret,
      features: { good: ret, noise: ((i * 53) % 100) / 10 } });
  }
  return rows;
}
const cands = [
  { field: 'good', camp: 'hero', auc: 0.9, direction: 'high', interval: { lo: 5, hi: Infinity } },
  { field: 'noise', camp: 'hero', auc: 0.52, direction: 'high', interval: { lo: 5, hi: Infinity } },
];

export function run(test) {
  test('recommendFactorPath: 从零(探索)应先推有效因子，held-out Δρ 为正', () => {
    const r = recommendFactorPath(mkRows(), [], cands, { threshold: 5, missingPolicy: 'zero' });
    assert.ok(r.path.length >= 1, '至少推一个');
    assert.strictEqual(r.path[0].field, 'good', '第一个应是有效因子');
    assert.ok(r.path[0].deltaTest > 0, 'held-out Δρ 应为正');
    assert.ok(r.nTrain > 0 && r.nTest > 0);
  });

  test('recommendFactorPath: 噪声因子不该被推进路径', () => {
    const r = recommendFactorPath(mkRows(), [], cands, { threshold: 5, missingPolicy: 'zero' });
    assert.ok(!r.path.some(p => p.field === 'noise'), 'noise 不应入选');
  });

  test('recommendFactorPath: 组合模式——good 已在池里时，不再重复推荐它', () => {
    const rows = mkRows();
    // 起点池含 good（构造一个最简因子对象；recommend 只看 camp+field 去重）
    const start = [{ field: 'good', camp: 'hero', weight: 100, lo0: -Infinity, lo1: 5, hi1: Infinity, hi0: Infinity }];
    const r = recommendFactorPath(rows, start, cands, { threshold: 5, missingPolicy: 'zero' });
    assert.ok(!r.path.some(p => p.field === 'good'), '已在池里的不重复推');
  });

  test('recommendFactorPath: 无可用候选(无区间)时给出 error，不抛异常', () => {
    const r = recommendFactorPath(mkRows(), [], [{ field: 'x', camp: 'hero', interval: null }], { threshold: 5 });
    assert.ok(r.error);
    assert.strictEqual(r.path.length, 0);
  });
}
