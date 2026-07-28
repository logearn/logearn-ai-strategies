import assert from 'node:assert';
import { optimizeWeightsForBucketRho, computeHeldOutDeltaRho, scorePoolBucketRho, buildFactors } from '../src/lib/factorLab.js';

// 跟 tier-gain-optimize.test.js 用同一套构造思路，但这里用梯形（有过渡带）而不是纯 0/1 阶跃因子——
// scorePoolBucketRho 按分位数切 K 档时"同分不跨档"，纯阶跃因子只有 2~3 个离散取值，容易在某个
// 取值上把好几个档粘成一档、凑不够 3 档而返回 NaN（真实踩过：两个 50/50 阶跃因子在 n=210 上
// 只撞出 {0,50,100} 三个值，还分布不均，K=5 划分退化成只剩 2 档）。梯形因子取值连续，不会有
// 这个退化问题，也更贴近真实因子池的常见形态。
// good 是贯穿全程的真实排序信号（值越大、收益越高）；noise 是跟收益无关的均匀噪声。
//
// 2026-07-28：K 已从固定 3~5 改成自适应（按期望命中数≥3 算档大小，见 factorLab.js 里
// bucketRankRho 的实现和内部注释），档内统计量从命中率换成中位数——文件末尾"离散网格回归"
// 那两个测试专门验证这次改动本身（单因子孤立评估不该轻易撞上±1），这里前几个测试沿用旧结构，
// 验证的是"配权框架本身能正常工作"，两组测试职责不重叠。
function makeRows(n = 300) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const level = (i % 20) / 20;                    // 0~0.95，贯穿全程缓慢漂移
    const ret = 1 + level * 20 + ((i * 7) % 10) / 10; // 收益随 level 单调抬升，叠一点抖动
    const good = 20 + level * 60 + ((i * 17) % 10);   // 跟 level 强相关（好因子）
    const noise = (i * 31) % 100;                     // 跟 level/ret 无关（噪声因子）
    rows.push({
      tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret,
      features: { good, noise },
    });
  }
  return rows;
}
// 梯形：[lo0,lo1] 线性过渡，[lo1,hi1] 满分，good 用 [20,60]→满分（贴合它 20~86 的实际取值范围）；
// noise 用 [0,100]→满分（贴合它 0~99 的实际取值范围），两个因子都是连续过渡，不会撞出离散重复值。
const good = w => ({ field: 'good', camp: 'hero', weight: w, lo0: 20, lo1: 60, hi1: Infinity, hi0: Infinity });
const noise = w => ({ field: 'noise', camp: 'hero', weight: w, lo0: 0, lo1: 100, hi1: Infinity, hi0: Infinity });

export function run(test) {
  test('optimizeWeightsForBucketRho: 不需要 cutoff 参数也能跑（签名里没有 cutoff）', () => {
    const rows = makeRows();
    const res = optimizeWeightsForBucketRho(rows, [good(50), noise(50)], { missingPolicy: 'zero', winThreshold: 2 });
    assert.ok(!res.error, '不应报错：' + res.error);
  });

  test('optimizeWeightsForBucketRho: 优化后 train 分层秩相关不低于优化前', () => {
    const rows = makeRows();
    const res = optimizeWeightsForBucketRho(rows, [good(50), noise(50)], { missingPolicy: 'zero', winThreshold: 2 });
    assert.ok(res.rhoTrainAfter >= res.rhoTrainBefore - 1e-9, 'train 分层秩相关不应下降');
  });

  test('optimizeWeightsForBucketRho: 返回值恒落在 [-1,1]（不像 tierGain 默认版会被触发数放大）', () => {
    const rows = makeRows();
    const res = optimizeWeightsForBucketRho(rows, [good(50), noise(50)], { missingPolicy: 'zero', winThreshold: 2 });
    for (const v of [res.rhoTrainBefore, res.rhoTrainAfter, res.rhoTestBefore, res.rhoTestAfter]) {
      if (Number.isFinite(v)) assert.ok(Math.abs(v) <= 1 + 1e-9, `目标值应落在[-1,1]，实际 ${v}`);
    }
  });

  test('optimizeWeightsForBucketRho: 返回 held-out test 前后值', () => {
    const rows = makeRows();
    const res = optimizeWeightsForBucketRho(rows, [good(50), noise(50)], { missingPolicy: 'zero', winThreshold: 2 });
    assert.ok(Number.isFinite(res.rhoTestBefore) && Number.isFinite(res.rhoTestAfter));
    assert.ok(res.nTrain > 0 && res.nTest > 0);
  });

  test('optimizeWeightsForBucketRho: 少于 2 个因子应返回 error 而不是抛异常', () => {
    const rows = makeRows();
    const res = optimizeWeightsForBucketRho(rows, [good(100)], { missingPolicy: 'zero' });
    assert.ok(res.error);
  });

  test('optimizeWeightsForBucketRho: 归一化后权重和≈100', () => {
    const rows = makeRows();
    const res = optimizeWeightsForBucketRho(rows, [good(50), noise(50)], { missingPolicy: 'zero', winThreshold: 2 });
    const sum = res.factors.reduce((s, f) => s + f.weight, 0);
    assert.ok(Math.abs(sum - 100) < 1, `权重和应≈100，实际 ${sum}`);
  });

  test('optimizeWeightsForBucketRho: 样本太少（切不出3档）应返回 error', () => {
    const res = optimizeWeightsForBucketRho(makeRows(10), [good(50), noise(50)], { missingPolicy: 'zero', winThreshold: 2 });
    assert.ok(res.error);
  });

  // 2026-07-28 回归测试：K 固定 3~5 的旧版本，单独评估一个因子时容易撞上离散网格的极值——
  // 真实数据实测过 frequent_volume 单独一个候选跑出 Δ=+1.000（理论最大值），根因是 K 太小、
  // 参与秩相关计算的点太少，"几个粗糙数字凑巧排对顺序"的概率远高于全局ρ。改成自适应 K（按期望
  // 命中数≥3 算档大小）+ 档内统计量用中位数（而不是命中率）之后，同样场景（贴近真实基准命中率
  // ~11.6%、单因子孤立评估、真实存在但不完美的信号）不应该再精确撞在 ±1（除非信号真的完美，
  // 这里构造的数据故意留了噪声，不该出现完美单调）。
  test('optimizeWeightsForBucketRho 的底层评估：单因子孤立评估不该轻易撞上 ±1（离散网格回归）', () => {
    const n = 550;
    const rows = [];
    for (let i = 0; i < n; i++) {
      // 基准命中率贴近真实项目口径 ~11.6%（i%100<12）
      const isWin = (i % 100) < 12;
      const noise = (i * 37) % 100;
      // good 因子对输赢有真实但不完美的区分力（叠了不小的噪声，不是纯阶跃）
      const good = isWin ? 40 + noise * 0.6 : 20 + noise * 0.5;
      const ret = isWin ? 5 + (i % 20) : 0.3 + (i % 10) / 10;
      rows.push({ tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret, features: { good } });
    }
    const candidate = { field: 'good', camp: 'hero', auc: 0.75, interval: { lo: 35, hi: Infinity } };
    const scoreFn = (rowsSet, factorSet, mp) => scorePoolBucketRho(rowsSet, factorSet, mp, 2);
    const r = computeHeldOutDeltaRho(rows, [], candidate, 'hero', 2, { missingPolicy: 'zero', shape: 'trap', scoreFn });
    assert.ok(!r.error, '不应报错：' + r.error);
    assert.ok(Math.abs(r.deltaTest) < 0.99,
      `不该精确撞上离散网格极值 ±1（实际 ${r.deltaTest}）——旧版 K=3~5 会在这种真实感数据上出现这个问题`);
    assert.ok(Math.abs(r.deltaTrain) < 0.99, `train 同理不该撞上 ±1（实际 ${r.deltaTrain}）`);
  });

  test('optimizeWeightsForBucketRho 的底层评估：纯噪声因子不该被误判成强信号', () => {
    const n = 550;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const isWin = (i % 100) < 12;
      const ret = isWin ? 5 + (i % 20) : 0.3 + (i % 10) / 10;
      const noiseField = ((i * 53) % 1000) / 10; // 跟 isWin/ret 完全无关
      rows.push({ tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret, features: { noiseField } });
    }
    const candidate = { field: 'noiseField', camp: 'hero', auc: 0.5, interval: { lo: 50, hi: Infinity } };
    const scoreFn = (rowsSet, factorSet, mp) => scorePoolBucketRho(rowsSet, factorSet, mp, 2);
    const r = computeHeldOutDeltaRho(rows, [], candidate, 'hero', 2, { missingPolicy: 'zero', shape: 'trap', scoreFn });
    assert.ok(!r.error, '不应报错：' + r.error);
    // NaN 是可以接受的结果：这个字段的梯形核心区间很窄，大量样本会两端顶格夹成大块同分——
    // "同分不跨档"规则把实际档数压到 minK 以下时，正确的做法是拒绝评估（NaN），不是硬凑一个数字。
    // NaN 和"数值但不高"都算通过；不能接受的是一个虚高的、接近±1的数字。
    assert.ok(Number.isNaN(r.deltaTest) || Math.abs(r.deltaTest) < 0.7,
      `纯噪声因子的 held-out 值不该是虚高的数字（实际 ${r.deltaTest}）`);
  });

  // 2026-07-28 回归测试：用户诊断——"推荐时少算了一个维度，把一个维度算到了极致，导致高度集中
  // 在一起"。真实场景：max_up_duration 推出的梯形下界形同虚设，几乎所有样本（不管输赢）都落在
  // 满分区，散点图上顶格那一竖排从1x到200x全混在一起，但桶间中位数排序看着还行（+0.964）——
  // 秩相关只看"桶间"排得对不对，不管"桶内"混杂成什么样，需要饱和度惩罚才能识别出这种情况。
  test('optimizeWeightsForBucketRho 的底层评估：饱和因子（几乎全员满分）应被饱和度惩罚打低分，不该虚高', () => {
    const n = 550;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const isWin = (i % 100) < 12;
      const ret = isWin ? 5 + (i % 20) : 0.3 + (i % 10) / 10;
      const dur = 100 + (i % 400); // 绝大多数样本落在满分区，跟输赢完全无关（模拟下界形同虚设）
      rows.push({ tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret, features: { dur } });
    }
    const candidate = { field: 'dur', camp: 'hero', auc: 0.55, interval: { lo: 100, hi: Infinity } };
    const scoreFn = (rowsSet, factorSet, mp) => scorePoolBucketRho(rowsSet, factorSet, mp, 2);
    const r = computeHeldOutDeltaRho(rows, [], candidate, 'hero', 2, { missingPolicy: 'zero', shape: 'trap', scoreFn });
    assert.ok(!r.error, '不应报错：' + r.error);
    assert.ok(Number.isNaN(r.deltaTest) || r.deltaTest < 0.3,
      `饱和因子不该被判成强信号（实际 ${r.deltaTest}）——大部分样本挤在同一个分数上，桶内没有区分度`);
  });

  test('optimizeWeightsForBucketRho 的底层评估：分布均匀的真实信号不该被饱和度惩罚误伤', () => {
    const n = 550;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const level = (i % 50) / 50;
      const ret = level > 0.85 ? 5 + (i % 15) : 0.5 + (i % 10) / 10;
      const good = 20 + level * 60 + ((i * 13) % 20);
      rows.push({ tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret, features: { good } });
    }
    const candidate = { field: 'good', camp: 'hero', auc: 0.7, interval: { lo: 60, hi: Infinity } };
    const scoreFn = (rowsSet, factorSet, mp) => scorePoolBucketRho(rowsSet, factorSet, mp, 2);
    const r = computeHeldOutDeltaRho(rows, [], candidate, 'hero', 2, { missingPolicy: 'zero', shape: 'trap', scoreFn });
    assert.ok(!r.error, '不应报错：' + r.error);
    assert.ok(Number.isFinite(r.deltaTest) && r.deltaTest > 0.3,
      `分布均匀的真实信号不该被饱和度惩罚误伤到接近0（实际 ${r.deltaTest}）`);
  });

  // 2026-07-28 四订正回归测试：用户在真实回测图上发现"档命中率"紫线锯齿很重，但配权用的
  // spearman 只看整体排序对不对，对局部倒挂"失明"。构造两组数据：6 档命中数分别是
  // [2,5,8,7,13,15]（小跌幅，第4档比第3档只低1）和 [2,5,8,6,13,15]（大跌幅，低2）——
  // 两组的档-命中数排列顺序（rank）完全一致（都是"…8 > dip < 13…"这一种相对位置关系，
  // dip 值只要仍然夹在 5 和 8 之间就不改变排序），max/min 也一样（range 都是 13），
  // 各档样本量也一样（都是15，maxBucketFrac 相同）——也就是说旧公式（spearman×饱和度惩罚）
  // 对这两组数据必定算出完全相同的分数，无法区分"小锯齿"和"大锯齿"。加了锯齿惩罚之后，
  // 跌幅更大的那组应该被扣得更多、算出更低的分层秩相关。
  function makeZigzagRows(hitCounts) {
    const rows = [];
    let x = 0;
    for (const count of hitCounts) {
      for (let j = 0; j < 15; j++) {
        rows.push({ tokenAddress: 'Z' + x, swapBeginTime: 1000 + x, returnMax: j < count ? 5 : 0.5, features: { x } });
        x++;
      }
    }
    return rows;
  }

  test('scorePoolBucketRho: 排序(spearman)和饱和度都相同时，跌幅更大的锯齿应该被扣得更多', () => {
    const factorSet = [{ field: 'x', camp: 'hero', weight: 100, lo0: 0, lo1: 89, hi1: Infinity, hi0: Infinity }];
    const rhoSmallDip = scorePoolBucketRho(makeZigzagRows([2, 5, 8, 7, 13, 15]), factorSet, 'zero', 1);
    const rhoBigDip = scorePoolBucketRho(makeZigzagRows([2, 5, 8, 6, 13, 15]), factorSet, 'zero', 1);
    assert.ok(Number.isFinite(rhoSmallDip) && Number.isFinite(rhoBigDip),
      `两组都应给出有效数值：small=${rhoSmallDip}, big=${rhoBigDip}`);
    assert.ok(rhoSmallDip > rhoBigDip + 1e-6,
      `小跌幅锯齿应该比大跌幅锯齿扣得少（旧公式这两组会算出完全相同的值）：small=${rhoSmallDip}, big=${rhoBigDip}`);
  });

  test('scorePoolBucketRho: 完全没有倒挂(纯递增)的档序列不该被锯齿惩罚误伤', () => {
    const factorSet = [{ field: 'x', camp: 'hero', weight: 100, lo0: 0, lo1: 89, hi1: Infinity, hi0: Infinity }];
    const rhoMonotonic = scorePoolBucketRho(makeZigzagRows([2, 5, 8, 11, 13, 15]), factorSet, 'zero', 1);
    const rhoSmallDip = scorePoolBucketRho(makeZigzagRows([2, 5, 8, 7, 13, 15]), factorSet, 'zero', 1);
    assert.ok(Number.isFinite(rhoMonotonic) && Number.isFinite(rhoSmallDip));
    assert.ok(rhoMonotonic > rhoSmallDip,
      `纯递增（零倒挂）应该比有倒挂的序列分数更高：monotonic=${rhoMonotonic}, dip=${rhoSmallDip}`);
  });

  // 2026-07-28 五订正回归测试：锯齿惩罚第一版（totalDrop / range 归一）上线后用户在真实数据
  // （n=679，177个候选字段，多数候选 AUC 只有 0.52~0.58 这种弱信号）上实测，候选表里"边际
  // 分层秩相关贡献"几乎全部塌成 0.000，因子推荐贪心也只挑得出1个字段。复现过程：先手工验证
  // 一个强信号(AUC~0.7)构造数据，第一版公式算出来完全正常（deltaTest≈0.52），说明问题不在
  // "档数多"本身，而在"信号弱、局部倒挂占涨跌总量的比例高"——真实候选大多是这种弱信号。换成
  // 弱信号构造（AUC~0.55，噪声远大于信号，贴近真实候选表里的典型候选）复现出同样的塌陷：第一版
  // 公式 deltaTest≈0.031（旧 range 归一——分子 totalDrop 随局部倒挂次数累加，分母 range 是
  // 跟倒挂次数无关的固定常数，弱信号局部倒挂占比高时很容易把比值顶到封顶的1）；改成"总变差"
  // （totalVariation，涨跌都算，totalDrop 天然是它的子集，比值不需要额外封顶）归一之后同一份
  // 数据 deltaTest≈0.092——量级对不上（3倍），但至少不再被拍扁到几乎为0。断言用 0.06 这个卡在
  // 两个版本中间的阈值：旧公式过不了，新公式能稳定过。
  test('computeHeldOutDeltaRho: 弱信号(AUC~0.55，贴近真实候选表的典型候选)不该被锯齿惩罚拍扁到接近0', () => {
    const n = 700;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const level = (i % 100) / 100;
      const isWin = level > 0.85; // 基准命中率 ~15%，贴近真实项目口径
      const ret = isWin ? 3 + (i % 20) : 0.3 + (i % 10) / 10;
      const good = level * 15 + ((i * 37) % 85); // 弱信号：涨跌幅里噪声远大于真实趋势，AUC~0.55
      rows.push({ tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret, features: { good } });
    }
    const candidate = { field: 'good', camp: 'hero', auc: 0.55, interval: { lo: 40, hi: Infinity } };
    const scoreFn = (rowsSet, factorSet, mp) => scorePoolBucketRho(rowsSet, factorSet, mp, 2);
    const r = computeHeldOutDeltaRho(rows, [], candidate, 'hero', 2, { missingPolicy: 'zero', shape: 'trap', scoreFn });
    assert.ok(!r.error, '不应报错：' + r.error);
    assert.ok(Number.isFinite(r.deltaTest) && r.deltaTest > 0.06,
      `弱信号候选不该被锯齿惩罚拍扁到接近0（实际 ${r.deltaTest}）——旧的 range 归一版本在这类候选上会算出≈0.03，几乎看不出区分度`);
  });
}
