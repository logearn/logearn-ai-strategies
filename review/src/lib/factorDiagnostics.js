// ========== 因子诊断：把"手算出来的判断"固化成函数 ==========
//
// 背景（readme 第 44 节）：42/43 两轮里最重要的三个结论——顶档塌陷的根因、
// 权重跟证据反向、饱和块由哪几个因子拼出来——全是人拿着 5 份报告交叉【手算】出来的：
//   摆幅 = 权重/Σ勇者×100 · 满命中样本数 · 缺失样本落在哪一档 · 顶档 lift 是不是 <1
// 这些手算是固定套路，本模块把它们变成函数，让报告直接给结论而不是给素材。
//
// 全部是纯函数、无 UI 依赖，方便测试；口径一律复用 factorLab.js 的既有实现
// （factorHitProfile / heroWeightSum / scoreRows / getFeatureValue），不另写一份近似的。
import {
  factorHitProfile, heroWeightSum, scoreRows, baseStats, getFeatureValue,
  sweepScoreCutoffs, recommendCutoff, buildScoreDeciles, scorePoolRho,
  NEAR_DEGENERATE_HIT_SHARE,
} from './factorLab.js';
import { percentile, spearman, WIN_THRESHOLD } from './utils.js';

// ---------- 1. 因子影响力：摆幅 / 满命中占比 / 有效区分样本数 ----------
// 「权重」这个数会误导：它是原始配比，真正决定一个因子能把分数推多远的是
// **摆幅 = 权重 / Σ勇者权重 × 100**（scoreRow 的归一分母只累加勇者，见 readme 第 33 节）。
// 42 轮的真实案例：above_below_ratio 权重 36.8 / Σ勇者 81.7 → 摆幅 45.0，
// 比任何一个别的因子都大，而它的 held-out Δρ 只有 0.023（最低）。
// 光看权重列看不出这件事，因为 Σ勇者 不在同一张表里。
//
// 「有效区分样本数」= n × (1 − modalShare)：这个因子真正在区分的样本有多少个。
// 一个 90% 满命中的因子，哪怕摆幅 45，也只对 10% 的样本说话——剩下 90% 拿的是同一个分。
export function factorInfluence(rows, factors) {
  const list = factors || [];
  const heroSum = heroWeightSum(list);
  return list.map(f => {
    const p = factorHitProfile(rows || [], f);
    const w = Number(f.weight) || 0;
    const swingAbs = heroSum > 0 ? (w / heroSum) * 100 : NaN;
    return {
      factor: f, field: f.field, camp: f.camp, weight: w,
      // 有符号摆幅：邪恶只能往下推，勇者只能往上推（单个梯形跨不过零，见 readme 40.2）
      swing: f.camp === 'evil' ? -swingAbs : swingAbs,
      swingAbs,
      modalShare: p.modalShare, modalHit: p.modalHit, distinct: p.distinct, n: p.n,
      effectiveN: Number.isFinite(p.modalShare) ? Math.round(p.n * (1 - p.modalShare)) : NaN,
      nearDegenerate: Number.isFinite(p.modalShare) && p.modalShare >= NEAR_DEGENERATE_HIT_SHARE,
    };
  });
}

// ---------- 2. 噪声地板：推荐路径该采纳前几步 ----------
// held-out Δρ 的噪声地板 = 该 test 集上 spearman ρ 的标准误 ≈ 1/√(n−3)。
// readme 36.4 第 2 条把它写死成 0.064（对应 n≈218），但它显然是随样本量变的，
// 所以这里现算——换个切分比例、换批数据，这条线就该跟着动。
export function rhoNoiseFloor(nTest) {
  const n = Number(nTest);
  if (!Number.isFinite(n) || n < 6) return NaN;
  return 1 / Math.sqrt(n - 3);
}

// 贪心路径必须按【前缀】切，不能逐步过滤：第 5 步的 Δρ 是"在前 4 步基础上"的增量，
// 把第 3 步摘掉之后第 5 步那个数就不成立了。所以从头走，遇到第一个低于地板的就停。
// adoptCount=0 是有意义的结论（连第一步都在噪声里），不要当成"出错了"。
export function splitPathByNoiseFloor(path, nTest) {
  const list = path || [];
  const floor = rhoNoiseFloor(nTest);
  if (!Number.isFinite(floor)) {
    return { floor: NaN, adoptCount: list.length, adopt: list.slice(), noise: [], unknown: true };
  }
  let k = 0;
  while (k < list.length && Number.isFinite(list[k].deltaTest) && list[k].deltaTest >= floor) k++;
  return { floor, adoptCount: k, adopt: list.slice(0, k), noise: list.slice(k), unknown: false };
}

// ---------- 3. 权重 ↔ 证据 是否对齐 ----------
// 按摆幅排一遍、按 held-out Δρ 排一遍，两个排名对不上就是"弱因子权重过高"（诊断清单第 2 条）。
// 用秩相关给一个总体指标，再挑出最刺眼的那一对具体点名——只给一个 rankRho 数字，
// 用户还是不知道该去动哪个因子。
export function weightEvidenceAlignment(influences, path) {
  const ev = new Map();
  for (const p of path || []) ev.set(p.camp + ':' + p.field, Number(p.deltaTest));
  const rows = (influences || [])
    .filter(i => ev.has(i.camp + ':' + i.field) && Number.isFinite(ev.get(i.camp + ':' + i.field)))
    .map(i => ({
      field: i.field, camp: i.camp, weight: i.weight,
      swingAbs: i.swingAbs, deltaTest: ev.get(i.camp + ':' + i.field),
    }));
  if (rows.length < 2) return { rows, inversions: 0, worst: null, rankRho: NaN };

  const bySwing = rows.slice().sort((a, b) => b.swingAbs - a.swingAbs);
  bySwing.forEach((r, idx) => { r.swingRank = idx + 1; });
  rows.slice().sort((a, b) => b.deltaTest - a.deltaTest).forEach((r, idx) => { r.evidenceRank = idx + 1; });

  let inversions = 0, worst = null, worstGap = 0;
  for (let i = 0; i < bySwing.length; i++) {
    for (let j = i + 1; j < bySwing.length; j++) {
      // i 摆幅更大；若 i 的证据反而更弱，就是一处倒挂
      if (bySwing[i].deltaTest < bySwing[j].deltaTest) {
        inversions++;
        // "最刺眼"= 摆幅倍数 × 证据倍数，两个方向的落差都算进去
        const swingRatio = bySwing[j].swingAbs > 0 ? bySwing[i].swingAbs / bySwing[j].swingAbs : Infinity;
        const evRatio = bySwing[i].deltaTest > 0 ? bySwing[j].deltaTest / bySwing[i].deltaTest : Infinity;
        const gap = swingRatio * evRatio;
        if (gap > worstGap) { worstGap = gap; worst = { heavy: bySwing[i], strong: bySwing[j] }; }
      }
    }
  }
  const rankRho = spearman(rows.map(r => [r.swingAbs, r.deltaTest]));
  return { rows: bySwing, inversions, worst, rankRho };
}

// ---------- 4. 顶档体检 ----------
// 42/43 两轮最重要的发现都在这里，但都要人翻第 7 节（十分位）和第 6 节（cutoff 扫描）交叉比对。
// 三件事一次算完：
//   ① 最高分那一档的 lift 是不是低于 1.0（"越高分越差"的顶部反转，42 轮 cut80 = 0.95）
//   ② 同分饱和块有多大、块内 lift 多少（43 轮 198 个 @100 分、块内只有 1.16）
//   ③ 高分段里有没有 lift <1.0 的档位（比只看最顶一档更敏感）
const SCORE_BUCKET = 1e6;   // 分数是浮点，按 1e-6 归桶再数众数（同 factorHitProfile 的做法）

export function topBinHealth(backtest, winThreshold = WIN_THRESHOLD, opts = {}) {
  const { minTriggered = 20, highCutFrac = 0.5 } = opts;
  const { scored, deciles, sweep, base } = backtest || {};
  if (!scored?.length || !base?.n || !(base.baseRate > 0)) return null;

  const bins = deciles?.length ? deciles : buildScoreDeciles(scored, winThreshold);
  const top = bins[bins.length - 1] || null;
  const topBin = top ? {
    bin: top.bin, n: top.n, pos: top.pos, hiRate: top.hiRate,
    lift: top.hiRate / base.baseRate,
    scoreLo: top.scoreLo, scoreHi: top.scoreHi,
  } : null;

  // 同分饱和块：最大的一撮同分样本
  const counts = new Map();
  for (const s of scored) {
    const k = Math.round(s.score * SCORE_BUCKET);
    let e = counts.get(k);
    if (!e) counts.set(k, e = { n: 0, pos: 0 });
    e.n++;
    if (Number(s.row.returnMax) > winThreshold) e.pos++;
  }
  let modalKey = null, modal = { n: 0, pos: 0 };
  for (const [k, e] of counts) if (e.n > modal.n) { modalKey = k; modal = e; }
  const saturation = modal.n ? {
    score: modalKey / SCORE_BUCKET,
    n: modal.n, pos: modal.pos,
    share: modal.n / scored.length,
    hiRate: modal.pos / modal.n,
    lift: (modal.pos / modal.n) / base.baseRate,
    // 这个块横跨几个十分位——横跨越多，第 7 节那几档的差异就越是随机切分的产物
    spansBins: bins.filter(b => b.scoreLo <= modalKey / SCORE_BUCKET + 1e-9
                             && b.scoreHi >= modalKey / SCORE_BUCKET - 1e-9).length,
  } : null;

  // 高分段里 lift <1.0 的档位：只看分数轴上半段（highCutFrac 以上），且触发数够
  const pts = sweep?.points || sweepScoreCutoffs(scored, winThreshold).points;
  let highCutWarning = null;
  if (pts?.length) {
    const lo = pts[0].cut, hi = pts[pts.length - 1].cut;
    const from = lo + (hi - lo) * highCutFrac;
    for (const p of pts) {
      if (p.cut < from || p.triggered < minTriggered || !Number.isFinite(p.lift)) continue;
      if (p.lift < 1) {
        // 取最严重的（lift 最低）
        if (!highCutWarning || p.lift < highCutWarning.lift) highCutWarning = { ...p };
      }
    }
  }

  return {
    topBin,
    topBinBelowBase: !!(topBin && topBin.lift < 1),
    saturation,
    saturated: !!(saturation && saturation.share >= 0.1),
    highCutWarning,
    baseRate: base.baseRate,
  };
}

// ---------- 5. 缺失样本的影响（必须按阵营分开讲） ----------
// factorLab.js 那句"缺失记 0 分、惩罚的是数据覆盖、偏保守"**只在勇者阵营下成立**：
//   勇者缺失 → 拿不到加分 → 惩罚（保守）
//   邪恶缺失 → 躲掉扣分 → **奖励**（激进）
// 42 轮的事故就是后者：holder_gini 缺失 40 个样本白得 22.5 分，被顶到分数最高处，
// 顶档因此变成"我们对它一无所知"的那批人，高倍率跌破基准。
// 这里把这件事直接算出来：白得/白失多少分、这批样本的高倍率是多少、它们的平均分排在哪。
export function missingImpact(rows, factors, winThreshold = WIN_THRESHOLD, opts = {}) {
  const { missingPolicy = 'zero' } = opts;
  const list = factors || [];
  const all = rows || [];
  if (!all.length || !list.length) return [];
  const heroSum = heroWeightSum(list);
  const scored = scoreRows(all, list, { missingPolicy });
  const scoreById = new Map(scored.map(s => [s.row, s.score]));
  const overallBase = baseStats(all, winThreshold);

  const out = [];
  for (const f of list) {
    const miss = all.filter(r => !Number.isFinite(getFeatureValue(r, f.field)));
    if (!miss.length) continue;
    const w = Number(f.weight) || 0;
    const swingAbs = heroSum > 0 ? (w / heroSum) * 100 : NaN;
    const pos = miss.filter(r => Number(r.returnMax) > winThreshold).length;
    const scores = miss.map(r => scoreById.get(r)).filter(Number.isFinite).sort((a, b) => a - b);
    out.push({
      field: f.field, camp: f.camp, weight: w,
      missingN: miss.length, missingRate: miss.length / all.length,
      // 邪恶：缺失=躲掉扣分=白【得】分；勇者：缺失=拿不到加分=白【失】分
      direction: f.camp === 'evil' ? 'bonus' : 'penalty',
      points: swingAbs,
      pos, hiRate: miss.length ? pos / miss.length : NaN,
      lift: overallBase.baseRate > 0 && miss.length ? (pos / miss.length) / overallBase.baseRate : NaN,
      medScore: scores.length ? percentile(scores, 0.5) : NaN,
      // 这批缺失样本的分数中位，在全样本里排在多少分位——越高越危险（被顶到顶档）
      medScorePct: scores.length ? quantileOfValue(scored.map(s => s.score), percentile(scores, 0.5)) : NaN,
    });
  }
  // 最危险的排最前：邪恶阵营 + 分数分位高 + 数量多
  return out.sort((a, b) => (b.direction === 'bonus') - (a.direction === 'bonus')
    || (b.medScorePct - a.medScorePct) || (b.missingN - a.missingN));
}

function quantileOfValue(values, v) {
  if (!values?.length || !Number.isFinite(v)) return NaN;
  let below = 0;
  for (const x of values) if (Number.isFinite(x) && x < v) below++;
  return below / values.length;
}

// ---------- 6. cutoff：补上倍数中位 + 临界点大倍数告警 ----------
// lift 按 ">阈值与否" 二元计数，**一个 208x 和一个 3.1x 完全等重**（readme 43.5）。
// 43 轮的真实案例：全样本最大赢家 208.35x 得分 83.3，被 cutoff=84 差 0.7 分挡在外面，
// 而扫描表上 84 那一行只显示"lift 1.28 最高"，看不出这件事。
// 两个补丁：① 每个档位补上触发集的倍数中位/均值；② 临界分附近的大倍数样本单独列出来。
export function enrichSweepWithReturns(sweep, scored, opts = {}) {
  const { } = opts;
  const pts = sweep?.points || [];
  if (!pts.length || !scored?.length) return sweep;
  const sorted = scored.slice().sort((a, b) => b.score - a.score);
  const rets = [];
  let i = 0;
  const out = [];
  // 按 cut 降序走一遍，增量维护触发集的倍数列表（避免每档重新过滤一次全样本）
  for (const p of pts.slice().sort((a, b) => b.cut - a.cut)) {
    while (i < sorted.length && sorted[i].score >= p.cut) {
      const r = Number(sorted[i].row.returnMax);
      if (Number.isFinite(r)) rets.push(r);
      i++;
    }
    const s = rets.slice().sort((a, b) => a - b);
    out.push({
      ...p,
      medRet: s.length ? percentile(s, 0.5) : NaN,
      avgRet: s.length ? s.reduce((a, x) => a + x, 0) / s.length : NaN,
    });
  }
  out.sort((a, b) => a.cut - b.cut);
  return { ...sweep, points: out };
}

// 临界分下方 window 分之内、倍数 ≥ minMultiple 的样本——"差一点就买到了"的大鱼。
export function nearCutoffOutliers(scored, cut, opts = {}) {
  const { window = 3, minMultiple = 10, limit = 10 } = opts;
  if (!scored?.length || !Number.isFinite(cut)) return [];
  return scored
    .filter(s => Number.isFinite(s.score) && s.score < cut && s.score >= cut - window
              && Number(s.row.returnMax) >= minMultiple)
    .map(s => ({
      score: s.score, gap: cut - s.score,
      returnMax: Number(s.row.returnMax),
      symbol: s.row.symbol, tokenAddress: s.row.tokenAddress ?? s.row.ca,
    }))
    .sort((a, b) => b.returnMax - a.returnMax)
    .slice(0, limit);
}

// ---------- 7. 留一法：逐个删因子看会发生什么 ----------
// 判断"这个因子到底有没有用"的决定性检验。三条纪律写死在实现里，别在调用方绕过：
//   ① **不重新配权**——重配权会把"删因子"和"权重变了"两个变量混在一起（readme 43.6）。
//   ② cutoff 每次重新推荐——删掉一个邪恶因子等于给所有分数加一个常数，沿用旧 cutoff
//      测的是"阈值漂了"而不是"因子有没有用"（readme 41.3 那条平移性质）。
//   ③ 同时报 ρ / lift@cutoff / 顶档 lift 三个口径——它们在 42→43 轮打过架，只看一个会误判。
export function leaveOneOutFactors(rows, factors, winThreshold = WIN_THRESHOLD, opts = {}) {
  const { missingPolicy = 'zero' } = opts;
  const list = factors || [];
  if (!rows?.length || list.length < 2) return null;

  const evalPool = pool => {
    if (!pool.length || heroWeightSum(pool) <= 0) return null;   // 纯邪恶池分数恒 0（readme 36.3）
    const scored = scoreRows(rows, pool, { missingPolicy });
    const base = baseStats(rows, winThreshold);
    const sweep = sweepScoreCutoffs(scored, winThreshold);
    const best = recommendCutoff(sweep, {});
    const deciles = buildScoreDeciles(scored, winThreshold);
    const health = topBinHealth({ scored, deciles, sweep, base }, winThreshold);
    // 删剩下的池子可能退化成"人人同分"。**不能靠 ρ 是不是 NaN 来判**——utils.spearman 对
    // 全常数输入返回的是 **0**，不是 NaN（这条是测试抓出来的）。0 看起来像"测出来没关系"，
    // 实际是"根本没得测"，混在一起会让"删了它 ρ 掉到 0"被误读成一个真实的下降。
    // 所以直接数不同分值的个数。
    const distinctScores = new Set(scored.map(s => Math.round(s.score * SCORE_BUCKET))).size;
    return {
      distinctScores,
      rho: scorePoolRho(rows, pool, missingPolicy),
      cut: best?.cut ?? NaN,
      triggered: best?.triggered ?? NaN,
      hitRate: best?.hitRate ?? NaN,
      lift: best?.lift ?? NaN,
      topLift: health?.topBin?.lift ?? NaN,
      saturationShare: health?.saturation?.share ?? NaN,
    };
  };

  const full = evalPool(list);
  if (!full) return null;
  const items = list.map((f, idx) => {
    const pool = list.filter((_, k) => k !== idx);
    const m = evalPool(pool);
    return {
      removed: { field: f.field, camp: f.camp, weight: Number(f.weight) || 0 },
      ...(m || {}),
      pureEvil: !m,
      // 删剩下的池子退化成"人人同分"时，ρ 不是"没变化"而是【测不出来】。
      // 必须跟 dRho=0 严格区分，否则它会混进"删了无损"那一档被当成可以安全删除的因子。
      degenerate: !!(m && m.distinctScores <= 1),
      dRho: m && m.distinctScores > 1 && Number.isFinite(m.rho) && Number.isFinite(full.rho)
        ? m.rho - full.rho : NaN,
      dLift: m && Number.isFinite(m.lift) && Number.isFinite(full.lift) ? m.lift - full.lift : NaN,
      dTopLift: m && Number.isFinite(m.topLift) && Number.isFinite(full.topLift) ? m.topLift - full.topLift : NaN,
    };
  });
  // 删掉之后 ρ 掉得最少的排最前 = 最没用的因子排最前。
  // dRho 可能是 NaN（纯邪恶池 / 删剩下退化），**必须显式沉底**：直接 `b.dRho - a.dRho`
  // 会让比较器返回 NaN，被 Array#sort 当 0 处理，结果顺序未定义（这条是测试抓出来的）。
  // 同值时按字段名兜底，跟 finalizeAucScan / recommendFactorPath 一样保证顺序可复现。
  items.sort((a, b) => {
    const av = Number.isFinite(a.dRho) ? a.dRho : -Infinity;
    const bv = Number.isFinite(b.dRho) ? b.dRho : -Infinity;
    return (bv - av) || a.removed.field.localeCompare(b.removed.field);
  });
  return { full, items };
}

// ---------- 8. 第二个贪心目标：顶档 lift ----------
// 北极星是 ρ，但决策变量是 cutoff —— ρ 由全体样本（79% 的普通盘）驱动，实盘只买顶部薄片。
// 43 轮是活证据：ρ 掉 0.024、而 lift@cutoff / 基线库四天 / 顶档反而全面变好。
// 所以**按 ρ 贪心推出来的因子，天生不是给 cutoff 用的**。
//
// 实现放在 factorLab.js 而不是这里，原因只有一个：**贪心跑在 Worker 里**，
// 函数没法过 structuredClone，所以目标只能以字符串 `opts.objective` 传进去、在那边解析成
// scoreFn。而 factorDiagnostics 已经 import 了 factorLab，反过来再 import 就成了循环依赖。
// 这里 re-export 一份，保持"诊断相关的东西从 factorDiagnostics 拿"这个心智模型不破。
export { makeTopLiftScorer } from './factorLab.js';
