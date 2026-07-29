import assert from 'node:assert';
import { aucForField, collectAucSamples, finalizeAucScan } from '../src/lib/auc.js';

const mk = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

export function run(test) {
  test('aucForField: bootstrap 已播固定种子 → 同一批数据重复扫，AUC 置信区间/显著性完全可复现', () => {
    // 造一批有区分度、又不是完美可分的样本，让 bootstrap CI 落在有意义的区间（能体现"每次一致"）
    const rows = mk(120, i => ({ features: { a: (i % 7) + (i > 60 ? 3 : 0) }, returnMax: i > 60 ? 6 : 1 }));
    const r1 = aucForField(rows, 'a', { bootstrapB: 200 });
    const r2 = aucForField(rows, 'a', { bootstrapB: 200 });
    assert.deepStrictEqual({ auc: r2.auc, ci: r2.ci, significant: r2.significant },
      { auc: r1.auc, ci: r1.ci, significant: r1.significant }, 'AUC/CI/显著性两次调用应完全一致');
  });

  test('collectAucSamples: null/空串不能被 Number() 转成 0 混进样本', () => {
    const rows = [
      { features: { a: 5 }, returnMax: 3 },
      { features: { a: null }, returnMax: 3 },
      { features: { a: '' }, returnMax: 3 },
      { features: {}, returnMax: 3 },
    ];
    const { values } = collectAucSamples(rows, 'a');
    assert.deepStrictEqual(values, [5], '只有真实有值的那条应进样本');
  });

  test('aucForField: 完美可分应给出 AUC=1', () => {
    const rows = mk(40, i => ({ features: { a: i }, returnMax: i < 20 ? 1 : 5 }));
    const r = aucForField(rows, 'a', { bootstrapB: 100 });
    assert.ok(Math.abs(r.auc - 1) < 1e-9, `实际 ${r.auc}`);
    assert.strictEqual(r.direction, 'high');
  });

  test('aucForField: 反向可分应识别为 low 方向且 AUC 仍 >0.5', () => {
    // 值越小越容易赢 —— 方向是 low，但 AUC 作为"区分能力"应报成 >0.5 而不是 <0.5
    const rows = mk(40, i => ({ features: { a: i }, returnMax: i < 20 ? 5 : 1 }));
    const r = aucForField(rows, 'a', { bootstrapB: 100 });
    assert.strictEqual(r.direction, 'low');
    assert.ok(r.auc > 0.9, `实际 ${r.auc}`);
  });

  test('aucForField: 点估计必须落在自己的置信区间内', () => {
    // 旧版点估计走下采样的 computeROC、CI 走精确 rankAuc，出现过点估计跑到 CI 外面
    for (const seed of [1, 2, 3]) {
      let s = seed;
      const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
      const rows = mk(120, () => ({ features: { a: rnd() }, returnMax: rnd() > 0.6 ? 5 : 1 }));
      const r = aucForField(rows, 'a', { bootstrapB: 200 });
      assert.ok(r.auc >= r.ci.lo - 1e-9 && r.auc <= r.ci.hi + 1e-9,
        `seed=${seed} 点估计 ${r.auc} 不在 CI [${r.ci.lo}, ${r.ci.hi}] 内`);
    }
  });

  test('aucForField: 样本全同类时 AUC 无定义，不能返回 0.5 冒充"无区分度"', () => {
    const rows = mk(30, i => ({ features: { a: i }, returnMax: 5 }));  // 全赢
    const r = aucForField(rows, 'a');
    assert.ok(Number.isNaN(r.auc));
    assert.ok(/无定义/.test(r.reason));
  });

  test('aucForField: 有效样本太少应给出原因而不是硬算', () => {
    const rows = mk(5, i => ({ features: { a: i }, returnMax: i > 2 ? 5 : 1 }));
    const r = aucForField(rows, 'a');
    assert.ok(Number.isNaN(r.auc));
    assert.ok(/仅 5 条/.test(r.reason));
  });

  // 2026-07-29：scanFieldsAuc（批量扫描的便捷包装，只服务已删除的"AUC 批量检测"面板）已删——
  // 它内部就是"逐字段 aucForField + finalizeAucScan"，这两步仍是候选扫描（assembleCampScan，
  // factorlab.test.js 覆盖）的核心，下面两条测试直接对着 finalizeAucScan 走，不因为面板删了
  // 就丢失这层回归覆盖；目标变量排除（AUC_TARGET_FIELDS）在候选扫描入口单独测过
  // （tests/factorlab.test.js），不用在这里重复。
  test('finalizeAucScan: 纯噪声字段批量扫描后不应有 BH 校正显著的', () => {
    let s = 99;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const rows = mk(150, () => {
      const f = {};
      for (let k = 0; k < 12; k++) f['n' + k] = rnd();
      return { features: f, returnMax: rnd() > 0.6 ? 5 : 1 };
    });
    const fields = Array.from({ length: 12 }, (_, k) => 'n' + k);
    const { usable } = finalizeAucScan(fields.map(f => aucForField(rows, f, { bootstrapB: 150 })));
    assert.strictEqual(usable.length, 12);
    const sig = usable.filter(r => r.significantAdj);
    assert.strictEqual(sig.length, 0, `纯噪声不该有校正后显著的，实际 ${sig.map(r => r.field)}`);
  });

  test('finalizeAucScan: 结果应按区分度（|AUC-0.5|）降序', () => {
    const rows = mk(80, i => ({ features: { good: i, noise: (i * 37) % 11 }, returnMax: i < 40 ? 1 : 5 }));
    const { usable } = finalizeAucScan(['noise', 'good'].map(f => aucForField(rows, f, { bootstrapB: 100 })));
    assert.strictEqual(usable[0].field, 'good', '强字段应排前面');
  });
}
