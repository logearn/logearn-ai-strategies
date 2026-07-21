// ========== Pro 分析功能：相关性矩阵 / 分组对比 / 特征重要性(OLS) / 时间维度 / 分类字段分析 ==========
// 必须最后加载：复用 ui.js（activeRows/scatterOptions/attachAutocomplete/getFeature 等）
// 和 charts.js（darkLayout/palette）里已经定义好的状态与函数。
// 之前这里有一层"解锁 Pro 分析功能"的软门控，但本地开关本身没有真实付费校验，只会增加使用摩擦，
// 已去掉，所有分析功能直接可用（UX 优化：取消/简化 Pro 解锁墙）。

// 时间维度分析（子视图 A 分桶统计 / 子视图 B 滚动窗口相关性）最近一次生成的数据，供 CSV 导出复用
let timeAnalysisData = [];
let rollingCorrData = [];

// 读取"切分方式/训练集比例/切分种子（锁定）"三个输入控件的值，拼成 splitTrainTest 需要的 options 对象。
// 相关性面板/回归面板/组合评分面板三处的切分控件 DOM id 只有前缀不同（如 oos/regOos/composite），
// 约定统一走 `${prefix}SplitMethod` / `${prefix}TrainRatio` / `${prefix}Seed` 三个 id 即可复用。
function readSplitOptions(prefix, extra = {}) {
  return {
    ...extra,
    method: document.getElementById(`${prefix}SplitMethod`).value,
    ratio: Number(document.getElementById(`${prefix}TrainRatio`).value) || 0.7,
    seed: Number(document.getElementById(`${prefix}Seed`).value)
  };
}

// "导入相关性表 Top10"按钮：从已计算好的 allCorrelations（按 |r| 降序排好）里取前 N 个不重复字段
// 批量塞进某个字段标签选择器，四个 Pro 子面板（相关矩阵/ROC批量/相似Case/组合评分）共用同一套逻辑。
// presetFields：调用前先固定加入的字段（如相关矩阵额外预填 returnMax），可留空。
function wireImportTop10Btn(btnId, selector, presetFields = [], topN = 10) {
  document.getElementById(btnId).addEventListener('click', () => {
    if (!allCorrelations.length) { showToast('请先点击"分析"加载数据'); return; }
    presetFields.forEach(f => selector.addField(f));
    const seen = new Set();
    for (const c of allCorrelations) {
      if (seen.size >= topN) break;
      if (!seen.has(c.feature)) { seen.add(c.feature); selector.addField(c.feature); }
    }
  });
}

// ---------- 通用多选字段标签输入（复用 X 指标联想 datalist） ----------
// 与 ui.js 的 batchXSelected 标签输入是同一套交互模式，但服务于本文件内独立的字段列表（相关性矩阵/回归特征），
// 因此在此单独实现一个参数化版本，而不是直接改造 ui.js 里那个专属 batchXSelected 的实现。
function makeFieldTagSelector(inputId, tagBoxId) {
  let selected = [];
  const input = document.getElementById(inputId);
  const box = document.getElementById(tagBoxId);

  function render() {
    box.querySelectorAll('.tag-chip').forEach(el => el.remove());
    for (const f of selected) {
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
        selected = selected.filter(x => x !== f);
        render();
      });
      chip.appendChild(label);
      chip.appendChild(btn);
      box.insertBefore(chip, input);
    }
  }

  function tryAdd() {
    const v = input.value.trim();
    if (!v || !scatterOptions.includes(v)) return false;
    if (!selected.includes(v)) { selected.push(v); render(); }
    input.value = '';
    return true;
  }

  input.addEventListener('input', () => {
    const v = input.value.trim();
    if (v && scatterOptions.includes(v)) tryAdd();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      tryAdd();
    } else if (e.key === 'Backspace' && !input.value && selected.length) {
      selected.pop();
      render();
    }
  });
  box.addEventListener('click', e => { if (e.target === box) input.focus(); });
  attachAutocomplete(input, box, 'xFieldList', v => {
    input.value = v;
    tryAdd();
    input.focus();
  });

  return {
    getSelected: () => selected,
    addField: f => { if (scatterOptions.includes(f) && !selected.includes(f)) { selected.push(f); render(); } },
    clear: () => { const n = selected.length; selected = []; render(); return n; }
  };
}

// ---------- 7. 相似 Case 检索（最近邻） ----------
// 对选中字段做 z-score 标准化后计算基准 token 与其余 token 的欧氏距离，取 Top K 最近的作为"历史上长得像"的参考案例。
// 缺失值处理：若某个候选行在部分字段上缺失，距离只在双方都有值的维度上计算，并按实际参与的维度数取均方根
// 归一化（而不是直接用缺失维度补 0），避免"缺失字段多的候选因为差异项更少而显得更相似"这种偏差。
function findSimilarCases(baseRow, fields, k) {
  const stats = fields.map(f => {
    const vals = [];
    for (const r of activeRows) {
      const v = getFeature(r, f);
      if (isFiniteNumber(v)) vals.push(Number(v));
    }
    if (!vals.length) return { field: f, mean: NaN, std: NaN };
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    return { field: f, mean, std: Math.sqrt(variance) };
  });

  const missingInBase = [];
  const baseVec = stats.map(s => {
    const v = getFeature(baseRow, s.field);
    if (!isFiniteNumber(v) || !Number.isFinite(s.std) || s.std === 0) { missingInBase.push(s.field); return null; }
    return (Number(v) - s.mean) / s.std;
  });
  const usableIdx = baseVec.map((v, i) => (v !== null ? i : -1)).filter(i => i >= 0);
  if (!usableIdx.length) return { error: '基准记录在所选字段上全部缺失（或字段在当前数据集里无变化），无法计算相似度' };

  const candidates = [];
  for (const r of activeRows) {
    if (r === baseRow) continue;
    let sumSq = 0, usedDims = 0;
    for (const i of usableIdx) {
      const s = stats[i];
      const v = getFeature(r, s.field);
      if (!isFiniteNumber(v)) continue;
      const z = (Number(v) - s.mean) / s.std;
      sumSq += (z - baseVec[i]) ** 2;
      usedDims++;
    }
    if (!usedDims) continue;
    candidates.push({ row: r, dist: Math.sqrt(sumSq / usedDims) });
  }
  candidates.sort((a, b) => a.dist - b.dist);
  return { top: candidates.slice(0, k), missingInBase, usedFieldCount: usableIdx.length };
}

function findBaseRowByInput(text) {
  const t = text.trim();
  if (!t) return null;
  // 精确匹配 token_address 优先，其次按 "symbol (token_address前8位…)" 展示格式或纯 symbol 匹配
  return activeRows.find(r => r.tokenAddress === t)
    || activeRows.find(r => `${r.symbol} (${(r.tokenAddress || '').slice(0, 8)}…)` === t)
    || activeRows.find(r => r.symbol === t);
}

function renderSimilarCases(baseInputText, fields, k) {
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  const summaryEl = document.getElementById('similarSummary');
  const tbody = document.getElementById('similarBody');
  if (!fields.length) { summaryEl.textContent = '请至少选择 1 个相似度计算字段'; tbody.innerHTML = ''; return; }
  const baseRow = findBaseRowByInput(baseInputText);
  if (!baseRow) { summaryEl.textContent = '未找到匹配的基准 token，请从下拉列表中选择或检查 symbol/CA 是否正确'; tbody.innerHTML = ''; return; }

  const result = findSimilarCases(baseRow, fields, Math.max(1, Math.min(100, k || 10)));
  if (result.error) { summaryEl.textContent = '⚠️ ' + result.error; tbody.innerHTML = ''; return; }

  const missingNote = result.missingInBase.length
    ? `基准 token 的以下字段缺失，相似度计算未纳入这些维度：${result.missingInBase.join('、')}。` : '';
  const rc = result.top.map(t => t.row.returnMax).filter(Number.isFinite);
  const meanRc = rc.length ? rc.reduce((a, b) => a + b, 0) / rc.length : NaN;
  const winRate = rc.length ? rc.filter(v => v > 1).length / rc.length : NaN;
  summaryEl.innerHTML = `基准 token：<b>${escapeHtml(baseRow.symbol || baseRow.tokenAddress)}</b>，实际参与相似度计算的字段数：${result.usedFieldCount}/${fields.length}。`
    + (missingNote ? `<br>${escapeHtml(missingNote)}` : '')
    + (result.top.length ? `<br>这 ${result.top.length} 个相似 case 的 returnMax 均值为 ${formatNumberSmart(meanRc)}x，胜率(&gt;1x)为 ${(winRate * 100).toFixed(1)}%。<span style="color:var(--text-muted)">（历史相似性参考，不是预测）</span>` : '');

  tbody.innerHTML = result.top.map(t => `
    <tr>
      <td>${escapeHtml(t.row.symbol || '-')}</td>
      <td class="ellip" title="${escapeHtml(t.row.tokenAddress || '')}">${escapeHtml(t.row.tokenAddress || '-')}</td>
      <td class="num">${t.dist.toFixed(4)}</td>
      <td class="num">${Number.isFinite(t.row.returnMax) ? t.row.returnMax.toFixed(3) + 'x' : '-'}</td>
    </tr>
  `).join('') || '<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">无匹配结果</td></tr>';
}

function refreshSimilarBaseOptions() {
  const list = document.getElementById('similarBaseList');
  if (!list) return;
  list.innerHTML = activeRows.slice(0, 2000).map(r =>
    `<option value="${escapeHtml(`${r.symbol} (${(r.tokenAddress || '').slice(0, 8)}…)`)}"></option>`
  ).join('');
}

// ---------- 1. 相关性矩阵 / 热力图 ----------
function renderCorrMatrix(fields, threshold, onlyHighlight) {
  if (fields.length < 2) { showToast('请至少选择 2 个字段'); return; }
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  threshold = Number.isFinite(threshold) ? threshold : 0.8;

  // 边界情况 1：字段在当前 activeRows 里全部缺失；边界情况 2：字段方差为 0（所有取值相同）——
  // 这两种情况下 pearson 分母为 0 或样本不足，r 本身没有意义，需要单独标注，不能和"确实不相关"混为一谈
  const fieldStatus = new Map();
  for (const f of fields) {
    const vals = activeRows.map(row => getFeature(row, f)).filter(isFiniteNumber).map(Number);
    if (!vals.length) fieldStatus.set(f, 'missing');
    else if (new Set(vals).size <= 1) fieldStatus.set(f, 'constant');
    else fieldStatus.set(f, 'ok');
  }

  const matrix = fields.map(fx => fields.map(fy => {
    if (fieldStatus.get(fx) !== 'ok' || fieldStatus.get(fy) !== 'ok') return NaN;
    if (fx === fy) return 1;
    const pairs = [];
    for (const row of activeRows) {
      const vx = getFeature(row, fx), vy = getFeature(row, fy);
      if (isFiniteNumber(vx) && isFiniteNumber(vy)) pairs.push([Number(vx), Number(vy)]);
    }
    return pairs.length >= 5 ? pearson(pairs) : NaN;
  }));

  const cellNote = f => fieldStatus.get(f) === 'missing' ? '数据不足' : fieldStatus.get(f) === 'constant' ? '无变化' : null;
  const text = matrix.map((row, i) => row.map((v, j) => {
    const note = cellNote(fields[i]) || cellNote(fields[j]);
    if (note) return note;
    return Number.isFinite(v) ? v.toFixed(2) : 'N/A';
  }));
  // "只高亮共线对"开启时，非共线（|r|<threshold 且非对角线）的格子调低透明度，让共线对在视觉上更突出
  const z = onlyHighlight
    ? matrix.map((row, i) => row.map((v, j) => {
        if (i === j || !Number.isFinite(v)) return v;
        return Math.abs(v) >= threshold ? v : v * 0.25;
      }))
    : matrix;

  Plotly.newPlot('corrMatrixChart', [{
    z, x: fields, y: fields, type: 'heatmap',
    zmin: -1, zmax: 1, colorscale: 'RdBu', reversescale: true,
    text, texttemplate: '%{text}', hoverinfo: 'x+y+z'
  }], darkLayout({
    title: `字段两两 Pearson r 相关性矩阵${onlyHighlight ? `（已弱化 |r|<${threshold} 的格子）` : ''}`,
    margin: { t: 50, l: 140, b: 140 },
    xaxis: { tickangle: -45 }
  }), { responsive: true });

  const chartEl = document.getElementById('corrMatrixChart');
  // 这里每次渲染都重新绑定（不像散点图那样做过"只绑一次"的缓存），本身不会丢监听器；
  // 加一道 removeAllListeners 是防重复累积——实测 Plotly 2.27 的 newPlot 会清掉旧监听器，
  // 但不依赖这个实现细节更稳妥，否则一次点击可能触发多次跳转。
  if (typeof chartEl.removeAllListeners === 'function') chartEl.removeAllListeners('plotly_click');
  chartEl.on('plotly_click', evt => {
    const p = evt.points && evt.points[0];
    if (!p || p.x === p.y) return;
    if (fieldStatus.get(p.x) !== 'ok' || fieldStatus.get(p.y) !== 'ok') return;
    if (scatterOptions.includes(p.x) && !batchXSelected.includes(p.x)) batchXSelected.push(p.x);
    setFieldInputValue('yField', p.y);
    renderBatchTags();
    plot();
    document.getElementById('scatterPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // 共线对列表：遍历上三角矩阵（不含对角线），筛出 |r| >= threshold 的字段对，作为热力图的文字化摘要
  const pairs = [];
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const r = matrix[i][j];
      if (Number.isFinite(r) && Math.abs(r) >= threshold) pairs.push({ a: fields[i], b: fields[j], r });
    }
  }
  pairs.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  document.getElementById('corrMatrixPairsBody').innerHTML = pairs.length
    ? pairs.map(p => `
      <tr>
        <td>${escapeHtml(p.a)}</td>
        <td>${escapeHtml(p.b)}</td>
        <td class="num">${p.r.toFixed(4)}</td>
        <td style="color:var(--text-muted)">这两个字段可能在描述同一件事，同时作为独立特征使用需谨慎</td>
      </tr>
    `).join('')
    : `<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">没有 |r| ≥ ${threshold} 的共线对</td></tr>`;
}

// ---------- 2. 分组对比分析 ----------
// 分组键计算：分类字段直接按值分组；数值字段填了断点时复用分箱柱状图的 parseBreakpoints/binLabel 做离散化分组，
// 两种分组共用同一套后续的 r 值计算和辛普森悖论检测逻辑，不重复实现。
function computeGroupKey(row, groupField, breakpoints) {
  if (breakpoints && breakpoints.length) {
    const v = getFeature(row, groupField);
    if (!isFiniteNumber(v)) return '(空)';
    const edges = [-Infinity, ...breakpoints, Infinity];
    for (let i = 0; i < edges.length - 1; i++) {
      if (Number(v) >= edges[i] && Number(v) < edges[i + 1]) return binLabel(edges[i], edges[i + 1]);
    }
    return '(空)';
  }
  const gv = getFeature(row, groupField);
  return (gv === undefined || gv === null || gv === '') ? '(空)' : String(gv);
}

// 自动分位数分层（混杂控制）通用工具：把一组数值按分位数切成 quantileCount 层，每层样本量大致相等，
// 避免手动断点容易出现的"某一层几乎包揽全部样本"问题。返回 { breakpoints } 或 { error } 二选一，
// 由调用方决定用 showToast 还是别的方式呈现——这个函数本身不做 UI 交互，保持纯函数、方便复用/测试。
function computeQuantileBreakpoints(values, quantileCount) {
  const vals = values.filter(isFiniteNumber).map(Number).sort((a, b) => a - b);
  if (vals.length < quantileCount * 5) {
    return { error: `有效数值样本仅 ${vals.length} 条，不足以做 ${quantileCount} 分位分层（每层至少需要约 5 条）` };
  }
  const cuts = [];
  for (let i = 1; i < quantileCount; i++) cuts.push(percentile(vals, i / quantileCount));
  const breakpoints = [...new Set(cuts)].filter(Number.isFinite);
  if (!breakpoints.length) return { error: '取值过于集中，分位数切点全部重合，无法分层' };
  return { breakpoints };
}

function renderGroupCompare(groupField, breakpointsText, featureField, targetField, minSample, quantileCount) {
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  if (!groupField || !featureField) { showToast('请填写分组字段和特征字段'); return; }
  let breakpoints = breakpointsText ? parseBreakpoints(breakpointsText) : [];
  // 启用自动分位数分层时优先于手动断点
  if (Number.isFinite(quantileCount) && quantileCount >= 2) {
    const result = computeQuantileBreakpoints(activeRows.map(r => getFeature(r, groupField)), quantileCount);
    if (result.error) { showToast(`分组字段${result.error}；请换字段或改用手动断点`); return; }
    breakpoints = result.breakpoints;
    if (breakpointsText) showToast('已启用自动分位数分层，手动断点本次被忽略');
  }
  const threshold = Number.isFinite(minSample) && minSample > 0 ? minSample : 10;

  const groups = new Map();
  for (const row of activeRows) {
    const key = computeGroupKey(row, groupField, breakpoints);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const stats = [];
  for (const [key, rows] of groups) {
    const targets = rows.map(r => getFeature(r, targetField)).filter(isFiniteNumber).map(Number);
    if (!targets.length) continue;
    const mean = targets.reduce((a, b) => a + b, 0) / targets.length;
    const winRate = targets.filter(v => v > 1).length / targets.length;
    const pairs = [];
    for (const r of rows) {
      const fv = getFeature(r, featureField), tv = getFeature(r, targetField);
      if (isFiniteNumber(fv) && isFiniteNumber(tv)) pairs.push([Number(fv), Number(tv)]);
    }
    // 低于最小样本量阈值的分组不计算相关性，直接标"样本不足"，避免小样本极端 r 值误导
    const belowThreshold = pairs.length < threshold;
    const r = (!belowThreshold && pairs.length >= 5) ? pearson(pairs) : NaN;
    const p = Number.isFinite(r) ? pearsonPValue(r, pairs.length) : NaN;
    stats.push({ key, n: rows.length, mean, winRate, r, p, rn: pairs.length, belowThreshold, targets });
  }
  stats.sort((a, b) => b.n - a.n);
  if (!stats.length) { showToast('没有可用的分组数据，请检查字段是否正确'); return; }

  // 整体（未分组）r 作为对照——辛普森悖论的判断基准
  const overallPairs = [];
  for (const row of activeRows) {
    const fv = getFeature(row, featureField), tv = getFeature(row, targetField);
    if (isFiniteNumber(fv) && isFiniteNumber(tv)) overallPairs.push([Number(fv), Number(tv)]);
  }
  const overallR = overallPairs.length >= 5 ? pearson(overallPairs) : NaN;

  // 分层调整后 r（混杂控制的核心输出）：各层内 r 按有效样本量加权平均。
  // 它回答的问题是“控制住分组变量后，特征还剩多少独立解释力”；与整体 r 差距越大，
  // 说明原始相关性里被分组变量（混杂）解释掉的比例越高
  const validGroupStats = stats.filter(s => Number.isFinite(s.r));
  const weightSum = validGroupStats.reduce((a, s) => a + s.rn, 0);
  const weightedR = weightSum > 0 ? validGroupStats.reduce((a, s) => a + s.r * s.rn, 0) / weightSum : NaN;
  const overallParts = [];
  if (Number.isFinite(overallR)) overallParts.push(`<b>整体（未分组）r:</b> ${overallR.toFixed(4)} <span style="color:var(--text-muted)">(n=${overallPairs.length})</span>`);
  if (Number.isFinite(weightedR)) overallParts.push(`<b>分层调整后 r（层内按样本量加权）:</b> ${weightedR.toFixed(4)} <span style="color:var(--text-muted)">(基于 ${validGroupStats.length} 层，覆盖 n=${weightSum})</span>`);
  document.getElementById('groupCompareOverall').innerHTML = overallParts.join(' &nbsp;|&nbsp; ');

  // 伪相关识别（自动标注，不需要用户手工判断）
  const warnEl = document.getElementById('groupCompareWarning');
  const warnings = [];
  if (Number.isFinite(overallR) && Math.abs(overallR) >= 0.3 && validGroupStats.length && validGroupStats.every(s => Math.abs(s.r) < 0.15)) {
    warnings.push('⚠️ 整体相关性可能是分组间均值差异导致的合成效应（辛普森悖论），单个分组内没有独立解释力。');
  }
  if (Number.isFinite(overallR) && Number.isFinite(weightedR) && Math.abs(overallR) >= 0.2
    && (Math.sign(weightedR) !== Math.sign(overallR) || Math.abs(weightedR) < Math.abs(overallR) * 0.5)) {
    warnings.push(`⚠️ 控制 ${escapeHtml(groupField)} 分层后相关性大幅减弱（整体 r=${overallR.toFixed(3)} → 层内加权 r=${weightedR.toFixed(3)}）：原始相关性可能主要由 ${escapeHtml(groupField)} 这个混杂因素造成，而非特征本身的独立解释力。`);
  }
  if (Number.isFinite(overallR) && validGroupStats.length) {
    const largestGroup = validGroupStats.reduce((a, b) => (b.n > a.n ? b : a));
    if (Math.sign(overallR) !== 0 && Math.sign(largestGroup.r) !== 0 && Math.sign(overallR) !== Math.sign(largestGroup.r)) {
      warnings.push(`⚠️ 该分组（"${largestGroup.key}"，样本占比最大）与整体趋势方向相反，请单独核查。`);
    }
  }
  if (warnings.length) {
    warnEl.classList.remove('hidden');
    warnEl.innerHTML = warnings.join('<br>');
  } else {
    warnEl.classList.add('hidden');
  }

  Plotly.newPlot('groupCompareChart', [{
    x: stats.map(s => s.key),
    y: stats.map(s => Number.isFinite(s.r) ? s.r : 0),
    type: 'bar',
    text: stats.map(s => `n=${s.n}`),
    textposition: 'outside',
    marker: { color: stats.map(s => (Number.isFinite(s.r) && s.r >= 0) ? '#30d158' : '#ff453a') }
  }], darkLayout({
    title: `${featureField} 与 ${targetField} 的相关性 r（按 ${groupField} 分组，各组独立计算）`,
    yaxis: { title: 'r', range: [-1, 1] },
    margin: { t: 50 }
  }), { responsive: true });

  document.getElementById('groupCompareBody').innerHTML = stats.map(s => `
    <tr>
      <td>${escapeHtml(s.key)}</td>
      <td class="num">${s.n}</td>
      <td class="num">${formatNumberSmart(s.mean)}</td>
      <td class="num">${(s.winRate * 100).toFixed(1)}%</td>
      <td class="num">${Number.isFinite(s.r) ? s.r.toFixed(4) : `样本不足(${s.rn})`}</td>
      <td class="num">${Number.isFinite(s.p) ? s.p.toExponential(2) : '-'}</td>
    </tr>
  `).join('');

  // 分组内多档位达标率：目标字段是"倍数"口径（1 = 不涨不跌），常见需求是不只看"是否 >1"这一个
  // 阈值的单一胜率，还想知道组内有多少比例能到 2 倍、3 倍……用同一份 targets 数组多算几个阈值，
  // 不需要重新分组或重新扫 activeRows。
  const WIN_THRESHOLDS = [1, 1.5, 2, 3, 5, 10];
  document.getElementById('groupCompareBreakdownHead').innerHTML = `
    <tr><th>分组</th><th class="num">样本数</th>${WIN_THRESHOLDS.map(t => `<th class="num">\u2265${t}\u500d</th>`).join('')}</tr>
  `;
  document.getElementById('groupCompareBreakdownBody').innerHTML = stats.map(s => `
    <tr>
      <td>${escapeHtml(s.key)}</td>
      <td class="num">${s.targets.length}</td>
      ${WIN_THRESHOLDS.map(t => {
        const rate = s.targets.length ? s.targets.filter(v => v >= t).length / s.targets.length : NaN;
        return `<td class="num">${Number.isFinite(rate) ? (rate * 100).toFixed(1) + '%' : '-'}</td>`;
      }).join('')}
    </tr>
  `).join('');
}

// ---------- 3. 特征重要性（多元线性回归，标准化系数） ----------
// 高斯消元（带部分选主元）求解线性方程组 A x = b，A 为 n x n。
// 不再用 ridge 微小正则"悄悄掩盖"共线问题——矩阵（近）奇异时直接返回 null，
// 让调用方明确知道"这组特征算不出稳定的系数"，而不是输出一个看似精确、实则没有意义的数字。
function solveLinearSystem(A, b) {
  const n = A.length;
  if (n === 0) return [];
  const scale = Math.max(...A.map((row, i) => Math.abs(row[i]))) || 1;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    if (Math.abs(M[col][col]) < 1e-9 * scale) return null; // 矩阵（近）奇异，无法稳定求解
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// 简易 VIF（方差膨胀因子）：对每个自变量，用它对其余自变量做回归得到 R²ᵢ，VIF = 1 / (1 - R²ᵢ)。
// VIF 越大说明该字段能被其余字段线性解释的程度越高，共线性越严重；
// 如果其余字段之间本身就高度共线导致这个子回归也解不出来，直接视为 VIF = Infinity（共线性已经严重到无法量化的程度）。
function computeVIFs(usedX, n) {
  return usedX.map((xi, i) => {
    const others = usedX.filter((_, j) => j !== i);
    const kk = others.length;
    const XtX = Array.from({ length: kk }, (_, a) => Array.from({ length: kk }, (_, b) => {
      let s = 0; for (let r = 0; r < n; r++) s += others[a].z[r] * others[b].z[r]; return s;
    }));
    const Xty = others.map(o => { let s = 0; for (let r = 0; r < n; r++) s += o.z[r] * xi.z[r]; return s; });
    const solved = solveLinearSystem(XtX, Xty);
    if (!solved) return Infinity;
    let sse = 0, sst = 0;
    for (let r = 0; r < n; r++) {
      let yhat = 0;
      for (let a = 0; a < kk; a++) yhat += solved[a] * others[a].z[r];
      sse += (xi.z[r] - yhat) ** 2;
      sst += xi.z[r] ** 2;
    }
    const r2i = sst > 0 ? 1 - sse / sst : 0;
    return r2i >= 0.999999 ? Infinity : 1 / (1 - r2i);
  });
}

function standardize(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  return { mean, std, z: std > 1e-12 ? values.map(v => (v - mean) / std) : values.map(() => 0) };
}

// 样本外验证：测试集必须用训练集算出来的 mean/std 标准化，而不是用测试集自己的分布重新标准化——
// 否则等于让测试集"偷看"了自己的统计信息，样本外 R² 会失去验证意义
function standardizeWith(values, mean, std) {
  return std > 1e-12 ? values.map(v => (v - mean) / std) : values.map(() => 0);
}

function renderFeatureImportance(targetField, fields, oosOptions) {
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  if (fields.length < 1) { showToast('请至少选择 1 个特征字段'); return; }
  // 完整案例：目标和全部特征都必须是有限数字才纳入回归，避免缺失值破坏矩阵运算
  const completeRows = activeRows.filter(row => {
    const tv = getFeature(row, targetField);
    if (!isFiniteNumber(tv)) return false;
    return fields.every(f => isFiniteNumber(getFeature(row, f)));
  });
  if (completeRows.length < fields.length + 5) {
    showToast(`完整样本数（${completeRows.length}）过少，无法稳定回归。请减少特征数量或检查字段是否大量缺失。`);
    return;
  }

  // 样本外验证：只在训练集上拟合标准化系数（均值/标准差也来自训练集），测试集直接复用训练集的标准化参数做预测，
  // 而不是在测试集上重新拟合一套新系数——重新拟合就失去了"验证"的意义
  let rows = completeRows, testRows = [];
  const oosEnabled = oosOptions && oosOptions.enabled;
  if (oosEnabled) {
    const split = splitTrainTest(completeRows, oosOptions.method, oosOptions.ratio, 'swapBeginTime', oosOptions.seed);
    rows = split.train;
    testRows = split.test;
    if (rows.length < fields.length + 5) {
      showToast(`训练集样本数（${rows.length}）过少，无法稳定回归。请调低训练集比例的切分粒度或减少特征数量。`);
      return;
    }
  }

  const y = standardize(rows.map(r => Number(getFeature(r, targetField))));
  const constFields = [];
  const xStd = fields.map(f => {
    const s = standardize(rows.map(r => Number(getFeature(r, f))));
    if (s.std < 1e-12) constFields.push(f);
    return s;
  });
  if (constFields.length) {
    showToast(`以下字段在当前数据里几乎是常数，无法参与回归，已自动剔除：${constFields.join('、')}`);
  }
  const usedFields = fields.filter((f, i) => xStd[i].std >= 1e-12);
  const usedX = xStd.filter(s => s.std >= 1e-12);
  if (!usedFields.length) { showToast('所有特征都是常数，无法回归'); return; }

  const n = rows.length, k = usedFields.length;
  // 自变量数不能超过可用样本数（矩阵不可逆的必要条件），直接拦截
  if (k >= n) {
    showToast(`自变量数量（${k}）不能超过可用样本数（${n}），请减少字段或放宽过滤条件。`);
    return;
  }

  // VIF 无论最终整体回归是否成功都先算好——如果整体矩阵奇异，VIF 表本身就是诊断"哪里出了问题"的关键线索
  const vifs = computeVIFs(usedX, n);
  // 单变量 r：在与多元回归完全相同的样本子集（listwise deletion 之后的 rows）上计算，
  // 才能和 β 系数公平对照，回答"哪些字段单看显著、放一起就消失"
  const univariateR = usedX.map(xi => pearson(xi.z.map((zx, r) => [zx, y.z[r]])));

  const warnEl = document.getElementById('importanceWarning');
  const coefBody = document.getElementById('importanceCoefBody');
  const vifBadge = vif => {
    if (!Number.isFinite(vif)) return '🔴 无法求解';
    if (vif > 10) return `🔴 严重 (${vif.toFixed(1)})`;
    if (vif > 5) return `🟡 中等 (${vif.toFixed(1)})`;
    return `🟢 正常 (${vif.toFixed(1)})`;
  };

  // 正规方程 X'X beta = X'y（X 含标准化特征，无截距列——标准化后截距理论上≈0，省略以简化）
  const XtX = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => {
    let s = 0;
    for (let r = 0; r < n; r++) s += usedX[i].z[r] * usedX[j].z[r];
    return s;
  }));
  const Xty = usedX.map(xi => {
    let s = 0;
    for (let r = 0; r < n; r++) s += xi.z[r] * y.z[r];
    return s;
  });
  const beta = solveLinearSystem(XtX, Xty);

  if (!beta) {
    // 矩阵（近）奇异：不再用 ridge 强行凑一个看似精确、实则没有意义的系数，
    // 而是明确告知用户问题所在，并展示 VIF 表帮助定位该剔除哪个字段
    warnEl.classList.remove('hidden');
    warnEl.textContent = '由于字段间共线性极高（可能存在完全线性相关或近乎重复的字段），无法求解稳定的回归系数，请参考下方 VIF 列先剔除高共线字段后重新运行。';
    document.getElementById('importanceResult').innerHTML = `<b>完整样本数:</b> ${n} &nbsp; <span style="color:var(--text-muted)">（矩阵近奇异，未输出系数/图表）</span>`;
    Plotly.purge('importanceChart');
    coefBody.innerHTML = usedFields.map((f, i) => `
      <tr>
        <td>${escapeHtml(f)}</td>
        <td class="num">-</td>
        <td class="num">${Number.isFinite(univariateR[i]) ? univariateR[i].toFixed(4) : '-'}</td>
        <td class="num">${Number.isFinite(vifs[i]) ? vifs[i].toFixed(1) : '∞'}</td>
        <td>${vifBadge(vifs[i])}</td>
      </tr>
    `).join('');
    return;
  }
  warnEl.classList.add('hidden');

  // R^2：标准化 y 的 SST = sum(y^2)（均值已为0）
  let sse = 0, sst = 0;
  for (let r = 0; r < n; r++) {
    let yhat = 0;
    for (let i = 0; i < k; i++) yhat += beta[i] * usedX[i].z[r];
    sse += (y.z[r] - yhat) ** 2;
    sst += y.z[r] ** 2;
  }
  const r2 = sst > 0 ? 1 - sse / sst : 0;
  // 调整 R²：惩罚字段数量，避免"字段越多 R² 越高"这种虚假的模型质量提升假象
  const adjR2 = n - k - 1 > 0 ? 1 - (1 - r2) * (n - 1) / (n - k - 1) : NaN;

  // 样本外 R²：用训练集拟合出的 beta + 训练集的均值/标准差，直接应用到测试集上做预测，
  // 定义为"预测值与真实值的相关系数平方"（而不是重新在测试集上算一套 SSE/SST，那等于重新拟合）
  let testR2 = NaN, testN = testRows.length;
  if (oosEnabled && testRows.length >= 5) {
    const yTestStd = standardizeWith(testRows.map(r => Number(getFeature(r, targetField))), y.mean, y.std);
    const xTestStd = usedFields.map((f, i) => standardizeWith(testRows.map(r => Number(getFeature(r, f))), usedX[i].mean, usedX[i].std));
    const yPred = testRows.map((_, r) => {
      let yhat = 0;
      for (let i = 0; i < k; i++) yhat += beta[i] * xTestStd[i][r];
      return yhat;
    });
    const testR = pearson(yPred.map((p, r) => [p, yTestStd[r]]));
    testR2 = Number.isFinite(testR) ? testR ** 2 : NaN;
  }

  const result = usedFields.map((f, i) => ({ field: f, beta: beta[i], vif: vifs[i], r: univariateR[i] }));
  result.sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta));

  let oosHtml = '';
  if (oosEnabled) {
    if (testN < 20) {
      oosHtml = `<br><span style="color:var(--warn, #ff9f0a);">⚠️ 测试集样本过少（n=${testN} < 20），样本外验证结果仅供参考。</span>`;
    } else if (Number.isFinite(testR2)) {
      const gap = r2 - testR2;
      const overfitWarn = gap > 0.2 ? `<br><span style="color:var(--warn, #ff9f0a);">⚠️ 训练集 R² 与测试集 R² 差距较大（${gap.toFixed(3)}），模型可能过拟合，谨慎作为决策依据。</span>` : '';
      oosHtml = `<br><b>训练集 R²:</b> ${r2.toFixed(4)} &nbsp; <b>测试集 R²（样本外):</b> ${testR2.toFixed(4)} &nbsp; <span style="color:var(--text-muted)">（n_train=${n}, n_test=${testN}）</span>${overfitWarn}`;
    } else {
      oosHtml = '<br><span style="color:var(--text-muted)">测试集上无法计算样本外 R²（可能预测值或真实值方差为 0）。</span>';
    }
  }

  document.getElementById('importanceResult').innerHTML =
    `<b>完整样本数:</b> ${n} &nbsp; <b>R²:</b> ${r2.toFixed(4)} &nbsp; <b>调整 R²:</b> ${Number.isFinite(adjR2) ? adjR2.toFixed(4) : '-'} &nbsp;
    <span style="color:var(--text-muted)">（这 ${k} 个字段合计能解释 ${targetField} 方差的 ${(Math.max(0, adjR2 || r2) * 100).toFixed(1)}%；标准化系数：每变化 1 个标准差对目标的独立贡献，符号=方向，绝对值=强度）</span>${oosHtml}`;

  Plotly.newPlot('importanceChart', [{
    x: result.map(r => r.beta),
    y: result.map(r => r.field),
    type: 'bar', orientation: 'h',
    marker: { color: result.map(r => r.beta >= 0 ? '#30d158' : '#ff453a') }
  }], darkLayout({
    title: `${targetField} 的标准化回归系数（按绝对值排序）`,
    xaxis: { title: '标准化系数 β' },
    margin: { t: 50, l: Math.min(280, 60 + Math.max(...result.map(r => r.field.length)) * 6) }
  }), { responsive: true });

  coefBody.innerHTML = result.map(r => `
    <tr>
      <td>${escapeHtml(r.field)}</td>
      <td class="num">${r.beta.toFixed(4)}</td>
      <td class="num">${Number.isFinite(r.r) ? r.r.toFixed(4) : '-'}</td>
      <td class="num">${Number.isFinite(r.vif) ? r.vif.toFixed(1) : '∞'}</td>
      <td>${vifBadge(r.vif)}</td>
    </tr>
  `).join('');
}

// ---------- 3.5 特征组合探索 ----------
function interactionExpr(a, b, op) {
  if (op === 'ratio') return `${a} / ${b}`;
  if (op === 'diff') return `${a} - ${b}`;
  return `${a} × ${b}`;
}

// 组装字段名只允许字母/数字/下划线/点，原始字段名里的其它符号（如空格、括号）统一替换成下划线
function sanitizeForFieldName(f) {
  return f.replace(/[^a-zA-Z0-9_.]/g, '_');
}

function interactionFieldName(a, b, op) {
  const opTag = op === 'ratio' ? 'div' : op === 'diff' ? 'minus' : 'times';
  return `custom.${sanitizeForFieldName(a)}_${opTag}_${sanitizeForFieldName(b)}`;
}

function interactionFieldCode(a, b, op) {
  const aExpr = `f[${JSON.stringify(a)}]`;
  const bExpr = `f[${JSON.stringify(b)}]`;
  if (op === 'ratio') return `${bExpr} !== 0 ? ${aExpr} / ${bExpr} : NaN`;
  if (op === 'diff') return `${aExpr} - ${bExpr}`;
  return `${aExpr} * ${bExpr}`;
}

function computeFeatureInteractions(fields, ops, targetField) {
  const results = [];
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const A = fields[i], B = fields[j];
      for (const op of ops) {
        const pairs = [];
        for (const row of activeRows) {
          const av = getFeature(row, A), bv = getFeature(row, B), tv = getFeature(row, targetField);
          if (!isFiniteNumber(av) || !isFiniteNumber(bv) || !isFiniteNumber(tv)) continue;
          let dv;
          if (op === 'ratio') { if (bv === 0) continue; dv = av / bv; }
          else if (op === 'diff') dv = av - bv;
          else dv = av * bv;
          if (!Number.isFinite(dv)) continue;
          pairs.push({ av, bv, tv, dv });
        }
        // 完整案例太少时相关系数不稳定，直接跳过而不是硬凑一个没有意义的结果
        if (pairs.length < 10) continue;
        const rNew = pearson(pairs.map(p => [p.dv, p.tv]));
        const rA = pearson(pairs.map(p => [p.av, p.tv]));
        const rB = pearson(pairs.map(p => [p.bv, p.tv]));
        if (!Number.isFinite(rNew)) continue;
        const baseMax = Math.max(Number.isFinite(rA) ? Math.abs(rA) : 0, Number.isFinite(rB) ? Math.abs(rB) : 0);
        const improvement = Math.abs(rNew) - baseMax;
        // 只保留比两个原始字段单独的 r 都更强、且提升幅度 >= 0.05 的组合，避免展示大量无意义的微弱提升
        if (improvement < 0.05) continue;
        results.push({ a: A, b: B, op, rNew, rA, rB, improvement, n: pairs.length });
      }
    }
  }
  results.sort((x, y) => Math.abs(y.rNew) - Math.abs(x.rNew));
  return results;
}

function renderFeatureInteractions(fields, ops, targetField) {
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  if (fields.length < 2) { showToast('请至少选择 2 个候选字段'); return; }
  if (fields.length > 15) { showToast(`候选字段数量（${fields.length}）超过上限 15 个，请减少后再运行。`); return; }
  if (!ops.length) { showToast('请至少勾选一种运算方式'); return; }

  const warnEl = document.getElementById('interactionWarning');
  if (fields.length > 10) {
    warnEl.classList.remove('hidden');
    warnEl.textContent = `字段较多（${fields.length} 个），组合评估可能比较慢，建议减少到 10 个以内。`;
  } else {
    warnEl.classList.add('hidden');
  }

  const results = computeFeatureInteractions(fields, ops, targetField);
  const summaryEl = document.getElementById('interactionSummary');
  const totalCombos = fields.length * (fields.length - 1) / 2 * ops.length;
  summaryEl.textContent = `共评估 ${totalCombos} 种组合，其中 ${results.length} 种比原始字段单独表现更强（|r| 提升 ≥ 0.05）。`;

  document.getElementById('interactionBody').innerHTML = results.map(r => `
    <tr>
      <td>${escapeHtml(interactionExpr(r.a, r.b, r.op))}</td>
      <td class="num">${r.rNew.toFixed(4)}</td>
      <td class="num">${Number.isFinite(r.rA) ? r.rA.toFixed(4) : '-'}</td>
      <td class="num">${Number.isFinite(r.rB) ? r.rB.toFixed(4) : '-'}</td>
      <td class="num">+${r.improvement.toFixed(4)}</td>
      <td class="num">${r.n}</td>
      <td><button type="button" class="addInteractionFieldBtn" data-a="${escapeHtml(r.a)}" data-b="${escapeHtml(r.b)}" data-op="${r.op}">加入组装字段库</button></td>
    </tr>
  `).join('') || '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">没有找到比原始字段更强的组合</td></tr>';

  document.querySelectorAll('.addInteractionFieldBtn').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = btn.dataset.a, b = btn.dataset.b, op = btn.dataset.op;
      const name = interactionFieldName(a, b, op);
      const code = interactionFieldCode(a, b, op);
      if (customFields.some(c => c.name === name)) { showToast(`字段 ${name} 已存在于组装字段库中`); return; }
      customFields.push({ name, code });
      saveCustomFields();
      refreshAfterCustomFieldChange();
      btn.textContent = '已加入 ✓';
      btn.disabled = true;
    });
  });
}

// ---------- 3.6 组合评分（多字段综合打分） ----------
// 训练/评估结果暂存，供"训练并评估"和"写入工作集"两个按钮共享（写入时对全量 matchedRows 复用训练集算出的标准化参数）
let lastCompositeSpec = null; // { targetField, fields: [{field, rho, direction, weight, mean, std, n}], weightMethod, trainN, testN }

// 用训练集的 mean/std 把该行每个评分字段标准化并截断到 ±3（防极端值主导整体评分），
// 按方向（Spearman ρ 符号）和权重加权平均；某字段缺失时跳过该字段（只用剩余字段的权重归一化），
// 全部字段都缺失时返回 NaN（不给一个建立在 0 个真实观测上的评分）
function computeCompositeRowScore(row, spec) {
  let wSum = 0, scoreSum = 0, missing = 0;
  for (const f of spec.fields) {
    const v = getFeature(row, f.field);
    if (!isFiniteNumber(v)) { missing++; continue; }
    const z = f.std > 1e-12 ? (Number(v) - f.mean) / f.std : 0;
    const zc = Math.max(-3, Math.min(3, z));
    scoreSum += f.direction * f.weight * zc;
    wSum += f.weight;
  }
  if (wSum <= 0) return null;
  return { score: scoreSum / wSum, missing };
}

function renderCompositeScore(targetField, fields, weightMethod, splitOptions) {
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  if (fields.length < 2) { showToast('请至少选择 2 个评分字段'); return; }
  if (fields.length > 15) { showToast(`评分字段数量（${fields.length}）超过上限 15 个，请减少后再运行。`); return; }

  const completeRows = activeRows.filter(r => isFiniteNumber(getFeature(r, targetField)));
  if (completeRows.length < 20) { showToast(`有效样本（含目标字段 ${targetField}）仅 ${completeRows.length} 条，太少无法训练/评估组合评分`); return; }

  const { train, test } = splitTrainTest(completeRows, splitOptions.method, splitOptions.ratio, 'swapBeginTime', splitOptions.seed);
  if (train.length < 10 || test.length < 10) {
    showToast(`训练集（${train.length}）或测试集（${test.length}）样本过少，请调整训练集比例`);
    return;
  }

  // 训练集上确定方向/权重/标准化参数——绝不用测试集数据参与这一步，否则"测试集评估"就失去了验证意义
  const specs = [];
  const excluded = [];
  for (const f of fields) {
    const pairs = [];
    for (const r of train) {
      const fv = getFeature(r, f), tv = getFeature(r, targetField);
      if (isFiniteNumber(fv) && isFiniteNumber(tv)) pairs.push([Number(fv), Number(tv)]);
    }
    if (pairs.length < 10) { excluded.push(`${f}（训练集有效样本仅 ${pairs.length} 条，<10）`); continue; }
    const rho = spearman(pairs);
    if (!Number.isFinite(rho) || rho === 0) { excluded.push(`${f}（训练集 ρ 不可用或为 0，无法确定方向）`); continue; }
    const vals = pairs.map(p => p[0]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance);
    const direction = rho >= 0 ? 1 : -1;
    const weight = weightMethod === 'rho' ? Math.abs(rho) : 1;
    specs.push({ field: f, rho, direction, weight, mean, std, n: pairs.length });
  }

  if (specs.length < 2) {
    showToast(`训练集上可用于组合评分的字段不足 2 个${excluded.length ? '（' + excluded.join('；') + '）' : ''}，请更换字段或增大数据集`);
    return;
  }

  lastCompositeSpec = { targetField, fields: specs, weightMethod, trainN: train.length, testN: test.length };
  document.getElementById('applyCompositeScoreBtn').classList.add('hidden'); // 每次重新训练后需要重新确认再写入，避免用旧结果覆盖

  // 测试集评估：评分与目标的相关性（评分是排名/方向的加权混合，秩相关比线性相关更贴切，Pearson 仅作对照）
  const testPairs = [];
  for (const r of test) {
    const tv = getFeature(r, targetField);
    if (!isFiniteNumber(tv)) continue;
    const res = computeCompositeRowScore(r, lastCompositeSpec);
    if (res && Number.isFinite(res.score)) testPairs.push([res.score, Number(tv)]);
  }
  const testRho = testPairs.length >= 5 ? spearman(testPairs) : NaN;
  const testR = testPairs.length >= 5 ? pearson(testPairs) : NaN;

  document.getElementById('compositeSpecBody').innerHTML = specs.map(s => `
    <tr>
      <td>${escapeHtml(s.field)}</td>
      <td class="num">${s.rho.toFixed(4)}</td>
      <td>${s.direction > 0 ? '正向（越大越好）' : '反向（越小越好）'}</td>
      <td class="num">${s.weight.toFixed(4)}</td>
      <td class="num">${s.n}</td>
    </tr>
  `).join('');

  const warnEl = document.getElementById('compositeWarning');
  const warnings = [];
  if (excluded.length) warnings.push(`⚠️ 以下字段已自动剔除，未参与评分：${excluded.map(escapeHtml).join('；')}`);
  if (test.length < 20) warnings.push(`⚠️ 测试集样本过少（n=${test.length} < 20），评估结果仅供参考。`);
  if (Number.isFinite(testRho) && Math.abs(testRho) < 0.1) warnings.push(`⚠️ 评分在测试集上与目标的秩相关很弱（ρ=${testRho.toFixed(3)}），组合评分可能没有实际筛选能力，谨慎采信。`);
  if (warnings.length) { warnEl.classList.remove('hidden'); warnEl.innerHTML = warnings.join('<br>'); }
  else warnEl.classList.add('hidden');

  document.getElementById('compositeSummary').innerHTML =
    `训练集 n=${train.length}，测试集 n=${test.length}（切分：${splitOptions.method === 'time' ? '按时间顺序' : '随机（种子 ' + splitOptions.seed + '，锁定可复现）'}）。`
    + ` 评分与 <b>${escapeHtml(targetField)}</b> 在测试集上的 Spearman ρ = <b>${Number.isFinite(testRho) ? testRho.toFixed(4) : '-'}</b>，`
    + ` Pearson r = ${Number.isFinite(testR) ? testR.toFixed(4) : '-'}（n=${testPairs.length}）。`;

  // 测试集评分五分位分层：直接看"评分越高，未来收益是否真的越好"，比单一相关系数更直观、也更贴近实际使用场景（按评分筛 token）
  const sortedByScore = testPairs.slice().sort((a, b) => a[0] - b[0]);
  const qCount = 5;
  const bucketSize = Math.ceil(sortedByScore.length / qCount);
  const buckets = [];
  for (let i = 0; i < qCount; i++) {
    const chunk = sortedByScore.slice(i * bucketSize, (i + 1) * bucketSize);
    if (!chunk.length) continue;
    const targets = chunk.map(p => p[1]);
    const mean = targets.reduce((a, b) => a + b, 0) / targets.length;
    const sortedT = targets.slice().sort((a, b) => a - b);
    const median = percentile(sortedT, 0.5);
    const winRate = targets.filter(v => v > 1).length / targets.length;
    buckets.push({
      label: `Q${i + 1}${i === qCount - 1 ? '（最高）' : i === 0 ? '（最低）' : ''}`,
      lo: chunk[0][0], hi: chunk[chunk.length - 1][0],
      n: chunk.length, mean, median, winRate
    });
  }
  document.getElementById('compositeDecileBody').innerHTML = buckets.map(b => `
    <tr>
      <td>${b.label}</td>
      <td class="num">[${b.lo.toFixed(3)}, ${b.hi.toFixed(3)}]</td>
      <td class="num">${b.n}</td>
      <td class="num">${formatNumberSmart(b.mean)}</td>
      <td class="num">${formatNumberSmart(b.median)}</td>
      <td class="num">${(b.winRate * 100).toFixed(1)}%</td>
    </tr>
  `).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">测试集样本不足，无法分层</td></tr>';

  document.getElementById('applyCompositeScoreBtn').classList.remove('hidden');
}

// 把最近一次训练好的评分（含训练集算出的标准化参数）应用到全量 matchedRows，写入 features.composite_score，
// 供散点图/过滤/分箱柱状图等下游功能直接当成一个普通数值字段使用。不经过自定义字段的公式引擎，因为
// 权重/方向/标准化参数是训练产物而不是用户手写的公式。
function applyCompositeScore() {
  if (!lastCompositeSpec) { showToast('请先点击"训练并评估"'); return; }
  if (!matchedRows.length) { showToast('请先点击"分析"加载数据'); return; }
  let written = 0;
  for (const r of matchedRows) {
    const res = computeCompositeRowScore(r, lastCompositeSpec);
    if (res && Number.isFinite(res.score)) { r.features.composite_score = res.score; written++; }
    else delete r.features.composite_score;
  }
  FIELD_DESC['composite_score'] = `组合评分：基于字段 ${lastCompositeSpec.fields.map(f => f.field).join('、')} 在训练集上确定方向/权重后合成（目标 ${lastCompositeSpec.targetField}）`;
  allNumericKeys = [...new Set([...matchedRows.flatMap(r => Object.keys(r.features)), ...DERIVED_KEYS, ...SIGNAL_KEYS, ...customFields.map(c => c.name)])].sort();
  updateScatterSelects();
  refreshAnalysisViews();
  showToast(`已把组合评分写入 composite_score（${written}/${matchedRows.length} 条样本有效），可在散点图/过滤/分箱柱状图里直接使用`);
}

// ---------- 4. 时间维度分析 ----------
function renderTimeAnalysis(featureField, targetField, bucketCount) {
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  const withTime = activeRows.filter(r => isFiniteNumber(r.swapBeginTime));
  if (withTime.length < 10) { showToast('有效的 swap_begin_time 样本太少（< 10），无法做时间分桶分析'); return; }
  const times = withTime.map(r => r.swapBeginTime);
  const minT = Math.min(...times), maxT = Math.max(...times);
  if (maxT <= minT) { showToast('样本的开仓时间几乎相同，无法分桶'); return; }
  const n = Math.max(2, Math.min(30, Math.round(bucketCount) || 8));
  const step = (maxT - minT) / n;
  const buckets = Array.from({ length: n }, (_, i) => ({
    lo: minT + i * step, hi: i === n - 1 ? maxT + 1 : minT + (i + 1) * step, rows: []
  }));
  for (const row of withTime) {
    const t = row.swapBeginTime;
    const idx = Math.min(n - 1, Math.floor((t - minT) / step));
    buckets[idx].rows.push(row);
  }
  const fmtDate = t => {
    // swap_begin_time 假定为 Unix 秒；若数值明显是毫秒级（>1e12），按毫秒处理
    const ms = t > 1e12 ? t : t * 1000;
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const stats = buckets.map(b => {
    const targets = b.rows.map(r => getFeature(r, targetField)).filter(isFiniteNumber).map(Number);
    const mean = targets.length ? targets.reduce((a, v) => a + v, 0) / targets.length : NaN;
    const winRate = targets.length ? targets.filter(v => v > 1).length / targets.length : NaN;
    let r = NaN;
    if (featureField) {
      const pairs = [];
      for (const row of b.rows) {
        const fv = getFeature(row, featureField), tv = getFeature(row, targetField);
        if (isFiniteNumber(fv) && isFiniteNumber(tv)) pairs.push([Number(fv), Number(tv)]);
      }
      if (pairs.length >= 5) r = pearson(pairs);
    }
    return { label: `${fmtDate(b.lo)}~${fmtDate(b.hi)}`, n: b.rows.length, mean, winRate, r };
  }).filter(s => s.n > 0);

  const traces = [{
    x: stats.map(s => s.label), y: stats.map(s => s.winRate * 100),
    type: 'bar', name: '胜率(%)',
    marker: { color: '#0a84ff' }
  }];
  if (featureField) {
    traces.push({
      x: stats.map(s => s.label), y: stats.map(s => Number.isFinite(s.r) ? s.r : null),
      type: 'scatter', mode: 'lines+markers', name: `${featureField} 与 ${targetField} 的 r`,
      yaxis: 'y2', line: { color: '#ff9f0a' }
    });
  }
  Plotly.newPlot('timeAnalysisChart', traces, darkLayout({
    title: `按开仓时间分 ${n} 桶：胜率${featureField ? ' 与特征相关性' : ''}是否随时间漂移`,
    yaxis: { title: '胜率(%)' },
    yaxis2: featureField ? { title: 'r', overlaying: 'y', side: 'right', range: [-1, 1] } : undefined,
    margin: { t: 50 }
  }), { responsive: true });

  document.getElementById('timeAnalysisBody').innerHTML = stats.map(s => `
    <tr>
      <td>${escapeHtml(s.label)}</td>
      <td class="num">${s.n}</td>
      <td class="num">${Number.isFinite(s.winRate) ? (s.winRate * 100).toFixed(1) + '%' : '-'}</td>
      <td class="num">${Number.isFinite(s.mean) ? formatNumberSmart(s.mean) : '-'}</td>
      <td class="num">${Number.isFinite(s.r) ? s.r.toFixed(4) : '-'}</td>
    </tr>
  `).join('');

  timeAnalysisData = stats;
  // 自动检测最近的桶相比历史均值胜率是否明显下降——用最后 20%（至少 1 个）的桶 vs 其余桶做对比
  const summaryEl = document.getElementById('timeAnalysisSummary');
  const withWinRate = stats.filter(s => Number.isFinite(s.winRate));
  const recentCount = Math.max(1, Math.round(withWinRate.length * 0.2));
  if (withWinRate.length - recentCount >= 2) {
    const recent = withWinRate.slice(-recentCount);
    const earlier = withWinRate.slice(0, -recentCount);
    const recentAvg = recent.reduce((a, s) => a + s.winRate, 0) / recent.length;
    const earlierAvg = earlier.reduce((a, s) => a + s.winRate, 0) / earlier.length;
    const dropPct = (earlierAvg - recentAvg) * 100;
    summaryEl.textContent = dropPct > 10
      ? `⚠️ 最近 ${recentCount} 个时间桶的胜率（${(recentAvg * 100).toFixed(1)}%）相比此前均值（${(earlierAvg * 100).toFixed(1)}%）下降了 ${dropPct.toFixed(1)} 个百分点，策略可能正在失效，建议结合具体时间段核查。`
      : '';
  } else {
    summaryEl.textContent = '';
  }
}

function downloadTimeAnalysisCsv() {
  if (!timeAnalysisData.length) { showToast('请先生成时间分析'); return; }
  const rows = timeAnalysisData.map(s => [s.label, s.n, Number.isFinite(s.winRate) ? (s.winRate * 100).toFixed(2) : '', Number.isFinite(s.mean) ? s.mean : '', Number.isFinite(s.r) ? s.r.toFixed(4) : '']);
  downloadCsvGeneric('time_analysis_buckets.csv', ['时间段', '样本数', '胜率(%)', '均值', '与特征的r'], rows);
}

// ---------- 4B. 相关性随时间漂移（滚动窗口） ----------
function renderRollingCorrelation(featureField, targetField, windowDays, stepDays) {
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  if (!featureField) { showToast('请填写特征字段'); return; }
  const withTime = activeRows.filter(r => isFiniteNumber(r.swapBeginTime));
  if (withTime.length < 10) { showToast('有效的 swap_begin_time 样本太少（< 10），无法做滚动窗口相关性分析'); return; }

  // swap_begin_time 假定为 Unix 秒；若数值明显是毫秒级（>1e12），统一换算成秒，避免窗口大小算错
  const toSec = t => (t > 1e12 ? t / 1000 : t);
  const timed = withTime.map(r => ({ row: r, t: toSec(r.swapBeginTime) })).sort((a, b) => a.t - b.t);
  const minT = timed[0].t, maxT = timed[timed.length - 1].t;
  const spanDays = (maxT - minT) / 86400;
  if (spanDays < 1) { showToast('当前样本时间跨度不足以进行有意义的时间维度分析（不足 1 天），建议放宽全局过滤条件'); return; }

  const windowSec = Math.max(0.01, windowDays) * 86400;
  const stepSec = Math.max(0.01, stepDays) * 86400;
  const windowCount = Math.floor((maxT - minT) / stepSec) + 1;
  if (windowCount > 200) { showToast(`当前窗口/步长设置会产生 ${windowCount} 个滚动窗口，过多不利于渲染和阅读，请调大步长或窗口大小`); return; }

  const LOW_N_THRESHOLD = 10;
  const points = [];
  for (let start = minT; start <= maxT; start += stepSec) {
    const end = start + windowSec;
    const pairs = [];
    for (const { row, t } of timed) {
      if (t < start || t >= end) continue;
      const fv = getFeature(row, featureField), tv = getFeature(row, targetField);
      if (isFiniteNumber(fv) && isFiniteNumber(tv)) pairs.push([Number(fv), Number(tv)]);
    }
    const r = pairs.length >= 5 ? pearson(pairs) : NaN;
    points.push({ end, n: pairs.length, r });
  }
  if (!points.some(p => Number.isFinite(p.r))) { showToast('每个滚动窗口内有效样本都不足 5 个，无法计算相关性，请调大窗口大小'); return; }

  const fmtDate = t => { const d = new Date(t * 1000); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };

  Plotly.newPlot('rollingCorrChart', [{
    x: points.map(p => fmtDate(p.end)),
    y: points.map(p => Number.isFinite(p.r) ? p.r : null),
    type: 'scatter', mode: 'lines+markers',
    marker: {
      color: '#0a84ff',
      size: points.map(p => p.n < LOW_N_THRESHOLD ? 6 : 9),
      opacity: points.map(p => p.n < LOW_N_THRESHOLD ? 0.35 : 1),
      symbol: points.map(p => p.n < LOW_N_THRESHOLD ? 'circle-open' : 'circle')
    },
    line: { color: '#0a84ff' },
    text: points.map(p => `n=${p.n}`),
    hovertemplate: '%{x}<br>r=%{y:.4f}<br>%{text}<extra></extra>'
  }], darkLayout({
    title: `${featureField} 与 ${targetField} 的滚动窗口相关性（窗口=${windowDays}天，步长=${stepDays}天）`,
    yaxis: { title: 'r', range: [-1, 1] },
    margin: { t: 50 }
  }), { responsive: true });

  document.getElementById('rollingCorrNote').textContent =
    `空心/半透明点表示该窗口样本数 < ${LOW_N_THRESHOLD}（低置信度：这段的 r 值本身不稳定，不代表真实趋势变化，不要把波动误读成"信号真的变了"）。`;

  rollingCorrData = points;
}

function downloadRollingCorrCsv() {
  if (!rollingCorrData.length) { showToast('请先生成滚动相关性图表'); return; }
  const rows = rollingCorrData.map(p => [new Date(p.end * 1000).toISOString(), p.n, Number.isFinite(p.r) ? p.r.toFixed(6) : '']);
  downloadCsvGeneric('rolling_correlation.csv', ['window_end', 'n', 'r'], rows);
}

// ---------- 5. 分类字段与收益关系（箱线图 + 胜率对比 + 显著性检验） ----------
async function renderCatAnalysis(catField, breakpointsText, valueField, sigTestEnabled) {
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  if (!catField || !valueField) { showToast('请填写分类字段和目标数值字段'); return; }
  const breakpoints = breakpointsText ? parseBreakpoints(breakpointsText) : [];
  const groups = new Map();
  for (const row of activeRows) {
    const key = computeGroupKey(row, catField, breakpoints);
    const vv = getFeature(row, valueField);
    if (!isFiniteNumber(vv)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(Number(vv));
  }
  if (!groups.size) { showToast('没有可用数据，请检查字段是否正确'); return; }
  // 分类值过多（比如误把连续数值字段当分类字段）时箱线图会失去意义，这里提示但不阻断
  if (groups.size > 15) {
    if (!await showConfirm(`检测到 ${groups.size} 个不同分类值，类别过多不利于阅读，可能不是合适的分类字段，是否继续？`)) return;
  }

  const entries = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  Plotly.newPlot('catAnalysisChart', entries.map(([key, vals], i) => ({
    y: vals, type: 'box', name: key, boxmean: true,
    marker: { color: palette[i % palette.length] }
  })), darkLayout({
    title: `${valueField} 按 ${catField} 分类的分布（箱线图）`,
    yaxis: { title: valueField },
    margin: { t: 50 }
  }), { responsive: true });

  // 样本数 < 5 的分类不纳入显著性检验（避免极小样本拉低整体检验的可靠性），
  // 汇总表里仍展示这些分类，但均值/中位数标注"样本过少，仅供参考"
  const MIN_SIG_N = 5;
  const rows = entries.map(([key, vals]) => {
    const stats = calcStats(vals, WIN_THRESHOLD);
    return { key, n: stats.count, mean: stats.mean, median: stats.median, winRate: stats.winRate, vals, tooFew: stats.count < MIN_SIG_N };
  });
  document.getElementById('catAnalysisBody').innerHTML = rows.map(s => `
    <tr>
      <td>${escapeHtml(s.key)}</td>
      <td class="num">${s.n}</td>
      <td class="num">${formatNumberSmart(s.mean)}${s.tooFew ? ' <span style="color:var(--text-muted)">(样本过少，仅供参考)</span>' : ''}</td>
      <td class="num">${formatNumberSmart(s.median)}</td>
      <td class="num">${(s.winRate * 100).toFixed(1)}%</td>
    </tr>
  `).join('');

  const summaryEl = document.getElementById('catAnalysisSummary');
  const validGroups = rows.filter(s => !s.tooFew);
  if (!sigTestEnabled || validGroups.length < 2) {
    summaryEl.textContent = sigTestEnabled ? '有效分组（样本数≥5）不足 2 个，无法进行显著性检验。' : '';
    return;
  }
  if (validGroups.length === 2) {
    const { t, df, p, mean1, mean2 } = welchTTest(validGroups[0].vals, validGroups[1].vals);
    const higher = mean1 >= mean2 ? validGroups[0].key : validGroups[1].key;
    summaryEl.innerHTML = `${escapeHtml(catField)} 两组间收益差异${p < 0.05 ? '<b style="color:var(--accent)">显著</b>' : '不显著'}（Welch's t=${t.toFixed(3)}, df≈${Number.isFinite(df) ? df.toFixed(1) : '-'}, p=${p.toExponential(2)}），其中 "${escapeHtml(higher)}" 组均值更高。<span style="color:var(--text-muted)">（p 值为大样本正态近似，样本量较小时结果仅供参考）</span>`;
  } else {
    const { F, p, df1, df2 } = anovaFTest(validGroups.map(g => g.vals));
    const topGroup = validGroups.reduce((a, b) => (b.mean > a.mean ? b : a));
    summaryEl.innerHTML = Number.isFinite(p)
      ? `${escapeHtml(catField)} 各组间收益差异${p < 0.05 ? '<b style="color:var(--accent)">显著</b>' : '不显著'}（简化 ANOVA F=${F.toFixed(3)}, df=(${df1},${df2}), p=${p.toExponential(2)}），其中 "${escapeHtml(topGroup.key)}" 组均值最高。<span style="color:var(--text-muted)">（简化版检验，p 值为近似值，不追求和专业统计软件完全一致，仅供方向参考）</span>`
      : '有效样本不足，无法计算 ANOVA。';
  }
}

// ---------- 6. 阈值优化（ROC-AUC 分析） ----------
// AUC 置信区间的重抽样次数。单字段和批量对比用不同的档位：单字段只算一次，可以给足次数换精度；
// 批量对比要对几十个字段各跑一遍，次数太高会明显拖慢，300 次已经够把"跨没跨过 0.5"这件事判准。
const ROC_BOOTSTRAP_B = 1000;
const ROC_BATCH_BOOTSTRAP_B = 300;

// AUC 显著性判定：置信区间完全落在 0.5 一侧才算"优于随机猜测"。
// 跨过 0.5 就意味着——这个字段和抛硬币在统计上分不出高下，点估计再好看也不能用。
function aucVerdict(auc, ci) {
  if (!ci || !Number.isFinite(ci.lo)) return { text: '-', color: 'var(--text-muted)', significant: false };
  if (ci.lo > 0.5) return { text: '优于随机', color: 'var(--ok, #30d158)', significant: true };
  if (ci.hi < 0.5) return { text: '反向有效', color: 'var(--ok, #30d158)', significant: true };
  return { text: '不显著', color: 'var(--text-muted)', significant: false };
}
function collectRocSamples(field, targetField, winThreshold) {
  const values = [], labels = [];
  for (const row of activeRows) {
    const fv = getFeature(row, field);
    const tv = getFeature(row, targetField);
    if (isFiniteNumber(fv) && isFiniteNumber(tv)) {
      values.push(Number(fv));
      labels.push(Number(tv) > winThreshold ? 1 : 0);
    }
  }
  return { values, labels };
}

// 自动检测方向：先按"越大越可能盈利"算一次 AUC，如果 < 0.5 说明方向反了，直接翻转方向重新计算
// （等价于取 1-AUC，但重新算一次能顺带拿到翻转方向下真实的最优切点/精确率/召回率，逻辑更直观）
function resolveRocDirection(values, labels, directionParam) {
  if (directionParam !== 'auto') return { direction: directionParam, roc: computeROC(values, labels, directionParam) };
  const higherRoc = computeROC(values, labels, 'higher');
  if (higherRoc.auc >= 0.5) return { direction: 'higher', roc: higherRoc };
  return { direction: 'lower', roc: computeROC(values, labels, 'lower') };
}

function renderRocSingle(field, targetField, winThreshold, directionParam) {
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  if (!field) { showToast('请填写候选字段'); return; }
  const { values, labels } = collectRocSamples(field, targetField, winThreshold);
  if (values.length < 20) { showToast('有效样本数过少（<20），ROC/AUC 估计不可靠，请检查字段或放宽过滤条件'); return; }
  const positives = labels.reduce((a, b) => a + b, 0);
  if (positives === 0 || positives === values.length) {
    showToast('当前样本全部是"赢"或全部是"输"，无法计算 ROC/AUC，请检查盈利判定阈值是否合理');
    return;
  }

  const { direction, roc } = resolveRocDirection(values, labels, directionParam);
  const { points, best, positives: P, negatives: N } = roc;
  // 点估计和置信区间必须用同一个算法：computeROC 的 AUC 是对下采样后的 100 个阈值做梯形积分，
  // 样本数 > 100 时是近似值（实测偏差在 1e-4 量级），而 CI 用的 rankAuc 是秩和精确解。
  // 两边混用会出现"点估计落在自己置信区间外"这种没法解释的展示，这里统一取精确值。
  // roc.points 仍用于画曲线——曲线本来就是按候选阈值逐点画的，下采样不影响观感。
  const auc = rankAuc(values, labels, direction);
  const precision = Number.isFinite(best.precision) ? best.precision : 0;
  const recall = best.tpr;

  Plotly.newPlot('rocChart', [
    {
      x: points.map(p => p.fpr), y: points.map(p => p.tpr),
      mode: 'lines+markers', type: 'scatter', name: 'ROC 曲线',
      line: { color: '#0a84ff' }
    },
    {
      x: [0, 1], y: [0, 1], mode: 'lines', type: 'scatter', name: '随机猜测基准 (AUC=0.5)',
      line: { dash: 'dash', color: '#98989d' }
    },
    {
      x: [best.fpr], y: [best.tpr], mode: 'markers', type: 'scatter', name: 'Youden 最优点',
      marker: { color: '#30d158', size: 12, symbol: 'star' }
    }
  ], darkLayout({
    title: `${field} 判定 "${targetField} > ${winThreshold}" 的 ROC 曲线（方向：${direction === 'higher' ? '越大越可能盈利' : '越小越可能盈利'}）`,
    xaxis: { title: 'FPR（假阳性率）', range: [0, 1] },
    yaxis: { title: 'TPR（真阳性率）', range: [0, 1] },
    margin: { t: 50 }
  }), { responsive: true });

  const ci = bootstrapAucCI(values, labels, direction, ROC_BOOTSTRAP_B);
  const verdict = aucVerdict(auc, ci);
  const ciText = Number.isFinite(ci.lo) ? `[${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]` : '样本不足，无法估计';
  // Youden 最优点落在多少个样本上——精确率是从这几个样本里算出来的，样本太少时这个百分比
  // 极不稳定（用户很容易把"16 个样本里 9 个赢"的 56% 当成真实提升），必须显式标出来
  const tpAtBest = Number.isFinite(best.tp) ? best.tp : NaN;
  const fpAtBest = Number.isFinite(best.fp) ? best.fp : NaN;
  const nAtBest = tpAtBest + fpAtBest;
  const baseRate = P / (P + N);
  const precisionNote = Number.isFinite(nAtBest) && nAtBest > 0
    ? `该精确率只由 <b>${nAtBest}</b> 个被选中样本算出（${tpAtBest} 赢 / ${fpAtBest} 输），基准率为 ${(baseRate * 100).toFixed(1)}%。`
      + (nAtBest < 30 ? `<span style="color:var(--warn, #ff9f0a)">选中样本不足 30 个，这个百分比的波动范围很大，不要直接当成真实提升。</span>` : '')
    : '';

  document.getElementById('rocSummary').innerHTML =
    `该字段 AUC=<b>${auc.toFixed(3)}</b>，95% 置信区间 <b>${ciText}</b>（重抽样 ${ROC_BOOTSTRAP_B} 次），<b style="color:${verdict.color}">${verdict.text}</b>。`
    + (verdict.significant
        ? ''
        : `<span style="color:var(--warn, #ff9f0a)"> 区间跨过 0.5，说明该字段与随机猜测在统计上无法区分，下面的建议阈值不具备参考价值。</span>`)
    + `<br>作为筛选条件时建议阈值设为 <b>${formatNumberSmart(best.threshold)}</b>（${direction === 'higher' ? `${escapeHtml(field)} ≥ 该值` : `${escapeHtml(field)} ≤ 该值`}），此时能筛出 <b>${(recall * 100).toFixed(1)}%</b> 的赢家（召回率），同时预测为"赢"的样本里有 <b>${(precision * 100).toFixed(1)}%</b> 真的赢了（精确率）。<span style="color:var(--text-muted)">（正样本 n=${P}，负样本 n=${N}）</span>`
    + (precisionNote ? `<br>${precisionNote}` : '')
    + `<br><span style="color:var(--text-muted)">注意：Youden 最优点是在所有候选阈值里挑出来的，天然偏乐观；同理，若这个字段是从几十上百个字段里挑出来的，还需要考虑多重比较问题。</span>`;
}

function renderRocBatch(fields, targetField, winThreshold) {
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  if (!fields.length) { showToast('请至少选择 1 个字段'); return; }
  const results = fields.map(field => {
    const { values, labels } = collectRocSamples(field, targetField, winThreshold);
    const positives = labels.reduce((a, b) => a + b, 0);
    if (values.length < 20 || positives === 0 || positives === values.length) {
      return { field, n: values.length, auc: NaN, reason: '样本不足/单一类别' };
    }
    // 取值恒定检测：字段所有样本取值相同（典型如 amm_volume/exchange_volume/scam_volume 常年全 0）时，
    // 秩和 AUC 恰好等于 0.5、bootstrap 每次重抽样结果也一样 → 置信区间宽度为 0（形如 [0.500, 0.500]）。
    // 这不是"测过了没用"，而是【根本没法测】：零方差字段不含任何信息。混在结果里会让人误判成
    // "这个字段试过了、不显著"，实际应该先去数据源确认它为什么恒定。
    const distinct = new Set(values);
    if (distinct.size <= 1) {
      return { field, n: values.length, auc: NaN, reason: `取值恒定（全为 ${formatNumberSmart(values[0])}）` };
    }
    const { direction, roc } = resolveRocDirection(values, labels, 'auto');
    const ci = bootstrapAucCI(values, labels, direction, ROC_BATCH_BOOTSTRAP_B);
    // 同单字段：AUC 取秩和精确解，与置信区间同源
    return { field, n: values.length, auc: rankAuc(values, labels, direction), ci, direction, threshold: roc.best.threshold, precision: roc.best.precision, recall: roc.best.tpr };
  });
  // 先按显著性分层、层内再按 AUC 排：否则一堆"AUC 看着高但区间跨 0.5"的噪声字段会混在真信号
  // 前面，排序结果反而误导人
  results.sort((a, b) => {
    // 无法计算的（恒定/样本不足）一律沉底，它们不是"结论"，只是数据问题
    const va = Number.isFinite(a.auc) ? 1 : 0, vb = Number.isFinite(b.auc) ? 1 : 0;
    if (va !== vb) return vb - va;
    const sa = aucVerdict(a.auc, a.ci).significant ? 1 : 0;
    const sb = aucVerdict(b.auc, b.ci).significant ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return (Number.isFinite(b.auc) ? b.auc : 0) - (Number.isFinite(a.auc) ? a.auc : 0);
  });
  // 顶部提示：有多少字段压根没参与检验，避免"我扫了 9 个字段全不显著"的误读
  const skipped = results.filter(r => !Number.isFinite(r.auc));
  const noteEl = document.getElementById('rocBatchNote');
  if (noteEl) {
    noteEl.innerHTML = skipped.length
      ? `<span style="color:var(--warn,#ff9f0a)">${skipped.length} 个字段未参与检验</span>（${skipped.map(r => escapeHtml(r.field) + '：' + escapeHtml(r.reason)).join('；')}）——这类字段是数据问题，不能算作"测过了不显著"。实际参与检验的是 ${results.length - skipped.length} 个。`
      : '';
  }
  document.getElementById('rocBatchBody').innerHTML = results.map(r => `
    <tr>
      <td>${escapeHtml(r.field)}</td>
      <td class="num">${r.n}</td>
      <td class="num">${Number.isFinite(r.auc) ? r.auc.toFixed(4) : `<span style="color:var(--warn,#ff9f0a)">${escapeHtml(r.reason || '无法计算')}</span>`}</td>
      <td class="num">${r.ci && Number.isFinite(r.ci.lo) ? `[${r.ci.lo.toFixed(3)}, ${r.ci.hi.toFixed(3)}]` : '-'}</td>
      <td style="color:${aucVerdict(r.auc, r.ci).color};">${aucVerdict(r.auc, r.ci).text}</td>
      <td>${r.direction ? (r.direction === 'higher' ? '越大越好' : '越小越好') : '-'}</td>
      <td class="num">${Number.isFinite(r.threshold) ? formatNumberSmart(r.threshold) : '-'}</td>
      <td class="num">${Number.isFinite(r.precision) ? (r.precision * 100).toFixed(1) + '%' : '-'}</td>
      <td class="num">${Number.isFinite(r.recall) ? (r.recall * 100).toFixed(1) + '%' : '-'}</td>
    </tr>
  `).join('');
}

// ---------- 8. CA 定位 & 过滤建议 ----------
// 目标问题：手上有几个"想让未来的过滤规则排除掉"的 CA（比如事后看是坑的 token），
// 想知道它们在"常用字段"上分别处于全量分布的什么位置，以及该往哪个字段加过滤条件、
// 加多严的阈值，才能把这几个 CA 挡掉，同时尽量不误伤"好样本"（returnMax > 2，即翻倍）。
//
// 与 7.相似Case检索 的区别：那个是"给一个基准 token，找历史上像它的其它 token"；
// 这个是"给几个已知目标 token，反推能挡住它们的过滤规则"，输出的是可直接抄进
// 策略过滤条件的 字段+方向+阈值，而不是相似案例列表。

// 按 token_address 优先、symbol 兜底，返回全部匹配行（同一个 CA 可能有多条 call 记录，
// 全部纳入统计而不是只取第一条，避免"这个 CA 到底算高还是算低"因为漏看了其它记录而失真）。
function findRowsByInput(text) {
  const t = text.trim();
  if (!t) return [];
  const byAddr = activeRows.filter(r => r.tokenAddress === t);
  if (byAddr.length) return byAddr;
  return activeRows.filter(r => r.symbol === t);
}

// 二分查找 value 在已排序数组里的百分位排名（0~1，即 <= value 的比例）。
function percentileRankOf(sortedVals, value) {
  if (!sortedVals.length || !isFiniteNumber(value)) return NaN;
  let lo = 0, hi = sortedVals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedVals[mid] <= value) lo = mid + 1; else hi = mid;
  }
  return lo / sortedVals.length;
}

function renderCaAdvisor(caInputText, fields) {
  const summaryEl = document.getElementById('caAdvisorSummary');
  const posHead = document.getElementById('caAdvisorPosHead');
  const posBody = document.getElementById('caAdvisorPosBody');
  const advBody = document.getElementById('caAdvisorAdviceBody');
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  const inputs = [...new Set(caInputText.split(/[\n,，;；\s]+/).map(s => s.trim()).filter(Boolean))];
  if (!inputs.length) { showToast('请输入至少一个 CA 或 symbol（换行/逗号/空格分隔均可）'); return; }
  if (!fields.length) { showToast('请至少选择 1 个字段（可点“导入常用字段”或“导入相关性表 Top10”）'); return; }

  const targetMap = new Map(); // input -> rows[]
  const unmatched = [];
  inputs.forEach(inp => {
    const rows = findRowsByInput(inp);
    if (!rows.length) unmatched.push(inp);
    else targetMap.set(inp, rows);
  });
  if (!targetMap.size) {
    summaryEl.innerHTML = `⚠️ 输入的 ${inputs.length} 个 CA/symbol 在当前工作集里都没有匹配到，请检查拼写，或者它们是否已被上方的全局过滤条件排除。`;
    posHead.innerHTML = ''; posBody.innerHTML = ''; advBody.innerHTML = '';
    return;
  }

  // 每个字段预排序好全量取值（用于百分位查找 + 过滤代价计算），只算一次复用给所有目标 CA。
  const sortedByField = new Map();
  fields.forEach(f => {
    sortedByField.set(f, activeRows.map(r => getFeature(r, f)).filter(isFiniteNumber).sort((a, b) => a - b));
  });
  const winRows = activeRows.filter(r => isFiniteNumber(r.returnMax) && r.returnMax > WIN_THRESHOLD);

  // ---- 定位表：每行 = 一条目标 CA 的匹配记录，每列 = 字段取值 + 百分位 ----
  posHead.innerHTML = `<tr><th>symbol</th><th>token_address</th>${fields.map(f => `<th class="num">${escapeHtml(f)}</th>`).join('')}</tr>`;
  const posRowsHtml = [];
  targetMap.forEach(rows => {
    rows.forEach(r => {
      const cells = fields.map(f => {
        const v = getFeature(r, f);
        const pr = percentileRankOf(sortedByField.get(f), v);
        if (!isFiniteNumber(v) || Number.isNaN(pr)) return '<td class="num" style="color:var(--text-muted);">缺失</td>';
        const pct = Math.round(pr * 100);
        const extreme = pct <= 10 || pct >= 90;
        return `<td class="num"${extreme ? ' style="color:var(--accent); font-weight:600;"' : ''}>${formatNumberSmart(v)}（P${pct}）</td>`;
      }).join('');
      posRowsHtml.push(`<tr><td>${escapeHtml(r.symbol || '-')}</td><td class="ellip" title="${escapeHtml(r.tokenAddress || '')}">${escapeHtml(r.tokenAddress || '-')}</td>${cells}</tr>`);
    });
  });
  posBody.innerHTML = posRowsHtml.join('') || '<tr><td colspan="99" style="text-align:center;color:var(--text-muted);">无匹配结果</td></tr>';

  // ---- 过滤建议表：每个字段推荐一条能排除全部目标 CA 的规则，按"代价"（连带排除掉的好样本比例）升序排 ----
  const allTargetRows = [...targetMap.values()].flat();
  const adviceRows = fields.map(f => {
    const sorted = sortedByField.get(f);
    const tVals = allTargetRows.map(r => getFeature(r, f)).filter(isFiniteNumber);
    if (!sorted.length || !tVals.length) return null;
    const avgPr = tVals.reduce((a, v) => a + percentileRankOf(sorted, v), 0) / tVals.length;
    // 目标值平均偏在分布高位 → 建议"小于阈值才保留"（挡住高值）；反之建议"大于阈值才保留"（挡住低值）
    const dir = avgPr >= 0.5 ? 'high' : 'low';
    const threshold = dir === 'high' ? Math.min(...tVals) : Math.max(...tVals);
    const rule = `${f} ${dir === 'high' ? '<' : '>'} ${formatNumberSmart(threshold)}`;
    const hitCount = dir === 'high' ? tVals.filter(v => v >= threshold).length : tVals.filter(v => v <= threshold).length;
    const excludedAll = dir === 'high' ? sorted.filter(v => v >= threshold).length : sorted.filter(v => v <= threshold).length;
    const cost = excludedAll / sorted.length;
    const winVals = winRows.map(r => getFeature(r, f)).filter(isFiniteNumber);
    let winCost = NaN;
    if (winVals.length) {
      const winExcluded = dir === 'high' ? winVals.filter(v => v >= threshold).length : winVals.filter(v => v <= threshold).length;
      winCost = winExcluded / winVals.length;
    }
    return { field: f, rule, hitCount, total: tVals.length, cost, winCost };
  }).filter(Boolean);
  adviceRows.sort((a, b) => (Number.isFinite(a.winCost) ? a.winCost : a.cost) - (Number.isFinite(b.winCost) ? b.winCost : b.cost));

  advBody.innerHTML = adviceRows.map(a => `
    <tr>
      <td>${escapeHtml(a.field)}</td>
      <td><code>${escapeHtml(a.rule)}</code></td>
      <td class="num">${a.hitCount}/${a.total}</td>
      <td class="num">${(a.cost * 100).toFixed(1)}%</td>
      <td class="num">${Number.isFinite(a.winCost) ? (a.winCost * 100).toFixed(1) + '%' : 'NA（无好样本可参照）'}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);">没有可用字段</td></tr>';

  const matchedCount = allTargetRows.length;
  summaryEl.innerHTML = `匹配到 ${targetMap.size}/${inputs.length} 个输入，共 ${matchedCount} 条记录，参与统计的字段 ${fields.length} 个。`
    + (unmatched.length ? `<br>⚠️ 未匹配到：${escapeHtml(unmatched.join('、'))}（检查拼写或是否被全局过滤条件排除）。` : '')
    + `<br>下方"过滤建议"按代价（该规则连带排除掉的好样本 returnMax&gt;2 的比例）从低到高排序，代价越低说明这条规则越"精准打击"目标 CA、越不容易误伤好样本。`;
}

// 最近一次回放的逐 check 拦截明细（check 名 -> { pass, fail, soleBlock, blocked[] }），
// 供看板表格里"查看 N 个"按钮点开时取数
let lastCheckBlocked = new Map();
// 策略有效性判定：不能只看中位数。
// meme 的收益极度右偏，价值几乎全在尾部——一个策略完全可能"把中位数抬高、同时把 100x 的票
// 全过滤掉"，那是最坏的结果，但只看中位数会判成"方向对"。所以同时看三个维度：
//   1) 中位数     —— 典型样本表现
//   2) 多档命中率 —— >2/>5/>10，>10 那档才真正代表能不能抓到大票
//   3) 大票捕获   —— 未命中组里有没有出现比命中组最大值还高的票（漏掉巨鲸是致命的）
// 三者不一致时明确指出来，而不是给一个笼统的"方向对/不对"。
function buildStrategyVerdict(hitRets, missRets) {
  if (!hitRets.length || !missRets.length) return '';
  const med = a => { const x = a.slice().sort((p, q) => p - q); const m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
  const rateAt = (a, t) => a.length ? a.filter(v => v > t).length / a.length * 100 : NaN;
  const hitMed = med(hitRets), missMed = med(missRets);
  const hitMax = Math.max(...hitRets), missMax = Math.max(...missRets);
  const THRESHOLDS = [WIN_THRESHOLD, 5, 10];

  const rows = THRESHOLDS.map(t => {
    const h = rateAt(hitRets, t), m = rateAt(missRets, t);
    return { t, h, m, better: h > m };
  });
  const medBetter = hitMed > missMed;
  // 漏掉大票：未命中组的最大值显著超过命中组最大值（1.5 倍以上才算"显著漏"，避免小幅波动误报）
  const missedWhale = missMax > hitMax * 1.5;
  const tailRow = rows[rows.length - 1]; // >10 那档
  const tailBetter = tailRow.better || (!Number.isFinite(tailRow.m) || tailRow.m === 0);

  // 判定优先级：中位数反转 > 漏巨鲸 > 尾部落后。
  // 中位数反转是更根本的问题（整体方向就错了），此时再强调"漏掉某个大票"是次要的；
  // 反过来，中位数占优时"漏巨鲸"才是那个最该被点名的隐患。
  let tone, headline;
  if (medBetter && tailBetter && !missedWhale) {
    tone = 'var(--ok,#30d158)';
    headline = '✓ 中位数和大票捕获都占优，策略的过滤方向是对的。';
  } else if (!medBetter) {
    tone = 'var(--warn,#ff9f0a)';
    headline = `⚠️ 命中组中位数【不高于】未命中组（${hitMed.toFixed(3)}x vs ${missMed.toFixed(3)}x）——策略拦掉的反而不比放行的差，过滤条件值得重新审视。`
      + (missedWhale ? `而且被拦的样本里还有 <b>${missMax.toFixed(1)}x</b>（命中组最高才 ${hitMax.toFixed(1)}x）。` : '');
  } else if (missedWhale) {
    tone = 'var(--danger,#ff453a)';
    headline = `⚠️ 严重信号：被拦掉的样本里出现了 <b>${missMax.toFixed(1)}x</b>，远高于命中组的最高 ${hitMax.toFixed(1)}x —— 策略把最大的票挡在了外面。`
      + `中位数虽然占优（${hitMed.toFixed(3)}x vs ${missMed.toFixed(3)}x），但 meme 的收益靠尾部，漏掉巨鲸的代价通常大于提升中位数的收益。`;
  } else if (medBetter && !tailBetter) {
    tone = 'var(--warn,#ff9f0a)';
    headline = `⚠️ 中位数占优但大票率落后（&gt;10x：命中 ${tailRow.h.toFixed(1)}% vs 未命中 ${tailRow.m.toFixed(1)}%）——策略在"提升平均质量"的同时牺牲了尾部，对 meme 未必划算。`;
  } else {
    tone = 'var(--text-muted)';
    headline = '各维度结论不一致，建议结合下方明细判断。';
  }

  const cells = rows.map(r => `<td class="num">${Number.isFinite(r.h) ? r.h.toFixed(1) + '%' : '-'}</td><td class="num" style="color:var(--text-muted)">${Number.isFinite(r.m) ? r.m.toFixed(1) + '%' : '-'}</td>`).join('');
  return `<div class="hint" style="margin:0 0 10px; padding:8px 10px; border-radius:6px; background:var(--surface-2);">
    <div style="color:${tone}; margin-bottom:6px;">${headline}</div>
    <table class="desc-table" style="background:var(--surface); border-radius:6px;">
      <thead><tr><th>指标</th>${THRESHOLDS.map(t => `<th class="num" colspan="2">&gt;${t}x 命中率</th>`).join('')}<th class="num">中位数</th><th class="num">最高</th></tr></thead>
      <tbody>
        <tr><td><b>命中组</b>（n=${hitRets.length}）</td>${rows.map(r => `<td class="num" colspan="2"><b>${Number.isFinite(r.h) ? r.h.toFixed(1) + '%' : '-'}</b></td>`).join('')}<td class="num"><b>${hitMed.toFixed(3)}x</b></td><td class="num">${hitMax.toFixed(1)}x</td></tr>
        <tr><td>未命中组（n=${missRets.length}）</td>${rows.map(r => `<td class="num" colspan="2" style="color:var(--text-muted)">${Number.isFinite(r.m) ? r.m.toFixed(1) + '%' : '-'}</td>`).join('')}<td class="num" style="color:var(--text-muted)">${missMed.toFixed(3)}x</td><td class="num" style="color:${missedWhale ? 'var(--danger,#ff453a)' : 'var(--text-muted)'}">${missMax.toFixed(1)}x</td></tr>
      </tbody>
    </table>
    <div style="margin-top:6px; color:var(--text-muted)">未命中组样本量 ${missRets.length} 条${missRets.length < 30 ? '（偏少，各档比率波动很大，别据此下定论）' : ''}；此处未做显著性检验，差异可能来自抽样运气。</div>
  </div>`;
}

// 最近一次回放的命中组 returnMax 列表，供"放宽这一条值不值"做对照
let lastReplayHitRets = [];

// 从 check 的"实际值"字符串里抠出数字。策略常把辅助信息拼进去（如 "3.30(2657/804)"、
// "2.032x"），parseFloat 只取前导数字正好合适；纯文本（平台名等）返回 NaN，该 check 不参与扫描。
function parseCheckNumber(v) {
  const n = parseFloat(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

// 从"期望"文字推断方向：'< 2.5' → 越小越好；'> 30' → 越大越好。
// 区间（'20~30'）和等值（'== 0'）没有单一切点，不给推荐。
function parseCheckDirection(expect) {
  const e = String(expect || '').trim();
  if (/~/.test(e) || /==/.test(e)) return null;
  if (/^<=?/.test(e)) return 'lt';
  if (/^>=?/.test(e)) return 'gt';
  return null;
}

// 为一条 check 扫描候选阈值：在两侧都保留足够样本的前提下，找"通过侧胜率最高"的切点。
// 返回 { rows, best, curr }，rows 是每个候选阈值的通过数/胜率/中位数，供表格展示。
function scanCheckThreshold(all, direction) {
  const pts = all.map(a => ({ v: parseCheckNumber(a.val), r: a.ret }))
                 .filter(p => Number.isFinite(p.v) && isFiniteNumber(p.r));
  if (pts.length < 20) return null;
  const medOf = a => { if (!a.length) return NaN; const x = a.slice().sort((p, q) => p - q); const m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
  const winOf = a => a.length ? a.filter(v => v > WIN_THRESHOLD).length / a.length * 100 : NaN;
  const baseWin = winOf(pts.map(p => p.r));
  // 候选切点取 5%~95% 分位，避免切出一侧样本极少的极端阈值
  const sorted = pts.map(p => p.v).slice().sort((a, b) => a - b);
  const cands = [];
  const seen = new Set();
  for (let q = 5; q <= 95; q += 5) {
    const v = sorted[Math.min(sorted.length - 1, Math.floor(q / 100 * (sorted.length - 1)))];
    if (!seen.has(v)) { seen.add(v); cands.push(v); }
  }
  const minSide = Math.max(10, Math.round(pts.length * 0.15));
  const rows = [];
  for (const t of cands) {
    const passSide = direction === 'lt' ? pts.filter(p => p.v < t) : pts.filter(p => p.v > t);
    const blockSide = direction === 'lt' ? pts.filter(p => p.v >= t) : pts.filter(p => p.v <= t);
    if (passSide.length < minSide || blockSide.length < minSide) continue;
    rows.push({ t, nPass: passSide.length, win: winOf(passSide.map(p => p.r)), med: medOf(passSide.map(p => p.r)),
                blockWin: winOf(blockSide.map(p => p.r)) });
  }
  if (!rows.length) return null;
  // 推荐：通过侧胜率最高的那个（同胜率取通过样本更多的，保守）
  const best = rows.slice().sort((a, b) => b.win - a.win || b.nPass - a.nPass)[0];
  return { rows, best, baseWin, total: pts.length };
}

// ---------- 8b. 策略诊断：把策略源码原样回放，看目标 CA 到底卡在哪一条 check ----------
// 目标问题：上面的"过滤建议"是【反推】——从数据分布里找能挡住目标 CA 的阈值。但很多时候策略本来
// 就已经上线跑了，真正想问的是【正推】：这个 CA 当时被我的策略拦了吗？卡在哪一条？实际值是多少？
// 靠人肉读策略代码 + 翻快照 JSON 对答案非常慢且容易看错，所以这里直接把策略源码跑一遍。
//
// 依赖的约定（本仓库 强势盘/PVP/1.5段/苏醒接力 四个策略均遵守）：策略是一段以 ctx 为入参的函数体，
// 内部构造 checks = [[名称, 是否通过, 实际值], ...]，然后 return true/false。
// 这里不解析源码语义，只做两件事：把 checks 抓出来、把 ctx 的属性读取路径记下来。

// 策略里的 checks 是函数内的局部变量，外部拿不到；把它的声明改写成对外部变量赋值，
// 就能在策略 return 之后（try/finally 保证一定执行）把整张表捞出来。
// 只改写第一处声明——四个策略都只有一个 checks 变量；万一改写没命中，回退到解析 ctx.log 的输出文本。
const STRATEGY_CHECKS_DECL_RE = /\b(?:var|const|let)\s+checks\s*=/;
const STRATEGY_CODE_STORAGE_KEY = 'chart_strategy_diag_code';

// 历史回放的时间基准：策略里的年龄/新鲜度判断走 Date.now()，直接用浏览器当前时间的话，
// 几个月前的样本会被算成"年龄几个月"，年龄类 check 全线失败，回放结果就没有意义了。
// 把 Date 整个替换成"当下 = 快照抓取时刻"的版本（同时覆盖 Date.now() 和 new Date() 两种写法）。
const RealDate = Date;
function makeFrozenDate(nowMs) {
  return class FrozenDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(nowMs); else super(...args); }
    static now() { return nowMs; }
  };
}

// 用 Proxy 递归包一层 ctx，把策略实际读到的属性路径记下来——这比正则扫源码可靠得多：
// 策略普遍会先起别名（var ki = ctx.kline_and_indicators、var gmgnStat = ctx.gmgn.stat），
// 正则只认 ctx.a.b 的写法就会大面积漏掉，而运行时记录拿到的是真正被读过的字段。
function makeCtxRecorder(ctx, seen) {
  const wrap = (val, path) => {
    if (val === null || typeof val !== 'object') return val;
    return new Proxy(val, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof prop === 'symbol') return v;
        // 数组下标和数组方法不记路径（ao_bars[0].value 这种记成 ao_bars.value 才是有用的信息，
        // 记成 ao_bars.0.value 只会把清单撑爆），但仍继续往下包，保证深层字段名能被记到。
        const isIndexLike = typeof prop === 'string' && /^\d+$/.test(prop);
        const nextPath = (isIndexLike || Array.isArray(target)) ? path : (path ? path + '.' + prop : prop);
        if (!isIndexLike && !Array.isArray(target) && typeof v !== 'function' && nextPath) seen.add(nextPath);
        if (typeof v === 'function') return v.bind(target);
        return wrap(v, nextPath);
      }
    });
  };
  return wrap(ctx, '');
}

// 策略读到的原始 ctx 路径 → 本工具的字段名。对应 data.js 里 flattenObject/flattenCtx 的展开口径：
// ctx.logearn.* 与 signal 同源，展开时不加前缀（所以 logearn.mcap → mcap）；
// ctx.gmgn.* / ctx.kline_and_indicators.* 保留各自前缀。其余（native_coin_price 等）不进特征体系。
function ctxPathToFieldName(path) {
  if (path.startsWith('logearn.')) {
    const name = path.slice('logearn.'.length);
    // data.js 里 current_mcap/fdv 已作为冗余字段并进 mcap（65 条样本核实过三者完全相同），
    // 工具里查不到这两个名字，映射时统一指向 mcap，否则会误报成"本工具没有这个字段"
    return (name === 'current_mcap' || name === 'fdv') ? 'mcap' : name;
  }
  if (path.startsWith('gmgn.') || path.startsWith('kline_and_indicators.')) return path;
  return null;
}

// 记录到的路径里既有叶子字段（gmgn.stat.bot_degen_rate）也有沿途的容器对象（gmgn、gmgn.stat）。
// 容器是访问叶子时顺带记下的，本身不是"策略用到的字段"，展示出来只会稀释清单。
// 判定：某条路径如果是另一条路径的前缀，就是容器，丢掉。
function dropContainerPaths(paths) {
  // log 是回放时自己注入的 ctx.log 打桩，不是快照里的数据字段，别混进"策略用到的字段"清单
  const list = [...paths].filter(p => p !== 'log' && !p.startsWith('log.'));
  return list.filter(p => !list.some(q => q !== p && q.startsWith(p + '.')));
}

function compileStrategy(src) {
  // 只去掉声明关键字（var/const/let），变量名仍然叫 checks——策略后面还会用 checks.every(...)
  // 之类引用它，改名会直接 ReferenceError。配合在最外层预声明一个 checks，就把它从"try 块内的
  // 局部变量"提升成了"整个函数体可见"，finally 里才拿得到（const/let 是块级作用域，
  // 不这么改的话 PVP 那种 `const checks = [...]` 在 finally 里根本不可见）。
  const capturedDecl = STRATEGY_CHECKS_DECL_RE.test(src);
  const rewritten = src.replace(STRATEGY_CHECKS_DECL_RE, 'checks =');
  // try/finally：策略未命中时会中途 return false，finally 保证 checks 仍然被交出来
  const body = `let checks = null;\ntry {\n${rewritten}\n} finally { __emit(checks); }`;
  let fn;
  try {
    fn = new Function('ctx', 'Date', '__emit', body);
  } catch (e) {
    return { error: `策略代码语法错误：${e.message}` };
  }
  return { fn, capturedDecl };
}

// 单行回放。返回 { passed, checks, logs, error, usedPaths }
function runStrategyOnRow(compiled, row) {
  if (!row.rawCtx) return { error: '该样本没有原始 ctx（快照数据缺失），无法回放策略' };
  const seen = new Set();
  const logs = [];
  let captured = null;
  // ctx.log 是平台注入的，快照里没有，得自己补；同时 ctx 用浅拷贝，避免策略往里写东西污染原始快照
  const logShim = {
    error: (...a) => logs.push({ level: 'error', text: a.join(' ') }),
    success: (...a) => logs.push({ level: 'success', text: a.join(' ') }),
    info: (...a) => logs.push({ level: 'info', text: a.join(' ') }),
    warn: (...a) => logs.push({ level: 'warn', text: a.join(' ') }),
  };
  const baseCtx = Object.assign({}, row.rawCtx, { log: logShim });
  const nowMs = Number.isFinite(row.buyTimestamp) ? row.buyTimestamp * 1000 : RealDate.now();
  let passed, error = null;
  try {
    passed = compiled.fn(makeCtxRecorder(baseCtx, seen), makeFrozenDate(nowMs), c => { captured = c; });
  } catch (e) {
    error = `${e.name}: ${e.message}`;
  }
  // checks 没抓到（策略写法不符合约定）时，回退到 ctx.log 里那条"未命中 ... | 失败:xxx"文本，
  // 至少还能把失败原因原样展示出来，而不是整个功能失效
  const checks = Array.isArray(captured)
    // c[3] 是可选的"期望条件"文字（如 '< 10'）——本仓库较新的策略会带上它。有它就展示，
    // 否则光看"值=14"根本判断不出阈值是多少，阈值记混了也发现不了（真实踩过：把"创建者发币数<80"
    // 误当成"推特发币数<80"，实际代码是 <10，8 个样本被拦却以为是工具算错）。
    ? captured.map(c => ({ name: String(c[0]), ok: !!c[1], value: c[2] === undefined ? '' : String(c[2]), expect: c[3] === undefined ? '' : String(c[3]) }))
    : null;
  return { passed: !!passed, checks, logs, error, usedPaths: seen, nowMs };
}

// useCurrentDataset=true 时忽略 CA 输入框，直接对整个当前工作集（activeRows）回放——
// 手动粘 CA 只能看几个个案，跑全量才能得出"这条 check 在整体上拦了多少、放宽能多命中几个"的结论。
function renderStrategyDiag(caInputText, src, useCurrentDataset) {
  const summaryEl = document.getElementById('strategyDiagSummary');
  const fieldsEl = document.getElementById('strategyDiagFields');
  const body = document.getElementById('strategyDiagBody');
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  if (!src.trim()) { showToast('请先粘贴策略代码（以 ctx 为入参、内部构造 checks 数组的那段）'); return; }

  const compiled = compileStrategy(src);
  if (compiled.error) {
    summaryEl.innerHTML = `⚠️ ${escapeHtml(compiled.error)}`;
    fieldsEl.innerHTML = ''; body.innerHTML = '';
    return;
  }

  const unmatched = [];
  const results = [];   // { input, row, res }
  let inputs = [];
  if (useCurrentDataset) {
    activeRows.forEach(row => results.push({ input: row.symbol || row.tokenAddress || '', row, res: runStrategyOnRow(compiled, row) }));
  } else {
    inputs = [...new Set(caInputText.split(/[\n,，;；\s]+/).map(s => s.trim()).filter(Boolean))];
    if (!inputs.length) { showToast('请在上方"目标 CA / symbol"里输入至少一个 CA，或点"用当前数据源回放"'); return; }
    inputs.forEach(inp => {
      const rows = findRowsByInput(inp);
      if (!rows.length) { unmatched.push(inp); return; }
      rows.forEach(row => results.push({ input: inp, row, res: runStrategyOnRow(compiled, row) }));
    });
  }
  if (!results.length) {
    summaryEl.innerHTML = useCurrentDataset
      ? '⚠️ 当前工作集为空。'
      : `⚠️ 输入的 ${inputs.length} 个 CA/symbol 在当前工作集里都没有匹配到，请检查拼写，或者它们是否已被上方的全局过滤条件排除。`;
    fieldsEl.innerHTML = ''; body.innerHTML = '';
    return;
  }

  // ---- 策略用到的字段：把每行回放期间记录到的 ctx 路径并起来 ----
  const allPaths = new Set();
  results.forEach(({ res }) => (res.usedPaths || new Set()).forEach(p => allPaths.add(p)));
  const fieldRows = dropContainerPaths(allPaths).sort().map(p => {
    const mapped = ctxPathToFieldName(p);
    // 映射得到的字段名在不在 scatterOptions 里，决定了它能不能拿去做散点图/过滤条件/相关性分析
    const inTool = mapped && scatterOptions.includes(mapped);
    return { path: p, mapped, inTool };
  });
  const usableCount = fieldRows.filter(f => f.inTool).length;
  fieldsEl.innerHTML = `
    <div class="hint" style="margin: 0 0 6px;">策略回放期间实际读到的 ctx 字段共 ${fieldRows.length} 个，其中 ${usableCount} 个在本工具里有对应字段（可直接拿去做散点图/相关性/过滤条件）。<span style="color:var(--text-muted)">这是运行时记录的真实读取路径，不是正则扫源码，策略里起了别名也能抓到。</span></div>
    <div class="table-scroll" style="max-height: 260px;">
      <table class="desc-table">
        <thead><tr><th>策略读取的 ctx 路径</th><th>本工具字段名</th><th>可用于分析</th></tr></thead>
        <tbody>${fieldRows.map(f => `
          <tr>
            <td><code>ctx.${escapeHtml(f.path)}</code></td>
            <td>${f.mapped ? escapeHtml(f.mapped) : '<span style="color:var(--text-muted)">—</span>'}</td>
            <td>${f.inTool ? '<span style="color:var(--ok,#30d158)">是</span>' : '<span style="color:var(--text-muted)">否</span>'}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;

  // ---- 逐个目标 CA：命中/未命中 + 卡在哪几条 check ----
  // 逐币卡片限量：全量回放几百条时，每条都渲染一张带 checks 表格的卡片会撑爆 DOM 且没人会逐个看。
  // 优先展示未命中的（那才是要排查的），命中的排后面；超出上限只留看板汇总。
  const MAX_CARDS = 40;
  const sortedForCards = results.slice().sort((a, b) => {
    const fa = (a.res.error || !a.res.passed) ? 0 : 1;
    const fb = (b.res.error || !b.res.passed) ? 0 : 1;
    return fa - fb;
  });
  const cardRows = sortedForCards.slice(0, MAX_CARDS);
  const cardsOmitted = results.length - cardRows.length;
  body.innerHTML = (cardsOmitted > 0
    ? `<div class="hint" style="margin:0 0 10px; color:var(--text-muted)">共 ${results.length} 条，下面只展开前 ${MAX_CARDS} 条明细（未命中的优先），其余 ${cardsOmitted} 条已计入上方看板统计。</div>`
    : '') + cardRows.map(({ input, row, res }) => {
    const title = `${escapeHtml(row.symbol || input)} <span style="color:var(--text-muted); font-size:12px;">${escapeHtml(row.tokenAddress || '')}</span>`;
    if (res.error) {
      return `<div class="strategy-diag-card">
        <div class="strategy-diag-head">${title} <span class="tag" style="background:rgba(255,69,58,.18);">回放报错</span></div>
        <div class="hint" style="margin:6px 0 0; color:var(--danger,#ff453a);">${escapeHtml(res.error)}</div>
        <div class="hint" style="margin:4px 0 0;">常见原因：策略用到了平台注入、但快照里没有的 ctx 字段。</div>
      </div>`;
    }
    if (!res.checks) {
      const logText = res.logs.map(l => l.text).join('\n');
      return `<div class="strategy-diag-card">
        <div class="strategy-diag-head">${title} <span class="tag">${res.passed ? '命中' : '未命中'}</span></div>
        <div class="hint" style="margin:6px 0 0;">没能从策略里抓到 checks 数组（策略写法与约定不同），下面是策略自己打的日志：</div>
        <pre class="strategy-diag-log">${escapeHtml(logText || '（无日志输出）')}</pre>
      </div>`;
    }
    const failed = res.checks.filter(c => !c.ok);
    const badge = res.passed
      ? '<span class="tag" style="background:rgba(48,209,88,.18);">命中（策略不会拦它）</span>'
      : `<span class="tag" style="background:rgba(255,69,58,.18);">未命中，卡在 ${failed.length} 条</span>`;
    const replayTime = Number.isFinite(res.nowMs) ? new RealDate(res.nowMs).toLocaleString() : '-';
    return `<div class="strategy-diag-card">
      <div class="strategy-diag-head">${title} ${badge}</div>
      <div class="hint" style="margin:6px 0 8px;">回放基准时刻（= 快照抓取时刻）：${escapeHtml(replayTime)}；returnMax = ${isFiniteNumber(row.returnMax) ? row.returnMax.toFixed(3) + 'x' : '-'}</div>
      <table class="desc-table">
        <thead><tr><th style="width:34px;"></th><th>check</th><th>实际值</th><th>期望</th></tr></thead>
        <tbody>${res.checks.map(c => `
          <tr${c.ok ? '' : ' style="background:rgba(255,69,58,.08);"'}>
            <td>${c.ok ? '<span style="color:var(--ok,#30d158)">✓</span>' : '<span style="color:var(--danger,#ff453a)">✗</span>'}</td>
            <td>${escapeHtml(c.name)}</td>
            <td><code>${escapeHtml(c.value)}</code></td>
            <td><code style="color:var(--text-muted)">${escapeHtml(c.expect || '')}</code></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
  }).join('');

  // ---- 看板：逐条 check 的通过率 + 单点否决数 ----
  // 币一多，逐张卡片就看不出规律了。这里按 check 汇总：
  //   通过/失败数 —— 哪一条最严
  //   单点否决数 —— 该样本【只】卡在这一条（放宽它就能直接多命中这么多个），最有行动价值
  //   命中/未命中两组的 returnMax 中位数 —— 反过来检验"策略拦掉的是不是真的更差"
  const checkStats = new Map(); // name -> { pass, fail, soleBlock }
  const valid = results.filter(r => !r.error && Array.isArray(r.res.checks));
  valid.forEach(({ row, res }) => {
    const failedNames = res.checks.filter(c => !c.ok).map(c => c.name);
    const sole = failedNames.length === 1 ? failedNames[0] : null;
    res.checks.forEach(c => {
      if (!checkStats.has(c.name)) checkStats.set(c.name, { pass: 0, fail: 0, soleBlock: 0, blocked: [], all: [], expect: c.expect || '' });
      const st = checkStats.get(c.name);
      // 全量样本（含通过的）都记一份 value+returnMax，供"推荐阈值"扫描——
      // 只有被拦的那些没法搜阈值，必须两侧都有才能算"卡在哪里区分度最好"
      st.all.push({ val: c.value, ret: row.returnMax, ok: c.ok });
      if (c.ok) st.pass++;
      else {
        st.fail++;
        // 同时记下被这条拦掉的样本明细，供表格里点开查看（值 = 该 check 当时的实际值）
        st.blocked.push({ symbol: row.symbol || '', addr: row.tokenAddress || '', ret: row.returnMax, val: c.value, expect: c.expect || '', sole: sole === c.name });
      }
    });
    // 只失败一条 = 单点否决，放宽这条这个样本就命中了
    if (sole) checkStats.get(sole).soleBlock++;
  });
  // 供表格行点开时查明细（把 blocked 挂到模块级，避免闭包塞进 HTML）
  lastCheckBlocked = checkStats;
  lastReplayHitRets = valid.filter(r => r.res.passed).map(r => r.row.returnMax).filter(isFiniteNumber);
  const ranked = [...checkStats.entries()].map(([name, st]) => ({ name, ...st }))
    .sort((a, b) => b.soleBlock - a.soleBlock || b.fail - a.fail);
  // 注意：results 的元素是 { input, row, res }，命中/报错状态在 res 里。
  // 之前误写成 r.passed / r.error（永远 undefined），导致命中数恒为 0——手动粘几个 CA 时
  // 恰好都未命中，一直没暴露，跑全量数据源才显出来。
  const passedCount = results.filter(r => !r.res.error && r.res.passed).length;
  const errorCount = results.filter(r => r.res.error).length;

  // 命中 vs 未命中的收益对比：策略有效的话，命中组的 returnMax 应该更高
  const med = arr => { if (!arr.length) return NaN; const a = arr.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const hitRets = valid.filter(r => r.res.passed).map(r => r.row.returnMax).filter(isFiniteNumber);
  const missRets = valid.filter(r => !r.res.passed).map(r => r.row.returnMax).filter(isFiniteNumber);
  const hitMed = med(hitRets), missMed = med(missRets);
  const winRate = arr => arr.length ? arr.filter(v => v > WIN_THRESHOLD).length / arr.length * 100 : NaN;

  // 看板 HTML：插在逐币卡片之前
  const boardEl = document.getElementById('strategyDiagBoard');
  if (boardEl) {
    boardEl.innerHTML = !valid.length ? '' : `
      <div class="stat-row" style="margin-bottom:10px;">
        <div class="stat-tile"><div class="stat-label">回放样本</div><div class="stat-value">${valid.length}</div></div>
        <div class="stat-tile"><div class="stat-label">命中</div><div class="stat-value" style="color:var(--ok,#30d158)">${passedCount}</div></div>
        <div class="stat-tile"><div class="stat-label">未命中</div><div class="stat-value" style="color:var(--danger,#ff453a)">${valid.length - passedCount}</div></div>
        <div class="stat-tile"><div class="stat-label">命中组 returnMax 中位数</div><div class="stat-value">${Number.isFinite(hitMed) ? hitMed.toFixed(3) + 'x' : '-'}</div></div>
        <div class="stat-tile"><div class="stat-label">未命中组 中位数</div><div class="stat-value">${Number.isFinite(missMed) ? missMed.toFixed(3) + 'x' : '-'}</div></div>
        <div class="stat-tile"><div class="stat-label">命中组胜率(&gt;${WIN_THRESHOLD})</div><div class="stat-value">${Number.isFinite(winRate(hitRets)) ? winRate(hitRets).toFixed(1) + '%' : '-'}</div></div>
      </div>
      ${buildStrategyVerdict(hitRets, missRets)}
      <div class="table-scroll" style="max-height:320px;">
        <table class="desc-table">
          <thead><tr><th>check</th><th class="num">通过</th><th class="num">失败</th><th class="num">通过率</th><th class="num">单点否决</th><th>说明</th><th>被拦 CA</th></tr></thead>
          <tbody>${ranked.map(r => {
            const rate = (r.pass + r.fail) ? r.pass / (r.pass + r.fail) * 100 : NaN;
            return `<tr${r.soleBlock > 0 ? ' style="background:rgba(255,159,10,.10);"' : ''}>
              <td>${escapeHtml(r.name)}</td>
              <td class="num">${r.pass}</td>
              <td class="num">${r.fail}</td>
              <td class="num">${Number.isFinite(rate) ? rate.toFixed(1) + '%' : '-'}</td>
              <td class="num"><b>${r.soleBlock || ''}</b></td>
              <td style="font-size:11.5px;">${r.soleBlock > 0
                ? `<span style="color:var(--warn,#ff9f0a)">放宽这一条可多命中 ${r.soleBlock} 个</span>`
                : (r.fail === 0 ? '<span style="color:var(--text-muted)">从未拦过任何样本</span>' : '')}</td>
              <td>${r.fail > 0 ? `<button type="button" class="secondary check-blocked-btn" data-check="${escapeHtml(r.name)}" style="padding:2px 10px; font-size:11px;">查看 ${r.fail} 个</button>` : ''}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
      <div id="strategyCheckBlockedDetail" style="margin-top:10px;"></div>`;
  }
  summaryEl.innerHTML = `回放 ${results.length} 条记录：命中 ${passedCount} 条，未命中 ${results.length - passedCount - errorCount} 条${errorCount ? `，报错 ${errorCount} 条` : ''}。`
    + (unmatched.length ? `<br>⚠️ 未匹配到：${escapeHtml(unmatched.join('、'))}（检查拼写或是否被全局过滤条件排除）。` : '')
    + (ranked.length ? `<br>拦得最多的 check：${ranked.filter(r => r.fail > 0).slice(0, 5).map(r => `<b>${escapeHtml(r.name)}</b>(${r.fail}条)`).join('、') || '无'}。` : '')
    + `<br><span style="color:var(--text-muted)">注意：回放用的是【买入时刻快照】里的 ctx，而策略上线时读的是实时数据，两者在时间上对齐但数据源可能有细微差异；另外这里只跑了目标 CA，不代表策略在全量样本上的表现。</span>`;
}

// ---------- 初始化：各 section 的输入联想/按钮绑定 ----------
function initProAnalytics() {
  const corrMatrixSelector = makeFieldTagSelector('corrMatrixInput', 'corrMatrixTagBox');
  document.getElementById('genCorrMatrixBtn').addEventListener('click', () => renderCorrMatrix(
    corrMatrixSelector.getSelected(),
    Number(document.getElementById('corrMatrixThreshold').value),
    document.getElementById('corrMatrixHighlight').checked
  ));
  // 默认预填"相关性表 Top10 字段 + returnMax"——从当前已计算好的 allCorrelations 里取
  // |r| 最大的前 10 个不重复字段（allCorrelations 本身已按 |r| 降序排好，直接取前几个去重即可）
  wireImportTop10Btn('importTop10CorrBtn', corrMatrixSelector, ['returnMax']);

  const importanceSelector = makeFieldTagSelector('importanceInput', 'importanceTagBox');
  document.getElementById('genImportanceBtn').addEventListener('click', () => {
    renderFeatureImportance(document.getElementById('importanceTargetField').value, importanceSelector.getSelected(),
      readSplitOptions('regOos', { enabled: document.getElementById('regOosEnabled').checked }));
  });

  const compositeSelector = makeFieldTagSelector('compositeInput', 'compositeTagBox');
  wireImportTop10Btn('importCompositeTop10Btn', compositeSelector);
  document.getElementById('genCompositeScoreBtn').addEventListener('click', () => {
    renderCompositeScore(
      document.getElementById('compositeTargetField').value,
      compositeSelector.getSelected(),
      document.getElementById('compositeWeightMethod').value,
      readSplitOptions('composite')
    );
  });
  document.getElementById('applyCompositeScoreBtn').addEventListener('click', applyCompositeScore);

  const interactionSelector = makeFieldTagSelector('interactionInput', 'interactionTagBox');
  document.getElementById('genInteractionBtn').addEventListener('click', () => {
    const ops = [];
    if (document.getElementById('interactionOpRatio').checked) ops.push('ratio');
    if (document.getElementById('interactionOpDiff').checked) ops.push('diff');
    if (document.getElementById('interactionOpProduct').checked) ops.push('product');
    renderFeatureInteractions(interactionSelector.getSelected(), ops, document.getElementById('interactionTargetField').value);
  });

  // 分组/分类字段用 filterFieldList（含 signalType/symbol 等分类字段 + 全部数值字段），
  // 而不是只含数值字段的 xFieldList，否则用户找不到 signalType 这类分类字段
  attachAutocomplete(document.getElementById('groupByField'), document.getElementById('groupByField'), 'filterFieldList', v => {
    document.getElementById('groupByField').value = v;
  });
  attachAutocomplete(document.getElementById('groupFeatureField'), document.getElementById('groupFeatureField'), 'xFieldList', v => {
    document.getElementById('groupFeatureField').value = v;
  });
  document.getElementById('genGroupCompareBtn').addEventListener('click', () => {
    renderGroupCompare(
      document.getElementById('groupByField').value.trim(),
      document.getElementById('groupByBreakpoints').value.trim(),
      document.getElementById('groupFeatureField').value.trim(),
      document.getElementById('groupTargetField').value,
      Number(document.getElementById('groupMinSample').value),
      Number(document.getElementById('groupByQuantiles').value)
    );
  });

  attachAutocomplete(document.getElementById('timeFeatureField'), document.getElementById('timeFeatureField'), 'xFieldList', v => {
    document.getElementById('timeFeatureField').value = v;
  });
  document.getElementById('genTimeAnalysisBtn').addEventListener('click', () => {
    renderTimeAnalysis(
      document.getElementById('timeFeatureField').value.trim(),
      document.getElementById('timeTargetField').value,
      Number(document.getElementById('timeBucketCount').value)
    );
  });
  document.getElementById('downloadTimeAnalysisCsvBtn').addEventListener('click', downloadTimeAnalysisCsv);

  attachAutocomplete(document.getElementById('rollingFeatureField'), document.getElementById('rollingFeatureField'), 'xFieldList', v => {
    document.getElementById('rollingFeatureField').value = v;
  });
  document.getElementById('genRollingCorrBtn').addEventListener('click', () => {
    renderRollingCorrelation(
      document.getElementById('rollingFeatureField').value.trim(),
      document.getElementById('rollingTargetField').value,
      Number(document.getElementById('rollingWindowDays').value),
      Number(document.getElementById('rollingStepDays').value)
    );
  });
  document.getElementById('downloadRollingCorrCsvBtn').addEventListener('click', downloadRollingCorrCsv);

  attachAutocomplete(document.getElementById('catField'), document.getElementById('catField'), 'filterFieldList', v => {
    document.getElementById('catField').value = v;
  });
  attachAutocomplete(document.getElementById('catValueField'), document.getElementById('catValueField'), 'xFieldList', v => {
    document.getElementById('catValueField').value = v;
  });
  document.getElementById('genCatAnalysisBtn').addEventListener('click', () => {
    renderCatAnalysis(
      document.getElementById('catField').value.trim(),
      document.getElementById('catBreakpoints').value.trim(),
      document.getElementById('catValueField').value.trim(),
      document.getElementById('catSigTest').checked
    );
  });

  attachAutocomplete(document.getElementById('rocField'), document.getElementById('rocField'), 'xFieldList', v => {
    document.getElementById('rocField').value = v;
  });
  document.getElementById('genRocBtn').addEventListener('click', () => {
    renderRocSingle(
      document.getElementById('rocField').value.trim(),
      document.getElementById('rocTargetField').value,
      Number(document.getElementById('rocWinThreshold').value),
      document.getElementById('rocDirection').value
    );
  });

  const rocBatchSelector = makeFieldTagSelector('rocBatchInput', 'rocBatchTagBox');
  wireImportTop10Btn('importRocTop10Btn', rocBatchSelector);
  // 按分组批量导入候选字段：分组定义直接复用字段浏览器算好的 fieldBrowserGroups，
  // 保证两处口径完全一致（那边怎么归组，这里导入的就是哪些）。
  document.getElementById('importRocGroupBtn').addEventListener('click', () => {
    const g = document.getElementById('rocBatchGroup').value;
    if (!g) { showToast('请先选择一个字段分组'); return; }
    // 实时算，不读 fieldBrowserGroups 缓存——那个只在字段浏览器面板渲染过之后才有内容，
    // 用户没展开过面板时会是空数组，导致误报"该分组没有可用字段"
    const groups = (typeof computeFieldGroups === 'function') ? computeFieldGroups() : (fieldBrowserGroups || {});
    const fields = groups[g] || [];
    if (!fields.length) { showToast('该分组在当前数据集里没有可用字段（可能还没点"分析"，或这批数据缺这类字段）'); return; }
    let added = 0;
    fields.forEach(f => { if (!rocBatchSelector.getSelected().includes(f)) { rocBatchSelector.addField(f); added++; } });
    showToast(`已加入 ${fields.length} 个字段（新增 ${added}）`);
  });
  // 一键清空候选字段：批量导入几十个字段后想换一批，逐个点 × 太折腾
  document.getElementById('clearRocBatchBtn').addEventListener('click', () => {
    const n = rocBatchSelector.clear();
    document.getElementById('rocBatchBody').innerHTML = '';
    const nEl = document.getElementById('rocBatchNote'); if (nEl) nEl.innerHTML = '';
    showToast(n ? `已清空 ${n} 个候选字段` : '候选字段本来就是空的');
  });
  document.getElementById('genRocBatchBtn').addEventListener('click', () => {
    renderRocBatch(
      rocBatchSelector.getSelected(),
      document.getElementById('rocTargetField').value,
      Number(document.getElementById('rocWinThreshold').value)
    );
  });

  const similarFieldsSelector = makeFieldTagSelector('similarFieldsInput', 'similarFieldsTagBox');
  wireImportTop10Btn('importSimilarTop10Btn', similarFieldsSelector);
  document.getElementById('genSimilarBtn').addEventListener('click', () => {
    renderSimilarCases(
      document.getElementById('similarBaseInput').value,
      similarFieldsSelector.getSelected(),
      Number(document.getElementById('similarK').value)
    );
  });

  const caAdvisorSelector = makeFieldTagSelector('caAdvisorFieldsInput', 'caAdvisorFieldsTagBox');
  wireImportTop10Btn('importCaAdvisorTop10Btn', caAdvisorSelector);
  document.getElementById('loadCaAdvisorTrustedBtn').addEventListener('click', () => {
    const fields = scatterOptions.filter(isTrustedField);
    if (!fields.length) { showToast('当前数据集里没有已核实过的常用字段'); return; }
    let added = 0;
    fields.forEach(f => { if (!caAdvisorSelector.getSelected().includes(f)) { caAdvisorSelector.addField(f); added++; } });
    showToast(`已加入 ${fields.length} 个常用字段（新增 ${added}，其余之前已在列表中）`);
  });
  document.getElementById('genCaAdvisorBtn').addEventListener('click', () => {
    renderCaAdvisor(
      document.getElementById('caAdvisorInput').value,
      caAdvisorSelector.getSelected()
    );
  });

  // 策略诊断复用同一个"目标 CA"输入框——问的是同一批 CA 的两个问题：
  // 上面是"该加什么规则才能挡住它们"，这里是"现有策略当时到底拦没拦住、卡在哪"
  document.getElementById('genStrategyDiagBtn').addEventListener('click', () => {
    renderStrategyDiag(
      document.getElementById('caAdvisorInput').value,
      document.getElementById('strategyCodeInput').value,
      false
    );
  });
  // 看板表格里点"查看 N 个"：展开该 check 拦掉的全部 CA。用事件委托挂在看板容器上，
  // 因为表格每次回放都会整体重建，逐个绑定必然会漏。
  document.getElementById('strategyDiagBoard').addEventListener('click', e => {
    const btn = e.target.closest('.check-blocked-btn');
    if (!btn) return;
    const name = btn.dataset.check;
    const st = lastCheckBlocked.get(name);
    const detail = document.getElementById('strategyCheckBlockedDetail');
    if (!st || !detail) return;
    // 单点否决的排最前——那些是"只卡这一条"，放宽它立刻能救回来的，最有行动价值
    const rows = st.blocked.slice().sort((a, b) => (b.sole ? 1 : 0) - (a.sole ? 1 : 0));
    // 排序状态：默认按"单点否决优先"（那批才是放宽后真能救回来的）。点表头可切换，
    // 同一列再点一次反向。数值列用 parseCheckNumber 解析（值常带括号后缀如 "3.30(2657/804)"）。
    const SORTERS = {
      symbol: (a, b) => String(a.symbol || '').localeCompare(String(b.symbol || '')),
      val: (a, b) => (parseCheckNumber(a.val) || 0) - (parseCheckNumber(b.val) || 0),
      ret: (a, b) => (isFiniteNumber(a.ret) ? a.ret : -Infinity) - (isFiniteNumber(b.ret) ? b.ret : -Infinity),
      sole: (a, b) => (a.sole ? 1 : 0) - (b.sole ? 1 : 0),
    };
    let sortKey = 'sole', sortDir = -1; // -1 = 降序（单点否决在前）
    function renderBlockedTable() {
      const sorted = rows.slice().sort((a, b) => SORTERS[sortKey](a, b) * sortDir);
      const arrow = k => sortKey === k ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
      const th = (k, label, cls) => `<th${cls ? ` class="${cls}"` : ''} data-sort="${k}" style="cursor:pointer; user-select:none;" title="点击按此列排序">${label}${arrow(k)}</th>`;
      return `<table class="desc-table">
          <thead><tr>${th('symbol', 'symbol')}<th>token_address</th>${th('val', '该 check 实际值', 'num')}<th>期望</th>${th('ret', 'returnMax', 'num')}${th('sole', '类型')}</tr></thead>
          <tbody>${sorted.map(r => `
            <tr${r.sole ? ' style="background:rgba(255,159,10,.10);"' : ''}>
              <td>${escapeHtml(r.symbol || '-')}</td>
              <td class="ellip" title="${escapeHtml(r.addr)}">${escapeHtml(r.addr || '-')}</td>
              <td class="num"><code>${escapeHtml(r.val)}</code></td>
              <td><code style="color:var(--text-muted)">${escapeHtml(r.expect || '')}</code></td>
              <td class="num">${isFiniteNumber(r.ret) ? r.ret.toFixed(3) + 'x' : '-'}</td>
              <td>${r.sole ? '<span style="color:var(--warn,#ff9f0a)">单点否决</span>' : '<span style="color:var(--text-muted)">还卡在其它条</span>'}</td>
            </tr>`).join('')}</tbody>
        </table>`;
    }
    const caList = rows.map(r => r.addr).filter(Boolean).join('\n');

    // 「放宽这一条值不值」：只有单点否决的样本才是放宽后真正会被放进来的（其余还卡在别处），
    // 所以拿这批的收益去和当前命中组比——比命中组差就说明这条 check 在正确地挡掉烂样本。
    const soleRets = rows.filter(r => r.sole).map(r => r.ret).filter(isFiniteNumber);
    const medOf = a => { if (!a.length) return NaN; const x = a.slice().sort((p, q) => p - q); const m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
    const winOf = a => a.length ? a.filter(v => v > WIN_THRESHOLD).length / a.length * 100 : NaN;
    const soleMed = medOf(soleRets), soleWin = winOf(soleRets);
    const hitRetsNow = lastReplayHitRets || [];
    const hitMedNow = medOf(hitRetsNow), hitWinNow = winOf(hitRetsNow);
    let verdictHtml = '';
    if (soleRets.length) {
      const better = Number.isFinite(hitMedNow) && soleMed > hitMedNow;
      verdictHtml = `<div class="hint" style="margin:0 0 8px; padding:8px 10px; border-radius:6px; background:var(--surface-2);">
        <b>放宽这一条值不值？</b>只有 <b>${soleRets.length}</b> 个单点否决样本会真正被放进来（其余还卡在别处，放宽也进不来）。
        <br>这批：胜率(&gt;${WIN_THRESHOLD}) <b>${Number.isFinite(soleWin) ? soleWin.toFixed(1) + '%' : '-'}</b>，中位数 <b>${Number.isFinite(soleMed) ? soleMed.toFixed(3) + 'x' : '-'}</b>
        ${Number.isFinite(hitMedNow) ? `　|　当前命中组：胜率 <b>${hitWinNow.toFixed(1)}%</b>，中位数 <b>${hitMedNow.toFixed(3)}x</b>` : ''}
        ${Number.isFinite(hitMedNow) ? `<br><span style="color:${better ? 'var(--warn,#ff9f0a)' : 'var(--ok,#30d158)'}">${better
            ? '⚠️ 被拦的这批中位数【高于】命中组——这条 check 可能在误杀，值得考虑放宽。'
            : '✓ 被拦的这批中位数低于命中组——这条 check 在正确地挡掉较差的样本，不建议放宽。'}</span>` : ''}
        <span style="color:var(--text-muted)">（样本少时波动大；且这只是"放进来之后"的收益，没有考虑放宽后未来会多进来多少未知样本）</span>
      </div>`;
    }
    // ---- 推荐阈值：扫这条 check 的字段值，找区分度最好的切点 ----
    const dir = parseCheckDirection(st.expect);
    const scan = dir ? scanCheckThreshold(st.all, dir) : null;
    let recHtml = '';
    if (scan) {
      const currT = parseCheckNumber(st.expect.replace(/^[<>=]+/, ''));
      const currRow = Number.isFinite(currT) ? scan.rows.find(r => Math.abs(r.t - currT) < 1e-9) : null;
      const op = dir === 'lt' ? '<' : '>';
      recHtml = `<div class="hint" style="margin:0 0 8px; padding:8px 10px; border-radius:6px; background:var(--surface-2);">
        <b>推荐阈值</b>（扫 ${scan.total} 个有数值的样本，两侧各至少保留 15%）：
        建议改成 <code style="color:var(--ok,#30d158)"><b>${op} ${formatNumberSmart(scan.best.t)}</b></code>
        —— 通过 ${scan.best.nPass} 个，其中胜率(&gt;${WIN_THRESHOLD}) <b>${scan.best.win.toFixed(1)}%</b>，中位数 ${scan.best.med.toFixed(3)}x
        <span style="color:var(--text-muted)">（全样本基准胜率 ${scan.baseWin.toFixed(1)}%${currRow ? `；当前阈值 ${op} ${formatNumberSmart(currT)} 的通过侧胜率 ${currRow.win.toFixed(1)}%` : ''}）</span>
        <details style="margin-top:6px;"><summary>展开各候选阈值的扫描结果</summary>
          <div class="table-scroll" style="max-height:220px; margin-top:6px;">
            <table class="desc-table">
              <thead><tr><th class="num">阈值</th><th class="num">通过数</th><th class="num">通过侧胜率</th><th class="num">通过侧中位数</th><th class="num">被拦侧胜率</th></tr></thead>
              <tbody>${scan.rows.map(r => `<tr${r === scan.best ? ' style="background:rgba(48,209,88,.12);"' : ''}>
                <td class="num">${op} ${formatNumberSmart(r.t)}</td>
                <td class="num">${r.nPass}</td>
                <td class="num"><b>${r.win.toFixed(1)}%</b></td>
                <td class="num">${r.med.toFixed(3)}x</td>
                <td class="num" style="color:var(--text-muted)">${r.blockWin.toFixed(1)}%</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
        </details>
        <span style="color:var(--warn,#ff9f0a)">注意：这是在【历史数据上挑出来的最优切点】，天然偏乐观；换新数据大概率没这么好。样本少时尤其别当准。</span>
      </div>`;
    } else if (st.expect) {
      recHtml = `<div class="hint" style="margin:0 0 8px; color:var(--text-muted)">该 check 的期望是 <code>${escapeHtml(st.expect)}</code>（区间/等值判定，或数值样本不足 20 个），没有单一切点可推荐。</div>`;
    }

    detail.innerHTML = recHtml + verdictHtml + `
      <div class="hint" style="margin:0 0 6px;">
        <b>${escapeHtml(name)}</b>${rows[0] && rows[0].expect ? ` <code style="color:var(--text-muted)">期望 ${escapeHtml(rows[0].expect)}</code>` : ''} 拦掉的 ${rows.length} 个样本${st.soleBlock ? `（其中 <b style="color:var(--warn,#ff9f0a)">${st.soleBlock} 个是单点否决</b>，放宽这一条就能命中）` : ''}
        <button type="button" id="copyBlockedCaBtn" class="secondary" style="padding:2px 10px; font-size:11px; margin-left:8px;">📋 复制这些 CA</button>
        <button type="button" id="fillBlockedCaBtn" class="secondary" style="padding:2px 10px; font-size:11px;">填入上方"目标 CA"</button>
      </div>
      <div class="table-scroll" style="max-height:300px;" id="blockedCaTableWrap">${renderBlockedTable()}</div>`;
    // 表头点击排序：同列再点反向。表格每次重渲染都会换掉 DOM，所以绑在外层容器上做委托。
    const wrap = document.getElementById('blockedCaTableWrap');
    if (wrap) wrap.addEventListener('click', ev => {
      const th = ev.target.closest('th[data-sort]');
      if (!th) return;
      const k = th.dataset.sort;
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = (k === 'symbol') ? 1 : -1; }
      wrap.innerHTML = renderBlockedTable();
    });
    document.getElementById('copyBlockedCaBtn').addEventListener('click', () => {
      navigator.clipboard.writeText(caList).then(() => showToast(`已复制 ${rows.length} 个 CA`)).catch(err => showToast('复制失败：' + err, true));
    });
    document.getElementById('fillBlockedCaBtn').addEventListener('click', () => {
      document.getElementById('caAdvisorInput').value = caList;
      showToast('已填入上方"目标 CA"，可直接点"分析"看它们的字段分布，或用 CA 定位反推过滤规则');
      document.getElementById('caAdvisorInput').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // 用当前数据源回放：忽略 CA 输入框，跑整个工作集。样本多时耗时明显，套一层 loading。
  document.getElementById('genStrategyDiagAllBtn').addEventListener('click', () => {
    withLoading(`正在对 ${activeRows.length} 条样本回放策略...`, () =>
      renderStrategyDiag('', document.getElementById('strategyCodeInput').value, true));
  });
  // ---- 代码编辑器交互：行号 / 统计 / 折叠 / 清空 / Tab 缩进 ----
  (() => {
    const ta = document.getElementById('strategyCodeInput');
    const gutter = document.getElementById('strategyCodeGutter');
    const meta = document.getElementById('strategyCodeMeta');
    const editor = document.getElementById('strategyCodeEditor');
    if (!ta || !gutter) return;
    const sync = () => {
      const lines = ta.value ? ta.value.split('\n').length : 1;
      // 行号槽独立渲染，跟 textarea 用同一套字号/行高，滚动时手动对齐
      gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
      if (meta) meta.textContent = ta.value ? `${lines} 行 · ${ta.value.length} 字符` : '空';
    };
    ta.addEventListener('input', sync);
    // textarea 滚动时行号跟着滚，否则长代码里行号会和代码错位
    ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
    // Tab 插入两个空格而不是跳走焦点——粘进来的代码要微调缩进时，默认行为会直接跳出输入框
    ta.addEventListener('keydown', e => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const s0 = ta.selectionStart, e0 = ta.selectionEnd;
      ta.value = ta.value.slice(0, s0) + '  ' + ta.value.slice(e0);
      ta.selectionStart = ta.selectionEnd = s0 + 2;
      sync();
    });
    // ---- 代码搜索：在 textarea 里定位并选中匹配 ----
    // 267 行的策略代码里找一条 check 很费劲。用 setSelectionRange 选中 + 手动滚到该行，
    // 比浏览器自带的 Ctrl+F 好用（自带的在 textarea 里定位不准、也不会选中）。
    const searchInput = document.getElementById('strategyCodeSearch');
    const searchCount = document.getElementById('strategyCodeSearchCount');
    let matches = [], matchIdx = -1;
    const lineHeightPx = () => {
      const lh = parseFloat(getComputedStyle(ta).lineHeight);
      return Number.isFinite(lh) ? lh : 18;
    };
    function findMatches() {
      const q = (searchInput.value || '').trim();
      matches = [];
      if (q) {
        const hay = ta.value.toLowerCase(), needle = q.toLowerCase();
        let i = hay.indexOf(needle);
        while (i !== -1) { matches.push(i); i = hay.indexOf(needle, i + Math.max(1, needle.length)); }
      }
      matchIdx = matches.length ? 0 : -1;
      updateCount();
      if (matches.length) jumpTo(0);
    }
    function updateCount() {
      if (!searchCount) return;
      const q = (searchInput.value || '').trim();
      searchCount.textContent = !q ? '' : (matches.length ? `${matchIdx + 1}/${matches.length}` : '无匹配');
      searchCount.style.color = (q && !matches.length) ? 'var(--warn, #ff9f0a)' : '';
    }
    function jumpTo(i) {
      if (!matches.length) return;
      matchIdx = (i + matches.length) % matches.length;
      const pos = matches[matchIdx];
      const len = (searchInput.value || '').trim().length;
      ta.focus();
      ta.setSelectionRange(pos, pos + len);
      // 滚到匹配行并留几行上下文，否则匹配可能贴在视口最顶/最底看不清
      const lineNo = ta.value.slice(0, pos).split('\n').length - 1;
      ta.scrollTop = Math.max(0, (lineNo - 4) * lineHeightPx());
      gutter.scrollTop = ta.scrollTop;
      updateCount();
    }
    if (searchInput) {
      searchInput.addEventListener('input', findMatches);
      searchInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); jumpTo(matchIdx + (e.shiftKey ? -1 : 1)); }
        else if (e.key === 'Escape') { searchInput.value = ''; findMatches(); }
      });
      document.getElementById('strategyCodeSearchNext').addEventListener('click', () => jumpTo(matchIdx + 1));
      document.getElementById('strategyCodeSearchPrev').addEventListener('click', () => jumpTo(matchIdx - 1));
    }
    // 代码变了要重算匹配，否则计数会对不上
    ta.addEventListener('input', () => { if (searchInput && searchInput.value.trim()) findMatches(); });

    const foldBtn = document.getElementById('strategyCodeFoldBtn');
    if (foldBtn) foldBtn.addEventListener('click', () => {
      const folded = editor.classList.toggle('folded');
      foldBtn.textContent = folded ? '▸ 展开' : '▾ 折叠';
    });
    const clearBtn = document.getElementById('strategyCodeClearBtn');
    if (clearBtn) clearBtn.addEventListener('click', async () => {
      if (!ta.value) return;
      if (!await showConfirm('确定清空策略代码？', { danger: true, okText: '清空' })) return;
      ta.value = ''; sync();
      try { localStorage.removeItem(STRATEGY_CODE_STORAGE_KEY); } catch (err) {}
      showToast('已清空');
    });
    sync();
    // 恢复本地缓存后要再同步一次行号（下面那段 localStorage 恢复在此之后执行）
    setTimeout(sync, 0);
  })();

  // 策略代码通常是从编辑器里粘过来的一大段，每次切换页面都要重贴太折腾，存本地
  const strategyCodeEl = document.getElementById('strategyCodeInput');
  try {
    const saved = localStorage.getItem(STRATEGY_CODE_STORAGE_KEY);
    if (saved) strategyCodeEl.value = saved;
  } catch (e) {}
  strategyCodeEl.addEventListener('change', () => {
    try { localStorage.setItem(STRATEGY_CODE_STORAGE_KEY, strategyCodeEl.value); } catch (e) {}
  });
}

initProAnalytics();
