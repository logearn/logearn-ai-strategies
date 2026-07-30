// 全字段因子推荐（方案 A）：绕开候选表那条链路里【唯一一道纯粹是技术限制】的削减，直接对
// 跨类的全量字段现挖区间，再原样喂给 recommendFactorPool 的四段流水线
// （held-out 贪心 → 全样本精配权 → 影子权重校验 → K折 k*）。
//
// 只绕过 fieldScope（见 ui/FactorLab.jsx 的 recommendCandidates）：候选表一次只扫"原字段"或
// "组装字段"其中一类，贪心看不到另一类——这是扫描成本导致的分批，不代表任何人的判断，绕过是纯收益。
//
// 下面这三道【都不绕过】，全是"人已经表过态"或"数据不可靠"，绕过去等于让算法推翻人的判断：
//   1. exclusions —— 用户在候选表上手点「移除」的字段。调用方按阵营传两份名单进来
//      （fields 收 { hero, evil } 形态），这里只在名单内的阵营挖区间。
//      曾经这一道是绕过的，代价在真实数据上立刻兑现：318 个字段挖出 525 个候选（候选表两阵营
//      加起来才 361 个），被人工否掉的 138/133 个字段全部复活，贪心第一步就捡回了一个事后字段。
//   2. blacklist —— "不许算法选它"的显式意图，照常经 opts.blacklist 传给贪心。
//   3. 缺失率 —— 非缺失样本太少的字段，held-out 增量容易只是在极小样本上凑巧；readme 里
//      "算推荐会挑进缺失率95%+的字段"那次事故就是这么来的，它是数据可靠性问题，不是显著性门槛。
//
// 为什么能"现挖"：贪心只吃候选对象的 { field, camp, interval } 三样（recommendFactorPath 的 pool
// 过滤 + buildFactors 按 'camp:field' 查区间 + autoWeights 读 interval.score）。候选表里那些贵的
// 统计量——AUC 的 bootstrap CI（200次重采样）、区间的置换检验（200次重扫）、BH 多重比较校正——
// 全都只喂候选表的展示列和显著性判定，**没有一个进入贪心的决策**。所以这里整套跳过，
// 单字段成本从"2×200 次重算"降到"2 次窗口扫描"，全量几百个字段才跑得动。
//
// 代价（UI 上必须说清楚，别让人误读）：候选的 interval.pPermutation 恒为 1、没有 pAdj/
// significantAdj —— 那是"这个检验根本没做"，不是"做了且不显著"。要看区间显著性，回候选表。
import { findHotInterval, findColdInterval, missingRate, recommendFactorPool } from './factorLab.js';
import { AUC_TARGET_FIELDS } from './auc.js';
import { WIN_THRESHOLD } from './utils.js';

// fields 的两种形态归一成 { hero, evil } 两份名单：
//   - 数组：老口径，两个阵营都用同一份（没有 exclusions 概念的调用方，比如单测/脚本）；
//   - { hero, evil }：调用方已按阵营剔过 exclusions，各阵营只挖自己名单里的字段。
// 分阵营而不是取交集：exclusions 本身就是按 camp+field 记的——同一个字段完全可能"允许当勇者、
// 不许当邪恶"，合并成一份名单会把这个区分抹掉。
export function normalizeCampFields(fields) {
  if (Array.isArray(fields)) return { hero: fields, evil: fields };
  return { hero: fields?.hero || [], evil: fields?.evil || [] };
}

// 全字段轻量扫描：每个字段在【它被允许的阵营】里各挖一次区间，挖得出来的就是一个候选。
// permB:0 关掉区间置换检验（理由见文件头）；minCoverage 沿用主扫描的 0.3，保持区间形状口径一致。
// onProgress(done, total) 用于 worker 侧回报进度；跨 worker 边界传不了函数，所以只在 worker
// 内部（或主线程兜底路径）自己调，不进 opts 的序列化 payload。
export function scanIntervalsLite(rows, fields, opts = {}) {
  const { winThreshold = WIN_THRESHOLD, minCoverage = 0.3, maxMissRate = 1, onProgress = null } = opts;
  const camps = normalizeCampFields(fields);
  const allow = {
    hero: new Set(camps.hero.filter(f => !AUC_TARGET_FIELDS.has(f))),
    evil: new Set(camps.evil.filter(f => !AUC_TARGET_FIELDS.has(f))),
  };
  // 扫描名单 = 两份的并集；缺失率只跟字段有关、跟阵营无关，所以按字段算一次就够。
  const scanned = [...new Set([...allow.hero, ...allow.evil])];
  const candidates = [];
  const skipped = [];
  for (let i = 0; i < scanned.length; i++) {
    const field = scanned[i];
    const miss = missingRate(rows, field);
    if (miss > maxMissRate) {
      skipped.push({ field, reason: `缺失率 ${(miss * 100).toFixed(1)}% 超过上限` });
    } else {
      let got = 0;
      for (const camp of ['hero', 'evil']) {
        if (!allow[camp].has(field)) continue;   // 这个阵营被「移除」过，跳过
        const find = camp === 'evil' ? findColdInterval : findHotInterval;
        const interval = find(rows, field, { winThreshold, minCoverage, permB: 0 });
        if (interval && !interval.error) {
          // liteScan 标记跟着候选一路传到 UI：显著性列该显示"未检验"而不是"不显著"。
          candidates.push({ field, camp, interval, missRate: miss, liteScan: true });
          got++;
        }
      }
      if (!got) skipped.push({ field, reason: '允许的阵营都没挖出可用区间' });
    }
    if (onProgress) onProgress(i + 1, scanned.length);
  }
  return { candidates, skipped, scannedCount: scanned.length };
}

// 扫描 + 推荐一条龙。opts 除下面两个自己消化的，其余原样透传给 recommendFactorPool
// （threshold / missingPolicy / shape / startFactors / blacklist / beamWidth / backward / monotoneGate …）。
// 返回 recommendFactorPool 的结果 + scanStats（UI 要显示"从多少字段里挖出多少候选"）。
export function recommendFromAllFields(rows, fields, opts = {}) {
  const { maxMissRate = 1, minCoverage = 0.3, onProgress = null, ...rest } = opts;
  const scan = scanIntervalsLite(rows, fields, {
    winThreshold: rest.threshold ?? WIN_THRESHOLD, minCoverage, maxMissRate, onProgress,
  });
  const scanStats = {
    scannedCount: scan.scannedCount,
    candidateCount: scan.candidates.length,
    heroCount: scan.candidates.filter(c => c.camp === 'hero').length,
    evilCount: scan.candidates.filter(c => c.camp === 'evil').length,
    skippedCount: scan.skipped.length,
  };
  if (!scan.candidates.length) {
    return { path: [], scanStats, error: `${scan.scannedCount} 个字段里没有一个挖得出区间——先降低高倍阈值或多攒数据` };
  }
  return { ...recommendFactorPool(rows, scan.candidates, rest), scanStats };
}

// ---------- 方案擂台：同一份数据上把几种"候选池 × 搜索策略"的组合各跑一遍，纵向摆开比 ----------
// 解决的问题：候选池扩大（全字段）和搜索加强（beam/后向/闸门）各自贡献多少，分开跑两张卡是看不出来的
// ——每张卡只给自己那一个数字，跨卡比还要人肉记。这里一次跑完，同一套口径下并排列。
//
// 排序键用 **K折曲线在 k* 处的 test ρ**，不是"精配权后的全样本 ρ"：后者是在全样本上配的权重、
// 又在全样本上打的分，方案越激进（候选池越大、beam 越宽）它越虚高，拿它排名等于奖励过拟合。
// k* 处的 K 折 test ρ 是这几个数里唯一"每折重推边界+重配权、按 token 分组、还砍掉了过拟合尾巴"的，
// 跨方案可比。次选 rhoTest（影子权重，单次切分）。
export const DEFAULT_PLANS = [
  { key: 'base', name: '候选表 · 单路径', pool: 'scan', search: {} },
  { key: 'scanPlus', name: '候选表 · beam3+后向+闸门', pool: 'scan', search: { beamWidth: 3, backward: true, monotoneGate: true } },
  { key: 'full', name: '全字段 · 单路径', pool: 'full', search: {} },
  { key: 'fullPlus', name: '全字段 · beam3+后向+闸门', pool: 'full', search: { beamWidth: 3, backward: true, monotoneGate: true } },
  { key: 'fullBeam5', name: '全字段 · beam5+后向', pool: 'full', search: { beamWidth: 5, backward: true } },
];

// 一个方案跑完之后抽成一行摘要——UI 表格和导出报告共用这一份，避免两处各抽各的、字段名漂移。
function summarizePlan(plan, res, ms) {
  const curve = res.heldoutCurve;
  const kStar = res.recommendedCount;
  const kStarRho = curve ? (curve.curve.find(c => c.k === kStar)?.testRho ?? NaN) : NaN;
  const last = res.path && res.path.length ? res.path[res.path.length - 1] : null;
  return {
    key: plan.key, name: plan.name, pool: plan.pool, search: plan.search,
    error: res.error || null,
    factorCount: res.path ? res.path.length : 0,
    kStar: Number.isFinite(kStar) ? kStar : null,
    kStarRho,                                  // ← 主排序键
    kBestRho: curve ? curve.bestTestRho : NaN,
    rhoAfter: res.rhoAfter, rhoTrain: res.rhoTrain, rhoTest: res.rhoTest,
    overfit: !!res.overfit,
    zigzag: last?.testZigzag?.inversionCount ?? null,
    zeroedCount: res.zeroedFields ? res.zeroedFields.length : 0,
    stopReason: res.stopReason || null,
    ms,
    // 采用时要用的完整因子对象（截断到 k* 的那份），跟表格行绑在一起——用户在擂台上看中哪行
    // 就直接采用哪行，不用再回到对应的卡片重跑一遍。
    factors: res.factorsTrimmed || res.factors || null,
    path: res.path || [],
    scanStats: res.scanStats || null,
  };
}

// rows/fields/candidates 三样都要：pool:'scan' 的方案吃调用方传进来的 candidates（候选表那份，
// 已经过 fieldScope/exclusions/缺失率），pool:'full' 的吃现挖的——现挖那份同样过 exclusions/缺失率，
// 只是不受 fieldScope 分批限制（见文件头），所以两种池子的差异【只剩】跨类字段这一项。
// 全字段扫描【只做一次】，所有 full 方案共用——它是这里最贵的一步，每个方案各扫一遍纯属浪费。
export function compareRecommendPlans(rows, opts = {}) {
  const { fields = [], candidates = [], plans = DEFAULT_PLANS,
          maxMissRate = 1, minCoverage = 0.3, onPlanDone = null, ...common } = opts;
  let fullCands = null, fullScanStats = null;
  const rowsOf = plan => {
    if (plan.pool !== 'full') return { cands: candidates, stats: null };
    if (!fullCands) {
      const s = scanIntervalsLite(rows, fields, {
        winThreshold: common.threshold ?? WIN_THRESHOLD, minCoverage, maxMissRate });
      fullCands = s.candidates;
      fullScanStats = { scannedCount: s.scannedCount, candidateCount: s.candidates.length,
        heroCount: s.candidates.filter(c => c.camp === 'hero').length,
        evilCount: s.candidates.filter(c => c.camp === 'evil').length,
        skippedCount: s.skipped.length };
    }
    return { cands: fullCands, stats: fullScanStats };
  };

  const out = [];
  for (const plan of plans) {
    const t0 = Date.now();
    const { cands, stats } = rowsOf(plan);
    let res;
    try {
      res = cands.length
        ? recommendFactorPool(rows, cands, { ...common, ...plan.search })
        : { path: [], error: plan.pool === 'full' ? '全字段没挖出任何区间' : '候选表没有可用候选（先扫描）' };
    } catch (err) {
      res = { path: [], error: String(err && err.message || err) };
    }
    const row = summarizePlan(plan, { ...res, scanStats: stats }, Date.now() - t0);
    out.push(row);
    if (onPlanDone) onPlanDone(row, out.length, plans.length);
  }
  // 排序键见文件上方说明：k* 处的 K 折 test ρ 优先，退化到影子权重 rhoTest，都没有的排最后。
  const keyOf = r => (Number.isFinite(r.kStarRho) ? r.kStarRho
    : Number.isFinite(r.rhoTest) ? r.rhoTest : -Infinity);
  const ranked = out.slice().sort((a, b) => keyOf(b) - keyOf(a));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return { rows: out, ranked, best: ranked[0] || null };
}
