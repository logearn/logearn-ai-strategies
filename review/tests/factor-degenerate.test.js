// 分数结构的两种病理：① 常数因子（梯形退化成"人人同分"）；② 同分并列压住北极星。
// 共性是【都在静默地限制 ρ，但在任何一张表上都看不出来】，所以都需要专门算一个数出来。
//
// 常数因子（梯形退化成"人人同分"）检测与闸门
// 起因见 readme 第 31 节：用户 >3x 那轮的因子池里 `shit_volume` 邪恶推出 lo1=0/hi1=∞，
// 而 shit_volume 是恒 ≥0 的持仓占比字段 —— 724/728 个样本命中度全是 1.00，每个样本一律
// 扣同样的 8.1 分，对 spearman(score, returnMax) 一分不动，却占着 8.1% 的权重分母。
// 报告里它跟正常因子长得一模一样（有 AUC、有区间、有权重），没有任何一处能看出来。
import assert from 'node:assert';
import {
  factorHitProfile, findDegenerateFactors, buildFactors, scoreRows, scorePoolRho, trapScore,
  heroWeightSum, estimateTieRhoCost, DEGENERATE_HIT_SHARE, NEAR_DEGENERATE_HIT_SHARE,
} from '../src/lib/factorLab.js';

export function run(test) {
  // ---------- 构造：一个恒 ≥0 的占比字段（复刻 shit_volume 的真实形状） ----------
  // 关键是 **绝大多数样本取值为 0**（大部分币压根没有垃圾钱包持仓），这才是退化梯形的成因：
  // deriveTrapezoidCore 拿"区间内目标类取值的 P25"当满分核起点 lo1，目标类有 75% 都压在 0 上
  // → lo1=0；区间又是 [0, ∞) 这种单边开区间 → hi1=hi0=∞。于是任何 ≥0 的取值都满命中。
  // 光靠"字段恒 ≥0"是推不出退化梯形的（P25 会落在一个正数上，梯形照样有区分度）——
  // 必须是"零值堆积 + 单边开区间"这个组合，这也是为什么它在真实数据上才现形。
  // 同时给一个真正有区分度的字段 good 做对照。
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push({
      id: 'r' + i,
      tokenAddress: 't' + i,
      swapBeginTime: 1000 + i,
      returnMax: i % 5 === 0 ? 8 : 1.2,          // 40 个高倍盘
      features: {
        ratio: i % 7 === 0 ? (i % 5) * 0.4 : 0,  // ~86% 是 0，其余小正数
        good: i % 5 === 0 ? 90 + (i % 7) : 10 + (i % 7),
      },
    });
  }
  // shit_volume 那份退化梯形：下界开在 0，上界开到 ∞ —— 任何 ≥0 的取值都满命中
  const constFactor = { field: 'ratio', camp: 'evil', weight: 10, lo0: -0.35, lo1: 0, hi1: Infinity, hi0: Infinity };
  const realFactor = { field: 'good', camp: 'hero', weight: 10, lo0: 40, lo1: 80, hi1: Infinity, hi0: Infinity };

  test('factorHitProfile: 恒 ≥0 的字段配上 lo1=0/hi1=∞ 的梯形 → 命中度人人 1.00', () => {
    const p = factorHitProfile(rows, constFactor);
    assert.strictEqual(p.n, 200);
    assert.strictEqual(p.distinct, 1, '所有样本应落在同一个命中度桶里');
    assert.strictEqual(p.modalHit, 1);
    assert.strictEqual(p.modalShare, 1);
  });

  test('factorHitProfile: 有区分度的因子 modalShare 明显小于 1', () => {
    const p = factorHitProfile(rows, realFactor);
    assert.ok(p.distinct > 1, '应该有多个不同的命中度');
    assert.ok(p.modalShare < NEAR_DEGENERATE_HIT_SHARE,
      `有区分度的因子不该被判为近似常数，实得 modalShare=${p.modalShare}`);
  });

  test('factorHitProfile: 缺失样本记 0 分不会掩盖退化——众数判据仍然测得出来', () => {
    // 方差判据在这里会失效：196 个 1.00 + 4 个 0.00 的方差不是 0
    const withMissing = rows.map((r, i) => (i < 4 ? { ...r, features: { ...r.features, ratio: null } } : r));
    const p = factorHitProfile(withMissing, constFactor);
    assert.strictEqual(p.distinct, 2, '应有 1.00 和 0.00 两个桶');
    assert.strictEqual(p.modalShare, 196 / 200);
    assert.ok(p.modalShare >= NEAR_DEGENERATE_HIT_SHARE, '98% 同分应触发软线提醒');
    assert.ok(p.modalShare < DEGENERATE_HIT_SHARE, '98% 未达硬闸（99%），不该被自动丢弃');
  });

  // ---------- 常数因子对排序确实零贡献（这是整件事的前提） ----------
  test('常数因子对 spearman(score, returnMax) 的贡献严格为 0', () => {
    const rhoAlone = scorePoolRho(rows, [realFactor], 'zero');
    const rhoWithConst = scorePoolRho(rows, [realFactor, constFactor], 'zero');
    assert.ok(Number.isFinite(rhoAlone) && Number.isFinite(rhoWithConst));
    assert.strictEqual(rhoWithConst, rhoAlone, '加一个常数因子，秩相关应一分不动');
  });

  // 分母改成「Σ勇者权重」后（见 readme 第 33 节），常数因子伤害分两种，都仍然是"白占位置"：
  //   · 邪恶常数因子 → 不进分母，纯粹把所有样本的分数【整体下移】一个常数；
  //   · 勇者常数因子 → 进分母、贡献又是常数，才是真正的【稀释】。
  // 两种都不改变秩序，但都会让 cutoff 的含义漂移，所以闸门照拦不误。
  test('邪恶常数因子把分数整体下移（不进分母，纯平移）', () => {
    const alone = scoreRows(rows, [realFactor], { missingPolicy: 'zero' });
    const withConst = scoreRows(rows, [realFactor, constFactor], { missingPolicy: 'zero' });
    const iTop = alone.findIndex(s => s.score === 100);
    assert.ok(iTop >= 0, '应有满命中样本');
    // 分母仍是勇者的 10，分子多了 -10 → (10-10)/10*100 = 0
    assert.strictEqual(withConst[iTop].score, 0);
    // 平移量对每个样本都一样 = -100（常数因子权重/勇者权重和 × 100）
    const shifts = new Set(alone.map((s, i) => Math.round((withConst[i].score - s.score) * 1e6)));
    assert.strictEqual(shifts.size, 1, '邪恶常数因子对每个样本的影响应完全相同');
    assert.strictEqual([...shifts][0] / 1e6, -100);
  });

  test('勇者常数因子会稀释其它因子的有效权重（它进分母、贡献却是常数）', () => {
    const heroConst = { ...constFactor, camp: 'hero' };
    const alone = scoreRows(rows, [realFactor], { missingPolicy: 'zero' });
    const withConst = scoreRows(rows, [realFactor, heroConst], { missingPolicy: 'zero' });
    const iTop = alone.findIndex(s => s.score === 100);
    // 分母 10→20、分子 10+10=20 → 满命中仍是 100，但没满命中的样本被拉向 50（常数因子那一半白送）
    const iLow = alone.findIndex(s => s.score === 0);
    assert.ok(iLow >= 0, '应有完全不命中的样本');
    assert.strictEqual(withConst[iLow].score, 50, '不命中样本被常数因子白送了一半分数');
    assert.strictEqual(withConst[iTop].score, 100);
  });

  test('两种常数因子都不改变秩序（ρ 一分不动）', () => {
    const base = scorePoolRho(rows, [realFactor], 'zero');
    assert.strictEqual(scorePoolRho(rows, [realFactor, constFactor], 'zero'), base);
    assert.strictEqual(scorePoolRho(rows, [realFactor, { ...constFactor, camp: 'hero' }], 'zero'), base);
  });

  // ---------- 归一化分母必须跟策略模板逐位一致（readme 第 32/33 节） ----------
  // 这是这次口径变更的验收：原本 review 用 Σ全部权重、策略模板用 Σ正权重（邪恶权重写成负数后
  // 被 Math.max(0,·) 夹成 0），两边差一个正的常数倍——排序一致但 cutoff 绝对值不通用，
  // 而「发送到策略」同步 CUTOFF 是原样搬的。既有测试一条都没覆盖到这个尺度，所以补在这里。
  test('scoreRow 的分数与策略模板公式逐位相等（混合阵营池）', () => {
    const pool = [
      { field: 'good', camp: 'hero', weight: 29.7, lo0: 40, lo1: 80, hi1: Infinity, hi0: Infinity },
      { field: 'ratio', camp: 'evil', weight: 70.5, lo0: -0.35, lo1: 0, hi1: Infinity, hi0: Infinity },
    ];
    // 策略模板：`total += s * weight; wsum += Math.max(0, weight)`，邪恶阵营 weight 写成负数
    const templateScore = (row) => {
      let total = 0, wsum = 0;
      for (const f of pool) {
        const w = f.camp === 'evil' ? -Math.abs(f.weight) : Math.abs(f.weight);
        const raw = row.features[f.field];
        const s = trapScore(raw == null ? NaN : Number(raw), f.lo0, f.lo1, f.hi1, f.hi0);
        total += s * w; wsum += Math.max(0, w);
      }
      return wsum > 0 ? total / wsum * 100 : 0;
    };
    const scored = scoreRows(rows, pool, { missingPolicy: 'zero' });
    for (let i = 0; i < rows.length; i++) {
      assert.strictEqual(scored[i].score, templateScore(rows[i]),
        `第 ${i} 行两边分数应逐位相等，实得 review=${scored[i].score} / 模板=${templateScore(rows[i])}`);
    }
    // 邪恶权重占七成时，分数能跌破 -100——cutoff 输入框/阈值扫描的下界不能再硬编码 -100
    assert.ok(scored.some(s => s.score < -100), '邪恶权重占比高时分数应能跌破 -100');
  });

  test('纯勇者池的分数跟口径变更前完全一致（仍落在 0~100）', () => {
    const scored = scoreRows(rows, [realFactor], { missingPolicy: 'zero' });
    assert.ok(scored.every(s => s.score >= 0 && s.score <= 100));
    assert.ok(scored.some(s => s.score === 100) && scored.some(s => s.score === 0));
  });

  test('纯邪恶池：Σ勇者权重=0 → 原样复刻策略侧返回 0，不自作主张换分母兜底', () => {
    const evilOnly = [{ field: 'good', camp: 'evil', weight: 50, lo0: 40, lo1: 80, hi1: Infinity, hi0: Infinity }];
    assert.strictEqual(heroWeightSum(evilOnly), 0);
    const scored = scoreRows(rows, evilOnly, { missingPolicy: 'zero' });
    assert.ok(scored.every(s => s.score === 0), '满分上限为 0 时归一无定义，跟策略模板一样给 0');
    // 分数全同 → 秩全部打平 → ρ=0（不是 NaN，spearman 对常数序列给 0）。数值上"没信息"是对的，
    // 但它跟"因子真的没用"长得一样，光看 ρ 分辨不出来，所以 UI 必须单独告警。
    assert.strictEqual(scorePoolRho(rows, evilOnly, 'zero'), 0);
  });

  test('heroWeightSum: 只累加勇者权重，空池/脏权重不炸', () => {
    assert.strictEqual(heroWeightSum([realFactor, constFactor]), 10);
    assert.strictEqual(heroWeightSum([]), 0);
    assert.strictEqual(heroWeightSum(null), 0);
    assert.strictEqual(heroWeightSum([{ camp: 'hero', weight: undefined }, { camp: 'hero', weight: 5 }]), 5);
  });

  // ---------- buildFactors 的硬闸 ----------
  const candConst = {
    field: 'ratio', camp: 'evil',
    interval: { lo: 0, hi: Infinity, score: 1.2, base: 0.2, n: 200, pos: 40, winRate: 0.2 },
  };
  const candReal = {
    field: 'good', camp: 'hero',
    interval: { lo: 80, hi: Infinity, score: 1.5, base: 0.2, n: 40, pos: 36, winRate: 0.9 },
  };

  test('buildFactors: 退化成常数的因子被拦下，理由进 skipped', () => {
    const { factors, skipped } = buildFactors(rows, [candConst], [{ field: 'ratio', camp: 'evil' }], 3);
    assert.strictEqual(factors.length, 0, '常数因子不该进池');
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0].field, 'ratio');
    assert.strictEqual(skipped[0].camp, 'evil');
    assert.ok(/梯形退化成常数/.test(skipped[0].reason), `理由应说明是退化，实得：${skipped[0].reason}`);
  });

  test('buildFactors: 有区分度的因子照常通过闸门', () => {
    const { factors, skipped } = buildFactors(rows, [candReal], [{ field: 'good', camp: 'hero' }], 3);
    assert.strictEqual(factors.length, 1);
    assert.strictEqual(skipped.length, 0);
  });

  test('buildFactors: 混合池——只丢常数那个，其余原样保留且权重重新归一到 100', () => {
    const { factors } = buildFactors(rows, [candConst, candReal],
      [{ field: 'ratio', camp: 'evil' }, { field: 'good', camp: 'hero' }], 3);
    assert.deepStrictEqual(factors.map(f => f.field), ['good']);
    assert.strictEqual(factors[0].weight, 100, '只剩一个因子时应独占 100 权重');
  });

  test('buildFactors: degenerateGate:false 可关闸门（排查用），关掉后常数因子照进', () => {
    const { factors, skipped } = buildFactors(rows, [candConst], [{ field: 'ratio', camp: 'evil' }], 3,
      { degenerateGate: false });
    assert.strictEqual(factors.length, 1, '显式关闸后应放行');
    assert.strictEqual(skipped.length, 0);
  });

  test('buildFactors: 闸门阈值可调——degenerateShare 收到 0.5 时连弱因子也会被拦', () => {
    const { factors } = buildFactors(rows, [candReal], [{ field: 'good', camp: 'hero' }], 3,
      { degenerateShare: 0.5 });
    assert.strictEqual(factors.length, 0, 'good 的 modalShare=0.8 > 0.5，收紧阈值后应被拦');
  });

  // ---------- 已在池子里的因子体检（UI 常驻提醒） ----------
  test('findDegenerateFactors: 挑出池中的常数因子，放过正常因子', () => {
    const found = findDegenerateFactors(rows, [realFactor, constFactor]);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].factor.field, 'ratio');
    assert.strictEqual(found[0].degenerate, true, 'modalShare=1.0 应标记为确定零贡献');
  });

  test('findDegenerateFactors: 90%~99% 的只提醒、不标 degenerate（该不该删由人判断）', () => {
    // 195/200 满命中、5 个缺失 → modalShare=0.975，落在软线与硬闸之间
    const nearRows = rows.map((r, i) => (i < 5 ? { ...r, features: { ...r.features, ratio: null } } : r));
    const found = findDegenerateFactors(nearRows, [constFactor]);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].degenerate, false);
    assert.ok(found[0].modalShare >= NEAR_DEGENERATE_HIT_SHARE && found[0].modalShare < DEGENERATE_HIT_SHARE);
  });

  test('findDegenerateFactors: 空 rows / 空因子池不报错，返回空数组', () => {
    assert.deepStrictEqual(findDegenerateFactors([], [constFactor]), []);
    assert.deepStrictEqual(findDegenerateFactors(rows, []), []);
    assert.deepStrictEqual(findDegenerateFactors(null, null), []);
  });

  test('findDegenerateFactors: 按 modalShare 降序，最没用的排最前', () => {
    const nearFactor = { field: 'good', camp: 'hero', weight: 5, lo0: -Infinity, lo1: -Infinity, hi1: 1e9, hi0: 1e9 };
    const found = findDegenerateFactors(rows, [nearFactor, constFactor], 0.5);
    assert.ok(found.length >= 2);
    for (let i = 1; i < found.length; i++) {
      assert.ok(found[i - 1].modalShare >= found[i].modalShare, '应按 modalShare 降序');
    }
  });

  // ---------- 同分并列对北极星的代价【估计】（readme 第 35 节） ----------
  // 报告原来对同分饱和的措辞是"直接压住 ρ 的上限"，触发线 10%。实测发现这在弱信号下
  // 夸大了一个数量级：代价 = f(块大小, 信号强度)，ρ≈0.19 时 36% 的块只值 +0.004，
  // 而 10%（那条触发线本身）的代价是 0.000。
  //
  // 第一版实现是错的，被测试当场抓住：拿"主键score、次键returnMax 排序后重算 ρ"当上界，
  // 等于把答案注入进去——弱信号给出 +0.118、强信号只给 +0.026，跟机制完全相反。
  // 真实代价取决于被打平抹掉的那部分信息，**从观测数据里算不出来**，只能建模估计。
  // 下面这几条守着模型的两个单调性 + 边界，那是这个估计唯一该被信任的部分。

  test('estimateTieRhoCost: 复现分析时报出的量级（n=728，ρ≈0.19）', () => {
    const at = tieRatio => estimateTieRhoCost({ n: 728, tieRatio, rho: 0.190 }).estCost;
    assert.ok(at(0.10) < 0.002, `10% 的代价应几乎为 0，实得 ${at(0.10).toFixed(4)}`);
    assert.ok(at(0.36) < 0.010, `36% 的代价应在千分之几量级，实得 ${at(0.36).toFixed(4)}`);
    assert.ok(at(0.76) > 0.03, `76% 的代价才该明显，实得 ${at(0.76).toFixed(4)}`);
  });

  test('estimateTieRhoCost: 代价随【信号强度】单调上升（弱信号打平损失更小）', () => {
    const costs = [0.19, 0.36, 0.68, 0.90].map(
      rho => estimateTieRhoCost({ n: 728, tieRatio: 0.36, rho }).estCost);
    for (let i = 1; i < costs.length; i++) {
      assert.ok(costs[i] >= costs[i - 1] - 1e-9,
        `强度变大代价不该反而变小：${costs.map(c => c.toFixed(4)).join(' → ')}`);
    }
    assert.ok(costs[costs.length - 1] > costs[0] * 3,
      `强信号的代价应远大于弱信号：${costs[0].toFixed(4)} → ${costs[costs.length - 1].toFixed(4)}`);
  });

  test('estimateTieRhoCost: 代价随【块大小】单调上升', () => {
    const costs = [0.1, 0.3, 0.55, 0.76].map(
      tieRatio => estimateTieRhoCost({ n: 728, tieRatio, rho: 0.19 }).estCost);
    for (let i = 1; i < costs.length; i++) {
      assert.ok(costs[i] >= costs[i - 1] - 1e-9,
        `块变大代价不该反而变小：${costs.map(c => c.toFixed(4)).join(' → ')}`);
    }
  });

  test('estimateTieRhoCost: 代价恒非负，且 rhoUntiedEst = |ρ| + 代价', () => {
    for (const [tieRatio, rho] of [[0.2, 0.1], [0.5, 0.4], [0.36, -0.25], [0.7, 0.8]]) {
      const r = estimateTieRhoCost({ n: 400, tieRatio, rho });
      assert.ok(r.estCost >= 0, `tieRatio=${tieRatio} rho=${rho} 代价不该为负`);
      assert.ok(Math.abs(r.rhoUntiedEst - (Math.abs(rho) + r.estCost)) < 1e-12);
    }
  });

  test('estimateTieRhoCost: 确定性——同一份输入反复调用结果完全一致', () => {
    const a = estimateTieRhoCost({ n: 728, tieRatio: 0.36, rho: 0.19 });
    const b = estimateTieRhoCost({ n: 728, tieRatio: 0.36, rho: 0.19 });
    assert.deepStrictEqual(a, b, '固定种子，结果必须可复现');
  });

  test('estimateTieRhoCost: 边界——无并列/样本太少/脏输入', () => {
    const noTie = estimateTieRhoCost({ n: 728, tieRatio: 0, rho: 0.19 });
    assert.strictEqual(noTie.estCost, 0, '没有并列就没有代价');
    assert.strictEqual(noTie.tieN, 0);
    assert.strictEqual(estimateTieRhoCost({ n: 5, tieRatio: 0.3, rho: 0.2 }), null, 'n<20 不给估计');
    assert.strictEqual(estimateTieRhoCost({ n: 728, tieRatio: NaN, rho: 0.2 }), null);
    assert.strictEqual(estimateTieRhoCost({ n: 728, tieRatio: 0.3, rho: NaN }), null);
    // 显式传 null 曾经在参数默认值解构上抛 TypeError
    assert.doesNotThrow(() => estimateTieRhoCost(null));
    assert.strictEqual(estimateTieRhoCost(null), null);
    assert.strictEqual(estimateTieRhoCost(), null);
  });
}
