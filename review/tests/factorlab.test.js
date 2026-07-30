// ========== factorLab（回测·因子）单元测试 ==========
// 覆盖：梯形打分边界、高倍区间挖掘（种入信号/纯噪声）、时间切分回退链、自动权重归一、
// 打分/阈值扫描/十分位、OOS 无泄漏、ctx 路径解析（×100/无前缀/派生字段/mcap 特判）、
// 以及最关键的"代码生成往返"——生成的策略代码经 compileStrategy 回放，命中判定必须与
// 面板侧 scoreRow 完全一致。
import assert from 'node:assert';
import {
  trapScore, findHotInterval, findColdInterval, deriveTrapezoid, deriveColdTrapezoid,
  splitRowsByTime, autoWeights,
  scoreRow, scoreRows, buildScoreDeciles, sweepScoreCutoffs, backtestFactors,
  runOOSBacktest, runWalkForwardBacktest, assessSplitDecay, assessCutoffInert,
  compareGroupsAgainstBaseline, compareWithHardGate, resolveCtxAccessor,
  buildFactors, scanFactorCandidates, missingRate, classifyFieldOrigin, factorCorrelations,
  computeHeldOutDeltaRho, recommendCutoff, recommendFactorPath,
  computeFieldRaw, assembleCampScan,
} from '../src/lib/factorLab.js';
import { AUC_TARGET_FIELDS } from '../src/lib/auc.js';
import { compileStrategy, runStrategyOnRow, aggregateScoreStats, parseFactorCheck } from '../src/lib/proAnalytics.js';
import { mergeDaily } from '../src/lib/mergeDaily.js';
import fs from 'node:fs';

// 固定种子 LCG：区间挖掘/OOS 断言依赖确定性的样本
function makeRand(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function makeRow(id, x, win, T, extra = {}) {
  return {
    id, tokenAddress: 'CA' + id, swapBeginTime: 1000 + id, buyTimestamp: 1000 + id,
    returnMax: win ? T + 1 + (id % 7) : 1 + (id % 10) / 20,
    features: x === undefined ? {} : { x },
    ...extra,
  };
}

export async function run(test, testAsync) {
  const T = 5; // 高倍阈值

  // ---------- trapScore ----------
  test('trapScore: 满分核内为 1，过渡段线性，界外为 0', () => {
    assert.strictEqual(trapScore(5, 0, 2, 8, 10), 1);
    assert.strictEqual(trapScore(1, 0, 2, 8, 10), 0.5);
    assert.strictEqual(trapScore(9, 0, 2, 8, 10), 0.5);
    assert.strictEqual(trapScore(-1, 0, 2, 8, 10), 0);
    assert.strictEqual(trapScore(11, 0, 2, 8, 10), 0);
    assert.strictEqual(trapScore(0, 0, 2, 8, 10), 0);   // 恰在硬界上 = 0
    assert.strictEqual(trapScore(2, 0, 2, 8, 10), 1);   // 恰在满分核边界 = 1
  });
  test('trapScore: ±Infinity 表示该侧不收敛', () => {
    assert.strictEqual(trapScore(1e12, 0, 2, Infinity, Infinity), 1);
    assert.strictEqual(trapScore(-1e12, -Infinity, -Infinity, 8, 10), 1);
  });
  test('trapScore: 非有限输入（缺失）一律 0 分', () => {
    assert.strictEqual(trapScore(NaN, 0, 2, 8, 10), 0);
    assert.strictEqual(trapScore(undefined, 0, 2, 8, 10), 0);
    assert.strictEqual(trapScore(null, 0, 2, 8, 10), 0);
  });
  test('trapScore: 退化梯形（lo0==lo1 的阶跃）不应除零', () => {
    assert.strictEqual(trapScore(3, 2, 2, 8, 8), 1);
    assert.strictEqual(trapScore(1, 2, 2, 8, 8), 0);
  });

  // ---------- findHotInterval ----------
  const rand = makeRand(42);
  const planted = [];
  for (let i = 0; i < 300; i++) {
    const x = rand() * 100;
    const p = x >= 30 && x <= 60 ? 0.55 : 0.08;
    planted.push(makeRow(i, x, rand() < p, T));
  }
  test('findHotInterval: 种入 [30,60] 的高倍信号应被挖出，lift > 2', () => {
    const res = findHotInterval(planted, 'x', { winThreshold: T });
    assert.ok(!res.error, res.error);
    assert.ok(res.lift > 2, `lift=${res.lift}`);
    // 区间应大致覆盖种入范围（分位数网格有粒度，允许边缘偏差）
    assert.ok(res.lo >= 20 && res.lo <= 40, `lo=${res.lo}`);
    assert.ok(res.hi >= 50 && res.hi <= 72, `hi=${res.hi}`);
    assert.ok(res.coverage >= 0.3);
  });
  test('findHotInterval: 纯噪声不应给出高 lift 区间', () => {
    const r2 = makeRand(7);
    const noise = [];
    for (let i = 0; i < 300; i++) noise.push(makeRow(i, r2() * 100, r2() < 0.2, T));
    const res = findHotInterval(noise, 'x', { winThreshold: T });
    assert.ok(res.error || res.lift < 1.8, `噪声却挖出 lift=${res.lift}`);
  });
  test('findHotInterval: null/空串取值应被剔除而不是当成 0', () => {
    const mixed = planted.map((r, i) => (i % 5 === 0 ? { ...r, features: { x: i % 10 === 0 ? null : '' } } : r));
    const res = findHotInterval(mixed, 'x', { winThreshold: T });
    assert.ok(!res.error, res.error);
    assert.ok(res.total <= 240, `剔除后样本应减少，实际 ${res.total}`);
  });
  test('findHotInterval: 高倍盘不足 5 个应明确拒绝', () => {
    const few = planted.map(r => ({ ...r, returnMax: 1 }));
    few[0] = { ...few[0], returnMax: T + 1 };
    const res = findHotInterval(few, 'x', { winThreshold: T });
    assert.ok(res.error && res.error.includes('高倍盘'), res.error);
  });

  // ---------- deriveTrapezoid ----------
  test('deriveTrapezoid: 满分核应落在区间内，硬界外扩且 lo0<=lo1<=hi1<=hi0', () => {
    const iv = findHotInterval(planted, 'x', { winThreshold: T });
    const tr = deriveTrapezoid(planted, 'x', iv, T);
    assert.ok(!tr.error, tr.error);
    assert.ok(tr.lo0 <= tr.lo1 && tr.lo1 <= tr.hi1 && tr.hi1 <= tr.hi0);
    assert.ok(tr.lo1 >= iv.lo && tr.hi1 <= iv.hi, '满分核应在区间内');
  });
  test('deriveTrapezoid: 单边开区间该侧应保持 ±Infinity', () => {
    const tr = deriveTrapezoid(planted, 'x', { lo: 30, hi: Infinity }, T);
    assert.ok(!tr.error, tr.error);
    assert.strictEqual(tr.hi1, Infinity);
    assert.strictEqual(tr.hi0, Infinity);
    assert.ok(Number.isFinite(tr.lo1));
  });

  // ---------- splitRowsByTime ----------
  test('splitRowsByTime: 70/30 切分 + 锚点回退链（swapBeginTime→buyTimestamp→末尾）', () => {
    const rows = [
      { id: 1, swapBeginTime: 300, buyTimestamp: 1 },
      { id: 2, swapBeginTime: null, buyTimestamp: 100 },   // 回退到 buyTimestamp
      { id: 3, swapBeginTime: 200, buyTimestamp: 999 },
      { id: 4, swapBeginTime: null, buyTimestamp: null },  // 都没有 → 排最后
      { id: 5, swapBeginTime: 100, buyTimestamp: 1 },
      { id: 6, swapBeginTime: 400, buyTimestamp: 1 },
      { id: 7, swapBeginTime: 250, buyTimestamp: 1 },
      { id: 8, swapBeginTime: 150, buyTimestamp: 1 },
      { id: 9, swapBeginTime: 350, buyTimestamp: 1 },
      { id: 10, swapBeginTime: 50, buyTimestamp: 1 },
    ];
    const { train, test: te } = splitRowsByTime(rows, 0.7);
    assert.strictEqual(train.length, 7);
    assert.strictEqual(te.length, 3);
    assert.strictEqual(train[0].id, 10);                       // 最早
    assert.strictEqual(te[te.length - 1].id, 4);               // 无时间的排最后
    assert.strictEqual(train[1].id, 2);                        // buyTimestamp=100 回退生效
  });

  // ---------- autoWeights ----------
  // 2026-07-28 改造：权重从 ∝|AUC-0.5| 换成 ∝interval.score（区间感知，见 scanIntervalCore/
  // factorLab.js 顶部注释）——AUC 假设方向单调，"驼峰型"字段会被误判成没区分度，改用区间打分
  // 才跟下游的梯形/区间打分口径一致。下面几个测试改用 interval.score 构造。
  test('autoWeights: 权重 ∝ interval.score，总和恰为 100', () => {
    const fs = autoWeights([
      { interval: { score: 2.0 } }, { interval: { score: 1.0 } }, { interval: { score: 0.5 } },
    ]);
    const sum = fs.reduce((a, f) => a + f.weight, 0);
    assert.ok(Math.abs(sum - 100) < 1e-6, `sum=${sum}`);
    assert.ok(fs[0].weight > fs[1].weight && fs[1].weight > fs[2].weight);
    // 2.0 : 1.0 : 0.5 → 约 57.1 : 28.6 : 14.3
    assert.ok(Math.abs(fs[0].weight - 57.1) < 0.2, `w0=${fs[0].weight}`);
  });
  test('autoWeights: interval.score 全为 0（或缺失 interval）时退化为均分', () => {
    const fs = autoWeights([{ interval: { score: 0 } }, {}]);
    assert.ok(Math.abs(fs[0].weight - 50) < 0.11 && Math.abs(fs[1].weight - 50) < 0.11);
    assert.ok(Math.abs(fs[0].weight + fs[1].weight - 100) < 1e-6);
  });
  test('autoWeights: 高AUC但驼峰型字段的区间分数不该被单调AUC掩盖——区间强的该拿更高权重，不管AUC显不显著', () => {
    // 驼峰字段：AUC 因两头对称抵消而不显著（甚至可能<0.5），但区间打分很强；
    // 弱单调字段：AUC 显著更高，但区间打分更弱（信号弥散、不集中）。
    // 用旧公式（|AUC-0.5|）算，弱单调字段权重会反而更高——这正是要修的问题。
    const hump = { field: 'hump', auc: 0.52, interval: { score: 1.45 } };
    const weakMono = { field: 'weakMono', auc: 0.68, interval: { score: 0.99 } };
    const fs = autoWeights([hump, weakMono]);
    const humpF = fs.find(f => f.field === 'hump'), weakF = fs.find(f => f.field === 'weakMono');
    assert.ok(humpF.weight > weakF.weight, `驼峰字段区间分数更强，权重应更高：hump=${humpF.weight} weakMono=${weakF.weight}`);
    // 反证：旧公式会把顺序搞反
    const oldRaw = [Math.abs(hump.auc - 0.5), Math.abs(weakMono.auc - 0.5)];
    assert.ok(oldRaw[0] < oldRaw[1], '旧公式(|AUC-0.5|)下驼峰字段权重会更低，构造反例本身要成立');
  });

  // ---------- scoreRow / sweep / deciles ----------
  const factor1 = { field: 'x', weight: 100, lo0: 0, lo1: 10, hi1: 20, hi0: 30 };
  test('scoreRow: 满分核 100 分，过渡段 50 分，缺失 0 分', () => {
    assert.strictEqual(scoreRow(makeRow(1, 15, false, T), [factor1]).score, 100);
    assert.strictEqual(scoreRow(makeRow(2, 5, false, T), [factor1]).score, 50);
    assert.strictEqual(scoreRow(makeRow(3, undefined, false, T), [factor1]).score, 0);
  });
  test('scoreRow: 总分按权重和归一，权重和 ≠100 时含义不变', () => {
    const f2 = [{ ...factor1, weight: 30 }, { field: 'x', weight: 30, lo0: 0, lo1: 10, hi1: 20, hi0: 30 }];
    assert.strictEqual(scoreRow(makeRow(1, 15, false, T), f2).score, 100);
  });
  test('sweepScoreCutoffs: 触发数随 cutoff 单调不增，cutoff=0 时捕获率=1', () => {
    const rows = [];
    const r3 = makeRand(9);
    for (let i = 0; i < 60; i++) rows.push(makeRow(i, r3() * 30, r3() < 0.3, T));
    const scored = scoreRows(rows, [factor1]);
    const { points, base } = sweepScoreCutoffs(scored, T);
    assert.ok(base.pos > 0);
    assert.strictEqual(points[0].capture, 1);
    for (let i = 1; i < points.length; i++) assert.ok(points[i].triggered <= points[i - 1].triggered);
  });
  test('sweepScoreCutoffs: 精确率/召回按手造样本验算', () => {
    // 4 行：分数 100/100/50/0，高倍的是前两行
    const rows = [makeRow(1, 15, true, T), makeRow(2, 15, true, T), makeRow(3, 5, false, T), makeRow(4, undefined, false, T)];
    const { points } = sweepScoreCutoffs(scoreRows(rows, [factor1]), T);
    const at60 = points.find(p => p.cut === 60);
    assert.strictEqual(at60.triggered, 2);
    assert.strictEqual(at60.hitRate, 1);
    assert.strictEqual(at60.capture, 1);
    const at40 = points.find(p => p.cut === 40);
    assert.strictEqual(at40.triggered, 3);
    assert.ok(Math.abs(at40.hitRate - 2 / 3) < 1e-9);
  });
  test('buildScoreDeciles: 等量分箱且高倍率验算正确', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(makeRow(i, i, i >= 10 && i <= 20, T)); // 满分核内的都是高倍
    const dec = buildScoreDeciles(scoreRows(rows, [factor1]), T);
    assert.strictEqual(dec.length, 10);
    assert.strictEqual(dec.reduce((a, d) => a + d.n, 0), 30);
    assert.strictEqual(dec[dec.length - 1].hiRate, 1, '最高分段应全是高倍');
    assert.strictEqual(dec[0].hiRate, 0, '最低分段应无高倍');
  });

  // ---------- OOS 无泄漏 ----------
  {
    const r4 = makeRand(123);
    const rows = [];
    // 训练段（时间靠前，前 140 条）：信号在 [30,60]；验证段（后 60 条）：信号只在 [80,95]
    for (let i = 0; i < 200; i++) {
      const isTrain = i < 140;
      const x = r4() * 100;
      const p = isTrain ? (x >= 30 && x <= 60 ? 0.55 : 0.08)
                        : (x >= 80 && x <= 95 ? 0.7 : 0.05);
      rows.push(makeRow(i, x, r4() < p, T));
    }
    const oos = await runOOSBacktest(rows, ['x'], T, { bootstrapB: 60 });
    test('runOOSBacktest: 区间只从训练段推导，不泄漏验证段的信号', () => {
      assert.ok(!oos.error, oos.error);
      const iv = oos.trainFactors[0].interval;
      // 训练段信号在 [30,60]，验证段独有的 [80,95] 不该被捡走
      assert.ok(iv.lo <= 62, `lo=${iv.lo}`);
      assert.ok(iv.lo >= 15, `lo=${iv.lo}`);
      assert.ok(iv.hi <= 78, `hi=${iv.hi}（疑似泄漏验证段信号）`);
      assert.strictEqual(oos.trainSize, 140);
      assert.strictEqual(oos.testSize, 60);
    });
    test('runOOSBacktest: 训练段规律在分布漂移的验证段上应明显衰减', () => {
      const trainLift = oos.train.sweep.points.find(p => p.cut === 60).lift;
      const testLift = oos.test.sweep.points.find(p => p.cut === 60).lift;
      assert.ok(trainLift > 1.5, `trainLift=${trainLift}`);
      assert.ok(testLift < trainLift, `test=${testLift} train=${trainLift}`);
    });

    // 2026-07-28 新增 walk-forward 多段滚动：splits=1 时第 0 段应该跟 runOOSBacktest 单次切分
    // 完全等价（同一个 trainRatio、同一份数据、同一套 backtestOneSplit 核心逻辑），验证重构没有
    // 悄悄改变原有单次切分的行为。
    const wf1 = await runWalkForwardBacktest(rows, ['x'], T, { bootstrapB: 60, splits: 1 });
    test('runWalkForwardBacktest: splits=1 时应与 runOOSBacktest 单次切分等价', () => {
      assert.ok(!wf1.error, wf1.error);
      assert.strictEqual(wf1.folds.length, 1);
      assert.strictEqual(wf1.folds[0].trainSize, oos.trainSize);
      assert.strictEqual(wf1.folds[0].testSize, oos.testSize);
      assert.strictEqual(wf1.folds[0].splitIndex, 0);
      assert.ok(Array.isArray(wf1.folds[0].factorDecay) && wf1.folds[0].factorDecay.length === 1,
        '应带逐因子归因(factorDecay)');
      assert.strictEqual(wf1.folds[0].factorDecay[0].field, 'x');
      assert.ok(Number.isFinite(wf1.folds[0].factorDecay[0].trainAuc));
    });

    // 多段（splits=3）：扩张窗口——后一段训练集应该包含前一段的验证窗口，因此严格递增。
    const wf3 = await runWalkForwardBacktest(rows, ['x'], T, { bootstrapB: 60, splits: 3 });
    test('runWalkForwardBacktest: splits=3 时应切出3段，训练集逐段扩张（扩张窗口）', () => {
      assert.ok(!wf3.error, wf3.error);
      assert.strictEqual(wf3.folds.length, 3);
      assert.ok(wf3.folds[1].trainSize > wf3.folds[0].trainSize, '第1段训练集应比第0段大');
      assert.ok(wf3.folds[2].trainSize > wf3.folds[1].trainSize, '第2段训练集应比第1段大');
      // 验证窗口按时间顺序前进，互不重叠
      assert.ok(wf3.folds[0].testEnd <= wf3.folds[1].testStart + 1, '验证窗口应按时间前后相接');
      assert.ok(wf3.folds[1].testEnd <= wf3.folds[2].testStart + 1);
    });

    {
      // 验证池只有 60 条，要求 splits=20 段（每段将<15条）——应该自动降到能保证每段≥15条的段数
      const wfMany = await runWalkForwardBacktest(rows, ['x'], T, { bootstrapB: 60, splits: 20 });
      test('runWalkForwardBacktest: 段数请求过多时自动降段，每段验证窗口≥15条', () => {
        assert.ok(!wfMany.error, wfMany.error);
        assert.ok(wfMany.splits < 20, `验证池只有60条，不该真的切出20段，实际 ${wfMany.splits}`);
        assert.ok(wfMany.folds.every(f => f.testSize >= 15), '每段验证窗口应≥15条');
      });
    }

    // 2026-07-29：每段自己在训练段上定 cutoff。以前这里不返回 cutoff，调用方拿页面上那个全样本
    // cutoff 去 sweepAt，而各段是重新配权的、分数分布对不上——阈值整体失效（触发≈全量、lift≡1.00）。
    test('runWalkForwardBacktest: 每段应带自己训出来的 cutoff，且落在该段训练分数区间内', () => {
      for (const f of wf3.folds) {
        assert.ok(Number.isFinite(f.cutoff), `第${f.splitIndex}段应给出 cutoff`);
        assert.strictEqual(f.cutoffSource, 'train', '样本充足时应是训练段定出来的，不是兜底');
        const cuts = f.train.sweep.points.map(p => p.cut);
        assert.ok(f.cutoff >= Math.min(...cuts) && f.cutoff <= Math.max(...cuts),
          `cutoff=${f.cutoff} 应落在该段训练扫描网格内`);
      }
    });
    test('runWalkForwardBacktest: 该段 cutoff 在训练段上应真的筛掉东西（不是放行全部）', () => {
      const sweepAt = (bt, cut) => bt.sweep.points.reduce((b, p) => (p.cut <= cut ? p : b), bt.sweep.points[0]);
      for (const f of wf3.folds) {
        const tr = sweepAt(f.train, f.cutoff);
        assert.ok(tr.triggered < f.trainSize,
          `第${f.splitIndex}段训练触发 ${tr.triggered}/${f.trainSize}，阈值等于没筛`);
        assert.ok(tr.lift > 1, `第${f.splitIndex}段训练 lift=${tr.lift}，训出来的阈值至少要跑赢基准`);
      }
    });

    // cutoffMode='fixed'：显式要求沿用外部传进来的 cutoff（保留旧行为的逃生口）
    const wfFixed = await runWalkForwardBacktest(rows, ['x'], T,
      { bootstrapB: 60, splits: 3, cutoffMode: 'fixed', cutoff: -12 });
    test('runWalkForwardBacktest: cutoffMode=fixed 时各段沿用外部 cutoff 并标明来源', () => {
      assert.ok(wfFixed.folds.every(f => f.cutoff === -12), '应原样沿用 -12');
      assert.ok(wfFixed.folds.every(f => f.cutoffSource === 'fixed'), '来源要标 fixed，报告才能提示不可比');
    });

    // keepWeights：只重挖区间、权重沿用因子池那一套（把"配权变了"这个变量摘掉）
    const specsW = [{ field: 'x', camp: 'hero', weight: 42 }];
    const wfKeep = await runWalkForwardBacktest(rows, specsW, T, { bootstrapB: 60, splits: 1, keepWeights: true });
    const wfAuto = await runWalkForwardBacktest(rows, specsW, T, { bootstrapB: 60, splits: 1 });
    test('runWalkForwardBacktest: keepWeights 打开时沿用因子池权重，关闭时走 autoWeights', () => {
      assert.strictEqual(wfKeep.folds[0].weightSource, 'pool');
      assert.strictEqual(wfKeep.folds[0].trainFactors[0].weight, 42, '应贴回池子里的权重');
      assert.strictEqual(wfAuto.folds[0].weightSource, 'auto');
      assert.strictEqual(wfAuto.folds[0].trainFactors[0].weight, 100, 'autoWeights 单因子归一到 100');
    });
    // specs 是字符串数组（没有 weight）却打开了 keepWeights：只能整体退回自动配权，
    // 绝不能只贴回一部分——那会造出一套既不是池子也不是自动的混合尺度，比两者都难解释。
    const wfNoWeight = await runWalkForwardBacktest(rows, ['x'], T, { bootstrapB: 60, splits: 1, keepWeights: true });
    test('runWalkForwardBacktest: keepWeights 打开但 specs 没带权重时应退回自动配权，不造混合尺度', () => {
      assert.strictEqual(wfNoWeight.folds[0].weightSource, 'auto-fallback');
      assert.strictEqual(wfNoWeight.folds[0].trainFactors[0].weight, 100, '退回后就是纯 autoWeights 的结果');
    });
  }

  // ---------- assessCutoffInert：阈值是否形同虚设 ----------
  test('assessCutoffInert: 训练段触发率≥95% 判定阈值失效', () => {
    assert.strictEqual(assessCutoffInert({ triggered: 96 }, 100).inert, true);
    assert.strictEqual(assessCutoffInert({ triggered: 95 }, 100).inert, true, '正好 95% 也算失效');
    assert.strictEqual(assessCutoffInert({ triggered: 94 }, 100).inert, false);
    assert.ok(Math.abs(assessCutoffInert({ triggered: 40 }, 100).frac - 0.4) < 1e-9);
  });
  test('assessCutoffInert: 缺样本量/缺 point 时不谎报失效', () => {
    assert.strictEqual(assessCutoffInert(null, 100).inert, false);
    assert.strictEqual(assessCutoffInert({ triggered: 10 }, 0).inert, false);
  });

  // ---------- assessSplitDecay：用两比例检验判断验证段是否显著衰减，替代固定阈值 ----------
  test('assessSplitDecay: 大样本下命中率明显更低应判显著衰减', () => {
    const train = { hit: 60, triggered: 200, hitRate: 0.3 };  // 训练段 30%
    const test_ = { hit: 10, triggered: 200, hitRate: 0.05 }; // 验证段 5%，明显更低
    const r = assessSplitDecay(train, test_);
    assert.ok(!r.insufficientN);
    assert.strictEqual(r.decayed, true);
    assert.strictEqual(r.significant, true, `应判显著衰减，p=${r.p}`);
  });
  test('assessSplitDecay: 命中率相近（抽样噪声范围内）不该判显著', () => {
    const train = { hit: 60, triggered: 200, hitRate: 0.3 };
    const test_ = { hit: 55, triggered: 200, hitRate: 0.275 }; // 差异很小
    const r = assessSplitDecay(train, test_);
    assert.strictEqual(r.significant, false, `差异很小不该判显著，p=${r.p}`);
  });
  test('assessSplitDecay: 验证段命中率反而更高时不该判衰减', () => {
    const train = { hit: 20, triggered: 200, hitRate: 0.1 };
    const test_ = { hit: 40, triggered: 200, hitRate: 0.2 };
    const r = assessSplitDecay(train, test_);
    assert.strictEqual(r.decayed, false);
    assert.strictEqual(r.significant, false);
  });
  test('assessSplitDecay: 触发数太少（<5）时应标 insufficientN，不给出判定', () => {
    const train = { hit: 1, triggered: 3, hitRate: 1 / 3 };
    const test_ = { hit: 0, triggered: 2, hitRate: 0 };
    const r = assessSplitDecay(train, test_);
    assert.strictEqual(r.insufficientN, true);
    assert.ok(!Number.isFinite(r.p));
    assert.strictEqual(r.significant, false, '样本不足不该报显著（宁可不下结论）');
  });

  // ---------- compareGroupsAgainstBaseline：基线库(整体) vs 训练集(按天/按组) 对比，不重训因子 ----------
  // 用一个恒定命中区间的因子（x 固定=8，永远落在 [5,∞)，score 恒为满分）——这样 sweepAt(cutoff=0)
  // 恒好触发全部样本，纯粹隔离测试"组 vs 基线库 命中率对比"这个逻辑，不跟区间/梯形细节纠缠。
  {
    const cmpFactor = [{ field: 'x', camp: 'hero', weight: 100, lo0: -Infinity, lo1: 5, hi1: Infinity, hi0: Infinity }];
    // 用取模构造【精确】命中率，不靠 RNG 凑近似值——LCG 在小样本上离目标概率飘多少不可控，
    // 精确取模让"命中率该判显著/不该判显著"这类边界断言可复现、不受种子选择影响。
    const mkCmpRowsExact = (n, hitsPer100) => {
      const out = [];
      for (let i = 0; i < n; i++) out.push(makeRow(i, 8, (i % 100) < hitsPer100, T));
      return out;
    };
    test('compareGroupsAgainstBaseline: 组命中率明显低于基线库时应判显著偏离', () => {
      const baseline = mkCmpRowsExact(300, 30);   // 命中率精确 30%
      const groupBad = mkCmpRowsExact(200, 5);    // 命中率精确 5%，明显更差
      const r = compareGroupsAgainstBaseline(baseline, [{ label: 'day1', rows: groupBad }], cmpFactor, T, { cutoff: 0 });
      assert.ok(!r.error, r.error);
      assert.strictEqual(r.groups[0].label, 'day1');
      assert.ok(r.groups[0].decay.significant, `应判显著偏离，p=${r.groups[0].decay.p}`);
    });
    test('compareGroupsAgainstBaseline: 命中率接近基线库时不该判偏离', () => {
      const baseline = mkCmpRowsExact(300, 30);   // 命中率精确 30%
      const groupOk = mkCmpRowsExact(250, 29);    // 命中率精确 29%，跟基线几乎一样
      const r = compareGroupsAgainstBaseline(baseline, [{ label: 'day1', rows: groupOk }], cmpFactor, T, { cutoff: 0 });
      assert.ok(!r.error, r.error);
      assert.strictEqual(r.groups[0].decay.significant, false);
    });
    test('compareGroupsAgainstBaseline: 多组各自独立对比，互不影响', () => {
      const baseline = mkCmpRowsExact(300, 30);
      const g1 = mkCmpRowsExact(200, 5);          // 明显更差
      const g2 = mkCmpRowsExact(200, 31);         // 跟基线几乎一样（还略高）
      const r = compareGroupsAgainstBaseline(baseline, [{ label: 'd1', rows: g1 }, { label: 'd2', rows: g2 }], cmpFactor, T, { cutoff: 0 });
      assert.strictEqual(r.groups.length, 2);
      assert.ok(r.groups[0].decay.significant, 'd1明显更差应判显著');
      assert.ok(!r.groups[1].decay.significant, 'd2跟基线接近（甚至更高）不该判显著');
    });
    test('compareGroupsAgainstBaseline: 因子池/基准库/对比组为空时应给出明确error而不是崩溃', () => {
      const baseline = mkCmpRowsExact(300, 30);
      assert.ok(compareGroupsAgainstBaseline(baseline, [{ label: 'd1', rows: baseline }], [], T).error, '因子池为空应报错');
      assert.ok(compareGroupsAgainstBaseline([], [{ label: 'd1', rows: baseline }], cmpFactor, T).error, '基准库为空应报错');
      assert.ok(compareGroupsAgainstBaseline(baseline, [], cmpFactor, T).error, '对比组为空应报错');
      assert.ok(compareGroupsAgainstBaseline(baseline, [{ label: 'd1', rows: [] }], cmpFactor, T).error, '唯一一组也是空应报错');
    });
  }

  // ---------- scanFactorCandidates / buildFactors ----------
  {
    const scan = await scanFactorCandidates(planted, ['x'], { winThreshold: T, bootstrapB: 60 });
    test('scanFactorCandidates: 有信号字段应给出 AUC 与推荐区间', () => {
      assert.strictEqual(scan.candidates.length, 1);
      const c = scan.candidates[0];
      assert.ok(Number.isFinite(c.auc));
      assert.ok(c.interval, c.intervalError || '无区间');
      assert.strictEqual(c.missRate, 0);
    });
    // 2026-07-28：区间显著性从"两比例检验"换成"置换检验"（见 scanIntervalCore 内部注释）——
    // 之前的两比例检验直接对 scanIntervalCore 已经从很多候选窗口里挑出来的最优窗口做检验，
    // 没有为"搜了这么多窗口才挑出这个"做校正（look-elsewhere/winner's curse）。真实种入的
    // 强信号应该在新实现下依然判显著，防止修复本身把好信号也误伤。
    test('scanFactorCandidates: 真实种入的强信号字段，区间置换检验应判显著（不是巧合撞出来的）', () => {
      const c = scan.candidates[0];
      assert.ok(Number.isFinite(c.interval.pPermutation), 'pPermutation 应该是个有效数值');
      assert.ok(c.interval.significantAdj, `真实信号应判显著，实际 pAdj=${c.interval.pAdj}`);
    });
    test('buildFactors: 由扫描结果构建因子并自动配权', () => {
      const { factors, skipped } = buildFactors(planted, scan.candidates, ['x'], T);
      assert.strictEqual(skipped.length, 0);
      assert.strictEqual(factors.length, 1);
      assert.ok(Math.abs(factors[0].weight - 100) < 1e-6, '单因子权重应为 100');
      assert.ok(factors[0].lo0 <= factors[0].lo1);
    });
    // shape:'interval'（矩形边界）的两条用例随该选项一起删除（2026-07-29，见 buildFactors 注释）。
    // trapScore 处理矩形因子的能力仍被 factorlab-fixes.test.js 的开区间/矩形用例覆盖——
    // 从策略导入的因子就是矩形，那条路还在。
  }

  // ---------- 候选粗筛/配权改用 interval.score（区间感知）而不是单调AUC 的回归测试 ----------
  // 2026-07-28：追查"三个核心问题"时发现的真实逻辑矛盾——scanFieldsAuc 在原始特征值上假设
  // 方向单调，下游打分（梯形/区间）不假设方向，两者可能给同一个字段相反的结论。构造一个
  // "驼峰型"字段（中段[40,60]命中率高、两头对称地低，两头互相抵消导致方向性AUC不显著）
  // 和一个"弱单调"字段（全程小幅单调，AUC显著但信号弥散、区间打分弱）对照，验证新公式/新排序
  // 键能正确识别出驼峰字段才是更强的信号，不会被 AUC 的方向性假设误伤。
  {
    const randH = makeRand(7);
    const humpRows = [];
    for (let i = 0; i < 400; i++) {
      const hump = randH() * 100; // 值域[0,100]均匀；热区[40,60]左右对称，两侧宽度相同(各40)
      const win = randH() < (hump >= 40 && hump <= 60 ? 0.6 : 0.1);
      // weakMono：跟 win 有真实但弱的单调关联——两组大范围重叠(各自跨度~90)，只是中心
      // 略微偏移(±6)，不能像 hump 的[40,60]那样有清晰边界，否则区间挖掘反而会找到一个
      // 近乎完美的切点，信号会变得比 hump 更强，测不出"AUC显著但区间弱"这个对照
      const weakMono = 50 + (win ? 6 : -6) + (randH() - 0.5) * 90;
      humpRows.push(makeRow(i, undefined, win, T, { features: { hump, weakMono } }));
    }
    const scanHump = await scanFactorCandidates(humpRows, ['hump', 'weakMono'], { winThreshold: T, bootstrapB: 80 });
    const humpC = scanHump.candidates.find(c => c.field === 'hump');
    const weakC = scanHump.candidates.find(c => c.field === 'weakMono');

    test('scanFactorCandidates: 驼峰字段的方向性AUC不显著，但区间打分/lift应明显强于弱单调字段', () => {
      assert.ok(humpC.interval, humpC.intervalError || '驼峰字段应挖出区间');
      assert.ok(weakC.interval, weakC.intervalError || '弱单调字段应挖出区间');
      assert.ok(Math.abs(humpC.auc - 0.5) < Math.abs(weakC.auc - 0.5),
        `驼峰字段的方向性AUC应比弱单调字段更接近0.5：hump.auc=${humpC.auc} weak.auc=${weakC.auc}`);
      assert.ok(humpC.interval.score > weakC.interval.score,
        `驼峰字段的区间分数应更强：hump.score=${humpC.interval.score} weak.score=${weakC.interval.score}`);
      assert.ok(humpC.interval.significantAdj, '驼峰字段的区间应该是统计显著的（BH校正后）');
    });

    test('autoWeights: 接入真实扫描结果后，驼峰字段应拿到比弱单调字段更高的权重', () => {
      const { factors } = buildFactors(humpRows, scanHump.candidates,
        [{ field: 'hump', camp: 'hero' }, { field: 'weakMono', camp: 'hero' }], T);
      const humpF = factors.find(f => f.field === 'hump'), weakF = factors.find(f => f.field === 'weakMono');
      assert.ok(humpF.weight > weakF.weight,
        `驼峰字段区间信号更强，权重应更高：hump=${humpF.weight} weakMono=${weakF.weight}`);
    });

    test('recommendFactorPath 的 candLimit 粗筛：按 interval.score 排序时驼峰字段应排在弱单调字段前面（旧的|AUC-0.5|排序会反过来）', () => {
      const sortedNew = [...scanHump.candidates].sort((a, b) => (b.interval?.score ?? 0) - (a.interval?.score ?? 0));
      assert.strictEqual(sortedNew[0].field, 'hump', '新排序键下驼峰字段应排第一');
      const sortedOld = [...scanHump.candidates].sort((a, b) => Math.abs((b.auc ?? 0.5) - 0.5) - Math.abs((a.auc ?? 0.5) - 0.5));
      assert.strictEqual(sortedOld[0].field, 'weakMono', '反证：旧的AUC排序键下弱单调字段会排第一，说明这个构造确实复现了问题');
    });
  }

  // ---------- 区间显著性置换检验：纯噪声字段不该被巧合窗口误判成真信号 ----------
  // 2026-07-28：修复"区间显著性检验没有为搜索了很多候选窗口这件事做校正"的问题（见
  // scanIntervalCore 内部注释）。这里构造一个跟输赢完全无关的纯噪声字段，多个随机种子里
  // 实测过 scanIntervalCore 确实会"运气好"搜到 lift 1.0~1.2 的窗口（不是没窗口，是窗口看起来
  // 还不错）——这正是旧版两比例检验最容易被骗过的场景，置换检验必须能识破它。
  {
    const randN = makeRand(7);
    const noiseRows = [];
    for (let i = 0; i < 300; i++) {
      const win = randN() < 0.15; // 基准命中率~15%，贴近真实项目口径
      const noise = randN() * 100; // 跟 win 完全无关
      noiseRows.push(makeRow(i, undefined, win, T, { features: { noise } }));
    }
    await testAsync('scanFactorCandidates: 纯噪声字段即使"运气好"搜到 lift>1 的窗口，置换检验也不该判显著', async () => {
      const scan = await scanFactorCandidates(noiseRows, ['noise'], { winThreshold: T, bootstrapB: 60 });
      const c = scan.candidates[0];
      if (c.interval) {
        assert.ok(!c.interval.significantAdj,
          `纯噪声字段不该判显著（lift=${c.interval.lift.toFixed(2)}, pAdj=${c.interval.pAdj}）——说明置换检验被这个巧合窗口骗过去了`);
      }
      // 没挖出任何达标区间（intervalError）也是可以接受的结果——只要不是"显著"就行
    });

    // 2026-07-28 试过又撤销：曾经在 recommendFactorPath 里加过"significantAdj===false 就排除"
    // 的硬过滤，真实数据上发现单字段AUC普遍贴着0.5（这套系统靠很多个体弱信号加权组合，不是
    // 靠单字段自证清白），硬门槛会把候选池筛空、因子推荐直接变成空的——比偶尔推荐一个不够
    // 严谨的字段更糟，已撤销。区间显著性现在只在UI候选表当展示参考，不再是 recommendFactorPath
    // 的硬门槛（recommendFactorPath 自己的 train/test held-out 验证已经足够把关）。
    test('recommendFactorPath: 区间显著性不显著的候选，只要 held-out 边际贡献够好仍然可以被推荐（不再硬性排除）', () => {
      const fakeCandidate = { field: 'x', camp: 'hero', auc: 0.9, interval: { lo: 30, hi: 60, significantAdj: false } };
      const r = recommendFactorPath(planted, [], [fakeCandidate], { threshold: T, missingPolicy: 'zero' });
      assert.ok(r.path.some(p => p.field === 'x'), '不该因为 significantAdj:false 就被硬性排除在候选池外');
    });
  }

  // ---------- 邪恶阵营：findColdInterval / deriveColdTrapezoid / 双极打分 ----------
  {
    // 专门造一份基准输率较低（~22%）的数据集：这样"危险区 100% 是输家"才能显出有意义的 lift
    // （若像 planted 那样基准输率本来就有 78%，危险区最多也就 1/0.78≈1.28 倍，测不出区分度）。
    // x 是勇者信号（[30,60] 内赢面 0.95 vs 别处 0.7），y 与胜负标签强绑定：
    // 赢家 y 落在安全区(~15-19)，输家 y 落在危险区(~80-84)——用来检验"同一行既有勇者因子
    // 又有邪恶因子"时两者符号是否正确。
    const rand4 = makeRand(123);
    const mixedRows = [];
    for (let i = 0; i < 300; i++) {
      const x = rand4() * 100;
      const pWin = (x >= 30 && x <= 60) ? 0.95 : 0.7;
      const win = rand4() < pWin;
      mixedRows.push({
        id: i, tokenAddress: 'CX' + i, swapBeginTime: 1000 + i, buyTimestamp: 1000 + i,
        returnMax: win ? T + 1 + (i % 7) : 1 + (i % 10) / 20,
        features: { x, y: (win ? 15 : 80) + (i % 5) },
      });
    }
    test('findColdInterval: y 的输家集中区应落在安全区(~15-19)与危险区(~80-84)之间的空隙里，risk-lift > 2', () => {
      const res = findColdInterval(mixedRows, 'y', { winThreshold: T });
      assert.ok(!res.error, res.error);
      assert.ok(res.lift > 2, `lift=${res.lift}`);
      // y 只有两簇取值（安全簇 15-19 / 危险簇 80-84），中间是空隙——任何切在空隙里的点都能
      // 100% 分开两簇，算法可能选空隙内任意点、上界也可能开到 +Infinity（数据里确实没有
      // 比危险簇更大的值，"y 越大越危险"在这份数据上是真的），只要求切点落在空隙内即可
      assert.ok(res.lo > 19 && res.lo < 80, `lo=${res.lo} 应落在两簇之间的空隙`);
    });
    test('deriveColdTrapezoid: 危险核应落在输家集中区间内', () => {
      const iv = findColdInterval(mixedRows, 'y', { winThreshold: T });
      const tr = deriveColdTrapezoid(mixedRows, 'y', iv, T);
      assert.ok(!tr.error, tr.error);
      assert.ok(tr.lo0 <= tr.lo1 && tr.lo1 <= tr.hi1 && tr.hi1 <= tr.hi0);
      assert.ok(tr.lo1 >= iv.lo && tr.hi1 <= iv.hi);
    });

    const scanE = await scanFactorCandidates(mixedRows, ['y'], { winThreshold: T, bootstrapB: 60, camp: 'evil' });
    test('scanFactorCandidates(camp=evil): 候选带 camp 标记，挖出输家集中的危险区', () => {
      assert.strictEqual(scanE.candidates.length, 1);
      const c = scanE.candidates[0];
      assert.strictEqual(c.camp, 'evil');
      assert.ok(c.interval, c.intervalError);
    });
    const scanH = await scanFactorCandidates(mixedRows, ['x'], { winThreshold: T, bootstrapB: 60, camp: 'hero' });
    test('scanFactorCandidates(camp=hero，默认): 候选带 camp=hero 标记', () => {
      assert.strictEqual(scanH.candidates[0].camp, 'hero');
    });
    const { factors: mixedFactors } = buildFactors(
      mixedRows, [...scanH.candidates, ...scanE.candidates],
      [{ field: 'x', camp: 'hero' }, { field: 'y', camp: 'evil' }], T);
    test('buildFactors: 混合阵营——各因子的 camp 与形状推导正确对应', () => {
      const fx = mixedFactors.find(f => f.field === 'x'), fy = mixedFactors.find(f => f.field === 'y');
      assert.strictEqual(fx.camp, 'hero');
      assert.strictEqual(fy.camp, 'evil');
      assert.ok(fy.lo1 >= 60, `evil 危险核应落在危险区，实际 lo1=${fy.lo1}`);
    });
    // y 这个合成字段两个阵营都能挖出有效区间（赢家聚在安全带、输家聚在危险带），
    // 真实浏览器走查时也确实撞过：UI 对同一批字段跑两次扫描（hero+evil），
    // 若 buildFactors 只按字段名找候选，会被数组里排在后面的那个阵营顶替，
    // 跟用户实际在哪张表里勾选的完全无关——这里锁死"按 {field,camp} 精确查找"的行为
    const scanYHero = await scanFactorCandidates(mixedRows, ['y'], { winThreshold: T, bootstrapB: 60, camp: 'hero' });
    const scanYEvil = await scanFactorCandidates(mixedRows, ['y'], { winThreshold: T, bootstrapB: 60, camp: 'evil' });
    // evil 候选排在数组更后面——如果实现退化成"只按字段名查、后者覆盖前者"，查 hero 时会误拿到 evil
    const mergedY = [...scanYHero.candidates, ...scanYEvil.candidates];
    test('buildFactors: 回归——同一字段在两个阵营都有候选时，camp 由调用方指定，不由候选数组拼接顺序决定', () => {
      assert.ok(scanYHero.candidates[0].interval, 'y 在勇者阵营下也应能挖出安全带区间（前提条件）');
      const { factors: fHero } = buildFactors(mixedRows, mergedY, [{ field: 'y', camp: 'hero' }], T);
      const { factors: fEvil } = buildFactors(mixedRows, mergedY, [{ field: 'y', camp: 'evil' }], T);
      assert.strictEqual(fHero[0].camp, 'hero', '显式指定 hero 却被 evil 顶替了');
      assert.strictEqual(fEvil[0].camp, 'evil');
      // 两者的核心区边界也应分别对应各自阵营的区间，而不是同一份
      assert.notStrictEqual(fHero[0].lo1, fEvil[0].lo1, '两个阵营对同一字段推导出的核心区应该不同');
    });
    // 并行扫描等价性回归：「扫全部字段」搬进 worker 池后，worker 路径 = computeFieldRaw（逐字段并行）
    // + assembleCampScan（主线程汇齐后统一做 AUC/区间的 BH 校正）。这套必须跟串行 scanFactorCandidates
    // 逐字段【完全一致】，否则搬进 worker 会让候选/显著性判定悄悄漂移。这里锁死等价性（含目标变量
    // returnMax 必须被两条路径同样剔除、不进候选也不进 skipped）。
    {
      const rnd = makeRand(20260728);
      const parRows = [];
      for (let i = 0; i < 400; i++) {
        const win = rnd() < 0.3;
        const sig = win ? 40 + rnd() * 20 : (rnd() < 0.5 ? rnd() * 40 : 60 + rnd() * 40); // 赢家聚在中段
        const danger = win ? rnd() * 50 : 60 + rnd() * 40;                                 // 输家聚在高位
        const noise = rnd() * 100;                                                          // 无关字段
        parRows.push({ id: i, returnMax: win ? T + 1 + (i % 5) : 1 + rnd(), features: { sig, danger, noise } });
      }
      const parFields = ['sig', 'danger', 'noise', 'returnMax'];
      const parOpts = { winThreshold: T, bootstrapB: 60, minCoverage: 0.3 };
      for (const camp of ['hero', 'evil']) {
        const serial = await scanFactorCandidates(parRows, parFields, { ...parOpts, camp });
        const scanned = parFields.filter(f => !AUC_TARGET_FIELDS.has(f));
        const viaWorkerPieces = assembleCampScan(
          scanned.map(f => computeFieldRaw(parRows, f, { ...parOpts, camp })), camp);
        test(`并行扫描等价性(camp=${camp}): computeFieldRaw + assembleCampScan 与 scanFactorCandidates 逐字段一致`, () => {
          assert.ok(serial.candidates.length >= 2, '前提：应有多个可用候选参与 BH 校正');
          assert.deepStrictEqual(viaWorkerPieces, serial);
        });
      }
    }
    test('scoreRow: 邪恶阵营命中危险区应扣分（负贡献），赢家在安全区不扣分', () => {
      const winnerRow = { id: 9001, returnMax: T + 3, features: { x: 45, y: 16 } };  // x 在勇者核心区，y 安全
      const loserRow = { id: 9002, returnMax: 1, features: { x: 5, y: 82 } };        // x 不在核心区，y 深陷危险区
      const rW = scoreRow(winnerRow, mixedFactors);
      const rL = scoreRow(loserRow, mixedFactors);
      assert.ok(rW.score > rL.score, `赢家分应显著高于输家：${rW.score} vs ${rL.score}`);
      const yIdx = mixedFactors.findIndex(f => f.field === 'y');
      assert.ok(rL.perFactor[yIdx] < 0, `输家命中危险区，邪恶阵营因子贡献应为负，实际 ${rL.perFactor[yIdx]}`);
      assert.ok(rW.perFactor[yIdx] <= 0, `赢家不在危险区，邪恶阵营贡献不应为正，实际 ${rW.perFactor[yIdx]}`);
    });
    test('sweepScoreCutoffs: 含邪恶阵营命中时下界应自动下探到覆盖最低分', () => {
      const scored = scoreRows(mixedRows, mixedFactors);
      const minScore = scored.reduce((m, s) => Math.min(m, s.score), 0);
      const { points } = sweepScoreCutoffs(scored, T);
      if (minScore < 0) assert.ok(points[0].cut <= minScore, `points 下界 ${points[0].cut} 应覆盖到最低分 ${minScore}`);
      else assert.strictEqual(points[0].cut, 0, '纯正分场景下界应保持 0（向后兼容）');
    });
    await testAsync('runOOSBacktest: fieldSpecs 支持 {field,camp} 混合写法，训练段各因子 camp 正确', async () => {
      const oosMixed = await runOOSBacktest(mixedRows, [{ field: 'x', camp: 'hero' }, { field: 'y', camp: 'evil' }], T, { bootstrapB: 40 });
      assert.ok(!oosMixed.error, oosMixed.error);
      const fx = oosMixed.trainFactors.find(f => f.field === 'x'), fy = oosMixed.trainFactors.find(f => f.field === 'y');
      assert.strictEqual(fx.camp, 'hero');
      assert.strictEqual(fy.camp, 'evil');
    });
    await testAsync('runOOSBacktest: 字符串数组写法向后兼容，全部当勇者阵营', async () => {
      const oosCompat = await runOOSBacktest(planted, ['x'], T, { bootstrapB: 40 });
      assert.ok(!oosCompat.error, oosCompat.error);
      assert.strictEqual(oosCompat.trainFactors[0].camp, 'hero');
    });
  }


  test('missingRate: 缺失比例验算', () => {
    const rows = [makeRow(1, 5, false, T), makeRow(2, undefined, false, T),
                  { ...makeRow(3, 5, false, T), features: { x: null } }];
    assert.ok(Math.abs(missingRate(rows, 'x') - 2 / 3) < 1e-9);
  });

  // ---------- classifyFieldOrigin（原字段/组装字段 分类）----------
  test('classifyFieldOrigin: ctx 原生字段是原字段，mcap 特判也是原字段', () => {
    assert.strictEqual(classifyFieldOrigin('gmgn.stat.fresh_wallet_rate').original, true);
    assert.strictEqual(classifyFieldOrigin('frequent_volume').original, true);
    assert.strictEqual(classifyFieldOrigin('mcap').original, true);
  });
  test('classifyFieldOrigin: 派生/K线量能/holder聚合 是组装字段，且带原因', () => {
    for (const f of ['buy_sell_amount_ratio', 'kline_volume_cv', 'holder_pnl_median']) {
      const c = classifyFieldOrigin(f);
      assert.strictEqual(c.original, false, f);
      assert.ok(c.reason, f + ' 应带原因');
    }
  });
  // ctx 里 chip_analysis 本身就是平台给的一个块，标量字段是原样存在的（buildRows 只是展开了一层）。
  // 曾经按前缀一刀切拦掉，害得上线告警对 chip_analysis.current_mcap 恒误报——它就是 ctx.logearn.mcap
  // 的副本，实盘取值毫无问题，用户却被建议"删掉因子或自己复刻计算逻辑"。
  test('classifyFieldOrigin: chip_analysis 的直传标量是原字段，不能按前缀一刀切', () => {
    for (const f of ['chip_analysis.current_mcap', 'chip_analysis.above_percent',
      'chip_analysis.below_percent', 'chip_analysis.total_holding_percent']) {
      assert.strictEqual(classifyFieldOrigin(f).original, true, f);
    }
  });
  test('classifyFieldOrigin: chip_analysis 里从数组算出来的那几个仍是组装字段', () => {
    for (const f of ['chip_analysis.above_below_ratio', 'chip_analysis.price_to_peak_ratio',
      'chip_analysis.price_concentration_hhi', 'chip_analysis.top5_hold_percent',
      'chip_analysis.top5_transfer_in_ratio']) {
      const c = classifyFieldOrigin(f);
      assert.strictEqual(c.original, false, f);
      assert.ok(c.reason, f + ' 应带原因');
    }
  });
  // 这四个虽然是 ctx 原生字段，但 review 侧做了「未毕业→缺失」的变换，跟 ctx 里的 0 已经不同口径，
  // 必须判成组装字段——否则 onlineExport 会内联 ctx 路径，线上未毕业的盘拿 0 而 review 是缺失。
  test('classifyFieldOrigin: 毕业哨兵拆解过的字段判成组装字段（口径已跟 ctx 不同）', () => {
    for (const f of ['is_graduated', 'launch_time_duration', 'chip_analysis.inner_sell_ratio',
      'chip_analysis.inner_address_holding', 'chip_analysis.inner_holding_address_count']) {
      assert.strictEqual(classifyFieldOrigin(f).original, false, f);
    }
  });
  test('classifyFieldOrigin: 与 resolveCtxAccessor 的拒绝口径一致', () => {
    const r = resolveCtxAccessor([], 'kline_volume_cv');
    assert.ok(!r.ok);
    assert.strictEqual(r.reason, classifyFieldOrigin('kline_volume_cv').reason);
  });

  // ---------- resolveCtxAccessor ----------
  function ctxRow(id, ratPct, freqVol, over = {}) {
    return {
      id, tokenAddress: 'CA' + id, swapBeginTime: 1000 + id, buyTimestamp: 2000 + id, returnMax: 2,
      features: {
        ...(ratPct !== undefined ? { 'gmgn.stat.top_rat_trader_percentage': ratPct } : {}),
        ...(freqVol !== undefined ? { frequent_volume: freqVol } : {}),
      },
      rawCtx: {
        gmgn: { stat: { top_rat_trader_percentage: ratPct !== undefined ? ratPct / 100 : undefined } },
        logearn: { frequent_volume: freqVol, symbol: 'TST' },
      },
      ...over,
    };
  }
  const ctxRows = [ctxRow(1, 3.3, 12.5), ctxRow(2, 7.98, 0), ctxRow(3, 0, 33.3)];
  test('resolveCtxAccessor: gmgn 占比字段应解析出 ×100 的 ctx 路径', () => {
    const r = resolveCtxAccessor(ctxRows, 'gmgn.stat.top_rat_trader_percentage');
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.path, 'gmgn.stat.top_rat_trader_percentage');
    assert.strictEqual(r.mul, 100);
  });
  test('resolveCtxAccessor: 无前缀信号字段应落到 ctx.logearn 下', () => {
    const r = resolveCtxAccessor(ctxRows, 'frequent_volume');
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.path, 'logearn.frequent_volume');
    assert.strictEqual(r.mul, 1);
  });
  test('resolveCtxAccessor: 派生字段（原始 ctx 不存在）应明确拒绝', () => {
    const r = resolveCtxAccessor(ctxRows, 'buy_sell_amount_ratio');
    assert.ok(!r.ok);
    assert.ok(r.reason.includes('组装') || r.reason.includes('派生'), r.reason);
  });
  test('resolveCtxAccessor: mcap 特判为 mcap→current_mcap→fdv 回退合并', () => {
    const rows = [{
      id: 1, returnMax: 2, features: { mcap: 45000 },
      rawCtx: { logearn: { current_mcap: 45000 } },   // mcap 缺失，回退 current_mcap
    }];
    const r = resolveCtxAccessor(rows, 'mcap');
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.path, '__effMcap__');
  });
  // 上线告警误报的回归：探测必须真的跑起来，而不是被前缀规则短路掉。
  test('resolveCtxAccessor: chip_analysis 标量应解析到 ctx.chip_analysis 下的同名路径', () => {
    const rows = [1, 2, 3].map(i => ({
      id: i, returnMax: 2,
      features: { 'chip_analysis.current_mcap': 10000 * i, 'chip_analysis.above_percent': 40 + i },
      rawCtx: { chip_analysis: { current_mcap: 10000 * i, above_percent: 40 + i } },
    }));
    const r = resolveCtxAccessor(rows, 'chip_analysis.current_mcap');
    assert.ok(r.ok, r.reason);
    assert.strictEqual(r.path, 'chip_analysis.current_mcap');
    const r2 = resolveCtxAccessor(rows, 'chip_analysis.above_percent');
    assert.ok(r2.ok, r2.reason);
  });
  test('resolveCtxAccessor: chip_analysis 字段对不上 ctx 时，理由是"核对过对不上"而不是"前缀不许"', () => {
    const rows = [1, 2, 3].map(i => ({
      id: i, returnMax: 2,
      features: { 'chip_analysis.current_mcap': 10000 * i },
      rawCtx: { chip_analysis: { current_mcap: 777 } },   // 数值对不上
    }));
    const r = resolveCtxAccessor(rows, 'chip_analysis.current_mcap');
    assert.ok(!r.ok);
    assert.ok(r.reason.includes('数值一致'), r.reason);
  });

  test('resolveCtxAccessor: 样本缺 rawCtx 时给出明确原因', () => {
    const r = resolveCtxAccessor([{ id: 1, returnMax: 2, features: { foo: 1 }, rawCtx: null }], 'foo');
    assert.ok(!r.ok && r.reason.includes('ctx'), r.reason);
  });

  // ---------- 代码生成往返：已随 generateStrategyCode 一起删除（2026-07-29）----------
  // 这里原本有两组共约 130 行的往返用例（普通阵营 / 混合阵营）：生成代码 → compileStrategy 编译 →
  // 逐行回放，断言"回放总分 ≡ 面板 scoreRow"。被测函数 generateStrategyCode 已删除（上线代码统一
  // 由策略侧 lib/onlineExport.js 生成），用例随之移除。
  // 这两组用例顺带覆盖到的东西，都另有直接用例守着，没有留下缺口：
  //   · scoreRow 的缺失记 0 分 / 权重归一 / 邪恶阵营负分 —— 见本文件 'scoreRow: ...' 三条；
  //   · 从 checks 文案反解阵营 —— 见 strategy-replay-logic 的 parseFactorCheck 用例；
  //   · 线上代码生成本身 —— 见 tests/online-export.test.js。

  // ---------- compareWithHardGate ----------
  test('compareWithHardGate: 三组统计验算', () => {
    const rows = [
      makeRow(1, 15, true, T), makeRow(2, 15, false, T), makeRow(3, 5, true, T),
      makeRow(4, 18, false, T), makeRow(5, 2, true, T), makeRow(6, undefined, false, T),
    ];
    const scored = scoreRows(rows, [factor1]); // 分数: 100,100,50,100,10,0
    const cmp = compareWithHardGate(scored, new Set([1, 3]), 70, T);
    assert.strictEqual(cmp.base.pos, 3);
    assert.strictEqual(cmp.old.n, 2);
    assert.strictEqual(cmp.old.pos, 2);
    assert.ok(Math.abs(cmp.old.capture - 2 / 3) < 1e-9);
    assert.strictEqual(cmp.neu.n, 3);        // 1,2,4
    assert.strictEqual(cmp.neu.pos, 1);      // 只有 1 是高倍
    assert.ok(Math.abs(cmp.neu.hiRate - 1 / 3) < 1e-9);
    assert.strictEqual(cmp.both.n, 1);       // 只有 1
  });

  // ---------- factorCorrelations（重复计分提醒）----------
  test('factorCorrelations: 秩相关的因子对被标出，独立因子不误报', () => {
    const r6 = makeRand(11);
    const rows = [];
    for (let i = 0; i < 60; i++) {
      const x = r6() * 100;
      rows.push({ id: i, returnMax: 1, features: { a: x, b: x * 2 + 5, c: r6() * 100 } });
    }
    const corr = factorCorrelations(rows, ['a', 'b', 'c']);
    assert.strictEqual(corr.length, 1, JSON.stringify(corr));
    assert.ok((corr[0].a === 'a' && corr[0].b === 'b'));
    assert.ok(Math.abs(corr[0].rho) > 0.99);
  });
  test('factorCorrelations: 样本不足 minN 的对子不参与', () => {
    const rows = [{ id: 1, returnMax: 1, features: { a: 1, b: 2 } }];
    assert.strictEqual(factorCorrelations(rows, ['a', 'b']).length, 0);
  });

  // ---------- computeHeldOutDeltaRho（边际ρ 的【唯一】口径：train 推边界、test 读增量）----------
  // 2026-07-29：这一组用例原本测的是样本内版 factorMarginalRho，那个函数已删除——候选表按钮、
  // 「算推荐」预筛、置换零分布三处统一走这一个函数，不再有第二套"边际ρ"。
  {
    // 复用 planted：field 'x' 在 [30,60] 集中高倍信号；额外造一个与 x 完全重复的字段 'xDup'，
    // 用来验证"信息重叠时边际贡献应趋近 0"（即便它自己单独进池的边际贡献不小）。
    const plantedDup = planted.map(r => ({ ...r, features: { x: r.features.x, xDup: r.features.x } }));

    await testAsync('computeHeldOutDeltaRho: 空因子池时，候选自己进池应给出正的验证段增量（deltaTest=withTest）', async () => {
      const scan = await scanFactorCandidates(plantedDup, ['x'], { winThreshold: T, bootstrapB: 60 });
      const c = scan.candidates[0];
      assert.ok(c.interval, 'x 应挖出可信区间');
      const res = computeHeldOutDeltaRho(plantedDup, [], c, 'hero', T);
      assert.ok(!res.error, res.error);
      assert.ok(!Number.isFinite(res.baselineTest), `空池 baselineTest 应为 NaN，实际 ${res.baselineTest}`);
      assert.ok(Number.isFinite(res.withTest) && res.withTest > 0, `withTest=${res.withTest}`);
      assert.strictEqual(res.deltaTest, res.withTest);
      assert.ok(res.nTrain > 0 && res.nTest > 0, `切分应给出两段：nTrain=${res.nTrain} nTest=${res.nTest}`);
    });

    await testAsync('computeHeldOutDeltaRho: 候选与已选因子信息完全重叠时，验证段边际贡献应远小于其独立进池的贡献', async () => {
      const scan = await scanFactorCandidates(plantedDup, ['x', 'xDup'], { winThreshold: T, bootstrapB: 60 });
      const cx = scan.candidates.find(c => c.field === 'x');
      const cDup = scan.candidates.find(c => c.field === 'xDup');
      assert.ok(cx.interval && cDup.interval);
      const { factors: poolWithX } = buildFactors(plantedDup, [cx], [{ field: 'x', camp: 'hero' }], T);
      const alone = computeHeldOutDeltaRho(plantedDup, [], cDup, 'hero', T);
      const withXInPool = computeHeldOutDeltaRho(plantedDup, poolWithX, cDup, 'hero', T);
      assert.ok(Number.isFinite(alone.deltaTest) && alone.deltaTest > 0.05, `alone.deltaTest=${alone.deltaTest}`);
      assert.ok(Number.isFinite(withXInPool.deltaTest), `withXInPool.deltaTest=${withXInPool.deltaTest}`);
      assert.ok(withXInPool.deltaTest < alone.deltaTest * 0.5,
        `重复字段的边际贡献应显著小于独立贡献：alone=${alone.deltaTest} withPool=${withXInPool.deltaTest}`);
    });

    test('computeHeldOutDeltaRho: 无可信区间的候选应报错而不是抛异常', () => {
      const res = computeHeldOutDeltaRho(plantedDup, [], { field: 'x', interval: null }, 'hero', T);
      assert.ok(res.error);
    });

    // 残差挖掘：候选的 .interval 是在残差子集（这里用前一半样本模拟）上挖出来的，
    // opts.buildRows 必须传同一份子集去推梯形边界，ρ 仍在全体（plantedDup）的 train/test 上评估。
    await testAsync('computeHeldOutDeltaRho: opts.buildRows 用于推导梯形边界，rows 仍用于 train/test 评估', async () => {
      const half = plantedDup.slice(0, 150);
      const scan = await scanFactorCandidates(half, ['x'], { winThreshold: T, bootstrapB: 60 });
      const c = scan.candidates[0];
      assert.ok(c.interval, '子集上 x 应挖出可信区间');
      const res = computeHeldOutDeltaRho(plantedDup, [], c, 'hero', T, { buildRows: half });
      assert.ok(!res.error, res.error);
      assert.ok(Number.isFinite(res.deltaTest), `deltaTest=${res.deltaTest}`);
      assert.strictEqual(res.nTest, plantedDup.length - Math.round(plantedDup.length * 0.7),
        'buildRows 只影响边界推导，评估切分仍按 rows 来');
      // 不传 buildRows 时默认用 rows 的 train 段推导，同样不应报错
      const resDefault = computeHeldOutDeltaRho(plantedDup, [], c, 'hero', T);
      assert.ok(!resDefault.error, resDefault.error);
    });

    // 泄漏回归：buildRows 也必须按同一把尺子切一刀、只用它的 train 段推边界。
    // 构造一份 buildRows，其【训练段】该字段全缺失——只有"偷偷用了全量 buildRows（含验证段）"
    // 才能推出边界；正确实现必须报错。这是"边界看过验证段、deltaTest 不再是 held-out"的守门用例。
    await testAsync('computeHeldOutDeltaRho: buildRows 只取 train 段推边界（训练段无值时报错，不偷用验证段）', async () => {
      const scan = await scanFactorCandidates(plantedDup, ['x'], { winThreshold: T, bootstrapB: 60 });
      const c = scan.candidates[0];
      const cut = Math.round(plantedDup.length * 0.7);
      // 按 swapBeginTime 升序即原序（makeRow 里 swapBeginTime=1000+id），前 70% 抹掉 x
      const trainBlind = plantedDup.map((r, i) => (i < cut ? { ...r, features: { ...r.features, x: null } } : r));
      const res = computeHeldOutDeltaRho(plantedDup, [], c, 'hero', T, { buildRows: trainBlind });
      assert.ok(res.error, `训练段推不出边界时必须报错，实际拿到 deltaTest=${res.deltaTest}`);
    });
  }

  // ---------- 缺失口径：只剩"记 0 分"一种 ----------
  // 原来这里有两条 missingPolicy:'renorm' 用例，随该口径一起删除（2026-07-29，见 scoreRow 注释：
  // onlineExport 没有对应实现，选中它回测和线上就系统性错位）。缺失记 0 分的行为由
  // 'scoreRow: 满分核 100 分，过渡段 50 分，缺失 0 分' 那条守着。
  {
    const fA = { field: 'a', weight: 60, lo0: 0, lo1: 10, hi1: 20, hi0: 30 };
    const fB = { field: 'b', weight: 40, lo0: 0, lo1: 10, hi1: 20, hi0: 30 };
    test('scoreRow: 缺失因子的权重仍留在分母里（这正是"惩罚数据不全的盘"的含义）', () => {
      const full = { id: 1, returnMax: 1, features: { a: 15, b: 5 } };   // a 满分, b 半分
      assert.strictEqual(scoreRow(full, [fA, fB]).score, 80);            // (60+20)/100
      const missB = { id: 2, returnMax: 1, features: { a: 15 } };
      assert.strictEqual(scoreRow(missB, [fA, fB]).score, 60);           // b 缺失，60/100 而不是 100
    });
  }

  // ---------- mergeDaily（多天文件合并去重）----------
  test('mergeDaily: calls 按 id 去重且保留导出更晚的那条', () => {
    const day1 = [{ id: 1, token_address: 'A', timestamp: 100, max_mcap: 500 }];
    const day2 = [{ id: 1, token_address: 'A', timestamp: 200, max_mcap: 900 },
                  { id: 2, token_address: 'B', timestamp: 200 }];
    const m = mergeDaily([day1, day2], [[]]);
    assert.strictEqual(m.calls.length, 2);
    assert.strictEqual(m.dupCalls, 1);
    assert.strictEqual(m.calls.find(c => c.id === 1).max_mcap, 900, '应保留 timestamp 更大的');
  });
  test('mergeDaily: 缺 id 的 call 退化到 token_address+timestamp 去重', () => {
    const m = mergeDaily([[{ token_address: 'A', timestamp: 100 }], [{ token_address: 'A', timestamp: 100 }]], [[]]);
    assert.strictEqual(m.calls.length, 1);
    assert.strictEqual(m.dupCalls, 1);
  });
  test('mergeDaily: snapshots 按 snapKey+timestamp 去重，不同时刻的同 token 快照都保留', () => {
    const s1 = { timestamp: 100, signal: { token_address: 'A', swap_begin_time: 50 } };
    const s2 = { timestamp: 200, signal: { token_address: 'A', swap_begin_time: 50 } };
    const m = mergeDaily([[]], [[s1, s2], [s1]]);
    assert.strictEqual(m.snapshots.length, 2);
    assert.strictEqual(m.dupSnaps, 1);
  });

  // ---------- aggregateScoreStats（打分版策略的回放聚合）----------
  {
    // 不读实盘的 强势盘策略/code-score.js——那份文件会随实盘调参持续演进（字段、权重、
    // 阵营归属都可能变），这里测的是 aggregateScoreStats 的聚合逻辑本身，不是那份策略
    // 当前的业务内容，两者耦合会导致"策略照常改进、这里的测试却跟着莫名其妙挂掉"。
    // 内联一份结构等价的合成策略（10 个打分因子权重合计 100 + 1 条硬否决），字段名和
    // 权重/区间照抄本文件历史上验证过的 score-v1.2.0 结构，下面的 ctx 造数据都是照那个
    // 结构配的。
    const scoreSrc = `
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }
const V = (x) => { if (x === null || x === undefined) return null; if (typeof x === 'boolean') return x ? 1 : 0; if (typeof x === 'string' && x.trim() === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null }
const trap = (x, lo0, lo1, hi1, hi0) => {
  if (x === null || !Number.isFinite(Number(x))) return 0
  const v = Number(x)
  if (v >= lo1 && v <= hi1) return 1
  if (v <= lo0 || v >= hi0) return 0
  if (v < lo1) { const w = lo1 - lo0; return Number.isFinite(w) && w > 0 ? (v - lo0) / w : 0 }
  const w = hi0 - hi1; return Number.isFinite(w) && w > 0 ? (hi0 - v) / w : 0
}
const CUTOFF = 60
const logearn = ctx.logearn || {}
const gmgn = ctx.gmgn || {}
const dev = gmgn.dev || {}
const stat = gmgn.stat || {}
const ki = ctx.kline_and_indicators || {}
const top10Pct = num(dev.top_10_holder_rate) * 100
const ratPct = num(stat.top_rat_trader_percentage) * 100
const effMcap = Math.max(num(logearn.current_mcap), num(logearn.mcap), num(logearn.fdv))
const buyerCntD1 = num(logearn.buyer_count_d1)
const buyTxD1 = num(logearn.buy_tx_count_d1)
const buyTxPerBuyer = buyerCntD1 > 0 ? buyTxD1 / buyerCntD1 : null
const VETOES = [
  ['内鬼%', ratPct < 10, ratPct.toFixed(1), '< 10'],
]
const FACTORS = [
  ['偏离%', V(ki.avg_price_deviation_pct) === null ? null : num(ki.avg_price_deviation_pct), 13, 2, 10, 60, 120],
  ['市值', effMcap > 0 ? effMcap : null, 18, 0, 8000, 60000, 120000],
  ['Top10持仓%', V(dev.top_10_holder_rate) === null ? null : top10Pct, 18, 15, 18, 25, 30],
  ['买入次数', V(logearn.buy_tx_count_d1) === null ? null : buyTxD1, 10, 50, 150, Infinity, Infinity],
  ['人均买入次数', buyTxPerBuyer, 5, -Infinity, -Infinity, 2.0, 2.6],
  ['高频钱包%', V(logearn.frequent_volume) === null ? null : num(logearn.frequent_volume), 7, 5, 10, Infinity, Infinity],
  ['新钱包%', V(logearn.new_volume) === null ? null : num(logearn.new_volume), 8, 20, 30, 50, 65],
  ['老钱包%', V(logearn.old_volume) === null ? null : num(logearn.old_volume), 7, 20, 30, 50, 60],
  ['新钱包率%', V(stat.fresh_wallet_rate) === null ? null : num(stat.fresh_wallet_rate) * 100, 7, 4, 8, Infinity, Infinity],
  ['机器人degen率%', V(stat.bot_degen_rate) === null ? null : num(stat.bot_degen_rate) * 100, 7, 30, 45, Infinity, Infinity],
]
let total = 0, wsum = 0
const checks = VETOES.slice()
for (const fc of FACTORS) {
  const s = trap(fc[1], fc[3], fc[4], fc[5], fc[6])
  total += s * fc[2]; wsum += fc[2]
  checks.push([fc[0] + '(分)', s > 0,
    (fc[1] === null ? '缺失' : String(Number(Number(fc[1]).toFixed(4)))) + ' → ' + (s * fc[2]).toFixed(1) + '分',
    '满分 ' + fc[4] + '~' + fc[5] + ' 权重 ' + fc[2]])
}
const score = wsum > 0 ? total / wsum * 100 : 0
const vetoPassed = VETOES.every((c) => c[1])
checks.push(['总分', score >= CUTOFF, score.toFixed(1), '>= ' + CUTOFF])
if (!vetoPassed) { return false }
if (score < CUTOFF) { return false }
return true
`;
    const compiledScore = compileStrategy(scoreSrc);
    const nowSec = 1784637810;
    const goodCtx = () => ({
      logearn: { symbol: 'T', platform: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
        swap_begin_time: nowSec - 600, current_mcap: 30000, mcap: 30000, fdv: 30000,
        frequent_volume: 12, new_volume: 40, old_volume: 40, shit_volume: 1,
        buy_tx_count_d1: 300, buyer_count_d1: 200 },
      gmgn: { visiting_count: 1,
        dev: { top_10_holder_rate: 0.21, creator_open_count: 2, creator_token_balance: 0, twitter_name_change_history: [] },
        stat: { top_rat_trader_percentage: 0.03, bot_degen_rate: 0.5, dev_team_hold_rate: 0.05,
                top_bundler_trader_percentage: 0.2, fresh_wallet_rate: 0.1 } },
      kline_and_indicators: { resolution: '1M', avg_price_deviation_pct: 25,
        ao_bars: [{ value: 5 }, { value: 3 }, { value: 2 }, { value: 1 }, { value: 0.5 }, { value: 0.2 }] },
    });
    // v1.2 起 AO/AC 是硬否决（必须过、维持 v1.8.0 原布尔判定），不再是打分因子——
    // "动量缺失"现在直接落进 vetoBlocked，不会走到"分数不足"分支。
    // 三条样本：满分命中(10x) / 动量确认但其余打分不够 43 分未命中(1.2x) / 内鬼超标硬否决(1.1x)
    const cGood = goodCtx();
    // 精心配比：市值/Top10（各权重18）单独补满就能从 43 分越过 60 分线；
    // 老钱包%/新钱包率%/degen率%（各权重7）单独补满仍不够（43+7=50<60）——
    // 用来验证"差此一项"能正确区分"大权重、补了就过"和"小权重、单补不够"两种因子
    const cLowScore = goodCtx();
    cLowScore.logearn.current_mcap = 0; cLowScore.logearn.mcap = 0; cLowScore.logearn.fdv = 0; // 市值 -> 0 分
    cLowScore.gmgn.dev.top_10_holder_rate = 0.05;   // Top10=5%，低于满分核下界 15 -> 0 分
    cLowScore.logearn.old_volume = 0;                // 老钱包% -> 0 分
    cLowScore.gmgn.stat.fresh_wallet_rate = 0;       // 新钱包率% -> 0 分
    cLowScore.gmgn.stat.bot_degen_rate = 0;          // degen率% -> 0 分
    const cVeto = goodCtx();
    cVeto.gmgn.stat.top_rat_trader_percentage = 0.15; // 内鬼 15% >= 10%，硬否决
    const mkR = (id, ctx2, ret) => {
      const row = { id, tokenAddress: 'CA' + id, returnMax: ret, buyTimestamp: nowSec, features: {}, rawCtx: ctx2 };
      return { input: row.tokenAddress, row, res: runStrategyOnRow(compiledScore, row) };
    };
    const results = [mkR(1, cGood, 10), mkR(2, cLowScore, 1.2), mkR(3, cVeto, 1.1)];
    // ---------- parseFactorCheck ----------
    test('parseFactorCheck: 勇者阵营 check 解析出正确的 camp/贡献/核心范围', () => {
      const r = parseFactorCheck({ name: '市值(分)', ok: true, value: '30000 → 18.0分', expect: '满分 8000~60000 权重 18' });
      assert.strictEqual(r.camp, 'hero');
      assert.ok(Math.abs(r.contrib - 18) < 1e-9);
      assert.ok(Math.abs(r.weight - 18) < 1e-9);
      assert.strictEqual(r.coreLo, '8000');
      assert.strictEqual(r.coreHi, '60000');
      assert.strictEqual(r.missing, false);
      assert.strictEqual(r.name, '市值');
    });
    test('parseFactorCheck: 邪恶阵营 check 解析出负贡献与 camp=evil', () => {
      const r = parseFactorCheck({ name: '内鬼%(分)', ok: true, value: '15 → -7.0分', expect: '危险区 10~30 权重 7' });
      assert.strictEqual(r.camp, 'evil');
      assert.ok(Math.abs(r.contrib - (-7)) < 1e-9);
      assert.strictEqual(r.coreLo, '10');
      assert.strictEqual(r.coreHi, '30');
    });
    test('parseFactorCheck: 缺失值应标记 missing=true', () => {
      const r = parseFactorCheck({ name: 'AO强度(分)', ok: false, value: '缺失 → 0.0分', expect: '满分 1~1.3 权重 22' });
      assert.strictEqual(r.missing, true);
    });
    test('parseFactorCheck: 非因子 check（硬否决/总分格式）应返回 null', () => {
      assert.strictEqual(parseFactorCheck({ name: '平台', ok: true, value: 'xxx', expect: '白名单' }), null);
      assert.strictEqual(parseFactorCheck({ name: '总分', ok: true, value: '86.9', expect: '>= 60' }), null);
    });
    // 回归：真实 code-score.js 里手工写的邪恶阵营因子用的是"满分 ... 权重 -10"这种写法——
    // 前缀是"满分"，靠权重本身带负号表达扣分，跟本工具"危险区"前缀的写法不是一回事。
    // 之前权重正则不认负号，这类行会被判定成"不是打分因子"，在 StrategyReplay 的逐样本弹窗里
    // 被错误地当成"硬否决未通过"展示出来（Rizzmr 样本实测踩到：shit_volume(分) 权重 -10）。
    test('parseFactorCheck: "满分"前缀 + 负权重也应识别为邪恶阵营打分因子，不能落回硬否决', () => {
      const r = parseFactorCheck({ name: 'shit_volume(分)', ok: false, value: '0 → 0.0分', expect: '满分 5~100 权重 -10' });
      assert.notStrictEqual(r, null, '不应被判定成硬否决/非因子行');
      assert.strictEqual(r.camp, 'evil');
      assert.ok(Math.abs(r.weight - (-10)) < 1e-9);
      assert.strictEqual(r.name, 'shit_volume');
    });
    const sa = aggregateScoreStats(results, 5);
    test('aggregateScoreStats: 识别打分版策略，未命中拆成 硬否决/分数不足', () => {
      assert.ok(sa, '应识别为打分版');
      assert.strictEqual(sa.cutoff, 60);
      assert.strictEqual(sa.n, 3);
      assert.strictEqual(sa.hits, 1);
      assert.strictEqual(sa.vetoBlocked, 1);
      assert.strictEqual(sa.scoreBlocked, 1);
      assert.strictEqual(sa.factors.length, 10, 'AO/AC 已移出打分，因子只剩 10 个');
      assert.ok(Math.abs(sa.wsum - 100) < 1e-6);
    });
    test('aggregateScoreStats: 差此一项——权重大的因子单独补满能过线，权重小的单独补不够', () => {
      const mcapF = sa.factors.find(f => f.name === '市值');
      const top10F = sa.factors.find(f => f.name === 'Top10持仓%');
      const oldF = sa.factors.find(f => f.name === '老钱包%');
      const freshF = sa.factors.find(f => f.name === '新钱包率%');
      const degenF = sa.factors.find(f => f.name === '机器人degen率%');
      assert.strictEqual(mcapF.lackOne, 1, '43 + 18 = 61 >= 60');
      assert.strictEqual(top10F.lackOne, 1, '43 + 18 = 61 >= 60');
      assert.strictEqual(oldF.lackOne, 0, '43 + 7 = 50 < 60，单独补不够');
      assert.strictEqual(freshF.lackOne, 0);
      assert.strictEqual(degenF.lackOne, 0);
      const dev = sa.factors.find(f => f.name === '偏离%');
      assert.strictEqual(dev.lackOne, 0, '偏离已是满分，补不了');
    });
    test('aggregateScoreStats: 每个因子应带 coreLo/coreHi（从 checks 的期望文本里解析出的核心范围）', () => {
      const mcapF = sa.factors.find(f => f.name === '市值');
      assert.strictEqual(mcapF.coreLo, '8000');
      assert.strictEqual(mcapF.coreHi, '60000');
    });
    test('aggregateScoreStats: 依赖此项——100 分命中盘去掉任何单因子都不掉线', () => {
      for (const f of sa.factors) assert.strictEqual(f.dependOn, 0, f.name);
    });
    test('aggregateScoreStats: 均分验算——分低组均分只统计分低盘，硬否决盘不得混入', () => {
      const mcapF = sa.factors.find(f => f.name === '市值');
      assert.ok(Math.abs(mcapF.avgHit - 18) < 1e-6);
      assert.ok(Math.abs(mcapF.avgMiss - 0) < 1e-6, `veto 盘混入了分低组均分：${mcapF.avgMiss}`);
    });

    // 上面那份策略权重和恰好=100，归一化(total/wsum*100)和原始累加分数值重合，测不出
    // "差此一项/依赖此项按哪种口径算"。下面两个用【权重和≠100 的归一化策略】手工构造 checks，
    // 让两种口径给出不同的 count——旧的"拿归一化 score 裸减原始贡献分"会算错，这里锁住修复。
    // 手工造 check（绕过 compileStrategy，直接喂 aggregateScoreStats 认得的格式）：
    const mkFactor = (name, contrib, weight) => ({
      name: name + '(分)', ok: contrib > 0,
      value: `x → ${contrib.toFixed(1)}分`, expect: `满分 0~1 权重 ${weight}`,
    });
    const mkTotal = (score, cutoff) => ({ name: '总分', ok: score >= cutoff, value: score.toFixed(2), expect: '>= ' + cutoff });
    const mkResult = (checks, passed, ret) => ({ input: 'x', row: { tokenAddress: 'x', symbol: 's', returnMax: ret }, res: { checks, passed } });

    test('aggregateScoreStats: 依赖此项按归一化口径重算——删因子分母跟着缩，命中盘不算"依赖"', () => {
      // pws=80，命中盘：F1/F2/F3 满分(20/17/20)、F4 缺(0)，rawTotal=57，score=57/80*100=71.25 过线。
      // 删 F1：归一化 (57-20)/(80-20)*100=61.67 ≥60 → 不算依赖(0)。
      // 旧的裸减法：71.25-20=51.25 <60 → 会误判成依赖(1)。这里锁 0。
      const checks = [
        mkFactor('F1', 20, 20), mkFactor('F2', 17, 17), mkFactor('F3', 20, 20), mkFactor('F4', 0, 23),
        mkTotal(71.25, 60),
      ];
      const sa2 = aggregateScoreStats([mkResult(checks, true, 3)], 5);
      assert.strictEqual(sa2.factors.find(f => f.name === 'F1').dependOn, 0, 'F1 删掉后 61.67≥60，不该算依赖');
      assert.strictEqual(sa2.factors.find(f => f.name === 'F2').dependOn, 0);
      assert.strictEqual(sa2.factors.find(f => f.name === 'F3').dependOn, 0);
    });

    test('aggregateScoreStats: 差此一项按归一化口径重算——补满分子，不是拿归一化 score 裸加原始权重', () => {
      // pws=60，落选盘：F1 满分(20)、F2/F3 缺(0)，rawTotal=20，score=20/60*100=33.33 未过线。
      // 补满 F2(w16)：归一化 (20+16)/60*100=60 ≥60 → 算差此一项(1)。
      // 旧的裸减法：33.33+16=49.33 <60 → 会漏判(0)。这里锁 1。
      const checks = [
        mkFactor('F1', 20, 20), mkFactor('F2', 0, 16), mkFactor('F3', 0, 24),
        mkTotal(33.33, 60),
      ];
      const sa2 = aggregateScoreStats([mkResult(checks, false, 1)], 5);
      assert.strictEqual(sa2.factors.find(f => f.name === 'F2').lackOne, 1, '补满 F2 后 60≥60，该算差此一项');
      assert.strictEqual(sa2.factors.find(f => f.name === 'F3').lackOne, 1, '补满 F3 后 73.33≥60，该算差此一项');
      assert.strictEqual(sa2.factors.find(f => f.name === 'F1').lackOne, 0, 'F1 已满分，补不动');
    });
    test('aggregateScoreStats: 硬 AND 策略（无总分 check）应返回 null', () => {
      const hardSrc = fs.readFileSync(new URL('../../强势盘策略/code.js', import.meta.url), 'utf8');
      const ch = compileStrategy(hardSrc);
      const r = [mkR(9, goodCtx(), 2)].map(x => ({ ...x, res: runStrategyOnRow(ch, x.row) }));
      assert.strictEqual(aggregateScoreStats(r, 5), null);
    });
  }

  // ---------- backtestFactors 集成 ----------
  test('backtestFactors: 十分位 + 扫描 + 基准一次产出', () => {
    const bt = backtestFactors(planted, [{ field: 'x', weight: 100, lo0: 25, lo1: 30, hi1: 60, hi0: 65 }], T);
    assert.ok(bt.deciles.length > 0);
    assert.ok(bt.sweep.points.length === 51);
    assert.strictEqual(bt.base.n, 300);
    // 打分与种入信号一致：高分段高倍率应显著高于低分段
    const top = bt.deciles[bt.deciles.length - 1], bot = bt.deciles[0];
    assert.ok(top.hiRate > bot.hiRate);
  });

  // ---------- recommendCutoff ----------
  test('recommendCutoff: 在种入的高倍信号区间上应挑出 lift 明显>1 且样本充足的档位', () => {
    const bt = backtestFactors(planted, [{ field: 'x', weight: 100, lo0: 25, lo1: 30, hi1: 60, hi0: 65 }], T);
    const rec = recommendCutoff(bt.sweep);
    assert.ok(rec, '样本充足应给出推荐');
    assert.ok(rec.lift > 1.5, `lift=${rec.lift}`);
    assert.ok(rec.triggered >= 20, `triggered=${rec.triggered}`);
    assert.ok(rec.hitRate > bt.base.baseRate, '推荐档位命中率应高于基准命中率');
  });
  test('recommendCutoff: 净超额命中数最大的档位应被选中，而不是单纯 lift 或 capture 最大的档位', () => {
    const sweep = {
      points: [
        { cut: 0, triggered: 100, hitRate: 0.2, capture: 1, lift: 1.0 },
        { cut: 50, triggered: 40, hitRate: 0.5, capture: 0.5, lift: 2.5 }, // 净超额=40*(0.5-0.2)=12，全场最大
        { cut: 80, triggered: 10, hitRate: 0.9, capture: 0.225, lift: 4.5 }, // lift 最高，但触发数<minN(20)，应被过滤
      ],
      base: { n: 100, baseRate: 0.2 },
    };
    const rec = recommendCutoff(sweep);
    assert.strictEqual(rec.cut, 50, `应选净超额命中数最大且样本充足的档位，实际选了 cut=${rec?.cut}`);
  });
  test('recommendCutoff: 所有档位触发数都不足 minN 时应返回 null', () => {
    const sweep = { points: [{ cut: 0, triggered: 5, hitRate: 0.5, capture: 1, lift: 5 }], base: { n: 10, baseRate: 0.1 } };
    assert.strictEqual(recommendCutoff(sweep), null);
  });
}
