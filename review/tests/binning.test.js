import assert from 'node:assert';
import { buildBins, quantileEdges } from '../src/lib/binning.js';

const R = (b, ret) => ({ features: { f: b }, returnMax: ret });

export function run(test) {
  test('buildBins: 断点应切出 n+1 个箱，边界归属为左闭右开', () => {
    const rows = [R(0, 1), R(5, 1), R(10, 1), R(15, 1)];
    const r = buildBins({ rows, binField: 'f', breakpoints: [5, 10] });
    assert.strictEqual(r.bins.length, 3);
    assert.deepStrictEqual(r.bins.map(b => b.n), [1, 1, 2], '5 应落入第二箱（左闭），10 落入第三箱');
  });

  test('buildBins: 分箱字段或目标字段缺值应跳过并记账', () => {
    // 关键：null 和空串必须和"字段不存在"一样被跳过。
    // Number(null)===0、Number('')===0 都是有限数，只靠 isFinite 会把它们当成 0 塞进最低那一箱。
    const rows = [
      R(1, 2),                                   // 正常
      { features: {}, returnMax: 3 },            // 分箱字段不存在
      { features: { f: 5 }, returnMax: null },   // 目标字段为 null
      { features: { f: null }, returnMax: 4 },   // 分箱字段为 null
      { features: { f: '' }, returnMax: 4 },     // 分箱字段为空串
    ];
    const r = buildBins({ rows, binField: 'f', breakpoints: [] });
    assert.strictEqual(r.skipped, 4, '四条缺值都应被跳过');
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.bins[0].n, 1, '只有正常那条进箱');
    assert.strictEqual(r.bins[0].mean, 2, '均值不应被 0 拉低');
  });

  test('buildBins: 胜率用 Wilson 区间，小样本不能给出越界区间', () => {
    // 3 条全赢：正态近似会给 [1,1] 这种零宽度荒谬区间，Wilson 会给一个合理的下界
    const rows = [R(1, 5), R(1, 6), R(1, 7)];
    const r = buildBins({ rows, binField: 'f', breakpoints: [] });
    const b = r.bins[0];
    assert.strictEqual(b.winRate, 1);
    assert.ok(b.winCI.lo > 0 && b.winCI.lo < 1, `下界应在 (0,1) 内，实际 ${b.winCI.lo}`);
    assert.ok(b.winCI.hi <= 1, '上界不应超过 1');
  });

  test('buildBins: 空箱不应崩溃，统计量为 NaN 而不是 0', () => {
    // 0 和 "没有样本" 完全不同，给 0 会让空箱在图上画成一根真实的零柱
    const rows = [R(100, 2)];
    const r = buildBins({ rows, binField: 'f', breakpoints: [1, 2] });
    assert.strictEqual(r.bins[0].n, 0);
    assert.ok(Number.isNaN(r.bins[0].winRate));
    assert.ok(Number.isNaN(r.bins[0].mean));
  });

  test('buildBins: 中位数在奇偶样本下都正确', () => {
    const odd = buildBins({ rows: [R(1, 1), R(1, 5), R(1, 9)], binField: 'f', breakpoints: [] });
    assert.strictEqual(odd.bins[0].median, 5);
    const even = buildBins({ rows: [R(1, 1), R(1, 3), R(1, 5), R(1, 9)], binField: 'f', breakpoints: [] });
    assert.strictEqual(even.bins[0].median, 4);
  });

  test('quantileEdges: 样本不足应返回空数组而不是切出空箱', () => {
    assert.deepStrictEqual(quantileEdges([1, 2, 3], 4), []);
    const e = quantileEdges(Array.from({ length: 100 }, (_, i) => i), 4);
    assert.strictEqual(e.length, 3, '4 箱应给 3 个边界');
    assert.ok(e[0] < e[1] && e[1] < e[2]);
  });

  test('quantileEdges: 大量重复值时应去重，避免切出空箱', () => {
    const vals = [...Array(50).fill(1), ...Array(50).fill(9)];
    const e = quantileEdges(vals, 4);
    assert.strictEqual(new Set(e).size, e.length, '边界不应重复');
  });
}

export function runReport(test) {
  const R = (b, ret) => ({ features: { f: b }, returnMax: ret });
  test('buildBinBarAiReport: 报告应包含统计能力边界与已知局限，且不依赖任何全局', async () => {
    const assert = (await import('node:assert')).default;
    const { buildBins, buildBinBarAiReport } = await import('../src/lib/binning.js');
    let s = 3; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const rows = Array.from({ length: 200 }, () => { const g = rnd();
      return R(g * 100, g > 0.5 ? 2 + rnd() * 8 : 0.3 + rnd() * 1.6); });
    const r = buildBins({ rows, binField: 'f', breakpoints: [25, 50, 75] });
    const md = buildBinBarAiReport({
      binField: 'f', valueField: 'returnMax', breakpoints: [25, 50, 75], primary: 'winRate',
      bins: r.bins.map(b => ({ label: b.label, lo: b.lo, hi: b.hi, n: b.n,
        winRate: b.winRate, median: b.median, mean: b.mean, std: b.std, ci: b.ci95 })),
      bestIdx: 3,
    }, rows, null);
    assert.ok(md && md.length > 500, '应生成完整报告');
    // 这两节是报告的价值所在——不能让 AI 对达不到检出门槛的差异做过度解读
    assert.ok(/统计能力边界/.test(md), '必须包含统计能力边界');
    assert.ok(/已知局限/.test(md), '必须包含已知局限');
    assert.ok(/重尾|右偏/.test(md), '重尾分布时应提示均值不可靠');
    assert.strictEqual(buildBinBarAiReport(null, rows), null, '没有分箱结果时应返回 null 而不是崩溃');
  });
}
