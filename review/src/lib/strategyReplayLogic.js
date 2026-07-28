// StrategyReplay.jsx 专用的纯逻辑（不依赖 React）——从组件里抽出来，方便直接单测、
// 也让组件本体只留状态管理和渲染编排。

import { pearson, pearsonPValue, spearman, wilsonInterval, median, WIN_THRESHOLD } from './utils.js';
import { compileStrategy, runStrategyOnRow, aggregateCheckStats, extractScoreReturnPair } from './proAnalytics.js';

// "Infinity"/"-Infinity" 是生成代码里 ±Infinity 的字面量，界面上显示成 ∞ 更好读
export const prettyBound = s => (s === 'Infinity' ? '∞' : s === '-Infinity' ? '-∞' : s);

// score vs 收益的相关性统计，抽成纯函数——整体/训练集/测试集三处都要用同一套算法，
// 不能各写一份（上次强势盘策略调权重就是靠这套口径，训练集显著不代表数，得看测试集）。
// scores 全相同（打分池为空时的占位常数）时 pearson 分母为 0，提前判出来给人话解释，
// 不能让调用方看到一个语义不明的 r=0（那看起来像"测过了、没关系"，实际是"根本没法测"）。
export function computeScoreReturnStats(pairs) {
  if (pairs.length < 5) return null;
  const n = pairs.length;
  const scores = pairs.map(p => p.score);
  const constant = scores.every(s => s === scores[0]);
  if (constant) return { n, constant: true };
  const rawPairs = pairs.map(p => [p.score, p.ret]);
  const logPairs = pairs.map(p => [p.score, Math.log(p.ret)]);
  const rRaw = pearson(rawPairs), rLog = pearson(logPairs), rho = spearman(rawPairs);
  return { n, constant: false, rRaw, pRaw: pearsonPValue(rRaw, n), rLog, pLog: pearsonPValue(rLog, n), rho };
}

// score 分位 vs 胜率：定打分阈值（CUTOFF）之前必须先看的表——score 按分位切桶后，
// 各桶胜率如果不随分数单调上升，说明 score 本身没有排序能力，这时候调阈值毫无意义。
// 每桶胜率带 Wilson 置信区间：分位桶样本量小（213 条切 10 桶每桶才 21 条），
// 点估计的波动很大，不给区间的话很容易把噪声当规律（±20个百分点的置信宽度是常态）。
export function computeScoreBuckets(pairs, winThreshold = 2) {
  // 每桶至少 ~20 条才有起码的统计意义；数据多切 10 桶（十分位），少切 5 桶，再少就不切了
  const n = pairs.length;
  if (n < 60) return null;
  const K = n >= 200 ? 10 : 5;
  const sorted = pairs.slice().sort((a, b) => a.score - b.score);
  // 相同 score 的样本绝不能被切进不同的桶——否则饱和区（大量样本同分，比如"全通过"=100）会被
  // 等数量切分硬拆成好几个"同分桶"，各自算出不同胜率，制造出假的单调结构（那个 ρ 就不可信了）。
  // 做法：等数量定目标边界后，把边界往后推到"score 真正变化"的位置，让同分样本留在同一桶。
  // 代价是桶大小不再均等（饱和越重越不均），但这是如实反映——同分样本本来就分不出高下。
  const buckets = [];
  let start = 0;
  for (let k = 1; k <= K && start < n; k++) {
    let end = Math.floor(k * n / K);
    if (end <= start) continue;                                   // 上一桶已把这段吃掉（并列推进导致）
    while (end < n && sorted[end].score === sorted[end - 1].score) end++;  // 别在同分处切开
    const chunk = sorted.slice(start, end);
    start = end;
    if (!chunk.length) continue;
    const wins = chunk.filter(p => p.ret > winThreshold).length;
    const ci = wilsonInterval(wins, chunk.length);
    buckets.push({
      idx: buckets.length + 1, n: chunk.length,
      scoreLo: chunk[0].score, scoreHi: chunk[chunk.length - 1].score,
      wins, winRate: wins / chunk.length, ciLo: ci.lo, ciHi: ci.hi,
    });
  }
  // 饱和度：最大同分组占样本的比例。太高（比如 >50% 挤在同一个分数上）时，分位分析没多少意义——
  // 大部分样本 score 一样、天然分不出高下，桶数也会因合并同分而远少于 K。界面据此提示。
  const scoreCounts = new Map();
  for (const p of sorted) scoreCounts.set(p.score, (scoreCounts.get(p.score) || 0) + 1);
  const maxTieFrac = Math.max(...scoreCounts.values()) / n;
  // 单调性：桶序号 vs 桶胜率的 spearman——ρ 高说明"分数高的桶确实胜率更高"这个排序关系成立
  const rho = spearman(buckets.map((b, i) => [i, b.winRate]));
  return { buckets, rho, K, maxTieFrac, effectiveBuckets: buckets.length };
}

// 追加条件时，选了阵营（勇者/危险区）就不再插入普通布尔 AND 条件，而是插入一条
// parseFactorCheck 认得的打分因子（expect 文案要匹配 SCORE_FACTOR_EXPECT_RE：
// /^(?:满分|危险区)\s.*权重\s*[\d.]+/）。权重先统一给同一个数——code-score.js 那次的教训是
// 权重从来不是随手拍准的，得攒数据用「回测·因子」面板校准，这里先让所有新加的因子权重一致，
// 方便你专注调区间，等有真实回测数据了再回来统一校准，不用一个个纠结"这个该给几分"。
export const FACTOR_WEIGHT_DEFAULT = 10;

// 把追加条件的操作符+阈值翻译成打分因子的"满分/危险区"区间文案。">"/">=）是"越大越好(或越大越危险)"，
// 区间开口向上；"<"/"<=" 反过来开口向下；"=="给一个零宽度区间（只有精确等于才算触发）。
// "!="没有自然对应的区间写法，阵营模式下不支持，退回选"无(布尔条件)"或换个操作符。
export function campRangeText(op, val) {
  if (op === '>' || op === '>=') return `${val}~Infinity`;
  if (op === '<' || op === '<=') return `-Infinity~${val}`;
  if (op === '==') return `${val}~${val}`;
  return null;
}
// 同上，但拆成 {lo, hi} 两段数值/字面量文本，供 ALL_CHECKS 行（buildAllChecksRow 的 lo/hi 参数）用——
// 那边要的是能直接拼进 trap(x, lo0, lo1, hi1, hi0) 调用里的字面量，不是拼成一段展示文字。
export function campRangeBounds(op, val) {
  if (op === '>' || op === '>=') return { lo: String(val), hi: 'Infinity' };
  if (op === '<' || op === '<=') return { lo: '-Infinity', hi: String(val) };
  if (op === '==') return { lo: String(val), hi: String(val) };
  return null;
}

// 用 Wilson 置信区间判断"起作用组"和"无效应组"的胜率差异是不是真的，而不是拿一个固定的
// 相对差值阈值（原来是 15%）直接下"反向/有效"结论——两组样本量往往差得很悬殊（比如无效应组
// 只有 11 条、起作用组有 270 条），小样本那侧的胜率点估计本身波动就很大，随便摸到几个高倍盘
// 就能冲到 70%，跟大样本那侧比"谁高"很容易把噪声当规律。只有两组 95% 置信区间完全不重叠，
// 才敢说"反向/有效"；重叠了就老实说"两组接近，样本不够分不出真假"——这跟总分分位桶那张表
// 已经在用的置信区间口径保持一致。
export function factorVerdict({ scoredWin, scoredN, zeroWin, zeroN, camp }) {
  if (scoredN < 5 || zeroN < 5) return { verdict: 'insufficient' };
  const ciScored = wilsonInterval(Math.round(scoredWin * scoredN), scoredN);
  const ciZero = wilsonInterval(Math.round(zeroWin * zeroN), zeroN);
  const scoredHigherConfident = ciScored.lo > ciZero.hi;
  const zeroHigherConfident = ciZero.lo > ciScored.hi;
  const isEvil = camp === 'evil';
  // 勇者阵营：起作用（得分）组置信区间整体高于无效应组 = 有效；邪恶阵营：反过来——
  // 两个阵营对"起作用"这件事的期望本来就相反
  const better = isEvil ? zeroHigherConfident : scoredHigherConfident;
  const worse = isEvil ? scoredHigherConfident : zeroHigherConfident;
  return { verdict: worse ? 'worse' : better ? 'better' : 'close', ciScored, ciZero };
}

// 打分策略本质是加权投票：每个因子是一个投票人，落进自己的"高倍区"就投一票（贡献 +weight），
// 邪恶阵营落进"输家区"投反对票（-weight）。这个投票人靠不靠谱，就看 factorVerdict——
// 只看最新一天的判定结果，不追踪历史。
// * 只有【真反向】（'worse'：两组 95% 置信区间不重叠、方向还反了）才降权重：投票人这次明确
//   投错了，权重 -2；降到 ≤1 就不再是"降一点"能救的，直接建议整条踢出投票团（删除这个 check）。
// * 'close'（分不出真假）【不动】——单看一天的数据，大量因子天然是"这天看不出它好坏"，
//   这不等于"它坏"。早先把 close 也按 -2 处理，结果一天的建议里能冒出十几个删除，
//   会把只是这天没显出信号、其实并不差的因子慢慢误删干净。分不出就先留着，等哪天数据
//   真的把它判成 worse 再降，宁可慢一点也别错杀。
// * 'better'（有效）说明这次投得准，+2 奖励。
// * 'insufficient'（两组样本量不够，见 factorVerdict）什么都不建议——数据还不够判断，
//   瞎调只会引入新噪声，等下次数据更多了再看。
const WEIGHT_STEP = 2;
const WEIGHT_REMOVE_FLOOR = 1;
// 权重上限：默认权重的 2 倍。不封顶的话，一个反复测出 better 的因子会一路 +2 涨下去——
// score 是归一化的（total/wsum*100），某个因子权重涨得越高，它在这个"加权投票"里占的话语权
// 越大，慢慢把其他因子的贡献稀释成噪声，跟"一人一票的投票委员会"初衷相反（变成一个大票仓）。
// 封到 2× 默认值：一个因子最多顶两票，好但不至于独裁。到顶就不再加，返回 none（不是"20→20"空调整）。
export const WEIGHT_MAX = FACTOR_WEIGHT_DEFAULT * 2;
export function suggestWeightAdjustment(verdict, currentWeight, maxWeight = WEIGHT_MAX) {
  if (verdict === 'worse') {
    const next = currentWeight - WEIGHT_STEP;
    return next <= WEIGHT_REMOVE_FLOOR ? { action: 'remove' } : { action: 'adjust', newWeight: next };
  }
  if (verdict === 'better') {
    if (currentWeight >= maxWeight) return { action: 'none' };   // 已封顶，不再加权
    return { action: 'adjust', newWeight: Math.min(maxWeight, currentWeight + WEIGHT_STEP) };
  }
  return { action: 'none' };
}

// ── 跨天累计判定（防单日噪声/whipsaw）────────────────────────────────────────────
// suggestWeightAdjustment 吃的是"某一天的判定"。但小样本下（一天 200 来条快照、~20 个因子
// 各判一遍），单看一天很容易把偶然显著当成"这因子真反向/真有效"，天天照单调权会来回横跳、
// 甚至把只是这天没显信号的好因子慢慢误删。这里在 factorVerdict（单日）之上加一层"要连续几天
// 同向判定才算数"的闸门：连续 N 天都判 worse 才降/删，连续 N 天都判 better 才加，否则先攒着
// 不动（hold）。逐日判定的数据不用额外持久化——回测报告存档（backtestReports）里每天就存了
// campFactors（逐因子 scoredWin/zeroWin/N），直接重算即可。
export const CROSS_DAY_MIN_STREAK = 2;

// 从跨天报告存档里抽某因子的逐日判定（最新在前）。同一日历日可能存过多份报告，取当天最后
// 一份（savedAt 最大）为准，保证"连续 N 天"数的是天数而不是存档次数。reports 里没这个因子的
// 那天直接跳过（不计入连续段——那天它可能还没进策略）。返回 [{ date, verdict }]。
export function dailyFactorVerdicts(name, reports) {
  const byDate = new Map();   // date -> { savedAt, stats }
  for (const r of reports || []) {
    const factors = r && r.metrics && r.metrics.campFactors;
    if (!Array.isArray(factors)) continue;
    const f = factors.find(x => x && x.name === name);
    if (!f) continue;
    const prev = byDate.get(r.date);
    const savedAt = Number(r.savedAt) || 0;
    if (!prev || savedAt >= prev.savedAt) byDate.set(r.date, { savedAt, stats: f });
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))   // 日期倒序，最新在前
    .map(([date, v]) => ({ date, verdict: factorVerdict(v.stats).verdict }));
}

// 把最新在前的逐日判定压成一个累计判定：只有最近连续 >= minStreak 天是同一个"可执行"方向
// （worse / better）才返回该方向，否则 hold（还没连够，先别动）。streak = 已经连续几天同向，
// direction = 当前这串的方向（哪怕还没连够，界面也能显示"反向 1/2 天 · 再观察"）。
// close / insufficient 都会打断连续段——它们不是"反向/有效"，不能算进 streak。
export function accumulateVerdict(verdicts, minStreak = CROSS_DAY_MIN_STREAK) {
  if (!Array.isArray(verdicts) || !verdicts.length) return { verdict: 'hold', streak: 0, minStreak, direction: null };
  const head = verdicts[0];
  if (head !== 'worse' && head !== 'better') return { verdict: 'hold', streak: 0, minStreak, direction: null };
  let streak = 0;
  for (const v of verdicts) { if (v === head) streak++; else break; }
  return { verdict: streak >= minStreak ? head : 'hold', streak, minStreak, direction: head };
}

// 把"今天这次回放的实时判定"接到"历史报告里的逐日判定"前面，得出某因子的跨天累计判定。
// 今天多半还没存报告，所以用实时 stats（todayStats）现算今天这一票；万一今天已经存过报告，
// 按 todayDate 去掉那天的历史项，避免重复计入同一天。返回 accumulateVerdict 的结果，外加
// today（今天的单日判定）——界面用 verdict 决定要不要给建议，用 today+streak 提示"再观察几天"。
export function crossDayVerdict({ name, todayStats, reports, todayDate, minStreak = CROSS_DAY_MIN_STREAK }) {
  const today = factorVerdict(todayStats).verdict;
  const hist = dailyFactorVerdicts(name, reports).filter(d => d.date !== todayDate);
  const acc = accumulateVerdict([today, ...hist.map(d => d.verdict)], minStreak);
  return { ...acc, today };
}

// 把一份策略代码在给定样本上完整跑一遍，算出几个"这版策略好不好"的顶层指标——给"调权建议
// 试算"用：改权重/删因子之前先拿旧代码算一份、拿改完的新代码算一份，两份并排看，才知道
// 这次调整到底是提升还是把策略搞差了，而不是盲目点"应用"。是纯函数（编译+回放+聚合都不碰
// React 状态），跟看板上那套 useMemo 出来的数字同源（aggregateCheckStats / computeScoreReturnStats
// / computeScoreBuckets），所以试算出来的口径和应用之后看板显示的完全一致。
// 返回 { ok, error?, total, hits, spearmanRho, decileRho, passRate, hit2/hit5/hit10, hitMedian, missMedian, rLog }：
// 判定一次改动好不好的【北极星】默认是 score↔returnMax 的强单调性——分数越高倍率越高，高倍集中在高分、
// 低倍落在低分。越强越好。这就是策略回放看板那张散点图 + 底下 spearman ρ 想量的东西，也是大多数调权/
// 删因子的终极目标。高倍率命中率是这个目标的一种体现（高倍确实落到了高分才会命中），一起看。
// 例外：若策略第一目标是"筛垃圾"，北极星降级为过线/未过线两层台阶（见 lib/factorLab.js 的
// scorePoolTierGain），此时本函数的 spearmanRho/decileRho 仍可作参考，但不是唯一判据。
//   spearmanRho  score 与 returnMax 的秩相关【主判据，越接近 1 越好】——直接量单调性，散点图底下那个 ρ。
//   decileRho    score 十分位桶 vs 各桶胜率的单调性（分档看更抗离群；样本<60 算不出→null），佐证单调性。
//   hit2/hit5/hit10  通过组里 returnMax >2x / >5x / >10x 的占比【共同判据，越高越好】——高倍有没有
//             真的集中到通过（高分）那一侧。>2x 最稳，>5x/>10x 样本少会抖。
//   passRate  通过率＝过策略的样本 / 全部样本。【中性】——触发多少不代表好坏，界面不上好坏色。
//   hitMedian 通过组 returnMax 中位数（越高越好）、missMedian 未通过组中位数（越低越好）
//   rLog      score 与 log(returnMax) 的皮尔逊相关（佐证项）
export function computeStrategyMetrics(code, rows) {
  const compiled = compileStrategy(code);
  if (compiled.error) return { ok: false, error: compiled.error };
  const results = rows.map(row => ({ input: row.tokenAddress, row, res: runStrategyOnRow(compiled, row) }));
  const agg = aggregateCheckStats(results);
  // score vs 收益：取【硬否决通过】的全部样本（命中 + veto过但分低），排除 veto 未过；
  // 分数优先读 '总分' check，缺失时回退日志 SCORE= 标记。跟 StrategyReplay 的 scoreReturnPairs
  // 共用 extractScoreReturnPair，两处口径必须一致。
  const pairs = [];
  for (const { row, res } of results) {
    const pair = extractScoreReturnPair(res, row);
    if (pair) pairs.push(pair);
  }
  const srStats = computeScoreReturnStats(pairs);
  const buckets = (srStats && !srStats.constant) ? computeScoreBuckets(pairs) : null;
  const nHit = agg.hitRets.length;
  const rateAbove = t => (nHit ? agg.hitRets.filter(r => r > t).length / nHit : null);
  const usable = srStats && !srStats.constant;
  return {
    ok: true,
    total: agg.total,
    hits: agg.hits,
    // spearmanRho＝score 与 returnMax 的秩相关【核心/北极星默认口径】——直接量"分数越高倍率越高"这个单调关系，
    // 就是散点图底下那个 spearman ρ。多数策略的终极目标是把它做强：高倍集中高分、低倍落低分。越接近 1 越好。
    // （筛垃圾类策略的北极星走分层台阶例外，见上方 computeStrategyMetrics 的说明）
    spearmanRho: usable ? srStats.rho : null,
    // decileRho＝score 十分位桶 vs 各桶胜率的单调性（分档看，比逐点 spearman 更抗离群），佐证单调性
    decileRho: buckets ? buckets.rho : null,
    passRate: agg.valid ? agg.hits / agg.valid : null,
    hit2: rateAbove(WIN_THRESHOLD),
    hit5: rateAbove(5),
    hit10: rateAbove(10),
    hitMedian: agg.hitRets.length ? median(agg.hitRets) : null,
    missMedian: agg.missRets.length ? median(agg.missRets) : null,
    rLog: usable ? srStats.rLog : null,
  };
}

// 把当前这次回放的聚合结果（StrategyReplay.jsx 里现算的 agg/scoreAgg/scoreReturnStats/
// scoreBuckets）压成一份可存档的快照——只留核心统计量和这次用的策略代码，不留逐样本明细
// （明细能从代码 + 当时的数据源原样重新跑一遍拿到，没必要重复占地方）。
// 跟下面 metricsFromStrategyMetrics() 存的形状保持一致，两处都是"回测报告存档"的 metrics 口径，
// 手动存的日报和试算确认自动存的优化前/后报告才能用同一套字段对比。
export function buildReplayReportMetrics({ agg, scoreAgg, scoreReturnStats, scoreBuckets }) {
  return {
    total: agg.total,
    hits: agg.hits,
    hitRate: agg.valid ? agg.hits / agg.valid : null,
    hitMedian: agg.hitRets.length ? median(agg.hitRets) : null,
    missMedian: agg.missRets.length ? median(agg.missRets) : null,
    cutoff: Number.isFinite(scoreAgg?.cutoff) ? scoreAgg.cutoff : null,
    scoreReturn: (scoreReturnStats && !scoreReturnStats.constant)
      ? { n: scoreReturnStats.n, rRaw: scoreReturnStats.rRaw, pRaw: scoreReturnStats.pRaw,
          rLog: scoreReturnStats.rLog, pLog: scoreReturnStats.pLog, rho: scoreReturnStats.rho }
      : null,
    monotonicity: scoreBuckets ? { rho: scoreBuckets.rho, K: scoreBuckets.K } : null,
    // 阵营因子明细留着不在这版界面展示，是给以后做"逐因子跨天对比"这类更细的功能预留的——
    // 反正数据已经算好了，存下来不费事，没有就得等真的需要那天回去重新跑历史数据才能补上。
    campFactors: scoreAgg?.factors ?? null,
  };
}

// 把 computeStrategyMetrics() 的输出转成"回测报告存档"用的 metrics 口径（跟上面
// buildReplayReportMetrics() 存的形状一致），这样应用调权建议时
// 算好的 before/after 才能直接存成报告，跟手动存的日报用同一套字段对比。
export function metricsFromStrategyMetrics(sm) {
  if (!sm || !sm.ok) return null;
  return {
    total: sm.total,
    hits: sm.hits,
    hitRate: sm.passRate,
    hitMedian: sm.hitMedian,
    missMedian: sm.missMedian,
    cutoff: null,
    scoreReturn: (sm.rLog != null || sm.spearmanRho != null)
      ? { n: sm.total, rRaw: null, pRaw: null, rLog: sm.rLog, pLog: null, rho: sm.spearmanRho }
      : null,
    monotonicity: sm.decileRho != null ? { rho: sm.decileRho, K: null } : null,
    campFactors: null,
  };
}

// 报告对比"优化建议"：拿两份存档报告（先后顺序不限，谁早谁晚由调用方传对）的 metrics 算出
// 变化方向，给一句话建议。口径跟 StrategyReplay.jsx 里 WeightSuggestionPreview 的 netHint 一致——
// 主看单调性 spearman ρ（score↔倍率，北极星默认口径；筛垃圾类策略以分层台阶为准），命中率/r(log) 做共同判据。
// 三者都读不出时退化成"无法判断"，不瞎猜。
export function suggestFromReportMetrics(before, after) {
  if (!before || !after) return null;
  const EPS_RHO = 1e-3, EPS_RATE = 1e-3, EPS_R = 1e-3;
  const rhoB = before.scoreReturn?.rho ?? before.monotonicity?.rho ?? null;
  const rhoA = after.scoreReturn?.rho ?? after.monotonicity?.rho ?? null;
  const dRho = (rhoB != null && rhoA != null) ? rhoA - rhoB : null;
  const hitB = before.hitRate, hitA = after.hitRate;
  const dHit = (hitB != null && hitA != null) ? hitA - hitB : null;
  const rLogB = before.scoreReturn?.rLog, rLogA = after.scoreReturn?.rLog;
  const dRLog = (rLogB != null && rLogA != null) ? rLogA - rLogB : null;

  const detail = [];
  if (dRho != null) detail.push(`单调性ρ ${rhoB.toFixed(3)}→${rhoA.toFixed(3)}${dRho > EPS_RHO ? ' ↑' : dRho < -EPS_RHO ? ' ↓' : '（基本不变）'}`);
  if (dHit != null) detail.push(`命中率 ${(hitB * 100).toFixed(1)}%→${(hitA * 100).toFixed(1)}%${dHit > EPS_RATE ? ' ↑' : dHit < -EPS_RATE ? ' ↓' : '（基本不变）'}`);
  if (dRLog != null) detail.push(`r(log) ${rLogB.toFixed(3)}→${rLogA.toFixed(3)}${dRLog > EPS_R ? ' ↑' : dRLog < -EPS_R ? ' ↓' : '（基本不变）'}`);

  let verdict;
  if (dRho != null) {
    if (dRho > EPS_RHO && (dHit == null || dHit >= -EPS_RATE)) verdict = { type: 'success', text: '单调性变强、命中率没变差——建议保留本次优化。' };
    else if (dRho > EPS_RHO) verdict = { type: 'warning', text: '单调性变强但命中率有降，方向对但要留意，建议再观察几天。' };
    else if (dRho < -EPS_RHO) verdict = { type: 'error', text: '单调性反而变弱——按"验证不了更单调就别改"的原则，建议回退本次优化。' };
    else verdict = { type: 'info', text: '单调性基本没变化，参考命中率/r(log)辅助判断，应用与否影响不大。' };
  } else if (dHit != null) {
    verdict = dHit > EPS_RATE ? { type: 'success', text: '样本不够算单调性ρ，退回看命中率：提升了，可以保留。' }
      : dHit < -EPS_RATE ? { type: 'error', text: '样本不够算单调性ρ，退回看命中率：下降了，建议回退。' }
      : { type: 'info', text: '样本不够算单调性ρ，命中率也没什么变化，无法给出明确建议。' };
  } else {
    verdict = { type: 'info', text: '两份报告都算不出单调性ρ和命中率，无法给出优化建议（样本太少或打分池为空）。' };
  }
  return { ...verdict, detail: detail.join('；') };
}
