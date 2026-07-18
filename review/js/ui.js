// ========== 应用状态 + UI 交互（自动补全、过滤面板、X 指标标签输入、CSV 导出、事件绑定） ==========
// 本文件必须最后加载：底部包含页面初始化时的事件绑定/立即执行代码，依赖前面所有模块已定义完毕。

let matchedRows = [];
let activeRows = []; // 全局过滤后的工作集，无过滤时与 matchedRows 一致；相关性/散点图/总览/分箱图均基于它
let allNumericKeys = [];
let allCategoricalKeys = []; // 非数值分类字段（如 platform），供过滤面板和 Pro 版分组/分类分析使用
let allCorrelations = [];
let scatterOptions = [];
let colorOptions = [];
let highlightCAs = new Set(); // 查找 CA：命中的地址在所有散点图里高亮显示，支持多个

function updateSummary() {
  if (!activeRows.length) {
    document.getElementById('summaryText').innerHTML = `<b>匹配样本数:</b> 0（当前过滤条件下没有样本，原始 ${matchedRows.length} 条）`;
    return;
  }
  const cur = activeRows.map(r => r.returnCurrent);
  const mx = activeRows.map(r => r.returnMax);
  const cs = calcStats(cur, 1);
  const ms = calcStats(mx, 1);
  const filterNote = activeRows.length !== matchedRows.length
    ? ` &nbsp; <b>(已应用全局过滤，原始 ${matchedRows.length} 条)</b>` : '';
  document.getElementById('summaryText').innerHTML = `
    <b>匹配样本数:</b> ${activeRows.length} &nbsp;
    <b>returnCurrent 平均倍数:</b> ${cs.mean.toFixed(4)}x &nbsp;
    <b>胜率(倍数>1):</b> ${(cs.winRate * 100).toFixed(1)}% &nbsp;
    <b>returnMax 平均倍数:</b> ${ms.mean.toFixed(4)}x &nbsp;
    <b>最大倍数:</b> ${ms.max.toFixed(4)}x${filterNote}
  `;
}

function renderCorrTable() {
  const target = document.getElementById('corrTarget').value;
  const source = document.getElementById('corrSource').value;
  const top = Number(document.getElementById('topN').value);
  const correction = document.getElementById('corrCorrection').value;
  const sortBy = document.getElementById('corrSortBy').value;
  const oosEnabled = document.getElementById('oosEnabled').checked;

  // m 必须是当前 目标/来源 筛选下参与检验的全部字段数（不是 topN 截断后的数量），
  // 否则会系统性低估需要校正的严重程度；corrSource/corrTarget 切换时 m 会跟着重新计算。
  const fullSet = allCorrelations.filter(c => (target === 'all' || c.target === target) && (source === 'all' || c.source === source));
  if (sortBy === 'delta') {
    fullSet.sort((a, b) => (Number.isFinite(b.delta) ? b.delta : -1) - (Number.isFinite(a.delta) ? a.delta : -1));
  } else {
    fullSet.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  }
  const rawPs = fullSet.map(c => c.p);
  const adjustedPs = correction === 'bonferroni' ? bonferroniAdjust(rawPs)
    : correction === 'none' ? rawPs
    : benjaminiHochbergAdjust(rawPs);
  fullSet.forEach((c, i) => { c._adjP = adjustedPs[i]; });

  const rawSigCount = fullSet.filter(c => Number.isFinite(c.p) && c.p < 0.05).length;
  const adjSigCount = fullSet.filter(c => Number.isFinite(c._adjP) && c._adjP < 0.05).length;
  const summaryEl = document.getElementById('corrCorrectionSummary');
  if (correction === 'none') {
    summaryEl.textContent = `共 ${fullSet.length} 个字段参与检验，未校正时有 ${rawSigCount} 个字段 p<0.05。`;
  } else {
    const methodName = correction === 'bonferroni' ? 'Bonferroni' : 'BH-FDR';
    summaryEl.textContent = `共 ${fullSet.length} 个字段参与检验，未校正时有 ${rawSigCount} 个字段 p<0.05，${methodName} 校正后仅剩 ${adjSigCount} 个仍然显著。`;
  }

  // 样本外验证：按训练/测试集分别跑一遍 computeCorrelations，两组结果并排展示，
  // 而不是只在训练集上重新拟合（重新拟合就失去了"验证"的意义）
  let testN = 0;
  const oosWarnEl = document.getElementById('oosWarning');
  if (oosEnabled) {
    const method = document.getElementById('oosSplitMethod').value;
    const ratio = Number(document.getElementById('oosTrainRatio').value) || 0.7;
    const { train, test } = splitTrainTest(activeRows, method, ratio, 'swapBeginTime');
    testN = test.length;
    const trainCorr = computeCorrelations(train);
    const testCorr = computeCorrelations(test);
    const trainMap = new Map(trainCorr.map(c => [`${c.target}|${c.feature}`, c]));
    const testMap = new Map(testCorr.map(c => [`${c.target}|${c.feature}`, c]));
    fullSet.forEach(c => {
      const key = `${c.target}|${c.feature}`;
      c._trainR = trainMap.get(key)?.r ?? NaN;
      c._testR = testMap.get(key)?.r ?? NaN;
    });
    oosWarnEl.classList.toggle('hidden', testN >= 20);
    if (testN < 20) oosWarnEl.textContent = `⚠️ 测试集样本过少（n=${testN} < 20），样本外验证结果仅供参考。`;
  } else {
    oosWarnEl.classList.add('hidden');
  }

  document.querySelector('#corrTableHead tr').innerHTML = '<th>目标</th><th>字段</th><th>中文含义</th><th>来源</th><th class="num">r</th>'
    + (oosEnabled ? '<th class="num">训练集 r</th><th class="num">测试集 r</th>' : '')
    + '<th class="num">Spearman ρ</th><th class="num">|Δ|</th><th class="num">n</th><th class="num">p</th><th class="num">校正后 p</th><th>操作</th>';

  const filtered = fullSet.slice(0, top);
  const tbody = document.getElementById('corrBody');
  tbody.innerHTML = filtered.map(c => {
    // 曾经 p<0.05、校正后不再显著的行：用浅灰+删除线区分，而不是直接从表格里消失——
    // 让用户看到"曾经以为显著、其实经不起多重比较校验"的字段，这本身就是重要信息
    const wasDemoted = correction !== 'none' && Number.isFinite(c.p) && c.p < 0.05 && !(Number.isFinite(c._adjP) && c._adjP < 0.05);
    const rowStyle = wasDemoted ? ' style="color: var(--text-muted); text-decoration: line-through;"' : '';
    // |Δ| 较大说明 Pearson r 和 Spearman ρ 明显不一致，可能存在非线性但单调的关系，提示去散点图里看形状
    const deltaFlag = Number.isFinite(c.delta) && c.delta > 0.15
      ? ` <span title="该字段的线性相关性和单调相关性差异较大，可能存在非线性关系，建议在散点图里查看具体形状（可尝试打开对数轴）">🔀</span>` : '';
    let oosCells = '';
    if (oosEnabled) {
      // 衰减幅度较大（测试集 |r| 相比训练集下降超过 50%）或符号翻转 → 醒目标出，提示可能是过拟合/巧合
      const decayed = Number.isFinite(c._trainR) && Number.isFinite(c._testR)
        && ((Math.abs(c._trainR) > 1e-6 && Math.abs(c._testR) < Math.abs(c._trainR) * 0.5) || (Math.sign(c._trainR) !== Math.sign(c._testR) && c._trainR !== 0 && c._testR !== 0));
      const testStyle = decayed ? ' style="color:#ff453a; font-weight:600;"' : '';
      const testTitle = decayed ? ' title="该字段的相关性在样本外明显减弱或符号翻转，可能是过拟合/巧合，谨慎作为决策依据"' : '';
      oosCells = `<td class="num">${Number.isFinite(c._trainR) ? c._trainR.toFixed(4) : '-'}</td><td class="num"${testStyle}${testTitle}>${Number.isFinite(c._testR) ? c._testR.toFixed(4) : '-'}${decayed ? ' ⚠️' : ''}</td>`;
    }
    return `
    <tr${rowStyle}>
      <td>${escapeHtml(c.target)}</td>
      <td>${escapeHtml(c.feature)}</td>
      <td class="ellip" title="${escapeHtml(getFieldDesc(c.feature))}">${escapeHtml(getFieldDesc(c.feature)) || '暂无备注'}</td>
      <td><span class="tag ${c.source}">${c.source === 'assembled' ? '组装' : '原始'}</span></td>
      <td class="num">${c.r.toFixed(4)}</td>
      ${oosCells}
      <td class="num">${Number.isFinite(c.rho) ? c.rho.toFixed(4) : '-'}</td>
      <td class="num">${Number.isFinite(c.delta) ? c.delta.toFixed(4) : '-'}${deltaFlag}</td>
      <td class="num">${c.n}</td>
      <td class="num">${Number.isFinite(c.p) ? c.p.toFixed(4) : '-'}</td>
      <td class="num">${Number.isFinite(c._adjP) ? c._adjP.toFixed(4) : '-'}</td>
      <td>
        <button class="setX" data-feature="${escapeHtml(c.feature)}" data-target="${escapeHtml(c.target)}">设 X,Y</button>
      </td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('button.setX').forEach(btn => {
    btn.addEventListener('click', () => {
      const feature = btn.dataset.feature;
      const target = btn.dataset.target;
      if (scatterOptions.includes(feature) && !batchXSelected.includes(feature)) batchXSelected.push(feature);
      setFieldInputValue('yField', target);
      renderBatchTags();
      plot();
    });
  });
}

// 字段质量总览：遍历数值/分类字段，统计覆盖率（有值样本占比）和唯一值数量——
// 覆盖率过低或字段是常量（唯一值数量=1）时，相关性/分组统计的结论都不可信，需要在看相关性表之前先暴露出来。
// 基于 activeRows（过滤后数据集）而不是 matchedRows，保证用户调整过滤条件后这里的数字同步更新。
function renderFieldQuality() {
  const panel = document.getElementById('fieldQualityPanel');
  const tbody = document.getElementById('fieldQualityBody');
  if (!panel || !tbody) return;
  if (!activeRows.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const fields = [...new Set([...ROW_LEVEL_FIELDS, ...allNumericKeys, ...allCategoricalKeys])];
  const total = activeRows.length;
  let rowsData = fields.map(f => {
    let nonEmpty = 0;
    const uniq = new Set();
    for (const r of activeRows) {
      const v = getFeature(r, f);
      const valid = typeof v === 'number' ? Number.isFinite(v) : (v !== undefined && v !== null && v !== '');
      if (valid) { nonEmpty++; uniq.add(v); }
    }
    const coverage = nonEmpty / total;
    const flag = nonEmpty > 0 && uniq.size === 1 ? 'constant' : (coverage < 0.5 ? 'low' : 'normal');
    return { field: f, coverage, uniqueCount: uniq.size, flag };
  });

  const onlyIssues = document.getElementById('fieldQualityOnlyIssues').checked;
  if (onlyIssues) rowsData = rowsData.filter(r => r.flag !== 'normal');
  rowsData.sort((a, b) => a.coverage - b.coverage);

  const badgeMap = { constant: '🔴 常量', low: '🟡 低覆盖', normal: '🟢 正常' };
  tbody.innerHTML = rowsData.map(r => {
    const pct = (r.coverage * 100).toFixed(1);
    const desc = getFieldDesc(r.field) || '-';
    return `
    <tr>
      <td class="ellip" style="cursor:pointer; color:var(--accent);" title="点击跳转到相关性表">
        <span class="fq-jump" data-field="${escapeHtml(r.field)}">${escapeHtml(r.field)}</span>
      </td>
      <td class="ellip" title="${escapeHtml(desc)}">${escapeHtml(desc)}</td>
      <td>
        <div class="coverage-bar-wrap">
          <div class="coverage-bar-fill" style="width:${pct}%;"></div>
          <div class="coverage-bar-text">${pct}%</div>
        </div>
      </td>
      <td class="num">${r.uniqueCount}</td>
      <td>${badgeMap[r.flag]}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">没有匹配的字段</td></tr>`;

  tbody.querySelectorAll('.fq-jump').forEach(el => {
    el.addEventListener('click', () => jumpToCorrField(el.dataset.field));
  });
}

// 从字段质量表跳转到相关性表定位该字段：数值字段直接在相关性表里高亮对应行；
// 分类字段本身不参与相关性计算（pearson 只对数值有意义），提示改去 Pro 分析的分组/分类视图看
function jumpToCorrField(field) {
  if (!scatterOptions.includes(field) && field !== 'returnCurrent' && field !== 'returnMax') {
    alert('该字段是分类字段，不参与相关性计算；可以在下方“Pro 分析”里的“分组对比”或“分类字段分析”中查看。');
    return;
  }
  document.getElementById('corrTarget').value = 'all';
  document.getElementById('corrSource').value = 'all';
  document.getElementById('topN').value = '99999';
  renderCorrTable();
  const panel = document.getElementById('corrPanel');
  panel.classList.remove('hidden');
  const body = document.getElementById('corrBody_');
  if (body && body.classList.contains('hidden')) {
    body.classList.remove('hidden');
    const toggle = panel.querySelector('.collapse-toggle');
    if (toggle) toggle.classList.remove('collapsed');
  }
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => {
    document.querySelectorAll('#corrBody tr').forEach(tr => {
      if (tr.children[1] && tr.children[1].textContent === field) {
        tr.style.transition = 'background .3s';
        tr.style.background = 'var(--accent)';
        setTimeout(() => { tr.style.background = ''; }, 1200);
      }
    });
  }, 50);
}

function setFieldInputValue(inputId, value) {
  const input = document.getElementById(inputId);
  if (scatterOptions.includes(value)) input.value = value;
}

// 用自定义深色下拉替代浏览器原生 datalist 弹窗（原生样式无法定制、超长且丑）。
// input：实际输入框；anchorEl：下拉锚定的元素（决定下拉出现的位置，通常是 input 本身或其外层包裹容器）；
// datalistId：数据来源（沿用已有的 <datalist>，读取 option 的 value/label）；onSelect：选中某项时的回调。
function attachAutocomplete(input, anchorEl, datalistId, onSelect) {
  input.removeAttribute('list');
  const dl = document.getElementById(datalistId);
  const panel = document.createElement('div');
  panel.className = 'autocomplete-panel hidden';
  document.body.appendChild(panel);

  // 用 fixed 定位 + 实时读取锚点的屏幕坐标，不依赖任何祖先元素的 position，
  // 避免下拉面板嵌套在深层容器（如过滤条件行）里时定位基准错乱、飘到页面其他地方。
  function positionPanel() {
    const rect = anchorEl.getBoundingClientRect();
    panel.style.left = rect.left + 'px';
    panel.style.top = (rect.bottom + 6) + 'px';
    panel.style.width = rect.width + 'px';
  }

  function getOptions() {
    return [...dl.querySelectorAll('option')].map(o => ({ value: o.value, label: o.label || o.value }));
  }

  function render() {
    positionPanel();
    const q = input.value.trim().toLowerCase();
    const opts = getOptions().filter(o => !q || o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q));
    if (!opts.length) {
      panel.innerHTML = '<div class="ac-empty">无匹配字段</div>';
    } else {
      panel.innerHTML = opts.slice(0, 300).map(o => `
        <div class="ac-item" data-value="${escapeHtml(o.value)}">
          <div class="ac-item-title">${escapeHtml(o.value)}</div>
          ${o.label && o.label !== o.value ? `<div class="ac-item-desc">${escapeHtml(o.label)}</div>` : ''}
        </div>
      `).join('');
    }
    panel.classList.remove('hidden');
  }

  const onWindowScroll = () => { if (!panel.classList.contains('hidden')) positionPanel(); };
  const onWindowResize = () => { if (!panel.classList.contains('hidden')) positionPanel(); };
  window.addEventListener('scroll', onWindowScroll, true);
  window.addEventListener('resize', onWindowResize);
  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('blur', () => setTimeout(() => panel.classList.add('hidden'), 120));
  panel.addEventListener('mousedown', e => {
    const item = e.target.closest('.ac-item');
    if (!item) return;
    e.preventDefault();
    onSelect(item.dataset.value);
    panel.classList.add('hidden');
  });

  // 销毁句柄：宿主输入框被移除（如删除过滤条件行）时调用，
  // 避免挂在 body 上的面板和 window 监听器越积越多造成泄漏
  return {
    destroy() {
      window.removeEventListener('scroll', onWindowScroll, true);
      window.removeEventListener('resize', onWindowResize);
      panel.remove();
    }
  };
}

function fillDatalist(datalistId, options) {
  const dl = document.getElementById(datalistId);
  dl.innerHTML = '';
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt;
    o.label = getFieldDesc(opt) || opt;
    dl.appendChild(o);
  }
}

function getValidFieldInput(inputId) {
  const v = document.getElementById(inputId).value;
  return scatterOptions.includes(v) ? v : '';
}

function getValidColorField() {
  const v = document.getElementById('colorField').value;
  return colorOptions.includes(v) ? v : '';
}

// 是否已完成首次初始化：之后再刷新（如保存自定义字段后）保留用户当前的 Y/颜色/X 选择，
// 不再强制重置回默认值（之前的 bug：每次刷新都把用户选好的 Y/颜色改回默认）
let scatterSelectsInitialized = false;

function updateScatterSelects() {
  scatterOptions = ['returnCurrent', 'returnMax', ...allNumericKeys].filter(isNumericColumn);
  const defaultX = scatterOptions.includes('buyer_count_d1') ? 'buyer_count_d1' :
    scatterOptions.find(c => c !== 'returnCurrent' && c !== 'returnMax') || scatterOptions[0] || '';
  const defaultY = scatterOptions.includes('returnMax') ? 'returnMax' : scatterOptions[0] || '';
  fillDatalist('xFieldList', scatterOptions);
  fillDatalist('yFieldList', scatterOptions);
  const yInput = document.getElementById('yField');
  if (!scatterOptions.includes(yInput.value)) yInput.value = defaultY;
  batchXSelected = batchXSelected.filter(f => scatterOptions.includes(f));
  if (!batchXSelected.length && defaultX && !scatterSelectsInitialized) batchXSelected = [defaultX];
  renderBatchTags();
  renderAllDescTable();

  // 颜色可选：数值字段 + 少量分类字段；空 = 无颜色，也是合法选择
  colorOptions = [...scatterOptions, 'symbol', 'signalType', 'id'];
  fillDatalist('colorFieldList', colorOptions);
  const colorInput = document.getElementById('colorField');
  if (!scatterSelectsInitialized) {
    colorInput.value = colorOptions.includes('signalType') ? 'signalType' : '';
  } else if (colorInput.value && !colorOptions.includes(colorInput.value)) {
    colorInput.value = '';
  }
  scatterSelectsInitialized = true;

  updateFilterOptions();
  if (!document.querySelector('#filterRows .filter-row')) addFilterRow();

  const binFieldInput = document.getElementById('binField');
  const binValueFieldInput = document.getElementById('binValueField');
  if (!binFieldInput.value && scatterOptions.includes('returnMax')) binFieldInput.value = 'returnMax';
  if (!binValueFieldInput.value) {
    const guess = scatterOptions.find(f => /entrapment|holder_count|holder/i.test(f));
    if (guess) binValueFieldInput.value = guess;
  }

}

function updateFilterOptions() {
  const dl = document.getElementById('filterFieldList');
  if (!dl) return;
  dl.innerHTML = '';
  const allFields = [...ROW_LEVEL_FIELDS, ...scatterOptions, ...allCategoricalKeys];
  for (const f of allFields) {
    const o = document.createElement('option');
    o.value = f;
    o.label = getFieldDesc(f) || f;
    dl.appendChild(o);
  }
}

function isFilterableField(field) {
  return ROW_LEVEL_FIELDS.includes(field) || scatterOptions.includes(field) || allCategoricalKeys.includes(field);
}

function addFilterRow(field = '', op = '>=', threshold = '') {
  const container = document.getElementById('filterRows');
  const div = document.createElement('div');
  div.className = 'filter-row';
  div.innerHTML = `
    <span class="filter-field-wrap" style="position: relative; flex: 1 1 180px;">
      <input type="text" class="filter-field field-search" placeholder="字段，如 gmgn.price.price（从下拉联想中选择）" value="${escapeHtml(field)}" autocomplete="off" style="width: 100%; min-width: 0;">
    </span>
    <select class="filter-op">
      <option value="&gt;=" ${op === '>=' ? 'selected' : ''}>&gt;=</option>
      <option value="&lt;=" ${op === '<=' ? 'selected' : ''}>&lt;=</option>
      <option value="&gt;" ${op === '>' ? 'selected' : ''}>&gt;</option>
      <option value="&lt;" ${op === '<' ? 'selected' : ''}>&lt;</option>
      <option value="==" ${op === '==' ? 'selected' : ''}>==</option>
      <option value="!=" ${op === '!=' ? 'selected' : ''}>!=</option>
      <option value="contains" ${op === 'contains' ? 'selected' : ''}>包含</option>
      <option value="not_contains" ${op === 'not_contains' ? 'selected' : ''}>不包含</option>
    </select>
    <input type="text" class="filter-threshold" placeholder="阈值（数字或文本）" value="${escapeHtml(threshold)}">
    <button type="button" class="removeFilterRow">删除</button>
  `;
  container.appendChild(div);
  const fieldInput = div.querySelector('.filter-field');
  // 字段名必须与实际数据字段精确匹配才能生效；失焦时若无效则标红提示，防止手打拼错/漏前缀导致条件被静默忽略
  const validateField = () => {
    const v = fieldInput.value.trim();
    fieldInput.classList.toggle('invalid', !!v && !isFilterableField(v));
  };
  fieldInput.addEventListener('blur', () => setTimeout(validateField, 150));
  fieldInput.addEventListener('input', validateField);
  const ac = attachAutocomplete(fieldInput, fieldInput.parentElement, 'filterFieldList', v => {
    fieldInput.value = v;
    validateField();
  });
  // 删除行时同步销毁自动补全面板/监听器；_acDestroy 供 clearFilter 批量清理使用
  div._acDestroy = ac.destroy;
  div.querySelector('.removeFilterRow').addEventListener('click', () => { ac.destroy(); div.remove(); });
}

// 数据集（activeRows）变化后统一刷新下游视图：字段质量 / 相关性 / 总览 / 散点图
function refreshAnalysisViews() {
  renderFieldQuality();
  allCorrelations = computeCorrelations(activeRows);
  renderCorrTable();
  updateSummary();
  plot();
}

function applyFilter() {
  if (!matchedRows.length) { alert('请先点击“分析”加载数据'); return; }
  const rowEls = document.querySelectorAll('#filterRows .filter-row');
  const conditions = [];
  const invalidFields = [];
  const emptyThresholdFields = [];
  for (const row of rowEls) {
    const fieldInput = row.querySelector('.filter-field');
    const field = fieldInput.value.trim();
    const op = row.querySelector('.filter-op').value;
    const threshold = row.querySelector('.filter-threshold').value.trim();
    if (!field) continue; // 完全空行：忽略，不算错误
    if (!isFilterableField(field)) {
      fieldInput.classList.add('invalid');
      invalidFields.push(field);
      continue;
    }
    if (threshold === '') { emptyThresholdFields.push(field); continue; }
    conditions.push({ field, op, threshold });
  }
  if (invalidFields.length) {
    alert('以下字段名未匹配到数据中的实际字段，已被忽略（请从下拉联想中选择）：\n' + invalidFields.join('\n'));
  }
  if (emptyThresholdFields.length) {
    alert('以下字段的阈值为空，已被忽略：\n' + emptyThresholdFields.join('\n'));
  }
  if (!conditions.length) {
    // 没有有效条件：视为清除全局过滤，回到完整数据集
    activeRows = matchedRows;
    refreshAnalysisViews();
    if (!invalidFields.length && !emptyThresholdFields.length) {
      alert('未输入任何条件，已重置为全部数据');
    }
    return;
  }
  const results = matchedRows.filter(r => {
    for (const c of conditions) {
      const v = getFeature(r, c.field);
      if (v === undefined || v === null) return false;
      if (!compareGeneric(v, c.op, c.threshold)) return false;
    }
    return true;
  });
  // 将筛选结果作为全局过滤，同时驱动相关性/总览/散点图/分箱图重新计算
  activeRows = results;
  refreshAnalysisViews();

  const caText = results.map(r => r.tokenAddress).filter(Boolean).join('\n');
  const caTextarea = document.getElementById('filterCaText');
  caTextarea.value = caText;
  caTextarea.style.display = results.length ? 'block' : 'none';
  const avgReturn = results.length ? (results.reduce((a, b) => a + b.returnCurrent, 0) / results.length).toFixed(4) : '-';
  const usedConditionsNote = `已生效 ${conditions.length} 个条件`;
  document.getElementById('filterStats').innerHTML = `命中 <b>${results.length}</b> / ${matchedRows.length} 条，平均 returnCurrent = <b>${avgReturn}</b> &nbsp; <span style="color:var(--text-muted)">（${usedConditionsNote}，已同步应用于上方相关性/总览/散点图/分箱图）</span>`;
  document.getElementById('filterBody').innerHTML = results.map(r => `
    <tr>
      <td>${escapeHtml(r.symbol || '')}</td>
      <td>${escapeHtml(r.tokenAddress || '')}</td>
      <td class="num">${r.returnCurrent.toFixed(4)}x</td>
      <td class="num">${conditions.map(c => { const v = getFeature(r, c.field); return `${escapeHtml(c.field)}: ${escapeHtml(typeof v === 'number' ? formatNumberSmart(v) : v)}`; }).join('<br>')}</td>
    </tr>
  `).join('');
}

function copyFilterCAs() {
  const textarea = document.getElementById('filterCaText');
  const text = textarea.value;
  if (!text) { alert('没有可复制的 CA'); return; }
  navigator.clipboard.writeText(text).then(() => alert('已复制 CA 列表到剪贴板')).catch(err => alert('复制失败：' + err));
}

function clearFilter() {
  activeRows = matchedRows;
  if (matchedRows.length) refreshAnalysisViews();
  // 先销毁各行的自动补全面板，再清空 DOM，避免孤儿面板/监听器泄漏
  document.querySelectorAll('#filterRows .filter-row').forEach(r => { if (r._acDestroy) r._acDestroy(); });
  document.getElementById('filterRows').innerHTML = '';
  addFilterRow();
  document.getElementById('filterBody').innerHTML = '';
  document.getElementById('filterStats').innerHTML = '';
  const ta = document.getElementById('filterCaText');
  ta.value = '';
  ta.style.display = 'none';
}

// X 指标多选（标签式）：输入联想，选中/回车添加为标签，点 × 或退格删除；
// 每个选中的指标对应一张独立散点图，自上而下平铺
let batchXSelected = [];

function renderBatchTags() {
  const box = document.getElementById('batchXTagBox');
  const input = document.getElementById('batchXInput');
  box.querySelectorAll('.tag-chip').forEach(el => el.remove());
  for (const f of batchXSelected) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = f;
    label.title = f;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip-remove';
    btn.textContent = '×';
    btn.title = '删除';
    btn.addEventListener('click', () => {
      batchXSelected = batchXSelected.filter(x => x !== f);
      renderBatchTags();
      if (matchedRows.length) plot();
    });
    chip.appendChild(label);
    chip.appendChild(btn);
    box.insertBefore(chip, input);
  }
}

function tryAddBatchField() {
  const input = document.getElementById('batchXInput');
  const v = input.value.trim();
  if (!v) return false;
  if (!scatterOptions.includes(v)) return false;
  if (!batchXSelected.includes(v)) {
    batchXSelected.push(v);
    renderBatchTags();
    if (matchedRows.length) plot();
  }
  input.value = '';
  return true;
}

// 从任意粘贴的 JSON/对象片段（严格 JSON 的 "key": 、单引号 'key': 、不带引号的 JS 对象字面量 key: 都支持；
// 允许带 // 注释、末尾逗号、外层大括号不闭合）里提取所有形如 key: 的字段名，
// 再按名称（不要求带前缀）匹配到当前数据里真实存在的字段：field === key 或 field 以 ".key" 结尾。
// 这样用户可以直接从 GMGN 返回的原始 JSON 片段或 JS 代码里复制一段，不用逐个手打/搜索字段名。
//
// 注意：像 creator_token_balance 这种同名字段可能同时存在于多个路径下（比如 gmgn.dev.creator_token_balance
// 和 gmgn.stat.creator_token_balance），如果直接把所有命中都自动加入 X，会一次性画出两张看起来"重复"的图，
// 让人误以为是 bug。这里遇到多义匹配时不自动加入，单独列出候选路径，交给用户从联想框里手动选具体那一个。
function importXFieldsFromSnippet(text) {
  // 冒号后紧跟 // 的是 URL scheme（如 https://），不是字段名，用负向前瞻排除
  const keyRe = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:(?!\/\/)|'([A-Za-z_][A-Za-z0-9_]*)'\s*:(?!\/\/)|\b([A-Za-z_][A-Za-z0-9_]*)\b\s*:(?!\/\/)/g;
  const rawKeys = [...new Set([...text.matchAll(keyRe)].map(m => m[1] || m[2] || m[3]))];
  const matched = [];
  const unmatched = [];
  const ambiguous = []; // { key, candidates }
  for (const k of rawKeys) {
    const hits = scatterOptions.filter(f => f === k || f.endsWith('.' + k));
    if (hits.length === 1) matched.push(hits[0]);
    else if (hits.length > 1) ambiguous.push({ key: k, candidates: hits });
    else unmatched.push(k);
  }
  return { matched: [...new Set(matched)], unmatched, ambiguous };
}

function initBatchXImport() {
  const toggleBtn = document.getElementById('batchXImportToggle');
  const panel = document.getElementById('batchXImportPanel');
  const importBtn = document.getElementById('batchXImportBtn');
  const textEl = document.getElementById('batchXImportText');
  const resultEl = document.getElementById('batchXImportResult');
  toggleBtn.addEventListener('click', () => panel.classList.toggle('hidden'));
  importBtn.addEventListener('click', () => {
    if (!matchedRows.length) { alert('请先点击"分析"加载数据'); return; }
    const text = textEl.value.trim();
    if (!text) { alert('请先粘贴内容'); return; }
    const { matched, unmatched, ambiguous } = importXFieldsFromSnippet(text);
    const yField = getValidFieldInput('yField');
    const added = [];
    for (const f of matched) {
      if (f === yField || batchXSelected.includes(f)) continue;
      batchXSelected.push(f);
      added.push(f);
    }
    renderBatchTags();
    if (matchedRows.length) plot();
    let msg = `匹配到 ${matched.length} 个已有字段，新增 ${added.length} 个到 X`;
    if (unmatched.length) msg += `；未匹配到（数据里没有对应字段）：${unmatched.join('、')}`;
    if (ambiguous.length) {
      msg += `；以下字段名对应多个路径，未自动添加，请从 X 输入框联想中手动选择具体那个：` +
        ambiguous.map(a => `${a.key}（${a.candidates.join(' / ')}）`).join('；');
    }
    resultEl.textContent = msg;
  });
}

function initBatchTagInput() {
  const input = document.getElementById('batchXInput');
  // 从 datalist 联想中选中（input 事件里值与选项完全匹配）时立即添加
  input.addEventListener('input', () => {
    const v = input.value.trim();
    if (v && scatterOptions.includes(v)) tryAddBatchField();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      tryAddBatchField();
    } else if (e.key === 'Backspace' && !input.value && batchXSelected.length) {
      batchXSelected.pop();
      renderBatchTags();
      if (matchedRows.length) plot();
    }
  });
  // 点击容器空白处聚焦输入框
  document.getElementById('batchXTagBox').addEventListener('click', e => {
    if (e.target.id === 'batchXTagBox') input.focus();
  });
  attachAutocomplete(input, document.getElementById('batchXTagBox'), 'xFieldList', v => {
    input.value = v;
    tryAddBatchField();
    input.focus();
  });
}

function plotFromButton() {
  if (!matchedRows.length) { alert('请先点击"分析"加载数据'); return; }
  tryAddBatchField(); // 输入框里若残留有效字段，先补加进去
  if (!batchXSelected.length) {
    alert('请先添加至少一个 X 指标（输入字段名联想后选中即可添加）');
    return;
  }
  plot();
}

function downloadCsv() {
  if (!matchedRows.length) return;
  const featureKeys = [...new Set(matchedRows.flatMap(r => Object.keys(r.features)))].sort();
  const cols = ['id','symbol','tokenAddress','signalType','initialMcap','currentMcap','maxMcap','returnCurrent','returnMax', ...featureKeys];
  const lines = [cols.map(csvEscape).join(',')];
  for (const r of matchedRows) {
    const row = cols.map(c => {
      if (c === 'id') return r.id;
      if (c === 'symbol') return r.symbol;
      if (c === 'tokenAddress') return r.tokenAddress;
      if (c === 'signalType') return r.signalType;
      if (['initialMcap','currentMcap','maxMcap','returnCurrent','returnMax'].includes(c)) return r[c];
      return r.features[c] === undefined || r.features[c] === null ? '' : r.features[c];
    });
    lines.push(row.map(csvEscape).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'returns_features.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function analyze() {
  const callsFile = document.getElementById('callsFile').files[0];
  const snapsFile = document.getElementById('snapsFile').files[0];
  if (!callsFile || !snapsFile) {
    alert('请先选择 calls 和 snapshots JSON 文件');
    return;
  }
  const btn = document.getElementById('analyzeBtn');
  btn.disabled = true; btn.textContent = '分析中...';
  try {
    const [calls, snapshots] = await Promise.all([readJson(callsFile), readJson(snapsFile)]);
    matchedRows = buildRows(calls, snapshots);
    const skipped = buildRows.lastSkippedByTimeDiff || 0;
    if (!matchedRows.length) {
      alert('未匹配到有效样本，请检查两个 JSON 是否对应。' + (skipped ? `（另有 ${skipped} 条因 call 与最近快照时间差超过阈值被跳过）` : ''));
      return;
    }
    activeRows = matchedRows;
    // 先计算用户自定义组装字段，让它们和内置字段一样进入候选列表/相关性/图表
    applyCustomFields(matchedRows);
    // 组装字段（DERIVED_KEYS + 自定义字段）始终加入候选列表，即使当前数据集里没有任何一行真正算出该值
    // （比如分母恰好都是 0/字段缺失），也不应该从联想框里"消失"，否则用户会误以为字段没加成功
    allNumericKeys = [...new Set([...matchedRows.flatMap(r => Object.keys(r.features)), ...DERIVED_KEYS, ...customFields.map(c => c.name)])].sort();

    // 分类字段：只保留在当前数据集中"看起来像分类"的字段（去重值数量 2~50 之间）——
    // 去重值 1 个说明是常量没有分组意义，去重值过多（比如误把接近唯一的字符串当分类字段）会让下拉列表和分组表格失去可读性
    const catValueSets = new Map();
    for (const r of matchedRows) {
      if (!r.categorical) continue;
      for (const [k, v] of Object.entries(r.categorical)) {
        if (!catValueSets.has(k)) catValueSets.set(k, new Set());
        catValueSets.get(k).add(v);
      }
    }
    allCategoricalKeys = [...catValueSets.entries()]
      .filter(([, set]) => set.size >= 2 && set.size <= 50)
      .map(([k]) => k)
      .sort();

    document.getElementById('filterPanel').classList.remove('hidden');
    document.getElementById('summaryPanel').classList.remove('hidden');
    document.getElementById('corrPanel').classList.remove('hidden');
    document.getElementById('customFieldPanel').classList.remove('hidden');
    document.getElementById('scatterPanel').classList.remove('hidden');
    document.getElementById('proPanel').classList.remove('hidden');
    document.getElementById('downloadWrap').classList.remove('hidden');
    document.getElementById('fileHint').textContent = `已分析完成：匹配 ${matchedRows.length} 条样本。` + (skipped ? ` 另有 ${skipped} 条因 call 与最近快照时间差超过 ${MAX_SNAPSHOT_MATCH_DIFF_SECONDS} 秒被跳过（未纳入分析）。` : '');

    updateScatterSelects();
    renderCustomFieldList();
    refreshAnalysisViews();
  } catch (err) {
    alert('解析失败：' + err.message);
    console.error(err);
  } finally {
    btn.disabled = false; btn.textContent = '分析';
  }
}

document.getElementById('analyzeBtn').addEventListener('click', analyze);
document.getElementById('plotBtn').addEventListener('click', plotFromButton);
document.getElementById('globalSwapBtn').addEventListener('click', e => {
  defaultSwapped = !defaultSwapped;
  // 已存在的图表设置也同步切换，避免当前图还是旧状态
  for (const opt of chartSettings.values()) opt.swapped = defaultSwapped;
  e.currentTarget.classList.toggle('active', defaultSwapped);
  e.currentTarget.title = defaultSwapped
    ? '开启时：X轴=returnMax，Y轴=上面选择的指标；关闭时恢复默认'
    : '关闭时：X轴=上面选择的指标，Y轴=returnMax';
  if (matchedRows.length) plot();
});
document.getElementById('yField').addEventListener('input', updateCurrentFieldDesc);
document.getElementById('yField').addEventListener('change', () => { if (matchedRows.length) plot(); });
document.getElementById('colorField').addEventListener('change', () => { if (matchedRows.length) plot(); });
document.getElementById('genBinBarBtn').addEventListener('click', renderBinBarChart);
initBatchTagInput();
initBatchXImport();
initCustomFieldPanel();
document.getElementById('batchXClearBtn').addEventListener('click', () => {
  batchXSelected = [];
  renderBatchTags();
  if (matchedRows.length) plot();
});
attachAutocomplete(document.getElementById('yField'), document.getElementById('yField'), 'yFieldList', v => {
  document.getElementById('yField').value = v;
  updateCurrentFieldDesc();
  if (matchedRows.length) plot();
});
attachAutocomplete(document.getElementById('colorField'), document.getElementById('colorField'), 'colorFieldList', v => {
  document.getElementById('colorField').value = v;
  if (matchedRows.length) plot();
});
attachAutocomplete(document.getElementById('binField'), document.getElementById('binField'), 'xFieldList', v => {
  document.getElementById('binField').value = v;
});
attachAutocomplete(document.getElementById('binValueField'), document.getElementById('binValueField'), 'yFieldList', v => {
  document.getElementById('binValueField').value = v;
});

// 查找 CA：支持多个（逗号/空格/换行分隔），命中的数据点在所有散点图里高亮显示
function updateHighlightCAs() {
  const raw = document.getElementById('searchCaInput').value;
  highlightCAs = new Set(raw.split(/[\s,，、;；]+/).map(s => s.trim().toLowerCase()).filter(Boolean));
}
let searchCaDebounceTimer = null;
document.getElementById('searchCaInput').addEventListener('input', () => {
  clearTimeout(searchCaDebounceTimer);
  searchCaDebounceTimer = setTimeout(() => {
    updateHighlightCAs();
    if (matchedRows.length) plot();
  }, 300);
});
document.getElementById('corrTarget').addEventListener('change', renderCorrTable);
document.getElementById('corrSource').addEventListener('change', renderCorrTable);
document.getElementById('topN').addEventListener('change', renderCorrTable);
document.getElementById('corrCorrection').addEventListener('change', renderCorrTable);
document.getElementById('corrSortBy').addEventListener('change', renderCorrTable);
document.getElementById('oosEnabled').addEventListener('change', renderCorrTable);
document.getElementById('oosSplitMethod').addEventListener('change', renderCorrTable);
document.getElementById('oosTrainRatio').addEventListener('change', renderCorrTable);
document.getElementById('downloadCsvBtn').addEventListener('click', downloadCsv);
document.getElementById('addFilterRow').addEventListener('click', () => addFilterRow());
document.getElementById('applyFilter').addEventListener('click', applyFilter);
document.getElementById('copyFilterCAs').addEventListener('click', copyFilterCAs);
document.getElementById('clearFilter').addEventListener('click', clearFilter);
addFilterRow();
document.getElementById('fieldQualityOnlyIssues').addEventListener('change', renderFieldQuality);

// 折叠/展开：点击任意 .panel-header-row 切换其 data-target 对应的 .panel-body 显隐
document.querySelectorAll('.panel-header-row[data-target]').forEach(header => {
  header.addEventListener('click', () => {
    const body = document.getElementById(header.dataset.target);
    const toggle = header.querySelector('.collapse-toggle');
    if (!body) return;
    body.classList.toggle('hidden');
    if (toggle) toggle.classList.toggle('collapsed');
  });
});

// 深色/浅色主题切换：持久化到 localStorage，并重绘已存在的 Plotly 图表（散点图 + 分箱柱状图）以应用新配色
function updateThemeToggleBtn() {
  const btn = document.getElementById('themeToggleBtn');
  if (!btn) return;
  btn.textContent = isLightTheme() ? '🌙 深色' : '☀️ 浅色';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('chartTheme', theme); } catch (e) {}
  updateThemeToggleBtn();
  if (matchedRows.length) {
    plot();
    if (document.getElementById('binBarChart').querySelector('.plotly')) {
      try { renderBinBarChart(); } catch (e) {}
    }
  }
}
document.getElementById('themeToggleBtn').addEventListener('click', () => {
  applyTheme(isLightTheme() ? 'dark' : 'light');
});
updateThemeToggleBtn();
