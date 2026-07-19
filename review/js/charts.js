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
  // 图表卡片现在会跨多次 plot() 调用被复用，创建卡片时闭包捕获的是 getChartSettings(xField)
  // 返回的对象引用；这里必须在原对象上原地重置字段（而不是像以前那样整个替换掉 Map 里的
  // 对象），否则已经渲染出来的卡片会一直用着替换前的旧对象，重置操作对它们不生效。
  for (const xField of batchXSelected) {
    Object.assign(getChartSettings(xField), { logX: false, logY: false, clipOutliers: false, showConfBand: true, showBinned: false, swapped: defaultSwapped });
  }
  if (matchedRows.length) plot();
}

// 逐个渲染所有选中的 X 指标：每个指标一张全宽散点图，自上而下平铺，
// 每张图自带一组功能按钮（对数轴 / 剔除离群点 / 置信区间 / 分档统计），互不影响
//
// 性能说明：以前每次调用都会 `stack.innerHTML = ''` 整体清空再重建所有卡片——
// 既没有对旧图调用 Plotly.purge()（Plotly 官方要求：移除图表容器前必须先 purge，
// 否则残留的内部监听器/状态会不断累积），也会把没有变化的图表连同它们的按钮、
// 事件监听器一起销毁重建。选中的图越多，单次"删除该图"触发的全量重建就越卡。
// 现在改为增量对账（reconcile）：按 X 字段缓存已渲染的卡片，只对"不再需要展示"
// 的图调用 purge + 移除 DOM，只对"新增"的图创建卡片，其余图表原地复用 DOM/监听器，
// 仅重新计算 Plotly 数据。
const chartCardsByField = new Map(); // xField -> { card, chartDiv, rerender }

function purgeChartCard(entry) {
  try { Plotly.purge(entry.chartDiv); } catch (e) {}
  entry.card.remove();
}

function clearAllChartCards() {
  for (const entry of chartCardsByField.values()) purgeChartCard(entry);
  chartCardsByField.clear();
}

// 分页：一次性选中几十上百个 X 指标时，就算单张图的重渲染已经做了脏检查优化，"当前页要展示
// 多少张图"本身仍然是硬成本——每张新出现的图都要跑一次 Plotly.newPlot（regression/置信区间/
// 分档统计 + SVG 绘制），129 张图一次性全画出来无论如何都会卡。分页后每次只渲染一小部分，
// 翻页时上一页的图会被正常 purge 掉（不会累积），从根上把渲染量摊开。
let plotPageSize = 20;
let plotPage = 0;

function paginationHtml(totalFields, totalPages) {
  if (totalPages <= 1) return '';
  return `
    <div class="plot-pagination">
      <button type="button" class="secondary plot-page-prev" ${plotPage === 0 ? 'disabled' : ''}>‹ 上一页</button>
      <span>第 <b style="color:var(--text)">${plotPage + 1}</b> / ${totalPages} 页，共 ${totalFields} 张图</span>
      <button type="button" class="secondary plot-page-next" ${plotPage >= totalPages - 1 ? 'disabled' : ''}>下一页 ›</button>
      <label style="display:flex; align-items:center; gap:6px;">每页
        <select class="plot-page-size">${[10, 20, 50].map(n => `<option value="${n}" ${n === plotPageSize ? 'selected' : ''}>${n}</option>`).join('')}</select>
        张
      </label>
    </div>`;
}

function renderPlotPagination(totalFields, totalPages) {
  const html = paginationHtml(totalFields, totalPages);
  const top = document.getElementById('plotPaginationTop');
  const bottom = document.getElementById('plotPaginationBottom');
  if (top) top.innerHTML = html;
  if (bottom) bottom.innerHTML = html;
}

// 翻页/改每页数量的按钮是每次 renderPlotPagination 都会被整体替换掉的动态 DOM，直接在容器上
// 用事件委托一次性绑定，不用每次渲染完再重新 addEventListener
['plotPaginationTop', 'plotPaginationBottom'].forEach(id => {
  const container = document.getElementById(id);
  if (!container) return;
  container.addEventListener('click', e => {
    if (e.target.closest('.plot-page-prev')) { plotPage = Math.max(0, plotPage - 1); plot(); }
    else if (e.target.closest('.plot-page-next')) { plotPage += 1; plot(); }
  });
  container.addEventListener('change', e => {
    if (e.target.classList.contains('plot-page-size')) {
      plotPageSize = Number(e.target.value) || 20;
      plotPage = 0;
      plot();
    }
  });
});

function plot() {
  const stack = document.getElementById('plotStack');
  if (!activeRows.length) {
    clearAllChartCards();
    renderPlotPagination(0, 0);
    document.getElementById('plotStats').innerHTML = matchedRows.length ? '<b>当前过滤条件下没有样本</b>' : '';
    return;
  }
  const yField = getValidFieldInput('yField');
  const fields = batchXSelected.filter(f => scatterOptions.includes(f) && f !== yField);
  if (!fields.length || !yField) {
    document.getElementById('plotStats').innerHTML = '<b>错误:</b> 请先添加 X 指标并选择有效的 Y 字段';
    clearAllChartCards();
    renderPlotPagination(0, 0);
    plotPage = 0;
    return;
  }

  // 之前加过"新增字段自动跳到最后一页"的逻辑，但用户反馈：图很多（比如 100 张、5 页）的时候
  // 应该始终聚焦在第一页第一张图，不要因为加字段就被甩到最后一页——只做正常的范围收紧
  // （页数变少导致当前页超界时才回退到最后一页），不主动跳页。
  const totalPages = Math.max(1, Math.ceil(fields.length / plotPageSize));
  plotPage = Math.min(Math.max(0, plotPage), totalPages - 1);

  const pageStart = plotPage * plotPageSize;
  const pageFields = fields.slice(pageStart, pageStart + plotPageSize);

  document.getElementById('plotStats').innerHTML = `<b>共 ${fields.length} 张图</b> &nbsp; Y = <b>${escapeHtml(yField)}</b> &nbsp; 样本集 = <b>${activeRows.length}</b> 条`;
  renderPlotPagination(fields.length, totalPages);

  const fieldSet = new Set(pageFields);
  for (const [f, entry] of chartCardsByField) {
    if (!fieldSet.has(f)) {
      purgeChartCard(entry);
      chartCardsByField.delete(f);
    }
  }

  let prevCard = null;
  for (const f of pageFields) {
    let entry = chartCardsByField.get(f);
    const isNew = !entry;
    if (isNew) {
      entry = createChartCard(f);
      chartCardsByField.set(f, entry);
    }
    // 先把卡片插进 DOM，再调用 Plotly 渲染：新建的卡片这时还是"游离"状态（没挂到 #plotStack
    // 上），此时量出来的容器宽度是 0，Plotly.newPlot 会按它内部的兜底宽度画图，图表就只占了
    // 卡片左边一小条、右边大片空白——即使容器随后被插入 DOM 变宽，这张图也不会自动纠正过来。
    // 顺序倒一下，量宽度时容器已经在文档里、有真实布局宽度，就不会出这个问题。
    if (!entry.card.isConnected || entry.card.previousElementSibling !== prevCard) {
      if (prevCard) prevCard.after(entry.card);
      else stack.prepend(entry.card);
    }
    prevCard = entry.card;
    if (isNew) {
      entry.rerender();
    } else {
      // 只对"渲染依据真的变了"的图重新算 Plotly 数据；纯粹增删别的图（比如点删除、加一个新
      // X 字段）不会影响这张图的 X/Y/颜色/样本集/主题，直接跳过，避免选中的图越多、单次操作
      // 越卡——重新计算回归/置信区间/分箱统计 + Plotly.newPlot 本身就不便宜，图多了尤其明显。
      entry.rerenderIfStale();
    }
  }
}

// 导出任意已渲染的 Plotly 图为 PNG（design doc §15.4），供散点图/分箱柱状图/收益分布图统一复用。
// useLightBg 时临时把背景/字体色切成浅色再导出，导出完成后（无论成功失败）都会切回原来的颜色，
// 不影响页面上实际展示的图表。
async function exportChartPng(chartDiv, filename, useLightBg) {
  if (!chartDiv || !chartDiv.querySelector('.main-svg')) { showToast('该图表还没有渲染，无法导出'); return; }
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
    showToast('导出失败：' + e.message);
  } finally {
    if (useLightBg && prevColors) {
      try { await Plotly.relayout(chartDiv, prevColors); } catch (e) {}
    }
  }
}

function createChartCard(xField) {
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

  const swapBtn = controls.querySelector('[data-action="swap"]');
  const checkboxes = controls.querySelectorAll('input[type=checkbox]');

  // yField/colorField 通过 getValidFieldInput/getValidColorField 实时读取，而不是在创建
  // 卡片时捕获成闭包常量：卡片现在会被 plot() 跨多次调用复用，Y 轴/颜色字段随时可能变化，
  // 闭包捕获的话会导致复用的卡片渲染出过期的 Y 字段。
  //
  // opt 同理也可能被卡片之外的地方原地修改（批量设置选项 / 重置所有选项），所以每次
  // rerender 都把开关控件的可视状态（checkbox 勾选 / 交换按钮高亮）跟当前 opt 同步一遍，
  // 否则复用的卡片会出现"控件显示的状态"和"实际生效的设置"对不上的情况。
  const rerender = () => {
    swapBtn.classList.toggle('active', opt.swapped);
    checkboxes.forEach(cb => { cb.checked = !!opt[cb.dataset.opt]; });

    const yField = getValidFieldInput('yField');
    const effX = opt.swapped ? yField : xField;
    const effY = opt.swapped ? xField : yField;
    titleText.textContent = `${effY} vs ${effX}`;
    renderScatterChart(effX, effY, { ...opt, colorField: getValidColorField() }, chartDiv, caption);
    renderedSnapshot = currentSnapshot();
  };
  // plot() 每次调用都会遍历所有已展示的图，但只有极少数场景真的需要重新计算 Plotly 数据
  // （Y/颜色字段变了、样本集变了、主题切换了，或者这张图自己的选项变了）——大多数时候
  // （比如删除了另一张图、新增了一个 X 字段）对这张图完全没影响。用一份轻量快照（都是
  // 基本类型或对象引用比较，不深比较 activeRows 数组本身）判断是否需要重算，命中就跳过，
  // 图越多、无关操作的性能提升越明显。
  const currentSnapshot = () => ({
    logX: opt.logX, logY: opt.logY, clipOutliers: opt.clipOutliers,
    showConfBand: opt.showConfBand, showBinned: opt.showBinned, swapped: opt.swapped,
    yField: getValidFieldInput('yField'), colorField: getValidColorField(),
    activeRows, highlightCAs, light: isLightTheme()
  });
  let renderedSnapshot = null;
  const rerenderIfStale = () => {
    const snap = currentSnapshot();
    const prev = renderedSnapshot;
    const same = prev && prev.logX === snap.logX && prev.logY === snap.logY &&
      prev.clipOutliers === snap.clipOutliers && prev.showConfBand === snap.showConfBand &&
      prev.showBinned === snap.showBinned && prev.swapped === snap.swapped &&
      prev.yField === snap.yField && prev.colorField === snap.colorField &&
      prev.activeRows === snap.activeRows && prev.highlightCAs === snap.highlightCAs &&
      prev.light === snap.light;
    if (!same) rerender();
  };
  swapBtn.addEventListener('click', () => {
    opt.swapped = !opt.swapped;
    rerender();
  });
  controls.querySelector('[data-action="remove"]').addEventListener('click', () => {
    batchXSelected = batchXSelected.filter(f => f !== xField);
    renderBatchTags();
    plot();
  });
  checkboxes.forEach(cb => {
    cb.addEventListener('change', () => {
      opt[cb.dataset.opt] = cb.checked;
      rerender();
    });
  });
  return { card, chartDiv, rerender, rerenderIfStale };
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
      line: { color: '#ff9f0a' },
      // hoverinfo:'skip'：趋势线只有 2 个数据点，但 Plotly 对 mode:'lines' 的最近点判定是按
      // "鼠标到线段本身的距离"算的，会覆盖几乎整条横轴。之前只给置信区间加了这个属性，
      // 趋势线没加，导致点击稍微偏离样本点（哪怕只偏几个像素）时，Plotly 判定"最近的点"是趋势线
      // 而不是下面的样本点——趋势线没有 customdata，点击处理器按设计静默返回，看起来就是
      // "点了没反应，console 也没日志"。加上这个属性后趋势线彻底退出 hover/点击的候选判定。
      hoverinfo: 'skip'
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
  }), { responsive: true }).catch(err => {
    // Plotly.newPlot 对某些数据分布（比如某个 X 字段全部同值、方差为 0、log 轴遇到 <=0 等边界
    // 情况）会在内部渲染时抛错导致 Promise reject；以前这里没有 .catch，一旦某张图命中这种情况，
    // 后面的 .then() 绑定点击事件的代码根本不会执行，且没有任何报错提示——图看起来渲染出来了
    // （Plotly 经常是先画出大部分内容再在某一步抛错），但点数据点永远没反应，且没法从控制台之外
    // 看出原因。这里兜底捕获一下，至少不让这一步阻断后面的点击事件绑定。
    console.error('Plotly 图表渲染出现异常，仍尝试绑定点击事件：', err);
  }).then(() => {
    // 图表卡片会在 plot() 的多次调用间被复用、反复 rerender()（切换对数轴/离群点/交换 X-Y 等
    // 都会重新走到这里），而同一个 chartDiv 上重复调用 Plotly.newPlot 并不会清空之前用 .on()
    // 挂的监听器；如果每次都重新绑定，点一次数据点会触发 N 次（rerender 过几次就开几个新标签页）。
    // 用 __clickBound 保证每个 chartDiv 只绑定一次，卡片被删除（Plotly.purge）后该 div 整个丢弃，
    // 不存在"以后还要重新绑定"的情况。
    if (chartDiv.__clickBound) return;
    chartDiv.__clickBound = true;
    try {
      chartDiv.on('plotly_click', ev => {
        // 用 ev.points[0] 而不是找第一个有 customdata 的点：当点击位置恰好和趋势线/置信区间边缘
        // 重叠时，Plotly 的 hovermode:'closest' 有时会命中那条线而不是下面的样本点，line/置信区间
        // trace 没有 customdata，导致明明点在数据点上却没反应。改成从所有命中里找第一个有
        // customdata 的，样本点和趋势线重叠时依然能正确取到样本点的地址。
        // 临时诊断日志（排查"点击没反应"问题用，定位到问题后可以删掉）：把点击命中的每一步
        // 都打出来，下次点击后直接看 console 就知道具体卡在哪一步，不用再靠猜。
        console.log('[logearn点击] plotly_click 触发，ev.points =', ev.points);
        const pt = (ev.points || []).find(p => p.customdata) || (ev.points && ev.points[0]);
        const addr = pt && pt.customdata;
        console.log('[logearn点击] 命中点 pt =', pt, ' addr =', addr);
        if (!addr) {
          // 趋势线/置信带/分箱统计等非样本 trace 没有 customdata：之前这里直接静默 return，
          // 用户点了没反应、console 也没日志，完全看不出发生了什么。现在给个明确提示，
          // 而不是让用户怀疑是图表本身坏了（大多数情况下已经靠上面给趋势线加 hoverinfo:'skip'
          // 从根上避免命中趋势线，这里只是兜底剩余的边界情况，如启用了"分档统计"时点在分箱线上）。
          showToast('该位置未命中具体样本点（可能点在趋势线/分档统计线上），请点击蓝色圆点样本');
          return;
        }
        const url = logearnUrl(addr);
        console.log('[logearn点击] 生成的 url =', url);
        if (!url) return;
        // window.open 被浏览器弹窗拦截时会返回 null/undefined（不抛错，界面上往往只有地址栏一个
        // 很容易被忽略的小图标提示），之前完全没处理这种情况，看起来就是"点了没反应"。这里检测
        // 一下，拦截时明确用 toast 告诉用户去放行，而不是让用户怀疑是这张图表本身坏了。
        const win = window.open(url, '_blank');
        console.log('[logearn点击] window.open 返回值 =', win);
        if (!win) showToast('浏览器拦截了新页签，请点击地址栏的拦截图标允许弹出窗口后重试', true);
      });
    } catch (e) {
      console.error('绑定图表点击事件失败：', e);
    }
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
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  const binField = document.getElementById('binField').value.trim();
  const valueField = document.getElementById('binValueField').value.trim();
  if (!binField || !valueField) { showToast('请填写分箱字段和数值字段'); return; }
  const breakpoints = parseBreakpoints(document.getElementById('binBreakpoints').value);
  if (!breakpoints.length) { showToast('请输入有效的分箱断点，如 -0.5,0,0.5,1'); return; }
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
