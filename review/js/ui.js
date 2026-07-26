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

// 样本外验证（训练/测试集相关性）结果缓存：只在 method/ratio/seed 真正变化时才重新
// splitTrainTest + computeCorrelations(train) + computeCorrelations(test)。
// 之前 renderCorrTable 每次调用（包括阈值筛选框敲字触发的 input 事件、切换排序/校正方式等
// 跟切分完全无关的操作）都会在 oosEnabled 时无条件重算一遍，字段多、样本量大时明显卡顿。
// 缓存的失效时机是 refreshAnalysisViews()（数据集真正变化的唯一入口），而不是靠 activeRows
// 的引用比较——因为自定义字段编辑等场景会原地 mutate 现有行的 features，activeRows 引用不变
// 但数据内容已经变了，引用比较会误判为"没变"从而返回过期结果。
let oosCorrCache = null;
function getOosCorrelations(method, ratio, seed) {
  if (oosCorrCache && oosCorrCache.method === method && oosCorrCache.ratio === ratio && oosCorrCache.seed === seed) {
    return oosCorrCache;
  }
  const { train, test } = splitTrainTest(activeRows, method, ratio, 'swapBeginTime', seed);
  oosCorrCache = {
    method, ratio, seed,
    trainCorr: computeCorrelations(train),
    testCorr: computeCorrelations(test),
    testN: test.length
  };
  return oosCorrCache;
}

function updateSummary() {
  const el = document.getElementById('summaryText');
  if (!activeRows.length) {
    el.innerHTML = `<div class="stat-row">
      <div class="stat-tile"><div class="stat-label">匹配样本数</div><div class="stat-value">0</div></div>
      <div class="stat-row-note">当前过滤条件下没有样本，原始 ${matchedRows.length} 条</div>
    </div>`;
    return;
  }
  const mx = activeRows.map(r => r.returnMax);
  const ms = calcStats(mx, WIN_THRESHOLD);
  const filterNote = activeRows.length !== matchedRows.length
    ? `<div class="stat-row-note">已应用全局过滤，原始 ${matchedRows.length} 条</div>` : '';
  // 观察窗口偏差检测：returnMax 的 max_mcap 只统计到导出时刻，观察时长太短的样本还没机会创出
  // 真实最高点，会系统性拉低整体胜率/均值。阈值 6 小时——meme 类 token 的最大涨幅通常在几分钟到
  // 几小时内出现，6 小时后仍未定型的占比已经不高。
  const OBS_WINDOW_MIN_SECONDS = 6 * 3600;
  const obsWindows = activeRows
    .map(r => (Number.isFinite(r.exportTimestamp) && Number.isFinite(r.buyTimestamp)) ? r.exportTimestamp - r.buyTimestamp : null)
    .filter(v => v !== null && v >= 0);
  let obsNote = '';
  let obsTile = '';
  if (obsWindows.length) {
    const sortedObs = obsWindows.slice().sort((a, b) => a - b);
    const medianObs = percentile(sortedObs, 0.5);
    const fmtDur = s => s >= 86400 ? (s / 86400).toFixed(1) + '天' : s >= 3600 ? (s / 3600).toFixed(1) + '小时' : Math.round(s / 60) + '分钟';
    obsTile = `<div class="stat-tile"><div class="stat-label" title="从买入（快照抓取时刻）到数据导出经过的时长；returnMax 只统计到导出为止">观察时长中位数</div><div class="stat-value">${fmtDur(medianObs)}</div></div>`;
    const freshCount = obsWindows.filter(v => v < OBS_WINDOW_MIN_SECONDS).length;
    if (freshCount > 0) {
      obsNote = `<div class="stat-row-note" style="color:var(--warn, #ff9f0a);">⚠️ ${freshCount} 条样本（${(freshCount / obsWindows.length * 100).toFixed(0)}%）观察时长不足 6 小时，其 returnMax 可能尚未定型，会拉低整体胜率/均值——和观察时间充分的老样本混在一起对比时要注意这个偏差。</div>`;
    }
  }
  // 非独立样本检测：同一个 token 触发多次信号，这些样本的收益高度相关，但所有统计都把它们当独立
  // 样本算，会虚增显著性。样本数和去重 token 数差距明显时给出警告和一键去重入口。
  const uniqueTokens = new Set(activeRows.map(r => (r.tokenAddress || '').toLowerCase()).filter(Boolean)).size;
  const dupNote = uniqueTokens > 0 && activeRows.length > uniqueTokens * 1.2
    ? `<div class="stat-row-note" style="color:var(--warn, #ff9f0a);">⚠️ ${activeRows.length} 条样本里只有 ${uniqueTokens} 个不同 token（同一 token 的多次信号收益高度相关，会虚增所有统计检验的显著性）。<button type="button" id="dedupPerTokenBtn" class="secondary" style="padding:3px 12px; font-size:12px; margin-left:8px;">每 token 只保留首条信号</button></div>`
    : '';
  // 几个关键数字以前是挤在一行的 label:value 文字，数字越多越难一眼扫清哪个是哪个；
  // 改成一排卡片（label 在上/次要色，value 在下/大号），扫描效率更高。
  el.innerHTML = `
    <div class="stat-row">
      <div class="stat-tile"><div class="stat-label">匹配样本数</div><div class="stat-value accent">${activeRows.length}</div></div>
      <div class="stat-tile"><div class="stat-label" title="去重后的不同 token 个数；和样本数差距大说明存在同一 token 的重复信号">去重 token 数</div><div class="stat-value">${uniqueTokens || '-'}</div></div>
      <div class="stat-tile"><div class="stat-label">returnMax 平均倍数</div><div class="stat-value">${ms.mean.toFixed(4)}x</div></div>
      <div class="stat-tile"><div class="stat-label">胜率（倍数&gt;2，翻倍）</div><div class="stat-value">${(ms.winRate * 100).toFixed(1)}%</div></div>
      <div class="stat-tile"><div class="stat-label">最大倍数</div><div class="stat-value">${ms.max.toFixed(4)}x</div></div>
      ${obsTile}
      ${filterNote}
      ${obsNote}
      ${dupNote}
    </div>
  `;
  const dedupBtn = document.getElementById('dedupPerTokenBtn');
  if (dedupBtn) {
    dedupBtn.addEventListener('click', async () => {
      if (!await showConfirm(`将从当前工作集中排除同一 token 的重复信号（每 token 保留买入时间最早的一条），${activeRows.length} 条 → ${uniqueTokens} 条。不修改原始文件，重新点"分析"或清除过滤即可恢复，是否继续？`)) return;
      const byToken = new Map();
      for (const r of activeRows) {
        const key = (r.tokenAddress || '').toLowerCase() || `__no_addr_${byToken.size}`;
        const prev = byToken.get(key);
        const rTime = Number.isFinite(r.buyTimestamp) ? r.buyTimestamp : (r.swapBeginTime || Infinity);
        const prevTime = prev ? (Number.isFinite(prev.buyTimestamp) ? prev.buyTimestamp : (prev.swapBeginTime || Infinity)) : Infinity;
        if (!prev || rTime < prevTime) byToken.set(key, r);
      }
      activeRows = [...byToken.values()];
      refreshAnalysisViews();
      showToast(`已按 token 去重：现在的工作集为 ${activeRows.length} 条（每 token 保留首条信号）`);
    });
  }
}

// 相关性表里勾选的行（key 为 `${target}|${feature}`），跨搜索过滤/排序持久保留，
// 方便先按不同关键词搜几轮、勾选好几批字段，最后一次性"加入散点图 X 轴"。
let corrSelectedRows = new Set();

function updateCorrSendToScatterBtn() {
  const btn = document.getElementById('corrSendToScatterBtn');
  const countEl = document.getElementById('corrSelectedCount');
  if (!btn || !countEl) return;
  countEl.textContent = corrSelectedRows.size;
  btn.disabled = corrSelectedRows.size === 0;
}

function renderCorrTable() {
  const target = document.getElementById('corrTarget').value;
  const source = document.getElementById('corrSource').value;
  const top = Number(document.getElementById('topN').value);
  const correction = document.getElementById('corrCorrection').value;
  const sortBy = document.getElementById('corrSortBy').value;
  const oosEnabled = document.getElementById('oosEnabled').checked;
  const minAbsR = parseFloat(document.getElementById('corrFilterMinAbsR').value);
  const minN = parseFloat(document.getElementById('corrFilterMinN').value);
  const maxP = parseFloat(document.getElementById('corrFilterMaxP').value);
  const maxAdjP = parseFloat(document.getElementById('corrFilterMaxAdjP').value);
  const ciExcludesZero = document.getElementById('corrFilterCiExcludesZero').checked;

  // m 必须是当前 目标/来源 筛选下参与检验的全部字段数（不是 topN 截断后的数量），
  // 否则会系统性低估需要校正的严重程度；corrSource/corrTarget 切换时 m 会跟着重新计算。
  // “全部”不包含 log 目标：共享判断见 data.js 里的 matchCorrTarget。
  const fullSet = allCorrelations.filter(c => matchCorrTarget(c, target) && (source === 'all' || c.source === source));
  if (sortBy === 'delta') {
    fullSet.sort((a, b) => (Number.isFinite(b.delta) ? b.delta : -1) - (Number.isFinite(a.delta) ? a.delta : -1));
  } else if (sortBy === 'rho') {
    // Spearman 排序：秩相关对重尾收益的极端值不敏感，比 |r| 排序更不容易把“被几个极端样本
    // 撑起来的字段”排到前面；ρ 无法计算（布尔字段等）的排末尾
    fullSet.sort((a, b) => (Number.isFinite(b.rho) ? Math.abs(b.rho) : -1) - (Number.isFinite(a.rho) ? Math.abs(a.rho) : -1));
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
  // 候选池治理摘要：说明有多少无效字段没有进入检验（既是透明度，也是提醒"m 已经瘦身，校正没那么苛刻了"）；
  // 悬浮可以看具体剔除了哪些字段
  const ex = allCorrelations._excluded;
  if (ex) {
    // 按桶遍历而不是逐个写死桶名：新增一类剔除原因时只要在下面的标签表里补一行，
    // 漏了也只是显示成原始 key，不会像之前那样把整条分析链路带崩。
    const exLabels = { timestamp: '时间戳', internal: '内部标记', metadata: '元数据/常量', constant: '取值恒定' };
    const exEntries = Object.entries(ex).filter(([, v]) => Array.isArray(v) && v.length);
    const exTotal = exEntries.reduce((n, [, v]) => n + v.length, 0);
    if (exTotal > 0) {
      const brief = exEntries.map(([k, v]) => `${exLabels[k] || k} ${v.length}`).join('、');
      summaryEl.textContent += ` 另有 ${exTotal} 个无效字段已自动剔除、不占检验名额（${brief}）。`;
      summaryEl.title = exEntries
        .map(([k, v]) => `${exLabels[k] || k}字段：${v.join('、')}`)
        .join('\n');
    } else {
      summaryEl.title = '';
    }
  }

  // 样本外验证：按训练/测试集分别跑一遍 computeCorrelations，两组结果并排展示，
  // 而不是只在训练集上重新拟合（重新拟合就失去了"验证"的意义）
  let testN = 0;
  const oosWarnEl = document.getElementById('oosWarning');
  if (oosEnabled) {
    const { method, ratio, seed } = readSplitOptions('oos');
    const { trainCorr, testCorr, testN: cachedTestN } = getOosCorrelations(method, ratio, seed);
    testN = cachedTestN;
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

  document.querySelector('#corrTableHead tr').innerHTML = '<th><input type="checkbox" id="corrSelectAll" title="全选当前过滤后的字段"></th><th>目标</th><th>字段</th><th>中文含义</th><th>来源</th>'
    + '<th class="num" title="综合覆盖率/样本量/离群敏感性/线性一致性/时间稳定性的 0-100 评分，悬浮单元格可看具体扣分原因">质量分</th><th class="num">r</th>'
    + (oosEnabled ? '<th class="num">训练集 r</th><th class="num">测试集 r</th>' : '')
    + '<th class="num">Spearman ρ</th><th class="num">|Δ|</th><th class="num">n</th><th class="num">p</th><th class="num">校正后 p</th><th>r 的 95% CI</th><th>操作</th>';

  // 数值阈值过滤只影响表格展示范围（在 topN 截断之前过滤，避免"排名靠后但确实合格"的字段被 Top N 挡住），
  // 不影响多重比较校正的 m（m 必须基于完整候选集，否则会系统性低估校正严重程度）。
  // 典型用法：先点"计算置信区间"，再用这些阈值把不合格的字段筛掉，剩下的批量勾选加入散点图。
  let threshFilteredSet = fullSet;
  if (Number.isFinite(minAbsR) || Number.isFinite(minN) || Number.isFinite(maxP) || Number.isFinite(maxAdjP) || ciExcludesZero) {
    threshFilteredSet = fullSet.filter(c => {
      if (Number.isFinite(minAbsR) && !(Math.abs(c.r) >= minAbsR)) return false;
      if (Number.isFinite(minN) && !(c.n >= minN)) return false;
      if (Number.isFinite(maxP) && !(Number.isFinite(c.p) && c.p <= maxP)) return false;
      if (Number.isFinite(maxAdjP) && !(Number.isFinite(c._adjP) && c._adjP <= maxAdjP)) return false;
      if (ciExcludesZero) {
        const ci = bootstrapCIMap.get(`${c.target}|${c.feature}`);
        if (!ci || !Number.isFinite(ci.lo) || !Number.isFinite(ci.hi) || (ci.lo < 0 && ci.hi > 0)) return false;
      }
      return true;
    });
  }
  const filtered = threshFilteredSet.slice(0, top);
  const tbody = document.getElementById('corrBody');
  tbody.innerHTML = filtered.map(c => {
    // 曾经 p<0.05、校正后不再显著的行：用浅灰+删除线区分，而不是直接从表格里消失——
    // 让用户看到"曾经以为显著、其实经不起多重比较校验"的字段，这本身就是重要信息
    const wasDemoted = correction !== 'none' && Number.isFinite(c.p) && c.p < 0.05 && !(Number.isFinite(c._adjP) && c._adjP < 0.05);
    const rowStyle = wasDemoted ? ' style="color: var(--text-muted); text-decoration: line-through;"' : '';
    // |Δ| 较大说明 Pearson r 和 Spearman ρ 明显不一致，可能存在非线性但单调的关系，提示去散点图里看形状
    const deltaFlag = Number.isFinite(c.delta) && c.delta > 0.15
      ? ` <span title="该字段的线性相关性和单调相关性差异较大，可能存在非线性关系，建议在散点图里查看具体形状（可尝试打开对数轴）">🔀</span>` : '';
    // 离群值敏感性：剔除两侧极端 ~1% 样本后 r 大幅缩水或变号 → 该相关性主要由少数极端样本撑起，
    // 换一批数据大概率不复现，标记出来防止用户被点估计值唬住
    const outlierFlag = c.outlierDriven
      ? ` <span title="剔除极端 1% 样本后 r 从 ${c.r.toFixed(3)} 变为 ${Number.isFinite(c.rTrim) ? c.rTrim.toFixed(3) : '-'}：该相关性主要由少数极端样本驱动，谨慎采信">📌</span>` : '';
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
    const rowKey = `${c.target}|${c.feature}`;
    const checked = corrSelectedRows.has(rowKey) ? ' checked' : '';
    return `
    <tr${rowStyle}>
      <td><input type="checkbox" class="corr-row-select" data-key="${escapeHtml(rowKey)}" data-feature="${escapeHtml(c.feature)}"${checked}></td>
      <td>${escapeHtml(c.target)}</td>
      <td>${escapeHtml(c.feature)}</td>
      <td class="ellip" title="${escapeHtml(getFieldDesc(c.feature))}">${escapeHtml(getFieldDesc(c.feature)) || '暂无备注'}</td>
      <td><span class="tag ${c.source}">${c.source === 'assembled' ? '组装' : '原始'}</span></td>
      <td class="num" style="color:${c.quality >= 80 ? 'var(--green)' : c.quality >= 50 ? '#ff9f0a' : 'var(--red)'}; font-weight:600;"${c.qualityReasons && c.qualityReasons.length ? ` title="${escapeHtml('扣分原因：\n' + c.qualityReasons.join('\n'))}"` : ' title="各项质量检查均通过"'}>${Number.isFinite(c.quality) ? c.quality : '-'}</td>
      <td class="num"${c.outlierDriven ? ' style="color:#ff9f0a;"' : ''}>${c.r.toFixed(4)}${outlierFlag}</td>
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
  tbody.querySelectorAll('input.corr-row-select').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) corrSelectedRows.add(cb.dataset.key);
      else corrSelectedRows.delete(cb.dataset.key);
      updateCorrSendToScatterBtn();
    });
  });
  const selectAllCb = document.getElementById('corrSelectAll');
  if (selectAllCb) {
    selectAllCb.checked = filtered.length > 0 && filtered.every(c => corrSelectedRows.has(`${c.target}|${c.feature}`));
    selectAllCb.addEventListener('change', () => {
      if (selectAllCb.checked) filtered.forEach(c => corrSelectedRows.add(`${c.target}|${c.feature}`));
      else filtered.forEach(c => corrSelectedRows.delete(`${c.target}|${c.feature}`));
      renderCorrTable();
    });
  }
  updateCorrSendToScatterBtn();
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
    const rm = r.returnMax;
    if (Number.isFinite(rm) && rm <= 0) reasons.push(`returnMax(${rm.toFixed(2)}x) ≤ 0，收益倍数理论上应该 > 0`);
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

  excludeBtn.onclick = async () => {
    const flaggedIds = new Set(alerts.map(a => a.row.id));
    if (!flaggedIds.size) return;
    if (!await showConfirm(`确定要从当前工作集中排除这 ${flaggedIds.size} 条记录吗？（不会修改原始文件，只影响当前分析）`)) return;
    activeRows = activeRows.filter(r => !flaggedIds.has(r.id));
    refreshAnalysisViews();
  };
}

// Bootstrap 置信区间：只对当前表格里可见的字段计算（而不是全部字段），把计算量控制在用户实际关心的范围内；
// 分批 yield 主线程（复用 14.3 的分批处理思路），避免大量重抽样计算卡住页面；支持随时取消。
async function runBootstrapCI() {
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  if (bootstrapRunning) return;

  const target = document.getElementById('corrTarget').value;
  const source = document.getElementById('corrSource').value;
  const top = Number(document.getElementById('topN').value);
  const B = Math.max(100, Math.min(2000, Number(document.getElementById('bootstrapResamples').value) || 500));

  const fullSet = allCorrelations.filter(c => matchCorrTarget(c, target) && (source === 'all' || c.source === source));
  fullSet.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  const targets = fullSet.slice(0, top);
  if (!targets.length) { showToast('当前表格没有可计算的字段'); return; }

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
  const searchTerm = (document.getElementById('fieldQualitySearch').value || '').trim().toLowerCase();
  if (searchTerm) {
    rowsData = rowsData.filter(r => {
      const desc = (getFieldDesc(r.field) || '').toLowerCase();
      return r.field.toLowerCase().includes(searchTerm) || desc.includes(searchTerm);
    });
  }
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

// ---------- 字段说明浮层 ----------
// 给任何带 data-field-tip="字段名" 的元素加悬停提示：字段分类 + 中文含义 + 计算公式。
// 用事件委托挂在 document 上，这样动态生成的元素（图表标题每次 rerender 都会重建）不用逐个绑定。
let fieldTipEl = null;

function fieldKindLabel(field) {
  if (customFields.some(c => c.name === field)) return '自定义字段';
  if (typeof isDevField === 'function' && isDevField(field)) return 'dev 字段';
  if (typeof isStatField === 'function' && isStatField(field)) return 'stat 字段';
  if (typeof isChipField === 'function' && isChipField(field)) return '筹码字段';
  if (typeof isHolderField === 'function' && isHolderField(field)) return '持有人字段';
  if (typeof isSignalField === 'function' && isSignalField(field)) return '信号字段';
  if (isAssembledField(field)) return '组装字段';
  if (typeof isHoldingField === 'function' && isHoldingField(field)) return '持仓指标';
  if (typeof ORIGINAL_FIELD_WHITELIST !== 'undefined' && ORIGINAL_FIELD_WHITELIST.has(field)) return '原字段';
  return '原字段';
}

function buildFieldTipHtml(field) {
  const desc = getFieldDesc(field);
  // 自定义字段的"计算公式"就是用户自己写的那段代码，内置的组装/信号字段则把公式写在中文说明里，
  // 所以这里只有自定义字段需要额外贴一段代码块
  const custom = customFields.find(c => c.name === field);
  return `<div><span class="field-tip-name">${escapeHtml(field)}</span><span class="field-tip-kind">${escapeHtml(fieldKindLabel(field))}</span></div>`
    + `<div class="field-tip-desc">${desc ? escapeHtml(desc) : '暂无字段说明'}</div>`
    + (custom ? `<div class="field-tip-code">${escapeHtml(custom.code)}</div>` : '');
}

function showFieldTip(target, field) {
  if (!fieldTipEl) {
    fieldTipEl = document.createElement('div');
    fieldTipEl.className = 'field-tip';
    document.body.appendChild(fieldTipEl);
  }
  fieldTipEl.innerHTML = buildFieldTipHtml(field);
  fieldTipEl.classList.add('show');
  // 先显示再量尺寸，否则 display:none 时量出来是 0，没法做边界收拢
  const r = target.getBoundingClientRect();
  const tip = fieldTipEl.getBoundingClientRect();
  let left = r.left;
  let top = r.bottom + 8;
  if (left + tip.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - tip.width - 8);
  // 下方放不下就翻到元素上方，避免浮层被视口截断
  if (top + tip.height > window.innerHeight - 8) top = Math.max(8, r.top - tip.height - 8);
  fieldTipEl.style.left = left + 'px';
  fieldTipEl.style.top = top + 'px';
}

function hideFieldTip() {
  if (fieldTipEl) fieldTipEl.classList.remove('show');
}

document.addEventListener('mouseover', e => {
  const t = e.target.closest && e.target.closest('[data-field-tip]');
  if (t) showFieldTip(t, t.getAttribute('data-field-tip'));
});
document.addEventListener('mouseout', e => {
  if (e.target.closest && e.target.closest('[data-field-tip]')) hideFieldTip();
});
// 滚动时元素会移位，浮层是 fixed 定位不会跟着走，直接隐藏比错位显示好
window.addEventListener('scroll', hideFieldTip, true);

// 从字段质量表跳转到相关性表定位该字段：数值字段直接在相关性表里高亮对应行；
// 分类字段本身不参与相关性计算（pearson 只对数值有意义），提示改去 Pro 分析的分组/分类视图看
function jumpToCorrField(field) {
  if (!scatterOptions.includes(field) && field !== 'returnMax') {
    showToast('该字段是分类字段，不参与相关性计算；可以在下方“Pro 分析”里的“分组对比”或“分类字段分析”中查看。');
    return;
  }
  document.getElementById('corrTarget').value = 'returnMax';
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
    // 常用字段排到最前面（Array.sort 是稳定排序，组内保持原有顺序不变），并单独高亮+打标，
    // 不用每次都从几十上百个字段里重新找"哪些是核实过靠谱的"
    opts.sort((a, b) => (isTrustedField(b.value) ? 1 : 0) - (isTrustedField(a.value) ? 1 : 0));
    if (!opts.length) {
      panel.innerHTML = '<div class="ac-empty">无匹配字段</div>';
    } else {
      const trustedCount = opts.findIndex(o => !isTrustedField(o.value));
      panel.innerHTML = opts.slice(0, 300).map((o, i) => {
        const trusted = isTrustedField(o.value);
        // 常用字段和其余字段之间插一条分隔线，明确"上面是常用的，下面是其它"，避免用户以为
        // 排序乱了看不懂
        const divider = i > 0 && i === trustedCount ? '<div class="ac-divider">其它字段</div>' : '';
        return `${divider}
        <div class="ac-item${trusted ? ' trusted' : ''}" data-value="${escapeHtml(o.value)}">
          <div class="ac-item-title">${escapeHtml(o.value)}${trusted ? '<span class="tag trusted">★ 常用</span>' : ''}</div>
          ${o.label && o.label !== o.value ? `<div class="ac-item-desc">${escapeHtml(o.label)}</div>` : ''}
        </div>`;
      }).join('');
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
  // 内部标记（_highlight_*/ai_max_*）和元数据/常量字段（decimals/chain/bnb_price/恒零量等）
  // 从候选池里彻底剔除。判定统一走 data.js 的 isNonAnalyticField，不在这里另写一份条件——
  // 之前就是"相关性池挡了、候选池没挡"，同一件事两处实现必然漂移。
  scatterOptions = ['returnMax', 'logReturnMax', ...allNumericKeys]
    .filter(isNumericColumn)
    .filter(k => !(typeof isNonAnalyticField === 'function' && isNonAnalyticField(k)));
  const defaultX = scatterOptions.includes('buyer_count_d1') ? 'buyer_count_d1' :
    scatterOptions.find(c => c !== 'returnMax') || scatterOptions[0] || '';
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
    <button type="button" class="removeFilterRow danger">删除</button>
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
  oosCorrCache = null; // 数据集真正变了（过滤/分析/自定义字段编辑等），OOS 训练/测试集缓存必须失效
  allCorrelations = computeCorrelations(activeRows);
  renderCorrTable();
  updateSummary();
  plot();
}

function applyFilter() {
  if (!matchedRows.length) { showToast('请先点击“分析”加载数据'); return; }
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
    showToast('以下字段名未匹配到数据中的实际字段，已被忽略（请从下拉联想中选择）：\n' + invalidFields.join('\n'));
  }
  if (emptyThresholdFields.length) {
    showToast('以下字段的阈值为空，已被忽略：\n' + emptyThresholdFields.join('\n'));
  }
  if (!conditions.length) {
    // 没有有效条件：视为清除全局过滤，回到完整数据集
    activeRows = matchedRows;
    refreshAnalysisViews();
    if (!invalidFields.length && !emptyThresholdFields.length) {
      showToast('未输入任何条件，已重置为全部数据');
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
  const avgReturn = results.length ? (results.reduce((a, b) => a + b.returnMax, 0) / results.length).toFixed(4) : '-';
  const usedConditionsNote = `已生效 ${conditions.length} 个条件`;
  document.getElementById('filterStats').innerHTML = `命中 <b>${results.length}</b> / ${matchedRows.length} 条，平均 returnMax = <b>${avgReturn}</b> &nbsp; <span style="color:var(--text-muted)">（${usedConditionsNote}，已同步应用于上方相关性/总览/散点图/分箱图）</span>`;
  document.getElementById('filterBody').innerHTML = results.length ? results.map(r => `
    <tr>
      <td>${escapeHtml(r.symbol || '')}</td>
      <td>${escapeHtml(r.tokenAddress || '')}</td>
      <td>${escapeHtml(r.signalType || '')}</td>
      <td class="num">${r.returnMax.toFixed(4)}x</td>
      <td class="num">${conditions.map(c => { const v = getFeature(r, c.field); return `${escapeHtml(c.field)}: ${escapeHtml(typeof v === 'number' ? formatNumberSmart(v) : v)}`; }).join('<br>')}</td>
      <td>${r.tokenAddress ? `<a href="${escapeHtml(logearnUrl(r.tokenAddress))}" target="_blank" rel="noopener">打开</a>` : ''}</td>
    </tr>
  `).join('') : `<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:20px 12px;">没有满足条件的样本，试试放宽阈值</td></tr>`;
}

function copyFilterCAs() {
  const textarea = document.getElementById('filterCaText');
  const text = textarea.value;
  if (!text) { showToast('没有可复制的 CA'); return; }
  navigator.clipboard.writeText(text).then(() => showToast('已复制 CA 列表到剪贴板')).catch(err => showToast('复制失败：' + err));
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

// ========== 过滤条件保存为"预设方案"（design doc §15.1） ==========
// 常用的过滤条件组合（比如"低风险信号：bundler占比<10% AND top10持仓<30%"）存起来，随时一键应用，
// 不用每次都重新拼几行条件。存储格式和 customFields/datasetIndex 一样走 localStorage。
const FILTER_PRESETS_STORAGE_KEY = 'chart_filter_presets';
let filterPresets = [];

function loadFilterPresets() {
  try {
    const raw = localStorage.getItem(FILTER_PRESETS_STORAGE_KEY);
    filterPresets = raw ? JSON.parse(raw) || [] : [];
  } catch (e) { filterPresets = []; }
}
function saveFilterPresetsToStorage() {
  try { localStorage.setItem(FILTER_PRESETS_STORAGE_KEY, JSON.stringify(filterPresets)); } catch (e) {}
}
function renderFilterPresetOptions() {
  const sel = document.getElementById('filterPresetSelect');
  const current = sel.value;
  sel.innerHTML = '<option value="">-- 选择预设 --</option>' + filterPresets.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}（${p.conditions.length}条件）</option>`).join('');
  if (filterPresets.some(p => p.id === current)) sel.value = current;
}

function saveFilterPreset() {
  const name = document.getElementById('filterPresetInput').value.trim();
  if (!name) { showToast('请填写预设方案名'); return; }
  const conditions = [];
  document.querySelectorAll('#filterRows .filter-row').forEach(row => {
    const field = row.querySelector('.filter-field').value.trim();
    const op = row.querySelector('.filter-op').value;
    const threshold = row.querySelector('.filter-threshold').value.trim();
    if (field && threshold !== '') conditions.push({ field, op, threshold });
  });
  if (!conditions.length) { showToast('当前没有有效的过滤条件（字段+阈值都填写才算有效），无法保存'); return; }
  filterPresets = filterPresets.filter(p => p.name !== name); // 同名覆盖
  filterPresets.push({ id: Date.now() + '_' + Math.random().toString(36).slice(2, 8), name, conditions });
  saveFilterPresetsToStorage();
  document.getElementById('filterPresetInput').value = '';
  renderFilterPresetOptions();
  showToast(`已保存预设「${name}」（${conditions.length} 个条件）`);
}

function applyFilterPreset() {
  const id = document.getElementById('filterPresetSelect').value;
  if (!id) { showToast('请先从下拉框选择一个预设'); return; }
  const preset = filterPresets.find(p => p.id === id);
  if (!preset) return;
  if (!matchedRows.length) { showToast('请先点击"分析"加载数据'); return; }

  // 预设里的字段名如果在当前数据集里不存在（比如换了一批字段结构不同的数据），跳过无效字段行并提示，
  // 而不是应用一半报错中断（design doc §15.1 边界情况）
  const validConditions = [];
  const invalidFields = [];
  for (const c of preset.conditions) {
    if (isFilterableField(c.field)) validConditions.push(c);
    else invalidFields.push(c.field);
  }
  if (invalidFields.length) {
    showToast(`以下字段在当前数据集里不存在，已跳过：\n${invalidFields.join('\n')}`);
  }
  if (!validConditions.length) { showToast('该预设里的字段在当前数据集里全部不存在，无法应用'); return; }

  document.querySelectorAll('#filterRows .filter-row').forEach(r => { if (r._acDestroy) r._acDestroy(); });
  document.getElementById('filterRows').innerHTML = '';
  for (const c of validConditions) addFilterRow(c.field, c.op, c.threshold);
  applyFilter();
}

async function deleteFilterPreset() {
  const id = document.getElementById('filterPresetSelect').value;
  if (!id) { showToast('请先从下拉框选择一个预设'); return; }
  const preset = filterPresets.find(p => p.id === id);
  if (!preset || !await showConfirm(`确定删除预设「${preset.name}」？`, { danger: true, okText: '删除' })) return;
  filterPresets = filterPresets.filter(p => p.id !== id);
  saveFilterPresetsToStorage();
  renderFilterPresetOptions();
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
  // 若"按分组浏览字段"面板正打开，同步刷新其 ✓ 已选中标记，避免和标签列表状态不一致
  const browserPanel = document.getElementById('fieldBrowserPanel');
  if (browserPanel && !browserPanel.classList.contains('hidden')) renderFieldBrowser();
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
    if (!matchedRows.length) { showToast('请先点击"分析"加载数据'); return; }
    const text = textEl.value.trim();
    if (!text) { showToast('请先粘贴内容'); return; }
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

// 按分组浏览字段：把当前可选的 X 字段（scatterOptions）分成"原字段"（数据里本来就有、可直接统计的字段）
// 和"组装字段"（DERIVED_KEYS 里的比率/差值等衍生字段 + 用户自定义字段），点击直接加入 X，
// 不用像自动补全那样一个字一个字打拼音/英文去联想。
// 保存最近一次分组结果，供"+ 全部加入X"按钮直接读取，不用重新计算一遍

async function addFieldsToX(fields) {
  if (!fields.length) return 0;
  // 以前这里超过 20 个字段会弹一个原生 confirm() 警告"可能比较慢"——分页上线后 plot()
  // 只渲染当前页，不会再因为一次加几十上百个字段就把页面卡死，这个警告已经过时，直接去掉；
  // 改成大批量时给个 loading 反馈（renderBatchTags 要重建全部标签 + plot() 渲染首页图表，
  // 字段多的时候仍需要看得见的一小段时间，避免用户以为点击没反应）。
  const run = () => {
    let added = 0;
    for (const f of fields) {
      if (!batchXSelected.includes(f)) { batchXSelected.push(f); added++; }
    }
    renderBatchTags();
    if (matchedRows.length) plot();
    return added;
  };
  return fields.length > 20 ? withLoading(`正在加入 ${fields.length} 个字段...`, () => run()) : run();
}

function copyFieldNames(fields) {
  if (!fields.length) { showToast('该分组暂无字段'); return; }
  navigator.clipboard.writeText(fields.join('\n'))
    .then(() => showToast(`已复制 ${fields.length} 个字段名到剪贴板（每行一个）`))
    .catch(err => showToast('复制失败：' + err));
}

// "原字段"分组的白名单：只有确实是有意义的原始业务字段才归入"原字段"，
// 排除 _highlight_*/ai_max_*/all_signals_max_ratio.* 等内部标记或高度重复的衍生统计字段（这些改归入"组装字段"分组）。
const ORIGINAL_FIELD_WHITELIST = new Set([
  'buy_tx_count_d1', 'buy_wcoin_amount_d1', 'buy_wcoin_amount_h1', 'buy_wcoin_amount_m5',
  'buyer_count_d1', 'frequent_volume', 'gmgn.dev.creator_token_balance',
  'gmgn.dev.dexscr_boost_fee', 
  'gmgn.dev.top_10_holder_rate', 'gmgn.dev.twitter_create_token_count', 'gmgn.dev.twitter_del_post_token_count',
  'gmgn.image_dup_count',
  'gmgn.launchpad_progress', 'gmgn.locked_ratio', 'gmgn.visiting_count', 'gmgn.launchpad_status', 'gmgn.price.hot_level', 'gmgn.pool.fee_ratio', 'gmgn.og', 'gmgn.migration_market_cap', 'launch_time_duration', 'is_fake', 'is_new_m5_hot_ranking_token', 'is_new_h1_hot_ranking_token',
  'gmgn.liquidity', 'gmgn.locked_ratio',
   'gmgn.pool.liquidity',
  'gmgn.price.buy_volume_1h', 'gmgn.price.buy_volume_1m', 'gmgn.price.buy_volume_24h', 'gmgn.price.buy_volume_5m',
  'gmgn.price.buy_volume_6h', 'gmgn.price.buys_1h', 'gmgn.price.buys_1m', 'gmgn.price.buys_24h', 'gmgn.price.buys_5m',
  'gmgn.price.buys_6h', 'gmgn.price.price_1h', 'gmgn.price.price_1m',
  'gmgn.price.price_24h', 'gmgn.price.price_5m', 'gmgn.price.price_6h',
  'gmgn.price.sell_volume_1h', 'gmgn.price.sell_volume_1m', 'gmgn.price.sell_volume_24h', 'gmgn.price.sell_volume_5m',
  'gmgn.price.sell_volume_6h', 'gmgn.price.sells_1h', 'gmgn.price.sells_1m', 'gmgn.price.sells_24h',
  'gmgn.price.sells_5m', 'gmgn.price.sells_6h',
  'gmgn.price.swaps_1h', 'gmgn.price.swaps_1m', 'gmgn.price.swaps_24h', 'gmgn.price.swaps_5m', 'gmgn.price.swaps_6h',
  'gmgn.price.volume_1h', 'gmgn.price.volume_1m', 'gmgn.price.volume_24h', 'gmgn.price.volume_5m', 'gmgn.price.volume_6h',
  'gmgn.stat.bot_degen_rate', 'gmgn.stat.creator_created_count', 'gmgn.stat.creator_hold_rate',
  'gmgn.stat.creator_token_balance', 'gmgn.stat.dev_team_hold_rate',
  'gmgn.stat.fresh_wallet_rate', 'gmgn.stat.holder_count',
  'gmgn.stat.top70_sniper_hold_rate', 'gmgn.stat.top_10_holder_rate', 'gmgn.stat.top_bot_degen_percentage',
  'gmgn.stat.top_bundler_trader_percentage', 'gmgn.stat.top_entrapment_trader_percentage', 'gmgn.stat.top_rat_trader_percentage',
  'gmgn.visiting_count',
  'gmgn.wallet_tags_stat.bundler_wallets', 'gmgn.wallet_tags_stat.creator_wallets', 'gmgn.wallet_tags_stat.fresh_wallets',
  'gmgn.wallet_tags_stat.rat_trader_wallets', 'gmgn.wallet_tags_stat.renowned_wallets', 'gmgn.wallet_tags_stat.smart_wallets',
  'gmgn.wallet_tags_stat.sniper_wallets', 'gmgn.wallet_tags_stat.top_wallets',
  'h1_featured_index', 'm5_featured_index', 'max_up_duration', 'max_up_mcap',
  'max_up_ratio', 'mcap', 'new_volume', 'old_volume', 'pool_liquidity',
  'price_change_1d', 'price_change_1h', 'price_change_5m', 'price_change_6h', 'profit_usernum',
  'sell_tx_count_d1', 'sell_wcoin_amount_d1', 'sell_wcoin_amount_h1', 'sell_wcoin_amount_m5',
  'seller_count_d1', 'shit_volume', 'signal_max_mcap', 'signal_max_ratio', 'signal_open_mcap',
  'smart_money_address_buy_count_d1', 'smart_money_address_sell_count_d1', 'smart_volume',
  'whale_volume',
]);

// 用户手动核实过、认为确实有统计/预测意义的"常用字段"（2026-07-19 反馈）。跟 ORIGINAL_FIELD_WHITELIST
// 是两回事：白名单控制"按分组浏览字段"面板里出现不出现，这个集合控制所有联想框（X/Y/颜色/过滤条件/
// 分箱字段等）里排序优先级和高亮——字段那么多，每次都要重新从几十上百个里找"哪些真的靠谱"太累。
const TRUSTED_FIELDS = new Set([
  'gmgn.dev.top_10_holder_rate', 'gmgn.stat.top_10_holder_rate',
  'gmgn.image_dup_count',
  'gmgn.liquidity', 'gmgn.pool.liquidity',
  'gmgn.stat.bot_degen_count', 'gmgn.stat.bot_degen_rate',
  'gmgn.stat.creator_hold_rate', 'gmgn.stat.dev_team_hold_rate',
  'gmgn.stat.top70_sniper_hold_rate', 'gmgn.stat.top_bot_degen_percentage',
  'gmgn.stat.top_bundler_trader_percentage', 'gmgn.stat.top_entrapment_trader_percentage',
  'gmgn.stat.top_rat_trader_percentage',
  'old_volume', 'new_volume', 'frequent_volume',
  'price_change_5m', 'price_change_1h', 'price_change_6h', 'price_change_1d',
  'above_cost_line',
  'gmgn.launchpad_progress', 'gmgn.locked_ratio', 'gmgn.visiting_count', 'gmgn.launchpad_status', 'gmgn.price.hot_level', 'gmgn.pool.fee_ratio', 'gmgn.og', 'gmgn.migration_market_cap', 'gmgn.image_dup_count', 'launch_time_duration', 'is_fake', 'is_new_m5_hot_ranking_token', 'is_new_h1_hot_ranking_token',
]);

// "常用字段"的实际判定口径 = 上面这份手工核实过的原始字段清单 ∪ 全部组装字段（DERIVED_KEYS 里的
// 比率/差值等衍生字段 + composite_score + 用户自定义字段）。组装字段之所以整体算常用：它们本来就是
// 为了分析才专门造出来的（原始字段是数据源给什么就有什么，组装字段是有目的地挑出来的），没有
// "需要人工筛一遍哪些靠谱"的问题。另外用户自定义字段是运行时动态增删的，写死进 TRUSTED_FIELDS
// 这个静态 Set 也维护不了，只能靠 isAssembledField 动态判断。
// 信号字段【不算】常用：它们有 49 个，且只在对应类型的信号存在时才有值——而三类信号基本互斥，
// 实测覆盖率低到个位数百分比。全塞进常用字段会让"★ 一键加载"灌进一堆大面积缺失的字段、
// 并把联想框顶部的 ★ 常用区淹没。需要它们时走字段浏览器的"信号字段"分组。
function isTrustedField(f) {
  if (typeof isSignalField === 'function' && isSignalField(f)) return false;
  return TRUSTED_FIELDS.has(f) || isAssembledField(f);
}

// 字段分组计算：从 scatterOptions 实时算，不依赖字段浏览器是否渲染过。
// 之前 fieldBrowserGroups 只在面板可见时由 renderFieldBrowser 填充，别处（如 AUC 批量导入）
// 直接读它，用户没展开过面板时就是一堆空数组 → 误报"该分组没有可用字段"。
// 现在统一走这个函数，渲染和导入用同一份口径。
function computeFieldGroups() {
  const holding = [], assembled = [], signal = [], volume = [], dev = [], stat = [], chip = [], holder = [];
  for (const f of scatterOptions) {
    // 8大持仓指标最先判定，单独成组放最前（用户最常用的核心筛选字段）
    if (typeof isHoldingField === 'function' && isHoldingField(f)) holding.push(f);
    else if (typeof isDevField === 'function' && isDevField(f)) dev.push(f);
    else if (typeof isStatField === 'function' && isStatField(f)) stat.push(f);
    else if (typeof isChipField === 'function' && isChipField(f)) chip.push(f);
    else if (typeof isHolderField === 'function' && isHolderField(f)) holder.push(f);
    // 原字段分组已移除：不属于上述主题组、也不是衍生/信号/量能字段的原始白名单字段，
    // 不再单独成组（仍可通过上方联想框搜索到）
    else if (isKlineVolumeField(f)) volume.push(f);
    else if (isSignalField(f)) signal.push(f);
    else if (isAssembledField(f)) assembled.push(f);
  }
  [holding, assembled, signal, volume, dev, stat, chip, holder].forEach(a => a.sort());
  return { holding, assembled, signal, volume, dev, stat, chip, holder };
}

// 保存最近一次分组结果，供各分组的"+ 全部加入X"/"复制字段名"按钮直接读取
let fieldBrowserGroups = computeFieldGroups();


// ========== 导出字段说明（字段名 + 含义 + 组装字段的公式） ==========
// 公式的来源：file:// 下 fetch 读不了本地 js（CORS 直接拒绝），所以从运行时函数体反查——
// data.js 是普通 script，顶层 function 都是 window 上的全局，toString() 能拿到源码。
// 这样导出的公式永远和当前实际执行的代码一致，不会出现"文档写完就过期"。
function collectRuntimeSources() {
  const out = [];
  for (const key of Object.getOwnPropertyNames(window)) {
    let v;
    try { v = window[key]; } catch (e) { continue; } // 个别浏览器属性读取会抛
    if (typeof v !== 'function') continue;
    let src;
    try { src = Function.prototype.toString.call(v); } catch (e) { continue; }
    if (src && src.indexOf('[native code]') < 0) out.push(src);
  }
  return out;
}

// 只取赋值号右边的表达式作为"公式"，不带上下文代码
function findFieldFormula(field, sources) {
  const esc = String(field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pat = new RegExp('features\\[[\'"]' + esc + '[\'"]\\]\\s*=\\s*([^\n]*)');
  for (const src of sources) {
    const m = src.match(pat);
    if (!m) continue;
    const rhs = m[1].replace(/;\s*$/, '').replace(/\s*\/\/.*$/, '').trim();
    return resolveIdentifier(rhs, src);
  }
  return '';
}

// 右边只是个中间变量名（features['x'] = drawdownMin）时，公式等于没写。
// 往回查一层它的 const 声明，把真正的表达式替换进来。
// 只认 const：let 声明意味着变量会被反复改写（典型是循环里累积的 bestSpeed），
// 拿它的初始值（往往是 NaN）当公式反而更误导，这种情况保留变量名更诚实。
function resolveIdentifier(rhs, src) {
  if (!/^[A-Za-z_$][\w$]*$/.test(rhs)) return rhs;
  const declPat = new RegExp('\\bconst\\s+' + rhs + '\\s*=\\s*([^\n]*)');
  const d = src.match(declPat);
  if (!d) return rhs;
  const expr = d[1].replace(/;\s*$/, '').replace(/\s*\/\/.*$/, '').trim();
  // 声明本身还是个裸变量名就不再递归了，避免链式跳转绕回来
  return expr && expr !== rhs ? expr : rhs;
}

function exportFieldDocs() {
  const groups = computeFieldGroups();
  const labels = {
    holding: '持仓指标',
    assembled: '比率/差值衍生 + 自定义字段', // 避免与「二、组装字段」大节标题撞名
    signal: '信号字段',
    volume: 'K线量能字段',
    dev: 'dev 字段（gmgn.dev.*）',
    stat: 'stat 字段（gmgn.stat.*）',
    chip: '筹码字段（chip_analysis.*）',
    holder: '持有人字段（holder_*）',
    ungrouped: '未归入主题分组的字段',
  };
  const order = ['holding', 'assembled', 'signal', 'volume', 'dev', 'stat', 'chip', 'holder'];
  // computeFieldGroups 只收录命中主题谓词的字段，剩下的原始白名单字段不属于任何组。
  // 这里必须兜底列出，否则导出会静默缺一块，用户无从察觉。
  const grouped = new Set(order.flatMap(k => groups[k] || []));
  groups.ungrouped = (typeof scatterOptions !== 'undefined' ? scatterOptions : []).filter(f => !grouped.has(f)).sort();
  order.push('ungrouped');

  const sources = collectRuntimeSources();
  const customByName = new Map(
    (typeof customFields !== 'undefined' && Array.isArray(customFields) ? customFields : [])
      .map(c => [c.name, c.code])
  );
  // 表格单元格里的 | 和换行会撑坏 Markdown 表格，统一转义
  const cell = t => String(t == null ? '' : t).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

  // 先把每个字段解出公式，再按"有没有公式"切成原生/组装两大块：
  // 有 features['x'] = ... 赋值的是本工具算出来的，没有的就是平台快照 JSON 原样给的。
  // 用这个判定而不是另维护一份清单，是因为它跟着代码自动走，不会漏也不会过期。
  const rawGroups = {}, madeGroups = {};
  let rawCount = 0, madeCount = 0;
  for (const key of order) {
    for (const fld of (groups[key] || [])) {
      const formula = customByName.has(fld) ? customByName.get(fld) : findFieldFormula(fld, sources);
      const bucket = formula ? madeGroups : rawGroups;
      (bucket[key] = bucket[key] || []).push({ field: fld, formula });
      if (formula) madeCount++; else rawCount++;
    }
  }

  const total = rawCount + madeCount;
  const L = ['# 字段说明', ''];
  L.push(`生成时间：${new Date().toLocaleString('zh-CN')}　字段总数：${total}（原生 ${rawCount} / 组装 ${madeCount}）`);
  L.push('');

  L.push(`## 一、原生字段（${rawCount}）`, '');
  L.push('直接来自平台快照 JSON，没有二次计算。', '');
  if (!rawCount) L.push('_（无）_', '');
  for (const key of order) {
    const items = rawGroups[key];
    if (!items || !items.length) continue;
    L.push(`### ${labels[key]}（${items.length}）`, '');
    L.push('| 字段 | 含义 |', '| --- | --- |');
    for (const it of items) {
      const desc = typeof getFieldDesc === 'function' ? getFieldDesc(it.field) : '';
      L.push(`| \`${cell(it.field)}\` | ${cell(desc)} |`);
    }
    L.push('');
  }

  L.push(`## 二、组装字段（${madeCount}）`, '');
  L.push('本工具从原生字段计算得到，公式如下。', '');
  if (!madeCount) L.push('_（无）_', '');
  for (const key of order) {
    const items = madeGroups[key];
    if (!items || !items.length) continue;
    L.push(`### ${labels[key]}（${items.length}）`, '');
    L.push('| 字段 | 含义 | 公式 |', '| --- | --- | --- |');
    for (const it of items) {
      const desc = typeof getFieldDesc === 'function' ? getFieldDesc(it.field) : '';
      L.push(`| \`${cell(it.field)}\` | ${cell(desc)} | \`${cell(it.formula)}\` |`);
    }
    L.push('');
  }
  L.push(`_共 ${total} 个字段：原生 ${rawCount} 个，组装 ${madeCount} 个。_`);

  const blob = new Blob([L.join('\n')], { type: 'text/markdown;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `字段说明_${total}字段_${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
  const tip = document.getElementById('fieldBrowserExportResult');
  if (tip) tip.textContent = `已导出 ${total} 个字段（原生 ${rawCount} / 组装 ${madeCount}）`;
}


function renderFieldBrowser() {
  const holdingBox = document.getElementById('fieldBrowserHolding');
  const assembledBox = document.getElementById('fieldBrowserAssembled');
  const signalBox = document.getElementById('fieldBrowserSignal');
  const volumeBox = document.getElementById('fieldBrowserVolume');
  const devBox = document.getElementById('fieldBrowserDev');
  const statBox = document.getElementById('fieldBrowserStat');
  const chipBox = document.getElementById('fieldBrowserChip');
  const holderBox = document.getElementById('fieldBrowserHolder');
  if (!holdingBox || !assembledBox || !signalBox || !volumeBox || !devBox || !statBox || !chipBox || !holderBox) return;
  // 分组口径与 AUC 批量导入等处共用同一个 computeFieldGroups，避免两处逻辑漂移
  fieldBrowserGroups = computeFieldGroups();
  const { holding, assembled, signal, volume, dev, stat, chip, holder } = fieldBrowserGroups;
  document.getElementById('fieldBrowserHoldingCount').textContent = `（${holding.length}）`;
  document.getElementById('fieldBrowserAssembledCount').textContent = `（${assembled.length}）`;
  document.getElementById('fieldBrowserSignalCount').textContent = `（${signal.length}）`;
  document.getElementById('fieldBrowserVolumeCount').textContent = `（${volume.length}）`;
  document.getElementById('fieldBrowserDevCount').textContent = `（${dev.length}）`;
  document.getElementById('fieldBrowserStatCount').textContent = `（${stat.length}）`;
  document.getElementById('fieldBrowserChipCount').textContent = `（${chip.length}）`;
  document.getElementById('fieldBrowserHolderCount').textContent = `（${holder.length}）`;

  const renderChips = fields => fields.map(f => {
    const selected = batchXSelected.includes(f);
    // 用 data-field-tip 走统一的字段说明浮层（含分类和自定义字段公式），不再用原生 title
    // ——原生 title 有约 1 秒延迟、纯文本、没法展示代码块
    return `<button type="button" class="secondary field-chip-btn${selected ? ' active' : ''}" data-field="${escapeHtml(f)}" data-field-tip="${escapeHtml(f)}">${escapeHtml(f)}${selected ? ' ✓' : ''}</button>`;
  }).join('');
  holdingBox.innerHTML = renderChips(holding) || '<span class="hint" style="margin:0;">暂无</span>';
  assembledBox.innerHTML = renderChips(assembled) || '<span class="hint" style="margin:0;">暂无</span>';
  signalBox.innerHTML = renderChips(signal) || '<span class="hint" style="margin:0;">暂无</span>';
  volumeBox.innerHTML = renderChips(volume) || '<span class="hint" style="margin:0;">暂无</span>';
  devBox.innerHTML = renderChips(dev) || '<span class="hint" style="margin:0;">暂无</span>';
  statBox.innerHTML = renderChips(stat) || '<span class="hint" style="margin:0;">暂无</span>';
  chipBox.innerHTML = renderChips(chip) || '<span class="hint" style="margin:0;">暂无</span>';
  holderBox.innerHTML = renderChips(holder) || '<span class="hint" style="margin:0;">暂无</span>';

  [holdingBox, assembledBox, signalBox, volumeBox, devBox, statBox, chipBox, holderBox].forEach(box => {
    box.querySelectorAll('.field-chip-btn').forEach(btn => {
      btn.addEventListener('click', () => addFieldsToX([btn.dataset.field]));
    });
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
  if (!matchedRows.length) { showToast('请先点击"分析"加载数据'); return; }
  tryAddBatchField(); // 输入框里若残留有效字段，先补加进去
  if (!batchXSelected.length) {
    showToast('请先添加至少一个 X 指标（输入字段名联想后选中即可添加）');
    return;
  }
  plot();
}

// CSV 导出跟随当前工作集（design doc §15.3）：提供"导出过滤后数据（activeRows）"/"导出全部数据（matchedRows）"
// 二选一开关，默认选中前者（更符合"导出我正在看的这份结果"的直觉）。
// 列集合从字段注册表（scatterOptions 并入 customFields 全部字段名）取全集，而不是从行数据反推——
// 即使某个自定义字段对所有行都算不出值（比如公式写错，或依赖的字段普遍缺失），也要在 CSV 里出现这一列
// （值留空），让"字段存在"和"字段有值"这两件事在导出结果里能被区分开来。
function downloadCsv() {
  const scope = document.querySelector('input[name="downloadCsvScope"]:checked').value;
  const rows = scope === 'all' ? matchedRows : activeRows;
  const isFiltered = scope !== 'all' && activeRows.length !== matchedRows.length;
  if (!rows.length) { showToast('当前没有数据可导出（请检查过滤条件或先点击"分析"）'); return; }
  const featureKeys = [...new Set([
    ...scatterOptions,
    ...customFields.map(c => c.name),
  ])].filter(f => f !== 'returnMax' && !ROW_LEVEL_FIELDS.includes(f)).sort();
  const categoricalKeys = [...new Set(rows.flatMap(r => Object.keys(r.categorical || {})))].sort();
  const cols = ['id','symbol','tokenAddress','signalType','initialMcap','currentMcap','maxMcap','returnMax', ...featureKeys, ...categoricalKeys];
  const lines = [cols.map(csvEscape).join(',')];
  for (const r of rows) {
    const row = cols.map(c => {
      if (c === 'id') return r.id;
      if (c === 'symbol') return r.symbol;
      if (c === 'tokenAddress') return r.tokenAddress;
      if (c === 'signalType') return r.signalType;
      if (['initialMcap','currentMcap','maxMcap','returnMax'].includes(c)) return r[c];
      if (categoricalKeys.includes(c)) return r.categorical && r.categorical[c] !== undefined ? r.categorical[c] : '';
      return r.features[c] === undefined || r.features[c] === null ? '' : r.features[c];
    });
    lines.push(row.map(csvEscape).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  // 文件名带上是否过滤、导出行数，事后从文件名就能分辨这份导出对应的是哪种口径（design doc §15.3 边界情况）
  a.download = `returns_features_${isFiltered ? 'filtered' : 'all'}_${rows.length}rows.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// 将 matchedRows 定型后的公共收尾工作（重新计算候选字段列表/展开面板/刷新下游视图），
// 被 analyze()（整体替换）和 appendData()（追加合并，§14.1）共享，避免两处都写一份容易漏同步。
function finalizeMatchedRows() {
  activeRows = matchedRows;
  applyCustomFields(matchedRows);
  allNumericKeys = [...new Set([...matchedRows.flatMap(r => Object.keys(r.features)), ...DERIVED_KEYS, ...SIGNAL_KEYS, ...customFields.map(c => c.name)])].sort();

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
  document.getElementById('binBarPanel').classList.remove('hidden');
  document.getElementById('proPanel').classList.remove('hidden');
  document.getElementById('downloadWrap').classList.remove('hidden');
  document.getElementById('appendWrap').classList.remove('hidden');
  document.getElementById('appendOptionsRow').classList.remove('hidden');

  updateScatterSelects();
  renderCustomFieldList();
  refreshAnalysisViews();
  // 所有重建工作集的入口（分析/追加/快照恢复/数据集切换）都会走到这里，统一刷新策略名展示
  renderStrategyBadge();
}

async function analyze() {
  const callsFile = document.getElementById('callsFile').files[0];
  const snapsFile = document.getElementById('snapsFile').files[0];
  if (!callsFile || !snapsFile) {
    showToast('请先选择 calls 和 snapshots JSON 文件');
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
      showToast('未匹配到有效样本，请检查两个 JSON 是否对应。' + (skipped ? `（另有 ${skipped} 条因 call 与最近快照时间差超过阈值被跳过）` : ''));
      return;
    }
    finalizeMatchedRows();
    document.getElementById('fileHint').textContent = `已分析完成：匹配 ${matchedRows.length} 条样本。` + (skipped ? ` 另有 ${skipped} 条因 call 与最近快照时间差超过 ${MAX_SNAPSHOT_MATCH_DIFF_SECONDS} 秒被跳过（未纳入分析）。` : '');
  } catch (err) {
    showToast('解析失败：' + err.message);
    console.error(err);
  } finally {
    btn.disabled = false; btn.textContent = '分析';
  }
}

// 数据源策略名展示：从当前 matchedRows 汇总 strategy_name（追加数据后可能有多个），
// 显示在"数据源"标题旁。对比两个策略版本时，一眼确认加载的是哪份数据。
function renderStrategyBadge() {
  const el = document.getElementById('dataSourceStrategy');
  if (!el) return;
  if (!matchedRows.length) { el.innerHTML = ''; return; }
  const counts = new Map();
  for (const r of matchedRows) {
    const n = r.strategyName || '(未标注策略)';
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  const items = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  el.innerHTML = items.map(([n, c]) =>
    `<span class="strategy-badge" title="该策略贡献 ${c} 条样本">${escapeHtml(n)} <b>${c}</b></span>`
  ).join('');
}

// 追加数据（design doc §14.1）：把新选择的 calls/snapshots 合并进当前 matchedRows，而不是整体替换。
// 按 token_address + swap_begin_time（与 buildRows 里的 callKey 同样的 key）去重，默认保留后导入的版本（因为
// 后导入的通常是更新的数据），勾选"保留先导入的版本"时反过来。
async function appendData() {
  const callsFile = document.getElementById('callsFile').files[0];
  const snapsFile = document.getElementById('snapsFile').files[0];
  if (!callsFile || !snapsFile) { showToast('请在上方重新选择要追加的 calls 和 snapshots JSON 文件'); return; }
  if (!matchedRows.length) { showToast('请先点击"分析"加载初始数据，再用这个按钮追加后续批次'); return; }
  const btn = document.getElementById('appendDataBtn');
  const keepFirst = document.getElementById('appendKeepFirst').checked;
  btn.disabled = true; btn.textContent = '追加中...';
  try {
    const [calls, snapshots] = await Promise.all([readJson(callsFile), readJson(snapsFile)]);
    const newRows = await buildRows(calls, snapshots, (done, total) => {
      btn.textContent = `追加中... ${done}/${total}`;
    });
    if (!newRows.length) { showToast('新文件里未匹配到有效样本，未发生合并'); return; }

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
    showToast('追加失败：' + err.message);
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
document.querySelectorAll('.batch-chart-op-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!batchXSelected.length) { showToast('当前没有已展示的图表'); return; }
    batchSetChartOption(btn.dataset.op, btn.dataset.val === 'true');
  });
});
document.getElementById('resetAllChartOptsBtn').addEventListener('click', () => {
  if (!batchXSelected.length) { showToast('当前没有已展示的图表'); return; }
  resetAllChartOptions();
});

// 低覆盖率过滤开关：改动后立即重绘（只影响渲染，不动已选字段列表）
['minCoverageEnabled', 'minCoveragePct', 'minCoverageUnit'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => { plotPage = 0; if (matchedRows.length) plot(); });
});
document.querySelectorAll('.export-png-btn').forEach(btn => {
  btn.addEventListener('click', () => exportChartPng(document.getElementById(btn.dataset.target), btn.dataset.filename));
});
document.getElementById('genBinBarBtn').addEventListener('click', renderBinBarChart);
// 导出分箱分析给 AI 诊断：复制到剪贴板（最常用，直接粘进对话框）+ 下载文件两条路
function withBinBarAiReport(fn) {
  const md = buildBinBarAiReport();
  if (!md) { showToast('请先点"生成分箱柱状图"，有结果之后才能导出'); return; }
  fn(md);
}
document.getElementById('copyBinBarAiBtn').addEventListener('click', () => withBinBarAiReport(md => {
  navigator.clipboard.writeText(md)
    .then(() => showToast(`已复制 ${md.length} 字符，直接粘贴给 AI 即可`))
    .catch(err => showToast('复制失败：' + err, true));
}));
document.getElementById('downloadBinBarAiBtn').addEventListener('click', () => withBinBarAiReport(md => {
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `分箱分析_${document.getElementById('binField').value.trim() || 'field'}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}));

document.getElementById('genWinCurveBtn').addEventListener('click', () => renderWinRateCurve());
document.getElementById('genFieldScanBtn').addEventListener('click', () => {
  withLoading('正在逐字段跑置换检验...', () => renderFieldScan());
});
// 点某行"设为分箱字段"：填进分箱字段框并直接画出该字段的曲线，方便顺着看细节
document.getElementById('fieldScanBody').addEventListener('click', e => {
  const btn = e.target.closest('.scan-pick-field-btn');
  if (!btn) return;
  document.getElementById('binField').value = btn.dataset.field;
  renderWinRateCurve();
  document.getElementById('winCurveChart').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
document.getElementById('addScanPassedToXBtn').addEventListener('click', async () => {
  if (!lastFieldScanPassed.length) { showToast('还没有通过检测的字段，请先运行集体检测'); return; }
  const added = await addFieldsToX(lastFieldScanPassed);
  showToast(`已加入 ${lastFieldScanPassed.length} 个通过检测的字段（新增 ${added}）`);
});
['curveWindow', 'curveLogX', 'peakWinThreshold'].forEach(id => {
  const el = document.getElementById(id);
  // 已经画过曲线才跟着重绘，避免刚进页面改参数就弹"请填写字段"
  if (el) el.addEventListener('change', () => {
    if (activeRows.length && document.getElementById('winCurveChart').querySelector('.main-svg')) renderWinRateCurve();
  });
});

document.getElementById('genBreakpointMineBtn').addEventListener('click', () => {
  withLoading('正在搜索最优切分点...', () => renderBreakpointMine());
});
// "填入断点"：把挖到的切点写进分箱断点框并立即重绘分箱图，省去手动复制粘贴
document.getElementById('breakpointMineBody').addEventListener('click', e => {
  const btn = e.target.closest('.apply-breakpoint-btn');
  if (!btn) return;
  document.getElementById('binBreakpoints').value = btn.dataset.cut;
  renderBinBarChart();
  document.getElementById('binBarChart').scrollIntoView({ behavior: 'smooth', block: 'center' });
  showToast('已填入断点并重绘分箱图');
});

// 主指标切换后立即重绘（已经生成过图才重绘，避免首次进页面就报"请填写字段"）
['binPrimaryStat'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => {
    if (activeRows.length && document.getElementById('binField').value.trim()) renderBinBarChart();
  });
});
document.getElementById('binRecommendBtn').addEventListener('click', () => {
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
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
document.getElementById('fieldBrowserToggle').addEventListener('click', () => {
  const panel = document.getElementById('fieldBrowserPanel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) renderFieldBrowser();
});
document.getElementById('fieldBrowserExportDocs').addEventListener('click', exportFieldDocs);
document.getElementById('fieldBrowserAddAllHolding').addEventListener('click', () => addFieldsToX(fieldBrowserGroups.holding));
document.getElementById('fieldBrowserAddAllAssembled').addEventListener('click', () => addFieldsToX(fieldBrowserGroups.assembled));
document.getElementById('fieldBrowserCopyHolding').addEventListener('click', () => copyFieldNames(fieldBrowserGroups.holding));
document.getElementById('fieldBrowserCopyAssembled').addEventListener('click', () => copyFieldNames(fieldBrowserGroups.assembled));
document.getElementById('fieldBrowserAddAllSignal').addEventListener('click', () => addFieldsToX(fieldBrowserGroups.signal));
document.getElementById('fieldBrowserCopySignal').addEventListener('click', () => copyFieldNames(fieldBrowserGroups.signal));
document.getElementById('fieldBrowserAddAllVolume').addEventListener('click', () => addFieldsToX(fieldBrowserGroups.volume));
document.getElementById('fieldBrowserCopyVolume').addEventListener('click', () => copyFieldNames(fieldBrowserGroups.volume));
document.getElementById('fieldBrowserAddAllDev').addEventListener('click', () => addFieldsToX(fieldBrowserGroups.dev));
document.getElementById('fieldBrowserCopyDev').addEventListener('click', () => copyFieldNames(fieldBrowserGroups.dev));
document.getElementById('fieldBrowserAddAllStat').addEventListener('click', () => addFieldsToX(fieldBrowserGroups.stat));
document.getElementById('fieldBrowserCopyStat').addEventListener('click', () => copyFieldNames(fieldBrowserGroups.stat));
document.getElementById('fieldBrowserAddAllChip').addEventListener('click', () => addFieldsToX(fieldBrowserGroups.chip));
document.getElementById('fieldBrowserCopyChip').addEventListener('click', () => copyFieldNames(fieldBrowserGroups.chip));
document.getElementById('fieldBrowserAddAllHolder').addEventListener('click', () => addFieldsToX(fieldBrowserGroups.holder));
document.getElementById('fieldBrowserCopyHolder').addEventListener('click', () => copyFieldNames(fieldBrowserGroups.holder));
document.getElementById('loadTrustedFieldsBtn').addEventListener('click', async () => {
  // 直接从 scatterOptions（当前数据集实际存在、可作为 X 轴的字段）里筛，而不是遍历 TRUSTED_FIELDS
  // 再过滤：一来避免加进去一堆当前数据里根本没有的死字段，二来组装字段（含用户自定义字段）本来就
  // 只在 scatterOptions 里才有完整的一份
  const fields = scatterOptions.filter(isTrustedField);
  if (!fields.length) { showToast('当前数据集里没有已核实过的常用字段（可能字段名对不上，或者还没加载数据）'); return; }
  const added = await addFieldsToX(fields);
  showToast(`已加入 ${fields.length} 个常用字段（新增 ${added}，其余之前已在列表中）`);
});
document.getElementById('batchXClearBtn').addEventListener('click', async () => {
  // 一键清空可能会把手动挑了老半天的一长串 X 字段瞬间清光，且没有撤销入口；字段较多时
  // 加一次确认，跟"删除预设/快照"等既有的高风险操作确认保持一致的风险阈值。
  if (batchXSelected.length > 3 && !await showConfirm(`确定要清空当前已选的 ${batchXSelected.length} 个 X 指标吗？`, { danger: true, okText: '清空' })) return;
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
document.getElementById('corrFilterMinAbsR').addEventListener('input', renderCorrTable);
document.getElementById('corrFilterMinN').addEventListener('input', renderCorrTable);
document.getElementById('corrFilterMaxP').addEventListener('input', renderCorrTable);
document.getElementById('corrFilterMaxAdjP').addEventListener('input', renderCorrTable);
document.getElementById('corrFilterCiExcludesZero').addEventListener('change', renderCorrTable);
document.getElementById('corrSendToScatterBtn').addEventListener('click', async () => {
  const features = [...new Set([...corrSelectedRows].map(k => k.split('|')[1]))].filter(f => scatterOptions.includes(f));
  const added = await addFieldsToX(features);
  corrSelectedRows.clear();
  renderCorrTable();
  const scatterPanel = document.getElementById('scatterPanel');
  const scatterBody = document.getElementById('scatterBody_');
  if (scatterBody) scatterBody.classList.remove('hidden');
  if (scatterPanel) scatterPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast(`已把 ${features.length} 个字段加入散点图 X 轴（新增 ${added}，其余之前已在列表中）`);
});
document.getElementById('distTargetField').addEventListener('change', renderDistribution);
document.getElementById('distLogX').addEventListener('change', renderDistribution);
document.getElementById('distBinCount').addEventListener('change', renderDistribution);
document.getElementById('computeBootstrapCIBtn').addEventListener('click', runBootstrapCI);
document.getElementById('cancelBootstrapCIBtn').addEventListener('click', () => { bootstrapCancelFlag = true; });
document.getElementById('oosEnabled').addEventListener('change', renderCorrTable);
document.getElementById('oosSplitMethod').addEventListener('change', renderCorrTable);
document.getElementById('oosTrainRatio').addEventListener('change', renderCorrTable);
document.getElementById('oosSeed').addEventListener('change', renderCorrTable);
document.getElementById('downloadCsvBtn').addEventListener('click', downloadCsv);
document.getElementById('addFilterRow').addEventListener('click', () => addFilterRow());
document.getElementById('applyFilter').addEventListener('click', applyFilter);
document.getElementById('copyFilterCAs').addEventListener('click', copyFilterCAs);
document.getElementById('clearFilter').addEventListener('click', clearFilter);
document.getElementById('saveFilterPresetBtn').addEventListener('click', saveFilterPreset);
document.getElementById('applyFilterPresetBtn').addEventListener('click', applyFilterPreset);
document.getElementById('deleteFilterPresetBtn').addEventListener('click', deleteFilterPreset);
loadFilterPresets();
renderFilterPresetOptions();
addFilterRow();
document.getElementById('fieldQualityOnlyIssues').addEventListener('change', renderFieldQuality);
document.getElementById('fieldQualitySearch').addEventListener('input', renderFieldQuality);

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

// ========== 导航跳转菜单（UX 优化）==========
// 页面已经涨到 10+ 个顶层面板 + 进阶分析区域下 8 个子模块，找一个功能得不断滚动，
// 这里加一个轻量的跳转菜单，覆盖所有面板，点击直接展开对应折叠体并滚动过去。
const NAV_ITEMS = [
  { group: '数据管理', label: '数据源 / 追加数据', panelId: null, targetId: 'sourceBody' },
  { group: '数据管理', label: '分析快照 / 完整数据集', panelId: 'snapshotPanel', targetId: 'snapshotPanel' },
  { group: '数据管理', label: '一键生成分析报告', panelId: 'reportPanel', targetId: 'reportPanel' },
  { group: '数据总览', label: '全局条件过滤 & 预设方案', panelId: 'filterPanel', targetId: 'filterPanel' },
  { group: '数据总览', label: '总览统计', panelId: 'summaryPanel', targetId: 'summaryPanel' },
  { group: '数据总览', label: '收益分布', panelId: 'distPanel', targetId: 'distPanel' },
  { group: '数据总览', label: '字段质量总览', panelId: 'fieldQualityPanel', targetId: 'fieldQualityPanel' },
  { group: '数据总览', label: '异常值 / 数据质量报警', panelId: 'qualityAlertPanel', targetId: 'qualityAlertPanel' },
  { group: '相关性与特征', label: '字段与收益相关性', panelId: 'corrPanel', targetId: 'corrPanel' },
  { group: '相关性与特征', label: '自定义组装字段', panelId: 'customFieldPanel', targetId: 'customFieldPanel' },
  { group: '图表', label: '散点图分析', panelId: 'scatterPanel', targetId: 'scatterPanel' },
  { group: '图表', label: '分箱柱状图', panelId: 'binBarPanel', targetId: 'binBarPanel' },
  { group: '进阶分析', label: '1. 相关性矩阵 / 热力图', panelId: 'proPanel', targetId: 'proSectionCorrMatrix' },
  { group: '进阶分析', label: '2. 分组对比分析', panelId: 'proPanel', targetId: 'proSectionGroupCompare' },
  { group: '进阶分析', label: '3. 特征重要性（回归）', panelId: 'proPanel', targetId: 'proSectionRegression' },
  { group: '进阶分析', label: '3.5 特征组合探索', panelId: 'proPanel', targetId: 'proSectionFeatureCombo' },
  { group: '进阶分析', label: '3.6 组合评分', panelId: 'proPanel', targetId: 'proSectionCompositeScore' },
  { group: '进阶分析', label: '4. 时间维度分析', panelId: 'proPanel', targetId: 'proSectionTimeAnalysis' },
  { group: '进阶分析', label: '5. 分类字段与收益关系', panelId: 'proPanel', targetId: 'proSectionCategoryCompare' },
  { group: '进阶分析', label: '6. 阈值优化（ROC-AUC）', panelId: 'proPanel', targetId: 'proSectionRoc' },
  { group: '进阶分析', label: '7. 相似 Case 检索', panelId: 'proPanel', targetId: 'proSectionSimilarCase' },
];

function renderNavMenu() {
  const panel = document.getElementById('navMenuPanel');
  let html = '';
  let lastGroup = null;
  NAV_ITEMS.forEach((item, i) => {
    if (item.group !== lastGroup) { html += `<div class="nav-group-title">${escapeHtml(item.group)}</div>`; lastGroup = item.group; }
    const gatePanel = item.panelId ? document.getElementById(item.panelId) : null;
    const locked = gatePanel && gatePanel.classList.contains('hidden');
    html += `<div class="nav-item${locked ? ' disabled' : ''}" data-idx="${i}">${escapeHtml(item.label)}${locked ? '<span class="nav-item-badge">需先加载数据</span>' : ''}</div>`;
  });
  panel.innerHTML = html;
  panel.querySelectorAll('.nav-item:not(.disabled)').forEach(el => {
    el.addEventListener('click', () => navigateTo(NAV_ITEMS[+el.dataset.idx]));
  });
}

function navigateTo(item) {
  const target = document.getElementById(item.targetId);
  if (!target) return;
  // 找到需要展开的折叠体：可能是 target 自身、target 内部的子元素、或者 target 所在的外层折叠体（进阶分析子模块场景）
  const body = target.classList.contains('panel-body') ? target
    : target.querySelector('.panel-body') || target.closest('.panel-body');
  if (body && body.classList.contains('hidden')) {
    body.classList.remove('hidden');
    const header = document.querySelector(`.panel-header-row[data-target="${body.id}"]`);
    if (header) { const t = header.querySelector('.collapse-toggle'); if (t) t.classList.remove('collapsed'); }
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('navMenuPanel').classList.add('hidden');
}

const navMenuBtn = document.getElementById('navMenuBtn');
const navMenuPanel = document.getElementById('navMenuPanel');
navMenuBtn.addEventListener('click', e => {
  e.stopPropagation();
  renderNavMenu(); // 每次打开时重新渲染，保证"需先加载数据"的锁定状态是最新的
  navMenuPanel.classList.toggle('hidden');
});
document.addEventListener('click', e => {
  if (!navMenuPanel.classList.contains('hidden') && !navMenuPanel.contains(e.target) && e.target !== navMenuBtn) {
    navMenuPanel.classList.add('hidden');
  }
});

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
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  const label = document.getElementById('snapshotLabelInput').value.trim() || `快照 ${analysisSnapshots.length + 1}`;
  const mx = activeRows.map(r => r.returnMax);
  const ms = calcStats(mx, WIN_THRESHOLD);
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
    summary: { winRate: ms.winRate, meanMax: ms.mean, maxMax: ms.max },
    topCorr: { returnMax: topByTarget('returnMax') },
  };
  analysisSnapshots.push(snapshot);
  saveAnalysisSnapshotsToStorage();
  document.getElementById('snapshotLabelInput').value = '';
  renderSnapshotList();
}

async function deleteSnapshot(id) {
  if (!await showConfirm('确定删除这份快照？', { danger: true, okText: '删除' })) return;
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
      <td><button type="button" class="danger snapshot-del" data-id="${s.id}">删除</button></td>
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

  // 两份快照的字段结构可能不完全一致（比如数据结构升级新增字段），
  // 用 Map 按字段名对齐，缺失的一侧显示"该快照中不存在此字段"而不是报错或留空造成误解
  const mapA = new Map(), mapB = new Map();
  ['returnMax'].forEach(t => {
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

// ========== 完整数据集保存 / 切换（design doc §14.2） ==========
// 和上面的"分析结果快照"（§10.1）是同一套存储体系的两种粒度：那边存摘要，这里存完整 matchedRows（含自定义字段结果）。
// 索引（标签/时间/样本数/体积）单独存一个 key，完整数据分开存到各自的 key，删除/列表时不需要读入全部数据体积，
// 只有真正"切换到该数据集"时才反序列化对应的那一份。
const DATASET_INDEX_STORAGE_KEY = 'chart_datasets_index';
const DATASET_DATA_KEY_PREFIX = 'chart_dataset_data_';
const DATASET_SIZE_LIMIT_BYTES = 4 * 1024 * 1024; // 留出余量，不用满 5MB 上限，避免刚好卡在临界值报错
let datasetIndex = [];

function loadDatasetIndex() {
  try {
    const raw = localStorage.getItem(DATASET_INDEX_STORAGE_KEY);
    datasetIndex = raw ? JSON.parse(raw) || [] : [];
  } catch (e) { datasetIndex = []; }
}
function saveDatasetIndex() {
  try { localStorage.setItem(DATASET_INDEX_STORAGE_KEY, JSON.stringify(datasetIndex)); } catch (e) {}
}

function saveCurrentDataset() {
  if (!matchedRows.length) { showToast('请先点击"分析"加载数据'); return; }
  const hintEl = document.getElementById('datasetStatusHint');
  const label = document.getElementById('datasetLabelInput').value.trim() || `数据集 ${datasetIndex.length + 1}`;
  const serialized = JSON.stringify(matchedRows);
  const sizeBytes = new Blob([serialized]).size;
  if (sizeBytes > DATASET_SIZE_LIMIT_BYTES) {
    hintEl.textContent = `⚠️ 数据集过大（约 ${(sizeBytes / 1024 / 1024).toFixed(1)}MB）无法完整保存，建议只保存分析结果摘要（见上方"保存当前快照"，更轻量）。`;
    return;
  }
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  try {
    localStorage.setItem(DATASET_DATA_KEY_PREFIX + id, serialized);
  } catch (e) {
    hintEl.textContent = `⚠️ 保存失败（可能是浏览器存储空间已满）：${e.message}`;
    return;
  }
  datasetIndex.push({ id, label, savedAt: new Date().toISOString(), n: matchedRows.length, sizeBytes });
  saveDatasetIndex();
  document.getElementById('datasetLabelInput').value = '';
  hintEl.textContent = `✅ 已保存「${label}」（${matchedRows.length} 条，约 ${(sizeBytes / 1024).toFixed(0)}KB）`;
  renderDatasetList();
}

async function switchToDataset(id) {
  const meta = datasetIndex.find(d => d.id === id);
  if (!meta) return;
  if (matchedRows.length && !await showConfirm(`切换到「${meta.label}」将替换当前工作集（当前未保存的过滤/自定义字段状态不会丢失，自定义字段定义本身独立存储），是否继续？`)) return;
  const raw = localStorage.getItem(DATASET_DATA_KEY_PREFIX + id);
  if (!raw) { showToast('未找到该数据集的完整数据（可能已被清除），仅保留了列表记录'); return; }
  try {
    matchedRows = JSON.parse(raw);
  } catch (e) { showToast('数据集解析失败：' + e.message); return; }
  finalizeMatchedRows();
  document.getElementById('fileHint').textContent = `已切换到数据集「${meta.label}」：${matchedRows.length} 条。`;
}

async function deleteDataset(id) {
  if (!await showConfirm('确定删除这个数据集？', { danger: true, okText: '删除' })) return;
  datasetIndex = datasetIndex.filter(d => d.id !== id);
  saveDatasetIndex();
  try { localStorage.removeItem(DATASET_DATA_KEY_PREFIX + id); } catch (e) {}
  renderDatasetList();
}

function renderDatasetList() {
  const tbody = document.getElementById('datasetListBody');
  if (!datasetIndex.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">还没有保存的数据集</td></tr>';
    return;
  }
  tbody.innerHTML = datasetIndex.slice().reverse().map(d => `
    <tr>
      <td>${escapeHtml(d.label)}</td>
      <td>${new Date(d.savedAt).toLocaleString()}</td>
      <td class="num">${d.n}</td>
      <td class="num">${(d.sizeBytes / 1024).toFixed(0)}KB</td>
      <td>
        <button type="button" class="secondary dataset-switch" data-id="${d.id}">切换到该数据集</button>
        <button type="button" class="danger dataset-del" data-id="${d.id}">删除</button>
      </td>
    </tr>
  `).join('');
  tbody.querySelectorAll('.dataset-switch').forEach(btn => btn.addEventListener('click', () => switchToDataset(btn.dataset.id)));
  tbody.querySelectorAll('.dataset-del').forEach(btn => btn.addEventListener('click', () => deleteDataset(btn.dataset.id)));
}

document.getElementById('saveDatasetBtn').addEventListener('click', saveCurrentDataset);
loadDatasetIndex();
renderDatasetList();

// ========== 基准库对比（用户需求，2026-07-19） ==========
// 跟"完整数据集保存/切换"是同一套存储模式（索引 + 按 id 分开存的完整数据），但用途不同：
// 数据集库是"整体替换工作集"，基准库是"新一批数据 vs 累积的历史基准，看这次调整是不是真的变好了"，
// 对比完确认无误后把新数据并入基准库，基准库像滚雪球一样越滚越大，代表"目前为止的全部历史"。
// 基准库有意跟主界面平时筛选/探索用的 matchedRows/activeRows 完全隔离存储，不会被日常操作污染。
const BENCHMARK_INDEX_STORAGE_KEY = 'chart_benchmark_index';
const BENCHMARK_DATA_KEY_PREFIX = 'chart_benchmark_data_';
const BENCHMARK_SIZE_LIMIT_BYTES = 4 * 1024 * 1024;
const BENCHMARK_BOOTSTRAP_B = 1000;
let benchmarkIndex = [];
// 上一次"对比"算出来的新数据快照，只有点过对比、且之后没有再改动过 activeRows 才允许"确认并入"，
// 防止用户比完 A 批数据，页面上早就换成 B 批了，却把 B 批稀里糊涂地并进了基于 A 批算出来的对比结果里
let pendingBenchmarkMerge = null; // { libraryId, rows }

function loadBenchmarkIndex() {
  try {
    const raw = localStorage.getItem(BENCHMARK_INDEX_STORAGE_KEY);
    benchmarkIndex = raw ? JSON.parse(raw) || [] : [];
  } catch (e) { benchmarkIndex = []; }
}
function saveBenchmarkIndexToStorage() {
  try { localStorage.setItem(BENCHMARK_INDEX_STORAGE_KEY, JSON.stringify(benchmarkIndex)); } catch (e) {}
}

function computeBenchmarkStats(rows) {
  const m = calcStats(rows.map(r => r.returnMax), WIN_THRESHOLD);
  return { winRate: m.winRate, avgReturn: m.mean, medianReturn: m.median };
}

function createBenchmarkLibrary() {
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  const nameInput = document.getElementById('benchmarkNameInput');
  const name = nameInput.value.trim();
  if (!name) { showToast('请输入基准库名称'); return; }
  if (benchmarkIndex.some(b => b.name === name)) { showToast('已存在同名基准库，请换个名称'); return; }
  const rows = activeRows.slice();
  const serialized = JSON.stringify(rows);
  const sizeBytes = new Blob([serialized]).size;
  const hintEl = document.getElementById('benchmarkStatusHint');
  if (sizeBytes > BENCHMARK_SIZE_LIMIT_BYTES) {
    hintEl.textContent = `⚠️ 数据过大（约 ${(sizeBytes / 1024 / 1024).toFixed(1)}MB）无法保存为基准库。`;
    return;
  }
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  try {
    localStorage.setItem(BENCHMARK_DATA_KEY_PREFIX + id, serialized);
  } catch (e) {
    hintEl.textContent = `⚠️ 保存失败（可能是浏览器存储空间已满）：${e.message}`;
    return;
  }
  const now = new Date().toISOString();
  benchmarkIndex.push({ id, name, n: rows.length, sizeBytes, createdAt: now, updatedAt: now, ...computeBenchmarkStats(rows) });
  saveBenchmarkIndexToStorage();
  nameInput.value = '';
  hintEl.textContent = `✅ 已新建基准库「${name}」（${rows.length} 条）`;
  renderBenchmarkList();
  renderBenchmarkSelect();
}

async function deleteBenchmarkLibrary(id) {
  const meta = benchmarkIndex.find(b => b.id === id);
  if (!meta) return;
  if (!await showConfirm(`确定删除基准库「${meta.name}」？累积的 ${meta.n} 条历史数据会一并清除，无法恢复。`, { danger: true, okText: '删除' })) return;
  benchmarkIndex = benchmarkIndex.filter(b => b.id !== id);
  saveBenchmarkIndexToStorage();
  try { localStorage.removeItem(BENCHMARK_DATA_KEY_PREFIX + id); } catch (e) {}
  if (pendingBenchmarkMerge && pendingBenchmarkMerge.libraryId === id) {
    pendingBenchmarkMerge = null;
    document.getElementById('confirmMergeBenchmarkBtn').disabled = true;
  }
  renderBenchmarkList();
  renderBenchmarkSelect();
}

function renameBenchmarkLibrary(id, input) {
  const meta = benchmarkIndex.find(b => b.id === id);
  if (!meta) return;
  const name = input.value.trim();
  if (!name) { input.value = meta.name; return; }
  if (name === meta.name) return;
  if (benchmarkIndex.some(b => b.id !== id && b.name === name)) {
    showToast('已存在同名基准库，请换个名称');
    input.value = meta.name;
    return;
  }
  meta.name = name;
  saveBenchmarkIndexToStorage();
  renderBenchmarkSelect();
}

function renderBenchmarkList() {
  const tbody = document.getElementById('benchmarkListBody');
  if (!tbody) return;
  if (!benchmarkIndex.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">还没有基准库，先用当前数据新建一个，或从 JSON 备份导入</td></tr>';
    return;
  }
  tbody.innerHTML = benchmarkIndex.slice().reverse().map(b => {
    // 容量占用：单份存储上限 4MB，基准库是滚雪球式增长的，提前把占用比例亮出来，
    // 别等哪天并入失败了才发现快满了
    const usagePct = b.sizeBytes / BENCHMARK_SIZE_LIMIT_BYTES * 100;
    const usageColor = usagePct >= 80 ? 'var(--red)' : usagePct >= 50 ? '#ff9f0a' : 'var(--text-muted)';
    return `
    <tr>
      <td><input type="text" class="benchmark-rename" data-id="${b.id}" value="${escapeHtml(b.name)}" style="width:100%; min-width:120px;"></td>
      <td class="num">${b.n}</td>
      <td class="num">${(b.winRate * 100).toFixed(1)}%</td>
      <td class="num">${b.avgReturn.toFixed(4)}x</td>
      <td class="num" style="color:${usageColor};" title="单份存储上限约 4MB，占用过高时建议导出备份后清理或拆分基准库">${(b.sizeBytes / 1024).toFixed(0)}KB（${usagePct < 1 ? '<1' : usagePct.toFixed(0)}%）</td>
      <td>${new Date(b.updatedAt).toLocaleString()}</td>
      <td>
        <button type="button" class="secondary benchmark-load" data-id="${b.id}" title="把这个基准库的全部累积数据加载为当前工作集，直接在上面跑相关性/散点图等分析">加载为数据源</button>
        <button type="button" class="secondary benchmark-export" data-id="${b.id}" title="导出为 JSON 文件备份（基准库只存在浏览器本地，清缓存/换设备会丢失）">导出</button>
        <button type="button" class="danger benchmark-del" data-id="${b.id}">删除</button>
      </td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('.benchmark-rename').forEach(inp => inp.addEventListener('blur', () => renameBenchmarkLibrary(inp.dataset.id, inp)));
  tbody.querySelectorAll('.benchmark-load').forEach(btn => btn.addEventListener('click', () => loadBenchmarkAsDataset(btn.dataset.id)));
  tbody.querySelectorAll('.benchmark-export').forEach(btn => btn.addEventListener('click', () => exportBenchmarkLibrary(btn.dataset.id)));
  tbody.querySelectorAll('.benchmark-del').forEach(btn => btn.addEventListener('click', () => deleteBenchmarkLibrary(btn.dataset.id)));
}

// 基准库导出/导入（照自定义字段配置 §13.2 的同一套模式）：基准库是长期滚雪球积累的数据资产，
// 只存 localStorage 的话清浏览器缓存/换设备就全没了，必须能落成文件备份。
const BENCHMARK_EXPORT_VERSION = 1;

function exportBenchmarkLibrary(id) {
  const meta = benchmarkIndex.find(b => b.id === id);
  if (!meta) return;
  const raw = localStorage.getItem(BENCHMARK_DATA_KEY_PREFIX + id);
  if (!raw) { showToast('未找到该基准库的完整数据，无法导出'); return; }
  let rows;
  try { rows = JSON.parse(raw); } catch (e) { showToast('基准库数据解析失败：' + e.message); return; }
  const payload = { version: BENCHMARK_EXPORT_VERSION, type: 'benchmark_library', name: meta.name, exportedAt: new Date().toISOString(), n: rows.length, rows };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `benchmark_${meta.name.replace(/[\\/:*?"<>|]/g, '_')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`已导出基准库「${meta.name}」（${rows.length} 条）`);
}

async function importBenchmarkFromFile(file) {
  let payload;
  try { payload = await readJson(file); } catch (e) { showToast('文件解析失败：' + e.message); return; }
  if (!payload || payload.type !== 'benchmark_library' || !Array.isArray(payload.rows)) {
    showToast('文件格式不对：不是本工具导出的基准库备份文件'); return;
  }
  if (!payload.rows.length) { showToast('备份文件里没有数据'); return; }
  // 同名冲突自动加后缀，不覆盖已有库——导入的目的通常是恢复/迁移，静默覆盖同名库风险太大
  let name = payload.name || '导入的基准库';
  while (benchmarkIndex.some(b => b.name === name)) name += '（导入）';
  const serialized = JSON.stringify(payload.rows);
  const sizeBytes = new Blob([serialized]).size;
  if (sizeBytes > BENCHMARK_SIZE_LIMIT_BYTES) { showToast(`备份数据过大（约 ${(sizeBytes / 1024 / 1024).toFixed(1)}MB），超出单份存储上限，无法导入`, true); return; }
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  try {
    localStorage.setItem(BENCHMARK_DATA_KEY_PREFIX + id, serialized);
  } catch (e) { showToast('保存失败（可能是浏览器存储空间已满）：' + e.message, true); return; }
  const now = new Date().toISOString();
  benchmarkIndex.push({ id, name, n: payload.rows.length, sizeBytes, createdAt: now, updatedAt: now, ...computeBenchmarkStats(payload.rows) });
  saveBenchmarkIndexToStorage();
  renderBenchmarkList();
  renderBenchmarkSelect();
  showToast(`已导入基准库「${name}」（${payload.rows.length} 条）`);
}

// 基准库当数据源用（用户需求，2026-07-19）：把基准库累积的全部历史数据整体加载为 matchedRows，
// 直接在上面跑相关性表/散点图/分箱图等全套分析——基准库通常样本量比单批新数据大得多，
// 在它上面找相关性比每次只在一小批新数据里找更有统计效力。跟"数据集库"的切换逻辑（14.2）完全一致，
// 复用同一套"替换前先确认"的交互，不搞第二套不一致的切换体验。
async function loadBenchmarkAsDataset(id) {
  const meta = benchmarkIndex.find(b => b.id === id);
  if (!meta) return;
  if (matchedRows.length && !await showConfirm(`加载基准库「${meta.name}」将替换当前工作集（当前未保存的过滤/自定义字段状态不会丢失，自定义字段定义本身独立存储），是否继续？`)) return;
  const raw = localStorage.getItem(BENCHMARK_DATA_KEY_PREFIX + id);
  if (!raw) { showToast('未找到该基准库的完整数据（可能已被清除），仅保留了列表记录'); return; }
  try {
    matchedRows = JSON.parse(raw);
  } catch (e) { showToast('基准库数据解析失败：' + e.message); return; }
  finalizeMatchedRows();
  document.getElementById('fileHint').textContent = `已加载基准库「${meta.name}」作为当前数据源：${matchedRows.length} 条。`;
}

function renderBenchmarkSelect() {
  const sel = document.getElementById('benchmarkSelect');
  if (!sel) return;
  const prevValue = sel.value;
  sel.innerHTML = benchmarkIndex.length
    ? benchmarkIndex.map(b => `<option value="${b.id}">${escapeHtml(b.name)}（${b.n} 条）</option>`).join('')
    : '<option value="">（还没有基准库）</option>';
  if (benchmarkIndex.some(b => b.id === prevValue)) sel.value = prevValue;
}

// 显著性判定统一用同一个函数，避免"结论文案"和"高亮颜色"各写一套判断条件导致不一致
function benchmarkVerdict(ci) {
  if (!ci || !Number.isFinite(ci.lo) || !Number.isFinite(ci.hi)) return { text: '样本不足，无法判断', color: 'var(--text-muted)' };
  if (ci.lo > 0) return { text: '显著变好', color: 'var(--green)' };
  if (ci.hi < 0) return { text: '显著变差', color: 'var(--red)' };
  return { text: '无显著差异', color: 'var(--text-muted)' };
}

async function compareAgainstBenchmark() {
  const id = document.getElementById('benchmarkSelect').value;
  const meta = benchmarkIndex.find(b => b.id === id);
  const resultEl = document.getElementById('benchmarkCompareResult');
  const confirmBtn = document.getElementById('confirmMergeBenchmarkBtn');
  confirmBtn.disabled = true;
  pendingBenchmarkMerge = null;
  if (!meta) { showToast('请先选择一个基准库'); return; }
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
  const raw = localStorage.getItem(BENCHMARK_DATA_KEY_PREFIX + id);
  if (!raw) { showToast('未找到该基准库的完整数据（可能已被清除），列表记录仍保留，建议删除后重建'); return; }
  let benchmarkRows;
  try { benchmarkRows = JSON.parse(raw); } catch (e) { showToast('基准库数据解析失败：' + e.message); return; }

  const newRows = activeRows;
  // n 太小时 bootstrap 差值本身估计不稳，先给个警告，但仍然算出来供参考（跟 OOS 测试集不足的处理方式一致）
  const smallSampleWarn = newRows.length < 20
    ? `<div class="hint" style="color:var(--warn, #ff9f0a); margin: 0 0 10px;">⚠️ 新数据样本量过小（n=${newRows.length} < 20），对比结果仅供参考。</div>` : '';

  const statsFn = arr => {
    const m = calcStats(arr.map(r => r.returnMax), WIN_THRESHOLD);
    return { winRate: m.winRate, avgReturn: m.mean, medianReturn: m.median };
  };
  const diffs = bootstrapDiffCI(newRows, benchmarkRows, statsFn, BENCHMARK_BOOTSTRAP_B);
  const newStats = statsFn(newRows);
  const benchStats = statsFn(benchmarkRows);

  const rowsHtml = [
    ['胜率（倍数>2，翻倍）', newStats.winRate, benchStats.winRate, diffs && diffs.winRate, v => (v * 100).toFixed(1) + '%'],
    ['returnMax 均值', newStats.avgReturn, benchStats.avgReturn, diffs && diffs.avgReturn, v => v.toFixed(4) + 'x'],
    ['returnMax 中位数', newStats.medianReturn, benchStats.medianReturn, diffs && diffs.medianReturn, v => v.toFixed(4) + 'x'],
  ].map(([label, newV, benchV, ci, fmt]) => {
    const verdict = benchmarkVerdict(ci);
    const ciText = ci && Number.isFinite(ci.lo) ? `[${fmt(ci.lo)}, ${fmt(ci.hi)}]` : '-';
    return `
    <tr>
      <td>${escapeHtml(label)}</td>
      <td class="num">${fmt(benchV)}</td>
      <td class="num">${fmt(newV)}</td>
      <td class="num">${ciText}</td>
      <td class="num" style="color:${verdict.color}; font-weight:500;">${verdict.text}</td>
    </tr>`;
  }).join('');

  resultEl.innerHTML = `
    ${smallSampleWarn}
    <div class="hint" style="margin: 0 0 8px;">对比：新数据（${newRows.length} 条）vs 基准库「${escapeHtml(meta.name)}」（${benchmarkRows.length} 条），差值 = 新数据 − 基准，括号为差值的 95% 置信区间（重抽样 ${BENCHMARK_BOOTSTRAP_B} 次）</div>
    <div class="table-scroll">
      <table class="desc-table">
        <thead><tr><th>指标</th><th class="num">基准库</th><th class="num">新数据</th><th class="num">差值 95% CI</th><th class="num">结论</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
  resultEl.classList.remove('hidden');

  pendingBenchmarkMerge = { libraryId: id, rows: newRows.slice() };
  confirmBtn.disabled = false;
}

async function mergeIntoBenchmark() {
  if (!pendingBenchmarkMerge) return;
  const { libraryId, rows: newRows } = pendingBenchmarkMerge;
  const meta = benchmarkIndex.find(b => b.id === libraryId);
  if (!meta) { showToast('该基准库已被删除'); return; }
  const raw = localStorage.getItem(BENCHMARK_DATA_KEY_PREFIX + libraryId);
  if (!raw) { showToast('未找到该基准库的完整数据'); return; }
  let benchmarkRows;
  try { benchmarkRows = JSON.parse(raw); } catch (e) { showToast('基准库数据解析失败：' + e.message); return; }

  // 去重规则跟"追加数据"（14.1）保持一致：同一个 token_address+swap_begin_time 视为同一条记录，
  // 默认用新数据覆盖旧的，不搞第二套不一致的去重逻辑
  const keyOf = r => `${r.tokenAddress || ''}_${r.swapBeginTime || ''}`;
  const existingByKey = new Map(benchmarkRows.map(r => [keyOf(r), r]));
  let addedCount = 0, overwrittenCount = 0;
  for (const nr of newRows) {
    const k = keyOf(nr);
    if (existingByKey.has(k)) overwrittenCount++; else addedCount++;
    existingByKey.set(k, nr);
  }
  const merged = [...existingByKey.values()];
  const serialized = JSON.stringify(merged);
  const sizeBytes = new Blob([serialized]).size;
  if (sizeBytes > BENCHMARK_SIZE_LIMIT_BYTES) {
    showToast(`合并后数据过大（约 ${(sizeBytes / 1024 / 1024).toFixed(1)}MB），超出单份存储上限，未能并入`, true);
    return;
  }
  try {
    localStorage.setItem(BENCHMARK_DATA_KEY_PREFIX + libraryId, serialized);
  } catch (e) {
    showToast('保存失败（可能是浏览器存储空间已满）：' + e.message, true);
    return;
  }
  Object.assign(meta, { n: merged.length, sizeBytes, updatedAt: new Date().toISOString() }, computeBenchmarkStats(merged));
  saveBenchmarkIndexToStorage();
  pendingBenchmarkMerge = null;
  document.getElementById('confirmMergeBenchmarkBtn').disabled = true;
  document.getElementById('benchmarkCompareResult').classList.add('hidden');
  renderBenchmarkList();
  renderBenchmarkSelect();
  showToast(`已并入基准库「${meta.name}」：新增 ${addedCount} 条，去重覆盖 ${overwrittenCount} 条，库内现有 ${merged.length} 条`);
}

document.getElementById('createBenchmarkBtn').addEventListener('click', createBenchmarkLibrary);
document.getElementById('compareBenchmarkBtn').addEventListener('click', compareAgainstBenchmark);
document.getElementById('confirmMergeBenchmarkBtn').addEventListener('click', mergeIntoBenchmark);
const benchmarkImportFileInput = document.getElementById('importBenchmarkFile');
document.getElementById('importBenchmarkBtn').addEventListener('click', () => benchmarkImportFileInput.click());
benchmarkImportFileInput.addEventListener('change', () => {
  const file = benchmarkImportFileInput.files[0];
  benchmarkImportFileInput.value = '';
  if (file) importBenchmarkFromFile(file);
});
loadBenchmarkIndex();
renderBenchmarkList();
renderBenchmarkSelect();

// ========== 一键生成分析报告（design doc §10.3） ==========
// 只负责拼接各面板已经算好的数据（不重新计算），图表部分用 Plotly.toImage 导出成 base64 图片；
// 报告结构：过滤条件说明 → 总览统计 → 数据质量摘要 → Top相关性表 → 关键图表 → 结论区（留空给用户手动补充）。
async function buildReportSections(options) {
  const parts = [];
  parts.push(`# 分析报告\n\n生成时间：${new Date().toLocaleString()}\n\n过滤条件：${describeCurrentFilter()}\n\n样本数：${activeRows.length}（原始 ${matchedRows.length} 条）\n`);

  if (options.summary && activeRows.length) {
    const mx = activeRows.map(r => r.returnMax);
    const ms = calcStats(mx, WIN_THRESHOLD);
    parts.push(`## 总览统计\n\n- returnMax 平均倍数：${ms.mean.toFixed(4)}x\n- 胜率（倍数>2，翻倍）：${(ms.winRate * 100).toFixed(1)}%\n- 最大倍数：${ms.max.toFixed(4)}x\n`);
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
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
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
  if (!activeRows.length) { showToast('请先点击"分析"加载数据'); return; }
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
