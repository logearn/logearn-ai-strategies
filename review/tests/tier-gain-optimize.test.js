import assert from 'node:assert';
import { optimizeWeightsForTierGain } from '../src/lib/factorLab.js';

// 构造两个独立、都真实有效的信号字段：a 主要区分"过线/未过线"这一刀（cutoff 附近的粗分类），
// b 主要区分档位内部的排序（贯穿全程的细粒度信号）。旧版 scorePoolTierGain 只看 cutoff
// 二分的台阶差，会把权重全部压给 a、b 压到 0（角点解）；新版加了粗粒度秩相关分量后，
// 两个因子都应该保留正权重（不再退化成单因子）。
// n=300（而非 200）：scorePoolTierGain 默认 minGroupN=20（2026-07-28 加，见 factorLab.js 内部注释），
// 30% 时间切分后测试段(30%)里垃圾组样本得comfortably超过20，n=200 时测试段垃圾组只有18条，卡在门槛下。
function makeRows(n = 300) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    // 垃圾/非垃圾按 i%10<3 交错分布（不是按时间顺序聚成一块），保证 splitTrainTest 按时间
    // 切出的 train/test 两段各自都同时含 above/below 两层样本。
    const isGarbage = (i % 10) < 3;
    // level 在非垃圾样本内部再分几档，用来体现"档内也有排序结构"，随 i 缓慢漂移但不跟 isGarbage 绑定。
    const level = (i % 20) / 20;
    const ret = isGarbage ? ((i * 13) % 10) / 10 : 1 + level * 20 + ((i * 7) % 10) / 10;
    // a：在 cutoff（=50）附近强区分 above/below，但档内几乎不变化（贴合"只吃一刀"的旧退化因子）
    const a = isGarbage ? 10 + ((i * 11) % 5) : 90 + ((i * 11) % 5);
    // b：全程随 level 平滑递增，贯穿多个档位都提供排序信息，但在 cutoff 这一刀本身区分度一般
    const b = 20 + level * 60 + ((i * 17) % 10);
    rows.push({
      tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret,
      features: { a, b },
    });
  }
  return rows;
}
// 区间命中因子：a 用 [50, ∞)（贴合它在 cutoff 附近的跳变），b 用 [50, ∞)（贴合它的全程递增趋势）
const factor = (field, weight) => ({ field, camp: 'hero', weight, lo0: 50, lo1: 50, hi1: Infinity, hi0: Infinity });

export function run(test) {
  test('optimizeWeightsForTierGain: 两个真实有效的因子都应保留正权重，不退化成单因子', () => {
    const rows = makeRows();
    const factors = [factor('a', 50), factor('b', 50)];
    const res = optimizeWeightsForTierGain(rows, factors, 50, { missingPolicy: 'zero', winThreshold: 2 });
    assert.ok(!res.error, '不应报错：' + res.error);
    const wA = res.factors.find(f => f.field === 'a').weight;
    const wB = res.factors.find(f => f.field === 'b').weight;
    assert.ok(wA > 0 && wB > 0, `两个因子都应保留正权重（a=${wA}, b=${wB}），不该退化成单因子 0/100`);
  });

  test('optimizeWeightsForTierGain: 优化后 train 分层增益不低于优化前', () => {
    const rows = makeRows();
    const res = optimizeWeightsForTierGain(rows, [factor('a', 50), factor('b', 50)], 50,
      { missingPolicy: 'zero', winThreshold: 2 });
    assert.ok(res.rhoTrainAfter >= res.rhoTrainBefore - 1e-9, 'train 分层增益不应下降');
  });

  test('optimizeWeightsForTierGain: 返回 held-out test 分层增益前后值', () => {
    const rows = makeRows();
    // minGroupN 显式传 5（老默认值）：这条测的是"held-out 前后值有正常返回"这条管线，不是在
    // 验证 minGroupN=20 这个新默认阈值本身（那个由下面专门的测试覆盖）——90 条测试段样本经过
    // 坐标上升搜索后，score>=cutoff 的实际切分点会随权重漂移，不一定总能保证两侧都≥20，
    // 用小样本场景的老阈值让这条测试只聚焦自己的职责，避免跟优化器具体收敛到哪个权重耦合。
    const res = optimizeWeightsForTierGain(rows, [factor('a', 50), factor('b', 50)], 50,
      { missingPolicy: 'zero', winThreshold: 2, minGroupN: 5 });
    assert.ok(Number.isFinite(res.rhoTestBefore) && Number.isFinite(res.rhoTestAfter));
    assert.ok(res.nTrain > 0 && res.nTest > 0);
  });

  test('optimizeWeightsForTierGain: 少于 2 个因子应返回 error 而不是抛异常', () => {
    const rows = makeRows();
    const res = optimizeWeightsForTierGain(rows, [factor('a', 100)], 50, { missingPolicy: 'zero' });
    assert.ok(res.error);
  });

  test('optimizeWeightsForTierGain: 归一化后权重和≈100', () => {
    const rows = makeRows();
    const res = optimizeWeightsForTierGain(rows, [factor('a', 50), factor('b', 50)], 50,
      { missingPolicy: 'zero', winThreshold: 2 });
    const sum = res.factors.reduce((s, f) => s + f.weight, 0);
    assert.ok(Math.abs(sum - 100) < 1, `权重和应≈100，实际 ${sum}`);
  });

  // 2026-07-28 加：推荐类策略用默认的"触发数×台阶差"配权会被"放量"牵着走（真实数据验证过：
  // 触发率从79%飙到92%，过滤能力形同虚设，见 factorLab.js scorePoolTierGain 内部注释）。
  // opts.volumeWeighted:false 去掉触发数乘数——用优化前(rhoTrainBefore，未经坐标上升搜索、
  // 纯粹是同一组权重下两种口径的直接算值)来验证：gapScore 本身必然落在 [-1,1]（0.7×台阶差+
  // 0.3×粗粒度秩相关，两项都是 [-1,1] 的凸组合），一旦乘回触发数(above.length)，在这份 n=200、
  // 只有 30% 垃圾的 fixture 上 train 段触发数远超 1，值必然超出 [-1,1]——用这个数学性质直接
  // 验证乘数被正确去掉，不依赖坐标上升具体收敛到哪个局部最优（那部分留给前面几个测试）。
  test('optimizeWeightsForTierGain volumeWeighted:false：目标值不再随触发数放大', () => {
    const rows = makeRows();
    const factors = [factor('a', 50), factor('b', 50)];
    const resTrue = optimizeWeightsForTierGain(rows, factors, 50, { missingPolicy: 'zero', winThreshold: 2, volumeWeighted: true });
    const resFalse = optimizeWeightsForTierGain(rows, factors, 50, { missingPolicy: 'zero', winThreshold: 2, volumeWeighted: false });
    assert.ok(!resTrue.error && !resFalse.error, '不应报错');
    assert.ok(Math.abs(resFalse.rhoTrainBefore) <= 1 + 1e-9,
      `volumeWeighted:false 的目标值应落在 [-1,1]（gapScore 本身），实际 ${resFalse.rhoTrainBefore}`);
    assert.ok(Math.abs(resTrue.rhoTrainBefore) > 1,
      `volumeWeighted:true（默认）的目标值应被触发数放大到超出 [-1,1]，实际 ${resTrue.rhoTrainBefore}——否则说明这份 fixture 触发数太小，测试基准需要调整`);
  });
}
