import { computeFieldRaw } from '../../lib/factorLab.js';

// 因子发现的逐字段扫描 worker：主线程把（某阵营的）字段切成小批派进来，这里纯算 computeFieldRaw
// （AUC bootstrap + 区间置换检验，都是 CPU 密集），算完把 raw 结果发回。BH 校正/排序留在主线程
// assembleCampScan 里做（依赖全量字段，不能分批）。这样几百个字段的扫描不再冻死主线程。
//
// rows 只在建好时 init 一次并缓存（几百个字段会切成远多于 worker 数的批次，逐批带 rows 会把
// 大数组结构化克隆几十上百遍——init 一次让每个 worker 只克隆一份）。
// 消息：{ type:'init', rows } | { type:'scan', taskId, fields, opts:{winThreshold,bootstrapB,minCoverage}, camp }
// 回包：{ type:'result', taskId, raw:[{field,auc,interval,missRate}] } 或 { type:'error', taskId, error }
let cachedRows = null;
self.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === 'init') { cachedRows = msg.rows; return; }
  if (msg.type !== 'scan') return;
  const { taskId, fields, opts, camp } = msg;
  try {
    const raw = fields.map(f => computeFieldRaw(cachedRows, f, { ...opts, camp }));
    self.postMessage({ type: 'result', taskId, raw });
  } catch (err) {
    self.postMessage({ type: 'error', taskId, error: String(err && err.stack || err) });
  }
});
