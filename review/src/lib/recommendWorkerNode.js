import { parentPort } from 'worker_threads';
import { computeHeldOutDeltaRho, scorePoolBucketRho } from './factorLab.js';

// Worker thread for Node: 接收 { taskId, rows, currentFactors, candidates, opts }
// 返回 { taskId, results: [{ field, camp, result }] } 或 { taskId, error }
//
// 2026-07-28 修复：跟浏览器版 recommendWorker.js 同一个 bug——之前
// computeHeldOutDeltaRho(rows, currentFactors||[], c, c.camp, opts) 只传 5 个参数，opts 对象
// 整个落进了 winThreshold 位置（函数签名第 5 个参数），导致内部按 returnMax > winThreshold
// 判赢家的比较恒为 NaN 比较（false），赢家标签全灭，candidate 100% 报错。见浏览器版内部注释。

parentPort.on('message', (msg) => {
  if (!msg || msg.type !== 'eval') return;
  const { taskId, rows, currentFactors, candidates, opts } = msg;
  try {
    const { threshold, scoreMode, ...restOpts } = opts || {};
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
    parentPort.postMessage({ type: 'result', taskId, results });
  } catch (err) {
    parentPort.postMessage({ type: 'error', taskId, error: String(err) });
  }
});
