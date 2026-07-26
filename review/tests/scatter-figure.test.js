// buildScatterFigure 的回归测试。旧版这段逻辑埋在 renderScatterChart 的 301 行里、
// 和 Plotly 调用揉在一起，一行都测不了——本次会话的点击失效、边际分布布局问题都出在这块。
import assert from 'node:assert';
import { buildScatterFigure, collectPoints } from '../src/lib/scatterFigure.js';

const mkRows = (n, f = i => ({ a: i, b: i * 2 })) =>
  Array.from({ length: n }, (_, i) => ({
    id: 'id' + i, symbol: 'S' + i, tokenAddress: 'CA' + i,
    returnMax: 1 + i * 0.1, features: f(i),
  }));

export function run(test) {
  test('collectPoints: 缺值/非数值应被剔除，且要分别记账高亮命中的丢失原因', () => {
    const rows = [
      { tokenAddress: 'ca1', features: { a: 1, b: 2 } },
      { tokenAddress: 'ca2', features: { a: null, b: 2 } },     // 缺值
      { tokenAddress: 'ca3', features: { a: -5, b: 2 } },       // 对数轴排除
    ];
    const hl = new Set(['ca2', 'ca3']);
    const r = collectPoints({ rows, xField: 'a', yField: 'b', logX: true, highlightCAs: hl });
    assert.strictEqual(r.points.length, 1);
    assert.strictEqual(r.dropped.missing, 1, 'ca2 应记为缺值');
    assert.strictEqual(r.dropped.nonPositive, 1, 'ca3 应记为对数轴排除');
  });

  test('趋势线必须带 hoverinfo:skip，否则会抢走样本点的点击', () => {
    // 趋势线只有 2 个点，但 Plotly 按"到线段的距离"判定最近点，会覆盖整条横轴。
    // 它没有 customdata，抢到点击后处理器静默返回——表现就是"点了没反应"。
    const fig = buildScatterFigure({ rows: mkRows(20), xField: 'a', yField: 'b' });
    const trend = fig.traces.find(t => t.name === '趋势线');
    assert.ok(trend, '应有趋势线');
    assert.strictEqual(trend.hoverinfo, 'skip');
    for (const t of fig.traces.filter(t => t.type === 'histogram')) {
      assert.strictEqual(t.hoverinfo, 'skip', '边际直方图同样不能参与点击判定');
    }
  });

  test('样本点 trace 必须带 customdata，否则点击无法打开 logearn', () => {
    const fig = buildScatterFigure({ rows: mkRows(10), xField: 'a', yField: 'b' });
    const pts = fig.traces.find(t => t.mode === 'markers');
    assert.ok(Array.isArray(pts.customdata) && pts.customdata[0] === 'CA0');
  });

  test('边际分布：只画左侧 Y 直方图，且与主图 domain 相接不留缝', () => {
    const fig = buildScatterFigure({ rows: mkRows(30), xField: 'a', yField: 'b', settings: { showMarginal: true } });
    const hists = fig.traces.filter(t => t.type === 'histogram');
    assert.strictEqual(hists.length, 1, '只应有一个直方图（Y 的）');
    assert.ok(hists[0].y && !hists[0].x, '应是 Y 方向的直方图');
    assert.deepStrictEqual(fig.layout.xaxis2.domain, [0, 0.15]);
    assert.deepStrictEqual(fig.layout.xaxis.domain, [0.15, 1], '必须相接，留缝会读成两张图');
    assert.strictEqual(fig.layout.yaxis.anchor, 'x2', 'Y 轴刻度要画在直方图外侧');
  });

  test('关闭边际分布时不应残留 domain / xaxis2', () => {
    const fig = buildScatterFigure({ rows: mkRows(30), xField: 'a', yField: 'b', settings: { showMarginal: false } });
    assert.strictEqual(fig.traces.filter(t => t.type === 'histogram').length, 0);
    assert.strictEqual(fig.layout.xaxis2, undefined);
    assert.strictEqual(fig.layout.xaxis.domain, undefined);
  });

  test('分类颜色应按类别拆成多条 trace，图例才能显示颜色', () => {
    const rows = mkRows(9, i => ({ a: i, b: i, g: ['x', 'y', 'z'][i % 3] }));
    const fig = buildScatterFigure({ rows, xField: 'a', yField: 'b', colorField: 'g', numericColor: false });
    const names = fig.traces.filter(t => t.mode === 'markers').map(t => t.name).sort();
    assert.deepStrictEqual(names, ['x', 'y', 'z']);
  });

  test('数值颜色应走 colorscale 单 trace 并显示 colorbar', () => {
    const rows = mkRows(9, i => ({ a: i, b: i, c: i * 3 }));
    const fig = buildScatterFigure({ rows, xField: 'a', yField: 'b', colorField: 'c', numericColor: true });
    const pts = fig.traces.filter(t => t.mode === 'markers');
    assert.strictEqual(pts.length, 1);
    assert.strictEqual(pts[0].marker.showscale, true);
  });

  test('剔除离群点应收紧坐标轴、把被隐藏的点报出来、且不再参与 r/p/趋势线计算', () => {
    const rows = mkRows(30, i => ({ a: i === 29 ? 100000 : i, b: i }));
    const fig = buildScatterFigure({ rows, xField: 'a', yField: 'b', settings: { clipOutliers: true } });
    assert.ok(Array.isArray(fig.layout.xaxis.range), '应设置轴范围');
    assert.ok(fig.outlierRows.length >= 1, '应识别出离群点');
    // 离群点（第 29 条，a=100000）被剔除后，参与统计的样本数应少于总数——
    // "剔除"如果只改坐标轴显示、不改统计口径，这里 stats.n 会还是 30，等于白剔除。
    assert.ok(fig.stats.n < 30, '离群点不应再计入 r/p 的样本数');
    assert.strictEqual(fig.stats.n, 30 - fig.outlierRows.length, 'stats.n 应正好是总数减去离群点数');
    assert.ok(fig.notices.some(t => /离群点/.test(t) && /不参与/.test(t)), '说明文字要讲清楚离群点不参与统计了');
  });
  test('剔除离群点应让离群点也退出相关系数计算，r 值应因此变化', () => {
    // 构造一个"主体样本几乎不相关，但离群点硬把 r 拉高"的场景：a=0..28 时 b 是随机噪声量级，
    // 第 29 条塞一个 a、b 都巨大的点，线性相关系数会被这一个点主导。
    const rows = mkRows(30, i => (i === 29 ? { a: 100000, b: 100000 } : { a: i, b: (i % 2) * 3 - 1 }));
    const withOutlier = buildScatterFigure({ rows, xField: 'a', yField: 'b', settings: { clipOutliers: false } });
    const withoutOutlier = buildScatterFigure({ rows, xField: 'a', yField: 'b', settings: { clipOutliers: true } });
    assert.notStrictEqual(withOutlier.stats.r.toFixed(3), withoutOutlier.stats.r.toFixed(3),
      '剔除离群点前后 r 值应该不一样，否则说明离群点根本没被排除出统计');
  });
  test('对数坐标下，r/p/趋势线应该在对数空间里算，不是在原始线性空间硬套对数轴', () => {
    // 构造一个严格的幂律关系 y = 2 * x^3——线性空间里 (x,y) 相关性一般，
    // 但取 log 之后 log(y) = log(2) + 3*log(x) 是完美的线性关系，r 应该接近 1。
    const rows = Array.from({ length: 20 }, (_, i) => {
      const x = i + 1;
      return { id: 'id' + i, symbol: 'S' + i, tokenAddress: 'CA' + i, features: { a: x, b: 2 * x ** 3 } };
    });
    const linear = buildScatterFigure({ rows, xField: 'a', yField: 'b', settings: { logX: false, logY: false } });
    const logged = buildScatterFigure({ rows, xField: 'a', yField: 'b', settings: { logX: true, logY: true } });
    assert.ok(logged.stats.r > linear.stats.r + 0.01,
      `对数空间的 r（${logged.stats.r.toFixed(4)}）应明显高于线性空间的 r（${linear.stats.r.toFixed(4)}），` +
      '因为这组数据只有取对数之后才是完美线性关系');
    assert.ok(logged.stats.r > 0.99, '幂律关系取对数后应接近完美线性相关');
  });

  test('图例位置要避开 X 轴标题', () => {
    const fig = buildScatterFigure({ rows: mkRows(10), xField: 'a', yField: 'b' });
    assert.ok(fig.layout.legend.y < 0, '图例应下移到绘图区之外');
    assert.ok(fig.layout.margin.b >= 80, '下边距要留够');
  });

  test('浅色主题应改变背景与文字色', () => {
    const d = buildScatterFigure({ rows: mkRows(5), xField: 'a', yField: 'b', light: false });
    const l = buildScatterFigure({ rows: mkRows(5), xField: 'a', yField: 'b', light: true });
    assert.notStrictEqual(d.layout.paper_bgcolor, l.layout.paper_bgcolor);
  });

  test('样本不足时不应崩溃', () => {
    for (const n of [0, 1, 2]) {
      const fig = buildScatterFigure({ rows: mkRows(n), xField: 'a', yField: 'b' });
      assert.ok(fig.traces.length >= 1, `n=${n} 应能出图`);
      assert.strictEqual(fig.stats.n, n);
    }
  });
}
