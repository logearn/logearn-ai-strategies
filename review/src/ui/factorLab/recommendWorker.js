import { computeHeldOutDeltaRho, scorePoolBucketRho } from '../../lib/factorLab.js';

// Worker 接受消息 { type: 'eval', taskId, rows, currentFactors, candidates, opts }
// 返回 { type: 'result', taskId, results: [{ field, camp, result }] }
//
// 2026-07-28 修复：之前这里是 computeHeldOutDeltaRho(rows, currentFactors||[], c, c.camp, opts)——
// 只传了 5 个参数，但函数签名是 (rows, currentFactors, candidate, camp, winThreshold, opts)，
// opts 对象整个落进了 winThreshold 这个位置参数（第 6 个真正的 opts 反而缺省成 {}）。winThreshold
// 变成一个对象后，内部按 returnMax > winThreshold 判赢家的比较会被强制转成 NaN 比较、恒为
// false——赢家标签全灭，trapezoid 推导不出满分核，candidate 100% 报错"无法在训练段推导出打分边界"。
// 实测复现过（真实候选数据）：修好参数对齐后从必错变成能正常返回 deltaTest。
self.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'eval') return;
  const { taskId, rows, currentFactors, candidates, opts } = msg;
  try {
    const { threshold, scoreMode, ...restOpts } = opts || {};
    // scoreMode:'bucketRho' 时目标函数改用分层秩相关（推荐场景独立北极星，不吃cutoff）——
    // scoreFn 是函数，没法跨 worker 边界传（postMessage 只能传可结构化克隆的数据），
    // 所以只传字符串 scoreMode，在 worker 内部本地构造 scoreFn。
    const scoreFnOpt = scoreMode === 'bucketRho'
      ? { scoreFn: (rowsSet, factorSet, mp) => scorePoolBucketRho(rowsSet, factorSet, mp, threshold) }
      : {};
    const results = candidates.map(c => {
      try {
        const r = computeHeldOutDeltaRho(rows, currentFactors || [], c, c.camp, threshold, { ...restOpts, ...scoreFnOpt });
        return { field: c.field, camp: c.camp, result: r };
      } catch (err) {
        return { field: c.field, camp: c.camp, error: String(err) };
      }
    });
    self.postMessage({ type: 'result', taskId, results });
  } catch (err) {
    // catastrophic error
    self.postMessage({ type: 'error', taskId, error: String(err) });
  }
});
