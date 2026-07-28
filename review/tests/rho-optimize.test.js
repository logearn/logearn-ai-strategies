import assert from 'node:assert';
import { optimizeWeightsForRho } from '../src/lib/factorLab.js';

// 构造确定性样本：good 字段 = returnMax（与目标完全同序），noise 字段与 returnMax 去相关。
// swapBeginTime 递增用于时间分割，但 returnMax 与时间去相关，保证 train/test 都带信号。
function makeRows(n = 80) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ret = ((i * 37) % 100) / 10;    // 0~9.9，伪随机、与 i 顺序基本去相关
    const noise = ((i * 53) % 100) / 10;
    rows.push({
      tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret,
      features: { good: ret, noise },
    });
  }
  return rows;
}
// 区间命中因子 [5, ∞)：值≥5 记满分，否则 0（trapScore 的矩形形态）
const factor = (field, weight) => ({ field, camp: 'hero', weight, lo0: 5, lo1: 5, hi1: Infinity, hi0: Infinity });

export function run(test) {
  test('optimizeWeightsForRho: 把权重推向有效因子，噪声因子被压到 0，train ρ 不降', () => {
    const rows = makeRows();
    const factors = [factor('good', 50), factor('noise', 50)];
    const res = optimizeWeightsForRho(rows, factors, { missingPolicy: 'zero' });
    assert.ok(!res.error, '不应报错：' + res.error);
    const wGood = res.factors.find(f => f.field === 'good').weight;
    const wNoise = res.factors.find(f => f.field === 'noise').weight;
    assert.ok(wGood > wNoise, `good 权重应高于 noise（good=${wGood}, noise=${wNoise}）`);
    assert.ok(res.rhoTrainAfter >= res.rhoTrainBefore - 1e-9, 'train ρ 不应下降');
    assert.ok(res.zeroedFields.includes('noise'), 'noise 应被标记为压到 0');
  });

  test('optimizeWeightsForRho: 优化后 train ρ 优于 50/50 等权（噪声被稀释掉）', () => {
    const rows = makeRows();
    const res = optimizeWeightsForRho(rows, [factor('good', 50), factor('noise', 50)], { missingPolicy: 'zero' });
    assert.ok(res.rhoTrainAfter > res.rhoTrainBefore + 1e-6,
      `应严格提升 train ρ：${res.rhoTrainBefore} → ${res.rhoTrainAfter}`);
  });

  test('optimizeWeightsForRho: 返回 held-out test ρ 前后值（用于过拟合判断）', () => {
    const rows = makeRows();
    const res = optimizeWeightsForRho(rows, [factor('good', 50), factor('noise', 50)], { missingPolicy: 'zero' });
    assert.ok(Number.isFinite(res.rhoTestBefore) && Number.isFinite(res.rhoTestAfter));
    assert.ok(res.nTrain > 0 && res.nTest > 0);
  });

  test('optimizeWeightsForRho: 少于 2 个因子应返回 error 而不是抛异常', () => {
    const rows = makeRows();
    const res = optimizeWeightsForRho(rows, [factor('good', 100)], { missingPolicy: 'zero' });
    assert.ok(res.error);
  });

  test('optimizeWeightsForRho: 归一化后权重和≈100', () => {
    const rows = makeRows();
    const res = optimizeWeightsForRho(rows, [factor('good', 50), factor('noise', 50)], { missingPolicy: 'zero' });
    const sum = res.factors.reduce((a, f) => a + f.weight, 0);
    assert.ok(Math.abs(sum - 100) < 1, `权重和应≈100，实际 ${sum}`);
  });
}
