import { assembleCampScan, summarizeNullDistribution } from '../../lib/factorLab.js';
import { AUC_TARGET_FIELDS } from '../../lib/auc.js';

// 因子发现的并行扫描：把两个阵营的字段切成小批，丢进一池 scanWorker 逐字段并行算 raw，
// 主线程再按阵营 assembleCampScan（BH 校正/排序，依赖全量字段，只能在主线程汇总做一次）。
// 效果与串行 scanFactorCandidates 逐字段一致，但几百个字段不再冻死主线程、还吃满多核。
//
// rows 只在每个 worker 建好时 init 一次（不随每个批次重复 postMessage 克隆——字段几百个时
// 批次远多于 worker 数，逐批带 rows 会把大数组克隆几十上百遍）。返回 { hero, evil }，
// 各自是 { candidates, skipped }，形状跟 scanFactorCandidates 完全一致。
export async function scanCandidatesWithWorkers(rows, heroFields, evilFields, opts = {}) {
  const { concurrency = 4, batchSize = 16, signal, onProgress,
          winThreshold, bootstrapB, minCoverage } = opts;
  const scanOpts = { winThreshold, bootstrapB, minCoverage };
  // 目标变量（returnMax 及其变换）在派发前剔除，跟 scanFactorCandidates 口径一致（不进候选/不进 skipped）。
  const heroScan = (heroFields || []).filter(f => !AUC_TARGET_FIELDS.has(f));
  const evilScan = (evilFields || []).filter(f => !AUC_TARGET_FIELDS.has(f));

  // camp 标记的字段批次队列（两阵营共用一池 worker，谁空谁取下一批，多核利用率最高）。
  const batches = [];
  for (const [camp, fs] of [['hero', heroScan], ['evil', evilScan]]) {
    for (let i = 0; i < fs.length; i += batchSize) batches.push({ camp, fields: fs.slice(i, i + batchSize) });
  }
  const total = heroScan.length + evilScan.length;
  // 按【批次下标】回填，不是按完成顺序 push —— 批次派进共享 worker 池，谁空谁取下一批，
  // 完成顺序取决于各批耗时和 OS 调度，每次刷新都不同。而 rawList 的顺序是会传导到最终推荐结果的：
  //   rawList 顺序 → finalizeAucScan 的稳定排序（|AUC−0.5| 打平时保留输入顺序）→ candidates 顺序
  //   → 贪心 pool.sort（interval.score 打平时保留 candidates 顺序）→ cands.sort（testRho 打平时
  //   保留 pool 顺序）→ 选中哪个候选。
  // 真实数据里精确打平很常见（同一个量的两个路径别名，如 chip_analysis.inner_sell_ratio /
  // inner_address_holding，AUC 和边际ρ 逐位相同），于是"每次刷新推荐出来的字段不一样"。
  // 既有的并行等价性测试喂的是按字段顺序的 rawList，从没测过乱序，所以一直没抓到。
  const slots = new Array(batches.length);
  const assemble = () => {
    const heroRaw = [], evilRaw = [];
    for (let i = 0; i < batches.length; i++) {
      if (!slots[i]) continue;                     // 该批失败/被取消：当"没扫到"，跟原行为一致
      (batches[i].camp === 'evil' ? evilRaw : heroRaw).push(...slots[i]);
    }
    return { hero: assembleCampScan(heroRaw, 'hero'), evil: assembleCampScan(evilRaw, 'evil') };
  };
  if (!batches.length) return assemble();

  const workerUrl = new URL('./scanWorker.js', import.meta.url);
  const nWorkers = Math.max(1, Math.min(concurrency, batches.length));
  const workers = [];
  for (let i = 0; i < nWorkers; i++) {
    const w = new Worker(workerUrl, { type: 'module' });
    w.postMessage({ type: 'init', rows });   // 每个 worker 缓存一份 rows，后续批次只发字段
    workers.push(w);
  }

  let taskId = 1, bi = 0, completed = 0;
  await new Promise((resolve, reject) => {
    let active = 0, dead = 0, doneBatches = 0, settled = false;
    // 收尾：所有 worker 都退出了才走到这里。
    // 若是【全部异常退出】且还有批次没回包，必须 reject —— 上层 runScan 的 catch 会回退主线程串行；
    // 直接 resolve 会静默返回一份缺了大半字段的候选表，比报错难排查得多。
    // 判据用「实际回包的批次数」而不是派发游标 bi：bi 在派发那一刻就已经加过了，
    // 用它判会把"派发出去、worker 当场炸了"误判成"跑完了"。
    const finish = () => {
      if (settled) return;
      settled = true;
      if (dead >= workers.length && doneBatches < batches.length) {
        reject(new Error(`扫描 worker 全部异常退出（${dead}/${workers.length}），回退主线程`));
      } else resolve();
    };
    function next(worker) {
      if ((signal && signal.aborted) || bi >= batches.length) {
        try { worker.terminate(); } catch (e) {}
        if (--active <= 0) finish();
        return;
      }
      const bIdx = bi++;
      const batch = batches[bIdx];
      const id = taskId++;
      const onmsg = (ev) => {
        const msg = ev.data;
        if (!msg || msg.taskId !== id) return;
        if (msg.type === 'result') {
          slots[bIdx] = msg.raw || [];   // 回填到派发下标，见上方 slots 的注释

          completed += batch.fields.length;
          if (typeof onProgress === 'function') onProgress({ completed, total });
        } else if (msg.type === 'error') {
          // 某批失败：raw 缺这些字段，assembleCampScan 会把它们当"没扫到"处理，不至于整体崩。
          console.warn('scanWorker error', msg.error);
        }
        doneBatches++;   // 回包了就算这批有结论（成功/该批报错都算），见 finish() 的判据
        worker.removeEventListener('message', onmsg);
        next(worker);
      };
      worker.addEventListener('message', onmsg);
      worker.postMessage({ type: 'scan', taskId: id, fields: batch.fields, opts: scanOpts, camp: batch.camp });
    }
    // worker 级错误（模块加载失败、OOM、postMessage 结构化克隆抛错）不会走 message 回包——
    // 少了这条监听，onmsg 永不触发 → next() 永不推进 → 这个 Promise 永不 resolve，
    // UI 表现是「扫描中…」永远转圈，而且上层那个"回退主线程"的 catch 也永远进不去（不是 reject，是 hang）。
    // 单个 worker 死掉不影响整体：它手上那批字段丢失（assembleCampScan 当"没扫到"处理），
    // 剩下的批次由其它 worker 继续领——批次队列 bi 是共享的。
    for (const w of workers) {
      w.addEventListener('error', (e) => {
        console.warn('scanWorker 异常退出', (e && (e.message || e)) || '');
        dead++;
        try { w.terminate(); } catch (_) {}
        if (--active <= 0) finish();
      });
    }
    active = workers.length;
    for (const w of workers) next(w);
  });

  return assemble();
}

// Simple worker pool for recommendWorker.js
// rows 只在每个 worker 建好时 init 一次并缓存（候选数远多于 batchSize 时，批次远多于 worker 数，
// 逐批带 rows 会把大数组结构化克隆几十上百遍，克隆本身在发送方主线程同步跑——2026-07-28 真实
// 数据实测"算推荐"把主线程冻到 FPS=1 就是这里，见 recommendWorker.js 头部注释）。
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
  // buildRows（候选区间实际挖自哪份行集）跟 rows 一样只在 init 时发一次并缓存，不能留在 workerOpts
  // 里跟着【每一批】eval 消息重发——结构化克隆发生在发送方主线程，批次远多于 worker 数时同一个大
  // 数组会被克隆几十遍，这正是 readme 里"算推荐把主线程冻到 FPS=1"那次修的坑，当时只把 rows
  // 挪进 init，buildRows 这条支路漏了（当时只有残差模式会走到，所以没被那次实测覆盖到；
  // 残差模式已于 2026-07-29 删除，这条支路现在只在"rows 换过但没重扫"时才走）。
  const buildRows = workerOpts.buildRows;
  delete workerOpts.buildRows;
  for (let i = 0; i < Math.max(1, Math.min(concurrency, candidates.length)); i++) {
    const w = new Worker(workerUrl, { type: 'module' });
    w.postMessage({ type: 'init', rows, buildRows });
    workers.push(w);
  }

  let taskId = 1;
  const results = [];
  const errors = [];

  // Create batches
  const batches = [];
  for (let i = 0; i < candidates.length; i += batchSize) batches.push(candidates.slice(i, i + batchSize));

  let bi = 0;
  let completed = 0;

  await new Promise((resolve, reject) => {
    let active = 0, dead = 0, doneBatches = 0, settled = false;
    // 与 scanCandidatesWithWorkers 同一套收尾：全部 worker 异常退出且还有批次没回包 → reject，
    // 让 runMarginalRho 的 catch 回退主线程逐候选串行；否则返回半份结果，界面上看不出少了谁。
    // 判据同样用「实际回包的批次数」而不是派发游标 bi（理由见 scanCandidatesWithWorkers）。
    const finish = () => {
      if (settled) return;
      settled = true;
      if (dead >= workers.length && doneBatches < batches.length) {
        reject(new Error(`边际ρ worker 全部异常退出（${dead}/${workers.length}），回退主线程`));
      } else resolve();
    };
    function next(worker) {
      if (signal && signal.aborted) {
        try { worker.terminate(); } catch (e) {}
        if (--active <= 0) finish();
        return;
      }
      if (bi >= batches.length) {
        // no more tasks for this worker
        worker.terminate();
        if (--active <= 0) finish();
        return;
      }
      const bIdx = bi++;
      const batch = batches[bIdx];
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
          doneBatches++;
          worker.removeEventListener('message', onmsg);
          next(worker);
        } else if (msg.type === 'error') {
          errors.push(msg.error);
          doneBatches++;   // 该批有结论（虽然是错的），见 finish() 的判据
          worker.removeEventListener('message', onmsg);
          next(worker);
        }
      };
      worker.addEventListener('message', onmsg);
      try {
        worker.postMessage({ type: 'eval', taskId: id, currentFactors, candidates: batch, opts: workerOpts });
      } catch (e) {
        errors.push(String(e));
        worker.removeEventListener('message', onmsg);
        next(worker);
      }
    }

    // worker 级错误监听，理由同 scanCandidatesWithWorkers（少了它 = 永久 hang + worker 泄漏）
    for (const w of workers) {
      w.addEventListener('error', (e) => {
        errors.push(String((e && (e.message || e)) || 'worker error'));
        dead++;
        try { w.terminate(); } catch (_) {}
        if (--active <= 0) finish();
      });
    }
    // start workers
    active = workers.length;
    for (const w of workers) next(w);
  });

  if (errors.length) console.warn('workerPool errors', errors[0]);
  return results;
}

// 边际ρ 的置换零分布：按 permutations 切片并行。每片一个 worker、一个不同的 seed，各自跑
// permutationNullMarginalRho，主线程把各片的 deltas 合起来再统一汇总分位数（summarizeNullDistribution
// 与串行版共用，口径一致）。切片而不是切候选，是因为每一次置换都要重打乱一遍全表 returnMax，
// 按置换切才能让每个 worker 各自独立完成整轮，互不依赖。
export async function runPermutationNullWithWorkers(rows, currentFactors, candidates, opts = {}) {
  const { concurrency = 4, permutations = 20, signal, onProgress, buildRows, ...rest } = opts;
  if (!candidates || !candidates.length) return { error: '没有可用于置换检验的候选' };
  const shards = Math.max(1, Math.min(concurrency, permutations));
  const per = Math.floor(permutations / shards);
  const counts = Array.from({ length: shards }, (_, i) => per + (i < permutations % shards ? 1 : 0)).filter(c => c > 0);

  let done = 0;
  const parts = await Promise.all(counts.map((count, i) => new Promise((resolve) => {
    const worker = new Worker(new URL('./recommendWorker.js', import.meta.url), { type: 'module' });
    const cleanup = () => { try { worker.terminate(); } catch (e) {} };
    if (signal) {
      if (signal.aborted) { cleanup(); resolve(null); return; }
      signal.addEventListener('abort', () => { cleanup(); resolve(null); }, { once: true });
    }
    worker.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg || msg.taskId !== 1) return;
      cleanup();
      done += count;
      if (typeof onProgress === 'function') onProgress({ completed: done, total: permutations });
      resolve(msg.type === 'result' ? msg.whole : null);
    });
    worker.addEventListener('error', (e) => { cleanup(); console.warn('permNull worker error', e.message || e); resolve(null); });
    // 每片换一个 seed，否则几片跑的是完全相同的置换序列，等于白白多跑几遍
    const shardOpts = { ...rest, permutations: count, seed: 0x5EED1234 + i * 7919 };
    if (buildRows && buildRows !== rows) shardOpts.buildRows = buildRows;  // 与 rows 相同就别再克隆一份
    worker.postMessage({ type: 'permNull', taskId: 1, rows, currentFactors, candidates, opts: shardOpts });
  })));

  const deltas = [];
  let attempted = 0;
  for (const p of parts) {
    if (!p) continue;
    if (Array.isArray(p.deltas)) deltas.push(...p.deltas);
    if (Number.isFinite(p.attempted)) attempted += p.attempted;
  }
  return summarizeNullDistribution(deltas, { permutations, candidates: candidates.length, attempted });
}

// 单 worker 跑完一整条推荐（选字段贪心 + 精配权 + K折曲线，纯函数），主线程只 postMessage 一次、
// 等一个结果——整个搜索（遍历全部候选、maxSteps 轮，每轮还要 build+两段打分）不再冻死主线程。
// kind:'recommend'（两张推荐卡片合并后只剩这一种）。payload 带该函数的入参（rows/candidates/opts，
// 起点池在 opts.startFactors 里）。
export function runRecommendInWorker(kind, payload, opts = {}) {
  // onProgress(pct)：只有 kind='recommendAll' 会回报（全字段扫描要跑几百个字段，没有进度条
  // 用户不知道是卡死还是在算）。其它 kind 不发 progress 消息，这条分支对它们是死代码。
  const { signal, onProgress } = opts;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./recommendWorker.js', import.meta.url), { type: 'module' });
    const cleanup = () => { try { worker.terminate(); } catch (e) {} };
    if (signal) {
      if (signal.aborted) { cleanup(); reject(new DOMException('aborted', 'AbortError')); return; }
      signal.addEventListener('abort', () => { cleanup(); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
    }
    worker.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg || msg.taskId !== 1) return;
      // progress 必须在 cleanup 之前拦掉：不然它会掉进下面的 else 被当成 error 直接 reject，
      // 顺手还把 worker terminate 了——整个任务在第一个进度回报时就死了。
      if (msg.type === 'progress') { if (onProgress) onProgress(msg.pct, msg.note); return; }
      cleanup();
      if (msg.type === 'result') resolve(msg.whole);
      else reject(new Error(msg.error || 'worker error'));
    });
    worker.addEventListener('error', (e) => { cleanup(); reject(e.error || new Error(String(e.message || e))); });
    worker.postMessage({ type: kind, taskId: 1, ...payload });
  });
}
