// Simple worker pool for recommendWorker.js
export async function evaluateCandidatesWithWorkers(rows, currentFactors, candidates, opts = {}) {
  const { concurrency = 4, batchSize = 8, signal, onProgress } = opts;
  if (!candidates || !candidates.length) return [];

  const workerUrl = new URL('./recommendWorker.js', import.meta.url);
  const workers = [];
  const workerOpts = { ...opts };
  delete workerOpts.concurrency;
  delete workerOpts.batchSize;
  delete workerOpts.signal;
  delete workerOpts.onProgress;
  for (let i = 0; i < Math.max(1, Math.min(concurrency, candidates.length)); i++) {
    workers.push(new Worker(workerUrl, { type: 'module' }));
  }

  let taskId = 1;
  const results = [];
  const errors = [];

  // Create batches
  const batches = [];
  for (let i = 0; i < candidates.length; i += batchSize) batches.push(candidates.slice(i, i + batchSize));

  let bi = 0;
  let completed = 0;

  await new Promise((resolve) => {
    let active = 0;
    function next(worker) {
      if (signal && signal.aborted) {
        try { worker.terminate(); } catch (e) {}
        if (--active <= 0) resolve();
        return;
      }
      if (bi >= batches.length) {
        // no more tasks for this worker
        worker.terminate();
        if (--active <= 0) resolve();
        return;
      }
      const batch = batches[bi++];
      const id = taskId++;
      const onmsg = (ev) => {
        const msg = ev.data;
        if (!msg) return;
        if (msg.taskId !== id) return;
        if (msg.type === 'result') {
          for (const entry of msg.results || []) {
            if (entry && entry.error) errors.push({ field: entry.field, camp: entry.camp, error: entry.error });
            else if (entry && entry.result) results.push({ field: entry.field, camp: entry.camp, result: entry.result });
          }
          const processed = (msg.results || []).length;
          completed += processed;
          if (typeof onProgress === 'function') onProgress({ completed, total: candidates.length });
          worker.removeEventListener('message', onmsg);
          next(worker);
        } else if (msg.type === 'error') {
          errors.push(msg.error);
          worker.removeEventListener('message', onmsg);
          next(worker);
        }
      };
      worker.addEventListener('message', onmsg);
      try {
        worker.postMessage({ type: 'eval', taskId: id, rows, currentFactors, candidates: batch, opts: workerOpts });
      } catch (e) {
        errors.push(String(e));
        worker.removeEventListener('message', onmsg);
        next(worker);
      }
    }

    // start workers
    active = workers.length;
    for (const w of workers) next(w);
  });

  if (errors.length) console.warn('workerPool errors', errors[0]);
  return results;
}
