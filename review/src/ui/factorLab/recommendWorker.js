import { computeHeldOutDeltaRho,
         recommendFactorPool, permutationNullMarginalRho } from '../../lib/factorLab.js';
import { recommendFromAllFields, compareRecommendPlans } from '../../lib/fullFieldRecommend.js';

// 因子推荐/边际评估的计算 worker——把主线程会冻住页面的三类重活都搬到这里：
//   1. 逐候选并行评估（per-candidate，主线程用 workerPool 切批派发）
//        { type:'eval', taskId, currentFactors, candidates, opts }（rows 走 init 缓存，见下）
//        一律 computeHeldOutDeltaRho（held-out 边际ρ）——「计算候选边际ρ贡献」按钮和「算推荐」
//        的候选预筛是同一个统计量。2026-07-29 前按钮走 opts.job:'marginal' → factorMarginalRho
//        （样本内、无切分），两套口径并存，挑因子那一步因此没有过拟合防护；现在只剩这一套，
//        job 参数一并取消。
//   2. 整条推荐（whole function，单 worker 跑完发回）
//        { type:'recommend', taskId, rows, candidates, opts }  → 「算推荐」
//        2026-07-29 前这里是 recommendPath / recommendFull 两条消息，对应 UI 上两张推荐卡片；
//        两张卡合并成一张后只剩这一条（起点池走 opts.startFactors，不再单独一个 payload 字段）。
//
// 2026-07-28 修复（历史，勿删注释）：computeHeldOutDeltaRho 曾少传一个参数，opts 整个落进
// winThreshold 位置，赢家标签全灭、candidate 100% 报错，被假通过测试掩盖过很久。现在参数对齐了。
//
// 2026-07-28 再修（真实数据实测"算推荐"冻页面）：workerPool.evaluateCandidatesWithWorkers 逐批
// postMessage 时曾经把完整 rows 跟着每一批一起发——候选数远多于 batchSize 时，同一份 rows（871行×
// 完整嵌套ctx，单行可能几十KB）被结构化克隆几十遍，克隆本身在【发送方主线程】同步跑，真实数据上
// 直接把主线程干到 FPS=1、单个长任务 800~1400ms。跟 scanWorker.js 当初"逐批带rows"踩的是同一个坑，
// 这次照抄同一个修法：rows 只在 worker 建好时 init 一次并缓存，之后的 eval 消息不再带 rows。
// buildRows（候选区间实际是在哪份行集上挖出来的）同样只在 init 时收一次并缓存——它跟 rows 一样大，
// 留在每批 eval 的 opts 里会被逐批重复克隆，是同一个坑的另一条支路。
// 注：残差模式删除后（2026-07-29），buildRows 只在"用户改了数据筛选、rows 换了一份但还没重扫"
// 时才与 rows 不同——候选是老那批，梯形边界就得回到挖出它们的那份数据上推。
let cachedRows = null;
let cachedBuildRows = null;
self.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === 'init') {
    cachedRows = msg.rows;
    cachedBuildRows = msg.buildRows || null;
    return;
  }

  // ---- 整条推荐贪心 / 置换零分布：单 worker 跑完整个纯函数，主线程只等结果，全程不冻 ----
  // permNull 会被主线程按 permutations 切成几片各发一个 worker（每片 seed 不同），
  // 各片返回的 deltas 由主线程合并后统一汇总分位数——见 workerPool.runPermutationNullWithWorkers。
  if (msg.type === 'recommend' || msg.type === 'permNull') {
    try {
      const rows = msg.rows || cachedRows;
      const res = msg.type === 'permNull'
        ? permutationNullMarginalRho(rows, msg.currentFactors || [], msg.candidates,
            (msg.opts && msg.opts.winThreshold), msg.opts || {})
        : recommendFactorPool(rows, msg.candidates, msg.opts || {});
      self.postMessage({ type: 'result', taskId: msg.taskId, whole: res });
    } catch (err) {
      self.postMessage({ type: 'error', taskId: msg.taskId, error: String(err && err.stack || err) });
    }
    return;
  }

  // ---- 全字段推荐（方案A）：字段名列表进来，worker 里现挖区间再跑贪心 ----
  // 跟 'recommend' 分开而不是复用：它收的是 fields（字符串数组，几 KB），不是已经扫好的
  // candidates；扫描那一步（几百个字段 × 两阵营挖区间）本身就是主线程扛不住的重活，
  // 必须在 worker 内做完再一起返回，不能让主线程先扫好再发进来。
  // 进度按字段回报（progress 消息），主线程只用来画进度条，不影响结果。
  if (msg.type === 'recommendAll') {
    try {
      const rows = msg.rows || cachedRows;
      let last = -1;
      const res = recommendFromAllFields(rows, msg.fields || [], {
        ...(msg.opts || {}),
        onProgress: (done, total) => {
          // 节流到整百分比：几百个字段逐个 postMessage 会把主线程的消息队列淹掉
          const pct = Math.floor(done / Math.max(total, 1) * 100);
          if (pct !== last) { last = pct; self.postMessage({ type: 'progress', taskId: msg.taskId, pct }); }
        },
      });
      self.postMessage({ type: 'result', taskId: msg.taskId, whole: res });
    } catch (err) {
      self.postMessage({ type: 'error', taskId: msg.taskId, error: String(err && err.stack || err) });
    }
    return;
  }

  // ---- 方案擂台：几种"候选池 × 搜索策略"各跑一遍，一次返回一张可排序的对比表 ----
  // 进度按【方案】回报（不是按字段）：这里最贵的全字段扫描在 compareRecommendPlans 内部只做一次，
  // 之后每个方案就是一次贪心，粒度到方案刚好——再细就要把回调塞进贪心内层，不值当。
  if (msg.type === 'comparePlans') {
    try {
      const rows = msg.rows || cachedRows;
      const res = compareRecommendPlans(rows, {
        ...(msg.opts || {}), fields: msg.fields || [], candidates: msg.candidates || [],
        plans: msg.plans,
        onPlanDone: (row, done, total) => self.postMessage({
          type: 'progress', taskId: msg.taskId, pct: Math.floor(done / Math.max(total, 1) * 100),
          note: row.name,
        }),
      });
      self.postMessage({ type: 'result', taskId: msg.taskId, whole: res });
    } catch (err) {
      self.postMessage({ type: 'error', taskId: msg.taskId, error: String(err && err.stack || err) });
    }
    return;
  }

  if (msg.type !== 'eval') return;
  const { taskId, currentFactors, candidates, opts } = msg;
  const rows = msg.rows || cachedRows;
  try {
    // 2026-07-29：目标函数只剩全程 ρ（computeHeldOutDeltaRho 内部默认的 scorePoolRho）。
    // 此前这里有个 opts.scoreMode:'bucketRho' 分支在 worker 内本地重建分层秩相关目标函数
    // （scoreFn 是函数，没法跨 worker 边界传，只能传字符串标记）；分层秩相关整条线已删除，
    // 分支连同 scorePoolBucketRho 的 import 一并去掉——那个 import 曾让本 worker 链接失败、
    // 整个 vite build 挂掉。
    const { threshold, buildRows, ...restOpts } = opts || {};
    const results = candidates.map(c => {
      try {
        // buildRows 只在"候选挖自另一份行集"时才有值（见文件顶部说明）；同一份时为 null，
        // computeHeldOutDeltaRho 直接用 rows 的 train 段。
        const r = computeHeldOutDeltaRho(rows, currentFactors || [], c, c.camp, threshold,
          { ...restOpts, buildRows: buildRows || cachedBuildRows || null });
        return { field: c.field, camp: c.camp, result: r };
      } catch (err) {
        return { field: c.field, camp: c.camp, error: String(err) };
      }
    });
    self.postMessage({ type: 'result', taskId, results });
  } catch (err) {
    self.postMessage({ type: 'error', taskId, error: String(err) });
  }
});
