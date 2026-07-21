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
    chartSettings.set(xField, { logX: false, logY: false, clipOutliers: false, showConfBand: true, showBinned: false, swapped: defaultSwapped, showVLine: false, vLineValue: 2 });
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
    Object.assign(getChartSettings(xField), { logX: false, logY: false, clipOutliers: false, showConfBand: true, showBinned: false, swapped: defaultSwapped, showVLine: false, vLineValue: 2 });
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

// 低覆盖率过滤：字段与 Y 同时有值的行数（即图上真正能画出来的点数）低于阈值时，整张图不渲染。
// 动机：字段缺失率差异极大（信号字段只在对应信号存在时才有值，gmgn 系列约四成缺失），
// n=8 而样本集 139 条的图，置信区间宽到横跨整个值域，看着像分析、实则是噪声，还占着页面位置。
// 注意这里要把该图【自己的】对数轴设置算进去——开了 logX 时 x<=0 的点会被剔除，实际点数更少。
function countValidPoints(xField, yField) {
  const opt = getChartSettings(xField);
  const effX = opt.swapped ? yField : xField;
  const effY = opt.swapped ? xField : yField;
  let n = 0;
  for (const row of activeRows) {
    const xv = getFeature(row, effX), yv = getFeature(row, effY);
    if (xv === undefined || xv === null || yv === undefined || yv === null) continue;
    const xn = Number(xv), yn = Number(yv);
    if (!Number.isFinite(xn) || !Number.isFinite(yn)) continue;
    if (opt.logX && xn <= 0) continue;
    if (opt.logY && yn <= 0) continue;
    n++;
  }
  return n;
}

function plot() {
  const stack = document.getElementById('plotStack');
  if (!activeRows.length) {
    clearAllChartCards();
    renderPlotPagination(0, 0);
    document.getElementById('plotStats').innerHTML = matchedRows.length ? '<b>当前过滤条件下没有样本</b>' : '';
    return;
  }
  const yField = getValidFieldInput('yField');
  let fields = batchXSelected.filter(f => scatterOptions.includes(f) && f !== yField);
  // 低覆盖率过滤：只影响"哪些图渲染出来"，不动 batchXSelected（用户选的字段列表原样保留，
  // 取消勾选就全回来了），避免误以为字段被删掉了
  const covEnabledEl = document.getElementById('minCoverageEnabled');
  const covPctEl = document.getElementById('minCoveragePct');
  const covNoteEl = document.getElementById('minCoverageNote');
  let hiddenByCoverage = 0;
  if (covEnabledEl && covEnabledEl.checked && yField && activeRows.length) {
    // 单位二选一：百分比（按样本集比例算 n）或绝对条数（直接当 n）
    const unit = (document.getElementById('minCoverageUnit') || {}).value || 'pct';
    const raw = Math.max(1, Number(covPctEl && covPctEl.value) || 50);
    const minN = unit === 'abs' ? Math.ceil(raw) : Math.ceil(activeRows.length * Math.min(100, raw) / 100);
    const before = fields.length;
    fields = fields.filter(f => countValidPoints(f, yField) >= minN);
    hiddenByCoverage = before - fields.length;
    if (covNoteEl) {
      covNoteEl.textContent = hiddenByCoverage
        ? `已隐藏 ${hiddenByCoverage} 张（有效样本 < ${minN} 条）`
        : `全部 ${before} 张均达标（阈值 ${minN} 条）`;
    }
  } else if (covNoteEl) {
    covNoteEl.textContent = '';
  }
  if (!fields.length || !yField) {
    document.getElementById('plotStats').innerHTML = hiddenByCoverage
      ? `<b>没有图可显示：</b>已选字段全部被"有效样本"阈值过滤掉了（隐藏 ${hiddenByCoverage} 张）。可以调低百分比或取消勾选。`
      : '<b>错误:</b> 请先添加 X 指标并选择有效的 Y 字段';
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

  document.getElementById('plotStats').innerHTML = `<b>共 ${fields.length} 张图</b>`
    + (hiddenByCoverage ? ` <span style="color:var(--warn, #ff9f0a)">（另有 ${hiddenByCoverage} 张因有效样本不足被隐藏）</span>` : '')
    + ` &nbsp; Y = <b>${escapeHtml(yField)}</b> &nbsp; 样本集 = <b>${activeRows.length}</b> 条`;
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
    <label class="chart-opt" title="在 X 轴指定数值处画一条竖直分割线，便于按阈值直观区分两组"><input type="checkbox" data-opt="showVLine" ${opt.showVLine ? 'checked' : ''}> 分割竖线</label>
    <input type="number" class="chart-vline-value" step="any" value="${opt.vLineValue}" title="竖线所在的 X 轴数值" style="width: 64px;">
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
  const vLineInput = controls.querySelector('.chart-vline-value');

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
    vLineInput.value = opt.vLineValue;

    const yField = getValidFieldInput('yField');
    const effX = opt.swapped ? yField : xField;
    const effY = opt.swapped ? xField : yField;
    // 标题里的两个字段名做成可悬停元素：鼠标移上去显示该字段的分类/含义/计算公式，
    // 不用再回字段字典面板里翻。复制按钮取的是 textContent，加了标签也不受影响。
    const titleField = f => `<span class="plot-title-field" data-field-tip="${escapeHtml(f)}">${escapeHtml(f)}</span>`;
    titleText.innerHTML = `${titleField(effY)} vs ${titleField(effX)}`;
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
    showVLine: opt.showVLine, vLineValue: opt.vLineValue,
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
      prev.showVLine === snap.showVLine && prev.vLineValue === snap.vLineValue &&
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
  vLineInput.addEventListener('change', () => {
    const v = parseFloat(vLineInput.value);
    opt.vLineValue = Number.isFinite(v) ? v : 2;
    vLineInput.value = opt.vLineValue;
    rerender();
  });
  return { card, chartDiv, rerender, rerenderIfStale };
}

function renderScatterChart(xField, yField, settings, chartDiv, captionEl) {
  const { colorField, logX, logY, clipOutliers, showConfBand, showBinned, showVLine, vLineValue } = settings;

  const pairs = [];
  const points = []; // { x, y, text, symbol, tokenAddress }
  const numericColor = colorField && isNumericColumn(colorField);

  // 查找命中（标星）在某些图上会"凭空消失"：不是高亮功能坏了，而是这几个 CA 在该图的
  // X/Y 字段上没有值（或被对数轴的 <=0 规则挡掉），压根没进 points。以前完全静默，
  // 用户看到的现象就是"上面那张图有星星，下面这张没有"，只能怀疑是 bug。
  // 这里按原因分别记账，渲染完在 caption 里说清楚少了几个、为什么少。
  const droppedHl = { missing: 0, nonPositive: 0 };
  const isHl = row => highlightCAs.size && row.tokenAddress && highlightCAs.has(row.tokenAddress.toLowerCase());

  for (const row of activeRows) {
    const xv = getFeature(row, xField);
    const yv = getFeature(row, yField);
    if (xv === undefined || xv === null || yv === undefined || yv === null) { if (isHl(row)) droppedHl.missing++; continue; }
    const xn = Number(xv), yn = Number(yv);
    if (!Number.isFinite(xn) || !Number.isFinite(yn)) { if (isHl(row)) droppedHl.missing++; continue; }
    if (logX && xn <= 0) { if (isHl(row)) droppedHl.nonPositive++; continue; }
    if (logY && yn <= 0) { if (isHl(row)) droppedHl.nonPositive++; continue; }
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

  let hlShown = 0;
  if (highlightCAs.size) {
    const hlPts = points.filter(p => p.tokenAddress && highlightCAs.has(p.tokenAddress.toLowerCase()));
    hlShown = hlPts.length;
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

  // 分割竖线：只是在 X 轴指定数值处画一条参考线，帮助直观区分"竖线左/右两组"，不参与任何
  // 计算——用 shapes 而不是额外加一条 scatter trace，这样对数轴下 Plotly 会自动按 log 位置摆放
  // （shapes 的 x0/x1 用的是该轴的原始数据值，不需要手动取 log10），也不会被点击事件误判成样本点。
  const shapes = [];
  const annotations = [];
  if (showVLine && Number.isFinite(Number(vLineValue)) && (!logX || Number(vLineValue) > 0)) {
    const vx = Number(vLineValue);
    shapes.push({
      type: 'line', xref: 'x', yref: 'paper',
      x0: vx, x1: vx, y0: 0, y1: 1,
      line: { color: '#bf5af2', width: 1.5, dash: 'dash' }
    });
    annotations.push({
      x: vx, y: 1, xref: 'x', yref: 'paper', yanchor: 'bottom', showarrow: false,
      text: String(vx), font: { color: '#bf5af2', size: 11 }
    });
  }

  const captionParts = [];
  if (outlierRows.length) {
    const top = outlierRows.slice(0, 5);
    captionParts.push(
      `<b>坐标轴已按 IQR 围栏自动收紧，共 ${outlierRows.length} 个离群点未显示（仍参与计算）：</b> ` +
      escapeHtml(top.map(p => `${p.symbol || '(无symbol)'} ${xField}=${p.x.toPrecision ? p.x.toPrecision(4) : p.x}, ${yField}=${p.y.toPrecision ? p.y.toPrecision(4) : p.y}`).join('； ')));
  }
  const droppedHlTotal = droppedHl.missing + droppedHl.nonPositive;
  if (droppedHlTotal) {
    const reasons = [];
    if (droppedHl.missing) reasons.push(`${droppedHl.missing} 个在 ${escapeHtml(xField)} / ${escapeHtml(yField)} 上没有取值`);
    if (droppedHl.nonPositive) reasons.push(`${droppedHl.nonPositive} 个取值 ≤ 0、被对数轴排除`);
    captionParts.push(`<b style="color:var(--warn, #ff9f0a)">查找命中的 CA 有 ${droppedHlTotal} 个未在本图标星</b>（${reasons.join('；')}），本图实际标星 ${hlShown} 个。这不是查找失效，是这些样本在本图的字段上缺数据。`);
  }
  captionEl.innerHTML = captionParts.join('<br>');

  const statsText = `n=${n}  r=${r.toFixed(4)}  p=${Number.isFinite(pVal) ? pVal.toExponential(2) : 'N/A'}`;
  Plotly.newPlot(chartDiv, traces, darkLayout({
    title: { text: `<span style="font-size:12px;color:${themeMutedColor()}">${statsText}（点击数据点打开 logearn）</span>` },
    xaxis, yaxis,
    hovermode: 'closest',
    legend: { orientation: 'h' },
    margin: { t: 40 },
    shapes, annotations
  }), { responsive: true }).catch(err => {
    // Plotly.newPlot 对某些数据分布（比如某个 X 字段全部同值、方差为 0、log 轴遇到 <=0 等边界
    // 情况）会在内部渲染时抛错导致 Promise reject；以前这里没有 .catch，一旦某张图命中这种情况，
    // 后面的 .then() 绑定点击事件的代码根本不会执行，且没有任何报错提示——图看起来渲染出来了
    // （Plotly 经常是先画出大部分内容再在某一步抛错），但点数据点永远没反应，且没法从控制台之外
    // 看出原因。这里兜底捕获一下，至少不让这一步阻断后面的点击事件绑定。
    console.error('Plotly 图表渲染出现异常，仍尝试绑定点击事件：', err);
  }).then(() => {
    // 【每次 newPlot 之后都必须重新绑定】——这里曾经用一个 __clickBound 标记做"只绑一次"，
    // 依据是"重复调用 Plotly.newPlot 不会清空已注册的监听器"。这个前提是错的：
    // 实测 Plotly 2.27.0，newPlot 会把 gd 上已注册的事件监听器全部清掉
    //   （绑定后 gd._ev._events.plotly_click 长度 1 → 再次 newPlot 后变成 0）。
    // 于是只绑一次的后果是：图表首次渲染能点开，之后任何一次 rerender（切对数轴 / 剔除离群点 /
    // 交换 X-Y / 翻页回来）都会 newPlot 清掉监听器，而标记还是 true 不再重绑，这张图就永久
    // 点不开了——正是"有的图能点开、有的点了完全没反应"的成因。
    //
    // 改成每次都重绑；重绑前先 removeAllListeners 清掉可能残留的旧监听器，避免万一某个版本/
    // 路径下没被清而导致一次点击开出 N 个标签页。实测连续 4 次 rerender 后监听器数恒为 1。
    if (typeof chartDiv.on !== 'function') {
      console.error('[logearn点击] Plotly 未能在该图上挂载事件接口，本次跳过绑定（下次 rerender 会重试）');
      return;
    }
    try {
      if (typeof chartDiv.removeAllListeners === 'function') chartDiv.removeAllListeners('plotly_click');
      chartDiv.on('plotly_click', ev => {
        // 用 ev.points[0] 而不是找第一个有 customdata 的点：当点击位置恰好和趋势线/置信区间边缘
        // 重叠时，Plotly 的 hovermode:'closest' 有时会命中那条线而不是下面的样本点，line/置信区间
        // trace 没有 customdata，导致明明点在数据点上却没反应。改成从所有命中里找第一个有
        // customdata 的，样本点和趋势线重叠时依然能正确取到样本点的地址。
        const pt = (ev.points || []).find(p => p.customdata) || (ev.points && ev.points[0]);
        const addr = pt && pt.customdata;
        if (!addr) {
          // 趋势线/置信带/分箱统计等非样本 trace 没有 customdata：之前这里直接静默 return，
          // 用户点了没反应、console 也没日志，完全看不出发生了什么。现在给个明确提示，
          // 而不是让用户怀疑是图表本身坏了（大多数情况下已经靠上面给趋势线加 hoverinfo:'skip'
          // 从根上避免命中趋势线，这里只是兜底剩余的边界情况，如启用了"分档统计"时点在分箱线上）。
          showToast('该位置未命中具体样本点（可能点在趋势线/分档统计线上），请点击蓝色圆点样本');
          return;
        }
        const url = logearnUrl(addr);
        if (!url) return;
        // window.open 被浏览器弹窗拦截时会返回 null/undefined（不抛错，界面上往往只有地址栏一个
        // 很容易被忽略的小图标提示），之前完全没处理这种情况，看起来就是"点了没反应"。这里检测
        // 一下，拦截时明确用 toast 告诉用户去放行，而不是让用户怀疑是这张图表本身坏了。
        const win = window.open(url, '_blank');
        if (!win) showToast('浏览器拦截了新页签，请点击地址栏的拦截图标允许弹出窗口后重试', true);
      });
    } catch (e) {
      console.error('绑定图表点击事件失败（下次 rerender 会重试）：', e);
    }
  });
}

// 根据地址格式推断链：0x 开头为 EVM（bsc），否则视为 solana
function logearnUrl(addr) {
  if (!addr) return '';
  const chainSlug = String(addr).startsWith('0x') ? 'bsc' : 'solana';
  return `https://logearn.com/cn/${chainSlug}/tokens/${addr}`;
}

// 收益分布：直方图 + P10~P99 分位数表。目标字段（returnMax）恒为正，对数轴默认开启，
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
// 每个候选点把样本分两组，衡量两组目标字段分布的区分度，选出差异最大的几个分裂点，贪心去重
// 避免选出彼此过近、没有额外信息量的点。
//
// 【2026-07 修正】原先用 ANOVA F（比较两组均值）打分，对 returnMax 这类右尾极端分布极不稳健：
// 只要某一侧恰好混进一两个几十倍的暴涨样本，均值就能被拉到看起来"区分度很高"，选出的断点
// 实质是在隔离离群值（真实出现过 n=132 vs n=16 这种切分，n=16 那组均值15.77但中位数只有1.62、
// 标准差52，纯粹是被极端值污染），而不是反映真实的分布差异。改用秩和（Mann-Whitney U）算的
// AUC 衡量两组区分度——只看排序、不看数值大小，同等程度不会被极端值的绝对幅度带偏；同时把
// 每组最小样本数从固定 3 提到"绝对下限 + 总量5%"，避免挑出一个只占样本总量个位数百分比的
// 极端小组。
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

  const n = pairs.length;
  const ys = pairs.map(p => p[1]);
  // 每组最少样本数：绝对下限 8（太少了统计上没意义），且不能低于总量的 8%（避免挑出一个只占
  // 个位数百分比的极端小组，靠寥寥几个样本的"伪区分度"胜出）
  const minGroupSize = Math.max(8, Math.ceil(n * 0.08));

  // 候选分裂点：按 5%~95% 分位数取 19 个候选（避开首尾，避免产生空分组）
  const candidates = new Set();
  for (let p = 5; p <= 95; p += 5) {
    const idx = Math.floor((p / 100) * (sortedX.length - 1));
    candidates.add(sortedX[idx]);
  }
  const scored = [];
  for (const c of candidates) {
    const labels = new Array(n);
    let n1 = 0;
    for (let i = 0; i < n; i++) {
      labels[i] = pairs[i][0] <= c ? 0 : 1;
      if (labels[i] === 1) n1++;
    }
    const n0 = n - n1;
    if (n0 < minGroupSize || n1 < minGroupSize) continue;
    const auc = rankAuc(ys, labels, 'higher');
    if (Number.isFinite(auc)) scored.push({ c, score: Math.abs(auc - 0.5) });
  }
  if (!scored.length) return { error: `未找到有效的候选分裂点（每组样本数需 ≥ ${minGroupSize}），建议直接手动设置断点或换个字段` };
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

// 最近一次分箱图 / 断点挖掘的计算结果快照，供"导出给 AI 诊断"复用——
// 导出时重算一遍不仅浪费，还可能因为用户中途改了输入框而与屏幕上看到的图不一致
let lastBinBarResult = null;
let lastBreakpointMineResult = null;

// ---------- 断点挖掘（样本外验证版）----------
// 为什么不走"找最优切点 + 显著性检验"那条路：实测用户场景 n≈148、基准胜率 31.8%，
// 该样本量下能检出的最小差异约 21pp，而字段里实际最大差异只有 7.5pp——要测出 7.5pp 需要约
// 1200 条样本。也就是说，在这个量级上【所有】字段都必然显示"不显著"，换任何检验方法都一样，
// p 值这条路提供不了任何区分度。
//
// 改用样本外验证：按时间把样本切成前后两段，只在前段（训练集）搜索最优切点，然后拿到后段
// （验证集）上原样套用。逻辑是——过拟合出来的规则在新数据上会失效甚至反向，真实规律则会保持
// 同方向。这不需要样本量达到检验功效的门槛，小样本下也能给出可操作的判断。
// 按【时间】而不是随机切分：策略是拿历史推未来，随机切分会让未来信息泄漏进训练集，高估效果。
const OOS_TRAIN_RATIO = 0.7;

// 当前样本量下能检出的最小差异（α=0.05 双尾、power=0.8、两组等分的经典近似）。
// 用途：让使用者知道能力边界——观察到的差异若小于它，就算是真的也测不出来。
function minDetectableDiff(n, baseRate) {
  if (!Number.isFinite(n) || n < 10 || !Number.isFinite(baseRate) || baseRate <= 0 || baseRate >= 1) return NaN;
  return (1.96 + 0.8416) * Math.sqrt(2 * baseRate * (1 - baseRate) / (n / 2));
}

// 当前"赢"的阈值：默认 WIN_THRESHOLD(2)，但胜率曲线/集体检测面板可切到 5、10——
// meme 极度右偏，只看 >2 看不见"哪个区间更容易出大票"。下拉不存在时退回 2。
function currentWinThreshold() {
  const el = document.getElementById('peakWinThreshold');
  const v = el ? Number(el.value) : WIN_THRESHOLD;
  return Number.isFinite(v) && v > 0 ? v : WIN_THRESHOLD;
}

function winRateOf(pairs) {
  if (!pairs.length) return NaN;
  const T = currentWinThreshold();
  return pairs.filter(([, y]) => y > T).length / pairs.length;
}

function mineBreakpointsOOS(field, targetField, minSide) {
  const rows = [];
  for (const r of activeRows) {
    const x = getFeature(r, field), y = getFeature(r, targetField);
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) continue;
    // 时间锚点：优先开仓时间，退回买入时刻；都没有的排最后（不会污染训练集的时间顺序）
    const t = Number.isFinite(r.swapBeginTime) ? r.swapBeginTime
            : (Number.isFinite(r.buyTimestamp) ? r.buyTimestamp : Infinity);
    rows.push({ x: Number(x), y: Number(y), t });
  }
  if (rows.length < minSide * 3) {
    return { error: `有效样本 ${rows.length} 条太少：样本外验证需要先切出训练/验证两段，每段还要能再分两侧，建议调低"每侧最少样本"或换字段` };
  }
  rows.sort((a, b) => a.t - b.t);
  const splitAt = Math.floor(rows.length * OOS_TRAIN_RATIO);
  const train = rows.slice(0, splitAt).map(r => [r.x, r.y]);
  const test = rows.slice(splitAt).map(r => [r.x, r.y]);

  const trainBase = winRateOf(train), testBase = winRateOf(test);
  const sortedX = train.map(p => p[0]).sort((a, b) => a - b);
  if (new Set(sortedX).size < 3) return { error: '训练段里该字段取值种类太少（<3），没有可搜索的切分点' };

  const seen = new Set(), results = [];
  for (let q = 2.5; q <= 97.5; q += 2.5) {
    const c = percentile(sortedX, q / 100);
    if (!Number.isFinite(c) || seen.has(c)) continue;
    seen.add(c);
    const trL = train.filter(([x]) => x < c), trR = train.filter(([x]) => x >= c);
    if (trL.length < minSide || trR.length < minSide) continue;
    const trLw = winRateOf(trL), trRw = winRateOf(trR);
    // 训练段上哪一侧更好，就把哪一侧定为"选中侧"；验证段必须沿用同一个方向，
    // 不能在验证段上重新挑方向——那等于又用了一次验证数据，样本外就不再是样本外了
    const better = trRw >= trLw ? 'right' : 'left';
    const trSel = better === 'right' ? trRw : trLw;
    const trLift = trainBase > 0 ? trSel / trainBase : NaN;

    const teSelPairs = better === 'right' ? test.filter(([x]) => x >= c) : test.filter(([x]) => x < c);
    const teSel = winRateOf(teSelPairs);
    const teLift = (testBase > 0 && Number.isFinite(teSel)) ? teSel / testBase : NaN;

    results.push({
      cut: c, better,
      trainN: better === 'right' ? trR.length : trL.length, trainWin: trSel, trainLift: trLift,
      testN: teSelPairs.length, testWin: teSel, testLift: teLift,
    });
  }
  if (!results.length) return { error: `训练段里没有候选切点能让两侧各留 ${minSide} 条，请调低该值` };
  return { results, trainBase, testBase, trainSize: train.length, testSize: test.length };
}

function renderBreakpointMine() {
  const body = document.getElementById('breakpointMineBody');
  const summaryEl = document.getElementById('breakpointMineSummary');
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  const field = (document.getElementById('binField').value || '').trim();
  const targetField = (document.getElementById('binValueField').value || '').trim() || 'returnMax';
  if (!field) { showToast('请先填写上方的"分箱字段"'); return; }
  const minSide = Math.max(5, Number(document.getElementById('mineMinN').value) || 20);

  const out = mineBreakpointsOOS(field, targetField, minSide);
  if (out.error) { summaryEl.innerHTML = `<span style="color:var(--warn,#ff9f0a)">${escapeHtml(out.error)}</span>`; body.innerHTML = ''; return; }

  // 排序：训练与验证同向且都跑赢基准的排最前，其次按验证集提升排——
  // 直接按训练集提升排会把过拟合最严重的排在最前面，正好是最不该采信的那些
  const rank = r => {
    const consistent = Number.isFinite(r.testLift) && r.trainLift > 1 && r.testLift > 1;
    return consistent ? 1 : 0;
  };
  const rows = out.results.slice().sort((a, b) => {
    const d = rank(b) - rank(a);
    if (d) return d;
    return (Number.isFinite(b.testLift) ? b.testLift : -1) - (Number.isFinite(a.testLift) ? a.testLift : -1);
  });
  const holdCount = rows.filter(r => rank(r) === 1).length;

  body.innerHTML = rows.map(r => {
    const cond = r.better === 'right' ? `${field} >= ${formatNumberSmart(r.cut)}` : `${field} < ${formatNumberSmart(r.cut)}`;
    const consistent = rank(r) === 1;
    let verdict, color;
    if (!Number.isFinite(r.testLift) || r.testN < 5) { verdict = '验证段样本太少，无法判断'; color = 'var(--text-muted)'; }
    else if (consistent) { verdict = '✓ 两段同向，值得关注'; color = 'var(--ok,#30d158)'; }
    else if (r.trainLift > 1 && r.testLift <= 1) { verdict = '✗ 验证段失效（过拟合）'; color = 'var(--danger,#ff453a)'; }
    else { verdict = '训练段本身就不占优'; color = 'var(--text-muted)'; }
    return `
    <tr${consistent ? ' style="background:rgba(48,209,88,.10);"' : ''}>
      <td class="num"><b>${formatNumberSmart(r.cut)}</b></td>
      <td class="num">${r.trainN} / ${(r.trainWin * 100).toFixed(1)}% <span style="color:var(--text-muted)">(${r.trainLift.toFixed(2)}×)</span></td>
      <td class="num">${r.testN} / ${Number.isFinite(r.testWin) ? (r.testWin * 100).toFixed(1) + '%' : '-'} <span style="color:${Number.isFinite(r.testLift) && r.testLift > 1 ? 'var(--ok,#30d158)' : 'var(--danger,#ff453a)'}">${Number.isFinite(r.testLift) ? '(' + r.testLift.toFixed(2) + '×)' : ''}</span></td>
      <td style="color:${color}; font-size:11.5px;">${verdict}</td>
      <td><code style="font-size:11px;">${escapeHtml(cond)}</code></td>
      <td><button type="button" class="secondary apply-breakpoint-btn" data-cut="${r.cut}" style="padding:2px 10px; font-size:11px;">填入断点</button></td>
    </tr>`;
  }).join('');

  lastBreakpointMineResult = {
    field, targetField, minSide,
    trainSize: out.trainSize, testSize: out.testSize,
    trainBase: out.trainBase, testBase: out.testBase,
    rows: rows.map(r => ({
      cut: r.cut, better: r.better,
      trainN: r.trainN, trainWin: r.trainWin, trainLift: r.trainLift,
      testN: r.testN, testWin: r.testWin, testLift: r.testLift,
      consistent: rank(r) === 1
    }))
  };

  const mde = minDetectableDiff(out.trainSize + out.testSize, out.trainBase);
  summaryEl.innerHTML =
    `<b>为什么不看 p 值：</b>当前有效样本 ${out.trainSize + out.testSize} 条、基准胜率 ${(out.trainBase * 100).toFixed(1)}%，`
    + `这个量级只能检出 <b>${Number.isFinite(mde) ? (mde * 100).toFixed(0) + 'pp' : '—'}</b> 以上的胜率差异；`
    + `实际字段的差异通常只有几个 pp，必然全部"不显著"，检验做了也没有区分度。`
    + `<br><b>改看样本外验证：</b>按时间把样本切成前 ${Math.round(OOS_TRAIN_RATIO * 100)}%（训练 ${out.trainSize} 条，胜率 ${(out.trainBase * 100).toFixed(1)}%）`
    + `和后 ${Math.round((1 - OOS_TRAIN_RATIO) * 100)}%（验证 ${out.testSize} 条，胜率 ${(out.testBase * 100).toFixed(1)}%），`
    + `只在训练段找切点，再原样拿到验证段套用。过拟合的规则到验证段会失效甚至反向，真信号才会保持同向。`
    + `<br>共 ${rows.length} 个候选切点，其中<b style="color:${holdCount ? 'var(--ok,#30d158)' : 'var(--warn,#ff9f0a)'}">${holdCount}</b> 个在两段都跑赢基准`
    + (holdCount ? '（绿色高亮行）。' : '——说明该字段上没有能延续到新数据的规则。')
    + `<br><span style="color:var(--text-muted)">注意：验证段只有 ${out.testSize} 条，本身也有波动；两段同向只是"值得继续观察"，不等于已经验证过。真正确认仍需要更多数据。</span>`;
}

// 滑动窗口胜率曲线的核心：给定按 x 排好序的 0/1 胜负序列，返回"Wilson 下界高于基准"的
// 最长连续区段长度。用增量更新维护窗口内赢数（进一个出一个），整条曲线 O(n)，
// 这样几百次置换才跑得动。
function longestAboveRun(arr, W, baselinePct) {
  if (arr.length < W) return 0;
  let k = 0;
  for (let i = 0; i < W; i++) k += arr[i];
  let best = 0, cur = 0;
  for (let i = 0; i + W <= arr.length; i++) {
    if (i > 0) k += arr[i + W - 1] - arr[i - 1];
    if (wilsonInterval(k, W).lo * 100 > baselinePct) { cur++; if (cur > best) best = cur; }
    else cur = 0;
  }
  return best;
}

// 置换检验：把胜负标签相对字段值随机打乱若干次，得到"纯随机下最长达标区段"的分布，
// 只有实际数据的最长区段显著长于它，波峰才不是噪声。
// 为什么必须这么做：曲线上有几百个位置、每个按 95% 判一次，纯随机也会有约 5% 越界；
// 而且滑动窗口相邻点高度相关，一次随机偏高会连续影响约 W 个窗口，噪声区段长度天然接近 W，
// 靠固定宽度门槛分不开（实测 5 次纯噪声有 3 次报出跨 13~20 个位置的"波峰"）。
// 置换用数据自身的重排定基准，自动把这层自相关也包含进去。
function permutationPeakTest(wins01, W, baselinePct, permN = 300) {
  const obs = longestAboveRun(wins01, W, baselinePct);
  const shuffled = wins01.slice();
  const runs = [];
  for (let t = 0; t < permN; t++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
    }
    runs.push(longestAboveRun(shuffled, W, baselinePct));
  }
  runs.sort((a, b) => a - b);
  return { obs, perm95: percentile(runs, 0.95), p: (runs.filter(r => r >= obs).length + 1) / (permN + 1) };
}

// ---------- 常用字段集体检测 ----------
// 逐个字段跑上面那套置换检验，把"确实存在非噪声波峰"的字段挑出来，省去一个个手动试。
// 关键：这里同时检验几十个字段，本身又是一次多重比较——46 个字段纯随机也会有 2~3 个 p<0.05，
// 所以对所有字段的置换 p 再做一次 BH-FDR 校正，只有校正后仍显著的才标为可用。
// permN 的下限由字段数决定：置换 p 的最小可能值是 1/(permN+1)，而 BH 校正在最好情况下要求
// 原始 p < 0.05/m（m = 字段数）。若 permN 不够，即使效应极强、置换中一次都没被超过，
// p 也只能触底在 1/(permN+1)，乘以 m 之后必然 >0.05——真信号会被数学上判死。
// 实测：43 个字段 × 200 次置换，一个"最长区段 73 vs 随机 23"的强信号照样被判不通过。
// 所以按字段数自动抬高置换次数，取 m/0.04 留出余量。
function requiredPermN(m) {
  return Math.ceil(m / 0.04);
}

function scanFieldsForPeaks(targetField, scope, permN) {
  const excluded = new Set([targetField, 'returnMax', 'logReturnMax']);
  const candidates = scatterOptions.filter(f => {
    if (excluded.has(f)) return false;
    if (scope === 'trusted' && typeof isTrustedField === 'function' && !isTrustedField(f)) return false;
    return true;
  });
  // 先按候选字段数把置换次数抬到够用的水平，否则多重比较校正会把真信号一并判死
  const effPermN = Math.max(permN, requiredPermN(candidates.length));
  const out = [];
  for (const field of candidates) {
    const pairs = [];
    for (const r of activeRows) {
      const x = getFeature(r, field), y = getFeature(r, targetField);
      if (isFiniteNumber(x) && isFiniteNumber(y)) pairs.push([Number(x), Number(y)]);
    }
    // 样本太少或字段几乎是常量，都没有"沿着取值找波峰"的意义
    if (pairs.length < 40) continue;
    if (new Set(pairs.map(p => p[0])).size < 5) continue;
    pairs.sort((a, b) => a[0] - b[0]);
    const T = currentWinThreshold();
    const wins01 = pairs.map(([, y]) => y > T ? 1 : 0);
    const base = wins01.reduce((a, b) => a + b, 0) / wins01.length;
    if (base <= 0 || base >= 1) continue; // 全赢或全输，没有可比的基准
    // 窗口随该字段的有效样本量自适应：太大曲线被抹平（用户实测窗口 140 / 样本 148 只剩 9 个位置），
    // 太小噪声压不住。取 n/5 并夹在 [20, 60]。
    const W = Math.min(60, Math.max(20, Math.round(pairs.length / 5)));
    const t = permutationPeakTest(wins01, W, base * 100, effPermN);
    // 波峰位置：实际曲线上达标区段对应的字段取值范围
    let bestSeg = null;
    if (t.obs > 0) {
      let k = 0; for (let i = 0; i < W; i++) k += wins01[i];
      let cur = 0, curStart = -1;
      for (let i = 0; i + W <= wins01.length; i++) {
        if (i > 0) k += wins01[i + W - 1] - wins01[i - 1];
        if (wilsonInterval(k, W).lo * 100 > base * 100) {
          if (cur === 0) curStart = i;
          cur++;
          if (cur === t.obs) { bestSeg = [pairs[curStart + Math.floor(W / 2)][0], pairs[i + Math.floor(W / 2)][0]]; break; }
        } else cur = 0;
      }
    }
    out.push({ field, n: pairs.length, W, base, obs: t.obs, perm95: t.perm95, p: t.p, seg: bestSeg });
  }
  const adj = benjaminiHochbergAdjust(out.map(r => r.p));
  out.forEach((r, i) => { r.adjP = adj[i]; });
  return { rows: out, scanned: candidates.length, effPermN };
}

let lastFieldScanPassed = [];

function renderFieldScan() {
  const body = document.getElementById('fieldScanBody');
  const summaryEl = document.getElementById('fieldScanSummary');
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  const targetField = (document.getElementById('binValueField').value || '').trim() || 'returnMax';
  const scope = document.getElementById('scanScope').value;
  const permN = Number(document.getElementById('scanPermN').value) || 200;

  const { rows, scanned, effPermN } = scanFieldsForPeaks(targetField, scope, permN);
  if (!rows.length) {
    summaryEl.innerHTML = `<span style="color:var(--warn,#ff9f0a)">扫描了 ${scanned} 个字段，但没有一个满足最低要求（有效样本 ≥40、取值种类 ≥5、且不是全赢/全输）。</span>`;
    body.innerHTML = ''; lastFieldScanPassed = [];
    return;
  }
  // 通过的排最前，其余按校正后 p 升序——p 小的即使没通过也更接近，值得优先复看
  rows.sort((a, b) => {
    const pa = a.adjP < 0.05 ? 1 : 0, pb = b.adjP < 0.05 ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return a.adjP - b.adjP;
  });
  const passed = rows.filter(r => r.adjP < 0.05);
  lastFieldScanPassed = passed.map(r => r.field);

  body.innerHTML = rows.map(r => {
    const ok = r.adjP < 0.05;
    const segTxt = r.seg ? `${formatNumberSmart(r.seg[0])} ~ ${formatNumberSmart(r.seg[1])}` : '—';
    return `
    <tr${ok ? ' style="background:rgba(48,209,88,.10);"' : ''}>
      <td><span data-field-tip="${escapeHtml(r.field)}" style="cursor:help; border-bottom:1px dashed var(--border-subtle);">${escapeHtml(r.field)}</span></td>
      <td class="num">${r.n}</td>
      <td class="num">${r.W}</td>
      <td class="num">${(r.base * 100).toFixed(1)}%</td>
      <td class="num">${r.obs}</td>
      <td class="num">${r.perm95.toFixed(0)}</td>
      <td class="num">${r.adjP.toExponential(2)}</td>
      <td>${ok ? `<span style="color:var(--ok,#30d158)">✓ 有真波峰</span> <code style="font-size:11px;">${escapeHtml(segTxt)}</code>` : '<span style="color:var(--text-muted)">未通过（波峰与随机无异）</span>'}</td>
      <td><button type="button" class="secondary scan-pick-field-btn" data-field="${escapeHtml(r.field)}" style="padding:2px 10px; font-size:11px;">设为分箱字段</button></td>
    </tr>`;
  }).join('');

  summaryEl.innerHTML = `扫描 ${scanned} 个字段，其中 <b>${rows.length}</b> 个满足最低要求（有效样本 ≥40、取值种类 ≥5）并完成置换检验（每个 ${effPermN} 次${effPermN > permN ? `，已按字段数自动从 ${permN} 抬高——置换 p 最小只能到 1/(次数+1)，次数不够时多重比较校正会把真信号一并判死` : ''}）。`
    + `<br>经 BH-FDR 校正后判定<b style="color:${passed.length ? 'var(--ok,#30d158)' : 'var(--warn,#ff9f0a)'}">存在真波峰的字段：${passed.length} 个</b>`
    + (passed.length ? `（绿色高亮行）：${passed.map(r => escapeHtml(r.field)).join('、')}。可点"设为分箱字段"逐个细看曲线，或用右上按钮批量加入 X 指标。`
                     : `——所有字段的波峰强度都和随机打乱数据没有区别。这通常意味着样本量不足以支撑这类探索，攒数据比继续换字段更有价值。`)
    + `<br><span style="color:var(--text-muted)">注：这里的校正是针对"同时检验多个字段"；每个字段内部沿取值找波峰造成的偏乐观，已由各自的置换检验处理。两层都过了才标为可用。</span>`;
}

// ---------- 胜率曲线（滑动窗口）----------
// 分箱柱状图只能看几个人为选定的断点切出来的档，形态被断点位置决定；换个断点结论可能就变了。
// 这里改成滑动窗口：按字段值排序后每次移动一个样本、算窗口内胜率，得到一条连续曲线，
// 能直接看出形态——单峰通常是真信号，上下锯齿多半是噪声。
//
// 关键是同时画出每个位置的 Wilson 置信带：判断"这个波峰值不值得"只需要看带子的下边缘有没有
// 整段抬到基准线以上。带子跨过基准线的起伏，无论峰有多高都是抽样波动。
function renderWinRateCurve() {
  const chartEl = document.getElementById('winCurveChart');
  const summaryEl = document.getElementById('winCurveSummary');
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  const field = (document.getElementById('binField').value || '').trim();
  const targetField = (document.getElementById('binValueField').value || '').trim() || 'returnMax';
  if (!field) { showToast('请先填写上方的"分箱字段"'); return; }
  const logX = document.getElementById('curveLogX').checked;

  const pairs = [];
  for (const r of activeRows) {
    const x = getFeature(r, field), y = getFeature(r, targetField);
    if (isFiniteNumber(x) && isFiniteNumber(y)) {
      const xn = Number(x);
      if (logX && xn <= 0) continue; // 对数轴下非正值无法显示
      pairs.push([xn, Number(y)]);
    }
  }
  const W = Math.max(10, Number(document.getElementById('curveWindow').value) || 30);
  if (pairs.length < W + 5) {
    summaryEl.innerHTML = `<span style="color:var(--warn,#ff9f0a)">有效样本 ${pairs.length} 条，不足以用 ${W} 的窗口滑动。请调小窗口或换字段。</span>`;
    Plotly.purge(chartEl);
    return;
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const T = currentWinThreshold();
  const baseWin = pairs.filter(([, y]) => y > T).length / pairs.length;

  const xs = [], ws = [], los = [], his = [];
  for (let i = 0; i + W <= pairs.length; i++) {
    const win = pairs.slice(i, i + W);
    const k = win.filter(([, y]) => y > T).length;
    const ci = wilsonInterval(k, W);
    // 横坐标取窗口内字段值的中位数：用窗口两端的均值会被极端值带偏，中位数更稳
    xs.push(win[Math.floor(W / 2)][0]);
    ws.push(k / W * 100);
    los.push(ci.lo * 100);
    his.push(ci.hi * 100);
  }

  // "值得的波峰" = 置信带下边缘高于基准线的位置；反过来上边缘低于基准线 = 显著更差的区段。
  //
  // 但光看"某个位置越界"会有大量假阳性：曲线上有几百个位置，每个都按 95% 判一次，纯随机也会
  // 有约 5% 越界（实测：一个与结果完全无关的字段，仍会报出两段"波峰"）。所以再加一道宽度门槛——
  // 噪声造成的越界通常只持续几个位置就回落，真信号会连续覆盖很长一段。
  // 门槛取窗口大小的 1/3：短于这个宽度的区段整段丢弃，宁可漏报也不误报。
  // 宽度门槛只能滤掉最短的尖峰，挡不住噪声形成的中等长度区段（实测 5 次纯噪声仍有 3 次
   // 报出跨 13~20 个位置的"波峰"）——因为滑动窗口相邻点高度相关，一次随机偏高会连续影响
   // 约 W 个窗口，噪声区段长度天然就接近 W。
   // 真正能定性的是【置换检验】：把 returnMax 与字段值的对应关系随机打乱若干次，每次重算曲线
   // 并记下最长的达标区段长度，得到"纯随机情况下最长能出现多长的区段"这个分布；只有实际数据的
   // 最长区段超过该分布的 95 分位，才能说这个波峰不是噪声。这不依赖任何分布假设，直接用数据自身
   // 的重排来定基准，是这类"曲线上找区段"问题的标准解法。
  const MIN_SEG_POINTS = Math.max(5, Math.round(W / 3));
  const above = xs.map((_, i) => los[i] > baseWin * 100);
  const below = xs.map((_, i) => his[i] < baseWin * 100);
  const segments = (flags) => {
    const segs = [];
    let start = -1;
    flags.forEach((f, i) => {
      if (f && start < 0) start = i;
      else if (!f && start >= 0) { if (i - start >= MIN_SEG_POINTS) segs.push([xs[start], xs[i - 1], i - start]); start = -1; }
    });
    if (start >= 0 && flags.length - start >= MIN_SEG_POINTS) segs.push([xs[start], xs[xs.length - 1], flags.length - start]);
    return segs;
  };
  const goodSegs = segments(above), badSegs = segments(below);
  const droppedShort = above.filter(Boolean).length > 0 && !goodSegs.length;

  // ---- 置换检验 ----
  const wins01 = pairs.map(([, y]) => y > T ? 1 : 0);
  const baseline = baseWin * 100;
  // 给定 0/1 序列，算滑动窗口下"Wilson 下界 > 基准"的最长连续区段长度。
  // 用增量更新维护窗口内的赢数（进一个出一个），整条曲线 O(n)，才撑得住几百次置换。
  const longestRun = (arr) => {
    let k = 0;
    for (let i = 0; i < W; i++) k += arr[i];
    let best = 0, cur = 0;
    for (let i = 0; i + W <= arr.length; i++) {
      if (i > 0) k += arr[i + W - 1] - arr[i - 1];
      if (wilsonInterval(k, W).lo * 100 > baseline) { cur++; if (cur > best) best = cur; }
      else cur = 0;
    }
    return best;
  };
  const obsRun = longestRun(wins01);
  const PERM_N = 300;
  const permRuns = [];
  const shuffled = wins01.slice();
  for (let t = 0; t < PERM_N; t++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
    }
    permRuns.push(longestRun(shuffled));
  }
  permRuns.sort((a, b) => a - b);
  const perm95 = percentile(permRuns, 0.95);
  // p = 随机重排中出现"不短于实际"的区段的比例（+1 是标准的保守修正，避免报出 p=0）
  const permP = (permRuns.filter(r => r >= obsRun).length + 1) / (PERM_N + 1);
  const permPass = permP < 0.05;

  const axisType = logX ? 'log' : 'linear';
  Plotly.newPlot(chartEl, [
    { x: xs, y: his, mode: 'lines', line: { width: 0 }, showlegend: false, hoverinfo: 'skip', name: 'CI上界' },
    { x: xs, y: los, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(10,132,255,0.15)',
      name: '95% 置信区间(Wilson)', hoverinfo: 'skip' },
    { x: xs, y: ws, mode: 'lines', line: { color: '#0a84ff', width: 2 }, name: `滑动窗口胜率 (窗口=${W})` },
    { x: [xs[0], xs[xs.length - 1]], y: [baseWin * 100, baseWin * 100], mode: 'lines',
      line: { color: '#ff9f0a', width: 2, dash: 'dash' }, name: `全样本基准 ${(baseWin * 100).toFixed(1)}%` },
    // 达标区段单独描粗：这些位置的置信下界已经高于基准，是真正值得看的波峰
    { x: xs.filter((_, i) => above[i]), y: ws.filter((_, i) => above[i]), mode: 'markers',
      marker: { color: '#30d158', size: 6 }, name: '置信下界高于基准' },
  ], darkLayout({
    title: `${field} → 命中率（${targetField} > ${T}）滑动窗口曲线`,
    xaxis: { title: field, type: axisType },
    yaxis: { title: '窗口胜率 (%)' },
    hovermode: 'x unified',
    margin: { t: 60 },
    showlegend: true
  }), { responsive: true });

  const fmtSeg = segs => segs.map(([a, b, len]) => `${formatNumberSmart(a)} ~ ${formatNumberSmart(b)}（跨 ${len} 个位置）`).join('、');
  summaryEl.innerHTML = `有效样本 ${pairs.length} 条，基准胜率 <b>${(baseWin * 100).toFixed(1)}%</b>，窗口 ${W}（曲线上共 ${xs.length} 个位置）。`
    + `<br>曲线最高点 <b>${Math.max(...ws).toFixed(1)}%</b>，最低点 ${Math.min(...ws).toFixed(1)}%。`
    + `<br><b>置换检验：</b>实际数据最长的达标区段跨 <b>${obsRun}</b> 个位置；把收益与字段值随机打乱 ${PERM_N} 次，纯随机下最长区段的 95 分位是 <b>${perm95.toFixed(0)}</b> 个位置，p = <b style="color:${permPass ? 'var(--ok,#30d158)' : 'var(--warn,#ff9f0a)'}">${permP.toFixed(3)}</b>。`
    + (permPass
        ? ` <span style="color:var(--ok,#30d158)">超过随机基准，波峰不是噪声。</span>`
        : ` <span style="color:var(--warn,#ff9f0a)">未超过随机基准——下面标出的区段，纯随机打乱数据同样能产生，不能当作发现。</span>`)
    + (goodSegs.length
        ? `<br>${permPass ? '<b style="color:var(--ok,#30d158)">值得关注的波峰' : '<span style="color:var(--text-muted)">（未通过置换检验，仅供参考）区段'}：${escapeHtml(fmtSeg(goodSegs))}${permPass ? '</b>' : '</span>'}`
        : (droppedShort
            ? `<br><b style="color:var(--warn,#ff9f0a)">有零星位置的置信下界超过了基准线，但都太窄（不足 ${MIN_SEG_POINTS} 个连续位置）已被滤掉</b>：曲线上有几百个位置，每个按 95% 判一次，纯随机也会有约 5% 越界，这种转瞬即逝的"尖峰"是典型噪声。`
            : `<br><b style="color:var(--warn,#ff9f0a)">没有任何位置的置信下界超过基准线</b>：曲线上所有起伏都在抽样噪声范围内，该字段目前看不出可用的波峰。`))
    + (badSegs.length ? `<br><span style="color:var(--danger,#ff453a)">显著更差的区段：${escapeHtml(fmtSeg(badSegs))}</span>——排除掉这些同样是一条有效规则。` : '')
    + `<br><span style="color:var(--text-muted)">只保留连续 ≥ ${MIN_SEG_POINTS} 个位置的区段（窗口的 1/3），更窄的一律当噪声丢弃。窗口越大曲线越平滑但越迟钝，越小越灵敏但噪声越大；相邻窗口有重叠，曲线上的点不是互相独立的，不要把连续几个点当成多个独立证据。</span>`;
}

// ---------- 导出分箱分析给 AI 诊断 ----------
// 目标不是"把数字倒出来"，而是让一个不了解这份数据的 AI 能给出【不过度解读】的建议。
// 所以除了分箱结果本身，还必须带上三类上下文，否则 AI 极容易把噪声当成发现：
//   1) 字段中文含义——字段名是 launch_to_buy_duration 这种，AI 无从判断业务意义
//   2) 统计能力边界（MDE）——不写清楚"当前样本量只能检出 21pp 差异"，AI 会对 1.04× 的提升大做文章
//   3) 数据本身的已知局限——幸存者偏差、信号类型混合、重尾分布，这些不说 AI 不可能知道
function buildBinBarAiReport() {
  if (!lastBinBarResult) return null;
  const R = lastBinBarResult;
  const L = [];
  const pct = v => Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-';
  const num = v => Number.isFinite(v) ? Number(v.toPrecision(6)) : '-';

  L.push('# 分箱分析数据（供 AI 诊断）');
  L.push('');
  L.push('## 我想要什么');
  L.push('这是一份 meme 币交易策略的历史回测数据。请基于下面的数据回答：');
  L.push('1. 这个字段值不值得用作策略的过滤条件？依据是什么？');
  L.push('2. 如果值得，断点应该设在哪里？如果不值得，说明理由。');
  L.push('3. 当前这套分析在方法上有什么问题、结论有多大可信度？');
  L.push('4. 下一步应该看什么、或者需要补什么数据？');
  L.push('');
  L.push('**请特别注意下面"统计能力边界"和"已知局限"两节，不要对达不到检出门槛的差异做过度解读。**');
  L.push('');

  L.push('## 分析设置');
  L.push(`- 分箱字段：\`${R.binField}\` —— ${getFieldDesc(R.binField) || '（无字段说明）'}`);
  L.push(`- 目标字段：\`${R.valueField}\` —— ${getFieldDesc(R.valueField) || '（无字段说明）'}`);
  L.push(`- "赢"的判定：${R.valueField} > ${WIN_THRESHOLD}（即相对买入至少翻倍）`);
  L.push(`- 分箱断点：${R.breakpoints.join(', ')}`);
  L.push('');

  // 全样本基准
  const allVals = activeRows.map(r => Number(getFeature(r, R.valueField))).filter(Number.isFinite);
  const st = allVals.length ? calcStats(allVals, WIN_THRESHOLD) : null;
  L.push('## 全样本基准');
  L.push(`- 工作集样本数：${activeRows.length}（该目标字段有效值 ${allVals.length} 条）`);
  if (st) {
    L.push(`- 基准胜率（>${WIN_THRESHOLD}倍）：${pct(st.winRate)}`);
    L.push(`- ${R.valueField} 分布：中位数 ${num(st.median)}，均值 ${num(st.mean)}，P25 ${num(st.q25)}，P75 ${num(st.q75)}，最大 ${num(st.max)}`);
    if (st.mean > st.median * 1.5) {
      L.push(`- ⚠️ 该目标是重尾右偏分布（均值是中位数的 ${(st.mean / st.median).toFixed(1)} 倍），**均值类指标会被少数极端样本主导，请以胜率和中位数为准**。`);
    }
  }
  L.push('');

  // 统计能力边界
  const mde = st ? minDetectableDiff(allVals.length, st.winRate) : NaN;
  L.push('## ⚠️ 统计能力边界（重要）');
  if (Number.isFinite(mde)) {
    L.push(`按 α=0.05 双尾、power=0.8 估算，当前样本量能可靠检出的**最小胜率差异约 ${(mde * 100).toFixed(1)} 个百分点**。`);
    L.push(`也就是说：任何小于 ${(mde * 100).toFixed(0)}pp 的档间差异，都无法与抽样波动区分开，即使它是真的也测不出来。`);
    L.push('**请不要基于低于这个幅度的差异给出"某区间更好"的结论。**');
  } else {
    L.push('样本量过小，无法估算检出能力。');
  }
  L.push('');

  L.push('## 分箱结果');
  L.push('| 区间 | n | 胜率 | 中位数 | 均值 | 标准差 | 95%CI | 备注 |');
  L.push('|---|---|---|---|---|---|---|---|');
  R.bins.forEach((b, i) => {
    const notes = [];
    if (i === R.bestIdx) notes.push('当前主指标最优');
    if (b.n > 0 && b.n < 10) notes.push('样本<10，不可信');
    if (Number.isFinite(b.mean) && Number.isFinite(b.median) && b.median > 0 && b.mean > b.median * 2) {
      notes.push(`均值被极端值拉高(${(b.mean / b.median).toFixed(1)}×中位数)`);
    }
    L.push(`| ${b.label} | ${b.n} | ${pct(b.winRate)} | ${num(b.median)} | ${num(b.mean)} | ${num(b.std)} | ${Number.isFinite(b.ci) ? '±' + num(b.ci) : '-'} | ${notes.join('；') || ''} |`);
  });
  L.push('');

  // 样本外验证（如果跑过且是同一个字段）
  if (lastBreakpointMineResult && lastBreakpointMineResult.field === R.binField) {
    const M = lastBreakpointMineResult;
    L.push('## 样本外验证（同一字段）');
    L.push(`按时间把样本切成前 70%（训练 ${M.trainSize} 条，胜率 ${pct(M.trainBase)}）和后 30%（验证 ${M.testSize} 条，胜率 ${pct(M.testBase)}）。`);
    L.push('只在训练段搜索切点，再原样拿到验证段套用——过拟合的规则在验证段会失效或反向。');
    L.push('');
    L.push('| 切分点 | 选中侧 | 训练段 n/胜率/提升 | 验证段 n/胜率/提升 | 两段是否同向 |');
    L.push('|---|---|---|---|---|');
    M.rows.slice(0, 15).forEach(r => {
      L.push(`| ${num(r.cut)} | ${r.better === 'right' ? '>=切点' : '<切点'} | ${r.trainN} / ${pct(r.trainWin)} / ${Number.isFinite(r.trainLift) ? r.trainLift.toFixed(2) + '×' : '-'} | ${r.testN} / ${pct(r.testWin)} / ${Number.isFinite(r.testLift) ? r.testLift.toFixed(2) + '×' : '-'} | ${r.consistent ? '是' : '否'} |`);
    });
    const holds = M.rows.filter(r => r.consistent).length;
    L.push('');
    L.push(`共 ${M.rows.length} 个候选切点，其中 ${holds} 个在训练段和验证段都跑赢各自基准。`);
    L.push('');
  } else {
    L.push('## 样本外验证');
    L.push('（未对该字段运行断点挖掘，因此没有样本外验证结果。仅凭单段数据挑出的最优区间天然偏乐观。）');
    L.push('');
  }

  L.push('## 已知局限（这些数据本身的问题，请纳入判断）');
  L.push('1. **幸存者偏差**：所有样本都是策略已经命中的信号，被策略过滤条件挡掉的样本不在数据里。因此本分析只能回答"在已命中的样本内部该字段有无区分度"，**不能**回答"这个字段作为过滤条件是否有价值"——后者需要未过滤的对照组。');
  L.push('2. **信号类型混合**：数据可能同时包含回撤反弹/早期精选/休眠苏醒等多类信号，不同信号的字段分布和过滤条件都不同，混在一起分析可能出现子群效应互相抵消。');
  L.push('3. **最优区间是挑出来的**：表中"最优"是在若干候选区间里选最大值，天然偏乐观；样本越少偏得越多。');
  L.push('4. **字段缺失非随机**：不同字段缺失率差异很大（部分字段仅在特定信号类型下才有值），各字段的有效样本集并不相同。');
  L.push('');
  L.push(`（导出时间：${new Date().toLocaleString()}）`);
  return L.join('\n');
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

  const labels = [], means = [], errs = [], errsLower = [], counts = [], stds = [], cis = [], medians = [], winRates = [], win5s = [], win10s = [];
  for (const b of bins) {
    const vals = b.values;
    const nb = vals.length;
    const mean = nb ? vals.reduce((a, c) => a + c, 0) / nb : NaN;
    const std = nb > 1 ? Math.sqrt(vals.reduce((a, c) => a + (c - mean) ** 2, 0) / (nb - 1)) : (nb === 1 ? 0 : NaN);
    const se = nb > 0 ? std / Math.sqrt(nb) : NaN;
    const ci95 = nb > 0 ? 1.96 * se : NaN;
    // 中位数：受极端值影响远小于均值，均值被少数暴涨/暴跌样本拉偏时，用中位数交叉验证更稳健
    const sorted = vals.slice().sort((a, c) => a - c);
    const mid = Math.floor(nb / 2);
    const median = nb === 0 ? NaN : (nb % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
    // 胜率：该区间里 returnMax 超过 WIN_THRESHOLD（翻倍）的样本占比。之所以把它作为默认主指标——
    // returnMax 是极度右偏的重尾分布，均值衡量的是"这一组有没有抽到那个 200 倍的极端值"，而不是
    // "这一组的典型表现"，一个样本就能把整档均值抬高十几倍（真实案例：某档 7 个样本，均值 32.2
    // 而中位数只有 1.96）。胜率是比例，完全不受极端值大小影响，且能直接反推成过滤阈值。
    const winRate = nb ? vals.filter(v => v > WIN_THRESHOLD).length / nb : NaN;
    // 多阈值命中率：meme 收益极度右偏，胜率(>2)看不出"哪个区间更容易出大票"——2 倍和 200 倍在它眼里
    // 一样。>5 / >10 命中率专门回答这个，且同样是比例、不被单个百倍票的绝对值绑架。
    const win5 = nb ? vals.filter(v => v > 5).length / nb : NaN;
    const win10 = nb ? vals.filter(v => v > 10).length / nb : NaN;
    labels.push(b.label); means.push(mean); counts.push(nb); stds.push(std); cis.push(ci95); medians.push(median); winRates.push(winRate); win5s.push(win5); win10s.push(win10);
    const err = errorType === 'ci95' ? ci95 : std;
    errs.push(err);
    // 下误差棒单独限制：均值 - 误差棒 不能探到比该区间实际观测到的最小值还低——像 returnMax
    // 这类字段本身不可能为负，右尾几个暴涨样本能把标准差顶得很大，对称误差棒会把下界画到负数，
    // 图上看起来完全没有意义。上误差棒不受影响，仍反映真实的标准差/置信区间大小。
    const obsMin = nb ? sorted[0] : NaN;
    errsLower.push(Number.isFinite(obsMin) ? Math.min(err, Math.max(0, mean - obsMin)) : err);
  }

  const primary = (document.getElementById('binPrimaryStat') || {}).value || 'winRate';
  // 胜率是比例，跟均值/中位数不是一个量纲，误差棒（标准差/CI 都是按原始值算的）挂上去没有意义，
  // 所以只有均值模式才画误差棒
  const traces = [];
  if (primary === 'winRate') {
    traces.push({
      x: labels, y: winRates.map(w => Number.isFinite(w) ? w * 100 : null), type: 'bar', name: `胜率（>${WIN_THRESHOLD}倍）`,
      marker: { color: '#30d158' },
      text: counts.map((c, i) => `n=${c}`), textposition: 'outside'
    });
  } else if (primary === 'median') {
    traces.push({
      x: labels, y: medians, type: 'bar', name: '中位数',
      marker: { color: '#ff9f0a' },
      text: counts.map(c => `n=${c}`), textposition: 'outside'
    });
  } else {
    traces.push({
      x: labels, y: means, type: 'bar', name: '均值',
      error_y: { type: 'data', array: errs, arrayminus: errsLower, visible: true, color: '#98989d' },
      marker: { color: '#0a84ff' },
      text: counts.map(c => `n=${c}`), textposition: 'outside'
    });
    traces.push({
      x: labels, y: medians, type: 'scatter', mode: 'markers', name: '中位数',
      marker: { color: '#ff9f0a', size: 12, symbol: 'diamond' }
    });
  }
  const primaryTitle = primary === 'winRate' ? `胜率（${valueField} > ${WIN_THRESHOLD}）`
                     : primary === 'median' ? `${valueField} 中位数`
                     : `${valueField} 均值 ± ${errorType === 'ci95' ? '95% CI' : '标准差'}（橙色菱形=中位数）`;
  Plotly.newPlot('binBarChart', traces, darkLayout({
    title: `按 ${binField} 分箱：${primaryTitle}`,
    xaxis: { title: binField },
    yaxis: { title: primary === 'winRate' ? '胜率 (%)' : valueField },
    margin: { t: 60 },
    showlegend: true
  }), { responsive: true });

  // 最优区间：按当前主指标取最大的那一档（样本数过少的不参与评选，否则 n=1 的档很容易夺冠）
  const MIN_N_FOR_BEST = 10;
  const primaryVals = primary === 'winRate' ? winRates : (primary === 'median' ? medians : means);
  let bestIdx = -1;
  primaryVals.forEach((v, i) => {
    if (!Number.isFinite(v) || counts[i] < MIN_N_FOR_BEST) return;
    if (bestIdx < 0 || v > primaryVals[bestIdx]) bestIdx = i;
  });

  document.getElementById('binBarBody').innerHTML = bins.map((b, i) => {
    // 均值远大于中位数 = 该档被少数极端值主导，均值不可信。2 倍是个经验阈值：重尾分布下
    // 均值本来就会略高于中位数，差到 2 倍以上基本可以断定是个别离群点造成的。
    const skewed = Number.isFinite(means[i]) && Number.isFinite(medians[i]) && medians[i] > 0 && means[i] > medians[i] * 2;
    const tooFew = counts[i] > 0 && counts[i] < MIN_N_FOR_BEST;
    const notes = [];
    if (i === bestIdx) notes.push('<span style="color:var(--ok,#30d158)">★ 当前主指标最优</span>');
    if (tooFew) notes.push(`<span style="color:var(--text-muted)">样本&lt;${MIN_N_FOR_BEST}，不参与评优</span>`);
    if (skewed) notes.push(`<span style="color:var(--warn,#ff9f0a)">⚠ 均值被极端值拉高（${(means[i] / medians[i]).toFixed(1)}× 中位数），别看均值</span>`);
    return `
    <tr${i === bestIdx ? ' style="background:rgba(48,209,88,.10);"' : ''}>
      <td>${escapeHtml(b.label)}</td>
      <td class="num">${counts[i]}</td>
      <td class="num"><b>${Number.isFinite(winRates[i]) ? (winRates[i] * 100).toFixed(1) + '%' : '-'}</b></td>
      <td class="num">${Number.isFinite(win5s[i]) ? (win5s[i] * 100).toFixed(1) + '%' : '-'}</td>
      <td class="num">${Number.isFinite(win10s[i]) ? (win10s[i] * 100).toFixed(1) + '%' : '-'}</td>
      <td class="num">${Number.isFinite(medians[i]) ? medians[i].toFixed(4) : '-'}</td>
      <td class="num">${Number.isFinite(means[i]) ? means[i].toFixed(4) : '-'}</td>
      <td class="num">${Number.isFinite(stds[i]) ? stds[i].toFixed(4) : '-'}</td>
      <td class="num">${Number.isFinite(cis[i]) ? '±' + cis[i].toFixed(4) : '-'}</td>
      <td style="font-size:11.5px;">${notes.join('　') || ''}</td>
    </tr>`;
  }).join('');

  lastBinBarResult = {
    binField, valueField, breakpoints, primary,
    bins: bins.map((b, i) => ({
      label: b.label, lo: b.lo, hi: b.hi, n: counts[i],
      winRate: winRates[i], median: medians[i], mean: means[i], std: stds[i], ci: cis[i]
    })),
    bestIdx
  };

  // 结论行：直接给出可抄进策略的过滤条件，省去人肉从表里挑
  const summaryEl = document.getElementById('binBarSummary');
  if (summaryEl) {
    if (bestIdx < 0) {
      summaryEl.innerHTML = `<span style="color:var(--warn,#ff9f0a)">没有任何区间的样本数达到 ${MIN_N_FOR_BEST}，无法给出可靠结论——请减少断点、把区间切粗一些。</span>`;
    } else {
      const b = bins[bestIdx];
      const cond = b.lo === -Infinity ? `${binField} < ${b.hi}`
                 : b.hi === Infinity ? `${binField} >= ${b.lo}`
                 : `${binField} >= ${b.lo} 且 ${binField} < ${b.hi}`;
      const overall = activeRows.map(r => Number(getFeature(r, valueField))).filter(Number.isFinite);
      const overallWin = overall.length ? overall.filter(v => v > WIN_THRESHOLD).length / overall.length : NaN;
      const lift = Number.isFinite(overallWin) && overallWin > 0 ? winRates[bestIdx] / overallWin : NaN;
      summaryEl.innerHTML = `最优区间 <b>${escapeHtml(b.label)}</b>（n=${counts[bestIdx]}）：胜率 <b>${(winRates[bestIdx] * 100).toFixed(1)}%</b>，中位数 <b>${medians[bestIdx].toFixed(3)}</b>。`
        + (Number.isFinite(overallWin) ? ` 全样本胜率 ${(overallWin * 100).toFixed(1)}%，提升 <b>${lift.toFixed(2)}×</b>。` : '')
        + `<br>对应过滤条件：<code>${escapeHtml(cond)}</code>`
        + `<br><span style="color:var(--text-muted)">注意：区间是从数据里挑出来的最优档，天然偏乐观；n 越小越不可信，要落地建议先看这一档的样本量是否够，并用新数据验证。</span>`;
    }
  }
}
