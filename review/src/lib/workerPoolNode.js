import { Worker } from 'worker_threads';

export async function evaluateCandidatesWithNodeWorkers(rows, currentFactors, candidates, opts = {}) {
  const { concurrency = 4, batchSize = 8 } = opts;
  const workerOpts = { ...opts };
  delete workerOpts.concurrency;
  delete workerOpts.batchSize;
  delete workerOpts.signal;
  delete workerOpts.onProgress;
  if (!candidates || !candidates.length) return [];

  const workerFile = new URL('./recommendWorkerNode.js', import.meta.url);
  const workers = [];
  const maxWorkers = Math.max(1, Math.min(concurrency, candidates.length));
  for (let i = 0; i < maxWorkers; i++) {
    workers.push(new Worker(workerFile, { execArgv: [], argv: [], workerData: null }));
  }

  const batches = [];
  for (let i = 0; i < candidates.length; i += batchSize) batches.push(candidates.slice(i, i + batchSize));

  let taskId = 1;
  const results = [];
  const errors = [];
  let bi = 0;

  await new Promise((resolve) => {
    let active = workers.length;
    function next(worker) {
      if (bi >= batches.length) {
        try { worker.terminate(); } catch (e) {}
        if (--active <= 0) resolve();
        return;
      }
      const batch = batches[bi++];
      const id = taskId++;
      const onmsg = (msg) => {
        if (!msg) return;
        if (msg.type === 'result' && msg.taskId === id) {
          for (const entry of msg.results || []) {
            if (entry && entry.error) errors.push({ field: entry.field, camp: entry.camp, error: entry.error });
            else if (entry && entry.result) results.push({ field: entry.field, camp: entry.camp, result: entry.result });
          }
          worker.off('message', onmsg);
          next(worker);
        } else if (msg.type === 'error' && msg.taskId === id) {
          errors.push(msg.error);
          worker.off('message', onmsg);
          next(worker);
        }
      };
      worker.on('message', onmsg);
      worker.postMessage({ type: 'eval', taskId: id, rows, currentFactors, candidates: batch, opts: workerOpts });
    }

    for (const w of workers) next(w);
  });

  if (errors.length) console.warn('workerPoolNode errors', errors[0]);
  return results;
}
