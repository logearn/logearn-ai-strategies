// ========== 主题 / Plotly 散点图 / 分箱柱状图渲染 ==========
// 依赖 utils.js（pearson/linearRegression/computeClipRange/pearsonPValue）、data.js（getFeature/isNumericColumn）、
// ui.js（activeRows/scatterOptions/batchXSelected/getValidFieldInput/getValidColorField/highlightCAs/plot/renderBatchTags）。

const palette = ['#0a84ff','#ff9f0a','#30d158','#ff453a','#bf5af2','#ac8e68','#ff375f','#98989d','#ffd60a','#64d2ff','#5e5ce6','#ffb340','#6bd47a','#ff6961','#da8fff'];

function isLightTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light';
}

// 当前次要文字色（跟页面 --text-muted 保持一致），用于图表标题副标题等内嵌 HTML 颜色
function themeMutedColor() {
  return isLightTheme() ? '#6e6e73' : '#86868b';
}

// Plotly 主题（与页面 Apple 深色/浅色风一致）；merge 进各图表 layout，随 data-theme 动态切换
function darkLayout(layout = {}) {
  const light = isLightTheme();
  const paperBg = light ? '#ffffff' : '#1d1d1f';
  const textColor = light ? '#1d1d1f' : '#f5f5f7';
  const gridColor = light ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.08)';
  const zeroLineColor = light ? 'rgba(0,0,0,.18)' : 'rgba(255,255,255,.16)';
  const lineColor = light ? 'rgba(0,0,0,.18)' : 'rgba(255,255,255,.16)';
  const axisTheme = { gridcolor: gridColor, zerolinecolor: zeroLineColor, linecolor: lineColor };
  const merged = Object.assign({
    paper_bgcolor: paperBg,
    plot_bgcolor: paperBg,
    font: { color: textColor, family: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "PingFang SC", sans-serif' }
  }, layout);
  merged.xaxis = Object.assign({}, axisTheme, layout.xaxis || {});
  merged.yaxis = Object.assign({}, axisTheme, layout.yaxis || {});
  if (merged.legend) merged.legend = Object.assign({ font: { color: textColor } }, merged.legend);
  return merged;
}

// 全局默认：把 X 指标列表里的字段放到 Y 轴，X 轴固定为 returnMax（用户要求的"对换下"）。
// 每张图仍可单独通过 ⇄ 交换 X/Y 按钮覆盖此默认值。
let defaultSwapped = true;

// 每张图各自独立的设置（对数轴 / 剔除离群点 / 置信区间 / 分档统计），以 X 字段为 key 保存，
// 这样切换标签、重新绘图时每张图之前调整过的选项不会丢失。颜色仍是全局设置（影响所有图）。
const chartSettings = new Map();
function getChartSettings(xField) {
  if (!chartSettings.has(xField)) {
    chartSettings.set(xField, { logX: false, logY: false, clipOutliers: false, showConfBand: true, showBinned: false, swapped: defaultSwapped });
  }
  return chartSettings.get(xField);
}

// 散点图批量操作（design doc §15.2）：X 指标多选后可能同时展开 10+ 张图，逐张点开关太低效。
// 只对"当前已展示的图表"对应的字段设置生效（不影响后续新增图表的默认值），遍历 chartSettings 批量赋值后
// 统一调一次 plot() 重渲染，而不是每张图单独触发重渲染。批量按钮是明确的"设为开启"动作，不做 toggle 语义。
function batchSetChartOption(opt, value) {
  for (const xField of batchXSelected) {
    getChartSettings(xField)[opt] = value;
  }
  if (matchedRows.length) plot();
}
function resetAllChartOptions() {
  for (const xField of batchXSelected) {
    chartSettings.set(xField, { logX: false, logY: false, clipOutliers: false, showConfBand: true, showBinned: false, swapped: defaultSwapped });
  }
  if (matchedRows.length) plot();
}

// 逐个渲染所有选中的 X 指标：每个指标一张全宽散点图，自上而下平铺，
// 每张图自带一组功能按钮（对数轴 / 剔除离群点 / 置信区间 / 分档统计），互不影响
function plot() {
  const stack = document.getElementById('plotStack');
  if (!activeRows.length) {
    stack.innerHTML = '';
    document.getElementById('plotStats').innerHTML = matchedRows.length ? '<b>当前过滤条件下没有样本</b>' : '';
    return;
  }
  const yField = getValidFieldInput('yField');
  const fields = batchXSelected.filter(f => scatterOptions.includes(f) && f !== yField);
  if (!fields.length || !yField) {
    document.getElementById('plotStats').innerHTML = '<b>错误:</b> 请先添加 X 指标并选择有效的 Y 字段';
    stack.innerHTML = '';
    return;
  }
  document.getElementById('plotStats').innerHTML = `<b>共 ${fields.length} 张图</b> &nbsp; Y = <b>${escapeHtml(yField)}</b> &nbsp; 样本集 = <b>${activeRows.length}</b> 条`;
  stack.innerHTML = '';
  for (const f of fields) renderChartCard(f, yField);
}

// 导出任意已渲染的 Plotly 图为 PNG（design doc §15.4），供散点图/分箱柱状图/收益分布图统一复用。
// useLightBg 时临时把背景/字体色切成浅色再导出，导出完成后（无论成功失败）都会切回原来的颜色，
// 不影响页面上实际展示的图表。
async function exportChartPng(chartDiv, filename, useLightBg) {
  if (!chartDiv || !chartDiv.querySelector('.main-svg')) { alert('该图表还没有渲染，无法导出'); return; }
  let prevColors = null;
  if (useLightBg) {
    const layout = chartDiv.layout || {};
    prevColors = {
      paper_bgcolor: layout.paper_bgcolor,
      plot_bgcolor: layout.plot_bgcolor,
      'font.color': layout.font ? layout.font.color : undefined,
    };
    try { await Plotly.relayout(chartDiv, { paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff', 'font.color': '#1d1d1f' }); } catch (e) {}
  }
  try {
    const dataUrl = await Plotly.toImage(chartDiv, {
      format: 'png',
      width: Math.max(600, chartDiv.clientWidth || 900),
      height: Math.max(400, chartDiv.clientHeight || 480),
      scale: 2,
    });
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${(filename || 'chart').replace(/[\\/:*?"<>|]/g, '_')}.png`;
    a.click();
  } catch (e) {
    alert('导出失败：' + e.message);
  } finally {
    if (useLightBg && prevColors) {
      try { await Plotly.relayout(chartDiv, prevColors); } catch (e) {}
    }
  }
}

function renderChartCard(xField, yField) {
  const opt = getChartSettings(xField);
  const card = document.createElement('div');
  card.className = 'plot-card';

  const controls = document.createElement('div');
  controls.className = 'chart-controls';
  controls.innerHTML = `
    <button type="button" class="chart-tool-btn${opt.swapped ? ' active' : ''}" data-action="swap" title="交换该图的横纵坐标">⇄ 交换 X/Y</button>
    <label class="chart-opt"><input type="checkbox" data-opt="logX" ${opt.logX ? 'checked' : ''}> 对数 X</label>
    <label class="chart-opt"><input type="checkbox" data-opt="logY" ${opt.logY ? 'checked' : ''}> 对数 Y</label>
    <label class="chart-opt" title="勾选后基于 IQR(Tukey k=1.5) 自动识别主体数据范围并收紧坐标轴，离群点仍参与计算但不显示在图上"><input type="checkbox" data-opt="clipOutliers" ${opt.clipOutliers ? 'checked' : ''}> 剔除离群点</label>
    <label class="chart-opt" title="在趋势线周围显示 95% 置信区间"><input type="checkbox" data-opt="showConfBand" ${opt.showConfBand ? 'checked' : ''}> 趋势线置信区间</label>
    <label class="chart-opt" title="按 X 字段分档，展示每档 Y 的均值±标准差"><input type="checkbox" data-opt="showBinned" ${opt.showBinned ? 'checked' : ''}> 分档统计</label>
    <button type="button" class="chart-tool-btn danger" data-action="remove" title="删除该图表，并移除对应的 X 指标">✕ 删除该图</button>
  `;

  const titleBar = document.createElement('div');
  titleBar.className = 'plot-title-bar';
  const titleText = document.createElement('span');
  titleText.className = 'plot-title-text';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'chart-tool-btn';
  copyBtn.title = '复制标题文字';
  copyBtn.textContent = '📋 复制';
  copyBtn.addEventListener('click', () => {
    const text = titleText.textContent;
    const done = () => { copyBtn.textContent = '✓ 已复制'; setTimeout(() => { copyBtn.textContent = '📋 复制'; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(done);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      done();
    }
  });
  // 导出为图片（design doc §15.4）：Plotly 自带 toImage API，不需要自己实现导出逻辑；
  // 用当前图表标题作为默认文件名，避免拿到一堆"newplot.png"分不清是哪张图；scale:2 保证贴进文档里不糊。
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'chart-tool-btn';
  exportBtn.title = '导出该图为 PNG 图片';
  exportBtn.textContent = '🖼 导出PNG';
  const lightExportLabel = document.createElement('label');
  lightExportLabel.className = 'chart-opt';
  lightExportLabel.title = '深色主题下导出的图片背景是深色，贴到白底文档/PPT 里会不协调，勾选后临时用浅色背景导出（不影响页面上实际展示的图表）';
  lightExportLabel.innerHTML = '<input type="checkbox" class="export-light-bg"> 导出用浅色背景';
  exportBtn.addEventListener('click', () => exportChartPng(chartDiv, titleText.textContent, lightExportLabel.querySelector('input').checked));
  titleBar.appendChild(titleText);
  titleBar.appendChild(exportBtn);
  titleBar.appendChild(lightExportLabel);
  titleBar.appendChild(copyBtn);

  const chartDiv = document.createElement('div');
  chartDiv.className = 'plot-chart';
  const caption = document.createElement('div');
  caption.className = 'plot-caption hint';

  card.appendChild(controls);
  card.appendChild(titleBar);
  card.appendChild(chartDiv);
  card.appendChild(caption);
  document.getElementById('plotStack').appendChild(card);

  const rerender = () => {
    const effX = opt.swapped ? yField : xField;
    const effY = opt.swapped ? xField : yField;
    titleText.textContent = `${effY} vs ${effX}`;
    renderScatterChart(effX, effY, { ...opt, colorField: getValidColorField() }, chartDiv, caption);
  };
  controls.querySelector('[data-action="swap"]').addEventListener('click', e => {
    opt.swapped = !opt.swapped;
    e.currentTarget.classList.toggle('active', opt.swapped);
    rerender();
  });
  controls.querySelector('[data-action="remove"]').addEventListener('click', () => {
    batchXSelected = batchXSelected.filter(f => f !== xField);
    renderBatchTags();
    plot();
  });
  controls.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      opt[cb.dataset.opt] = cb.checked;
      rerender();
    });
  });
  rerender();
}

function renderScatterChart(xField, yField, settings, chartDiv, captionEl) {
  const { colorField, logX, logY, clipOutliers, showConfBand, showBinned } = settings;

  const pairs = [];
  const points = []; // { x, y, text, symbol, tokenAddress }
  const numericColor = colorField && isNumericColumn(colorField);

  for (const row of activeRows) {
    const xv = getFeature(row, xField);
    const yv = getFeature(row, yField);
    if (xv === undefined || xv === null || yv === undefined || yv === null) continue;
    const xn = Number(xv), yn = Number(yv);
    if (!Number.isFinite(xn) || !Number.isFinite(yn)) continue;
    if (logX && xn <= 0) continue;
    if (logY && yn <= 0) continue;
    const cv = colorField ? getFeature(row, colorField) : null;
    points.push({
      x: xn, y: yn,
      text: `${row.symbol || ''} (${(row.id || '').slice(0, 8)}...)`,
      symbol: row.symbol || '',
      tokenAddress: row.tokenAddress || '',
      colorVal: cv
    });
    pairs.push([xn, yn]);
  }

  const xArr = points.map(p => p.x), yArr = points.map(p => p.y);
  const traces = [];

  if (!colorField) {
    traces.push({
      x: xArr, y: yArr, mode: 'markers', type: 'scatter',
      text: points.map(p => p.text), name: '样本',
      customdata: points.map(p => p.tokenAddress),
      marker: { color: '#0a84ff', opacity: 0.6, size: 7 }
    });
  } else if (numericColor) {
    const colorArr = points.map(p => { const n = Number(p.colorVal); return Number.isFinite(n) ? n : null; });
    traces.push({
      x: xArr, y: yArr, mode: 'markers', type: 'scatter',
      text: points.map(p => p.text), name: '样本',
      customdata: points.map(p => p.tokenAddress),
      marker: { color: colorArr, colorscale: 'RdYlGn', showscale: true, colorbar: { title: colorField }, opacity: 0.7, size: 7 }
    });
  } else {
    // 分类颜色：按类别拆分为多条 trace，保证图例正确显示每个类别的颜色
    const groups = new Map();
    points.forEach(p => {
      const key = p.colorVal || '(空)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    });
    let i = 0;
    for (const [key, pts] of groups) {
      traces.push({
        x: pts.map(p => p.x), y: pts.map(p => p.y), mode: 'markers', type: 'scatter',
        text: pts.map(p => p.text), name: String(key),
        customdata: pts.map(p => p.tokenAddress),
        marker: { color: palette[i % palette.length], opacity: 0.7, size: 7 }
      });
      i++;
    }
  }

  if (highlightCAs.size) {
    const hlPts = points.filter(p => p.tokenAddress && highlightCAs.has(p.tokenAddress.toLowerCase()));
    if (hlPts.length) {
      traces.push({
        x: hlPts.map(p => p.x), y: hlPts.map(p => p.y), mode: 'markers', type: 'scatter',
        text: hlPts.map(p => p.text), name: `查找命中 (${hlPts.length})`,
        customdata: hlPts.map(p => p.tokenAddress),
        marker: { color: '#ff453a', size: 15, symbol: 'star', line: { color: '#fff', width: 1.5 } }
      });
    }
  }

  const r = pearson(pairs);
  const n = pairs.length;
  const pVal = pearsonPValue(r, n);

  if (n >= 2) {
    const { slope, intercept } = linearRegression(pairs);
    const minX = Math.min(...xArr), maxX = Math.max(...xArr);
    const steps = 40;
    const xs = Array.from({ length: steps + 1 }, (_, i) => minX + (maxX - minX) * i / steps);

    traces.push({
      x: [minX, maxX],
      y: [slope * minX + intercept, slope * maxX + intercept],
      mode: 'lines', type: 'scatter', name: '趋势线',
      line: { color: '#ff9f0a' }
    });

    if (showConfBand && n >= 4) {
      const meanX = xArr.reduce((a, b) => a + b, 0) / n;
      const Sxx = xArr.reduce((a, x) => a + (x - meanX) ** 2, 0);
      const sse = pairs.reduce((a, [x, y]) => a + (y - (slope * x + intercept)) ** 2, 0);
      const s = Math.sqrt(sse / Math.max(1, n - 2));
      const tcrit = 1.96; // 大样本近似 95% 置信
      const upper = [], lower = [];
      for (const x0 of xs) {
        const se = Sxx > 0 ? s * Math.sqrt(1 / n + (x0 - meanX) ** 2 / Sxx) : s / Math.sqrt(n);
        const yhat = slope * x0 + intercept;
        upper.push(yhat + tcrit * se);
        lower.push(yhat - tcrit * se);
      }
      traces.push({
        x: xs, y: upper, mode: 'lines', type: 'scatter', name: '95% 置信区间(近似)',
        line: { width: 0 }, showlegend: false, hoverinfo: 'skip'
      });
      traces.push({
        x: xs, y: lower, mode: 'lines', type: 'scatter', name: '95% 置信区间(近似)',
        line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(255,159,10,0.15)',
        showlegend: true, hoverinfo: 'skip'
      });
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
      const cx = chunk.reduce((a, p) => a + p.x, 0) / chunk.length;
      const cyMean = chunk.reduce((a, p) => a + p.y, 0) / chunk.length;
      const cyStd = Math.sqrt(chunk.reduce((a, p) => a + (p.y - cyMean) ** 2, 0) / chunk.length);
      binX.push(cx); binY.push(cyMean); binErr.push(cyStd);
    }
    traces.push({
      x: binX, y: binY, mode: 'markers+lines', type: 'scatter', name: `分箱均值±标准差 (n=${binCount})`,
      error_y: { type: 'data', array: binErr, visible: true, color: '#ff453a' },
      marker: { color: '#ff453a', size: 10, symbol: 'diamond' },
      line: { color: '#ff453a', dash: 'dot' }
    });
  }

  const xaxis = { title: xField, type: logX ? 'log' : 'linear' };
  const yaxis = { title: yField, type: logY ? 'log' : 'linear' };
  const outlierRows = [];

  if (clipOutliers && n >= 8) {
    const sortedX = xArr.slice().sort((a, b) => a - b);
    const sortedY = yArr.slice().sort((a, b) => a - b);
    const cx = computeClipRange(sortedX);
    const cy = computeClipRange(sortedY);
    if (!logX && cx.hi > cx.lo) xaxis.range = [cx.lo, cx.hi];
    if (logX && cx.hi > cx.lo && cx.lo > 0) xaxis.range = [Math.log10(cx.lo), Math.log10(cx.hi)];
    if (!logY && cy.hi > cy.lo) yaxis.range = [cy.lo, cy.hi];
    if (logY && cy.hi > cy.lo && cy.lo > 0) yaxis.range = [Math.log10(cy.lo), Math.log10(cy.hi)];

    points.forEach(p => {
      const outX = !cx.degenerate && (p.x < cx.fenceLo || p.x > cx.fenceHi);
      const outY = !cy.degenerate && (p.y < cy.fenceLo || p.y > cy.fenceHi);
      if (outX || outY) outlierRows.push(p);
    });
  }

  if (outlierRows.length) {
    const top = outlierRows.slice(0, 5);
    captionEl.innerHTML =
      `<b>坐标轴已按 IQR 围栏自动收紧，共 ${outlierRows.length} 个离群点未显示（仍参与计算）：</b> ` +
      escapeHtml(top.map(p => `${p.symbol || '(无symbol)'} ${xField}=${p.x.toPrecision ? p.x.toPrecision(4) : p.x}, ${yField}=${p.y.toPrecision ? p.y.toPrecision(4) : p.y}`).join('； '));
  } else {
    captionEl.innerHTML = '';
  }

  const statsText = `n=${n}  r=${r.toFixed(4)}  p=${Number.isFinite(pVal) ? pVal.toExponential(2) : 'N/A'}`;
  Plotly.newPlot(chartDiv, traces, darkLayout({
    title: { text: `<span style="font-size:12px;color:${themeMutedColor()}">${statsText}（点击数据点打开 logearn）</span>` },
    xaxis, yaxis,
    hovermode: 'closest',
    legend: { orientation: 'h' },
    margin: { t: 40 }
  }), { responsive: true }).then(() => {
    chartDiv.on('plotly_click', ev => {
      const pt = ev.points && ev.points[0];
      const addr = pt && pt.customdata;
      if (!addr) return; // 趋势线/置信带/分箱统计等非样本 trace 没有 customdata
      const url = logearnUrl(addr);
      if (url) window.open(url, '_blank');
    });
  });
}

// 根据地址格式推断链：0x 开头为 EVM（bsc），否则视为 solana
function logearnUrl(addr) {
  if (!addr) return '';
  const chainSlug = String(addr).startsWith('0x') ? 'bsc' : 'solana';
  return `https://logearn.com/cn/${chainSlug}/tokens/${addr}`;
}

// 收益分布：直方图 + P10~P99 分位数表。目标字段（returnCurrent/returnMax）恒为正，对数轴默认开启，
// 但保留"含 0/负值时自动关闭对数轴"这层保护，以防未来复用到其他可能含 0/负值的字段。
function renderDistribution() {
  const panel = document.getElementById('distPanel');
  if (!panel) return;
  if (!activeRows.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const targetField = document.getElementById('distTargetField').value;
  const logXInput = document.getElementById('distLogX');
  const values = activeRows.map(r => getFeature(r, targetField)).filter(isFiniteNumber).map(Number);
  const summaryEl = document.getElementById('distSummary');

  if (values.length < 5) {
    summaryEl.textContent = '有效样本过少（<5），无法生成分布图。';
    Plotly.purge('distChart');
    document.getElementById('distQuantileBody').innerHTML = '';
    return;
  }

  const hasNonPositive = values.some(v => v <= 0);
  logXInput.disabled = hasNonPositive;
  if (hasNonPositive) logXInput.checked = false;
  const logX = logXInput.checked;

  const sorted = values.slice().sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const q = {
    p10: percentile(sorted, 0.1), p25: percentile(sorted, 0.25), p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75), p90: percentile(sorted, 0.9), p99: percentile(sorted, 0.99)
  };

  const plotValues = logX ? values.map(v => Math.log10(v)) : values;
  const n = values.length;
  const binCountInput = Number(document.getElementById('distBinCount').value);
  const binCount = binCountInput > 0 ? binCountInput : Math.max(5, Math.round(Math.sqrt(n)));
  const medianLine = logX ? Math.log10(q.p50) : q.p50;
  const meanLine = logX ? Math.log10(mean) : mean;

  Plotly.newPlot('distChart', [{
    x: plotValues, type: 'histogram', nbinsx: binCount,
    marker: { color: '#0a84ff' }
  }], darkLayout({
    title: `${targetField} 分布${logX ? '（log10 X轴）' : ''}（n=${n}）`,
    xaxis: { title: logX ? `log10(${targetField})` : targetField },
    yaxis: { title: '样本数' },
    margin: { t: 50 },
    shapes: [
      { type: 'line', x0: medianLine, x1: medianLine, y0: 0, y1: 1, yref: 'paper', line: { color: '#30d158', dash: 'dash', width: 2 } },
      { type: 'line', x0: meanLine, x1: meanLine, y0: 0, y1: 1, yref: 'paper', line: { color: '#ff9f0a', dash: 'dash', width: 2 } }
    ],
    annotations: [
      { x: medianLine, y: 1, yref: 'paper', text: '中位数', showarrow: false, yshift: 14, font: { color: '#30d158' } },
      { x: meanLine, y: 1, yref: 'paper', text: '均值', showarrow: false, yshift: -4, font: { color: '#ff9f0a' } }
    ]
  }), { responsive: true });

  // 均值明显高于中位数 → 分布右偏，用一句自然语言提示，而不是让用户自己对比两个数字
  const skewRatio = q.p50 > 0 ? mean / q.p50 : NaN;
  summaryEl.textContent = Number.isFinite(skewRatio) && skewRatio > 1.3
    ? `均值（${formatNumberSmart(mean)}）明显高于中位数（${formatNumberSmart(q.p50)}），说明收益分布右偏，少数极端案例拉高了平均表现。`
    : '';

  document.getElementById('distQuantileBody').innerHTML = `
    <tr>
      <td class="num">${formatNumberSmart(q.p10)}</td>
      <td class="num">${formatNumberSmart(q.p25)}</td>
      <td class="num">${formatNumberSmart(q.p50)}</td>
      <td class="num">${formatNumberSmart(q.p75)}</td>
      <td class="num">${formatNumberSmart(q.p90)}</td>
      <td class="num">${formatNumberSmart(q.p99)}</td>
      <td class="num">${formatNumberSmart(mean)}</td>
    </tr>`;
}

function parseBreakpoints(text) {
  return text.split(',').map(s => parseFloat(s.trim())).filter(Number.isFinite).sort((a, b) => a - b);
}

// 最优分箱阈值推荐（design doc §8.2）：简化版单变量决策树分裂思路——按分位数取候选分裂点，
// 每个候选点把样本分两组，用现有的简化 ANOVA F 统计量（第5点分类对比已实现）衡量两组目标字段
// 均值的区分度，选出差异最大的几个分裂点，贪心去重避免选出彼此过近、没有额外信息量的点。
function recommendBreakpoints(field, targetField) {
  const pairs = [];
  for (const r of activeRows) {
    const x = getFeature(r, field);
    const y = getFeature(r, targetField);
    if (isFiniteNumber(x) && isFiniteNumber(y)) pairs.push([Number(x), Number(y)]);
  }
  if (pairs.length < 10) return { error: '有效样本不足（<10），无法推荐断点' };
  const sortedX = pairs.map(p => p[0]).sort((a, b) => a - b);
  if (new Set(sortedX).size < 4) return { error: '该字段取值种类较少，建议直接手动设置断点' };

  // 候选分裂点：按 5%~95% 分位数取 19 个候选（避开首尾，避免产生空分组）
  const candidates = new Set();
  for (let p = 5; p <= 95; p += 5) {
    const idx = Math.floor((p / 100) * (sortedX.length - 1));
    candidates.add(sortedX[idx]);
  }
  const scored = [];
  for (const c of candidates) {
    const groupA = [], groupB = [];
    for (const [x, y] of pairs) (x <= c ? groupA : groupB).push(y);
    if (groupA.length < 3 || groupB.length < 3) continue;
    const { F } = anovaFTest([groupA, groupB]);
    if (Number.isFinite(F)) scored.push({ c, score: F });
  }
  if (!scored.length) return { error: '未找到有效的候选分裂点，建议直接手动设置断点' };
  scored.sort((a, b) => b.score - a.score);

  // 贪心挑选区分度最高的最多 4 个分裂点，要求彼此间距 >= 数据整体范围的 5%，避免挑出挤在一起的重复点
  const range = sortedX[sortedX.length - 1] - sortedX[0];
  const minGap = range * 0.05;
  const picked = [];
  for (const s of scored) {
    if (picked.length >= 4) break;
    if (picked.every(p => Math.abs(p - s.c) >= minGap)) picked.push(s.c);
  }
  picked.sort((a, b) => a - b);
  return { breakpoints: picked };
}

function binLabel(lo, hi) {
  if (lo === -Infinity) return `<${hi}`;
  if (hi === Infinity) return `>=${lo}`;
  return `${lo}~${hi}`;
}

function renderBinBarChart() {
  if (!activeRows.length) { alert('请先点击"分析"加载数据'); return; }
  const binField = document.getElementById('binField').value.trim();
  const valueField = document.getElementById('binValueField').value.trim();
  if (!binField || !valueField) { alert('请填写分箱字段和数值字段'); return; }
  const breakpoints = parseBreakpoints(document.getElementById('binBreakpoints').value);
  if (!breakpoints.length) { alert('请输入有效的分箱断点，如 -0.5,0,0.5,1'); return; }
  const errorType = document.getElementById('binErrorType').value;

  const edges = [-Infinity, ...breakpoints, Infinity];
  const bins = [];
  for (let i = 0; i < edges.length - 1; i++) {
    bins.push({ lo: edges[i], hi: edges[i + 1], label: binLabel(edges[i], edges[i + 1]), values: [] });
  }

  for (const row of activeRows) {
    const bv = Number(getFeature(row, binField));
    const vv = Number(getFeature(row, valueField));
    if (!Number.isFinite(bv) || !Number.isFinite(vv)) continue;
    for (const b of bins) {
      if (bv >= b.lo && bv < b.hi) { b.values.push(vv); break; }
    }
  }

  const labels = [], means = [], errs = [], counts = [], stds = [], cis = [];
  for (const b of bins) {
    const vals = b.values;
    const nb = vals.length;
    const mean = nb ? vals.reduce((a, c) => a + c, 0) / nb : NaN;
    const std = nb > 1 ? Math.sqrt(vals.reduce((a, c) => a + (c - mean) ** 2, 0) / (nb - 1)) : (nb === 1 ? 0 : NaN);
    const se = nb > 0 ? std / Math.sqrt(nb) : NaN;
    const ci95 = nb > 0 ? 1.96 * se : NaN;
    labels.push(b.label); means.push(mean); counts.push(nb); stds.push(std); cis.push(ci95);
    errs.push(errorType === 'ci95' ? ci95 : std);
  }

  Plotly.newPlot('binBarChart', [{
    x: labels, y: means, type: 'bar',
    error_y: { type: 'data', array: errs, visible: true, color: '#98989d' },
    marker: { color: '#0a84ff' },
    text: counts.map(c => `n=${c}`), textposition: 'outside'
  }], darkLayout({
    title: `${valueField} 按 ${binField} 分箱均值 ± ${errorType === 'ci95' ? '95% CI' : '标准差'}`,
    xaxis: { title: binField },
    yaxis: { title: valueField },
    margin: { t: 60 }
  }), { responsive: true });

  document.getElementById('binBarBody').innerHTML = bins.map((b, i) => `
    <tr>
      <td>${escapeHtml(b.label)}</td>
      <td class="num">${counts[i]}</td>
      <td class="num">${Number.isFinite(means[i]) ? means[i].toFixed(4) : '-'}</td>
      <td class="num">${Number.isFinite(stds[i]) ? stds[i].toFixed(4) : '-'}</td>
      <td class="num">${Number.isFinite(cis[i]) ? '±' + cis[i].toFixed(4) : '-'}</td>
    </tr>
  `).join('');
}
