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
const bootstrapCIMap = new Map(); // `${target}|${feature}` -> { lo, hi, n }；activeRows 变化时清空，避免用旧数据集的区间误导
let bootstrapRunning = false;
let bootstrapCancelFlag = false;

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
    + '<th class="num">Spearman ρ</th><th class="num">|Δ|</th><th class="num">n</th><th class="num">p</th><th class="num">校正后 p</th><th>r 的 95% CI</th><th>操作</th>';

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
    // Bootstrap 置信区间：跨零（lo<0<hi）说明"该字段与收益实际无关"的可能性不能排除，点估计值可能只是运气
    const ci = bootstrapCIMap.get(`${c.target}|${c.feature}`);
    let ciCell = '<td>-</td>';
    if (ci) {
      const crossesZero = Number.isFinite(ci.lo) && Number.isFinite(ci.hi) && ci.lo < 0 && ci.hi > 0;
      const smallN = ci.n < 20;
      const style = crossesZero ? ' style="color:#ff453a; font-weight:600;"' : '';
      const title = crossesZero
        ? '置信区间跨零，不能排除该字段与收益实际无关的可能，点估计值可能只是运气'
        : (smallN ? '样本量过小，置信区间估计本身可信度有限，仅供参考' : '');
      ciCell = `<td${style}${title ? ` title="${escapeHtml(title)}"` : ''}>${Number.isFinite(ci.lo) && Number.isFinite(ci.hi) ? `[${ci.lo.toFixed(2)}, ${ci.hi.toFixed(2)}]` : '-'}${crossesZero ? ' ⚠️' : ''}${smallN ? ' 🔸' : ''}</td>`;
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
      ${ciCell}
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

// 异常值/数据质量报警（design doc §6.2）：内置一组硬编码规则，命中不代表数据一定是错的
// （也可能是极端但真实的市场情况），文案用"可能存在问题"而不是"错误"。
function computeQualityAlerts(rows) {
  const alerts = [];
  for (const r of rows) {
    const reasons = [];
    const rc = r.returnCurrent, rm = r.returnMax;
    if (Number.isFinite(rc) && rc <= 0) reasons.push(`returnCurrent(${rc.toFixed(2)}x) ≤ 0，收益倍数理论上应该 > 0`);
    if (Number.isFinite(rm) && rm <= 0) reasons.push(`returnMax(${rm.toFixed(2)}x) ≤ 0，收益倍数理论上应该 > 0`);
    if (Number.isFinite(rc) && Number.isFinite(rm) && rm < rc) {
      reasons.push(`returnMax(${rm.toFixed(2)}x) 小于 returnCurrent(${rc.toFixed(2)}x)，逻辑矛盾（期间最大值不应小于当前值）`);
    }
    // m5 窗口买卖金额量级异常：design doc §20.1 发现的真实数据笔误案例（少写小数点导致量级相差几个数量级）
    const buyM5 = getFeature(r, 'buy_wcoin_amount_m5'), sellM5 = getFeature(r, 'sell_wcoin_amount_m5');
    if (isFiniteNumber(buyM5) && isFiniteNumber(sellM5) && buyM5 > 0 && sellM5 > 0) {
      const ratio = Math.max(buyM5, sellM5) / Math.min(buyM5, sellM5);
      if (ratio > 1000) reasons.push(`buy_wcoin_amount_m5(${buyM5}) 与 sell_wcoin_amount_m5(${sellM5}) 量级相差 ${ratio.toFixed(0)} 倍，疑似小数点错误`);
    }
    // 筹码上下占比之和应接近100%，明显偏离说明分类没有穷尽或有计算误差（design doc §20.5）
    const above = getFeature(r, 'chip_analysis.above_percent'), below = getFeature(r, 'chip_analysis.below_percent');
    if (isFiniteNumber(above) && isFiniteNumber(below)) {
      const sum = above + below;
      if (Math.abs(sum - 100) > 15) reasons.push(`chip_analysis.above_percent + below_percent = ${sum.toFixed(1)}%，明显偏离 100%`);
    }
    for (const field of ['pool_liquidity', 'buyer_count_d1', 'seller_count_d1']) {
      const v = getFeature(r, field);
      if (isFiniteNumber(v) && v < 0) reasons.push(`${field}(${v}) 为负数，该字段语义上不应为负`);
    }
    if (reasons.length) alerts.push({ row: r, reasons });
  }
  return alerts;
}

function renderQualityAlerts() {
  const panel = document.getElementById('qualityAlertPanel');
  const titleEl = document.getElementById('qualityAlertTitle');
  const tbody = document.getElementById('qualityAlertBody');
  const excludeBtn = document.getElementById('excludeQualityAlertsBtn');
  if (!panel) return;
  if (!activeRows.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const alerts = computeQualityAlerts(activeRows);
  titleEl.textContent = alerts.length ? `⚠️ 异常值 / 数据质量报警（发现 ${alerts.length} 条可能存在数据问题的记录）` : '异常值 / 数据质量报警（未发现问题）';
  excludeBtn.classList.toggle('hidden', alerts.length === 0);
  tbody.innerHTML = alerts.map(a => `
    <tr>
      <td>${escapeHtml(a.row.symbol || '-')}</td>
      <td class="ellip" title="${escapeHtml(a.row.tokenAddress || '')}">${escapeHtml(a.row.tokenAddress || '-')}</td>
      <td>${a.reasons.map(r => escapeHtml(r)).join('<br>')}</td>
    </tr>
  `).join('') || '<tr><td colspan="3" style="text-align:center; color:var(--text-muted);">未发现可能存在问题的记录</td></tr>';

  excludeBtn.onclick = () => {
    const flaggedIds = new Set(alerts.map(a => a.row.id));
    if (!flaggedIds.size) return;
    if (!confirm(`确定要从当前工作集中排除这 ${flaggedIds.size} 条记录吗？（不会修改原始文件，只影响当前分析）`)) return;
    activeRows = activeRows.filter(r => !flaggedIds.has(r.id));
    refreshAnalysisViews();
  };
}

// Bootstrap 置信区间：只对当前表格里可见的字段计算（而不是全部字段），把计算量控制在用户实际关心的范围内；
// 分批 yield 主线程（复用 14.3 的分批处理思路），避免大量重抽样计算卡住页面；支持随时取消。
async function runBootstrapCI() {
  if (!activeRows.length) { alert('请先点击"分析"加载数据'); return; }
  if (bootstrapRunning) return;

  const target = document.getElementById('corrTarget').value;
  const source = document.getElementById('corrSource').value;
  const top = Number(document.getElementById('topN').value);
  const B = Math.max(100, Math.min(2000, Number(document.getElementById('bootstrapResamples').value) || 500));

  const fullSet = allCorrelations.filter(c => (target === 'all' || c.target === target) && (source === 'all' || c.source === source));
  fullSet.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  const targets = fullSet.slice(0, top);
  if (!targets.length) { alert('当前表格没有可计算的字段'); return; }

  bootstrapRunning = true;
  bootstrapCancelFlag = false;
  const btn = document.getElementById('computeBootstrapCIBtn');
  const cancelBtn = document.getElementById('cancelBootstrapCIBtn');
  const progressEl = document.getElementById('bootstrapProgress');
  btn.disabled = true;
  cancelBtn.classList.remove('hidden');
  progressEl.classList.remove('hidden');

  const CHUNK_SIZE = 3; // 每处理 3 个字段就让出一次主线程，兼顾响应性和总耗时
  for (let i = 0; i < targets.length; i++) {
    if (bootstrapCancelFlag) { progressEl.textContent = `已取消（完成 ${i}/${targets.length}）`; break; }
    const c = targets[i];
    const pairs = [];
    for (const row of activeRows) {
      const xv = getFeature(row, c.feature), yv = getFeature(row, c.target);
      if (isFiniteNumber(xv) && isFiniteNumber(yv)) pairs.push([xv, yv]);
    }
    const n = pairs.length;
    const { lo, hi } = n >= 2 ? bootstrapPearsonCI(pairs, B) : { lo: NaN, hi: NaN };
    bootstrapCIMap.set(`${c.target}|${c.feature}`, { lo, hi, n });

    if (i % CHUNK_SIZE === CHUNK_SIZE - 1 || i === targets.length - 1) {
      progressEl.textContent = `正在计算置信区间 ${i + 1} / ${targets.length}（${Math.round(((i + 1) / targets.length) * 100)}%）...`;
      renderCorrTable();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  bootstrapRunning = false;
  btn.disabled = false;
  cancelBtn.classList.add('hidden');
  if (!bootstrapCancelFlag) progressEl.textContent = `已完成 ${targets.length} 个字段的置信区间计算（重抽样 ${B} 次）。`;
  renderCorrTable();
}

// 数组字段覆盖率（design doc §20.0）：holders/kline_bars/各类 _list 事件数组不会展开进数值特征体系，
// 单独统计"哪些数组字段在当前数据集里非空覆盖率是多少、平均有几条元素"，方便用户决定值得花力气聚合哪个字段。
function renderArrayFieldQuality() {
  const wrap = document.getElementById('arrayFieldQualityWrap');
  const tbody = document.getElementById('arrayFieldQualityBody');
  if (!wrap || !tbody) return;
  const arrayKeys = new Set();
  activeRows.forEach(r => { if (r.arrays) Object.keys(r.arrays).forEach(k => arrayKeys.add(k)); });
  if (!arrayKeys.size) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const total = activeRows.length;
  const rowsData = [...arrayKeys].map(k => {
    let nonEmpty = 0, lenSum = 0;
    for (const r of activeRows) {
      const arr = r.arrays && r.arrays[k];
      if (Array.isArray(arr) && arr.length) { nonEmpty++; lenSum += arr.length; }
    }
    return { field: k, coverage: nonEmpty / total, avgLen: nonEmpty ? lenSum / nonEmpty : 0 };
  }).sort((a, b) => b.coverage - a.coverage);
  tbody.innerHTML = rowsData.map(r => `
    <tr>
      <td class="ellip" title="row.arrays.${escapeHtml(r.field)}">${escapeHtml(r.field)}</td>
      <td>${(r.coverage * 100).toFixed(1)}%</td>
      <td class="num">${r.avgLen.toFixed(1)}</td>
    </tr>
  `).join('');
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

  renderArrayFieldQuality();

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
  renderQualityAlerts();
  refreshSimilarBaseOptions();
  renderDistribution();
  bootstrapCIMap.clear();
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

// CSV 导出跟随当前工作集（design doc §15.3）：之前导出的是全量 matchedRows，忽略了顶部"全局条件过滤"，
// 用户过滤掉的记录依然会被导出，容易造成"导出的数据和界面上看到的分析结果不一致"的误解，改成导出 activeRows。
// 同时列集合显式并入 customFields 的字段名，避免某个自定义字段对所有行都算不出值（比如公式依赖的原始字段
// 在这批数据里全部缺失）时，因为 flatMap 扫不到任何一行有这个 key 而整列从 CSV 里消失、用户却毫无察觉。
function downloadCsv() {
  if (!activeRows.length) { alert('当前没有数据可导出（请检查过滤条件或先点击"分析"）'); return; }
  const featureKeys = [...new Set([
    ...activeRows.flatMap(r => Object.keys(r.features)),
    ...customFields.map(c => c.name),
  ])].sort();
  const categoricalKeys = [...new Set(activeRows.flatMap(r => Object.keys(r.categorical || {})))].sort();
  const cols = ['id','symbol','tokenAddress','signalType','initialMcap','currentMcap','maxMcap','returnCurrent','returnMax', ...featureKeys, ...categoricalKeys];
  const lines = [cols.map(csvEscape).join(',')];
  for (const r of activeRows) {
    const row = cols.map(c => {
      if (c === 'id') return r.id;
      if (c === 'symbol') return r.symbol;
      if (c === 'tokenAddress') return r.tokenAddress;
      if (c === 'signalType') return r.signalType;
      if (['initialMcap','currentMcap','maxMcap','returnCurrent','returnMax'].includes(c)) return r[c];
      if (categoricalKeys.includes(c)) return r.categorical && r.categorical[c] !== undefined ? r.categorical[c] : '';
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

// 将 matchedRows 定型后的公共收尾工作（重新计算候选字段列表/展开面板/刷新下游视图），
// 被 analyze()（整体替换）和 appendData()（追加合并，§14.1）共享，避免两处都写一份容易漏同步。
function finalizeMatchedRows() {
  activeRows = matchedRows;
  applyCustomFields(matchedRows);
  allNumericKeys = [...new Set([...matchedRows.flatMap(r => Object.keys(r.features)), ...DERIVED_KEYS, ...customFields.map(c => c.name)])].sort();

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
  document.getElementById('appendWrap').classList.remove('hidden');
  document.getElementById('appendOptionsRow').classList.remove('hidden');

  updateScatterSelects();
  renderCustomFieldList();
  refreshAnalysisViews();
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
    // 大数据量时分批处理并汇报进度（design doc §14.3），避免上万条 calls 同步循环卡死页面没反应
    matchedRows = await buildRows(calls, snapshots, (done, total) => {
      btn.textContent = `分析中... ${done}/${total}`;
      document.getElementById('fileHint').textContent = `正在匹配数据... ${done}/${total}`;
    });
    const skipped = buildRows.lastSkippedByTimeDiff || 0;
    if (!matchedRows.length) {
      alert('未匹配到有效样本，请检查两个 JSON 是否对应。' + (skipped ? `（另有 ${skipped} 条因 call 与最近快照时间差超过阈值被跳过）` : ''));
      return;
    }
    finalizeMatchedRows();
    document.getElementById('fileHint').textContent = `已分析完成：匹配 ${matchedRows.length} 条样本。` + (skipped ? ` 另有 ${skipped} 条因 call 与最近快照时间差超过 ${MAX_SNAPSHOT_MATCH_DIFF_SECONDS} 秒被跳过（未纳入分析）。` : '');
  } catch (err) {
    alert('解析失败：' + err.message);
    console.error(err);
  } finally {
    btn.disabled = false; btn.textContent = '分析';
  }
}

// 追加数据（design doc §14.1）：把新选择的 calls/snapshots 合并进当前 matchedRows，而不是整体替换。
// 按 token_address + swap_begin_time（与 buildRows 里的 callKey 同样的 key）去重，默认保留后导入的版本（因为
// 后导入的通常是更新的数据），勾选"保留先导入的版本"时反过来。
async function appendData() {
  const callsFile = document.getElementById('callsFile').files[0];
  const snapsFile = document.getElementById('snapsFile').files[0];
  if (!callsFile || !snapsFile) { alert('请在上方重新选择要追加的 calls 和 snapshots JSON 文件'); return; }
  if (!matchedRows.length) { alert('请先点击"分析"加载初始数据，再用这个按钮追加后续批次'); return; }
  const btn = document.getElementById('appendDataBtn');
  const keepFirst = document.getElementById('appendKeepFirst').checked;
  btn.disabled = true; btn.textContent = '追加中...';
  try {
    const [calls, snapshots] = await Promise.all([readJson(callsFile), readJson(snapsFile)]);
    const newRows = await buildRows(calls, snapshots, (done, total) => {
      btn.textContent = `追加中... ${done}/${total}`;
    });
    if (!newRows.length) { alert('新文件里未匹配到有效样本，未发生合并'); return; }

    const keyOf = r => `${r.tokenAddress || ''}_${r.swapBeginTime || ''}`;
    const existingByKey = new Map(matchedRows.map(r => [keyOf(r), r]));
    let addedCount = 0, overwrittenCount = 0;
    for (const nr of newRows) {
      const k = keyOf(nr);
      if (existingByKey.has(k)) {
        if (!keepFirst) existingByKey.set(k, nr); // 默认用新导入的覆盖，勾选保留先导入则不替换
        overwrittenCount++;
      } else {
        existingByKey.set(k, nr);
        addedCount++;
      }
    }
    matchedRows = [...existingByKey.values()];
    finalizeMatchedRows();
    document.getElementById('fileHint').textContent = `追加完成：新增 ${addedCount} 条，去重重复 ${overwrittenCount} 条（${keepFirst ? '已保留先导入的版本' : '已用新导入的版本覆盖'}），当前工作集共 ${matchedRows.length} 条。`;
  } catch (err) {
    alert('追加失败：' + err.message);
    console.error(err);
  } finally {
    btn.disabled = false; btn.textContent = '追加数据';
  }
}

document.getElementById('analyzeBtn').addEventListener('click', analyze);
document.getElementById('appendDataBtn').addEventListener('click', appendData);
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
document.getElementById('binRecommendBtn').addEventListener('click', () => {
  if (!activeRows.length) { alert('请先点击"分析"加载数据'); return; }
  const field = document.getElementById('binField').value.trim();
  const hintEl = document.getElementById('binRecommendHint');
  if (!field) { hintEl.textContent = '请先填写分箱字段'; return; }
  const target = document.getElementById('binRecommendTarget').value;
  const result = recommendBreakpoints(field, target);
  if (result.error) { hintEl.textContent = '⚠️ ' + result.error; return; }
  document.getElementById('binBreakpoints').value = result.breakpoints.map(v => formatNumberSmart(v)).join(',');
  hintEl.textContent = `基于当前数值字段与 ${target} 的区分度自动计算（已回填到断点输入框，可直接使用或手动微调）`;
});
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
document.getElementById('distTargetField').addEventListener('change', renderDistribution);
document.getElementById('distLogX').addEventListener('change', renderDistribution);
document.getElementById('distBinCount').addEventListener('change', renderDistribution);
document.getElementById('computeBootstrapCIBtn').addEventListener('click', runBootstrapCI);
document.getElementById('cancelBootstrapCIBtn').addEventListener('click', () => { bootstrapCancelFlag = true; });
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

// ========== 分析快照保存 / 对比（design doc §10.1） ==========
// 存的是"分析结果摘要"（过滤条件 + 总览统计 + 相关性 Top N），不是全量原始数据，避免存储爆炸；
// 用于跨批次对比"这批新数据跑完之后，相关性和上一批比是变强了还是变弱了"。
const ANALYSIS_SNAPSHOTS_STORAGE_KEY = 'chart_analysis_snapshots';
let analysisSnapshots = [];
const SNAPSHOT_TOP_N = 30; // 每个 target 存 Top N 个相关性结果，覆盖对比时的常见关注范围，避免整份存储过大

function loadAnalysisSnapshots() {
  try {
    const raw = localStorage.getItem(ANALYSIS_SNAPSHOTS_STORAGE_KEY);
    if (raw) analysisSnapshots = JSON.parse(raw) || [];
  } catch (e) { analysisSnapshots = []; }
}
function saveAnalysisSnapshotsToStorage() {
  try { localStorage.setItem(ANALYSIS_SNAPSHOTS_STORAGE_KEY, JSON.stringify(analysisSnapshots)); } catch (e) {}
}

// 把当前 #filterRows 里的有效条件行序列化成一句人类可读的描述，跟保存的快照一起存，方便事后回顾"当时用的过滤条件是什么"
function describeCurrentFilter() {
  const parts = [];
  document.querySelectorAll('#filterRows .filter-row').forEach(row => {
    const field = row.querySelector('.filter-field').value.trim();
    const op = row.querySelector('.filter-op').value;
    const threshold = row.querySelector('.filter-threshold').value.trim();
    if (field && threshold !== '') parts.push(`${field} ${op} ${threshold}`);
  });
  return parts.length ? parts.join(' AND ') : '（无过滤条件，全量数据）';
}

function saveCurrentSnapshot() {
  if (!activeRows.length) { alert('请先点击"分析"加载数据'); return; }
  const label = document.getElementById('snapshotLabelInput').value.trim() || `快照 ${analysisSnapshots.length + 1}`;
  const cur = activeRows.map(r => r.returnCurrent);
  const mx = activeRows.map(r => r.returnMax);
  const cs = calcStats(cur, 1);
  const ms = calcStats(mx, 1);
  const topByTarget = target => allCorrelations
    .filter(c => c.target === target)
    .slice()
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r))
    .slice(0, SNAPSHOT_TOP_N)
    .map(c => ({ feature: c.feature, r: c.r, n: c.n }));
  const snapshot = {
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    label,
    savedAt: new Date().toISOString(),
    n: activeRows.length,
    filterDesc: describeCurrentFilter(),
    summary: { meanCurrent: cs.mean, winRate: cs.winRate, meanMax: ms.mean, maxMax: ms.max },
    topCorr: { returnCurrent: topByTarget('returnCurrent'), returnMax: topByTarget('returnMax') },
  };
  analysisSnapshots.push(snapshot);
  saveAnalysisSnapshotsToStorage();
  document.getElementById('snapshotLabelInput').value = '';
  renderSnapshotList();
}

function deleteSnapshot(id) {
  if (!confirm('确定删除这份快照？')) return;
  analysisSnapshots = analysisSnapshots.filter(s => s.id !== id);
  saveAnalysisSnapshotsToStorage();
  renderSnapshotList();
}

function renderSnapshotList() {
  const tbody = document.getElementById('snapshotListBody');
  if (!analysisSnapshots.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">还没有保存的快照</td></tr>';
    return;
  }
  tbody.innerHTML = analysisSnapshots.slice().reverse().map(s => `
    <tr>
      <td><input type="checkbox" class="snapshot-checkbox" data-id="${s.id}"></td>
      <td>${escapeHtml(s.label)}</td>
      <td>${new Date(s.savedAt).toLocaleString()}</td>
      <td class="num">${s.n}</td>
      <td><button type="button" class="secondary snapshot-del" data-id="${s.id}">删除</button></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('.snapshot-del').forEach(btn => btn.addEventListener('click', () => deleteSnapshot(btn.dataset.id)));
  tbody.querySelectorAll('.snapshot-checkbox').forEach(cb => cb.addEventListener('change', () => {
    // 限制最多勾选 2 份：勾选第 3 个时自动取消最早勾选的那个，避免用户困惑"为什么勾不上"
    const checked = [...tbody.querySelectorAll('.snapshot-checkbox:checked')];
    if (checked.length > 2) checked[0].checked = false;
  }));
}

function compareSelectedSnapshots() {
  const hintEl = document.getElementById('snapshotCompareHint');
  const wrap = document.getElementById('snapshotCompareWrap');
  const checked = [...document.querySelectorAll('.snapshot-checkbox:checked')].map(cb => cb.dataset.id);
  if (checked.length !== 2) { hintEl.textContent = '请勾选恰好 2 份快照后再对比'; wrap.classList.add('hidden'); return; }
  const [a, b] = checked.map(id => analysisSnapshots.find(s => s.id === id));
  if (!a || !b) return;
  hintEl.textContent = `对比：「${a.label}」(${a.n}条, ${a.filterDesc}) vs 「${b.label}」(${b.n}条, ${b.filterDesc})`;
  wrap.classList.remove('hidden');

  // 两份快照可能是不同 target（returnCurrent/returnMax）或字段结构不完全一致（比如数据结构升级新增字段），
  // 用 Map 按字段名对齐，缺失的一侧显示"该快照中不存在此字段"而不是报错或留空造成误解
  const mapA = new Map(), mapB = new Map();
  ['returnCurrent', 'returnMax'].forEach(t => {
    (a.topCorr[t] || []).forEach(c => mapA.set(`${t}|${c.feature}`, c.r));
    (b.topCorr[t] || []).forEach(c => mapB.set(`${t}|${c.feature}`, c.r));
  });
  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);
  const rows = [...allKeys].map(key => {
    const [target, feature] = key.split('|');
    const rA = mapA.has(key) ? mapA.get(key) : null;
    const rB = mapB.has(key) ? mapB.get(key) : null;
    const delta = (rA !== null && rB !== null) ? Math.abs(rA - rB) : NaN;
    return { target, feature, rA, rB, delta };
  });
  rows.sort((x, y) => (Number.isFinite(y.delta) ? y.delta : -1) - (Number.isFinite(x.delta) ? x.delta : -1));

  document.getElementById('snapshotCompareBody').innerHTML = rows.map(r => {
    const highlight = Number.isFinite(r.delta) && r.delta >= 0.15;
    return `
    <tr${highlight ? ' style="background: rgba(255,159,10,0.12);"' : ''}>
      <td>${escapeHtml(r.feature)} <span style="color:var(--text-muted)">(${escapeHtml(r.target)})</span></td>
      <td class="num">${r.rA !== null ? r.rA.toFixed(4) : '<span style="color:var(--text-muted)">该快照中不存在此字段</span>'}</td>
      <td class="num">${r.rB !== null ? r.rB.toFixed(4) : '<span style="color:var(--text-muted)">该快照中不存在此字段</span>'}</td>
      <td class="num">${Number.isFinite(r.delta) ? r.delta.toFixed(4) : '-'}</td>
    </tr>`;
  }).join('');
}

document.getElementById('snapshotToggleBtn').addEventListener('click', () => {
  document.getElementById('snapshotPanel').classList.toggle('hidden');
});
document.getElementById('saveSnapshotBtn').addEventListener('click', saveCurrentSnapshot);
document.getElementById('compareSnapshotsBtn').addEventListener('click', compareSelectedSnapshots);
loadAnalysisSnapshots();
renderSnapshotList();

// ========== 一键生成分析报告（design doc §10.3） ==========
// 只负责拼接各面板已经算好的数据（不重新计算），图表部分用 Plotly.toImage 导出成 base64 图片；
// 报告结构：过滤条件说明 → 总览统计 → 数据质量摘要 → Top相关性表 → 关键图表 → 结论区（留空给用户手动补充）。
async function buildReportSections(options) {
  const parts = [];
  parts.push(`# 分析报告\n\n生成时间：${new Date().toLocaleString()}\n\n过滤条件：${describeCurrentFilter()}\n\n样本数：${activeRows.length}（原始 ${matchedRows.length} 条）\n`);

  if (options.summary && activeRows.length) {
    const cur = activeRows.map(r => r.returnCurrent);
    const mx = activeRows.map(r => r.returnMax);
    const cs = calcStats(cur, 1);
    const ms = calcStats(mx, 1);
    parts.push(`## 总览统计\n\n- returnCurrent 平均倍数：${cs.mean.toFixed(4)}x\n- 胜率（倍数>1）：${(cs.winRate * 100).toFixed(1)}%\n- returnMax 平均倍数：${ms.mean.toFixed(4)}x\n- 最大倍数：${ms.max.toFixed(4)}x\n`);
  }

  if (options.quality && activeRows.length) {
    const alerts = computeQualityAlerts(activeRows);
    parts.push(`## 数据质量摘要\n\n发现 ${alerts.length} 条可能存在数据问题的记录（详见工具内"异常值/数据质量报警"面板）。\n`);
  }

  if (options.corr && allCorrelations.length) {
    const top = allCorrelations.slice().sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 20);
    let table = '## Top 相关性表\n\n| 目标 | 字段 | r | n | p |\n|---|---|---|---|---|\n';
    for (const c of top) {
      table += `| ${c.target} | ${c.feature} | ${c.r.toFixed(4)} | ${c.n} | ${Number.isFinite(c.p) ? c.p.toExponential(2) : '-'} |\n`;
    }
    parts.push(table);
  }

  if (options.charts) {
    const chartDivs = [];
    document.querySelectorAll('#plotStack .plot-chart').forEach((el, i) => { if (el.querySelector('.main-svg')) chartDivs.push({ title: `散点图 ${i + 1}`, el }); });
    if (document.getElementById('binBarChart').querySelector('.main-svg')) chartDivs.push({ title: '分箱柱状图', el: document.getElementById('binBarChart') });
    if (document.getElementById('distChart').querySelector('.main-svg')) chartDivs.push({ title: '收益分布直方图', el: document.getElementById('distChart') });
    if (chartDivs.length) {
      let chartsMd = '## 关键图表\n\n';
      for (const c of chartDivs) {
        try {
          const dataUrl = await Plotly.toImage(c.el, { format: 'png', width: 900, height: 500 });
          chartsMd += `### ${c.title}\n\n![${c.title}](${dataUrl})\n\n`;
        } catch (e) { chartsMd += `### ${c.title}\n\n（导出失败：${e.message}）\n\n`; }
      }
      parts.push(chartsMd);
    }
  }

  parts.push('## 结论\n\n（请在此手动补充解读，工具只呈现数据事实，不代替判断）\n');
  return parts;
}

function getReportOptions() {
  return {
    summary: document.getElementById('reportIncSummary').checked,
    quality: document.getElementById('reportIncQuality').checked,
    corr: document.getElementById('reportIncCorr').checked,
    charts: document.getElementById('reportIncCharts').checked,
  };
}

async function generateMarkdownReport() {
  if (!activeRows.length) { alert('请先点击"分析"加载数据'); return; }
  const hintEl = document.getElementById('reportStatusHint');
  hintEl.textContent = '正在生成报告...';
  try {
    const parts = await buildReportSections(getReportOptions());
    const blob = new Blob([parts.join('\n')], { type: 'text/markdown;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `分析报告_${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    hintEl.textContent = '✅ 已生成并下载';
  } catch (e) {
    hintEl.textContent = '❌ 生成失败：' + e.message;
  }
}

async function generatePrintableReport() {
  if (!activeRows.length) { alert('请先点击"分析"加载数据'); return; }
  const hintEl = document.getElementById('reportStatusHint');
  hintEl.textContent = '正在生成可打印页面...';
  try {
    const parts = await buildReportSections(getReportOptions());
    // 简单把 markdown 转成可读 HTML：标题/表格/图片分别处理，不追求完整 markdown 语法支持，够报告用即可
    const html = parts.map(md => {
      let html = escapeHtml(md);
      html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^### (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" style="max-width:100%; margin: 8px 0;">');
      // 表格：把 markdown 表格行转成 <table>（每个 md 片段里最多一张表，简化处理）
      const lines = html.split('\n');
      let inTable = false, out = [];
      for (const line of lines) {
        if (/^\|/.test(line)) {
          if (!inTable) { out.push('<table border="1" cellpadding="6" style="border-collapse:collapse;">'); inTable = true; }
          if (/^\|[\s-|]+\|$/.test(line)) continue; // 表头分隔行
          const cells = line.split('|').slice(1, -1).map(c => c.trim());
          out.push('<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>');
        } else {
          if (inTable) { out.push('</table>'); inTable = false; }
          out.push(`<p>${line}</p>`);
        }
      }
      if (inTable) out.push('</table>');
      return out.join('\n');
    }).join('\n');
    const win = window.open('', '_blank');
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>分析报告</title>
      <style>body{font-family:-apple-system,sans-serif; max-width:900px; margin:40px auto; color:#1d1d1f;} table{width:100%; margin:8px 0;} h1,h2,h3{margin-top:24px;}</style>
      </head><body>${html}<script>window.onload=()=>window.print();</script></body></html>`);
    win.document.close();
    hintEl.textContent = '✅ 已在新窗口打开，可在打印对话框里选择"另存为PDF"';
  } catch (e) {
    hintEl.textContent = '❌ 生成失败：' + e.message;
  }
}

document.getElementById('reportToggleBtn').addEventListener('click', () => {
  document.getElementById('reportPanel').classList.toggle('hidden');
});
document.getElementById('genReportMdBtn').addEventListener('click', generateMarkdownReport);
document.getElementById('genReportPrintBtn').addEventListener('click', generatePrintableReport);
