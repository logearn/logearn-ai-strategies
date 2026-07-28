import React, { useEffect, useMemo, useState } from 'react';
import { Card, Button, Table, Tag, Tooltip, Typography, Space, Segmented, Alert,
         InputNumber, Slider, Input, Statistic, Row, Col, App as AntApp } from 'antd';
import PlotlyChart from './PlotlyChart.jsx';
import { getFieldDesc } from '../lib/dictionary.js';
import { formatNumberSmart } from '../lib/utils.js';
import { plotColors } from '../theme.js';
import { compileStrategy, runStrategyOnRow, parseFactorCheck } from '../lib/proAnalytics.js';
import {
  FACTOR_WIN_THRESHOLDS, DEFAULT_FACTOR_WIN_THRESHOLD,
  autoWeights, optimizeWeightsForBucketRho, baseStats, backtestFactors, runOOSBacktest, compareWithHardGate,
  classifyFieldOrigin, factorCorrelations, recommendCutoff, computeRankBuckets,
  missingRate,
} from '../lib/factorLab.js';
import { replaceScoreRowsInAllChecks } from '../lib/campLibrary.js';
import { loadFactorPoolState, saveFactorPoolState, clearFactorPoolState } from '../lib/factorPoolStore.js';
import { buildCandidateExportTsv } from '../lib/factorScanExport.js';
import { buildBacktestReport } from '../lib/backtestReportExport.js';
import ImportStrategyCard from './factorLab/ImportStrategyCard.jsx';
import FactorSopCard from './factorLab/FactorSopCard.jsx';
import MissedRowsCard from './factorLab/MissedRowsCard.jsx';
import FactorRecommendCard from './factorLab/FactorRecommendCard.jsx';
import CompareHardGateCard from './factorLab/CompareHardGateCard.jsx';
import { useFactorScan } from './factorLab/useFactorScan.js';

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
    title: <Tooltip title='把该字段临时并入当前已选因子池（自动配权）后，分层秩相关（自适应粗粒度分档、档内看命中率、不吃cutoff）相比不加它的变化——挑因子固定看这个，不再区分策略用途。'>
      边际分层秩相关贡献</Tooltip>,
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
      return <Tooltip title={`池外分层秩相关=${Number.isFinite(m.baseline) ? m.baseline.toFixed(3) : '-'} → 池内分层秩相关=${m.withCandidate.toFixed(3)}`}>
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
    { title: '区间判定', width: 110,
      render: (_, r) => {
        if (!r.interval) return <Typography.Text type="secondary" style={{ fontSize: 11 }}>-</Typography.Text>;
        return r.interval.significantAdj
          ? <Tooltip title={`置换检验p=${r.interval.pPermutation?.toFixed(3) ?? '-'}，BH校正后p=${r.interval.pAdj?.toFixed(3) ?? '-'}`}>
              <Tag color="success">校正后显著</Tag></Tooltip>
          : <Tooltip title="置换检验(为搜索了很多候选窗口这件事做了校正)认为这个区间的判别力可能只是巧合——单看这个字段不够稳，但不代表它组合进打分池就没用（这套系统本来就靠很多弱信号加权组合），仅供参考，不影响候选粗筛/因子推荐">
              <Tag>不显著</Tag></Tooltip>;
      } },
    { title: '缺失率', width: 80, align: 'right', sorter: (a, b) => a.missRate - b.missRate,
      render: (_, r) => fmtPct(r.missRate) },
    { title: '', width: 70, render: (_, r) => (
      <Button size="small" type="text" danger onClick={() => onExclude(r.field)}>移除</Button>) },
  );
  return cols;
}

export default function FactorLab({ rows, fields, light, strategyCode, onStrategyCodeChange, onGoToStrategy }) {
  const { message } = AntApp.useApp();
  // 因子池进度持久化：只在挂载时读一次（跟其它 localStorage 驱动的 state 同一套模式），
  // 用来给 threshold/fieldScope/scoreShape/missingPolicy/cutoff/factors 提供恢复初值——
  // 挖因子是个耗时手工活，刷新页面/误关标签页不该让这些进度清零。
  const [persisted] = useState(loadFactorPoolState);
  const [restoredNotice, setRestoredNotice] = useState(!!(persisted && persisted.factors && persisted.factors.length));
  const [threshold, setThreshold] = useState(persisted?.threshold ?? DEFAULT_FACTOR_WIN_THRESHOLD);
  // 字段范围：默认只扫原字段（数据源直接给、能映射回实盘 ctx 的）。组装字段是工具聚合/派生的，
  // 无法进生成代码，需要人工审核后才考虑使用——所以单独一档，不和原字段混在一张表里。
  const [fieldScope, setFieldScope] = useState(persisted?.fieldScope ?? 'original');
  // 候选表过滤：字段一多（几十上百个）逐行翻页找"够格"的候选很累，按几个关键指标设个下限/上限
  // 直接筛掉不够格的——只影响候选表的展示，不影响扫描/勾选本身（勾了的字段被过滤掉也不会被取消勾选）。
  // minMarginal 默认 0.005：算过边际ρ后自动只留"加进池子能提升 ρ（正贡献）"的候选——挑因子的口径。
  // 算之前该过滤不生效（下面 applyCandFilter 里有 scan.marginalRho 守卫），所以默认值不会误伤未算的表。
  const [candFilter, setCandFilter] = useState({ minAuc: 0, minMarginal: 0.005, minLift: 1.05, minN: 0, maxMissRate: 100 });
  const [candSearch, setCandSearch] = useState('');   // 按字段名/含义搜索候选（跨两阵营、跨分页）
  // 打分形状：trap=梯形（密集核满分/满罚、边缘衰减）；interval=区间命中（在可信区间=满权重，区间外=0）
  const [scoreShape, setScoreShape] = useState(persisted?.scoreShape ?? 'trap');
  // 缺失口径：zero=缺失记0分（保守）；renorm=按在场因子权重重归一（不惩罚数据覆盖，覆盖<50% 判 0）
  const [missingPolicy, setMissingPolicy] = useState(persisted?.missingPolicy ?? 'zero');
  const [factors, setFactors] = useState(persisted?.factors ?? []);
  const [cutoff, setCutoff] = useState(persisted?.cutoff ?? 60);
  const [oos, setOos] = useState(null);
  const [oosBusy, setOosBusy] = useState(false);
  // 2026-07-28 再订正：配权固定用分层秩相关（不吃 cutoff，自适应粗粒度分档、不要求逐点单调），
  // 不再提供"ρ最优"/"分层增益"两个可选口径——之前的设计是按策略用途在三者间选（默认ρ最优、
  // 筛垃圾用分层增益、推荐用分层秩相关），用户决定不再需要这层区分，统一只用分层秩相关。
  // 历史上"围绕cutoff判定"这个方向本身就有问题——该先按整体排序质量（粗粒度分层，不要求逐点
  // 单调）配好权重，cutoff 是排序定下来之后从结果里读出来的一个点（用下面「推荐阈值」），不该
  // 反过来先猜 cutoff 去配权，这也是分层秩相关（而不是绑定cutoff的分层增益）更适合作为唯一
  // 口径的原因之一。
  const [bucketRhoOpt, setBucketRhoOpt] = useState(null);
  const [bucketRhoOptBusy, setBucketRhoOptBusy] = useState(false);
  // 策略源码由 App 提升管理（跟「策略」tab 共用同一份 state + 持久化），这里不再自己 useState/
  // 读 localStorage——避免两个 tab 常驻挂载时各自缓存一份旧值、编辑了却互相看不见的问题。
  const strategySrc = strategyCode;
  const setStrategySrc = onStrategyCodeChange;
  const [replay, setReplay] = useState(null);
  const [replayBusy, setReplayBusy] = useState(false);

  // 只持久化"最终产物"：因子池本身 + 几个标量参数。scanHero/scanEvil/selectedHero/selectedEvil
  // 这类跟当次扫描强绑定的中间结果不存——体积大且换一批数据就可能失真，重新扫一次比恢复一份
  // 可能过期的候选表更可靠。
  useEffect(() => {
    if (!factors.length) { clearFactorPoolState(); return; }
    saveFactorPoolState({ factors, threshold, fieldScope, scoreShape, missingPolicy, cutoff });
  }, [factors, threshold, fieldScope, scoreShape, missingPolicy, cutoff]);

  const base = useMemo(() => baseStats(rows, threshold), [rows, threshold]);
  const scopedFields = useMemo(
    () => fields.filter(f => classifyFieldOrigin(f).original === (fieldScope === 'original')),
    [fields, fieldScope]);
  const backtest = useMemo(
    () => (factors.length ? backtestFactors(rows, factors, threshold, { missingPolicy }) : null),
    [rows, factors, threshold, missingPolicy]);
  // 残差子集：当前因子池打分 < cutoff 的样本（含漏网之鱼 + 真输家），残差模式下扫描/建因子都在这个子集里做。
  const residualRows = useMemo(() => {
    if (!backtest) return null;
    const missSet = new Set(backtest.scored.filter(s => s.score < cutoff).map(s => s.row.id));
    return rows.filter(r => missSet.has(r.id));
  }, [backtest, cutoff, rows]);
  // 已选因子两两相关性：|Spearman ρ|>=0.7 的组合有重复计分嫌疑，挂黄标提醒
  // 阈值设 0：拿到【全部】两两相关（按 |ρ| 降序），既能挑出 ≥0.7 的高相关对告警，
  // 也能在"无冗余"时把最高几对的具体 ρ 值列出来（不然只说"均<0.7"，看不出是 0.1 还是 0.68）。
  const factorCorr = useMemo(
    () => (factors.length >= 2 ? factorCorrelations(rows, factors.map(f => f.field), { threshold: 0 }) : []),
    [rows, factors]);
  const factorCorrHigh = useMemo(() => factorCorr.filter(c => Math.abs(c.rho) >= 0.7), [factorCorr]);
  const compare = useMemo(
    () => (backtest && replay && replay.hitIds ? compareWithHardGate(backtest.scored, replay.hitIds, cutoff, threshold) : null),
    [backtest, replay, cutoff, threshold]);
  // 低分高倍复盘（漏网之鱼）：分数没过触发线（用当前"回测"卡片同一个 cutoff）却真的翻倍的样本——
  // 当前因子池对它们基本没识别出来，是排查"漏因子/区间没覆盖/权重太小/数据缺失"的重点对象。
  // 按 returnMax 降序：漏得越离谱（倍数越高分数越低）越该优先看。
  const missedRows = useMemo(() => {
    if (!backtest) return [];
    return backtest.scored
      .filter(s => s.score < cutoff && Number(s.row.returnMax) > threshold)
      .sort((a, b) => Number(b.row.returnMax) - Number(a.row.returnMax));
  }, [backtest, cutoff, threshold]);
  async function copyMissedCAs() {
    try {
      await navigator.clipboard.writeText(missedRows.map(s => s.row.tokenAddress).filter(Boolean).join('\n'));
      message.success(`已复制 ${missedRows.length} 个 CA，可贴到「找因子」散点图的查找CA框里高亮`);
    } catch { message.error('复制失败，请手动从表格里复制'); }
  }

  // 采用因子推荐：把推荐路径上的 {field,camp} 并入勾选并重建因子池（跟勾候选一个效果）。
  function adoptRecommended(specs) {
    if (!specs || !specs.length) return;
    const heroAdd = specs.filter(s => s.camp !== 'evil').map(s => s.field);
    const evilAdd = specs.filter(s => s.camp === 'evil').map(s => s.field);
    const newHero = [...new Set([...scan.selectedHero, ...heroAdd])];
    const newEvil = [...new Set([...scan.selectedEvil, ...evilAdd])];
    scan.setSelectedHero(newHero); scan.setSelectedEvil(newEvil);
    scan.rebuildFactors(scan.scanHero, scan.scanEvil, newHero, newEvil, factors);
    message.success(`已采用 ${specs.length} 个推荐因子`);
  }

  // 导出回测报告（markdown）→ 复制到剪贴板，喂给 AI 诊断。把各处 state 抽成 lib 需要的 input。
  async function exportBacktestReport() {
    if (!backtest) { message.warning('先建好因子池、有回测结果再导出'); return; }
    const p = sweepAt(backtest, cutoff);
    const oosInput = (oos && !oos.error) ? {
      trainSize: oos.trainSize, testSize: oos.testSize, skipped: oos.skipped,
      train: sweepAt(oos.train, cutoff), test: sweepAt(oos.test, cutoff),
    } : (oos && oos.error ? { error: oos.error } : null);
    const report = buildBacktestReport({
      config: { sampleN: rows.length, threshold, cutoff, missingPolicy, scoreShape, fieldScope },
      base,
      factors: factors.map(f => ({ field: f.field, camp: f.camp, weight: f.weight,
        lo0: f.lo0, lo1: f.lo1, hi1: f.hi1, hi0: f.hi0, auc: f.auc, missRate: missingRate(rows, f.field) })),
      corr: factorCorr,
      bucketRhoOpt,
      current: { triggered: p.triggered, hitRate: p.hitRate, capture: p.capture, lift: p.lift },
      sweep: backtest.sweep.points.map(x => ({ cut: x.cut, triggered: x.triggered, hitRate: x.hitRate, capture: x.capture, lift: x.lift })),
      deciles: backtest.deciles,
      oos: oosInput,
      missed: missedRows.map(s => ({ ca: s.row.tokenAddress, symbol: s.row.symbol, score: s.score, ret: Number(s.row.returnMax) })),
    });
    try { await navigator.clipboard.writeText(report); message.success('回测报告已复制（markdown），直接粘给 AI 即可'); }
    catch { message.error('复制失败'); }
  }
  // 导出"精简样本"+当前因子池/候选/配置成一份 JSON——不是给人看的报告，是给"直接在 Node 里
  // import factorLab.js 重放同一套函数"用的数据快照。只挑 scoreRows/recommendFactorPath/
  // computeRankBuckets 等打分函数实际会读的字段（id/symbol/tokenAddress/swapBeginTime/
  // returnMax/features），跳过 arrays/rawCtx/rawSignal/rawCall/categorical 这些大头——
  // 那些是给策略回放/快照查看器用的完整原始快照，体积是 features 的几十倍以上，
  // 数学模型验证根本用不到，带上只会把导出文件撑到几百 MB。
  function exportRawDataJson() {
    if (!rows.length) { message.warning('还没有数据可导出'); return; }
    const slimRows = rows.map(r => ({
      id: r.id, symbol: r.symbol, tokenAddress: r.tokenAddress,
      swapBeginTime: r.swapBeginTime, returnMax: r.returnMax, features: r.features,
    }));
    const payload = {
      exportedAt: new Date().toISOString(),
      config: { threshold, cutoff, missingPolicy, scoreShape, fieldScope },
      rows: slimRows,
      factors,
      candidates: {
        hero: scan.visibleHeroCandidates || [],
        evil: scan.visibleEvilCandidates || [],
      },
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `factorlab_raw_${rows.length}行_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    message.success(`已导出 ${rows.length} 行精简数据（仅 id/symbol/tokenAddress/swapBeginTime/returnMax/features + 因子池/候选），可直接喂给 Node 脚本用 factorLab.js 原函数在内存中验证`);
  }

  const hasEvil = factors.some(f => f.camp === 'evil');
  const cutoffMin = hasEvil ? -100 : 0;
  // 推荐触发阈值：净超额命中数最大的档位（见 factorLab.js 里 recommendCutoff 的注释）
  const cutoffRecommend = useMemo(
    () => (backtest ? recommendCutoff(backtest.sweep) : null),
    [backtest]);
  function applyRecommendedCutoff() {
    if (!cutoffRecommend) { message.warning('样本不足，暂无法推荐阈值'); return; }
    setCutoff(cutoffRecommend.cut);
    message.success(`已设为推荐阈值 ${cutoffRecommend.cut}（触发 ${cutoffRecommend.triggered}，命中率 ${fmtPct(cutoffRecommend.hitRate)}，捕获率 ${fmtPct(cutoffRecommend.capture)}，lift ${cutoffRecommend.lift.toFixed(2)}）`);
  }

  // 任何会改变打分参数的操作都要把"下游背书"（OOS 结果 / 生成代码）作废，
  // 否则屏幕上会留着一份基于旧参数的验证结果给新参数站台
  const invalidateDownstream = () => { setOos(null); setRhoOpt(null); setTierGainOpt(null); };

  function changeThreshold(t) {
    setThreshold(t);
    invalidateDownstream();
  }

  // 因子发现（扫描/候选/勾选/边际ρ贡献/持久化排除）这一大块状态与逻辑收在 useFactorScan 里，
  // 详见该文件顶部注释。
  const scan = useFactorScan({
    rows, scopedFields, fieldScope, threshold, scoreShape, missingPolicy, cutoff,
    factors, setFactors, residualRows, invalidateDownstream, message,
  });
  const residualBase = useMemo(
    () => (scan.residualMode && residualRows ? baseStats(residualRows, threshold) : null),
    [scan.residualMode, residualRows, threshold]);

  // 从现有策略代码导入因子池：不用重新扫描/勾选，直接把这份代码里已经在打分的字段原样
  // 搬进因子权重表——权重/阵营原样保留（不跑 autoWeights，那会用 |AUC-0.5| 覆盖掉真实权重）。
  // 局限：checks 的 expect 文案只编码了核心区 [lo1,hi1]，硬界 lo0/hi0 没编码进去，这里按
  // 矩形（lo0=lo1, hi1=hi0）近似导入——等价于"区间命中"打分，进表后可以手工把过渡带拉开。
  function importFromStrategy() {
    if (!strategySrc.trim()) { message.warning('请先在下方粘贴现有策略代码'); return; }
    const compiled = compileStrategy(strategySrc);
    if (compiled.error) { message.error('策略代码编译失败：' + compiled.error); return; }
    // checks 的权重/核心区间对全部样本是常量（来自代码里的字面量），只需要找一条能跑通的样本
    // 取结构；contrib/missing 才逐行变化，这里用不到，不用跑全量样本。
    let sampleChecks = null;
    for (const row of rows) {
      if (!row.rawCtx) continue;
      const res = runStrategyOnRow(compiled, row);
      if (!res.error && Array.isArray(res.checks)) { sampleChecks = res.checks; break; }
    }
    if (!sampleChecks) { message.error('策略代码跑不出结果（样本缺原始 ctx，或全部样本都报错）'); return; }
    const parsed = sampleChecks.map(parseFactorCheck).filter(Boolean);
    if (!parsed.length) { message.warning('这份策略代码里没识别到打分因子（可能全是硬否决条件，没有"满分/危险区 ... 权重 w"格式的行）'); return; }
    const toNum = v => (v === '-Infinity' ? -Infinity : v === 'Infinity' ? Infinity : parseFloat(v));
    const imported = parsed.map(p => {
      const lo1 = toNum(p.coreLo), hi1 = toNum(p.coreHi);
      return { field: p.name, camp: p.camp,
        weight: Number.isFinite(p.weight) ? Math.abs(p.weight) : 1,
        lo0: lo1, lo1, hi1, hi0: hi1,
        auc: NaN, missRate: missingRate(rows, p.name), interval: null };
    });
    scan.resetScan();
    setFactors(imported);
    invalidateDownstream();
    message.success(`已导入 ${imported.length} 个打分因子（权重/阵营原样保留，核心区已还原，硬界暂按矩形近似）——可在下面因子表里手工调整或删除，也可以直接扫「残差」找漏网之鱼该补的字段。`);
  }

  // 按 field+camp 复合匹配，而不是只按 field：同一字段理论上可以同时在两个阵营各选一次
  // （不建议但不禁止），只按 field 匹配会让编辑/删除其中一个连带影响到另一个阵营的那份
  function editFactor(field, camp, patch) {
    setFactors(prev => prev.map(f => (f.field === field && f.camp === camp ? { ...f, ...patch } : f)));
    invalidateDownstream();
  }

  function removeFactor(f) {
    if (f.camp === 'evil') scan.setSelectedEvil(prev => prev.filter(x => x !== f.field));
    else scan.setSelectedHero(prev => prev.filter(x => x !== f.field));
    setFactors(prev => autoWeights(prev.filter(x => !(x.field === f.field && x.camp === f.camp))));
    invalidateDownstream();
  }

  // 分层秩相关配权：唯一的配权口径，不吃 cutoff——只按整体排序质量（自适应粗粒度分档，
  // 不要求逐点单调）配权。配完之后 cutoff 该用下面「推荐阈值」单独去定，不在这一步定。
  async function runBucketRhoOptimize() {
    setBucketRhoOptBusy(true);
    await new Promise(r => setTimeout(r, 0));
    try {
      const res = optimizeWeightsForBucketRho(rows, factors, { missingPolicy, winThreshold: threshold });
      if (res.error) { message.warning(res.error); setBucketRhoOpt(null); return; }
      setFactors(res.factors);
      invalidateDownstream();
      setBucketRhoOpt(res);
      const overfit = Number.isFinite(res.rhoTestAfter) && Number.isFinite(res.rhoTestBefore)
        && res.rhoTestAfter <= res.rhoTestBefore;
      if (overfit) message.warning('train 分层秩相关提升了，但 held-out test 没涨——可能过拟合，谨慎采用（可点「全部重置为自动」还原）');
      else message.success('已按分层秩相关写回权重，train / test 均见提升——现在可以点「推荐阈值」单独定 cutoff');
    } finally { setBucketRhoOptBusy(false); }
  }

  async function runOOS() {
    setOosBusy(true);
    await new Promise(r => setTimeout(r, 0));
    try {
      const fieldSpecs = [
        ...scan.selectedHero.map(field => ({ field, camp: 'hero' })),
        ...scan.selectedEvil.map(field => ({ field, camp: 'evil' })),
      ];
      const res = await runOOSBacktest(rows, fieldSpecs, threshold, { bootstrapB: 100, shape: scoreShape, missingPolicy });
      setOos(res);
      if (res.error) message.warning(res.error);
    } finally { setOosBusy(false); }
  }

  async function runReplay() {
    if (!strategySrc.trim()) { message.warning('请先粘贴现有策略代码'); return; }
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

  // 发送到策略：找因子只负责找因子，代码归策略。把当前因子池【整体替换】策略里的打分段
  // （保留硬否决段），权重照搬找因子的，CUTOFF 同步成当前触发阈值，然后跳到「策略」tab。
  function sendToStrategy() {
    if (!factors.length) { message.warning('因子池为空，先扫描并勾选因子'); return; }
    const res = replaceScoreRowsInAllChecks(strategySrc, factors, { cutoff });
    if (res.error) { message.error(res.error); return; }
    setStrategySrc(res.next);
    message.success(`已发送到策略：替换 ${res.removed} 条旧打分行 → 写入 ${res.inserted} 个因子`
      + (res.cutoffSynced ? `，CUTOFF 同步为 ${cutoff}` : '（策略里没找到 const CUTOFF，请手动设为 ' + cutoff + '）'));
    if (onGoToStrategy) onGoToStrategy();
  }

  // 候选表批量导出：制表符分隔，直接粘贴进 Excel/飞书表格能对齐成列，或整段发给 AI 帮忙挑因子。
  // 列（方向/coverage/CI 等挑因子必看项）由 lib/factorScanExport.js 统一拼，勇者/邪恶口径一致。
  // 只导出当前"过滤后"展示的那些行，跟表格里看到的一致。
  const exportOpts = () => ({
    getDesc: getFieldDesc, getMarginal: scan.getMarginal,
    meta: `因子扫描候选导出 · 高倍阈值=${threshold}x · 样本=${rows.length} · 字段范围=${fieldScope === 'original' ? '原字段' : '组装字段'}${scan.residualMode ? ' · 残差模式' : ''}`,
  });
  async function copyCandidateList(camp, list) {
    if (!list || !list.length) return;
    const { text, count } = buildCandidateExportTsv([{ camp, list }], exportOpts());
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制 ${count} 条候选（制表符分隔，可粘进表格或发给 AI 挑因子）`);
    } catch { message.error('复制失败，请手动从表格里选中复制'); }
  }
  // 一键导出两阵营全部过滤后候选（合并成一张表，最省事的"发我挑因子"入口）
  async function copyAllCandidates() {
    const camps = [
      { camp: 'hero', list: filteredHeroCandidates },
      { camp: 'evil', list: filteredEvilCandidates },
    ].filter(x => x.list && x.list.length);
    if (!camps.length) return;
    const { text, count } = buildCandidateExportTsv(camps, exportOpts());
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制两阵营共 ${count} 条候选（含方向/coverage/CI），粘给我即可挑因子`);
    } catch { message.error('复制失败，请手动从表格里选中复制'); }
  }

  // 不用 useMemo 缓存：列定义要闭包住当前这一份 scan.handleExcludeCandidate（引用了随渲染变化的
  // selectedHero/selectedEvil/scanHero/scanEvil），缓存住旧闭包会让"移除"按钮操作到过期的状态。
  const scanHeroColumns = makeScanColumns('hero', field => scan.handleExcludeCandidate('hero', field), scan.getMarginal);
  const scanEvilColumns = makeScanColumns('evil', field => scan.handleExcludeCandidate('evil', field), scan.getMarginal);
  // 候选表过滤：AUC 按偏离 0.5 的幅度筛（判别力，不分方向）；边际ρ贡献按【带符号】筛——只留
  // delta ≥ 阈值的正贡献候选（加进池子能提升 ρ 的才是该挑的；负贡献 = 加了反而拉低 ρ，不该留，
  // 哪怕它绝对值很大）。只在算过之后才生效（没算过时不该把整表清空——那只是"还没算"不是"不合格"）。
  // selectedSet：该阵营当前已勾选的字段。已选中的候选【永远保留】，不被任何过滤藏起来——
  // 否则它们从 dataSource 消失会连带让 AntD 裁掉受控选择、把因子从池子里弄丢（真实踩过的 bug）。
  // 而且边际ρ只对"未选中"的候选计算，已选中的 getMarginal 恒为 undefined，一过滤就必然被误杀。
  function applyCandFilter(list, selectedSet) {
    if (!list) return list;
    const q = candSearch.trim().toLowerCase();
    return list.filter(c => {
      // 搜索对所有行生效（含已选中）：显式"找某字段"时，不匹配的就该藏起来。字段名 + 中文含义都匹配。
      if (q && !(c.field.toLowerCase().includes(q) || (getFieldDesc(c.field) || '').toLowerCase().includes(q))) return false;
      if (selectedSet && selectedSet.has(c.field)) return true;   // 已选中 → 免受数值过滤，恒显示
      if (Math.abs((c.auc ?? 0.5) - 0.5) < candFilter.minAuc) return false;
      if (candFilter.minN > 0 && (!c.interval || c.interval.n < candFilter.minN)) return false;
      if (candFilter.minLift > 1 && !(c.interval && c.interval.lift >= candFilter.minLift)) return false;
      if ((c.missRate ?? 0) * 100 > candFilter.maxMissRate) return false;
      if (candFilter.minMarginal > 0 && scan.marginalRho) {
        const m = scan.getMarginal(c.field);
        if (!m || !Number.isFinite(m.delta) || m.delta < candFilter.minMarginal) return false;
      }
      return true;
    });
  }
  const filteredHeroCandidates = applyCandFilter(scan.visibleHeroCandidates, new Set(scan.selectedHero));
  const filteredEvilCandidates = applyCandFilter(scan.visibleEvilCandidates, new Set(scan.selectedEvil));
  const candFilterActive = candFilter.minAuc > 0 || candFilter.minN > 0 || candFilter.maxMissRate < 100
    || candFilter.minLift > 1 || candSearch.trim() !== '' || (candFilter.minMarginal > 0 && scan.marginalRho);

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

  // ---------- 分数 vs 倍数散点：聚合指标（命中率/lift/ρ）会掩盖分布形状，直接看点图更直观——
  // 高倍点（橙）是不是靠右堆、普通点（灰）是不是靠左堆，一眼就能看出，比读数字表格快。
  // Y 轴取对数：倍数天然右偏（1x~100x+ 跨两个数量级很正常），线性轴会把大部分点挤扁在底部。
  // 竖线=当前 cutoff，横线=高倍阈值——四个象限：右上=真正命中，左下=真正过滤掉，
  // 右下=过线但没高倍（虚耗），左上=没过线却是高倍（漏网之鱼，见下面"低分高倍复盘"卡片）。
  const scoreScatterFigure = useMemo(() => {
    if (!backtest) return null;
    const c = plotColors(!light);
    const pts = backtest.scored.filter(s => Number.isFinite(s.score) && Number.isFinite(s.row.returnMax) && s.row.returnMax > 0);
    const win = pts.filter(s => s.row.returnMax > threshold);
    const lose = pts.filter(s => s.row.returnMax <= threshold);
    const traces = [
      { x: lose.map(s => s.score), y: lose.map(s => s.row.returnMax), name: `普通（≤${threshold}x）`,
        type: 'scatter', mode: 'markers', marker: { color: '#8e8e93', size: 5, opacity: 0.55 } },
      { x: win.map(s => s.score), y: win.map(s => s.row.returnMax), name: `高倍（>${threshold}x）`,
        type: 'scatter', mode: 'markers', marker: { color: '#ff9f0a', size: 7, opacity: 0.85 } },
    ];
    // 分层秩相关吃的就是这些档：档命中率（不是中位数——中位数对右偏的倍数分布不敏感，一大坨
    // 低倍盘会把中位数钉死在差不多的位置，尾部涨多猛都感受不到，命中率才是"阈值右侧赚率"这个
    // 真实目标的直接体现）连成折线画在右轴上，是不是整体爬升、哪几档在打架（命中率比前一档还低），
    // 一眼就能看出，比只看一个 rho 数字直观。
    const rankBuckets = computeRankBuckets(pts.map(s => ({ score: s.score, ret: s.row.returnMax })), threshold);
    if (rankBuckets) {
      const bx = [], by = [];
      rankBuckets.buckets.forEach(b => {
        const mid = (b.loScore + b.hiScore) / 2;
        bx.push(mid); by.push(b.hitRate * 100);
      });
      traces.push({
        x: bx, y: by, name: `档命中率%（${rankBuckets.buckets.length} 档，分层秩相关用这个）`,
        type: 'scatter', mode: 'lines+markers', yaxis: 'y2',
        line: { color: '#bf5af2', width: 2 }, marker: { color: '#bf5af2', size: 6 },
      });
    }
    const layout = {
      height: 380, margin: { l: 56, r: 56, t: 24, b: 40 },
      paper_bgcolor: c.paperBg, plot_bgcolor: c.paperBg, font: { color: c.textColor, size: 12 },
      xaxis: { title: { text: '总分' }, ...c.axis },
      yaxis: { title: { text: '倍数（returnMax，对数轴）' }, type: 'log', ...c.axis },
      yaxis2: { title: { text: `档命中率%（>${threshold}x）` }, overlaying: 'y', side: 'right', rangemode: 'tozero', ...c.axis },
      shapes: [
        { type: 'line', x0: cutoff, x1: cutoff, y0: 0, y1: 1, yref: 'paper',
          line: { color: '#ff453a', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: threshold, y1: threshold,
          line: { color: '#30d158', width: 1, dash: 'dot' } },
      ],
      legend: { orientation: 'h', y: 1.1 },
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

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* 找因子操作指引（SOP）：默认折叠，把整套流程固化在页面，用户对着点即可 */}
      <FactorSopCard />
      {restoredNotice && (
        <Alert type="info" showIcon closable onClose={() => setRestoredNotice(false)}
          message={`已恢复上次进度：${factors.length} 个因子（含参数设置）。如果想从头开始，点右侧「清空重来」。`}
          action={<Button size="small" danger onClick={() => {
            clearFactorPoolState();
            setFactors([]); scan.resetScan();
            invalidateDownstream(); setRestoredNotice(false);
          }}>清空重来</Button>} />
      )}
      {/* 1. 阈值与总览 */}
      <Card id="fl-threshold" size="small" title="高倍阈值与样本总览"
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

      {/* 1.5 从现有策略导入因子池：不用从零扫描/勾选，直接把「策略」页那份代码里已经在
          打分的字段搬进来，权重/阵营原样保留，再用下面的因子表/残差模式修正或过滤它们。 */}
      <ImportStrategyCard strategySrc={strategySrc} setStrategySrc={setStrategySrc} onImport={importFromStrategy} />

      {/* 2. 因子发现：勇者阵营 + 邪恶阵营 两个候选池 */}
      <Card id="fl-discover" size="small" title="因子发现（勇者阵营找高倍集中区加分 · 邪恶阵营找输家集中区减分）"
        extra={<Space wrap>
          <Space size={4}>
            <Tooltip title={!backtest ? '先扫一遍全体样本、选几个因子建好打分池，才有"score<cutoff"这个残差子集可挖'
              : `残差子集：当前 ${cutoff} 分线下 ${residualBase ? residualBase.n : (residualRows ? residualRows.length : 0)} 个样本`}>
              <Segmented value={scan.residualMode ? 'residual' : 'all'} disabled={!backtest}
                onChange={v => scan.setResidualMode(v === 'residual')}
                options={[{ label: '全体样本', value: 'all' }, { label: '残差（漏网之鱼）', value: 'residual' }]} />
            </Tooltip>
            {!backtest && <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              （先在下方候选表勾选几个字段进因子池才能用）</Typography.Text>}
          </Space>
          <Segmented value={fieldScope} onChange={v => setFieldScope(v)}
            options={[{ label: '原字段', value: 'original' }, { label: '组装字段', value: 'assembled' }]} />
          <Button type="primary" loading={scan.scanBusy} disabled={!rows.length || !scopedFields.length}
            onClick={scan.runScan}>
            扫描 {scopedFields.length} 个{fieldScope === 'original' ? '原' : '组装'}字段（两阵营{scan.residualMode ? '·残差' : ''}）
          </Button>
          <Tooltip title='逐个把候选字段临时并入当前因子池，看分层秩相关（自适应粗粒度分档、档内看命中率，不吃cutoff）的变化——挑因子固定用这个口径，不再区分策略用途。'>
            <Button loading={scan.marginalBusy} disabled={!scan.scanHero && !scan.scanEvil}
              onClick={scan.runMarginalRho}>计算候选分层秩相关贡献</Button>
          </Tooltip>
        </Space>}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          两个阵营各自独立扫描：<b>勇者阵营</b>挖"高倍盘集中的取值区间"，命中 = 好迹象、加分；
          <b>邪恶阵营</b>挖"输家（未达高倍阈值）集中的取值区间"，命中 = 危险迹象、减分。
          两边都复用同一套 AUC + 区间挖掘算法（lift/捕获率评分口径一致，只是目标类从"赢"换成"输"）。
          「原字段」是数据源直接给的、能映射回实盘 ctx 进生成代码；「组装字段」是本工具聚合/派生的，
          仅供探索审核，无法进入生成代码。
        </Typography.Paragraph>
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message={<b>残差模式怎么用</b>}
          description={
            <ol style={{ margin: '4px 0 0', paddingInlineStart: 18, fontSize: 12 }}>
              <li>先用「全体样本」扫一遍、勾几个候选字段建好因子池，下面「回测」卡片会给出打分。</li>
              <li>切到「残差（漏网之鱼）」——这时候扫描/挖区间只在 score &lt; {cutoff} 的子集（也就是「低分高倍复盘」
                卡片里那批漏网之鱼 + 同分段的真输家）里做，不再被已经打对的大多数样本稀释。</li>
              <li>候选表里边际ρ贡献高的字段就是"这批漏网之鱼跟同子集里的真输家相比，明显不一样"的地方——
                勾选并入因子池，区间/梯形边界会用残差子集校准，更贴合这批漏网之鱼。</li>
              <li>因子池更新后打分仍在<b>全体样本</b>上计算（不是只对残差子集打分），时间外推验证也仍按全体样本切分。</li>
            </ol>
          } />
        {scan.residualMode && backtest && (!residualRows || !residualRows.length) && (
          <Alert style={{ marginBottom: 12 }} type="warning" showIcon
            message={`当前 ${cutoff} 分线下没有样本（全部样本都已过线），残差模式无字段可扫，调低触发阈值或换个因子池再试。`} />)}
        {fieldScope === 'assembled' && <Alert style={{ marginBottom: 12 }} type="info" showIcon
          message="组装字段是工具从快照聚合/派生出来的，实盘 ctx 里没有对应值——回测发现的规律需要你人工审核认可后，再想办法在实盘侧复刻计算，不能直接生成代码。" />}
        {scan.staleScan && <Alert style={{ marginBottom: 12 }} type="warning" showIcon
          message={scan.scanScope !== fieldScope
            ? `扫描结果是「${scan.scanScope === 'original' ? '原字段' : '组装字段'}」范围的，当前已切到「${fieldScope === 'original' ? '原字段' : '组装字段'}」，请重新扫描。`
            : scan.scanResidual !== scan.residualMode
            ? `扫描结果是在「${scan.scanResidual ? '残差子集' : '全体样本'}」上算的，当前已切到「${scan.residualMode ? '残差子集' : '全体样本'}」，请重新扫描。`
            : `扫描结果是在 ${scan.scanThreshold}x 阈值下算的，当前已切到 ${threshold}x，请重新扫描。`} />}
        {scan.scanResidual && (scan.scanHero || scan.scanEvil) && !scan.staleScan && (() => {
          const scanBase = scan.scanRowsUsed ? baseStats(scan.scanRowsUsed, threshold) : null;
          const tooFewWinners = scanBase && scanBase.pos < 5;
          return <>
            <Alert style={{ marginBottom: tooFewWinners ? 8 : 12 }} type="info" showIcon
              message={`当前候选表基于残差子集（score<${cutoff}，n=${scan.scanRowsUsed ? scan.scanRowsUsed.length : '-'}，其中高倍盘 ${scanBase ? scanBase.pos : '-'} 个）计算的 AUC/区间，不代表全局统计量。`} />
            {tooFewWinners && (
              <Alert style={{ marginBottom: 12 }} type="warning" showIcon
                message={`残差子集里只有 ${scanBase.pos} 个高倍盘（区间挖掘至少需要 5 个才会给出结果）——大部分字段显示"区间：无"是这个原因，不是字段本身没信号。
                  ${scanBase.pos === 0 ? '当前因子池可能已经把这批全部漏网之鱼都排除在"高倍"之外了（即高倍盘全部已经过线，残差里全是真输家），残差挖掘在这个 cutoff 下已经挖不出新东西。' : '可以调高触发阈值 cutoff 把更多样本纳入残差子集再试，或换个阈值/因子池。'}`} />
            )}
          </>;
        })()}
        {scan.marginalStale && <Alert style={{ marginBottom: 12 }} type="warning" showIcon
          message="因子池/打分方式/缺失口径/阈值已变化，「边际ρ贡献」列是旧结果，请重新计算。" />}

        {(scan.scanHero || scan.scanEvil) && (
          <Space wrap size={12} style={{ marginBottom: 12, padding: '8px 12px', background: 'rgba(127,127,127,.08)', borderRadius: 6 }}>
            <Typography.Text style={{ fontSize: 12, opacity: .65 }}>候选表过滤（只影响展示，不影响勾选）：</Typography.Text>
            <Input allowClear size="small" placeholder="搜字段名/含义" style={{ width: 180 }}
              value={candSearch} onChange={e => setCandSearch(e.target.value)} />
            <Space size={4}><span style={{ fontSize: 12 }}>AUC 偏离 ≥</span>
              <InputNumber size="small" min={0} max={0.5} step={0.01} style={{ width: 70 }}
                value={candFilter.minAuc} onChange={v => setCandFilter(f => ({ ...f, minAuc: v || 0 }))} /></Space>
            <Tooltip title={!scan.marginalRho ? '先点「计算候选分层秩相关贡献」才能按这个筛' : '只保留边际贡献 ≥ 该值的候选（正贡献=加进池子能提升排序信息量）。负贡献会被挡掉，哪怕绝对值大。设 0 = 显示全部（含负贡献）'}>
              <Space size={4}><span style={{ fontSize: 12 }}>边际分层秩相关贡献 ≥</span>
                <InputNumber size="small" min={0} max={1} step={0.005} style={{ width: 70 }} disabled={!scan.marginalRho}
                  value={candFilter.minMarginal} onChange={v => setCandFilter(f => ({ ...f, minMarginal: v || 0 }))} /></Space>
            </Tooltip>
            <Tooltip title="只保留 lift ≥ 该值的候选（lift=区间内高倍率/基准，>1 才有区分度）。设 1 = 显示全部。注意 lift 要和捕获率/显著性/边际ρ 一起看，别只看 lift。">
              <Space size={4}><span style={{ fontSize: 12 }}>lift ≥</span>
                <InputNumber size="small" min={1} max={5} step={0.05} style={{ width: 70 }}
                  value={candFilter.minLift} onChange={v => setCandFilter(f => ({ ...f, minLift: v || 1 }))} /></Space>
            </Tooltip>
            <Space size={4}><span style={{ fontSize: 12 }}>区间 n ≥</span>
              <InputNumber size="small" min={0} step={5} style={{ width: 70 }}
                value={candFilter.minN} onChange={v => setCandFilter(f => ({ ...f, minN: v || 0 }))} /></Space>
            <Space size={4}><span style={{ fontSize: 12 }}>缺失率 ≤</span>
              <InputNumber size="small" min={0} max={100} step={5} style={{ width: 70 }} suffix="%"
                value={candFilter.maxMissRate} onChange={v => setCandFilter(f => ({ ...f, maxMissRate: v ?? 100 }))} /></Space>
            {candFilterActive && <Button size="small" onClick={() => { setCandFilter({ minAuc: 0, minMarginal: 0, minLift: 1, minN: 0, maxMissRate: 100 }); setCandSearch(''); }}>清空过滤</Button>}
            <Tooltip title="把两阵营当前过滤后的全部候选（含方向/coverage/CI/边际ρ）复制成一张表，粘给 AI 帮忙挑因子。想让边际ρ也带上，先点上面「计算候选边际ρ贡献」。">
              <Button size="small" type="primary" ghost
                disabled={!filteredHeroCandidates.length && !filteredEvilCandidates.length}
                onClick={copyAllCandidates}>📋 导出全部候选（发我挑因子）</Button>
            </Tooltip>
          </Space>
        )}

        {scan.scanHero && (
          <>
            <Space align="center" style={{ marginBottom: 6 }}>
              <Typography.Text strong style={{ fontSize: 12 }}>
                🛡 勇者阵营候选（{scan.visibleHeroCandidates.length} 个可用
                {candFilterActive ? `，过滤后 ${filteredHeroCandidates.length} 个` : ''} / 跳过 {scan.scanHero.skipped.length} 个）
              </Typography.Text>
              {scan.excludedHero.length > 0 && (
                <Typography.Link style={{ fontSize: 12 }}
                  onClick={() => scan.setShowExcluded(s => ({ ...s, hero: !s.hero }))}>
                  已移除 {scan.excludedHero.length} 个（{scan.showExcluded.hero ? '收起' : '查看/恢复'}）
                </Typography.Link>
              )}
              <Button size="small" type="text" disabled={!filteredHeroCandidates.length}
                onClick={() => copyCandidateList('hero', filteredHeroCandidates)}>复制候选清单</Button>
            </Space>
            {scan.showExcluded.hero && (
              <div style={{ marginBottom: 8 }}>
                <Space wrap size={4}>
                  {scan.excludedHero.map(x => (
                    <Tag key={x.field} closable onClose={() => scan.handleUnexcludeCandidate('hero', x.field)}>
                      {x.field}
                    </Tag>
                  ))}
                </Space>
              </div>
            )}
            <Table style={{ marginTop: 6, marginBottom: 16 }} size="small" rowKey="field"
              columns={scanHeroColumns} dataSource={filteredHeroCandidates}
              rowSelection={{
                selectedRowKeys: scan.selectedHero,
                onChange: keys => { scan.setSelectedHero(keys); scan.rebuildFactors(scan.scanHero, scan.scanEvil, keys, scan.selectedEvil, factors); },
                getCheckboxProps: r => ({ disabled: !r.interval }),
                preserveSelectedRowKeys: true,   // 搜索/过滤把已选行移出 dataSource 时，选择不被裁掉，因子不丢
              }}
              scroll={{ x: 1200, y: 320 }} pagination={{ pageSize: 20, size: 'small' }} />
          </>
        )}
        {scan.scanEvil && (
          <>
            <Space align="center" style={{ marginBottom: 6 }}>
              <Typography.Text strong style={{ fontSize: 12 }}>
                ☠ 邪恶阵营候选（{scan.visibleEvilCandidates.length} 个可用
                {candFilterActive ? `，过滤后 ${filteredEvilCandidates.length} 个` : ''} / 跳过 {scan.scanEvil.skipped.length} 个）
              </Typography.Text>
              {scan.excludedEvil.length > 0 && (
                <Typography.Link style={{ fontSize: 12 }}
                  onClick={() => scan.setShowExcluded(s => ({ ...s, evil: !s.evil }))}>
                  已移除 {scan.excludedEvil.length} 个（{scan.showExcluded.evil ? '收起' : '查看/恢复'}）
                </Typography.Link>
              )}
              <Button size="small" type="text" disabled={!filteredEvilCandidates.length}
                onClick={() => copyCandidateList('evil', filteredEvilCandidates)}>复制候选清单</Button>
            </Space>
            {scan.showExcluded.evil && (
              <div style={{ marginBottom: 8 }}>
                <Space wrap size={4}>
                  {scan.excludedEvil.map(x => (
                    <Tag key={x.field} closable onClose={() => scan.handleUnexcludeCandidate('evil', x.field)}>
                      {x.field}
                    </Tag>
                  ))}
                </Space>
              </div>
            )}
            <Table style={{ marginTop: 6 }} size="small" rowKey="field"
              columns={scanEvilColumns} dataSource={filteredEvilCandidates}
              rowSelection={{
                selectedRowKeys: scan.selectedEvil,
                onChange: keys => { scan.setSelectedEvil(keys); scan.rebuildFactors(scan.scanHero, scan.scanEvil, scan.selectedHero, keys, factors); },
                getCheckboxProps: r => ({ disabled: !r.interval }),
                preserveSelectedRowKeys: true,   // 同上：搜索/过滤不影响已勾选因子
              }}
              scroll={{ x: 1200, y: 320 }} pagination={{ pageSize: 20, size: 'small' }} />
          </>
        )}
        {/* 因子推荐：贪心前向 + held-out 边际ρ。两模式：基于当前池(动态) / 从零探索 */}
        {(scan.scanHero || scan.scanEvil) && (
          <FactorRecommendCard rows={rows} factors={factors} threshold={threshold}
            missingPolicy={missingPolicy} scoreShape={scoreShape} onAdopt={adoptRecommended}
            candidates={[...(scan.visibleHeroCandidates || []), ...(scan.visibleEvilCandidates || [])]} />
        )}
      </Card>

      {/* 3. 因子权重（可编辑） */}
      {factors.length > 0 && (
        <Card id="fl-weights" size="small" title={`因子权重（${factors.length} 个，可编辑）`}
          extra={<Space>
            <Typography.Text type={Math.abs(weightSum - 100) > 0.5 ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
              权重合计 {weightSum.toFixed(1)}{Math.abs(weightSum - 100) > 0.5 ? '（≠100，总分会按合计归一）' : ''}
            </Typography.Text>
            <Segmented size="small" value={scoreShape}
              options={[{ label: '梯形', value: 'trap' }, { label: '区间命中', value: 'interval' }]}
              onChange={v => { setScoreShape(v); if (scan.scanHero || scan.scanEvil) scan.rebuildFactors(scan.scanHero, scan.scanEvil, scan.selectedHero, scan.selectedEvil, [], v); }} />
            <Segmented size="small" value={missingPolicy}
              options={[{ label: '缺失记0分', value: 'zero' }, { label: '缺失重归一', value: 'renorm' }]}
              onChange={v => { setMissingPolicy(v); invalidateDownstream(); }} />
            <Tooltip title='唯一的配权口径——不吃 cutoff，只要求自适应粗粒度分档递增（不要求逐点单调；档大小固定至少15，命中率低时按期望命中数≥3自适应放大，避免小分桶下命中率方差太大；档内统计量用命中率而不是中位数——中位数对右偏的倍数分布不敏感，尾部涨得再猛也感受不到）。目标值 = 「档序号 vs 档命中率」的 spearman × (1−饱和度惩罚，防桶间排对/桶内一锅粥) × (1−锯齿惩罚，防桶间大体排对/局部反复倒挂——就是散点图紫线看着一路跳水那种)。搜非负权重让这个目标值最大（前 70% 拟合、后 30% 验证），会把对分档排序无贡献/有害的因子权重压到 0。配完权重后，点右边「推荐阈值」单独定 cutoff，不要先猜 cutoff 再配权。'>
              <Button size="small" type="primary" ghost loading={bucketRhoOptBusy}
                disabled={factors.length < 2 || !rows.length}
                onClick={runBucketRhoOptimize}>🎯 按分层秩相关配权</Button>
            </Tooltip>
            <Button size="small" onClick={() => (scan.scanHero || scan.scanEvil) && scan.rebuildFactors(scan.scanHero, scan.scanEvil, scan.selectedHero, scan.selectedEvil, [])}>全部重置为自动</Button>
            <Tooltip title="把当前因子池整体替换到「策略」tab 的打分段（保留硬否决段、CUTOFF 同步当前触发阈值），然后跳到策略 tab。前提：策略里有 ALL_CHECKS+VETO_NAMES 基础策略。">
              <Button size="small" type="primary" onClick={sendToStrategy}>发送到策略 →</Button>
            </Tooltip>
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
            权重自动按区间打分（Wilson下界×√coverage，区间感知，不假设方向单调）分配，可手工调整；
            点「🎯 按分层秩相关配权」直接优化排序质量（不吃 cutoff，配完权重后用「推荐阈值」单独定 cutoff——先排序、再从排序里读 cutoff，不要反过来）。
            切换打分方式会按新方式重新推导边界（手工编辑会被重置）。
          </Typography.Paragraph>
          {bucketRhoOpt && (() => {
            const fmt = v => (Number.isFinite(v) ? v.toFixed(3) : '—');
            const dTrain = bucketRhoOpt.rhoTrainAfter - bucketRhoOpt.rhoTrainBefore;
            const dTest = bucketRhoOpt.rhoTestAfter - bucketRhoOpt.rhoTestBefore;
            const testUp = Number.isFinite(dTest) && dTest > 0;
            return (
              <Alert style={{ marginBottom: 12 }} type={testUp ? 'success' : 'warning'} showIcon
                message={<span style={{ fontSize: 12 }}>
                  🎯 分层秩相关配权结果（北极星例外口径②(推荐) = 档序号↔档命中率的 Spearman，不吃 cutoff）：
                  <b> train</b> {fmt(bucketRhoOpt.rhoTrainBefore)} → {fmt(bucketRhoOpt.rhoTrainAfter)}（{dTrain >= 0 ? '+' : ''}{fmt(dTrain)}），
                  <b> held-out test</b> {fmt(bucketRhoOpt.rhoTestBefore)} → {fmt(bucketRhoOpt.rhoTestAfter)}（{dTest >= 0 ? '+' : ''}{fmt(dTest)}）
                  <Typography.Text type="secondary">　train {bucketRhoOpt.nTrain} / test {bucketRhoOpt.nTest} 条</Typography.Text>
                </span>}
                description={<span style={{ fontSize: 12 }}>
                  {testUp
                    ? 'test 也涨 = 排序质量真实提升，可放心采用——接下来点右上角「推荐阈值」单独定 cutoff，不要用旧 cutoff。'
                    : '⚠️ 只有 train 涨、held-out test 没涨 —— 大概率过拟合。别急着用，考虑减因子或点「全部重置为自动」还原。'}
                  {bucketRhoOpt.zeroedFields.length > 0 && <>　被压到 0（对分档排序无贡献或有害，建议删）：{bucketRhoOpt.zeroedFields.map(f => <code key={f} style={{ fontSize: 11, marginLeft: 4 }}>{f}</code>)}</>}
                </span>} />
            );
          })()}
          {/* 去冗余检查：始终有态——有高相关对就橙色告警二选一；没有就给绿色"无冗余"确认，
              避免"告警不出现"让人分不清是"没冗余(好)"还是"功能没了"。需 ≥2 个因子才有意义。 */}
          {factors.length >= 2 && (
            factorCorrHigh.length > 0 ? (
              <Alert style={{ marginBottom: 12 }} type="warning" showIcon
                message={<span style={{ fontSize: 12 }}>
                  🔁 去冗余：以下因子高度相关（|Spearman ρ|≥0.7），同一份信息在重复计分——建议二选一（留边际ρ更高的）或手动降权：
                  {factorCorrHigh.map((c, i) => (
                    <div key={i} style={{ paddingLeft: 8 }}>
                      · <code style={{ fontSize: 11 }}>{c.a}</code> ↔ <code style={{ fontSize: 11 }}>{c.b}</code>
                      　ρ={c.rho.toFixed(2)}（n={c.n}）
                    </div>
                  ))}
                </span>} />
            ) : (
              <Alert style={{ marginBottom: 12 }} type="success" showIcon
                message={<span style={{ fontSize: 12 }}>
                  ✓ 去冗余检查：已选 {factors.length} 个因子两两 |Spearman ρ| 均 &lt; 0.7，无重复计分。
                  {factorCorr.length > 0 && <>相关性最高的几对：
                    {factorCorr.slice(0, 3).map((c, i) => (
                      <span key={i}>{i > 0 ? '；' : ' '}
                        <code style={{ fontSize: 11 }}>{c.a}</code>↔<code style={{ fontSize: 11 }}>{c.b}</code> ρ={c.rho.toFixed(2)}</span>
                    ))}。</>}
                </span>} />
            ))}
          {/* rowKey 用 camp+field 复合键：同一字段理论上可以被两个阵营各选一次（不建议但不禁止），
              纯按 field 当 key 会撞车，导致 AntD/React 拿错行的渲染状态 */}
          <Table size="small" rowKey={f => f.camp + ':' + f.field} columns={factorColumns} dataSource={factors}
            scroll={{ x: 1080 }} pagination={false} />
        </Card>)}

      {/* 4. 回测 */}
      {backtest && (
        <Card id="fl-backtest" size="small" title="回测"
          extra={<Space size={16}>
            <span style={{ fontSize: 12, opacity: .65 }}>触发阈值</span>
            <Slider style={{ width: 180 }} min={cutoffMin} max={100} value={cutoff}
              onChange={v => setCutoff(v)} />
            <InputNumber size="small" min={cutoffMin} max={100} value={cutoff}
              onChange={v => setCutoff(v ?? 0)} />
            <Tooltip title={cutoffRecommend
              ? `在触发数≥样本量5%（且≥20）的档位里，挑净超额命中数（触发数×(命中率−基准命中率)）最大的一档：cut=${cutoffRecommend.cut}，触发 ${cutoffRecommend.triggered}，命中率 ${fmtPct(cutoffRecommend.hitRate)}，捕获率 ${fmtPct(cutoffRecommend.capture)}，lift ${cutoffRecommend.lift.toFixed(2)}`
              : '样本不足，暂无法推荐'}>
              <Button size="small" onClick={applyRecommendedCutoff} disabled={!cutoffRecommend}>
                🎯 推荐阈值{cutoffRecommend ? `（${cutoffRecommend.cut}）` : ''}
              </Button>
            </Tooltip>
            <Tooltip title="把配置/因子池/去冗余/北极星ρ最优配权结果/当前回测/cutoff扫描/分段表/时间外推/漏网之鱼 + 诊断清单，拼成一份 markdown 复制到剪贴板，直接粘给 AI 让它诊断调试。">
              <Button size="small" type="primary" ghost onClick={exportBacktestReport}>📋 导出报告（喂 AI）</Button>
            </Tooltip>
            <Tooltip title="导出原始样本数据 JSON（rows + 当前因子池 + 候选 + 配置），跟 buildRows() 产出的形状完全一致——可以直接在 Node 里 import factorLab.js 重放 scoreRows/recommendFactorPath/computeRankBuckets 等原函数，在内存中验证方案，不用等实现完再回测。">
              <Button size="small" onClick={exportRawDataJson}>💾 导出原始数据（供内存验证）</Button>
            </Tooltip>
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
          {scoreScatterFigure && (<>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
              分数 vs 倍数散点（Y 轴对数）：橙=高倍（{'>'}{threshold}x），灰=普通；红竖线=当前 cutoff，绿虚横线=高倍阈值；
              紫线（右轴，%）=分层秩相关实际用的档命中率（每档≥15条、且按整体命中率自适应放大保证期望命中数≥3，同分不跨档；
              命中率比中位数更贴近"高倍捕获"这个真实目标——中位数会被一大坨普通盘钉死，涨得再猛也感受不到）。
              紫线整体爬升=分层单调，某几档比前一档还低=打架（分层秩相关会因此打折）。高倍点是否靠右堆、有没有大量橙点落在竖线左侧（漏网），一眼可看。
            </Typography.Text>
            <PlotlyChart traces={scoreScatterFigure.traces} layout={scoreScatterFigure.layout} height={380} />
          </>)}
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

      {/* 4.5 低分高倍复盘（漏网之鱼）：score < cutoff 却真的翻倍的样本，逐个看因子命中明细 */}
      {backtest && (
        <MissedRowsCard missedRows={missedRows} factors={factors} threshold={threshold}
          cutoff={cutoff} onCopy={copyMissedCAs} />)}

      {/* 5. 对比现有硬门槛策略 */}
      {backtest && (
        <CompareHardGateCard strategySrc={strategySrc} setStrategySrc={setStrategySrc}
          replayBusy={replayBusy} onReplay={runReplay} replay={replay} compare={compare}
          threshold={threshold} cutoff={cutoff} />)}

      {/* 6. 发送到策略：找因子只找因子，代码归策略 */}
      {factors.length > 0 && (
        <Card id="fl-send" size="small" title="发送到策略"
          extra={<Button type="primary" onClick={sendToStrategy}>
            按当前因子池发送（CUTOFF 同步 {cutoff}）</Button>}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            把当前 <b>{factors.length}</b> 个因子（权重照搬 ρ最优/手调后的、区间为挖出的梯形）
            <b>整体替换</b>「策略」tab 里的打分段——策略的<b>硬否决条件（VETO_NAMES）原样保留</b>，
            CUTOFF 同步成当前触发阈值 {cutoff}，然后自动跳到「策略」tab。
            代码只在策略侧生成一处（上线走「生成上线代码」的 f 垫片）。
            <br />前提：策略里要有一份 <code>ALL_CHECKS + VETO_NAMES</code> 架构的基础策略（含你的硬否决段）；
            没有的话先在「策略」tab 放一份。
          </Typography.Paragraph>
        </Card>)}
    </Space>
  );
}
