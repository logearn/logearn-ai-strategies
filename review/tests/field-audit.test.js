// ========== 字段质量审核单元测试 ==========
// 覆盖两件事：
//   1. 与目标的机械耦合（returnMax = max_mcap / initial_mcap，分母就是进场市值）
//   2. 边际ρ 的置换零分布——"多大的增量才算超出噪声"的经验标尺，
//      关键性质是【纯噪声数据上，真实候选的 Δρ 不该明显超出零分布】。
// 时点标记与缺失非随机检查已按需求移除（看字段名/缺失率人肉判断即可），见 fieldAudit.js 头部注释。
import assert from 'node:assert';
import { auditMcapCoupling, fieldMcapRho } from '../src/lib/fieldAudit.js';
import {
  permutationNullMarginalRho, permutationPValue, summarizeNullDistribution,
  computeFieldRaw, assembleCampScan, computeHeldOutDeltaRho, findHotInterval, buildFactors,
} from '../src/lib/factorLab.js';

// 固定种子 LCG，跟 factorlab.test.js 同一套：区间挖掘/置换断言都依赖确定性样本
function makeRand(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

export function run(test) {
  const T = 5; // 高倍阈值

  // ---------- 1. 与目标的机械耦合（进场市值） ----------
  // 注意这里【不测观察期偏差】：returnMax 的统计截止时刻在 calls JSON 里根本没有，
  // row.exportTimestamp 取的是信号时刻，基于它的检测对 100% 样本无条件触发——
  // summary.js 里同思路的警告已经因为这个原因被删过一次，别再加回来。
  test('auditMcapCoupling: 小盘更容易翻倍时 ρ(进场市值, returnMax) 应显著为负', () => {
    const rand = makeRand(11);
    const rows = Array.from({ length: 200 }, (_, i) => {
      const mcap = 10000 + i * 500;
      return { initialMcap: mcap, returnMax: 1 + 100000 / mcap + rand() * 0.2, features: {} };
    });
    const a = auditMcapCoupling(rows);
    assert.strictEqual(a.n, 200);
    assert.ok(a.rhoMcapReturn < -0.8, `小盘涨更多时 ρ 应接近 -1，实际 ${a.rhoMcapReturn}`);
    assert.ok(a.p10Mcap <= a.medianMcap && a.medianMcap <= a.p90Mcap, '分位数必须单调');
  });

  test('auditMcapCoupling: 市值与收益无关时 ρ 接近 0', () => {
    const rand = makeRand(23);
    const rows = Array.from({ length: 200 }, (_, i) => ({
      initialMcap: 10000 + i * 500, returnMax: 1 + rand() * 10, features: {},
    }));
    assert.ok(Math.abs(auditMcapCoupling(rows).rhoMcapReturn) < 0.2);
  });

  test('auditMcapCoupling: 没有可用进场市值时给 error 而不是抛异常', () => {
    const a = auditMcapCoupling([{ returnMax: 3, features: {} }]);
    assert.ok(a.error);
  });

  test('fieldMcapRho: 字段本身就是市值的代理时 |ρ| 接近 1', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      initialMcap: (i + 1) * 1000, returnMax: 2,
      features: { supply_like: (i + 1) * 7, noise: (i * 37) % 11 },
    }));
    assert.ok(fieldMcapRho(rows, 'supply_like') > 0.99, '与市值同构的字段 ρ 应接近 1');
    assert.ok(Math.abs(fieldMcapRho(rows, 'noise')) < 0.5, '无关字段 ρ 应远离 1');
    assert.ok(Number.isNaN(fieldMcapRho(rows, 'nope')), '字段不存在时应判无效');
  });

  test('computeFieldRaw: 扫描结果带上与进场市值的 ρ，并原样传到候选对象上', () => {
    const rand = makeRand(7);
    const rows = Array.from({ length: 160 }, (_, i) => {
      const x = rand() * 100;
      return {
        initialMcap: (i + 1) * 1000,
        returnMax: x > 60 ? T + 1 + rand() : 1 + rand(),
        features: { x, supply_like: (i + 1) * 7 },
      };
    });
    const raw = computeFieldRaw(rows, 'x', { winThreshold: T, bootstrapB: 30 });
    assert.ok(Number.isFinite(raw.mcapRho), '扫描应顺带算出与进场市值的相关');
    assert.ok(Number.isFinite(raw.missRate), '缺失率仍然要有（只是不再算缺失偏差）');
    const { candidates } = assembleCampScan([raw, computeFieldRaw(rows, 'supply_like', { winThreshold: T, bootstrapB: 30 })], 'hero');
    const byField = Object.fromEntries(candidates.map(c => [c.field, c]));
    assert.ok(byField.supply_like.mcapRho > 0.99, 'supply_like 就是进场市值的代理，候选表该看得见');
  });

  // ---------- 2. 边际ρ 的置换零分布 ----------
  test('permutationNullMarginalRho: 打乱 returnMax 后的 Δρ 分布应以 0 为中心且量级很小', () => {
    const rand = makeRand(31);
    const rows = Array.from({ length: 220 }, () => {
      const x = rand() * 100, y = rand() * 100;
      return { initialMcap: 30000, returnMax: x > 70 ? T + 2 : 1 + rand() * 2, features: { x, y } };
    });
    const cands = ['x', 'y'].map(field => ({ field, camp: 'hero', interval: findHotInterval(rows, field, { winThreshold: T }) }))
      .filter(c => c.interval && !c.interval.error);
    assert.ok(cands.length, '先得挖得出区间，否则这个用例什么也没测');

    const dist = permutationNullMarginalRho(rows, [], cands, T, { permutations: 6 });
    assert.ok(!dist.error, dist.error);
    assert.ok(dist.n >= 10, `零分布样本数不足：${dist.n}`);
    assert.ok(Math.abs(dist.q50) < 0.12, `噪声 Δρ 的中位数应接近 0，实际 ${dist.q50}`);
    assert.ok(dist.q95 <= dist.q99 && dist.q99 <= dist.max, '分位数必须单调');

    // 关键性质：真实标签下 x 的边际ρ 必须明显跑赢这条噪声标尺，否则这把尺子没有区分力。
    // 观测值和零分布量的必须是同一个统计量（都是 held-out 的 deltaTest）——2026-07-29 统一口径
    // 之前，零分布用的是样本内 Δρ，拿它去卡 held-out 观测值等于换了把尺子。
    const real = computeHeldOutDeltaRho(rows, [], cands.find(c => c.field === 'x'), 'hero', T, {});
    assert.ok(real.deltaTest > dist.q95, `种入信号的字段应超出零分布 q95（Δρtest=${real.deltaTest}，q95=${dist.q95}）`);
    assert.ok(permutationPValue(dist, real.deltaTest) < 0.1, '经验 p 值应该小');
  });

  test('permutationNullMarginalRho: 置换用固定种子，同样输入两次结果一致', () => {
    const rand = makeRand(41);
    const rows = Array.from({ length: 150 }, () => {
      const x = rand() * 100;
      return { initialMcap: 30000, returnMax: x > 60 ? T + 1 : 1.5, features: { x } };
    });
    const iv = findHotInterval(rows, 'x', { winThreshold: T });
    const cands = [{ field: 'x', camp: 'hero', interval: iv }];
    const a = permutationNullMarginalRho(rows, [], cands, T, { permutations: 5 });
    const b = permutationNullMarginalRho(rows, [], cands, T, { permutations: 5 });
    assert.deepStrictEqual(a.deltas, b.deltas, '同一份数据反复跑必须可复现');
  });

  test('permutationNullMarginalRho: 不打乱原始 rows（只在副本上换 returnMax）', () => {
    const rand = makeRand(53);
    const rows = Array.from({ length: 120 }, () => {
      const x = rand() * 100;
      return { initialMcap: 30000, returnMax: x > 60 ? T + 1 : 1.5, features: { x } };
    });
    const before = rows.map(r => r.returnMax);
    permutationNullMarginalRho(rows, [], [{ field: 'x', camp: 'hero', interval: findHotInterval(rows, 'x', { winThreshold: T }) }], T, { permutations: 3 });
    assert.deepStrictEqual(rows.map(r => r.returnMax), before, '置换必须作用在副本上，不能污染调用方的 rows');
  });

  test('permutationNullMarginalRho: 候选为空/样本太少时给 error 而不是抛异常', () => {
    assert.ok(permutationNullMarginalRho([], [], [], 5).error);
    assert.ok(permutationNullMarginalRho([{ returnMax: 2, features: {} }], [], [{ field: 'x', camp: 'hero' }], 5).error);
  });

  test('summarizeNullDistribution: 样本不足时报错但仍把碎片 deltas 带回（供分片合并）', () => {
    const r = summarizeNullDistribution([0.1, 0.2, 0.3], { permutations: 1 });
    assert.ok(r.error);
    assert.deepStrictEqual(r.deltas, [0.1, 0.2, 0.3]);
    assert.strictEqual(r.permutations, 1);
  });

  test('permutationPValue: 观测值越大 p 越小，且永远 >0（+1 修正）', () => {
    const dist = { deltas: Array.from({ length: 100 }, (_, i) => i / 1000) };  // 0 ~ 0.099
    assert.ok(permutationPValue(dist, 0.5) > 0, '跑有限次置换最多只能说 p < 1/(N+1)，不能给 0');
    assert.ok(permutationPValue(dist, 0.5) < 0.02);
    assert.ok(permutationPValue(dist, 0.05) > 0.4, '落在分布中间应给出不显著的 p');
    assert.ok(Number.isNaN(permutationPValue(null, 0.1)));
  });
}
