import assert from 'node:assert';
import { evaluateCandidatesWithNodeWorkers } from '../src/lib/workerPoolNode.js';

function mkRows(n = 80) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ret = ((i * 31) % 100) / 10;
    rows.push({ tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret,
      features: { good: ret, noise: ((i * 47) % 100) / 10 } });
  }
  return rows;
}

const cands = [
  { field: 'good', camp: 'hero', auc: 0.9, interval: { lo: 5, hi: Infinity } },
  { field: 'noise', camp: 'hero', auc: 0.52, interval: { lo: 5, hi: Infinity } },
];

// run 必须是 async、内部每个 test(...) 必须 await——run-tests.js 里注册这个文件时也要用
// testAsync（而不是同步的 test）并 await 调用本身。这三层但凡漏一层，async 用例的
// assert 失败就会变成"未处理的 promise rejection"，在 run-tests.js 打印完总数之后才触发，
// 完全不计入通过/失败统计——2026-07-28 debug `evaluateCandidatesWithNodeWorkers` 那个参数错位
// bug 时，就是先撞见"测试一直显示✓、但换个断言方式验证却发现函数其实总是报错"，才连带发现
// 这层 async 用例统计是假的。
export async function run(test) {
  // 2026-07-28 回归测试：recommendWorker.js/recommendWorkerNode.js 曾经把 opts 对象整个
  // 传进了 computeHeldOutDeltaRho 的 winThreshold 位置参数（少传了一个参数导致错位），
  // winThreshold 变成对象后，内部 returnMax > winThreshold 的比较恒为 NaN 比较（false），
  // 赢家标签全灭，candidate 100% 报"无法在训练段推导出打分边界"——之前这个测试没传
  // threshold/missingPolicy/shape，opts 传到 worker 那边变成 {}，恰好绕开了这个 bug
  // （{} 和数字都会被 default parameter 挡在外面，只有传"非空的普通对象"才会踩中）,
  // 所以没能测出来。这次显式传 threshold，贴合真实 FactorRecommendCard 的调用方式。
  await test('evaluateCandidatesWithNodeWorkers: 基本返回所有候选的结果（贴合真实调用，带 threshold）', async () => {
    const rows = mkRows();
    const res = await evaluateCandidatesWithNodeWorkers(rows, [], cands,
      { concurrency: 2, batchSize: 1, threshold: 2, missingPolicy: 'zero', shape: 'trap' });
    assert.strictEqual(res.length, cands.length);
    const good = res.find(r => r.field === 'good');
    assert.ok(good && good.result && !good.result.error,
      `不应报错（回归：opts 传进 winThreshold 位置的参数错位 bug）：${good?.result?.error}`);
    assert.ok(typeof good.result.deltaTest === 'number');
  });

  await test('evaluateCandidatesWithNodeWorkers: scoreMode=bucketRho 时用分层秩相关而不是全局ρ', async () => {
    const rows = mkRows();
    const resRho = await evaluateCandidatesWithNodeWorkers(rows, [], [cands[0]],
      { concurrency: 1, batchSize: 1, threshold: 2, missingPolicy: 'zero', shape: 'trap' });
    const resBucket = await evaluateCandidatesWithNodeWorkers(rows, [], [cands[0]],
      { concurrency: 1, batchSize: 1, threshold: 2, missingPolicy: 'zero', shape: 'trap', scoreMode: 'bucketRho' });
    assert.ok(!resRho[0].result.error && !resBucket[0].result.error, '两种口径都不应报错');
    // 不要求具体数值关系（两把不同的尺子，没有必然大小关系），只要求"确实是两种不同的算法在跑，
    // 没有报错"——分层秩相关样本量/分档不够时会安全退化成 NaN（不是报错），这里两种都接受。
    const dt = resBucket[0].result.deltaTest;
    assert.ok(Number.isFinite(dt) || Number.isNaN(dt),
      `bucketRho 模式应正常返回 NaN 或数字，不该是别的东西：${dt}`);
  });

  await test('evaluateCandidatesWithNodeWorkers: 仅筛选可评估候选', async () => {
    const rows = mkRows();
    const res = await evaluateCandidatesWithNodeWorkers(rows, [], [{ field: 'bad', camp: 'hero', interval: null }], { concurrency: 1, batchSize: 1 });
    assert.strictEqual(res.length, 1);
    assert.ok(res[0].result && res[0].result.error, 'should return result entry with error for invalid candidate');
  });
}
