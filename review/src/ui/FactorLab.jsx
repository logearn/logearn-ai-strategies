import React, { useMemo, useState } from 'react';
import { Card, Button, Table, Tag, Tooltip, Typography, Space, Segmented, Alert,
         InputNumber, Slider, Input, Statistic, Row, Col, App as AntApp } from 'antd';
import PlotlyChart from './PlotlyChart.jsx';
import { getFieldDesc } from '../lib/dictionary.js';
import { formatNumberSmart } from '../lib/utils.js';
import { plotColors } from '../theme.js';
import { compileStrategy, runStrategyOnRow } from '../lib/proAnalytics.js';
import {
  FACTOR_WIN_THRESHOLDS, DEFAULT_FACTOR_WIN_THRESHOLD,
  scanFactorCandidates, buildFactors, autoWeights, baseStats,
  backtestFactors, runOOSBacktest, compareWithHardGate,
  resolveCtxAccessor, generateStrategyCode, classifyFieldOrigin, factorCorrelations,
  factorMarginalRho,
} from '../lib/factorLab.js';
import { loadFactorExclusions, saveFactorExclusions, excludeFactor,
         unexcludeFactor, filterExcluded } from '../lib/factorExclusions.js';

// 与 StrategyReplay 共用同一个 localStorage 键：策略代码在那边粘过一次，这边就不用再粘
const CODE_KEY = 'chart_strategy_diag_code_react';

const fmtPct = v => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-');
const fmtBound = v => (v === -Infinity ? '-∞' : v === Infinity ? '∞' : formatNumberSmart(v));
const fmtInterval = iv => iv ? `[${fmtBound(iv.lo)}, ${fmtBound(iv.hi)})` : '-';

// 勇者/邪恶两阵营共用的候选字段表列；差异点（区间/lift/捕获率的措辞、是否显示 AUC 方向）
// 按 camp 参数切换文案——底层数据结构（interval.lo/hi/lift/coverage/n）完全一样，
// 邪恶阵营的 interval 只是换成了"输家集中区"（findColdInterval 的结果），不是另一套字段。
// onExclude(field)：把这个字段标记成"不适合该阵营"，持久化排除——以后扫描/勾选都不再出现，
// 跟"删除已选因子"（removeFactor，只是取消这次勾选）是两回事，这个是更强的"判定"。
// getMarginal(field) -> undefined（未算）| { error } | { baseline, withCandidate, delta }
function makeScanColumns(camp, onExclude, getMarginal) {
  const isEvil = camp === 'evil';
  const cols = [
    { title: '字段', dataIndex: 'field', width: 230, fixed: 'left',
      render: v => <code style={{ fontSize: 11 }}>{v}</code> },
    { title: '含义', width: 170, ellipsis: true,
      render: (_, r) => <Tooltip title={getFieldDesc(r.field)}>
        <span style={{ opacity: .65 }}>{getFieldDesc(r.field)}</span></Tooltip> },
    { title: 'AUC', dataIndex: 'auc', width: 80, align: 'right', defaultSortOrder: 'descend',
      sorter: (a, b) => Math.abs(a.auc - .5) - Math.abs(b.auc - .5), render: v => v.toFixed(3) },
    { title: '判定', width: 110, render: (_, r) => r.significantAdj
      ? <Tag color="success">校正后显著</Tag>
      : r.significant ? <Tag color="warning">仅未校正显著</Tag> : <Tag>不显著</Tag> },
  ];
  if (!isEvil) {
    cols.push({ title: '方向', dataIndex: 'direction', width: 80,
      render: v => (v === 'high' ? '值大更好' : '值小更好') });
  }
  cols.push({
    title: <Tooltip title="把该字段临时并入当前已选因子池（自动配权）后，score↔returnMax 的 Spearman ρ 相比不加它的变化。北极星是 ρ 不是单字段 AUC——两者可能不一致（如信息与已选因子重叠，边际贡献会趋近 0）。">边际ρ贡献</Tooltip>,
    width: 100, align: 'right',
    sorter: (a, b) => {
      const ma = getMarginal(a.field), mb = getMarginal(b.field);
      return (Number.isFinite(ma?.delta) ? ma.delta : -Infinity) - (Number.isFinite(mb?.delta) ? mb.delta : -Infinity);
    },
    render: (_, r) => {
      const m = getMarginal(r.field);
      if (!m) return <Typography.Text type="secondary" style={{ fontSize: 11 }}>未算</Typography.Text>;
      if (m.error) return <Tooltip title={m.error}><Typography.Text type="secondary" style={{ fontSize: 11 }}>-</Typography.Text></Tooltip>;
      if (!Number.isFinite(m.delta)) return <Typography.Text type="secondary" style={{ fontSize: 11 }}>-</Typography.Text>;
      const sign = m.delta > 0 ? '+' : '';
      return <Tooltip title={`池外ρ=${Number.isFinite(m.baseline) ? m.baseline.toFixed(3) : '-'} → 池内ρ=${m.withCandidate.toFixed(3)}`}>
        <span style={{ color: m.delta > 0 ? '#30d158' : m.delta < 0 ? '#ff453a' : undefined, fontSize: 11 }}>
          {sign}{m.delta.toFixed(3)}
        </span>
      </Tooltip>;
    },
  });
  cols.push(
    { title: isEvil ? '输家集中区间' : '高倍集中区间', width: 150,
      render: (_, r) => r.interval
        ? <code style={{ fontSize: 11 }}>{fmtInterval(r.interval)}</code>
        : <Tooltip title={r.intervalError}><Typography.Text type="secondary" style={{ fontSize: 11 }}>无</Typography.Text></Tooltip> },
    { title: isEvil ? '风险lift' : 'lift', width: 70, align: 'right',
      sorter: (a, b) => (a.interval?.lift ?? 0) - (b.interval?.lift ?? 0),
      render: (_, r) => r.interval ? r.interval.lift.toFixed(2) : '-' },
    { title: isEvil ? '输家捕获率' : '捕获率', width: 80, align: 'right',
      render: (_, r) => r.interval ? fmtPct(r.interval.coverage) : '-' },
    { title: '区间n', width: 70, align: 'right', render: (_, r) => r.interval ? r.interval.n : '-' },
    { title: '缺失率', width: 80, align: 'right', sorter: (a, b) => a.missRate - b.missRate,
      render: (_, r) => fmtPct(r.missRate) },
    { title: '', width: 70, render: (_, r) => (
      <Button size="small" type="text" danger onClick={() => onExclude(r.field)}>移除</Button>) },
  );
  return cols;
}

export default function FactorLab({ rows, fields, light }) {
  const { message } = AntApp.useApp();
  const [threshold, setThreshold] = useState(DEFAULT_FACTOR_WIN_THRESHOLD);
  // 字段范围：默认只扫原字段（数据源直接给、能映射回实盘 ctx 的）。组装字段是工具聚合/派生的，
  // 无法进生成代码，需要人工审核后才考虑使用——所以单独一档，不和原字段混在一张表里。
  const [fieldScope, setFieldScope] = useState('original');
  // 两个阵营各自的扫描结果与已选字段：勇者阵营挖"高倍盘集中区"用来加分，
  // 邪恶阵营挖"输家集中区"用来减分。两套候选池独立扫描、独立勾选，最后合并成一份 factors。
  const [scanHero, setScanHero] = useState(null);
  const [scanEvil, setScanEvil] = useState(null);
  const [scanThreshold, setScanThreshold] = useState(null); // 扫描时用的阈值，切换后提示重扫
  const [scanScope, setScanScope] = useState(null);         // 扫描时用的字段范围，切换后提示重扫
  const [scanBusy, setScanBusy] = useState(false);
  const [selectedHero, setSelectedHero] = useState([]);
  const [selectedEvil, setSelectedEvil] = useState([]);
  // 因子发现表的"移除"清单：手动判定某字段不适合某阵营，持久化排除——扫描前过滤掉不再扫，
  // 已经扫出来的候选表也立刻过滤掉不再展示。camp+field 两边各自独立。
  const [exclusions, setExclusions] = useState(loadFactorExclusions);
  const [showExcluded, setShowExcluded] = useState({ hero: false, evil: false });
  // 打分形状：trap=梯形（密集核满分/满罚、边缘衰减）；interval=区间命中（在可信区间=满权重，区间外=0）
  const [scoreShape, setScoreShape] = useState('trap');
  // 缺失口径：zero=缺失记0分（保守）；renorm=按在场因子权重重归一（不惩罚数据覆盖，覆盖<50% 判 0）
  const [missingPolicy, setMissingPolicy] = useState('zero');
  const [factors, setFactors] = useState([]);
  const [cutoff, setCutoff] = useState(60);
  const [oos, setOos] = useState(null);
  const [oosBusy, setOosBusy] = useState(false);
  const [strategySrc, setStrategySrc] = useState(() => localStorage.getItem(CODE_KEY) || '');
  const [replay, setReplay] = useState(null);
  const [replayBusy, setReplayBusy] = useState(false);
  const [gen, setGen] = useState(null);
  // 候选字段的边际 ρ 贡献：按需算（synchronous 扫一遍候选表对样本量较大的池子有开销，不跟着每次
  // 渲染自动重算），key = camp+':'+field；poolKey 记录算这份结果时的因子池签名，池子变了就判过期。
  const [marginalRho, setMarginalRho] = useState(null); // { poolKey, map }
  const [marginalBusy, setMarginalBusy] = useState(false);

  const base = useMemo(() => baseStats(rows, threshold), [rows, threshold]);
  const scopedFields = useMemo(
    () => fields.filter(f => classifyFieldOrigin(f).original === (fieldScope === 'original')),
    [fields, fieldScope]);
  const backtest = useMemo(
    () => (factors.length ? backtestFactors(rows, factors, threshold, { missingPolicy }) : null),
    [rows, factors, threshold, missingPolicy]);
  // 已选因子两两相关性：|Spearman ρ|>=0.7 的组合有重复计分嫌疑，挂黄标提醒
  const factorCorr = useMemo(
    () => (factors.length >= 2 ? factorCorrelations(rows, factors.map(f => f.field)) : []),
    [rows, factors]);
  const compare = useMemo(
    () => (backtest && replay && replay.hitIds ? compareWithHardGate(backtest.scored, replay.hitIds, cutoff, threshold) : null),
    [backtest, replay, cutoff, threshold]);
  const hasEvil = factors.some(f => f.camp === 'evil');
  const cutoffMin = hasEvil ? -100 : 0;

  // 任何会改变打分参数的操作都要把"下游背书"（OOS 结果 / 生成代码）作废，
  // 否则屏幕上会留着一份基于旧参数的验证结果给新参数站台
  const invalidateDownstream = () => { setOos(null); setGen(null); };

  function changeThreshold(t) {
    setThreshold(t);
    invalidateDownstream();
  }

  async function runScan() {
    setScanBusy(true);
    setMarginalRho(null); // 新一轮扫描的候选区间/AUC 全变了，旧的边际ρ结果直接作废
    await new Promise(r => setTimeout(r, 0));   // 让出一帧，按钮 loading 才能画出来
    try {
      const scanOpts = { winThreshold: threshold, bootstrapB: 200 };
      // 已经判定"不适合该阵营"的字段直接不喂进扫描——既不浪费 bootstrap 算力，
      // 也保证它们以后不会又出现在候选表里（不是扫出来再过滤展示，是压根不扫）。
      const heroScanFields = filterExcluded(scopedFields, exclusions, 'hero');
      const evilScanFields = filterExcluded(scopedFields, exclusions, 'evil');
      const [resHero, resEvil] = await Promise.all([
        scanFactorCandidates(rows, heroScanFields, { ...scanOpts, camp: 'hero' }),
        scanFactorCandidates(rows, evilScanFields, { ...scanOpts, camp: 'evil' }),
      ]);
      setScanHero(resHero); setScanEvil(resEvil);
      setScanThreshold(threshold);
      setScanScope(fieldScope);
      // 保留仍然有效的已选字段，其余清掉
      const stillHero = new Set(resHero.candidates.filter(c => c.interval).map(c => c.field));
      const stillEvil = new Set(resEvil.candidates.filter(c => c.interval).map(c => c.field));
      const keepHero = selectedHero.filter(f => stillHero.has(f));
      const keepEvil = selectedEvil.filter(f => stillEvil.has(f));
      setSelectedHero(keepHero); setSelectedEvil(keepEvil);
      rebuildFactors(resHero, resEvil, keepHero, keepEvil, []);
      invalidateDownstream();
    } finally { setScanBusy(false); }
  }

  // 合并两个阵营的候选与已选字段，重新构建 factors。新增字段自动推导打分形状，
  // 已有字段保留手工编辑；权重整体重配（组合变了，旧权重的相对比例已失去意义）
  function rebuildFactors(rHero, rEvil, heroSel, evilSel, prevFactors, shape = scoreShape) {
    // 复合键 camp+field：只按 field 查会让"先勾了 hero 版的这个字段，再勾 evil 版的同一个字段"
    // 时，新算出来的 evil 因子被 prevMap 里那份【hero】的旧缓存整个覆盖掉（camp 也被带偏），
    // 这是真实踩过的 bug——两次勾选同一字段、后一次的阵营选择在权重表里被吃掉了
    const prevMap = new Map(prevFactors.map(f => [f.camp + ':' + f.field, f]));
    const candidates = [...(rHero ? rHero.candidates : []), ...(rEvil ? rEvil.candidates : [])];
    // 必须带 camp 一起查（而不是只传字段名）：同一字段在勇者/邪恶两个阵营各自都有一份候选
    // （UI 对同一批字段跑了两次扫描），只按字段名查会让结果取决于 candidates 数组的拼接顺序，
    // 跟用户到底在哪张表里勾选的完全无关
    const fieldSpecs = [
      ...heroSel.map(field => ({ field, camp: 'hero' })),
      ...evilSel.map(field => ({ field, camp: 'evil' })),
    ];
    const { factors: derived, skipped } = buildFactors(rows, candidates, fieldSpecs, threshold, { shape });
    const merged = derived.map(f => {
      const prev = prevMap.get(f.camp + ':' + f.field);
      return prev ? { ...prev, auc: f.auc, weight: 0 } : f;
    });
    setFactors(autoWeights(merged));
    if (skipped.length) message.warning(`${skipped.length} 个字段无法推导区间被跳过：` + skipped.map(s => s.field).join('、'));
    invalidateDownstream();
  }

  // 按 field+camp 复合匹配，而不是只按 field：同一字段理论上可以同时在两个阵营各选一次
  // （不建议但不禁止），只按 field 匹配会让编辑/删除其中一个连带影响到另一个阵营的那份
  function editFactor(field, camp, patch) {
    setFactors(prev => prev.map(f => (f.field === field && f.camp === camp ? { ...f, ...patch } : f)));
    invalidateDownstream();
  }

  function removeFactor(f) {
    if (f.camp === 'evil') setSelectedEvil(prev => prev.filter(x => x !== f.field));
    else setSelectedHero(prev => prev.filter(x => x !== f.field));
    setFactors(prev => autoWeights(prev.filter(x => !(x.field === f.field && x.camp === f.camp))));
    invalidateDownstream();
  }

  // 因子发现候选表里的"移除"：判定这个字段不适合这个阵营，持久化排除（不是取消勾选那种临时的）。
  // 如果当时已经勾选了，一并取消勾选、从因子表里删掉——判定不适合了就不该继续参与打分。
  function handleExcludeCandidate(camp, field) {
    const next = excludeFactor(exclusions, { camp, field });
    setExclusions(next);
    saveFactorExclusions(next);
    if (camp === 'evil' && selectedEvil.includes(field)) {
      const keys = selectedEvil.filter(f => f !== field);
      setSelectedEvil(keys);
      rebuildFactors(scanHero, scanEvil, selectedHero, keys, factors);
    } else if (camp === 'hero' && selectedHero.includes(field)) {
      const keys = selectedHero.filter(f => f !== field);
      setSelectedHero(keys);
      rebuildFactors(scanHero, scanEvil, keys, selectedEvil, factors);
    }
    message.success(`已把「${field}」标记为不适合${camp === 'evil' ? '邪恶' : '勇者'}阵营，以后扫描不会再出现`);
  }

  function handleUnexcludeCandidate(camp, field) {
    const next = unexcludeFactor(exclusions, { camp, field });
    setExclusions(next);
    saveFactorExclusions(next);
  }

  async function runOOS() {
    setOosBusy(true);
    await new Promise(r => setTimeout(r, 0));
    try {
      const fieldSpecs = [
        ...selectedHero.map(field => ({ field, camp: 'hero' })),
        ...selectedEvil.map(field => ({ field, camp: 'evil' })),
      ];
      const res = await runOOSBacktest(rows, fieldSpecs, threshold, { bootstrapB: 100, shape: scoreShape, missingPolicy });
      setOos(res);
      if (res.error) message.warning(res.error);
    } finally { setOosBusy(false); }
  }

  async function runReplay() {
    if (!strategySrc.trim()) { message.warning('请先粘贴现有策略代码'); return; }
    localStorage.setItem(CODE_KEY, strategySrc);
    setReplayBusy(true);
    await new Promise(r => setTimeout(r, 0));
    try {
      const compiled = compileStrategy(strategySrc);
      if (compiled.error) { setReplay({ error: compiled.error }); return; }
      const hitIds = new Set();
      let errors = 0, noCtx = 0;
      for (const row of rows) {
        if (!row.rawCtx) { noCtx++; continue; }
        const res = runStrategyOnRow(compiled, row);
        if (res.error) { errors++; continue; }
        if (res.passed) hitIds.add(row.id);
      }
      setReplay({ hitIds, errors, noCtx, total: rows.length });
    } finally { setReplayBusy(false); }
  }

  function runGenerate() {
    const resolved = factors.map(f => resolveCtxAccessor(rows, f.field));
    const res = generateStrategyCode({ factors, resolved, cutoff, winThreshold: threshold,
                                       sampleN: rows.length, missingPolicy });
    setGen(res);
    if (res.error) message.error(res.error);
  }

  async function copyCode() {
    try { await navigator.clipboard.writeText(gen.code); message.success('已复制'); }
    catch { message.error('复制失败，请手动全选复制'); }
  }

  const staleScan = (scanHero || scanEvil) && (scanThreshold !== threshold || scanScope !== fieldScope);
  // 因子池签名：谁在池子里、打分方式/缺失口径是什么——任一项变了，已算出的边际ρ就该判过期
  // （不是删掉，界面上仍显示但标"已过期"，避免因子发现表整片瞬间清空造成跳动）
  const poolKey = factors.map(f => f.camp + ':' + f.field).sort().join(',') + '|' + scoreShape + '|' + missingPolicy + '|' + threshold;
  const marginalStale = marginalRho && marginalRho.poolKey !== poolKey;
  const getMarginal = field => (marginalRho ? marginalRho.map.get(field) : undefined);

  async function runMarginalRho() {
    setMarginalBusy(true);
    await new Promise(r => setTimeout(r, 0));
    try {
      const map = new Map();
      const heroSelSet = new Set(selectedHero), evilSelSet = new Set(selectedEvil);
      const pools = [
        [visibleHeroCandidates, 'hero', heroSelSet],
        [visibleEvilCandidates, 'evil', evilSelSet],
      ];
      for (const [list, camp, selSet] of pools) {
        if (!list) continue;
        for (const c of list) {
          if (!c.interval || selSet.has(c.field)) continue; // 已在池子里的因子不算"加入"边际
          map.set(c.field, factorMarginalRho(rows, factors, c, camp, threshold, { shape: scoreShape, missingPolicy }));
        }
      }
      setMarginalRho({ poolKey, map });
    } finally { setMarginalBusy(false); }
  }

  // 不用 useMemo 缓存：列定义要闭包住当前这一份 handleExcludeCandidate（引用了随渲染变化的
  // selectedHero/selectedEvil/scanHero/scanEvil），缓存住旧闭包会让"移除"按钮操作到过期的状态。
  const scanHeroColumns = makeScanColumns('hero', field => handleExcludeCandidate('hero', field), getMarginal);
  const scanEvilColumns = makeScanColumns('evil', field => handleExcludeCandidate('evil', field), getMarginal);
  // 已排除但候选表本身没扫出来（比如刚移除、还没重新扫描）的字段也该能在"已移除"里看到并恢复，
  // 所以不是单纯从 candidates 反查——扫描前已经把它们从 scopedFields 里过滤掉了。
  const excludedHero = exclusions.filter(x => x.camp === 'hero');
  const excludedEvil = exclusions.filter(x => x.camp === 'evil');
  const visibleHeroCandidates = scanHero ? filterExcluded(scanHero.candidates, exclusions, 'hero', c => c.field) : null;
  const visibleEvilCandidates = scanEvil ? filterExcluded(scanEvil.candidates, exclusions, 'evil', c => c.field) : null;

  // ---------- 因子权重编辑表 ----------
  const boundInput = (f, key, openIsNeg) => (
    <InputNumber size="small" style={{ width: 90 }}
      value={Number.isFinite(f[key]) ? f[key] : null}
      placeholder={openIsNeg ? '-∞' : '∞'}
      onChange={v => editFactor(f.field, f.camp, { [key]: v == null ? (openIsNeg ? -Infinity : Infinity) : v })} />
  );
  const weightSum = factors.reduce((a, f) => a + f.weight, 0);
  const factorColumns = [
    { title: '字段', dataIndex: 'field', width: 200, fixed: 'left',
      render: v => <Tooltip title={getFieldDesc(v)}><code style={{ fontSize: 11 }}>{v}</code></Tooltip> },
    { title: '阵营', dataIndex: 'camp', width: 70,
      filters: [{ text: '勇者', value: 'hero' }, { text: '邪恶', value: 'evil' }],
      onFilter: (v, f) => f.camp === v,
      render: v => v === 'evil' ? <Tag color="error">邪恶</Tag> : <Tag color="success">勇者</Tag> },
    { title: <Tooltip title="勇者阵营=0分下界；邪恶阵营=0分（不扣分）下界">下界 lo0</Tooltip>,
      width: 100, render: (_, f) => boundInput(f, 'lo0', true) },
    { title: <Tooltip title="勇者阵营=满分核起点；邪恶阵营=危险核起点（命中此区间开始扣分）">核心起 lo1</Tooltip>,
      width: 100, render: (_, f) => boundInput(f, 'lo1', true) },
    { title: <Tooltip title="勇者阵营=满分核止点；邪恶阵营=危险核止点">核心止 hi1</Tooltip>,
      width: 100, render: (_, f) => boundInput(f, 'hi1', false) },
    { title: <Tooltip title="勇者阵营=0分上界；邪恶阵营=0分（不扣分）上界">上界 hi0</Tooltip>,
      width: 100, render: (_, f) => boundInput(f, 'hi0', false) },
    { title: '权重', width: 100, render: (_, f) => (
      <InputNumber size="small" style={{ width: 80 }} min={0} step={0.1} value={f.weight}
        onChange={v => editFactor(f.field, f.camp, { weight: v ?? 0 })} />) },
    { title: 'AUC', width: 70, align: 'right', render: (_, f) => Number.isFinite(f.auc) ? f.auc.toFixed(3) : '-' },
    { title: '缺失率', width: 80, align: 'right', render: (_, f) => fmtPct(f.missRate) },
    { title: '', width: 60, render: (_, f) => (
      <Button size="small" type="text" danger onClick={() => removeFactor(f)}>删除</Button>) },
  ];

  // ---------- 阈值扫描图 ----------
  const sweepFigure = useMemo(() => {
    if (!backtest) return null;
    const c = plotColors(!light);
    const pts = backtest.sweep.points;
    const traces = [
      { x: pts.map(p => p.cut), y: pts.map(p => p.triggered), name: '触发数',
        type: 'scatter', mode: 'lines', line: { color: '#0a84ff', width: 2 } },
      { x: pts.map(p => p.cut), y: pts.map(p => (p.hitRate * 100)), name: `高倍命中率%（>${threshold}x）`,
        type: 'scatter', mode: 'lines', yaxis: 'y2', line: { color: '#30d158', width: 2 } },
      { x: pts.map(p => p.cut), y: pts.map(p => (p.capture * 100)), name: '高倍捕获率%',
        type: 'scatter', mode: 'lines', yaxis: 'y2', line: { color: '#ff9f0a', width: 2, dash: 'dot' } },
    ];
    const layout = {
      height: 340, margin: { l: 56, r: 56, t: 24, b: 40 },
      paper_bgcolor: c.paperBg, plot_bgcolor: c.paperBg, font: { color: c.textColor, size: 12 },
      xaxis: { title: { text: '触发阈值（总分）' }, ...c.axis },
      yaxis: { title: { text: '触发数' }, ...c.axis, rangemode: 'tozero' },
      yaxis2: { title: { text: '%' }, overlaying: 'y', side: 'right', range: [0, 105], ...c.axis },
      shapes: [{ type: 'line', x0: cutoff, x1: cutoff, y0: 0, y1: 1, yref: 'paper',
                 line: { color: '#ff453a', width: 1.5, dash: 'dash' } }],
      legend: { orientation: 'h', y: 1.12 },
      showlegend: true,
    };
    return { traces, layout };
  }, [backtest, cutoff, light, threshold]);

  const decileColumns = [
    { title: '分段', dataIndex: 'bin', width: 60 },
    { title: '分数区间', width: 130, render: (_, d) => `${d.scoreLo.toFixed(1)} ~ ${d.scoreHi.toFixed(1)}` },
    { title: 'n', dataIndex: 'n', width: 60, align: 'right' },
    { title: `>${threshold}x 数`, dataIndex: 'pos', width: 80, align: 'right' },
    { title: '高倍率', width: 150, align: 'right',
      render: (_, d) => `${fmtPct(d.hiRate)}（${fmtPct(d.wilson.lo)}~${fmtPct(d.wilson.hi)}）` },
    { title: '倍数均值', width: 90, align: 'right', render: (_, d) => d.avgRet.toFixed(2) + 'x' },
    { title: '倍数中位', width: 90, align: 'right', render: (_, d) => d.medRet.toFixed(2) + 'x' },
  ];

  const sweepAt = (bt, cut) => bt.sweep.points.reduce((best, p) => (p.cut <= cut ? p : best), bt.sweep.points[0]);

  const cmpColumns = compare ? [
    { title: '', dataIndex: 'k', width: 160 },
    { title: `旧策略命中（n=${compare.old.n}）`, dataIndex: 'old', align: 'right' },
    { title: `新打分 ≥${cutoff}（n=${compare.neu.n}）`, dataIndex: 'neu', align: 'right' },
    { title: `交集（n=${compare.both.n}）`, dataIndex: 'both', align: 'right' },
  ] : [];
  const cmpRows = compare ? [
    { k: `高倍数（>${threshold}x）`, old: compare.old.pos, neu: compare.neu.pos, both: compare.both.pos },
    { k: '高倍命中率', old: fmtPct(compare.old.hiRate), neu: fmtPct(compare.neu.hiRate), both: fmtPct(compare.both.hiRate) },
    { k: '高倍捕获率', old: fmtPct(compare.old.capture), neu: fmtPct(compare.neu.capture), both: fmtPct(compare.both.capture) },
    { k: '倍数中位数', old: Number.isFinite(compare.old.medRet) ? compare.old.medRet.toFixed(2) + 'x' : '-',
      neu: Number.isFinite(compare.neu.medRet) ? compare.neu.medRet.toFixed(2) + 'x' : '-',
      both: Number.isFinite(compare.both.medRet) ? compare.both.medRet.toFixed(2) + 'x' : '-' },
    { k: '最高倍数', old: Number.isFinite(compare.old.maxRet) ? compare.old.maxRet.toFixed(1) + 'x' : '-',
      neu: Number.isFinite(compare.neu.maxRet) ? compare.neu.maxRet.toFixed(1) + 'x' : '-',
      both: Number.isFinite(compare.both.maxRet) ? compare.both.maxRet.toFixed(1) + 'x' : '-' },
  ].map((r, i) => ({ ...r, key: i })) : [];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* 1. 阈值与总览 */}
      <Card size="small" title="高倍阈值与样本总览"
        extra={<Segmented value={threshold} onChange={changeThreshold}
          options={FACTOR_WIN_THRESHOLDS.map(t => ({ label: `${t}x`, value: t }))} />}>
        <Row gutter={24}>
          <Col><Statistic title="样本数" value={base.n} /></Col>
          <Col><Statistic title={`高倍盘（>${threshold}x）`} value={base.pos} /></Col>
          <Col><Statistic title="基准高倍率" value={fmtPct(base.baseRate)}
            suffix={<span style={{ fontSize: 12, opacity: .55 }}>（{fmtPct(base.wilson.lo)}~{fmtPct(base.wilson.hi)}）</span>} /></Col>
        </Row>
        {base.pos < 30 && base.n > 0 && (
          <Alert style={{ marginTop: 12 }} type="warning" showIcon
            message={`当前阈值下高倍盘只有 ${base.pos} 个，区间挖掘和权重的统计稳定性都很差——结论只能当线索，建议积累更多天的数据或调低阈值。`} />)}
      </Card>

      {/* 2. 因子发现：勇者阵营 + 邪恶阵营 两个候选池 */}
      <Card size="small" title="因子发现（勇者阵营找高倍集中区加分 · 邪恶阵营找输家集中区减分）"
        extra={<Space>
          <Segmented value={fieldScope} onChange={v => setFieldScope(v)}
            options={[{ label: '原字段', value: 'original' }, { label: '组装字段', value: 'assembled' }]} />
          <Button type="primary" loading={scanBusy} disabled={!rows.length || !scopedFields.length}
            onClick={runScan}>扫描 {scopedFields.length} 个{fieldScope === 'original' ? '原' : '组装'}字段（两阵营）</Button>
          <Tooltip title="逐个把候选字段临时并入当前因子池，看 score↔returnMax 的 Spearman ρ 变化——比单字段 AUC 更贴近北极星指标">
            <Button loading={marginalBusy} disabled={!scanHero && !scanEvil}
              onClick={runMarginalRho}>计算候选边际ρ贡献</Button>
          </Tooltip>
        </Space>}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          两个阵营各自独立扫描：<b>勇者阵营</b>挖"高倍盘集中的取值区间"，命中 = 好迹象、加分；
          <b>邪恶阵营</b>挖"输家（未达高倍阈值）集中的取值区间"，命中 = 危险迹象、减分。
          两边都复用同一套 AUC + 区间挖掘算法（lift/捕获率评分口径一致，只是目标类从"赢"换成"输"）。
          「原字段」是数据源直接给的、能映射回实盘 ctx 进生成代码；「组装字段」是本工具聚合/派生的，
          仅供探索审核，无法进入生成代码。
        </Typography.Paragraph>
        {fieldScope === 'assembled' && <Alert style={{ marginBottom: 12 }} type="info" showIcon
          message="组装字段是工具从快照聚合/派生出来的，实盘 ctx 里没有对应值——回测发现的规律需要你人工审核认可后，再想办法在实盘侧复刻计算，不能直接生成代码。" />}
        {staleScan && <Alert style={{ marginBottom: 12 }} type="warning" showIcon
          message={scanScope !== fieldScope
            ? `扫描结果是「${scanScope === 'original' ? '原字段' : '组装字段'}」范围的，当前已切到「${fieldScope === 'original' ? '原字段' : '组装字段'}」，请重新扫描。`
            : `扫描结果是在 ${scanThreshold}x 阈值下算的，当前已切到 ${threshold}x，请重新扫描。`} />}
        {marginalStale && <Alert style={{ marginBottom: 12 }} type="warning" showIcon
          message="因子池/打分方式/缺失口径/阈值已变化，「边际ρ贡献」列是旧结果，请重新计算。" />}

        {scanHero && (
          <>
            <Space align="center" style={{ marginBottom: 6 }}>
              <Typography.Text strong style={{ fontSize: 12 }}>
                🛡 勇者阵营候选（{visibleHeroCandidates.length} 个可用 / 跳过 {scanHero.skipped.length} 个）
              </Typography.Text>
              {excludedHero.length > 0 && (
                <Typography.Link style={{ fontSize: 12 }}
                  onClick={() => setShowExcluded(s => ({ ...s, hero: !s.hero }))}>
                  已移除 {excludedHero.length} 个（{showExcluded.hero ? '收起' : '查看/恢复'}）
                </Typography.Link>
              )}
            </Space>
            {showExcluded.hero && (
              <div style={{ marginBottom: 8 }}>
                <Space wrap size={4}>
                  {excludedHero.map(x => (
                    <Tag key={x.field} closable onClose={() => handleUnexcludeCandidate('hero', x.field)}>
                      {x.field}
                    </Tag>
                  ))}
                </Space>
              </div>
            )}
            <Table style={{ marginTop: 6, marginBottom: 16 }} size="small" rowKey="field"
              columns={scanHeroColumns} dataSource={visibleHeroCandidates}
              rowSelection={{
                selectedRowKeys: selectedHero,
                onChange: keys => { setSelectedHero(keys); rebuildFactors(scanHero, scanEvil, keys, selectedEvil, factors); },
                getCheckboxProps: r => ({ disabled: !r.interval }),
              }}
              scroll={{ x: 1200, y: 320 }} pagination={{ pageSize: 20, size: 'small' }} />
          </>
        )}
        {scanEvil && (
          <>
            <Space align="center" style={{ marginBottom: 6 }}>
              <Typography.Text strong style={{ fontSize: 12 }}>
                ☠ 邪恶阵营候选（{visibleEvilCandidates.length} 个可用 / 跳过 {scanEvil.skipped.length} 个）
              </Typography.Text>
              {excludedEvil.length > 0 && (
                <Typography.Link style={{ fontSize: 12 }}
                  onClick={() => setShowExcluded(s => ({ ...s, evil: !s.evil }))}>
                  已移除 {excludedEvil.length} 个（{showExcluded.evil ? '收起' : '查看/恢复'}）
                </Typography.Link>
              )}
            </Space>
            {showExcluded.evil && (
              <div style={{ marginBottom: 8 }}>
                <Space wrap size={4}>
                  {excludedEvil.map(x => (
                    <Tag key={x.field} closable onClose={() => handleUnexcludeCandidate('evil', x.field)}>
                      {x.field}
                    </Tag>
                  ))}
                </Space>
              </div>
            )}
            <Table style={{ marginTop: 6 }} size="small" rowKey="field"
              columns={scanEvilColumns} dataSource={visibleEvilCandidates}
              rowSelection={{
                selectedRowKeys: selectedEvil,
                onChange: keys => { setSelectedEvil(keys); rebuildFactors(scanHero, scanEvil, selectedHero, keys, factors); },
                getCheckboxProps: r => ({ disabled: !r.interval }),
              }}
              scroll={{ x: 1200, y: 320 }} pagination={{ pageSize: 20, size: 'small' }} />
          </>
        )}
      </Card>

      {/* 3. 因子权重（可编辑） */}
      {factors.length > 0 && (
        <Card size="small" title={`因子权重（${factors.length} 个，可编辑）`}
          extra={<Space>
            <Typography.Text type={Math.abs(weightSum - 100) > 0.5 ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
              权重合计 {weightSum.toFixed(1)}{Math.abs(weightSum - 100) > 0.5 ? '（≠100，总分会按合计归一）' : ''}
            </Typography.Text>
            <Segmented size="small" value={scoreShape}
              options={[{ label: '梯形', value: 'trap' }, { label: '区间命中', value: 'interval' }]}
              onChange={v => { setScoreShape(v); if (scanHero || scanEvil) rebuildFactors(scanHero, scanEvil, selectedHero, selectedEvil, [], v); }} />
            <Segmented size="small" value={missingPolicy}
              options={[{ label: '缺失记0分', value: 'zero' }, { label: '缺失重归一', value: 'renorm' }]}
              onChange={v => { setMissingPolicy(v); invalidateDownstream(); }} />
            <Button size="small" onClick={() => (scanHero || scanEvil) && rebuildFactors(scanHero, scanEvil, selectedHero, selectedEvil, [])}>全部重置为自动</Button>
          </Space>}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
            <Tag color="success" style={{ marginRight: 4 }}>勇者</Tag>命中核心区 = +权重×命中度（加分）；
            <Tag color="error" style={{ marginRight: 4 }}>邪恶</Tag>命中核心区 = -权重×命中度（减分）。
            {scoreShape === 'trap'
              ? '梯形打分：值落在 [核心起, 核心止] 满效应，向两侧的 0 效应界线性衰减，界外 0；留空 = 该侧不设界（∞）。'
              : '区间命中打分：值落在挖出的可信区间内 = 满效应（±权重），区间外 = 0，没有过渡段（核心起/止就是区间边界，仍可手工微调）。'}
            {missingPolicy === 'zero'
              ? '字段缺失记 0（不加不减，惩罚数据不全的盘，保守）。'
              : '字段缺失时该因子不参与，按在场因子权重重归一；在场权重不足 50% 判 0 分。'}
            总分 = Σ(±权重×命中度)/权重合计×100，纯勇者阵营时落在 0~100，含邪恶阵营命中时可能为负。
            权重自动按 |AUC−0.5| 分配，可手工调整。切换打分方式会按新方式重新推导边界（手工编辑会被重置）。
          </Typography.Paragraph>
          {factorCorr.length > 0 && (
            <Alert style={{ marginBottom: 12 }} type="warning" showIcon
              message={<span style={{ fontSize: 12 }}>
                以下因子高度相关（|Spearman ρ|≥0.7），同一份信息在重复计分——建议二选一或手动降权：
                {factorCorr.map((c, i) => (
                  <div key={i} style={{ paddingLeft: 8 }}>
                    · <code style={{ fontSize: 11 }}>{c.a}</code> ↔ <code style={{ fontSize: 11 }}>{c.b}</code>
                    　ρ={c.rho.toFixed(2)}（n={c.n}）
                  </div>
                ))}
              </span>} />)}
          {/* rowKey 用 camp+field 复合键：同一字段理论上可以被两个阵营各选一次（不建议但不禁止），
              纯按 field 当 key 会撞车，导致 AntD/React 拿错行的渲染状态 */}
          <Table size="small" rowKey={f => f.camp + ':' + f.field} columns={factorColumns} dataSource={factors}
            scroll={{ x: 1080 }} pagination={false} />
        </Card>)}

      {/* 4. 回测 */}
      {backtest && (
        <Card size="small" title="回测"
          extra={<Space size={16}>
            <span style={{ fontSize: 12, opacity: .65 }}>触发阈值</span>
            <Slider style={{ width: 180 }} min={cutoffMin} max={100} value={cutoff}
              onChange={v => { setCutoff(v); setGen(null); }} />
            <InputNumber size="small" min={cutoffMin} max={100} value={cutoff}
              onChange={v => { setCutoff(v ?? 0); setGen(null); }} />
          </Space>}>
          {hasEvil && <Alert style={{ marginBottom: 12 }} type="info" showIcon
            message="已包含邪恶阵营因子，总分可能为负——阈值滑块下限已相应放宽到 -100。" />}
          {(() => { const p = sweepAt(backtest, cutoff); return (
            <Row gutter={24} style={{ marginBottom: 12 }}>
              <Col><Statistic title="触发数" value={p.triggered} suffix={`/ ${base.n}`} /></Col>
              <Col><Statistic title={`高倍命中率（基准 ${fmtPct(base.baseRate)}）`} value={fmtPct(p.hitRate)} /></Col>
              <Col><Statistic title="高倍捕获率" value={fmtPct(p.capture)} /></Col>
              <Col><Statistic title="lift" value={Number.isFinite(p.lift) ? p.lift.toFixed(2) : '-'} /></Col>
            </Row>); })()}
          {sweepFigure && <PlotlyChart traces={sweepFigure.traces} layout={sweepFigure.layout} height={340} />}
          <Table style={{ marginTop: 12 }} size="small" rowKey="bin" columns={decileColumns}
            dataSource={backtest.deciles} pagination={false} scroll={{ x: 700 }} />
          <div style={{ marginTop: 16 }}>
            <Space align="center">
              <Button loading={oosBusy} onClick={runOOS}>时间外推验证（前 70% 推导 → 后 30% 检验）</Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                区间与权重只用训练段重新自动推导（不含手工编辑），原样套到验证段——验证段明显衰减 = 过拟合。
              </Typography.Text>
            </Space>
            {oos && !oos.error && (() => {
              const tr = sweepAt(oos.train, cutoff), te = sweepAt(oos.test, cutoff);
              const decayed = Number.isFinite(tr.lift) && Number.isFinite(te.lift) && te.lift < tr.lift * 0.6;
              return (
                <div style={{ marginTop: 12 }}>
                  <Table size="small" pagination={false} rowKey="k"
                    columns={[
                      { title: '', dataIndex: 'k', width: 140 },
                      { title: `训练段（n=${oos.trainSize}）`, dataIndex: 'tr', align: 'right' },
                      { title: `验证段（n=${oos.testSize}）`, dataIndex: 'te', align: 'right' },
                    ]}
                    dataSource={[
                      { k: `触发数@${cutoff}`, tr: tr.triggered, te: te.triggered },
                      { k: '高倍命中率', tr: fmtPct(tr.hitRate), te: fmtPct(te.hitRate) },
                      { k: '高倍捕获率', tr: fmtPct(tr.capture), te: fmtPct(te.capture) },
                      { k: 'lift', tr: Number.isFinite(tr.lift) ? tr.lift.toFixed(2) : '-', te: Number.isFinite(te.lift) ? te.lift.toFixed(2) : '-' },
                    ].map((r, i) => ({ ...r, key: i }))} />
                  {decayed && <Alert style={{ marginTop: 8 }} type="warning" showIcon
                    message="验证段 lift 不到训练段的 60%——这套区间/权重疑似过拟合训练期行情，慎直接上实盘。" />}
                  {oos.skipped.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    训练段推导时跳过：{oos.skipped.map(s => `${s.field}（${s.reason}）`).join('；')}</Typography.Text>}
                </div>);
            })()}
            {oos && oos.error && <Alert style={{ marginTop: 8 }} type="warning" showIcon message={oos.error} />}
          </div>
        </Card>)}

      {/* 5. 对比现有硬门槛策略 */}
      {backtest && (
        <Card size="small" title="对比现有硬门槛策略"
          extra={<Button loading={replayBusy} onClick={runReplay}>回放对比</Button>}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            把现有策略代码（checks 契约）在全部样本上回放，与新打分（≥{cutoff} 分触发）对比命中集质量。
            代码与「策略」页共用，粘贴一处即可。
          </Typography.Paragraph>
          <Input.TextArea rows={6} value={strategySrc} onChange={e => setStrategySrc(e.target.value)}
            placeholder="粘贴现有策略代码（如 强势盘策略/code.js 的函数体）" style={{ fontFamily: 'monospace', fontSize: 12 }} />
          {replay && replay.error && <Alert style={{ marginTop: 8 }} type="error" showIcon message={replay.error} />}
          {replay && !replay.error && (
            <div style={{ marginTop: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                回放 {replay.total} 条：旧策略命中 {replay.hitIds.size} 条
                {replay.errors ? `；${replay.errors} 条回放报错` : ''}{replay.noCtx ? `；${replay.noCtx} 条缺原始 ctx 跳过` : ''}
              </Typography.Text>
              {compare && <Table style={{ marginTop: 8 }} size="small" pagination={false}
                columns={cmpColumns} dataSource={cmpRows} scroll={{ x: 700 }} />}
            </div>)}
        </Card>)}

      {/* 6. 生成策略打分代码 */}
      {factors.length > 0 && (
        <Card size="small" title="生成策略打分代码"
          extra={<Space>
            <Button type="primary" onClick={runGenerate}>按当前因子与阈值 {cutoff} 生成</Button>
            {gen && gen.code && <Button onClick={copyCode}>复制</Button>}
          </Space>}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            生成可直接粘贴进实盘策略的自包含打分代码（字段自动映射回原始 ctx 路径并抽样核对，
            取值/缩放/缺失/阵营符号语义与本面板回测完全一致——勇者阵营命中加分，邪恶阵营命中减分）。
            注意：原策略的硬否决条件（平台白名单、内鬼、创建者等防雷项）不在打分范围内，请保留在策略前段。
          </Typography.Paragraph>
          {gen && gen.excluded && gen.excluded.length > 0 && (
            <Alert style={{ marginBottom: 8 }} type="warning" showIcon
              message={`以下因子无法映射回原始 ctx，已从生成代码中排除：` +
                gen.excluded.map(e => `${e.field}（${e.reason}）`).join('；')} />)}
          {gen && gen.code && (
            <Input.TextArea readOnly rows={18} value={gen.code}
              style={{ fontFamily: 'monospace', fontSize: 12 }} />)}
        </Card>)}
    </Space>
  );
}
