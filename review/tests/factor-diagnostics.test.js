// 因子诊断模块：把 42/43 两轮【手算】出来的判断固化成函数之后，得有测试守着那些结论。
// 每一组都对应 readme 里一个真实踩过的坑，注释标了节号——将来这些数字变了，
// 要么是代码回退了，要么是口径改了，两种都得有人看一眼。
import assert from 'node:assert';
import {
  factorInfluence, rhoNoiseFloor, splitPathByNoiseFloor, weightEvidenceAlignment,
  topBinHealth, missingImpact, enrichSweepWithReturns, nearCutoffOutliers,
  leaveOneOutFactors, makeTopLiftScorer,
} from '../src/lib/factorDiagnostics.js';
import { backtestFactors, heroWeightSum, resolveObjective, recommendFactorPath, scorePoolRho } from '../src/lib/factorLab.js';

const F = (field, camp, weight, lo0, lo1, hi1, hi0) => ({ field, camp, weight, lo0, lo1, hi1, hi0 });
const R = (returnMax, features) => ({ returnMax, features, symbol: 'T' + returnMax });

export function run(test) {

  // ---------- 1. 摆幅：真正决定影响力的是 权重/Σ勇者，不是权重本身 ----------
  test('factorInfluence: 摆幅 = 权重/Σ勇者×100，邪恶为负（42 轮真实数字）', () => {
    const factors = [
      F('a', 'hero', 18.1, 0, 0, Infinity, Infinity),
      F('b', 'hero', 26.8, 0, 0, Infinity, Infinity),
      F('c', 'hero', 36.8, 0, 0, Infinity, Infinity),
      F('d', 'evil', 18.4, -Infinity, -Infinity, 1, 1),
    ];
    const rows = [R(1, { a: 1, b: 1, c: 1, d: 0 })];
    assert.ok(Math.abs(heroWeightSum(factors) - 81.7) < 1e-9, 'Σ勇者只算勇者');
    const by = Object.fromEntries(factorInfluence(rows, factors).map(i => [i.field, i]));
    assert.ok(Math.abs(by.c.swing - 45.04) < 0.02, `above_below_ratio 摆幅应 ≈45.0，实际 ${by.c.swing}`);
    assert.ok(Math.abs(by.a.swing - 22.15) < 0.02, `price_to_ath 摆幅应 ≈22.2，实际 ${by.a.swing}`);
    // 摆幅最大的因子是 c（Δρ 最低那个）—— 这正是光看权重列看不出来的事
    assert.ok(by.c.swing > by.a.swing * 2, '权重 36.8 vs 18.1 的差距，在摆幅上是 2 倍以上');
    assert.ok(by.d.swing < 0, '邪恶阵营摆幅必须为负（单个梯形跨不过零，readme 40.2）');
    assert.ok(Math.abs(by.d.swingAbs - 22.52) < 0.02, `holder_gini 摆幅绝对值应 ≈22.5，实际 ${by.d.swingAbs}`);
  });

  test('factorInfluence: 满命中占比与有效区分样本数', () => {
    const f = F('x', 'hero', 10, 0.5, 0.5, Infinity, Infinity);
    const rows = [];
    for (let i = 0; i < 90; i++) rows.push(R(1, { x: 5 }));   // 核心区内，命中度 1.0
    for (let i = 0; i < 10; i++) rows.push(R(1, { x: 0 }));   // 区间外，命中度 0
    const [inf] = factorInfluence(rows, [f]);
    assert.ok(Math.abs(inf.modalShare - 0.9) < 1e-9);
    assert.strictEqual(inf.effectiveN, 10, '有效区分样本数 = n×(1−modalShare)');
    assert.strictEqual(inf.nearDegenerate, true, '90% 同命中度应触发准常数标记（软线 0.90）');
  });

  test('factorInfluence: 纯邪恶池 Σ勇者=0 时摆幅是 NaN，不能除出 Infinity', () => {
    const [inf] = factorInfluence([R(1, { x: 0 })], [F('x', 'evil', 10, -Infinity, -Infinity, 1, 1)]);
    assert.ok(Number.isNaN(inf.swing), '纯邪恶池分数恒 0（readme 36.3），摆幅无定义');
  });

  // ---------- 2. 噪声地板：该采纳前几步 ----------
  test('rhoNoiseFloor: 随样本量现算，n≈218 时回到 readme 写死的那个量级', () => {
    const f = rhoNoiseFloor(218);
    assert.ok(Math.abs(f - 0.0680) < 0.002, `n=218 应 ≈0.068（readme 36.4 写死的 0.064 同量级），实际 ${f}`);
    assert.ok(rhoNoiseFloor(1000) < rhoNoiseFloor(200), '样本越多地板越低');
    assert.ok(Number.isNaN(rhoNoiseFloor(4)), '样本太少时无定义，不能返回一个假的数');
  });

  test('splitPathByNoiseFloor: 按【前缀】切，不是逐步过滤（43 轮真实 Δρ 序列）', () => {
    const path = [0.153, 0.110, 0.063, 0.044, 0.026, 0.023]
      .map((d, i) => ({ field: 'f' + i, camp: 'hero', deltaTest: d }));
    const r = splitPathByNoiseFloor(path, 218);
    assert.strictEqual(r.adoptCount, 2, '第 3 步 0.063 低于地板 0.068 → 只采纳前 2 步');
    assert.strictEqual(r.noise.length, 4);
    // 关键纪律：后面某步 Δρ 再高也不能捡回来——它的增量建立在被砍掉的前缀之上
    const path2 = [{ field: 'a', camp: 'hero', deltaTest: 0.01 }, { field: 'b', camp: 'hero', deltaTest: 0.9 }];
    assert.strictEqual(splitPathByNoiseFloor(path2, 218).adoptCount, 0,
      '第一步就在噪声里 → 整条路径都不采纳，不能跳过它去捡第二步');
  });

  // ---------- 3. 权重 ↔ 证据 对齐 ----------
  test('weightEvidenceAlignment: 抓出"摆幅最大的因子证据最弱"（42 轮真实形态）', () => {
    const influences = [
      { field: 'above_below_ratio', camp: 'hero', weight: 36.8, swingAbs: 45.0 },
      { field: 'fresh_wallets', camp: 'hero', weight: 26.8, swingAbs: 32.8 },
      { field: 'price_to_ath', camp: 'hero', weight: 18.1, swingAbs: 22.2 },
    ];
    const path = [
      { field: 'price_to_ath', camp: 'hero', deltaTest: 0.153 },
      { field: 'fresh_wallets', camp: 'hero', deltaTest: 0.044 },
      { field: 'above_below_ratio', camp: 'hero', deltaTest: 0.023 },
    ];
    const a = weightEvidenceAlignment(influences, path);
    assert.strictEqual(a.inversions, 3, '三个因子摆幅与证据完全反序 → 3 处倒挂');
    assert.strictEqual(a.worst.heavy.field, 'above_below_ratio');
    assert.strictEqual(a.worst.strong.field, 'price_to_ath');
    assert.ok(a.rankRho < 0, '摆幅与证据的秩相关应为负（完全反着来）');
  });

  test('weightEvidenceAlignment: 完全对齐时 0 处倒挂、worst 为 null', () => {
    const a = weightEvidenceAlignment(
      [{ field: 'a', camp: 'hero', weight: 30, swingAbs: 30 }, { field: 'b', camp: 'hero', weight: 10, swingAbs: 10 }],
      [{ field: 'a', camp: 'hero', deltaTest: 0.2 }, { field: 'b', camp: 'hero', deltaTest: 0.05 }]);
    assert.strictEqual(a.inversions, 0);
    assert.strictEqual(a.worst, null);
  });

  test('weightEvidenceAlignment: 路径里没有的因子不参与（起点池因子没有 Δρ）', () => {
    const a = weightEvidenceAlignment(
      [{ field: 'a', camp: 'hero', swingAbs: 30 }, { field: 'ghost', camp: 'hero', swingAbs: 99 }],
      [{ field: 'a', camp: 'hero', deltaTest: 0.2 }]);
    assert.strictEqual(a.rows.length, 1, '没有 Δρ 的因子不能拿来判对齐，否则等于凭空造证据');
  });

  // ---------- 4. 顶档体检 ----------
  test('topBinHealth: 顶档 lift<1 要被抓出来（42 轮 cut80 lift 0.95 那种）', () => {
    const factors = [F('x', 'hero', 100, 0, 0, Infinity, Infinity)];
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push(R(i < 30 ? 5 : 1, {}));        // 0 分段，命中 30%
    for (let i = 0; i < 100; i++) rows.push(R(i < 10 ? 5 : 1, { x: 1 })); // 100 分段，命中 10%
    const h = topBinHealth(backtestFactors(rows, factors, 3), 3);
    assert.strictEqual(h.topBinBelowBase, true, '顶档 lift<1 必须被标出来');
    assert.ok(h.topBin.lift < 1, `顶档 lift 应 <1，实际 ${h.topBin.lift}`);
    assert.ok(h.highCutWarning, '高分段应报出 lift<1 的档位');
    assert.ok(h.highCutWarning.lift < 1);
  });

  test('topBinHealth: 饱和块的大小 / 块内 lift / 横跨几档', () => {
    const factors = [F('x', 'hero', 100, 0, 0, Infinity, Infinity)];
    const rows = [];
    for (let i = 0; i < 60; i++) rows.push(R(i < 12 ? 5 : 1, { x: 1 }));  // 60 个满分同分块
    for (let i = 0; i < 40; i++) rows.push(R(i < 8 ? 5 : 1, {}));
    const h = topBinHealth(backtestFactors(rows, factors, 3), 3);
    assert.strictEqual(h.saturation.n, 60);
    assert.ok(Math.abs(h.saturation.share - 0.6) < 1e-9);
    assert.strictEqual(h.saturated, true, '≥10% 就该判饱和');
    assert.ok(h.saturation.spansBins >= 5,
      `60% 的块必然横跨多个十分位（那几档差异是随机切分产物），实际 ${h.saturation.spansBins}`);
  });

  test('topBinHealth: 单调上升的池子不该误报顶档反转', () => {
    const factors = [F('x', 'hero', 100, 0, 20, Infinity, Infinity)];
    const rows = [];
    // 分数随 x 单调上升，命中率也随 x 单调上升
    for (let i = 0; i < 200; i++) rows.push(R(i % 10 < Math.floor(i / 20) ? 5 : 1, { x: i / 10 }));
    const h = topBinHealth(backtestFactors(rows, factors, 3), 3);
    assert.strictEqual(h.topBinBelowBase, false, '顶档明显最好时不该报反转');
    assert.strictEqual(h.highCutWarning, null, '也不该报高分段 lift<1');
  });

  test('topBinHealth: 空输入返回 null 而不是抛异常', () => {
    assert.strictEqual(topBinHealth(null, 3), null);
    assert.strictEqual(topBinHealth({ scored: [], base: { n: 0 } }, 3), null);
  });

  // ---------- 5. 缺失按阵营（42.2 那次事故的根因） ----------
  test('missingImpact: 邪恶因子缺失 = 白【得】分，会被顶到分数顶部', () => {
    const factors = [
      F('h', 'hero', 50, 0, 0, Infinity, Infinity),
      F('e', 'evil', 50, -Infinity, -Infinity, 1, 1),
    ];
    const rows = [];
    for (let i = 0; i < 90; i++) rows.push(R(1, { h: 1, e: 0 }));   // 踩中邪恶区，被扣分
    for (let i = 0; i < 10; i++) rows.push(R(1, { h: 1 }));         // e 缺失 → 躲掉扣分
    const imp = missingImpact(rows, factors, 3);
    const e = imp.find(x => x.field === 'e');
    assert.ok(e, '有缺失的邪恶因子必须出现在报告里');
    assert.strictEqual(e.direction, 'bonus', '邪恶缺失 → 躲掉扣分 → 奖励（不是"保守"）');
    assert.ok(Math.abs(e.points - 100) < 1e-9, 'Σ勇者=50、权重 50 → 白得 100 分');
    assert.ok(e.medScorePct > 0.85, `缺失样本被顶到分数顶部，分位应很高，实际 ${e.medScorePct}`);
    assert.strictEqual(imp.find(x => x.field === 'h'), undefined, 'h 没有缺失样本，不该出现');
  });

  test('missingImpact: 勇者缺失标 penalty 并沉到底部（同一个缺失率，两个相反含义）', () => {
    const factors = [F('h', 'hero', 50, 0, 0, Infinity, Infinity)];
    const rows = [];
    for (let i = 0; i < 90; i++) rows.push(R(1, { h: 1 }));
    for (let i = 0; i < 10; i++) rows.push(R(1, {}));
    const [h] = missingImpact(rows, factors, 3);
    assert.strictEqual(h.direction, 'penalty');
    assert.ok(h.medScorePct < 0.15, '勇者缺失样本应沉到底部');
  });

  test('missingImpact: 报出缺失样本自己的高倍率（判断顶档是不是被噪声占据）', () => {
    const factors = [
      F('h', 'hero', 50, 0, 0, Infinity, Infinity),
      F('e', 'evil', 50, -Infinity, -Infinity, 1, 1),
    ];
    const rows = [];
    for (let i = 0; i < 80; i++) rows.push(R(i < 20 ? 5 : 1, { h: 1, e: 0 }));  // 基准 25%
    for (let i = 0; i < 20; i++) rows.push(R(i < 5 ? 5 : 1, { h: 1 }));          // 缺失组也是 25%
    const e = missingImpact(rows, factors, 3).find(x => x.field === 'e');
    assert.strictEqual(e.missingN, 20);
    assert.ok(Math.abs(e.hiRate - 0.25) < 1e-9);
    assert.ok(Math.abs(e.lift - 1) < 1e-9, '缺失组 lift=1 = 顶档被"一无所知"的样本占据，等于不筛');
  });

  // ---------- 6. cutoff：倍数中位 + 临界大鱼 ----------
  test('enrichSweepWithReturns: 每档补上触发集的倍数中位，且不改动档位与顺序', () => {
    const factors = [F('x', 'hero', 100, 0, 100, Infinity, Infinity)];
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push(R(1 + i / 10, { x: i }));
    const bt = backtestFactors(rows, factors, 3);
    const rich = enrichSweepWithReturns(bt.sweep, bt.scored);
    assert.strictEqual(rich.points.length, bt.sweep.points.length, '档位数不能变');
    for (let i = 1; i < rich.points.length; i++) {
      assert.ok(rich.points[i].cut > rich.points[i - 1].cut, 'cut 必须仍是升序');
      assert.strictEqual(rich.points[i].triggered, bt.sweep.points[i].triggered, '触发数不能被改动');
    }
    const withRet = rich.points.filter(p => p.triggered > 0 && Number.isFinite(p.medRet));
    assert.ok(withRet.length > 5);
    assert.ok(withRet[withRet.length - 1].medRet > withRet[0].medRet,
      '本构造里分数与倍数同向，高 cut 的倍数中位应更高');
  });

  test('nearCutoffOutliers: 抓住"差 0.7 分没进"的 208x（43.5 真实案例）', () => {
    const scored = [
      { score: 83.3, row: { returnMax: 208.35, symbol: 'looong' } },
      { score: 82.0, row: { returnMax: 4.0, symbol: 'small' } },
      { score: 90.0, row: { returnMax: 50, symbol: 'inside' } },
      { score: 60.0, row: { returnMax: 300, symbol: 'far' } },
    ];
    const out = nearCutoffOutliers(scored, 84, { window: 3, minMultiple: 10 });
    assert.strictEqual(out.length, 1, '只有 83.3 那个既在窗口内、倍数又够大');
    assert.strictEqual(out[0].symbol, 'looong');
    assert.ok(Math.abs(out[0].gap - 0.7) < 1e-9, '要报出差了多少分');
    assert.strictEqual(nearCutoffOutliers(scored, 84, { window: 3, minMultiple: 500 }).length, 0);
    assert.strictEqual(nearCutoffOutliers(scored, 84, { window: 0.5, minMultiple: 10 }).length, 0,
      '窗口外的不算——"差一点"要有个界');
  });

  // ---------- 7. 留一法 ----------
  test('leaveOneOutFactors: 常数因子删掉后 ρ 一分不动，应排最前（= 最没用）', () => {
    const factors = [
      F('sig', 'hero', 50, 0, 19, Infinity, Infinity),                    // 全区间连续斜坡
      F('const', 'hero', 50, -Infinity, -Infinity, Infinity, Infinity),   // 人人满命中
    ];
    const rows = [];
    // sig 与 returnMax 正相关（sig 越高越可能是高倍）——fixture 必须真的有信号，
    // 否则"删掉它 ρ 反而涨"会让这条测试测的东西整个反过来（第一版就踩了这个）
    for (let i = 0; i < 120; i++) {
      const sig = i % 20;
      rows.push(R(sig >= 14 ? 5 : 1, { sig, const: 1 }));
    }
    const loo = leaveOneOutFactors(rows, factors, 3);
    assert.ok(loo.full.rho > 0.2, `fixture 前提：完整池 ρ 必须显著为正，实际 ${loo.full.rho}`);
    assert.ok(loo);
    assert.strictEqual(loo.items.length, 2);
    assert.strictEqual(loo.items[0].removed.field, 'const', '最没用的因子排最前');
    assert.ok(Math.abs(loo.items[0].dRho) < 1e-9, '常数勇者因子删掉后 ρ 严格不变（只改分数尺度）');
    // 反向：删掉 sig 之后只剩常数因子，全样本同分 → ρ 测不出来。这跟"删了无损"是两回事，
    // 必须标 degenerate 且 dRho=NaN 沉底，不能混进可安全删除那一档（sort 的 NaN 陷阱就在这）。
    const dropSig = loo.items.find(i => i.removed.field === 'sig');
    assert.strictEqual(dropSig.degenerate, true, '删剩下退化成人人同分 → 标 degenerate');
    assert.ok(Number.isNaN(dropSig.dRho));
    assert.strictEqual(loo.items[loo.items.length - 1].removed.field, 'sig', 'NaN 必须沉到最后');
  });

  test('leaveOneOutFactors: 删到纯邪恶池要标 pureEvil，不能返回一个假的 ρ', () => {
    const factors = [
      F('h', 'hero', 50, 0, 1, Infinity, Infinity),
      F('e', 'evil', 50, -Infinity, -Infinity, 1, 1),
    ];
    const rows = [];
    for (let i = 0; i < 60; i++) rows.push(R(i % 3 === 0 ? 5 : 1, { h: i % 2, e: i % 2 }));
    const dropHero = leaveOneOutFactors(rows, factors, 3).items.find(i => i.removed.field === 'h');
    assert.strictEqual(dropHero.pureEvil, true, '删掉唯一勇者 → Σ勇者=0 → 分数恒 0，必须标出来');
    assert.ok(Number.isNaN(dropHero.dRho));
  });

  test('leaveOneOutFactors: 单因子池返回 null（没有"留一"可言）', () => {
    assert.strictEqual(leaveOneOutFactors([R(1, { x: 1 })], [F('x', 'hero', 1, 0, 0, 1, 1)], 3), null);
  });

  // ---------- 8. 第二目标：顶档 lift ----------
  test('makeTopLiftScorer: 只看顶部薄片，跟 ρ 是两个不同的目标', () => {
    const scorer = makeTopLiftScorer({ topFrac: 0.3, winThreshold: 3 });
    const factors = [F('x', 'hero', 100, 0, 100, Infinity, Infinity)];
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push(R(i >= 70 ? 5 : 1, { x: i }));
    const v = scorer(rows, factors, 'zero');
    assert.ok(v > 2.5, `顶部薄片全命中，lift 应接近 1/0.3≈3.3，实际 ${v}`);
    assert.strictEqual(scorer.objective, 'topLift');
    assert.ok(scorer.suggestedMinGain > 0.003, 'lift 的量级比 ρ 大，minGain 必须跟着换');
  });

  test('makeTopLiftScorer: 顶部薄片切在同分块中间时要把整块带上', () => {
    const scorer = makeTopLiftScorer({ topFrac: 0.3, winThreshold: 3, minTop: 5 });
    const factors = [F('x', 'hero', 100, 0, 0, Infinity, Infinity)];
    const rows = [];
    for (let i = 0; i < 50; i++) rows.push(R(i < 25 ? 5 : 1, { x: 1 }));  // 50 个满分同分块
    for (let i = 0; i < 50; i++) rows.push(R(1, {}));
    // 整块 50 个、命中 25 = 50%，基准 25% → lift 2.0；在块中间乱切的话值会随切点抖动
    assert.ok(Math.abs(scorer(rows, factors, 'zero') - 2) < 1e-9,
      '应把整个同分块带上得到 lift=2');
  });

  test('makeTopLiftScorer: 纯邪恶池返回 NaN（分数恒 0 时"顶部薄片"无意义）', () => {
    const scorer = makeTopLiftScorer({ winThreshold: 3 });
    const rows = [];
    for (let i = 0; i < 60; i++) rows.push(R(i % 3 === 0 ? 5 : 1, { e: i % 2 }));
    assert.ok(Number.isNaN(scorer(rows, [F('e', 'evil', 50, -Infinity, -Infinity, 1, 1)], 'zero')));
  });

  // ---------- 9. objective 字符串 → 目标函数（Worker 边界只能传字符串） ----------
  test('resolveObjective: topLift 换目标时 minGain 必须跟着换量级', () => {
    const r = resolveObjective('rho', { threshold: 3 });
    assert.strictEqual(r.scoreFn, scorePoolRho);
    assert.ok(Math.abs(r.minGain - 0.003) < 1e-9);
    const t = resolveObjective('topLift', { threshold: 3 });
    assert.strictEqual(t.objective, 'topLift');
    assert.ok(t.minGain > r.minGain * 5, 'lift 的增量量级比 ρ 大一个数量级，沿用 0.003 等于没有下限');
  });

  test('resolveObjective: 未知目标回落到 ρ，不静默换成别的', () => {
    assert.strictEqual(resolveObjective('nonsense').objective, 'rho');
    assert.strictEqual(resolveObjective(undefined).objective, 'rho');
    assert.strictEqual(resolveObjective(null).scoreFn, scorePoolRho);
  });

  test('resolveObjective: 显式 minGain 优先于目标的建议值', () => {
    assert.ok(Math.abs(resolveObjective('topLift', { minGain: 0.5 }).minGain - 0.5) < 1e-9);
  });

  test('recommendFactorPath: objective 默认 rho，行为跟不传这个参数时完全一致', () => {
    const rows = [];
    for (let i = 0; i < 200; i++) {
      const x = i % 25, y = (i * 13) % 25;
      rows.push({ returnMax: x >= 18 ? 5 : 1, features: { x, y }, swapBeginTime: 1000 + i });
    }
    const cands = [
      { field: 'x', camp: 'hero', interval: { lo: 18, hi: Infinity, score: 2 }, auc: 0.7 },
      { field: 'y', camp: 'hero', interval: { lo: 10, hi: Infinity, score: 1 }, auc: 0.51 },
    ];
    const a = recommendFactorPath(rows, [], cands, { threshold: 3 });
    const b = recommendFactorPath(rows, [], cands, { threshold: 3, objective: 'rho' });
    assert.deepStrictEqual(a.path.map(p => p.field), b.path.map(p => p.field), '默认值必须等价');
    assert.strictEqual(a.objective, 'rho', '返回值要带回目标口径，UI 不能靠猜 deltaTest 是 Δρ 还是 Δlift');
  });

  test('recommendFactorPath: objective=topLift 时 deltaTest 是 lift 的增量（量级完全不同）', () => {
    const rows = [];
    for (let i = 0; i < 200; i++) {
      const x = i % 25;
      rows.push({ returnMax: x >= 18 ? 5 : 1, features: { x }, swapBeginTime: 1000 + i });
    }
    const cands = [{ field: 'x', camp: 'hero', interval: { lo: 18, hi: Infinity, score: 2 }, auc: 0.7 }];
    const r = recommendFactorPath(rows, [], cands, { threshold: 3, objective: 'topLift' });
    assert.strictEqual(r.objective, 'topLift');
    if (r.path.length) {
      assert.ok(r.path[0].deltaTest > 0.02, `Δlift 应在 lift 的量级上，实际 ${r.path[0].deltaTest}`);
    }
  });

  test('recommendFactorPath: 显式 scoreFn 仍然优先（既有调用方不受影响）', () => {
    const rows = [];
    for (let i = 0; i < 120; i++) rows.push({ returnMax: i % 5 === 0 ? 5 : 1, features: { x: i % 20 }, swapBeginTime: 1000 + i });
    const cands = [{ field: 'x', camp: 'hero', interval: { lo: 10, hi: Infinity, score: 1 }, auc: 0.6 }];
    let called = 0;
    const custom = (rs, fs, mp) => { called++; return scorePoolRho(rs, fs, mp); };
    const r = recommendFactorPath(rows, [], cands, { threshold: 3, objective: 'topLift', scoreFn: custom });
    assert.ok(called > 0, '传了 scoreFn 就该用它，objective 不能把它覆盖掉');
    assert.strictEqual(r.objective, 'custom');
  });
}
