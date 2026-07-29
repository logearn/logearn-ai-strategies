import assert from 'node:assert';
import { scanCandidatesWithWorkers, evaluateCandidatesWithWorkers } from '../src/ui/factorLab/workerPool.js';

// worker 池的失败路径回归测试（2026-07-29 新增）。
//
// 被测的是这么一个真实缺陷：scanCandidatesWithWorkers / evaluateCandidatesWithWorkers 原来只挂了
// 'message' 监听，没挂 'error'。worker 模块加载失败、OOM、postMessage 结构化克隆抛错这几类失败
// 【不走 message 回包】，于是 next() 永不推进、外层 Promise 永不 resolve——UI 表现是「扫描中…」
// 永远转圈，而且调用方那个"回退主线程串行"的 catch 也永远进不去（不是 reject，是 hang）。
// 同文件的 runPermutationNullWithWorkers/runRecommendInWorker 一直是有 error 监听的，只有这两个漏了。
//
// 测试手段：用假 Worker 替换 globalThis.Worker。真 worker 在 node 里跑不起来，
// 而这里要验的本来就是"worker 挂掉时池子怎么收场"，用假的反而能精确控制失败时机。
class FakeWorker {
  constructor(url, opts) {
    this.listeners = new Map();
    this.terminated = false;
    FakeWorker.instances.push(this);
    this.behavior = FakeWorker.nextBehavior();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const arr = this.listeners.get(type);
    if (arr) this.listeners.set(type, arr.filter(f => f !== fn));
  }
  terminate() { this.terminated = true; }
  emit(type, ev) { for (const fn of [...(this.listeners.get(type) || [])]) fn(ev); }
  postMessage(msg) {
    if (!msg || msg.type === 'init') return;           // init 不回包，跟真 worker 一致
    // 异步回包/异步炸，模拟真实事件循环（同步触发会打乱 next() 的推进顺序）
    setTimeout(() => {
      if (this.terminated) return;
      if (this.behavior === 'error') { this.emit('error', { message: 'boom' }); return; }
      if (msg.type === 'scan') {
        // raw 里每个元素的形状见 computeFieldRaw：这里给"AUC 不可用"的最简形态，
        // assembleCampScan 会把它归进 skipped，不影响本用例要验的收尾逻辑。
        this.emit('message', { data: { type: 'result', taskId: msg.taskId,
          raw: msg.fields.map(f => ({ field: f, auc: { field: f, auc: NaN, ci: null, reason: '构造样本' }, interval: null })) } });
      } else if (msg.type === 'eval') {
        this.emit('message', { data: { type: 'result', taskId: msg.taskId,
          results: msg.candidates.map(c => ({ field: c.field, camp: c.camp, result: { deltaTest: 0.01 } })) } });
      }
    }, 0);
  }
}
FakeWorker.instances = [];
FakeWorker.behaviors = [];
FakeWorker.nextBehavior = () => FakeWorker.behaviors[FakeWorker.instances.length - 1] || 'ok';

function withFakeWorkers(behaviors, fn) {
  const prev = globalThis.Worker;
  FakeWorker.instances = [];
  FakeWorker.behaviors = behaviors;
  globalThis.Worker = FakeWorker;
  return Promise.resolve()
    .then(fn)
    .then(r => ({ ok: true, value: r }), e => ({ ok: false, error: e }))
    .then(res => { globalThis.Worker = prev; return res; });
}

const rows = Array.from({ length: 20 }, (_, i) => ({ features: { a: i, b: i % 3 }, returnMax: i > 10 ? 6 : 1 }));

export async function run(testAsync) {
  await testAsync('workerPool: 扫描 worker 全部异常退出时应 reject（而不是永久 hang），且不泄漏 worker', async () => {
    const res = await withFakeWorkers(['error', 'error'], () =>
      // 超时兜底：这条测试要防的就是"永不 resolve"，没有它失败会表现成整个测试进程挂住
      Promise.race([
        scanCandidatesWithWorkers(rows, ['a'], ['b'], { concurrency: 2, batchSize: 1 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT: 池子永不结束（就是这个 bug 本身）')), 2000)),
      ]));
    assert.strictEqual(res.ok, false, '全部 worker 异常退出时应当 reject，让上层回退主线程');
    assert.ok(!/TIMEOUT/.test(res.error.message), res.error.message);
    assert.ok(/异常退出/.test(res.error.message), `错误信息应说明原因，实际：${res.error.message}`);
    assert.ok(FakeWorker.instances.every(w => w.terminated), '异常退出的 worker 必须被 terminate，否则线程泄漏');
  });

  await testAsync('workerPool: 部分 worker 异常退出时，剩下的应继续把批次跑完并正常返回', async () => {
    const res = await withFakeWorkers(['error', 'ok'], () =>
      Promise.race([
        scanCandidatesWithWorkers(rows, ['a'], ['b'], { concurrency: 2, batchSize: 1 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT: 池子永不结束')), 2000)),
      ]));
    assert.strictEqual(res.ok, true, `一个 worker 死掉不该拖垮整体，实际：${res.ok ? '' : res.error.message}`);
    assert.ok(res.value.hero && res.value.evil, '返回形状应与 scanFactorCandidates 一致');
    assert.ok(FakeWorker.instances.every(w => w.terminated), '收尾时所有 worker 都该被 terminate');
  });

  await testAsync('workerPool: 边际ρ worker 全部异常退出时应 reject（而不是永久 hang）', async () => {
    const cands = [{ field: 'a', camp: 'hero', interval: { lo: 5, hi: Infinity } },
                   { field: 'b', camp: 'evil', interval: { lo: 0, hi: 2 } }];
    const res = await withFakeWorkers(['error', 'error'], () =>
      Promise.race([
        evaluateCandidatesWithWorkers(rows, [], cands, { concurrency: 2, batchSize: 1 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT: 池子永不结束（就是这个 bug 本身）')), 2000)),
      ]));
    assert.strictEqual(res.ok, false, '全部 worker 异常退出时应当 reject，让上层回退主线程串行');
    assert.ok(!/TIMEOUT/.test(res.error.message), res.error.message);
    assert.ok(FakeWorker.instances.every(w => w.terminated), '异常退出的 worker 必须被 terminate');
  });

  await testAsync('workerPool: 边际ρ 正常路径应按 camp:field 返回每个候选的结果', async () => {
    const cands = [{ field: 'a', camp: 'hero', interval: { lo: 5, hi: Infinity } },
                   { field: 'b', camp: 'evil', interval: { lo: 0, hi: 2 } }];
    const res = await withFakeWorkers(['ok', 'ok'], () =>
      evaluateCandidatesWithWorkers(rows, [], cands, { concurrency: 2, batchSize: 1 }));
    assert.strictEqual(res.ok, true, res.ok ? '' : res.error.message);
    const keys = res.value.map(r => r.camp + ':' + r.field).sort();
    assert.deepStrictEqual(keys, ['evil:b', 'hero:a'], '两个候选都该有结果，且阵营不能串');
  });
}
