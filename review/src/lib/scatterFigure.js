// 散点图的【图形构建】——纯函数：给定数据和设置，返回 Plotly 需要的 traces / layout，
// 不碰 DOM、不调 Plotly。这是从 js/charts.js 的 renderScatterChart（301 行）里剥出来的部分：
// 原函数把"算什么"和"怎么画"揉在一起，导致 300 行里没有一行是可测的。
//
// 逻辑口径与旧版逐条对齐（包括那些用真实数据换来的细节，见各处注释），
// 差别只在于：全局状态 activeRows / highlightCAs 改成入参。
import { pearson, pearsonPValue, linearRegression, computeClipRange } from './utils.js';
import { getFeature } from './data.js';

// 图表配色。注意逻辑层不该 import UI 库，所以这里保留一份与 AntD 主题对齐的取值，
// 由调用方把 light 传进来——src/theme.js 里的 plotColors 是同一套值。
export function themeColors(light) {
  return {
    paperBg: light ? '#ffffff' : '#141414',
    textColor: light ? 'rgba(0,0,0,0.88)' : 'rgba(255,255,255,0.85)',
    muted: light ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.45)',
    axis: {
      gridcolor: light ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.10)',
      zerolinecolor: light ? 'rgba(0,0,0,.18)' : 'rgba(255,255,255,.20)',
      linecolor: light ? 'rgba(0,0,0,.18)' : 'rgba(255,255,255,.20)',
    },
  };
}

const PALETTE = ['#0a84ff', '#ff9f0a', '#30d158', '#bf5af2', '#ff453a', '#64d2ff', '#ffd60a', '#ac8e68'];

// 收集入图的点。查找命中（标星）在某些图上会"凭空消失"——不是高亮坏了，而是这些 CA 在该图的
// X/Y 字段上没有值、或被对数轴的 <=0 规则挡掉，压根没进 points。这里按原因分别记账，
// 让调用方能在图注里说清楚少了几个、为什么少，而不是静默丢弃。
export function collectPoints({ rows, xField, yField, colorField, logX, logY, highlightCAs }) {
  const points = [], pairs = [];
  const dropped = { missing: 0, nonPositive: 0 };
  const hlSet = highlightCAs || new Set();
  const isHl = row => hlSet.size && row.tokenAddress && hlSet.has(String(row.tokenAddress).toLowerCase());

  for (const row of rows) {
    const xv = getFeature(row, xField);
    const yv = getFeature(row, yField);
    if (xv === undefined || xv === null || yv === undefined || yv === null) { if (isHl(row)) dropped.missing++; continue; }
    const xn = Number(xv), yn = Number(yv);
    if (!Number.isFinite(xn) || !Number.isFinite(yn)) { if (isHl(row)) dropped.missing++; continue; }
    if (logX && xn <= 0) { if (isHl(row)) dropped.nonPositive++; continue; }
    if (logY && yn <= 0) { if (isHl(row)) dropped.nonPositive++; continue; }
    points.push({
      x: xn, y: yn,
      text: `${row.symbol || ''} (${String(row.id || '').slice(0, 8)}...)`,
      symbol: row.symbol || '',
      tokenAddress: row.tokenAddress || '',
      colorVal: colorField ? getFeature(row, colorField) : null,
      label: row.label || null, // 人工标注（'junk'/'good'/null），供图上叠加"已标垃圾"标记
    });
    pairs.push([xn, yn]);
  }
  return { points, pairs, dropped };
}

export function buildScatterFigure({
  rows, xField, yField, colorField = '', numericColor = false,
  highlightCAs, settings = {}, light = false,
}) {
  const {
    logX = false, logY = false, clipOutliers = false, showConfBand = true,
    showBinned = false, showMarginal = true, showVLine = false, vLineValue = 2,
  } = settings;

  const { points, pairs, dropped } = collectPoints({ rows, xField, yField, colorField, logX, logY, highlightCAs });
  const xArr = points.map(p => p.x), yArr = points.map(p => p.y);
  const n = pairs.length;
  const traces = [];

  if (!colorField) {
    traces.push({
      x: xArr, y: yArr, mode: 'markers', type: 'scatter', name: '样本',
      text: points.map(p => p.text), customdata: points.map(p => p.tokenAddress),
      marker: { color: '#0a84ff', opacity: 0.6, size: 7 },
    });
  } else if (numericColor) {
    traces.push({
      x: xArr, y: yArr, mode: 'markers', type: 'scatter', name: '样本',
      text: points.map(p => p.text), customdata: points.map(p => p.tokenAddress),
      marker: {
        color: points.map(p => { const v = Number(p.colorVal); return Number.isFinite(v) ? v : null; }),
        colorscale: 'RdYlGn', showscale: true, colorbar: { title: colorField }, opacity: 0.7, size: 7,
      },
    });
  } else {
    // 分类颜色拆成多条 trace，图例才能正确显示每个类别的颜色
    const groups = new Map();
    for (const p of points) {
      const key = p.colorVal || '(空)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    let i = 0;
    for (const [key, pts] of groups) {
      traces.push({
        x: pts.map(p => p.x), y: pts.map(p => p.y), mode: 'markers', type: 'scatter',
        name: String(key), text: pts.map(p => p.text), customdata: pts.map(p => p.tokenAddress),
        marker: { color: PALETTE[i % PALETTE.length], opacity: 0.7, size: 7 },
      });
      i++;
    }
  }

  let hlShown = 0;
  const hlSet = highlightCAs || new Set();
  if (hlSet.size) {
    const hlPts = points.filter(p => p.tokenAddress && hlSet.has(String(p.tokenAddress).toLowerCase()));
    hlShown = hlPts.length;
    if (hlPts.length) {
      traces.push({
        x: hlPts.map(p => p.x), y: hlPts.map(p => p.y), mode: 'markers', type: 'scatter',
        name: `查找命中 (${hlPts.length})`, text: hlPts.map(p => p.text),
        customdata: hlPts.map(p => p.tokenAddress),
        marker: { color: '#ff453a', size: 15, symbol: 'star', line: { color: '#fff', width: 1.5 } },
      });
    }
  }

  // 人工标"垃圾"的点单独叠一层标记（灰色叉），而不是从图上直接剔除——标注影响的是全局统计口径
  // （胜率/中位数/AUC 都按降级后的 returnMax 算），图上仍要如实展示"这个点被人工判过、
  // 它现在显示的坐标已经是降级后的"，不然会有人拿着这张图问"这个点怎么长这样"却查不到原因。
  const junkPts = points.filter(p => p.label === 'junk');
  if (junkPts.length) {
    traces.push({
      x: junkPts.map(p => p.x), y: junkPts.map(p => p.y), mode: 'markers', type: 'scatter',
      name: `已标垃圾 (${junkPts.length})`, text: junkPts.map(p => p.text + '（已人工标记为垃圾，returnMax 已降级）'),
      customdata: junkPts.map(p => p.tokenAddress),
      marker: { color: '#8e8e93', size: 12, symbol: 'x', line: { color: '#8e8e93', width: 2 } },
    });
  }

  // 离群点探测提前到这里算一次：既用来（下面）收紧坐标轴显示，也用来在勾选"剔除离群点"时
  // 把这些点从相关系数/趋势线的计算里排除——不然"剔除"就只是把点挪出画面的视觉效果，
  // 极端值照样在拉着 r 值/趋势线跑，跟"剔除"这两个字的字面意思对不上。
  let cx = null, cy = null;
  const outlierIdx = new Set();
  if (clipOutliers && n >= 8) {
    cx = computeClipRange(xArr.slice().sort((a, b) => a - b));
    cy = computeClipRange(yArr.slice().sort((a, b) => a - b));
    points.forEach((p, i) => {
      const outX = !cx.degenerate && (p.x < cx.fenceLo || p.x > cx.fenceHi);
      const outY = !cy.degenerate && (p.y < cy.fenceLo || p.y > cy.fenceHi);
      if (outX || outY) outlierIdx.add(i);
    });
  }
  const outlierRows = points.filter((_, i) => outlierIdx.has(i));

  // 相关系数/趋势线用"统计口径"数据：剔除了离群点（勾选时），并按对数开关做过变换——
  // 对数轴下趋势线该是"对数空间里的一条直线"，不是"线性空间的直线硬套在对数轴上"
  // （那样在对数轴上会显示成一条跟直觉对不上的弯曲曲线，r 值也仍是线性相关，不是对数相关）。
  // collectPoints 在 logX/logY 开启时已经把 <=0 的点滤掉了，这里可以放心直接取 log10。
  const statX = v => (logX ? Math.log10(v) : v);
  const statY = v => (logY ? Math.log10(v) : v);
  const unstatY = v => (logY ? Math.pow(10, v) : v);
  const statPairs = points
    .map((p, i) => ({ p, i }))
    .filter(({ i }) => !outlierIdx.has(i))
    .map(({ p }) => [statX(p.x), statY(p.y)]);
  const nStat = statPairs.length;

  const r = pearson(statPairs);
  const pVal = pearsonPValue(r, nStat);

  if (nStat >= 2) {
    const { slope, intercept } = linearRegression(statPairs);
    const xStatArr = statPairs.map(p => p[0]);
    const minXStat = Math.min(...xStatArr), maxXStat = Math.max(...xStatArr);
    const steps = 40;
    // 对数场景下趋势线在原始坐标里是曲线，不是直线——多采样几个点连成折线才能画对；
    // 线性场景下这些多余的采样点无害，仍然会连成一条直线。
    const xsStat = Array.from({ length: steps + 1 }, (_, i) => minXStat + (maxXStat - minXStat) * i / steps);
    const xsRaw = xsStat.map(v => (logX ? Math.pow(10, v) : v));
    const ysRaw = xsStat.map(v => unstatY(slope * v + intercept));
    traces.push({
      x: xsRaw, y: ysRaw,
      mode: 'lines', type: 'scatter', name: '趋势线', line: { color: '#ff9f0a' },
      // hoverinfo:'skip' 不是可选项：Plotly 对 mode:'lines' 的最近点判定是按"到线段的距离"算的，
      // 会覆盖几乎整条横轴，把点击从样本点上抢走。趋势线没有 customdata，点击处理器按设计
      // 静默返回——表现就是"点了没反应"。
      hoverinfo: 'skip',
    });

    if (showConfBand && nStat >= 4) {
      const meanXStat = xStatArr.reduce((a, b) => a + b, 0) / nStat;
      const Sxx = xStatArr.reduce((a, x) => a + (x - meanXStat) ** 2, 0);
      const sse = statPairs.reduce((a, [x, y]) => a + (y - (slope * x + intercept)) ** 2, 0);
      const s = Math.sqrt(sse / Math.max(1, nStat - 2));
      const upper = [], lower = [];
      for (const x0 of xsStat) {
        const se = Sxx > 0 ? s * Math.sqrt(1 / nStat + (x0 - meanXStat) ** 2 / Sxx) : s / Math.sqrt(nStat);
        const yhat = slope * x0 + intercept;
        upper.push(unstatY(yhat + 1.96 * se));
        lower.push(unstatY(yhat - 1.96 * se));
      }
      traces.push({ x: xsRaw, y: upper, mode: 'lines', type: 'scatter', name: '95% 置信区间(近似)', line: { width: 0 }, showlegend: false, hoverinfo: 'skip' });
      traces.push({ x: xsRaw, y: lower, mode: 'lines', type: 'scatter', name: '95% 置信区间(近似)', line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(255,159,10,0.15)', showlegend: true, hoverinfo: 'skip' });
    }
  }

  if (showBinned && n >= 6) {
    const sorted = points.slice().sort((a, b) => a.x - b.x);
    const binCount = Math.min(8, Math.max(3, Math.round(Math.sqrt(n))));
    const binSize = Math.ceil(sorted.length / binCount);
    const binX = [], binY = [], binErr = [];
    for (let i = 0; i < sorted.length; i += binSize) {
      const chunk = sorted.slice(i, i + binSize);
      if (!chunk.length) continue;
      const binCx = chunk.reduce((a, p) => a + p.x, 0) / chunk.length;
      const cyMean = chunk.reduce((a, p) => a + p.y, 0) / chunk.length;
      const cyStd = Math.sqrt(chunk.reduce((a, p) => a + (p.y - cyMean) ** 2, 0) / chunk.length);
      binX.push(binCx); binY.push(cyMean); binErr.push(cyStd);
    }
    traces.push({
      x: binX, y: binY, mode: 'markers+lines', type: 'scatter', name: `分箱均值±标准差 (n=${binCount})`,
      error_y: { type: 'data', array: binErr, visible: true, color: '#ff453a' },
      marker: { color: '#ff453a', size: 10, symbol: 'diamond' },
      line: { color: '#ff453a', dash: 'dot' },
    });
  }

  const T = themeColors(light);
  const xaxis = { title: xField, type: logX ? 'log' : 'linear', ...T.axis };
  const yaxis = { title: yField, type: logY ? 'log' : 'linear', ...T.axis };

  // cx/cy/outlierRows 已经在上面算过一次（供相关系数/趋势线排除离群点用），这里直接复用，
  // 只用来把坐标轴范围收紧到围栏以内——不重复算一遍。
  if (clipOutliers && cx && cy) {
    if (!logX && cx.hi > cx.lo) xaxis.range = [cx.lo, cx.hi];
    if (logX && cx.hi > cx.lo && cx.lo > 0) xaxis.range = [Math.log10(cx.lo), Math.log10(cx.hi)];
    if (!logY && cy.hi > cy.lo) yaxis.range = [cy.lo, cy.hi];
    if (logY && cy.hi > cy.lo && cy.lo > 0) yaxis.range = [Math.log10(cy.lo), Math.log10(cy.hi)];
  }

  // 左侧 Y 边际分布。不画 X 的：X 常是重尾字段（如 returnMax），顶部直方图会退化成
  // "第一根柱子顶天、其余贴地"，占画布却读不出信息。
  const marginalAxes = {};
  if (showMarginal && n >= 2) {
    const HIST_W = 0.15;
    xaxis.domain = [HIST_W, 1];   // 与直方图直接相接，留缝会读成"两张图并排"
    marginalAxes.xaxis2 = { domain: [0, HIST_W], showgrid: false, zeroline: false, showticklabels: false, anchor: 'y' };
    yaxis.anchor = 'x2';          // Y 轴刻度改画在直方图外侧，否则会压在柱子上
    traces.push({
      type: 'histogram', y: yArr, xaxis: 'x2',
      nbinsy: Math.min(60, Math.max(10, Math.round(Math.sqrt(n) * 2))),
      marker: { color: 'rgba(255,159,10,0.55)' }, showlegend: false, hoverinfo: 'skip',
    });
  }

  const shapes = [], annotations = [];
  if (showVLine && Number.isFinite(Number(vLineValue)) && (!logX || Number(vLineValue) > 0)) {
    const vx = Number(vLineValue);
    shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: vx, x1: vx, y0: 0, y1: 1, line: { color: '#bf5af2', width: 1.5, dash: 'dash' } });
    annotations.push({ x: vx, y: 1, xref: 'x', yref: 'paper', yanchor: 'bottom', showarrow: false, text: String(vx), font: { color: '#bf5af2', size: 11 } });
  }

  const statsText = `n=${nStat}  r=${r.toFixed(4)}  p=${Number.isFinite(pVal) ? pVal.toExponential(2) : 'N/A'}`;
  const layout = {
    paper_bgcolor: T.paperBg, plot_bgcolor: T.paperBg,
    font: { color: T.textColor, family: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif' },
    title: { text: `<span style="font-size:12px;color:${T.muted}">${statsText}（点击数据点打开 logearn）</span>` },
    xaxis, yaxis, ...marginalAxes,
    hovermode: 'closest', bargap: 0.05,
    // 横向图例默认贴在绘图区正下方，会盖住 X 轴标题
    legend: { orientation: 'h', y: -0.16, yanchor: 'top', font: { color: T.textColor } },
    margin: { t: 40, b: 90 },
    shapes, annotations,
  };

  const notices = [];
  if (outlierRows.length) {
    const top = outlierRows.slice(0, 5)
      .map(p => `${p.symbol || '(无symbol)'} ${xField}=${p.x.toPrecision(4)}, ${yField}=${p.y.toPrecision(4)}`).join('； ');
    notices.push(`坐标轴已按 IQR 围栏自动收紧，共 ${outlierRows.length} 个离群点未显示、也不参与 r/p/趋势线计算（图上样本点仍照常画出，只是不进统计）：${top}`);
  }
  const droppedTotal = dropped.missing + dropped.nonPositive;
  if (droppedTotal) {
    const reasons = [];
    if (dropped.missing) reasons.push(`${dropped.missing} 个在 ${xField} / ${yField} 上没有取值`);
    if (dropped.nonPositive) reasons.push(`${dropped.nonPositive} 个取值 ≤ 0、被对数轴排除`);
    notices.push(`查找命中的 CA 有 ${droppedTotal} 个未在本图标星（${reasons.join('；')}），本图实际标星 ${hlShown} 个。这不是查找失效，是这些样本在本图的字段上缺数据。`);
  }

  return { traces, layout, stats: { n: nStat, r, p: pVal, statsText }, notices, outlierRows, points };
}
