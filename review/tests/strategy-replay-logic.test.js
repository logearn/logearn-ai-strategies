import assert from 'node:assert';
import { factorVerdict, suggestWeightAdjustment, computeStrategyMetrics, computeScoreBuckets,
         accumulateVerdict, dailyFactorVerdicts, crossDayVerdict,
         metricsFromStrategyMetrics, suggestFromReportMetrics } from '../src/lib/strategyReplayLogic.js';
import { extractScoreReturnPair } from '../src/lib/proAnalytics.js';

// 跨天判定测试用的三档单日 stats（跟上面 factorVerdict 用例同源）：
const WORSE = { scoredWin: 0.075, scoredN: 400, zeroWin: 0.75, zeroN: 100, camp: 'hero' }; // 无效应组明显更高 → 反向
const BETTER = { scoredWin: 0.75, scoredN: 400, zeroWin: 0.30, zeroN: 100, camp: 'hero' }; // 起作用组明显更高 → 有效
const CLOSE = { scoredWin: 0.50, scoredN: 100, zeroWin: 0.53, zeroN: 100, camp: 'hero' };   // 置信区间重叠 → 分不出
const mkReport = (date, savedAt, name, stats) => ({ date, savedAt, metrics: { campFactors: [{ name, ...stats }] } });

export function run(test) {
  test('factorVerdict: 任一侧样本 <5 应返回 insufficient，不下结论', () => {
    assert.strictEqual(factorVerdict({ scoredWin: 0.5, scoredN: 4, zeroWin: 0.5, zeroN: 100, camp: 'hero' }).verdict, 'insufficient');
    assert.strictEqual(factorVerdict({ scoredWin: 0.5, scoredN: 100, zeroWin: 0.5, zeroN: 4, camp: 'hero' }).verdict, 'insufficient');
  });

  // 回归用例：这是真实踩过的坑——旧版只用"相对差值超过 15%"判定，小样本那侧（刚好卡在
  // n=5 门槛上）随便摸到几个高倍盘，胜率点估计能轻松冲到 80%，旧逻辑会把这个误判成"反向"，
  // 但它的 Wilson 95% 置信区间宽达 37.6%~96.4%，跟大样本那侧的 53.1%~66.5% 明显重叠，
  // 根本分不出真假。改用置信区间判定后应该是 close，不能再下"反向"结论。
  test('factorVerdict: 小样本(n=5)胜率高但置信区间跟大样本重叠时，不能判反向——应为 close', () => {
    const r = factorVerdict({ scoredWin: 0.6, scoredN: 200, zeroWin: 0.8, zeroN: 5, camp: 'hero' });
    assert.strictEqual(r.verdict, 'close', '置信区间明显重叠，只能说分不出真假');
  });

  test('factorVerdict: 勇者阵营——起作用组置信区间整体高于无效应组时应判 better', () => {
    // scored: 300/400=75%，CI 大致 70.5%~79.1%；zero: 30/100=30%，CI 大致 21.9%~39.5%——不重叠
    const r = factorVerdict({ scoredWin: 0.75, scoredN: 400, zeroWin: 0.30, zeroN: 100, camp: 'hero' });
    assert.strictEqual(r.verdict, 'better');
    assert.ok(r.ciScored.lo > r.ciZero.hi, '起作用组置信区间下界应高于无效应组上界');
  });

  test('factorVerdict: 勇者阵营——无效应组置信区间整体高于起作用组时应判 worse（真反向，非样本噪声）', () => {
    // scored: 30/400=7.5%，CI 大致 5.3%~10.5%；zero: 75/100=75%，CI 大致 65.6%~82.6%——不重叠
    const r = factorVerdict({ scoredWin: 0.075, scoredN: 400, zeroWin: 0.75, zeroN: 100, camp: 'hero' });
    assert.strictEqual(r.verdict, 'worse');
  });

  test('factorVerdict: 邪恶阵营的方向跟勇者相反——踩中危险区组胜率置信区间更低才是"有效"', () => {
    // 邪恶阵营期望"起作用"（踩中危险区）组胜率更低：scored=7.5% CI低, zero=75% CI高，方向相反 = better
    const better = factorVerdict({ scoredWin: 0.075, scoredN: 400, zeroWin: 0.75, zeroN: 100, camp: 'evil' });
    assert.strictEqual(better.verdict, 'better');
    // 反过来——踩中危险区组胜率反而更高 = 邪恶阵营的"反向"（选反了，命中危险区不该赢更多）
    const worse = factorVerdict({ scoredWin: 0.75, scoredN: 400, zeroWin: 0.30, zeroN: 100, camp: 'evil' });
    assert.strictEqual(worse.verdict, 'worse');
  });

  test('factorVerdict: 两组胜率相近、置信区间大幅重叠时应为 close', () => {
    const r = factorVerdict({ scoredWin: 0.50, scoredN: 200, zeroWin: 0.52, zeroN: 200, camp: 'hero' });
    assert.strictEqual(r.verdict, 'close');
  });

  test('suggestWeightAdjustment: worse → 权重-2（未触底）', () => {
    assert.deepStrictEqual(suggestWeightAdjustment('worse', 10), { action: 'adjust', newWeight: 8 });
  });

  // 规则变更（用户确认）：只有【真反向 worse】才降/删；close（分不出真假）不动——
  // 单看一天数据大量因子天然是 close，把它们也 -2 会慢慢误删掉其实并不差的因子。
  test('suggestWeightAdjustment: close（分不出真假）不动，返回 none', () => {
    assert.deepStrictEqual(suggestWeightAdjustment('close', 10), { action: 'none' });
    assert.deepStrictEqual(suggestWeightAdjustment('close', 2), { action: 'none' });
  });

  test('suggestWeightAdjustment: worse 降到 ≤1 应建议删除而不是继续降权重', () => {
    assert.deepStrictEqual(suggestWeightAdjustment('worse', 3), { action: 'remove' });
    assert.deepStrictEqual(suggestWeightAdjustment('worse', 2), { action: 'remove' });
    // 边界：currentWeight=3 时 next=1，触底建议删除；currentWeight=4 时 next=2，未触底，正常降权重
    assert.deepStrictEqual(suggestWeightAdjustment('worse', 4), { action: 'adjust', newWeight: 2 });
  });

  test('suggestWeightAdjustment: better → 权重+2', () => {
    assert.deepStrictEqual(suggestWeightAdjustment('better', 10), { action: 'adjust', newWeight: 12 });
  });

  // 权重封顶（默认 20 = 2×默认权重）：不封顶的话 better 会一路涨，归一化打分下把一个因子涨成
  // 独裁大票仓，稀释其他因子。到顶不再加。
  test('suggestWeightAdjustment: better 接近上限时封顶到 20，到顶后不再加（返回 none）', () => {
    assert.deepStrictEqual(suggestWeightAdjustment('better', 19), { action: 'adjust', newWeight: 20 }, '19+2=21 应封到 20');
    assert.deepStrictEqual(suggestWeightAdjustment('better', 20), { action: 'none' }, '已到顶，不再加');
    assert.deepStrictEqual(suggestWeightAdjustment('better', 25), { action: 'none' }, '超过上限也不加');
  });

  test('suggestWeightAdjustment: insufficient → 不给建议（数据不够，瞎调只会引入新噪声）', () => {
    assert.deepStrictEqual(suggestWeightAdjustment('insufficient', 10), { action: 'none' });
  });

  // computeScoreBuckets：相同 score 的样本绝不能被切进不同的桶（饱和区的假单调）。
  test('computeScoreBuckets: 同分样本不被切到不同桶，饱和度如实报告', () => {
    // 120 条：70 条 score=100（饱和），另外 50 条散在 10~59。等数量十分位会想在 100 那堆里切好几刀，
    // 修复后同分只能进同一个桶——所有 score=100 的样本必须落在恰好一个桶里。
    const pairs = [];
    for (let i = 0; i < 70; i++) pairs.push({ score: 100, ret: i % 3 === 0 ? 3 : 1 });   // 饱和分
    for (let i = 0; i < 50; i++) pairs.push({ score: 10 + i, ret: i % 2 === 0 ? 3 : 1 }); // 各不相同
    const r = computeScoreBuckets(pairs);
    assert.ok(r, '≥60 条应出分位表');
    // 核心不变量：任何一个 score 值都只能落在一个桶里（同分不被拆开）——用相邻桶 score 区间
    // 不重叠来验证：上一桶的 scoreHi 必须严格小于下一桶的 scoreLo，否则说明有个分数被切到了两桶。
    const sortedB = r.buckets.slice().sort((a, b) => a.scoreLo - b.scoreLo);
    for (let i = 1; i < sortedB.length; i++) {
      assert.ok(sortedB[i].scoreLo > sortedB[i - 1].scoreHi, `第 ${i} 桶与前一桶 score 区间重叠了（同分被切开）`);
    }
    // score=100 那一大堆（饱和分）必须整团落在恰好一个桶里，不能被切成好几个"同分桶"制造假单调
    const bucketsCovering100 = r.buckets.filter(b => b.scoreLo <= 100 && b.scoreHi >= 100);
    assert.strictEqual(bucketsCovering100.length, 1, 'score=100 的样本只能落在一个桶里，不能被拆开');
    assert.ok(Math.abs(r.maxTieFrac - 70 / 120) < 1e-9, 'maxTieFrac 应报告最大同分组占比');
    assert.ok(r.effectiveBuckets <= r.K, '合并同分后实际桶数不超过 K');
  });

  // computeStrategyMetrics：给"试算"用的顶层指标——编译+回放+聚合，跟看板同源。
  // 造 6 条样本，score 与 returnMax 完全正相关（分越高越赢），验证 hitRate/命中数/rLog 合理。
  test('computeStrategyMetrics: 编译不过时返回 ok:false + error', () => {
    const r = computeStrategyMetrics('this is not valid js {{{', []);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  });

  test('computeStrategyMetrics: 打分策略在样本上跑出命中率/中位数/rLog', () => {
    // 策略：score = f('x')，>=50 通过。x 越大 returnMax 越大 → 正相关
    const code = `const checks = []\nconst score = Number(f('x'))\nchecks.push(['x分', score>0, String(score)+' → '+score.toFixed(1)+'分', '满分 0~100 权重 10'])\nchecks.push(['总分', score>=50, score.toFixed(1), '>= 50'])\nif (score < 50) return false\nreturn true`;
    const mk = (x, ret) => ({ tokenAddress: 'T'+x, symbol: 'T'+x, returnMax: ret,
      buyTimestamp: 1780000000, rawCtx: {}, features: { x } });
    // getFeature 读 row.features[name]；这里给足 features 让 f('x') 取到值
    const rows = [mk(90, 6), mk(80, 5), mk(70, 4), mk(30, 1.1), mk(20, 1.05), mk(10, 1.02)];
    const m = computeStrategyMetrics(code, rows);
    assert.strictEqual(m.ok, true);
    assert.strictEqual(m.total, 6);
    assert.strictEqual(m.hits, 3, 'score>=50 的 3 条通过');
    assert.ok(Math.abs(m.passRate - 0.5) < 1e-9, '通过率 3/6');
    // 通过的 3 条 returnMax = [6,5,4]：>2x 全中(100%)，>5x 命中 6 这一条(1/3)，>10x 无(0%)
    assert.ok(Math.abs(m.hit2 - 1) < 1e-9, '通过组 >2x 命中率 100%');
    assert.ok(Math.abs(m.hit5 - 1 / 3) < 1e-9, '通过组 >5x 命中率 1/3（只有 6x 那条）');
    assert.ok(Math.abs(m.hit10 - 0) < 1e-9, '通过组 >10x 命中率 0');
    assert.ok(m.hitMedian >= 4, '通过组中位数应是高倍那几个');
    // score 与 returnMax 完全同序（x 越大 ret 越大）→ spearman ρ 应为 1（强单调）
    assert.ok(Math.abs(m.spearmanRho - 1) < 1e-9, 'score↔倍率完全同序，单调性 ρ=1');
  });

  test('computeStrategyMetrics: 打乱 score 与倍率的对应关系，单调性 ρ 应显著低于完全同序', () => {
    const code = `const checks = []\nconst score = Number(f('x'))\nchecks.push(['x分', score>0, String(score)+' → '+score.toFixed(1)+'分', '满分 0~100 权重 10'])\nchecks.push(['总分', score>=0, score.toFixed(1), '>= 0'])\nreturn true`;
    const mk = (x, ret) => ({ tokenAddress: 'T'+x+'_'+ret, symbol: 'T', returnMax: ret,
      buyTimestamp: 1780000000, rawCtx: {}, features: { x } });
    // 高分未必高倍：故意让分数和倍率不同序
    const rows = [mk(90, 1.1), mk(80, 6), mk(70, 1.05), mk(60, 5), mk(50, 1.2), mk(40, 4)];
    const m = computeStrategyMetrics(code, rows);
    assert.strictEqual(m.ok, true);
    assert.ok(m.spearmanRho < 0.5, `乱序时单调性应明显偏弱，实际 ρ=${m.spearmanRho}`);
  });

  // ── score vs 收益散点：应画【硬否决通过】的全部样本，不只是命中的 ────────────────
  // 真实 bug：策略把 checks.push(['总分'...]) 写在 veto/分低 return false 之后，未命中样本
  // 吐不出"总分"check，散点只剩命中侧那一撮 score>=cutoff。修复＝checks 无"总分"时回退日志 SCORE=。
  test('computeStrategyMetrics: 总分 push 在 return 之后时，veto通过但分低的样本仍进散点（靠日志SCORE=兜底）', () => {
    // buggy 写法：只有命中(score>=80)才 push '总分'；未命中只打 SCORE= 日志
    const code = `const checks = []
const veto = Number(f('ok')) === 1
const score = Number(f('s'))
if (!veto) { ctx.log.error('未命中(否决) SCORE=' + score.toFixed(1)); return false }
if (score < 80) { ctx.log.error('未命中(分低) SCORE=' + score.toFixed(1)); return false }
checks.push(['总分', true, score.toFixed(1), '>= 80'])
ctx.log.success('命中 SCORE=' + score.toFixed(1))
return true`;
    const mk = (name, ok, s, ret) => ({ tokenAddress: name, symbol: name, returnMax: ret,
      buyTimestamp: 1780000000, rawCtx: {}, features: { ok, s } });
    // 散点单调性 ρ 需要 >=5 个样本才算得出，这里放 6 条 veto 通过 + 1 条 veto 未过
    const rows = [
      mk('vetoFail', 0, 30, 9),   // veto 未过 → 排除（给个高倍率，若被误纳入会打乱同序）
      mk('low1', 1, 40, 1.1),     // veto 过、分低 → 进散点
      mk('low2', 1, 55, 1.3),     // veto 过、分低 → 进散点
      mk('low3', 1, 70, 2.5),     // veto 过、分低 → 进散点
      mk('hit1', 1, 82, 4),       // 命中 → 进散点
      mk('hit2', 1, 90, 6),       // 命中 → 进散点
      mk('hit3', 1, 95, 8),       // 命中 → 进散点
    ];
    const m = computeStrategyMetrics(code, rows);
    assert.strictEqual(m.ok, true);
    assert.strictEqual(m.total, 7, '全部 7 条都跑了策略');
    assert.strictEqual(m.hits, 3, '命中(score>=80)有 3 条');
    // 散点样本 = 6 条 veto 通过，score↔ret 完全同序 → ρ=1
    // vetoFail(score=30,ret=9) 若被误纳入会严重打乱同序，ρ 到不了 1，以此断言它确实被排除
    assert.ok(Math.abs(m.spearmanRho - 1) < 1e-9,
      `散点应含 veto 通过的 6 条(含分低)且排除 veto 未过的，ρ 应=1，实际 ρ=${m.spearmanRho}`);
  });

  test('extractScoreReturnPair: veto未过样本排除、命中与分低样本保留、收益无效丢弃', () => {
    const mkRes = (logsText, checks) => ({ error: null,
      logs: logsText.map(text => ({ text })), checks });
    // veto 未过：日志含"(否决)" → null
    assert.strictEqual(
      extractScoreReturnPair(mkRes(['未命中(否决) SCORE=30'], null), { returnMax: 2 }), null);
    // 有'总分'check、命中 → 取 check 值
    const hit = extractScoreReturnPair(
      mkRes(['命中'], [{ name: '总分', ok: true, value: '90.0', expect: '>= 80' }]), { returnMax: 5 });
    assert.deepStrictEqual(hit, { score: 90, ret: 5 });
    // 无'总分'check、日志有 SCORE= → 兜底取分（分低样本）
    const low = extractScoreReturnPair(mkRes(['未命中(分低) SCORE=55.0'], []), { returnMax: 3 });
    assert.deepStrictEqual(low, { score: 55, ret: 3 });
    // 收益无效(<=0) → null
    assert.strictEqual(
      extractScoreReturnPair(mkRes(['命中'], [{ name: '总分', ok: true, value: '90', expect: '' }]),
        { returnMax: 0 }), null);
  });

  // ── 跨天累计判定（A：连续 N 天同向才动手）────────────────────────────────────
  test('accumulateVerdict: 连续 >= minStreak 天同向才给可执行判定，否则 hold', () => {
    // 最近连续 2 天 worse，minStreak=2 → 可执行 worse
    assert.strictEqual(accumulateVerdict(['worse', 'worse', 'close'], 2).verdict, 'worse');
    // 只有今天 1 天 worse，没连够 → hold，但 streak=1、direction=worse（界面显示"再观察"）
    const one = accumulateVerdict(['worse', 'close', 'worse'], 2);
    assert.strictEqual(one.verdict, 'hold');
    assert.strictEqual(one.streak, 1);
    assert.strictEqual(one.direction, 'worse');
    // 连续 3 天 better，minStreak=2 → 可执行 better，streak=3
    const good = accumulateVerdict(['better', 'better', 'better'], 2);
    assert.strictEqual(good.verdict, 'better');
    assert.strictEqual(good.streak, 3);
  });

  test('accumulateVerdict: close/insufficient 会打断连续段，方向翻转也重新计数', () => {
    // 今天 close（不是可执行方向）→ 直接 hold，streak=0
    assert.strictEqual(accumulateVerdict(['close', 'worse', 'worse'], 2).verdict, 'hold');
    assert.strictEqual(accumulateVerdict(['close', 'worse', 'worse'], 2).streak, 0);
    // 昨天 better、今天 worse：方向不同，连续段只算今天这 1 天 → hold
    assert.strictEqual(accumulateVerdict(['worse', 'better', 'better'], 2).verdict, 'hold');
    // 空/非数组兜底
    assert.strictEqual(accumulateVerdict([], 2).verdict, 'hold');
    assert.strictEqual(accumulateVerdict(null, 2).verdict, 'hold');
  });

  test('dailyFactorVerdicts: 每个日历日取最后一次存档，重算 verdict，最新在前', () => {
    const reports = [
      mkReport('2026-07-20', 100, 'F', BETTER),
      mkReport('2026-07-21', 200, 'F', WORSE),
      mkReport('2026-07-21', 300, 'F', BETTER),  // 同一天更晚的一份，应覆盖上面那份
      mkReport('2026-07-22', 400, 'OTHER', WORSE), // 这天没有 F，跳过
    ];
    const ds = dailyFactorVerdicts('F', reports);
    assert.deepStrictEqual(ds.map(d => d.date), ['2026-07-21', '2026-07-20'], '按日期倒序、每天一条、没 F 的天跳过');
    assert.strictEqual(ds[0].verdict, 'better', '07-21 取更晚的那份（BETTER）');
    assert.strictEqual(ds[1].verdict, 'better');
  });

  test('crossDayVerdict: 今天实时判定 + 历史逐日判定，连够才可执行', () => {
    const reports = [mkReport('2026-07-24', 100, 'F', WORSE)];
    // 今天(07-25)也判 worse，加上昨天 worse → 连续 2 天，minStreak=2 → 可执行 worse
    const cd = crossDayVerdict({ name: 'F', todayStats: WORSE, reports, todayDate: '2026-07-25', minStreak: 2 });
    assert.strictEqual(cd.today, 'worse');
    assert.strictEqual(cd.verdict, 'worse');
    assert.strictEqual(cd.streak, 2);
    // 历史里没这个因子 → 只有今天 1 天 → hold（再观察）
    const cd2 = crossDayVerdict({ name: 'F', todayStats: WORSE, reports: [], todayDate: '2026-07-25', minStreak: 2 });
    assert.strictEqual(cd2.verdict, 'hold');
    assert.strictEqual(cd2.streak, 1);
  });

  test('crossDayVerdict: 今天已存过报告时，用实时判定、不把当天历史项重复计入', () => {
    // 历史里有一份"今天"的旧报告(判 better)，但今天实时判 worse——应以实时为准，当天不重复算
    const reports = [
      mkReport('2026-07-25', 100, 'F', BETTER),  // 今天早些存的旧报告
      mkReport('2026-07-24', 90, 'F', WORSE),
    ];
    const cd = crossDayVerdict({ name: 'F', todayStats: WORSE, reports, todayDate: '2026-07-25', minStreak: 2 });
    assert.strictEqual(cd.today, 'worse');
    // 序列应是 [今天 worse(实时), 07-24 worse]，07-25 的历史 better 被 todayDate 过滤掉 → 连续 2 天 worse
    assert.strictEqual(cd.verdict, 'worse');
    assert.strictEqual(cd.streak, 2);
  });

  // ── metricsFromStrategyMetrics：把试算用的顶层指标转成报告存档口径 ──
  test('metricsFromStrategyMetrics: 编译失败(ok:false)应返回 null，不硬凑一份假指标', () => {
    assert.strictEqual(metricsFromStrategyMetrics({ ok: false, error: 'x' }), null);
    assert.strictEqual(metricsFromStrategyMetrics(null), null);
  });

  test('metricsFromStrategyMetrics: 字段一一映射，spearmanRho/decileRho 分别落进 scoreReturn.rho / monotonicity.rho', () => {
    const sm = { ok: true, total: 100, hits: 20, passRate: 0.2, hitMedian: 3, missMedian: 0.8,
      spearmanRho: 0.55, decileRho: 0.4, rLog: 0.3 };
    const m = metricsFromStrategyMetrics(sm);
    assert.strictEqual(m.total, 100);
    assert.strictEqual(m.hitRate, 0.2, 'hitRate 应取 passRate（跟 buildMetrics 存的 agg.hits/agg.valid 同口径）');
    assert.strictEqual(m.hitMedian, 3);
    assert.strictEqual(m.missMedian, 0.8);
    assert.strictEqual(m.scoreReturn.rho, 0.55);
    assert.strictEqual(m.scoreReturn.rLog, 0.3);
    assert.strictEqual(m.monotonicity.rho, 0.4);
  });

  test('metricsFromStrategyMetrics: rLog/spearmanRho/decileRho 全为 null 时（样本太少）对应字段应为 null 而不是硬造对象', () => {
    const m = metricsFromStrategyMetrics({ ok: true, total: 3, hits: 1, passRate: 0.33, hitMedian: null, missMedian: null,
      spearmanRho: null, decileRho: null, rLog: null });
    assert.strictEqual(m.scoreReturn, null);
    assert.strictEqual(m.monotonicity, null);
  });

  // ── suggestFromReportMetrics：报告对比"优化建议"，口径跟试算弹窗的 netHint 一致 ──
  const mkM = (rho, hitRate, rLog) => ({ hitRate, scoreReturn: { rho, rLog } });

  test('suggestFromReportMetrics: 单调性ρ变强、命中率没变差 → success，建议保留', () => {
    const r = suggestFromReportMetrics(mkM(0.2, 0.1, 0.1), mkM(0.4, 0.15, 0.2));
    assert.strictEqual(r.type, 'success');
    assert.ok(r.text.includes('保留'));
  });

  test('suggestFromReportMetrics: 单调性ρ变弱 → error，建议回退', () => {
    const r = suggestFromReportMetrics(mkM(0.4, 0.2, 0.2), mkM(0.2, 0.2, 0.1));
    assert.strictEqual(r.type, 'error');
    assert.ok(r.text.includes('回退'));
  });

  test('suggestFromReportMetrics: 单调性ρ变强但命中率下降 → warning，建议观察', () => {
    const r = suggestFromReportMetrics(mkM(0.2, 0.3, 0.1), mkM(0.4, 0.2, 0.2));
    assert.strictEqual(r.type, 'warning');
  });

  test('suggestFromReportMetrics: ρ 基本不变（<EPS）→ info', () => {
    const r = suggestFromReportMetrics(mkM(0.30, 0.2, 0.1), mkM(0.3001, 0.2, 0.1));
    assert.strictEqual(r.type, 'info');
  });

  test('suggestFromReportMetrics: 两份都没有 ρ，退回看命中率——提升 → success，下降 → error', () => {
    const before = { hitRate: 0.1, scoreReturn: null };
    const up = suggestFromReportMetrics(before, { hitRate: 0.2, scoreReturn: null });
    assert.strictEqual(up.type, 'success');
    const down = suggestFromReportMetrics(before, { hitRate: 0.05, scoreReturn: null });
    assert.strictEqual(down.type, 'error');
  });

  test('suggestFromReportMetrics: 两份都算不出 ρ 和命中率 → info，且明说"无法给出优化建议"', () => {
    const r = suggestFromReportMetrics({ hitRate: null, scoreReturn: null }, { hitRate: null, scoreReturn: null });
    assert.strictEqual(r.type, 'info');
    assert.ok(r.text.includes('无法给出'));
  });

  test('suggestFromReportMetrics: 缺 before/after 应返回 null，不抛异常', () => {
    assert.strictEqual(suggestFromReportMetrics(null, mkM(0.2, 0.1, 0.1)), null);
    assert.strictEqual(suggestFromReportMetrics(mkM(0.2, 0.1, 0.1), undefined), null);
  });

  test('suggestFromReportMetrics: monotonicity.rho 作为 scoreReturn.rho 缺失时的兜底', () => {
    const before = { hitRate: 0.1, monotonicity: { rho: 0.2 } };
    const after = { hitRate: 0.15, monotonicity: { rho: 0.4 } };
    const r = suggestFromReportMetrics(before, after);
    assert.strictEqual(r.type, 'success');
    assert.ok(r.detail.includes('0.200'));
  });
}
