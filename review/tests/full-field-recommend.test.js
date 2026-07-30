import assert from 'node:assert';
import { scanIntervalsLite, recommendFromAllFields,
         compareRecommendPlans, DEFAULT_PLANS } from '../src/lib/fullFieldRecommend.js';
import { recommendFactorPath } from '../src/lib/factorLab.js';

// 造一批"字段值 → returnMax"关系明确的样本。features 里放若干字段，只有 good 跟收益真相关。
function mkRows(n = 200) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ret = ((i * 37) % 100) / 10;          // 0~9.9，与下标顺序去相关
    rows.push({
      tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret,
      features: {
        good: ret,                               // 完美信号
        noise: ((i * 53) % 100) / 10,            // 纯噪声
        halfMissing: i % 2 === 0 ? ret : null,   // 一半缺失，但没缺失的那半是真信号
        mostlyMissing: i % 20 === 0 ? ret : null, // 95% 缺失
      },
    });
  }
  return rows;
}

// 后向剔除用：strong 是真信号；stale 只在【训练段】跟收益一致、验证段是噪声——
// 贪心（在 train 上推边界）容易先被它骗进来，等 strong 进池后它就该被删掉。
function mkRedundantRows(n = 240) {
  const rows = [];
  const splitAt = Math.round(n * 0.7);
  for (let i = 0; i < n; i++) {
    const ret = ((i * 37) % 100) / 10;
    rows.push({
      tokenAddress: 'R' + i, swapBeginTime: 2000 + i, returnMax: ret,
      features: {
        strong: ret,
        stale: i < splitAt ? ret : ((i * 71) % 100) / 10,
        dupA: ret + (i % 3) * 0.01,
        noise1: ((i * 53) % 100) / 10,
        noise2: ((i * 91) % 100) / 10,
      },
    });
  }
  return rows;
}

const FIELDS = ['good', 'noise', 'halfMissing', 'mostlyMissing'];

export function run(test) {
  // ---------- 方案A：全字段轻量扫描 ----------
  test('scanIntervalsLite: 每个可用字段两个阵营各挖一份候选，带 camp/interval/missRate', () => {
    const r = scanIntervalsLite(mkRows(), ['good', 'noise'], { winThreshold: 5 });
    assert.strictEqual(r.scannedCount, 2);
    const good = r.candidates.filter(c => c.field === 'good');
    assert.ok(good.length >= 1, 'good 至少挖出一个阵营的区间');
    assert.ok(good.every(c => c.interval && !c.interval.error));
    assert.ok(good.every(c => c.camp === 'hero' || c.camp === 'evil'));
    assert.ok(good.every(c => Number.isFinite(c.missRate)));
    assert.ok(good.every(c => c.liteScan === true), 'liteScan 标记要带上，UI 才知道显著性没检验过');
  });

  test('scanIntervalsLite: 目标变量及其变换不参与扫描（不能自己预测自己）', () => {
    const r = scanIntervalsLite(mkRows(), ['good', 'returnMax', 'currentMcap'], { winThreshold: 5 });
    assert.strictEqual(r.scannedCount, 1, 'returnMax/currentMcap 应被 AUC_TARGET_FIELDS 挡掉');
    assert.ok(!r.candidates.some(c => c.field === 'returnMax'));
  });

  test('scanIntervalsLite: maxMissRate 过滤高缺失字段，并记进 skipped', () => {
    const r = scanIntervalsLite(mkRows(), FIELDS, { winThreshold: 5, maxMissRate: 0.1 });
    assert.ok(!r.candidates.some(c => c.field === 'mostlyMissing'), '95% 缺失的不该进候选');
    assert.ok(r.skipped.some(s => s.field === 'mostlyMissing' && /缺失率/.test(s.reason)));
    assert.ok(r.candidates.some(c => c.field === 'good'), '低缺失的真信号仍要留下');
  });

  // ---------- 按阵营吃 exclusions（fields 收 { hero, evil } 形态） ----------
  // 回归的是这个事故：exclusions 曾经被全字段扫描整个绕过，被人工「移除」过的字段全部复活，
  // 贪心第一步就捡回了一个事后字段（post_buy_max_drawdown_pct）。
  test('scanIntervalsLite: fields 传 { hero, evil } 时，各阵营只挖自己名单里的字段', () => {
    const r = scanIntervalsLite(mkRows(), { hero: ['good'], evil: ['noise'] }, { winThreshold: 5 });
    assert.ok(!r.candidates.some(c => c.field === 'good' && c.camp === 'evil'),
      'good 不在邪恶名单里，不该挖出邪恶候选');
    assert.ok(!r.candidates.some(c => c.field === 'noise' && c.camp === 'hero'),
      'noise 不在勇者名单里，不该挖出勇者候选');
    assert.strictEqual(r.scannedCount, 2, 'scannedCount 按两份名单的并集算');
  });

  test('scanIntervalsLite: 某字段两个阵营都被移除时，它压根不进扫描名单', () => {
    const r = scanIntervalsLite(mkRows(), { hero: ['good'], evil: ['good'] }, { winThreshold: 5 });
    assert.ok(!r.candidates.some(c => c.field === 'noise'));
    assert.ok(!r.skipped.some(s => s.field === 'noise'), '被移除的字段不该出现在 skipped——它没被扫，不是扫了没结果');
    assert.strictEqual(r.scannedCount, 1);
  });

  test('scanIntervalsLite: 传数组仍是老口径（两个阵营共用同一份名单）', () => {
    const arr = scanIntervalsLite(mkRows(), ['good', 'noise'], { winThreshold: 5 });
    const obj = scanIntervalsLite(mkRows(), { hero: ['good', 'noise'], evil: ['good', 'noise'] }, { winThreshold: 5 });
    assert.strictEqual(arr.scannedCount, obj.scannedCount);
    assert.strictEqual(arr.candidates.length, obj.candidates.length);
  });

  test('recommendFromAllFields: 被移除的字段进不了推荐路径（哪怕它是最强信号）', () => {
    const withGood = recommendFromAllFields(mkRows(), FIELDS,
      { threshold: 5, missingPolicy: 'zero', maxMissRate: 0.6 });
    assert.ok(withGood.path.some(p => p.field === 'good'), '前提：不移除时 good 会被选中');
    const banned = FIELDS.filter(f => f !== 'good');
    const r = recommendFromAllFields(mkRows(), { hero: banned, evil: banned },
      { threshold: 5, missingPolicy: 'zero', maxMissRate: 0.6 });
    assert.ok(!r.path.some(p => p.field === 'good'), 'good 两阵营都被移除，不该出现在路径里');
  });

  test('scanIntervalsLite: permB=0 —— 区间置换检验没做，pPermutation 是占位的 1 而不是真检验结果', () => {
    const r = scanIntervalsLite(mkRows(), ['good'], { winThreshold: 5 });
    assert.ok(r.candidates.every(c => c.interval.pPermutation === 1));
    assert.ok(r.candidates.every(c => c.interval.pAdj === undefined), '没跑 BH，不该有 pAdj');
  });

  test('recommendFromAllFields: 只给裸字段名（不预先扫描）也能推出真信号，并回带 scanStats', () => {
    const r = recommendFromAllFields(mkRows(), FIELDS, { threshold: 5, missingPolicy: 'zero', maxMissRate: 0.6 });
    assert.ok(r.path.length >= 1, '至少推一个');
    assert.ok(r.path.some(p => p.field === 'good'), '真信号应被选中');
    assert.ok(!r.path.some(p => p.field === 'mostlyMissing'), '95% 缺失的被 maxMissRate 挡在外面');
    assert.strictEqual(r.scanStats.scannedCount, 4);
    assert.ok(r.scanStats.candidateCount > 0);
    assert.strictEqual(r.scanStats.candidateCount, r.scanStats.heroCount + r.scanStats.evilCount);
  });

  test('recommendFromAllFields: 一个字段都挖不出区间时给 error，不抛异常', () => {
    const rows = mkRows(30).map(r => ({ ...r, features: { flat: 1 } }));
    const r = recommendFromAllFields(rows, ['flat'], { threshold: 5 });
    assert.strictEqual(r.path.length, 0);
    assert.ok(r.error);
    assert.ok(r.scanStats);
  });

  // ---------- 等价性回归：三个开关默认关时，行为跟加它们之前一致 ----------
  test('搜索增强默认关闭：不传 beamWidth/backward/monotoneGate 时路径与显式全关逐项一致', () => {
    const rows = mkRedundantRows();
    const cands = ['strong', 'stale', 'dupA', 'noise1', 'noise2'].map(f => ({
      field: f, camp: 'hero', interval: { lo: 5, hi: Infinity, score: 1 },
    }));
    const a = recommendFactorPath(rows, [], cands, { threshold: 5, missingPolicy: 'zero' });
    const b = recommendFactorPath(rows, [], cands, { threshold: 5, missingPolicy: 'zero',
      beamWidth: 1, backward: false, monotoneGate: false });
    assert.deepStrictEqual(a.path.map(p => p.camp + ':' + p.field), b.path.map(p => p.camp + ':' + p.field));
    assert.deepStrictEqual(a.path.map(p => p.deltaTest), b.path.map(p => p.deltaTest));
    assert.strictEqual(a.baseTestRho, b.baseTestRho);
  });

  // ---------- 方案D：后向剔除 ----------
  test('backward: 开启后路径不会更长、held-out ρ 不会更差', () => {
    const rows = mkRedundantRows();
    const cands = ['stale', 'strong', 'dupA', 'noise1', 'noise2'].map(f => ({
      field: f, camp: 'hero', interval: { lo: 5, hi: Infinity, score: 1 },
    }));
    const off = recommendFactorPath(rows, [], cands, { threshold: 5, missingPolicy: 'zero' });
    const on = recommendFactorPath(rows, [], cands, { threshold: 5, missingPolicy: 'zero', backward: true });
    assert.ok(on.path.length <= off.path.length, '后向剔除只会删不会加');
    assert.ok(!Number.isFinite(off.baseTestRho) || on.baseTestRho >= off.baseTestRho - 1e-9,
      '删因子的条件是 ρ 不降，最终 ρ 不该比不开时差');
    const keys = on.path.map(p => p.camp + ':' + p.field);
    assert.strictEqual(new Set(keys).size, keys.length, '路径里不该有重复字段');
  });

  test('backward: 剔除后 path 与实际留下的因子一致（被删的不留在 path 里）', () => {
    const rows = mkRedundantRows();
    const cands = ['stale', 'strong', 'dupA', 'noise1', 'noise2'].map(f => ({
      field: f, camp: 'hero', interval: { lo: 5, hi: Infinity, score: 1 },
    }));
    const on = recommendFactorPath(rows, [], cands, { threshold: 5, missingPolicy: 'zero', backward: true });
    // path 每项都必须还能在候选里找到（没有被删掉却仍留在 path 里的幽灵项）
    const pool = new Set(cands.map(c => c.camp + ':' + c.field));
    assert.ok(on.path.every(p => pool.has(p.camp + ':' + p.field)));
  });

  // ---------- 方案C：Beam search ----------
  test('beamWidth=1 与默认行为完全一致（beam 化不能改动默认入口的结果）', () => {
    const rows = mkRedundantRows();
    const cands = ['strong', 'stale', 'dupA', 'noise1', 'noise2'].map(f => ({
      field: f, camp: 'hero', interval: { lo: 5, hi: Infinity, score: 1 },
    }));
    const one = recommendFactorPath(rows, [], cands, { threshold: 5, missingPolicy: 'zero', beamWidth: 1 });
    const def = recommendFactorPath(rows, [], cands, { threshold: 5, missingPolicy: 'zero' });
    assert.deepStrictEqual(one.path.map(p => p.field), def.path.map(p => p.field));
  });

  // 这条抓到过一个真 bug（2026-07-29 首版 beam 实现）：每步 `beams = nextBeams` 时，一条
  // "这一步没有任何合法扩展"的 beam 会被直接丢掉——而它可能正是全局最优解，于是 beam=4 反而
  // 比 beam=1 差（实测 ρ 0.846 vs 0.941）。修法是跨步维护历史最优 bestBeam。
  // beam search 的这条基本性质（加宽搜索不该让结果变差）必须一直守着。
  test('beamWidth>1: 最终 held-out ρ 不劣于单路径贪心', () => {
    const rows = mkRedundantRows();
    const cands = ['strong', 'stale', 'dupA', 'noise1', 'noise2'].map(f => ({
      field: f, camp: 'hero', interval: { lo: 5, hi: Infinity, score: 1 },
    }));
    const one = recommendFactorPath(rows, [], cands, { threshold: 5, missingPolicy: 'zero', beamWidth: 1 });
    const many = recommendFactorPath(rows, [], cands, { threshold: 5, missingPolicy: 'zero', beamWidth: 4 });
    assert.ok(many.path.length >= 1, 'beam 版也要能推出因子');
    assert.ok(many.baseTestRho >= one.baseTestRho - 1e-9,
      `beam=4 的最终 ρ(${many.baseTestRho}) 不该低于 beam=1(${one.baseTestRho})`);
    const keys = many.path.map(p => p.camp + ':' + p.field);
    assert.strictEqual(new Set(keys).size, keys.length, '同一条 beam 内不该重复选同一个字段');
  });

  // ---------- 方案B：单调性闸门 ----------
  test('monotoneGate: 开启后最终路径的 held-out 倒挂数不比关闭时多', () => {
    const rows = mkRedundantRows();
    const cands = ['strong', 'stale', 'dupA', 'noise1', 'noise2'].map(f => ({
      field: f, camp: 'hero', interval: { lo: 5, hi: Infinity, score: 1 },
    }));
    const off = recommendFactorPath(rows, [], cands, { threshold: 5, missingPolicy: 'zero' });
    const on = recommendFactorPath(rows, [], cands, { threshold: 5, missingPolicy: 'zero', monotoneGate: true });
    const lastZig = r => (r.path.length ? r.path[r.path.length - 1].testZigzag?.inversionCount ?? 0 : 0);
    if (on.path.length && off.path.length) {
      assert.ok(lastZig(on) <= lastZig(off) || on.path.length <= off.path.length,
        '闸门要么压住倒挂、要么早停，不该两样都更差');
    }
    assert.ok(on.path.every(p => p.testZigzag), '每步都要带分档诊断');
  });

  test('monotoneGate: 全被拦下时走专属 stopReason/文案，不跟"没候选能提升ρ"混为一谈', () => {
    const rows = mkRedundantRows();
    const cands = ['strong', 'stale', 'dupA'].map(f => ({
      field: f, camp: 'hero', interval: { lo: 5, hi: Infinity, score: 1 },
    }));
    // gateTopK=0：一个候选都不检查 → 必然全被拦下，专门验这条分支的返回形状
    const r = recommendFactorPath(rows, [], cands, { threshold: 5, missingPolicy: 'zero',
      monotoneGate: true, gateTopK: 0 });
    assert.strictEqual(r.path.length, 0);
    assert.strictEqual(r.stopReason, 'monotoneGate');
  });

  // ---------- 方案擂台 ----------
  test('compareRecommendPlans: 每个方案一行，ranked 按 k* 处 K折 ρ 降序、rank 从 1 连续', () => {
    const rows = mkRedundantRows();
    const cands = ['strong', 'stale', 'dupA'].map(f => ({
      field: f, camp: 'hero', interval: { lo: 5, hi: Infinity, score: 1 },
    }));
    const r = compareRecommendPlans(rows, {
      fields: ['strong', 'stale', 'dupA', 'noise1', 'noise2'], candidates: cands,
      threshold: 5, missingPolicy: 'zero',
    });
    assert.strictEqual(r.rows.length, DEFAULT_PLANS.length, '每个方案都要有一行');
    assert.strictEqual(r.ranked.length, r.rows.length);
    assert.deepStrictEqual(r.ranked.map(x => x.rank), r.ranked.map((_, i) => i + 1));
    const keyOf = x => (Number.isFinite(x.kStarRho) ? x.kStarRho
      : Number.isFinite(x.rhoTest) ? x.rhoTest : -Infinity);
    for (let i = 1; i < r.ranked.length; i++) {
      assert.ok(keyOf(r.ranked[i - 1]) >= keyOf(r.ranked[i]), '排名必须按主键降序');
    }
    assert.strictEqual(r.best, r.ranked[0]);
  });

  test('compareRecommendPlans: 全字段扫描只做一次，所有 full 方案共用同一份 scanStats', () => {
    const rows = mkRedundantRows();
    const r = compareRecommendPlans(rows, {
      fields: ['strong', 'stale', 'dupA'], candidates: [],
      threshold: 5, missingPolicy: 'zero',
    });
    const fulls = r.rows.filter(x => x.pool === 'full' && x.scanStats);
    assert.ok(fulls.length >= 2, '至少两个 full 方案');
    // 同一个对象引用 = 只扫了一次（换成深比较就看不出"扫了两次但结果一样"）
    assert.ok(fulls.every(x => x.scanStats === fulls[0].scanStats));
  });

  test('compareRecommendPlans: 单个方案报错不该带崩整张表，其余方案照常出结果', () => {
    const rows = mkRedundantRows();
    // candidates 为空 → 所有 pool:'scan' 的方案必然报错；pool:'full' 的照常
    const r = compareRecommendPlans(rows, {
      fields: ['strong', 'noise1'], candidates: [], threshold: 5, missingPolicy: 'zero',
    });
    assert.strictEqual(r.rows.length, DEFAULT_PLANS.length);
    assert.ok(r.rows.some(x => x.pool === 'scan' && x.error), 'scan 方案应带 error');
    assert.ok(r.rows.some(x => x.pool === 'full' && !x.error), 'full 方案不受影响');
  });

  test('compareRecommendPlans: 每行带可直接采用的因子对象（截断到 k* 的那份）', () => {
    const rows = mkRedundantRows();
    const r = compareRecommendPlans(rows, {
      fields: ['strong', 'stale', 'dupA', 'noise1'], candidates: [],
      threshold: 5, missingPolicy: 'zero',
    });
    const ok = r.rows.filter(x => !x.error && x.factorCount > 0);
    assert.ok(ok.length >= 1);
    for (const row of ok) {
      assert.ok(Array.isArray(row.factors) && row.factors.length, '采用按钮要有东西可采');
      assert.ok(row.factors.every(f => f.field && f.camp && Number.isFinite(f.weight)),
        '必须是配好权重的完整因子对象，不是 spec');
      if (row.kStar != null) assert.ok(row.factors.length <= row.factorCount);
    }
  });

  test('compareRecommendPlans: onPlanDone 逐方案回调，进度是 done/total 而不是乱序', () => {
    const rows = mkRedundantRows();
    const seen = [];
    compareRecommendPlans(rows, {
      fields: ['strong'], candidates: [], threshold: 5, missingPolicy: 'zero',
      onPlanDone: (row, done, total) => seen.push({ key: row.key, done, total }),
    });
    assert.strictEqual(seen.length, DEFAULT_PLANS.length);
    assert.deepStrictEqual(seen.map(s => s.done), seen.map((_, i) => i + 1));
    assert.ok(seen.every(s => s.total === DEFAULT_PLANS.length));
    assert.deepStrictEqual(seen.map(s => s.key), DEFAULT_PLANS.map(p => p.key));
  });

  test('搜索配置回带给调用方（报告里要能看出这条路径是怎么搜出来的）', () => {
    const rows = mkRedundantRows();
    const cands = [{ field: 'strong', camp: 'hero', interval: { lo: 5, hi: Infinity, score: 1 } }];
    const r = recommendFactorPath(rows, [], cands, { threshold: 5, missingPolicy: 'zero',
      beamWidth: 3, backward: true, monotoneGate: true });
    assert.strictEqual(r.beamWidth, 3);
    assert.strictEqual(r.backward, true);
    assert.strictEqual(r.monotoneGate, true);
  });
}
