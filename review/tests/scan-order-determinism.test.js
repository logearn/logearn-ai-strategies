// 扫描结果的【顺序无关性】回归（readme 第 38 节）
//
// 起因：用户报"每次刷新跑出来的推荐结果都不一样"。算法层全是固定种子（scanIntervalCore /
// assignFoldsByToken / bootstrapAucCI / estimateTieRhoCost），坐标上升本身确定性——不确定性
// 来自【输入顺序】：
//
//   scanCandidatesWithWorkers 把字段切批派进共享 worker 池，谁空谁取下一批，
//   原实现按【完成顺序】push 进 rawList（完成顺序取决于各批耗时和 OS 调度，每次刷新都不同）
//     → finalizeAucScan 的 usable.sort 只按 |AUC−0.5|，Array#sort 稳定 → 打平时保留输入顺序
//     → candidates 顺序
//     → recommendFactorPath 的 pool.sort 只按 interval.score → 打平时保留 candidates 顺序
//     → 贪心 cands.sort 只按 testRho → 打平时保留 pool 顺序
//     → 选中哪个候选
//
// 真实数据里精确打平很常见：同一个量的两个路径别名（chip_analysis.inner_sell_ratio /
// inner_address_holding 的 AUC 和边际ρ 逐位相同）建出来的因子打分完全一样，testRho 必然打平。
//
// 既有的「并行扫描等价性」测试（factorlab.test.js）喂的是按字段顺序的 rawList，
// **从没测过乱序**，所以一直没抓到。这个文件专门补这一层。
import assert from 'node:assert';
import { computeFieldRaw, assembleCampScan, recommendFactorPath, recommendFactorPool } from '../src/lib/factorLab.js';
import { finalizeAucScan } from '../src/lib/auc.js';

export function run(test) {
  // 造一批字段，其中三对是【完全相关的别名】——AUC / interval.score / testRho 必然逐位打平
  const N = 400, rows = [];
  let a = 12345;
  const rnd = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  for (let i = 0; i < N; i++) {
    const s1 = rnd(), s2 = rnd(), s3 = rnd(), noise = rnd();
    rows.push({ id: 'r' + i, tokenAddress: 't' + i, swapBeginTime: 1000 + i,
      returnMax: (0.3 * s1 + 0.25 * s2 + 0.2 * s3 + 0.25 * noise) * 10,
      features: { f1: s1, f1_alias: s1, f2: s2, f2_alias: s2, f3: s3, f3_alias: s3,
        n1: noise, n2: rnd(), n3: rnd() } });
  }
  const fields = ['f1', 'f1_alias', 'f2', 'f2_alias', 'f3', 'f3_alias', 'n1', 'n2', 'n3'];
  const opts = { winThreshold: 5, bootstrapB: 40, minCoverage: 0.3, camp: 'hero' };
  const raw = fields.map(f => computeFieldRaw(rows, f, opts));

  const orders = {
    '输入顺序': raw.map((_, i) => i),
    '倒序': raw.map((_, i) => i).reverse(),
    '随机打乱': (() => {
      const idx = raw.map((_, i) => i);
      let b = 999;
      const r2 = () => { b |= 0; b = b + 0x6D2B79F5 | 0; let t = Math.imul(b ^ b >>> 15, 1 | b);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r2() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      return idx;
    })(),
  };
  const scanIn = order => assembleCampScan(order.map(i => raw[i]), 'hero');

  test('前提：这批 fixture 里确实存在精确打平的候选（否则这组测试测不到东西）', () => {
    const { candidates } = scanIn(orders['输入顺序']);
    const keys = candidates.map(c => `${c.auc.toFixed(12)}|${(c.interval?.score ?? 0).toFixed(12)}`);
    assert.ok(new Set(keys).size < keys.length,
      '别名字段应产生逐位相同的 auc + interval.score；没有打平就说明 fixture 失效了');
  });

  test('finalizeAucScan: usable 的顺序不随输入顺序变（字段名兜底 tie-break）', () => {
    const nameOf = order => finalizeAucScan(order.map(i => raw[i]).map(r => r.auc)).usable.map(r => r.field);
    const base = nameOf(orders['输入顺序']);
    for (const [label, ord] of Object.entries(orders)) {
      assert.deepStrictEqual(nameOf(ord), base, `${label} 下 usable 排序应与输入顺序一致`);
    }
  });

  test('assembleCampScan: candidates 的字段顺序不随 rawList 顺序变', () => {
    const base = scanIn(orders['输入顺序']).candidates.map(c => c.field);
    for (const [label, ord] of Object.entries(orders)) {
      assert.deepStrictEqual(scanIn(ord).candidates.map(c => c.field), base, `${label} 下候选顺序应一致`);
    }
  });

  // 这条是用户实际看到的症状：刷新一次，推荐出来的字段就换了一批
  test('recommendFactorPath: 推荐路径不随扫描顺序变（用户报的那个现象）', () => {
    const pathOf = ord => recommendFactorPath(rows, [], scanIn(ord).candidates,
      { threshold: 5, maxSteps: 4, minGain: 0.001 }).path.map(p => p.camp + ':' + p.field);
    const base = pathOf(orders['输入顺序']);
    assert.ok(base.length >= 3, '前提：应能选出多步路径');
    for (const [label, ord] of Object.entries(orders)) {
      assert.deepStrictEqual(pathOf(ord), base, `${label} 下推荐路径应完全一致，实得 ${pathOf(ord).join(' → ')}`);
    }
  });

  test('recommendFactorPool: 完整四段流水线的产物（路径+权重+k*）也不随顺序变', () => {
    const runOf = ord => {
      const r = recommendFactorPool(rows, scanIn(ord).candidates, { threshold: 5, maxSteps: 4, minGain: 0.001 });
      return {
        path: r.path.map(p => p.camp + ':' + p.field),
        weights: (r.factors || []).map(f => `${f.camp}:${f.field}=${f.weight}`),
        k: r.recommendedCount, rhoAfter: r.rhoAfter,
      };
    };
    const base = runOf(orders['输入顺序']);
    for (const [label, ord] of Object.entries(orders)) {
      assert.deepStrictEqual(runOf(ord), base, `${label} 下整条流水线的产物应完全一致`);
    }
  });

  // beam / 后向剔除 / 单调性闸门这三条增强各自都会读排序结果（闸门只看前 gateTopK 个），
  // 顺序不稳时它们受影响更大，单独锁一遍
  test('三个搜索增强开启时同样顺序无关（beam3 + 后向 + 闸门）', () => {
    const pathOf = ord => recommendFactorPath(rows, [], scanIn(ord).candidates,
      { threshold: 5, maxSteps: 4, minGain: 0.001, beamWidth: 3, backward: true, monotoneGate: true })
      .path.map(p => p.camp + ':' + p.field);
    const base = pathOf(orders['输入顺序']);
    for (const [label, ord] of Object.entries(orders)) {
      assert.deepStrictEqual(pathOf(ord), base, `${label} 下 beam 路径应一致`);
    }
  });
}
