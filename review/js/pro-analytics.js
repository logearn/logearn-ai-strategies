// ========== Pro 分析功能：相关性矩阵 / 分组对比 / 特征重要性(OLS) / 时间维度 / 分类字段分析 ==========
// 必须最后加载：复用 ui.js（activeRows/scatterOptions/attachAutocomplete/getFeature 等）
// 和 charts.js（darkLayout/palette）里已经定义好的状态与函数。
// 所有功能默认锁定，点击"解锁 Pro 分析功能"后才展示（本地开关，无真实付费校验）。

const PRO_UNLOCK_STORAGE_KEY = 'chart_pro_unlocked';
let proUnlocked = false;

function loadProUnlockState() {
  try { proUnlocked = localStorage.getItem(PRO_UNLOCK_STORAGE_KEY) === '1'; } catch (e) { proUnlocked = false; }
}
function saveProUnlockState() {
  try { localStorage.setItem(PRO_UNLOCK_STORAGE_KEY, proUnlocked ? '1' : '0'); } catch (e) {}
}
function applyProUnlockUi() {
  document.getElementById('proLockedNotice').classList.toggle('hidden', proUnlocked);
  document.getElementById('proContent').classList.toggle('hidden', !proUnlocked);
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

  return { getSelected: () => selected };
}

// ---------- 1. 相关性矩阵 / 热力图 ----------
function renderCorrMatrix(fields) {
  if (fields.length < 2) { alert('请至少选择 2 个字段'); return; }
  if (!activeRows.length) { alert('请先点击"分析"加载数据'); return; }
  const matrix = fields.map(fx => fields.map(fy => {
    if (fx === fy) return 1;
    const pairs = [];
    for (const row of activeRows) {
      const vx = getFeature(row, fx), vy = getFeature(row, fy);
      if (isFiniteNumber(vx) && isFiniteNumber(vy)) pairs.push([Number(vx), Number(vy)]);
    }
    return pairs.length >= 5 ? pearson(pairs) : NaN;
  }));
  const text = matrix.map(row => row.map(v => Number.isFinite(v) ? v.toFixed(2) : 'N/A'));
  Plotly.newPlot('corrMatrixChart', [{
    z: matrix, x: fields, y: fields, type: 'heatmap',
    zmin: -1, zmax: 1, colorscale: 'RdBu', reversescale: true,
    text, texttemplate: '%{text}', hoverinfo: 'x+y+z'
  }], darkLayout({
    title: '字段两两 Pearson r 相关性矩阵',
    margin: { t: 50, l: 140, b: 140 },
    xaxis: { tickangle: -45 }
  }), { responsive: true });
}

// ---------- 2. 分组对比分析 ----------
function renderGroupCompare(groupField, featureField, targetField) {
  if (!activeRows.length) { alert('请先点击"分析"加载数据'); return; }
  if (!groupField || !featureField) { alert('请填写分组字段和特征字段'); return; }
  const groups = new Map();
  for (const row of activeRows) {
    const gv = getFeature(row, groupField);
    const key = (gv === undefined || gv === null || gv === '') ? '(空)' : String(gv);
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
    const r = pairs.length >= 5 ? pearson(pairs) : NaN;
    const p = pairs.length >= 5 ? pearsonPValue(r, pairs.length) : NaN;
    stats.push({ key, n: rows.length, mean, winRate, r, p, rn: pairs.length });
  }
  stats.sort((a, b) => b.n - a.n);
  if (!stats.length) { alert('没有可用的分组数据，请检查字段是否正确'); return; }

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

function renderFeatureImportance(targetField, fields) {
  if (!activeRows.length) { alert('请先点击"分析"加载数据'); return; }
  if (fields.length < 1) { alert('请至少选择 1 个特征字段'); return; }
  // 完整案例：目标和全部特征都必须是有限数字才纳入回归，避免缺失值破坏矩阵运算
  const rows = activeRows.filter(row => {
    const tv = getFeature(row, targetField);
    if (!isFiniteNumber(tv)) return false;
    return fields.every(f => isFiniteNumber(getFeature(row, f)));
  });
  if (rows.length < fields.length + 5) {
    alert(`完整样本数（${rows.length}）过少，无法稳定回归。请减少特征数量或检查字段是否大量缺失。`);
    return;
  }
  const y = standardize(rows.map(r => Number(getFeature(r, targetField))));
  const constFields = [];
  const xStd = fields.map(f => {
    const s = standardize(rows.map(r => Number(getFeature(r, f))));
    if (s.std < 1e-12) constFields.push(f);
    return s;
  });
  if (constFields.length) {
    alert(`以下字段在当前数据里几乎是常数，无法参与回归，已自动剔除：${constFields.join('、')}`);
  }
  const usedFields = fields.filter((f, i) => xStd[i].std >= 1e-12);
  const usedX = xStd.filter(s => s.std >= 1e-12);
  if (!usedFields.length) { alert('所有特征都是常数，无法回归'); return; }

  const n = rows.length, k = usedFields.length;
  // 自变量数不能超过可用样本数（矩阵不可逆的必要条件），直接拦截
  if (k >= n) {
    alert(`自变量数量（${k}）不能超过可用样本数（${n}），请减少字段或放宽过滤条件。`);
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

  const result = usedFields.map((f, i) => ({ field: f, beta: beta[i], vif: vifs[i], r: univariateR[i] }));
  result.sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta));

  document.getElementById('importanceResult').innerHTML =
    `<b>完整样本数:</b> ${n} &nbsp; <b>R²:</b> ${r2.toFixed(4)} &nbsp; <b>调整 R²:</b> ${Number.isFinite(adjR2) ? adjR2.toFixed(4) : '-'} &nbsp;
    <span style="color:var(--text-muted)">（这 ${k} 个字段合计能解释 ${targetField} 方差的 ${(Math.max(0, adjR2 || r2) * 100).toFixed(1)}%；标准化系数：每变化 1 个标准差对目标的独立贡献，符号=方向，绝对值=强度）</span>`;

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

// ---------- 4. 时间维度分析 ----------
function renderTimeAnalysis(featureField, targetField, bucketCount) {
  if (!activeRows.length) { alert('请先点击"分析"加载数据'); return; }
  const withTime = activeRows.filter(r => isFiniteNumber(r.swapBeginTime));
  if (withTime.length < 10) { alert('有效的 swap_begin_time 样本太少（< 10），无法做时间分桶分析'); return; }
  const times = withTime.map(r => r.swapBeginTime);
  const minT = Math.min(...times), maxT = Math.max(...times);
  if (maxT <= minT) { alert('样本的开仓时间几乎相同，无法分桶'); return; }
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
}

// ---------- 5. 分类字段与收益关系（箱线图 + 胜率对比） ----------
function renderCatAnalysis(catField, valueField) {
  if (!activeRows.length) { alert('请先点击"分析"加载数据'); return; }
  if (!catField || !valueField) { alert('请填写分类字段和目标数值字段'); return; }
  const groups = new Map();
  for (const row of activeRows) {
    const gv = getFeature(row, catField);
    const key = (gv === undefined || gv === null || gv === '') ? '(空)' : String(gv);
    const vv = getFeature(row, valueField);
    if (!isFiniteNumber(vv)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(Number(vv));
  }
  if (!groups.size) { alert('没有可用数据，请检查字段是否正确'); return; }
  // 分类值过多（比如误把连续数值字段当分类字段）时箱线图会失去意义，这里提示但不阻断
  if (groups.size > 30) {
    if (!confirm(`检测到 ${groups.size} 个不同分类值，可能不是合适的分类字段，是否继续？`)) return;
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

  const rows = entries.map(([key, vals]) => {
    const stats = calcStats(vals, 1);
    return { key, n: stats.count, mean: stats.mean, median: stats.median, winRate: stats.winRate };
  });
  document.getElementById('catAnalysisBody').innerHTML = rows.map(s => `
    <tr>
      <td>${escapeHtml(s.key)}</td>
      <td class="num">${s.n}</td>
      <td class="num">${formatNumberSmart(s.mean)}</td>
      <td class="num">${formatNumberSmart(s.median)}</td>
      <td class="num">${(s.winRate * 100).toFixed(1)}%</td>
    </tr>
  `).join('');
}

// ---------- 初始化：解锁开关 + 各 section 的输入联想/按钮绑定 ----------
function initProAnalytics() {
  loadProUnlockState();
  applyProUnlockUi();
  document.getElementById('proUnlockBtn').addEventListener('click', () => {
    proUnlocked = true;
    saveProUnlockState();
    applyProUnlockUi();
  });

  const corrMatrixSelector = makeFieldTagSelector('corrMatrixInput', 'corrMatrixTagBox');
  document.getElementById('genCorrMatrixBtn').addEventListener('click', () => renderCorrMatrix(corrMatrixSelector.getSelected()));

  const importanceSelector = makeFieldTagSelector('importanceInput', 'importanceTagBox');
  document.getElementById('genImportanceBtn').addEventListener('click', () => {
    renderFeatureImportance(document.getElementById('importanceTargetField').value, importanceSelector.getSelected());
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
      document.getElementById('groupFeatureField').value.trim(),
      document.getElementById('groupTargetField').value
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

  attachAutocomplete(document.getElementById('catField'), document.getElementById('catField'), 'filterFieldList', v => {
    document.getElementById('catField').value = v;
  });
  attachAutocomplete(document.getElementById('catValueField'), document.getElementById('catValueField'), 'xFieldList', v => {
    document.getElementById('catValueField').value = v;
  });
  document.getElementById('genCatAnalysisBtn').addEventListener('click', () => {
    renderCatAnalysis(document.getElementById('catField').value.trim(), document.getElementById('catValueField').value.trim());
  });
}

initProAnalytics();
