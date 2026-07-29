import React, { useEffect, useMemo, useState } from 'react';
import { Card, Button, Table, Tag, Tooltip, Typography, Space, Segmented, Alert,
         InputNumber, Slider, Input, Select, Statistic, Row, Col, Popconfirm, App as AntApp } from 'antd';
import PlotlyChart from './PlotlyChart.jsx';
import { getFieldDesc } from '../lib/dictionary.js';
import { formatNumberSmart } from '../lib/utils.js';
import { plotColors } from '../theme.js';
import { compileStrategy, runStrategyOnRow, parseFactorCheck } from '../lib/proAnalytics.js';
import {
  FACTOR_WIN_THRESHOLDS, DEFAULT_FACTOR_WIN_THRESHOLD,
  autoWeights, optimizeWeightsForRho, baseStats, backtestFactors, runWalkForwardBacktest, assessSplitDecay,
  compareGroupsAgainstBaseline, compareWithHardGate,
  classifyFieldOrigin, factorCorrelations, recommendCutoff,
  missingRate, permutationPValue, resolveCtxAccessor,
} from '../lib/factorLab.js';
import { auditMcapCoupling } from '../lib/fieldAudit.js';
import { FIELD_TO_BLOCK } from '../lib/onlineExport.js';
import { selectRowsBySlice, dayOf, UNKNOWN_DAY, strategyOf, groupRowsByStrategyAndDay } from '../lib/dataSlices.js';
import { replaceScoreRowsInAllChecks } from '../lib/campLibrary.js';
import { loadFactorPoolState, saveFactorPoolState, clearFactorPoolState } from '../lib/factorPoolStore.js';
import { buildCandidateExportTsv } from '../lib/factorScanExport.js';
import { buildBacktestReport, buildWalkForwardReport, buildBaselineVsTrainReport, buildRecommendPathReport } from '../lib/backtestReportExport.js';
import ImportStrategyCard from './factorLab/ImportStrategyCard.jsx';
import FactorSopCard from './factorLab/FactorSopCard.jsx';
import MissedRowsCard from './factorLab/MissedRowsCard.jsx';
import FactorRecommendCard from './factorLab/FactorRecommendCard.jsx';
import CompareHardGateCard from './factorLab/CompareHardGateCard.jsx';
import { useFactorScan } from './factorLab/useFactorScan.js';

// 字段范围三档：original=只扫原字段（能进生成代码）；assembled=只扫组装/派生字段（仅供探索）；
// all=两者一起扫（组装字段命中的规律仍需人工在实盘侧复刻，进不了生成代码）。
const FIELD_SCOPE_LABEL = { original: '原字段', assembled: '组装字段', all: '全部字段' };
const fmtPct = v => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-');
const fmtBound = v => (v === -Infinity ? '-∞' : v === Infinity ? '∞' : formatNumberSmart(v));
const fmtInterval = iv => iv ? `[${fmtBound(iv.lo)}, ${fmtBound(iv.hi)})` : '-';

// 勇者/邪恶两阵营共用的候选字段表列；差异点（区间/lift/捕获率的措辞、是否显示 AUC 方向）
// 按 camp 参数切换文案——底层数据结构（interval.lo/hi/lift/coverage/n）完全一样，
// 邪恶阵营的 interval 只是换成了"输家集中区"（findColdInterval 的结果），不是另一套字段。
// onExclude(field)：把这个字段标记成"不适合该阵营"，持久化排除——以后扫描/勾选都不再出现，
// 跟"删除已选因子"（removeFactor，只是取消这次勾选）是两回事，这个是更强的"判定"。
// getMarginal(field) -> undefined（未算）| { error } | computeHeldOutDeltaRho 的返回值
//   { deltaTrain, deltaTest, baselineTrain/Test, withTrain/Test, nTrain, nTest }——
//   展示的主数字固定是 deltaTest（held-out 增量），deltaTrain 只用来标过拟合。
// permNull：边际ρ 的置换零分布（scan.permNull），有就给每个候选的边际ρ 配一个经验 p 值
// （"纯噪声凑出这么大增量的概率"）；没算过就只显示增量本身。
function makeScanColumns(camp, onExclude, getMarginal, permNull) {
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
    title: <Tooltip title='held-out 边际ρ：把该字段并进当前因子池（自动配权）后，验证段 spearman(score, returnMax) 相比不加它的增量。梯形边界只在训练段推、增量只在验证段读，所以这个数已经扣掉了"边界是照着这批样本挖出来的"那层水分——挑因子固定看这个。括号里的 train 是同一次评估的训练段增量，只用来看背离（train 涨、test 不涨 = 过拟合）。'>
      边际ρ<span style={{ opacity: .6 }}>(test)</span></Tooltip>,
    width: 106, align: 'right',
    sorter: (a, b) => {
      // 带 camp 取：同一字段两个阵营各有一份边际贡献，只按字段名取会串表（见 useFactorScan 的 getMarginal）
      const ma = getMarginal(a.field, camp), mb = getMarginal(b.field, camp);
      const v = m => (Number.isFinite(m?.deltaTest) ? m.deltaTest : -Infinity);
      return v(ma) - v(mb);
    },
    render: (_, r) => {
      const m = getMarginal(r.field, camp);
      if (!m) return <Typography.Text type="secondary" style={{ fontSize: 11 }}>未算</Typography.Text>;
      if (m.error) return <Tooltip title={m.error}><Typography.Text type="secondary" style={{ fontSize: 11 }}>-</Typography.Text></Tooltip>;
      if (!Number.isFinite(m.deltaTest)) return <Typography.Text type="secondary" style={{ fontSize: 11 }}>-</Typography.Text>;
      const sign = m.deltaTest > 0 ? '+' : '';
      // 经验 p 值：这个增量在"打乱 returnMax 后重跑整条流水线"的零分布里排第几。
      // 零分布量的也是 deltaTest（见 permutationNullMarginalRho），两边同一把尺子。
      const p = permNull && !permNull.error ? permutationPValue(permNull, m.deltaTest) : NaN;
      // train 涨、test 不涨 = 这个候选的贡献只存在于用来推边界的那批样本里，典型过拟合
      const overfit = Number.isFinite(m.deltaTrain) && m.deltaTrain > 0.005 && m.deltaTest <= 0;
      const fmtD = v => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(3) : '-');
      return <Tooltip title={`验证段 ρ ${Number.isFinite(m.baselineTest) ? m.baselineTest.toFixed(3) : '-'} → ${Number.isFinite(m.withTest) ? m.withTest.toFixed(3) : '-'}（n=${m.nTest}）`
        + `；训练段 Δ=${fmtD(m.deltaTrain)}（n=${m.nTrain}）`
        + (overfit ? '；train 涨 test 不涨 = 贡献只存在于推边界的那批样本里，别要' : '')
        + (Number.isFinite(p) ? `；置换零分布经验 p=${p.toFixed(3)}（噪声凑出 ≥ 这个增量的比例）` : '')}>
        <div style={{ lineHeight: 1.3 }}>
          <span style={{ color: m.deltaTest > 0 ? '#30d158' : m.deltaTest < 0 ? '#ff453a' : undefined, fontSize: 11 }}>
            {sign}{m.deltaTest.toFixed(3)}
          </span>
          {overfit && <span style={{ fontSize: 10, color: '#ff9f0a', marginLeft: 3 }}>⚠</span>}
          <div style={{ fontSize: 10, opacity: .55 }}>
            train {fmtD(m.deltaTrain)}
            {Number.isFinite(p) && <span style={{ marginLeft: 4, color: p < 0.05 ? '#30d158' : undefined }}>p={p.toFixed(2)}</span>}
          </div>
        </div>
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
    { title: <Tooltip title='该字段与【进场市值】的 spearman ρ。returnMax = max_mcap / initial_mcap，分母就是进场市值——|ρ| 越大，这个字段越可能只是进场市值的影子，它那点预测力其实是"小盘天生更容易翻倍"借给它的，不是新规律。左边字段名上的「市值同源」标记只按名字认，这一列是数据驱动的补充，能抓到名字上看不出来的（总供应量、流动性、持有人数这类跟盘子大小同涨同落的字段）。'>与市值ρ</Tooltip>,
      width: 88, align: 'right',
      sorter: (a, b) => Math.abs(a.mcapRho ?? 0) - Math.abs(b.mcapRho ?? 0),
      render: (_, r) => {
        if (!Number.isFinite(r.mcapRho)) return <Typography.Text type="secondary" style={{ fontSize: 11 }}>-</Typography.Text>;
        const a = Math.abs(r.mcapRho);
        return <Tooltip title={a >= 0.5 ? '与进场市值高度相关，基本就是市值的另一种写法' : a >= 0.3 ? '与进场市值有明显相关，效果里掺着小盘效应' : ''}>
          <span style={{ fontSize: 11, color: a >= 0.5 ? '#ff453a' : a >= 0.3 ? '#ff9f0a' : undefined }}>{r.mcapRho.toFixed(2)}</span>
        </Tooltip>;
      } },
    { title: '', width: 70, render: (_, r) => (
      <Button size="small" type="text" danger onClick={() => onExclude(r.field)}>移除</Button>) },
  );
  return cols;
}

export default function FactorLab({ rows, fields, light, archiveAllRows, archiveSliceCats, strategyCode, onStrategyCodeChange, onGoToStrategy }) {
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
  // minMarginal 默认 0.005：算过边际ρ后自动只留"加进池子能提升【验证段】ρ（正贡献）"的候选——挑因子的口径。
  // 算之前该过滤不生效（下面 applyCandFilter 里有 scan.marginalRho 守卫），所以默认值不会误伤未算的表。
  const [candFilter, setCandFilter] = useState({ minMarginal: 0.005, maxMissRate: 100 });
  const [candSearch, setCandSearch] = useState('');   // 按字段名/含义搜索候选（跨两阵营、跨分页）
  // 2026-07-29：打分形状与缺失口径从"两个可选开关"降成两个常量，UI 上的 Segmented 已删。
  //
  // scoreShape：曾可选 'interval'（区间命中＝把梯形退化成矩形，区间内满权重、区间外 0）。梯形是它的
  //   超集——挖出的区间边界本来就是搜索出来的最优窗口，边缘那一段线性衰减正是对"边界不可能刚好卡准"
  //   的软化；退回硬矩形只会让边界附近的样本被非黑即白地判定。实践中没有理由选它。
  //   注意：矩形因子本身仍然合法（从策略导入时 checks 文案只编码了核心区，按 lo0=lo1/hi1=hi0 近似），
  //   trapScore 对矩形的处理不能删，删的只是"扫描后按矩形建因子"这个选项。
  // missingPolicy：曾可选 'renorm'（缺失因子不参与、按在场权重重归一）。它是个真陷阱——
  //   策略侧的「生成上线代码」(lib/onlineExport.js) 里【没有任何 renorm 概念】，线上一律缺失记 0 分。
  //   用户一旦在这里选了 renorm，回测分数和线上分数就系统性对不上，cutoff 照搬必然错位。
  //   这不是一个选项，是一个只会让人踩坑的开关。
  const scoreShape = 'trap';
  const missingPolicy = 'zero';
  const [factors, setFactors] = useState(persisted?.factors ?? []);
  const [cutoff, setCutoff] = useState(persisted?.cutoff ?? 60);
  const [oos, setOos] = useState(null); // { folds:[{splitIndex,trainSize,testSize,testStart,testEnd,train,test,trainFactors,skipped,factorDecay}], splits, trainRatio, burnIn } | { error }
  const [oosBusy, setOosBusy] = useState(false);
  const [oosProgress, setOosProgress] = useState(null); // {completed,total} walk-forward 逐段进度
  const [oosFoldIdx, setOosFoldIdx] = useState(0); // 详情面板选中的那一段，默认最后一段（训练集最大、离现在最近）
  // FactorRecommendCard 算出的推荐结果，靠 onResultChange 抛上来——不是给这里渲染用，只为了
  // 「导出完整报告」能把分档诊断也并进去，不用再单独一个导出按钮（见 exportFullReport）。
  const [recommendResult, setRecommendResult] = useState(null);
  // 「基线库 vs 训练集(按天)」对比要选定的策略——2026-07-28 真实数据实测发现的bug：基准库/训练集
  // 归类是按【策略+天】两个维度做的（同一天在不同策略下可以分别归类），之前按天分组时没有再按
  // 策略区分，导致多个策略在同一天都有归类时会被误合并成一行（用户截图验证：某天114条被误并成
  // 154条，多出来的40条来自另一个策略同一天的训练集数据）。修复：对比范围收窄到单个策略，
  // 默认选数据量最大的那个（下面 useMemo 算出 strategyOptions 后由另一个 effect 兜底选中）。
  const [baselineVsTrainStrategy, setBaselineVsTrainStrategy] = useState(null);
  // 2026-07-28 大回退：分层秩相关（BucketRho）在真实数据上试了一圈（饱和度惩罚、锯齿惩罚两轮
  // 订正）配权效果都不理想，换回全程 ρ（scorePoolRho/optimizeWeightsForRho：全样本点对点的
  // spearman，不分档、不用命中率）——这是"没特殊说明都走这个"的默认口径，见北极星方案文档。
  const [rhoOpt, setRhoOpt] = useState(null);
  const [rhoOptBusy, setRhoOptBusy] = useState(false);
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
    () => (fieldScope === 'all'
      ? fields.slice()
      : fields.filter(f => classifyFieldOrigin(f).original === (fieldScope === 'original'))),
    [fields, fieldScope]);
  const backtest = useMemo(
    () => (factors.length ? backtestFactors(rows, factors, threshold, { missingPolicy }) : null),
    [rows, factors, threshold, missingPolicy]);
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

  // 采用推荐结果（整条 / 截断到 k*）：结果自带精配好的权重（全样本坐标上升，不是 interval.score
  // 自动权重），直接整体替换因子池——不能走 adoptRecommended 那条路（它会用 rebuildFactors 重新按
  // interval.score 自动配权，把精配的权重覆盖掉）。
  // 2026-07-29：原「因子推荐1」的 replaceWithRecommended（按 spec 整体替换、autoWeights 配权）
  // 已删除——两张卡片合并后，"整体替换"统一由这个函数承担，而且它替换进去的权重是精配过的，
  // 严格优于旧那条路径；旧函数留着只会让"替换"有两种权重语义。
  function adoptRecommendedFactors(newFactors) {
    if (!newFactors || !newFactors.length) return;
    const heroAdd = newFactors.filter(f => f.camp !== 'evil').map(f => f.field);
    const evilAdd = newFactors.filter(f => f.camp === 'evil').map(f => f.field);
    scan.setSelectedHero([...new Set([...scan.selectedHero, ...heroAdd])]);
    scan.setSelectedEvil([...new Set([...scan.selectedEvil, ...evilAdd])]);
    setFactors(newFactors);
    invalidateDownstream();
    message.success(`已采用 ${newFactors.length} 个推荐因子（含配好的权重），替换了原因子池`);
  }

  // 导出完整报告（markdown）→ 复制到剪贴板，喂给 AI 诊断。2026-07-29：原来候选表/回测/时间外推
  // 验证/基线库对比/因子推荐分档诊断分散在五处、共 8 个导出按钮，都是同一种"喂AI的markdown"，
  // 拆细只会让人多点几下再手工拼——合并成一个按钮，按当前实际算出了什么就并什么，没算的段落
  // 直接跳过、不占位。把各处 state 抽成各 lib 函数需要的 input。
  async function exportFullReport() {
    if (!backtest) { message.warning('先建好因子池、有回测结果再导出'); return; }
    const sections = [];

    const campsForExport = [
      { camp: 'hero', list: filteredHeroCandidates },
      { camp: 'evil', list: filteredEvilCandidates },
    ].filter(x => x.list && x.list.length);
    if (campsForExport.length) {
      const { text } = buildCandidateExportTsv(campsForExport, exportOpts());
      sections.push(`# 候选字段列表\n\n${text}`);
    }

    const p = sweepAt(backtest, cutoff);
    // 回测段固定用"详情面板"当前选中的那一段（跟页面上展示的一致），不是笼统平均——
    // 这样导出的数字和用户在页面上实际看到的数字对得上。
    const oosSelectedFold = (oos && !oos.error) ? oos.folds[Math.min(oosFoldIdx, oos.folds.length - 1)] : null;
    const oosInput = (oosSelectedFold && !oosSelectedFold.error) ? {
      trainSize: oosSelectedFold.trainSize, testSize: oosSelectedFold.testSize, skipped: oosSelectedFold.skipped,
      train: sweepAt(oosSelectedFold.train, cutoff), test: sweepAt(oosSelectedFold.test, cutoff),
    } : (oos && oos.error ? { error: oos.error } : (oosSelectedFold?.error ? { error: oosSelectedFold.error } : null));
    sections.push(buildBacktestReport({
      config: { sampleN: rows.length, threshold, cutoff, missingPolicy, scoreShape, fieldScope },
      base,
      factors: factors.map(f => ({ field: f.field, camp: f.camp, weight: f.weight,
        lo0: f.lo0, lo1: f.lo1, hi1: f.hi1, hi0: f.hi0, auc: f.auc, missRate: missingRate(rows, f.field) })),
      corr: factorCorr,
      rhoOpt,
      current: { triggered: p.triggered, hitRate: p.hitRate, capture: p.capture, lift: p.lift },
      sweep: backtest.sweep.points.map(x => ({ cut: x.cut, triggered: x.triggered, hitRate: x.hitRate, capture: x.capture, lift: x.lift })),
      deciles: backtest.deciles,
      oos: oosInput,
      missed: missedRows.map(s => ({ ca: s.row.tokenAddress, symbol: s.row.symbol, score: s.score, ret: Number(s.row.returnMax) })),
    }));

    if (oos && !oos.error && oosFoldRows) sections.push(buildWalkForwardReport(oos, oosFoldRows, { cutoff, threshold }));

    if (baselineVsTrain && !baselineVsTrain.error) {
      sections.push(buildBaselineVsTrainReport(baselineVsTrain, { cutoff, threshold, strategyName: baselineVsTrainStrategy }));
    }

    if (recommendResult?.path?.length) sections.push(buildRecommendPathReport(recommendResult.path, { threshold }));

    const report = sections.join('\n\n---\n\n');
    try { await navigator.clipboard.writeText(report); message.success('完整报告已复制（markdown），直接粘给 AI 即可'); }
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

  // 样本层面的两个系统性偏差。它们不属于任何单个字段，却会同时污染这一页上的每一个统计量，
  // 所以常驻在最顶上的总览卡，而不是藏在某个诊断按钮后面。
  const sampleHealth = useMemo(() => {
    const n = rows.length;
    if (!n) return null;
    // ① 非独立样本：同一个 token 的多条信号收益高度相关，但 AUC 的 bootstrap CI、区间的置换
    //    检验、Wilson 区间、两比例检验全都按"n 条独立样本"算——重复越多，显著性虚增越厉害
    //    （n 条相关样本的有效信息量远不到 n）。找因子默认不去重（去重按钮在「总览」页）。
    const tokens = new Set(rows.map(r => String(r.tokenAddress || r.id || '')).filter(Boolean));
    const uniqTokens = tokens.size;
    // ② 观察期未定型：returnMax = max_mcap / initial_mcap，而 max_mcap 只统计到数据导出为止
    //    （见 data.js buildRows 的 exportTimestamp 注释）。最近抓到的样本还没走完行情，
    //    returnMax 系统性偏低。数据里没有真正的"统计截止时刻"，用样本里最晚的买入时刻近似。
    //    这条直接决定了怎么读"时间外推验证"：test 段永远是最新的样本，天然吃这个亏，
    //    看到"验证段衰减"要先排除它，别一上来就归因成参数过拟合。
    let latest = -Infinity;
    for (const r of rows) { const t = Number(r.buyTimestamp); if (Number.isFinite(t) && t > latest) latest = t; }
    const FRESH_HOURS = 24;
    let fresh = 0, freshWin = 0, aged = 0, agedWin = 0;
    if (Number.isFinite(latest)) {
      const cut = latest - FRESH_HOURS * 3600;
      for (const r of rows) {
        const t = Number(r.buyTimestamp);
        if (!Number.isFinite(t)) continue;
        const win = Number(r.returnMax) > threshold ? 1 : 0;
        if (t >= cut) { fresh++; freshWin += win; } else { aged++; agedWin += win; }
      }
    }
    return {
      n, uniqTokens, dupRatio: uniqTokens ? 1 - uniqTokens / n : 0,
      freshN: fresh, freshRate: fresh ? freshWin / fresh : NaN,
      agedN: aged, agedRate: aged ? agedWin / aged : NaN, freshHours: FRESH_HOURS,
    };
  }, [rows, threshold]);

  const hasEvil = factors.some(f => f.camp === 'evil');
  const cutoffMin = hasEvil ? -100 : 0;
  // 因子池里"映射不回原始 ctx，且上线代码也没有已知派生算法"的因子：这类字段在上线代码里
  // 取值才会真的恒为 null（记 0 分）、权重却仍占分母，线上总分因此系统性低于回测总分——阈值
  // 直接照搬就会偏紧。这里算一次，发送到策略时提示，因子表上也常驻一条提醒。
  // 2026-07-29：加入 FIELD_TO_BLOCK 判断——onlineExport.js 里已经登记过派生算法的字段（比如
  // chip_analysis.above_below_ratio、holder_hhi 这类"组装字段但有现成公式，可以内联算"）不算
  // 不可映射，之前只查 classifyFieldOrigin/resolveCtxAccessor（只认"直接对应单一 ctx 路径"）会
  // 把这类字段一并误报成"恒为缺失"，虽然生成上线代码时其实能正确算出来。
  const unmappableFactors = useMemo(() => {
    if (!factors.length || !rows.length) return [];
    return factors.filter(f => {
      if (FIELD_TO_BLOCK.has(f.field)) return false;
      return !classifyFieldOrigin(f.field).original || !resolveCtxAccessor(rows, f.field).ok;
    });
  }, [factors, rows]);
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
  const invalidateDownstream = () => { setOos(null); setRhoOpt(null); };

  function changeThreshold(t) {
    setThreshold(t);
    invalidateDownstream();
  }

  // 因子发现（扫描/候选/勾选/边际ρ贡献/持久化排除）这一大块状态与逻辑收在 useFactorScan 里，
  // 详见该文件顶部注释。
  const scan = useFactorScan({
    rows, scopedFields, fieldScope, threshold, scoreShape, missingPolicy,
    factors, setFactors, invalidateDownstream, message,
  });

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
    // 勾选状态必须跟着导入的因子一起立起来。resetScan 把两个 selected 清空了，如果不补这一步，
    // 用户导入完随手点一次「扫描」，rebuildFactors 会按"本次扫到、但没勾选"的规则把这些因子
    // 判成"用户取消勾选了"，整池当场清空——跟 useFactorScan 顶部注释里记的那次"刷新后重建把
    // 整池清空"是同一个事故，只是入口换成了导入。
    scan.setSelectedHero(imported.filter(f => f.camp !== 'evil').map(f => f.field));
    scan.setSelectedEvil(imported.filter(f => f.camp === 'evil').map(f => f.field));
    setFactors(imported);
    invalidateDownstream();
    message.success(`已导入 ${imported.length} 个打分因子（权重/阵营原样保留，核心区已还原，硬界暂按矩形近似）——可在下面因子表里手工调整或删除，也可以重新扫描后用「计算候选边际ρ贡献」找该补的字段。`);
  }

  // 按 field+camp 复合匹配，而不是只按 field：同一字段理论上可以同时在两个阵营各选一次
  // （不建议但不禁止），只按 field 匹配会让编辑/删除其中一个连带影响到另一个阵营的那份
  function editFactor(field, camp, patch) {
    setFactors(prev => prev.map(f => (f.field === field && f.camp === camp ? { ...f, ...patch } : f)));
    invalidateDownstream();
  }

  // 删因子【不】重新 autoWeights：剩下那些因子的权重可能是「按ρ最优配权」搜出来的、或者用户
  // 手工调的，autoWeights 会按 interval.score 把它们整体覆盖掉——删一个因子顺手把配权成果清了，
  // 界面上还留着 rhoOpt 那张"train/test 都涨了"的结果给新权重站台（真实踩过）。
  // 权重和不再是 100 也没关系：scoreRow 按 Σw 归一，相对比例不变，cutoff 的含义也不漂移。
  function removeFactor(f) {
    if (f.camp === 'evil') scan.setSelectedEvil(prev => prev.filter(x => x !== f.field));
    else scan.setSelectedHero(prev => prev.filter(x => x !== f.field));
    setFactors(prev => prev.filter(x => !(x.field === f.field && x.camp === f.camp)));
    invalidateDownstream();
  }

  // 按字段名删除（去冗余提示里的 ✕ 用）：相关性是按字段名算的，同名字段两个阵营都删掉。
  function removeFactorByField(field) {
    if (!factors.some(f => f.field === field)) return;
    scan.setSelectedHero(prev => prev.filter(x => x !== field));
    scan.setSelectedEvil(prev => prev.filter(x => x !== field));
    setFactors(prev => prev.filter(f => f.field !== field));   // 同上：不重配权
    invalidateDownstream();
    message.success(`已删除因子「${field}」`);
  }

  // 一键清空整个因子池（setFactors([]) 会触发持久化 effect 里的 clearFactorPoolState 一并清掉本地缓存）
  function clearAllFactors() {
    scan.setSelectedHero([]);
    scan.setSelectedEvil([]);
    setFactors([]);
    invalidateDownstream();
    message.success('已清空因子池');
  }

  // ρ最优配权（默认口径）：全程点对点 spearman(score, returnMax)，不分档、不绑 cutoff。
  async function runRhoOptimize() {
    setRhoOptBusy(true);
    await new Promise(r => setTimeout(r, 0));
    try {
      const res = optimizeWeightsForRho(rows, factors, { missingPolicy });
      if (res.error) { message.warning(res.error); setRhoOpt(null); return; }
      setFactors(res.factors);
      invalidateDownstream();
      setRhoOpt(res);
      const overfit = Number.isFinite(res.rhoTestAfter) && Number.isFinite(res.rhoTestBefore)
        && res.rhoTestAfter <= res.rhoTestBefore;
      if (overfit) message.warning('train ρ 提升了，但 held-out test 没涨——可能过拟合，谨慎采用（可点「全部重置为自动」还原）');
      else message.success('已按 ρ 最优写回权重，train / test 均见提升——现在可以点「推荐阈值」单独定 cutoff');
    } finally { setRhoOptBusy(false); }
  }

  // 2026-07-28 从单次70/30切分升级成 walk-forward 多段滚动（见 factorLab.js runWalkForwardBacktest
  // 注释）：解决"只切一刀"的运气问题——多段都稳定才可信，只是某几段衰减也能看出是不是特定
  // 行情阶段的问题。splits=5，验证池不够切5段时函数内部会自动降段。
  async function runOOS() {
    setOosBusy(true);
    setOosProgress(null);
    await new Promise(r => setTimeout(r, 0));
    try {
      // 验证对象取【当前因子池】而不是候选表的勾选状态：两者会不一致——从策略导入的因子、跨字段
      // 范围保留下来的因子、「因子推荐」带权重直接采用的因子，都在池子里但未必在本次扫描的勾选里；
      // 反过来勾了却没能建出因子的字段也不该拿去验证。用勾选去验证的后果是"页面上在用的因子池"
      // 和"被验证的因子集"根本不是同一批（导入策略之后 selected 为空，直接报"推导不出任何有效
      // 因子"，用户看到的却是满满一池因子）。
      const fieldSpecs = factors.map(f => ({ field: f.field, camp: f.camp }));
      if (!fieldSpecs.length) { message.warning('因子池为空，先扫描并勾选因子'); return; }
      const res = await runWalkForwardBacktest(rows, fieldSpecs, threshold, {
        bootstrapB: 100, shape: scoreShape, missingPolicy, splits: 5,
        onProgress: ({ completed, total }) => setOosProgress({ completed, total }),
      });
      setOos(res);
      if (res.error) message.warning(res.error);
      else setOosFoldIdx(res.folds.length - 1); // 默认看最后一段（训练集最大、离现在最近，最接近"现在上线"的情形）
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
    // 上线代码里，映射不回原始 ctx 的字段取值恒为 null → 记 0 分，但它的权重仍留在分母里
    // （onlineExport 的 V() 口径）。于是线上总分【系统性低于】这里的回测总分，而 CUTOFF 是照搬
    // 回测面板的——触发数会莫名其妙地少一大截，且越是这类因子权重大、偏得越狠。
    // 这里只能提醒：要么把这些因子从池子里去掉重新定阈值，要么在实盘侧自己复刻它们的计算。
    if (unmappableFactors.length) {
      message.warning(`⚠️ 有 ${unmappableFactors.length} 个因子（${unmappableFactors.map(f => f.field).join('、')}）`
        + `映射不回原始 ctx，上线后它们恒为"缺失"记 0 分、权重却仍占分母——线上总分会系统性低于回测总分，`
        + `CUTOFF=${cutoff} 直接套用会偏紧。建议先把它们删掉、重新看一次「推荐阈值」再发送。`, 12);
    }
    if (onGoToStrategy) onGoToStrategy();
  }

  // 候选表批量导出：制表符分隔，直接粘贴进 Excel/飞书表格能对齐成列，或整段发给 AI 帮忙挑因子。
  // 列（方向/coverage/CI 等挑因子必看项）由 lib/factorScanExport.js 统一拼，勇者/邪恶口径一致。
  // 只导出当前"过滤后"展示的那些行，跟表格里看到的一致。
  const exportOpts = () => ({
    getDesc: getFieldDesc, getMarginal: scan.getMarginal,
    meta: `因子扫描候选导出 · 高倍阈值=${threshold}x · 样本=${rows.length} · 字段范围=${FIELD_SCOPE_LABEL[fieldScope]}`,
  });

  // 市值耦合体检：进场市值与 returnMax 的相关有多强（见 fieldAudit.js）。
  // 只跟 rows 有关，跟因子池/阈值都无关，所以缓存住即可。
  const mcapAudit = useMemo(() => auditMcapCoupling(rows), [rows]);

  // 不用 useMemo 缓存：列定义要闭包住当前这一份 scan.handleExcludeCandidate（引用了随渲染变化的
  // selectedHero/selectedEvil/scanHero/scanEvil），缓存住旧闭包会让"移除"按钮操作到过期的状态。
  const scanHeroColumns = makeScanColumns('hero', field => scan.handleExcludeCandidate('hero', field), scan.getMarginal, scan.permNull);
  const scanEvilColumns = makeScanColumns('evil', field => scan.handleExcludeCandidate('evil', field), scan.getMarginal, scan.permNull);
  // 候选表过滤：AUC 按偏离 0.5 的幅度筛（判别力，不分方向）；边际ρ按【带符号】筛——只留
  // deltaTest ≥ 阈值的正贡献候选（验证段真涨的才是该挑的；负贡献 = 加了反而拉低 ρ，不该留，
  // 哪怕它绝对值很大）。卡的是 test 不是 train：train 涨 test 不涨的候选正是要被这道拦掉的那类。
  // 只在算过之后才生效（没算过时不该把整表清空——那只是"还没算"不是"不合格"）。
  // selectedSet：该阵营当前已勾选的字段。已选中的候选【永远保留】，不被任何过滤藏起来——
  // 否则它们从 dataSource 消失会连带让 AntD 裁掉受控选择、把因子从池子里弄丢（真实踩过的 bug）。
  // 而且边际ρ只对"未选中"的候选计算，已选中的 getMarginal 恒为 undefined，一过滤就必然被误杀。
  function applyCandFilter(list, selectedSet, camp = 'hero') {
    if (!list) return list;
    const q = candSearch.trim().toLowerCase();
    return list.filter(c => {
      // 搜索对所有行生效（含已选中）：显式"找某字段"时，不匹配的就该藏起来。字段名 + 中文含义都匹配。
      if (q && !(c.field.toLowerCase().includes(q) || (getFieldDesc(c.field) || '').toLowerCase().includes(q))) return false;
      if (selectedSet && selectedSet.has(c.field)) return true;   // 已选中 → 免受数值过滤，恒显示
      if ((c.missRate ?? 0) * 100 > candFilter.maxMissRate) return false;
      if (candFilter.minMarginal > 0 && scan.marginalRho) {
        // 必须带 camp：只按字段名取会拿到另一个阵营那份 Δρ，把该留的候选筛掉、该筛的留下
        const m = scan.getMarginal(c.field, camp);
        if (!m || !Number.isFinite(m.deltaTest) || m.deltaTest < candFilter.minMarginal) return false;
      }
      return true;
    });
  }
  const filteredHeroCandidates = applyCandFilter(scan.visibleHeroCandidates, new Set(scan.selectedHero), 'hero');
  const filteredEvilCandidates = applyCandFilter(scan.visibleEvilCandidates, new Set(scan.selectedEvil), 'evil');
  const candFilterActive = candFilter.maxMissRate < 100
    || candSearch.trim() !== '' || (candFilter.minMarginal > 0 && scan.marginalRho);

  // 「因子推荐」的候选池：只套用候选表里的"缺失率≤"这一道过滤，不牵连 lift/边际ρ
  // 那两道——它们是候选表专用的显著性类展示过滤，之前"硬显著性门槛把候选池筛空"已经踩过坑
  // （见 readme 4.1节），推荐算法应尽量遍历全部候选。但缺失率是例外：非缺失样本太少的候选，
  // held-out评估容易只是在极小样本上凑巧，之前"缺失率≤"过滤器只作用于候选表展示、没接进推荐
  // 算法，导致「算推荐」依然会挑出缺失率95%+的字段并给不小权重。
  const recommendCandidates = [...(scan.visibleHeroCandidates || []), ...(scan.visibleEvilCandidates || [])]
    .filter(c => (c.missRate ?? 0) * 100 <= candFilter.maxMissRate);

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
    const layout = {
      height: 380, margin: { l: 56, r: 56, t: 24, b: 40 },
      paper_bgcolor: c.paperBg, plot_bgcolor: c.paperBg, font: { color: c.textColor, size: 12 },
      xaxis: { title: { text: '总分' }, ...c.axis },
      yaxis: { title: { text: '倍数（returnMax，对数轴）' }, type: 'log', ...c.axis },
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

  // 时间外推验证——选中那一段的完整 cutoff 扫描曲线对照（train lift vs test lift 全程曲线，
  // 而不是只挑当前一个 cutoff 看单点）：数据本来就在 fold.train.sweep / fold.test.sweep 里
  // （backtestFactors 内部本来就算了全量扫描），这里纯展示层，零额外计算。一眼看出是全程衰减
  // 还是只有某几个 cutoff 区间衰减——全程衰减更值得担心，只在极端cutoff衰减可能只是那里样本太少。
  const oosFoldSweepFigure = useMemo(() => {
    if (!oos || oos.error) return null;
    const fold = oos.folds?.[Math.min(oosFoldIdx, oos.folds.length - 1)];
    if (!fold || fold.error) return null;
    const c = plotColors(!light);
    const trainPts = fold.train.sweep.points.filter(p => Number.isFinite(p.lift));
    const testPts = fold.test.sweep.points.filter(p => Number.isFinite(p.lift));
    const traces = [
      { x: trainPts.map(p => p.cut), y: trainPts.map(p => p.lift), name: `训练段（n=${fold.trainSize}）`,
        type: 'scatter', mode: 'lines', line: { color: '#0a84ff', width: 2 } },
      { x: testPts.map(p => p.cut), y: testPts.map(p => p.lift), name: `验证段（n=${fold.testSize}）`,
        type: 'scatter', mode: 'lines', line: { color: '#ff9f0a', width: 2 } },
    ];
    const layout = {
      height: 300, margin: { l: 56, r: 20, t: 24, b: 40 },
      paper_bgcolor: c.paperBg, plot_bgcolor: c.paperBg, font: { color: c.textColor, size: 12 },
      xaxis: { title: { text: 'cutoff' }, ...c.axis },
      yaxis: { title: { text: 'lift（命中率÷基准率）' }, ...c.axis },
      shapes: [
        { type: 'line', x0: cutoff, x1: cutoff, y0: 0, y1: 1, yref: 'paper',
          line: { color: '#ff453a', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 1, y1: 1,
          line: { color: '#8e8e93', width: 1, dash: 'dot' } },
      ],
      legend: { orientation: 'h', y: 1.15 },
      showlegend: true,
    };
    return { traces, layout };
  }, [oos, oosFoldIdx, cutoff, light]);

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

  // walk-forward 各段总览行：渲染的总览表和「导出完整报告」（exportFullReport）共用同一份计算——
  // 保证页面上看到的"衰减判定"跟导出markdown里的判定永远一致，不会出现两处算出不同结论。
  const oosFoldRows = useMemo(() => {
    if (!oos || oos.error) return null;
    return oos.folds.map((f, i) => {
      if (f.error) return { key: i, idx: i, error: f.error, trainSize: f.trainSize, testSize: f.testSize };
      const tr = sweepAt(f.train, cutoff), te = sweepAt(f.test, cutoff);
      const decay = assessSplitDecay(tr, te);
      return { key: i, idx: i, tr, te, decay, trainSize: f.trainSize, testSize: f.testSize,
               testStart: f.testStart, testEnd: f.testEnd };
    });
  }, [oos, cutoff]);

  // 基线库(整体) vs 训练集(按天) 对比——2026-07-28 新增，跟「时间外推验证」是两套不同的东西：
  // 那个是"当前样本内自动按时间切分、重新训练再验证"；这个是用户在「数据与过滤」tab 手动把
  // 累积数据【按天】归到「基准库」/「训练集」（见 lib/dataSlices.js），这里直接用【当前因子池】
  // 原样打分（不重新推导任何区间/权重）——基准库当一个整体算一次，训练集按天各自算一次，
  // 用两比例检验（跟 assessSplitDecay 同一套）看训练集哪几天的命中率已经显著偏离基准库，
  // 用来监控"现成策略在不同数据来源/时间上表现是否一致"，不是过拟合检验。
  // archiveAllRows/archiveSliceCats 不受当前分析范围（sliceSel）影响，独立从归类表里现分。
  //
  // 策略数据源里可以有多个策略（比如"强势盘策略"+"1.5段策略"），归类表按【策略+天】两个维度记
  // （sliceKeyOf(strategyKey, day)），同一天在不同策略下可以分别归到不同类别——真实数据实测过
  // 一版只按天分组会把不同策略的样本混进同一天（比如策略A的07-26训练集114条 + 策略B的07-26
  // 训练集40条被合并显示成154条，07-22~25明明是策略A的基准库天却也混进策略B的训练集数据冒出
  // 一行），所以这里固定收窄到【单个策略】范围内对比，避免跨策略混淆。
  const strategyOptions = useMemo(() => {
    if (!archiveAllRows?.length) return [];
    return groupRowsByStrategyAndDay(archiveAllRows).map(g => ({ strategyName: g.strategyName, count: g.count }));
  }, [archiveAllRows]);

  // 默认选数据量最大的策略；如果之前选的策略已经不在候选里了（比如换了归档数据）也重新兜底选一个。
  useEffect(() => {
    if (!strategyOptions.length) { if (baselineVsTrainStrategy !== null) setBaselineVsTrainStrategy(null); return; }
    if (!strategyOptions.some(s => s.strategyName === baselineVsTrainStrategy)) {
      setBaselineVsTrainStrategy(strategyOptions[0].strategyName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyOptions]);

  const baselineVsTrain = useMemo(() => {
    if (!factors.length || !archiveAllRows?.length || !baselineVsTrainStrategy) return null;
    const scopedRows = archiveAllRows.filter(r => strategyOf(r) === baselineVsTrainStrategy);
    const baselineRows = selectRowsBySlice(scopedRows, archiveSliceCats, { mode: 'baseline' });
    const trainRows = selectRowsBySlice(scopedRows, archiveSliceCats, { mode: 'train' });
    const byDay = new Map();
    for (const r of trainRows) {
      const d = dayOf(r?.buyTimestamp) || UNKNOWN_DAY;
      if (d === UNKNOWN_DAY) continue; // 无法定位到具体天的样本不参与按天对比
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }
    const groups = [...byDay.keys()].sort().map(day => ({ label: day, rows: byDay.get(day) }));
    return compareGroupsAgainstBaseline(baselineRows, groups, factors, threshold, { missingPolicy, cutoff });
  }, [factors, archiveAllRows, archiveSliceCats, baselineVsTrainStrategy, threshold, missingPolicy, cutoff]);

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
        {/* 样本独立性：同一 token 多条信号 → 所有显著性判定都虚高，见 sampleHealth 注释 */}
        {sampleHealth && sampleHealth.dupRatio > 0.2 && (
          <Alert style={{ marginTop: 12 }} type="warning" showIcon
            message={<span style={{ fontSize: 12 }}>
              ⚠️ {sampleHealth.n} 条样本只来自 {sampleHealth.uniqTokens} 个不同 token（重复率 {fmtPct(sampleHealth.dupRatio)}）
            </span>}
            description={<span style={{ fontSize: 12 }}>
              同一个 token 的多次信号收益高度相关，但这一页所有统计量（AUC 的置信区间、区间的置换检验 p、
              Wilson 区间、衰减的两比例检验）都按"独立样本"算——<b>显著性会被系统性高估</b>，有效样本量远小于 {sampleHealth.n}。
              挑因子时把"校正后显著"当参考而不是准绳；想要干净的结论，可以先去「总览」页点一次「每个 token 只留首条信号」再回来扫。
            </span>} />)}
        {/* 观察期未定型：最新样本的 returnMax 还没走完，别把它误读成"行情变差/参数过拟合" */}
        {sampleHealth && sampleHealth.freshN >= 10 && sampleHealth.agedN >= 10
          && Number.isFinite(sampleHealth.freshRate) && sampleHealth.freshRate < sampleHealth.agedRate * 0.8 && (
          <Alert style={{ marginTop: 12 }} type="info" showIcon
            message={<span style={{ fontSize: 12 }}>
              ⏳ 最近 {sampleHealth.freshHours} 小时的 {sampleHealth.freshN} 条样本高倍率只有 {fmtPct(sampleHealth.freshRate)}，
              明显低于更早的 {sampleHealth.agedN} 条（{fmtPct(sampleHealth.agedRate)}）
            </span>}
            description={<span style={{ fontSize: 12 }}>
              returnMax 取的是 max_mcap/initial_mcap，而 max_mcap 只统计到数据导出为止——<b>最新的样本还没走完行情，
              倍数天生偏低</b>，这未必是行情变差。影响最大的是「时间外推验证」：验证段永远是最新的那批样本，
              天然吃这个亏，看到"验证段衰减"要先排除这层，别一上来就归因成参数过拟合。
            </span>} />)}
      </Card>

      {/* 1.5 从现有策略导入因子池：不用从零扫描/勾选，直接把「策略」页那份代码里已经在
          打分的字段搬进来，权重/阵营原样保留，再用下面的因子表修正或过滤它们。 */}
      <ImportStrategyCard strategySrc={strategySrc} setStrategySrc={setStrategySrc} onImport={importFromStrategy} />

      {/* 2. 因子发现：勇者阵营 + 邪恶阵营 两个候选池 */}
      <Card id="fl-discover" size="small" title="因子发现（勇者阵营找高倍集中区加分 · 邪恶阵营找输家集中区减分）"
        extra={<Space wrap>
          {/* 这里原本还有一个「全体样本 / 残差（漏网之鱼）」开关，见 useFactorScan.js 顶部说明：
              残差挖掘想干的事就是 held-out 边际ρ 的定义，功能重复，已删。 */}
          <Segmented value={fieldScope} onChange={v => setFieldScope(v)}
            options={[{ label: '原字段', value: 'original' }, { label: '组装字段', value: 'assembled' }, { label: '全部', value: 'all' }]} />
          <Button type="primary" loading={scan.scanBusy} disabled={!rows.length || !scopedFields.length}
            onClick={scan.runScan}>
            {scan.scanBusy && scan.scanProgress > 0
              ? `扫描中 ${Math.round(scan.scanProgress * 100)}%…`
              : `扫描 ${scopedFields.length} 个${FIELD_SCOPE_LABEL[fieldScope]}（两阵营）`}
          </Button>
          <Tooltip title='逐个把候选字段临时并入当前因子池，看 spearman(score, returnMax) 的变化——挑因子固定用这个口径。按时间切 70/30：梯形边界只在训练段推、增量只在验证段(test)读，所以这个数不含"边界照着这批样本挖出来"的水分。表里同时给训练段增量作对照。'>
            <Button loading={scan.marginalBusy} disabled={!scan.scanHero && !scan.scanEvil}
              onClick={scan.runMarginalRho}>计算候选边际ρ贡献（held-out）</Button>
          </Tooltip>
          <Tooltip title='把 returnMax 在样本间完全打乱（字段值不动，只切断字段与收益的对应关系），再把"挖区间→切训练/验证→建梯形→算 held-out Δρ"整条流水线原样重跑 20 遍，得到"纯噪声能凑出多大 deltaTest"的经验分布（跟候选表那一列同一个统计量，才能拿来当尺子）。q95 就是「边际ρ(test) ≥」那条线该设多少的依据，不用再拍脑袋；同时给每个候选一个经验 p 值。'>
            <Button loading={scan.permNullBusy} disabled={!scan.scanHero && !scan.scanEvil}
              onClick={() => scan.runPermNull()}>
              {scan.permNullBusy && scan.permNullProgress > 0
                ? `置换中 ${Math.round(scan.permNullProgress * 100)}%…` : '跑置换零分布'}
            </Button>
          </Tooltip>
        </Space>}>
        {/* 这里原本常驻一段 7 行的说明（两阵营各挖什么、原字段/组装字段/全部三种范围的区别）。
            那是"看一次就够"的教学内容，却跟"扫描结果已过期"这类必须当场处理的有态告警挤在同一屏，
            互相稀释注意力。已整体移进顶部折叠的 SOP 卡（FactorSopCard 的「两阵营与字段范围」一节），
            页面上只留一句定义。同理，条件触发的告警（组装字段提醒、staleScan 等）留在原地，
            因为它们只在真的出事时才出现。 */}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          <b>勇者阵营</b>挖"高倍盘集中的取值区间"（命中加分）、<b>邪恶阵营</b>挖"输家集中的取值区间"（命中减分），
          两边独立扫描、共用同一套区间挖掘算法。字段范围与阵营的详细口径见顶部「📖 找因子操作指引」。
        </Typography.Paragraph>
        {fieldScope !== 'original' && <Alert style={{ marginBottom: 12 }} type="info" showIcon
          message={fieldScope === 'all'
            ? '「全部」范围里含组装字段——组装字段是工具从快照聚合/派生出来的，实盘 ctx 里没有对应值，命中的规律需要你人工审核认可后，再想办法在实盘侧复刻计算，不能直接生成代码。'
            : '组装字段是工具从快照聚合/派生出来的，实盘 ctx 里没有对应值——回测发现的规律需要你人工审核认可后，再想办法在实盘侧复刻计算，不能直接生成代码。'} />}
        {/* 「结果已过期」原本是三选一（范围变了 / 残差开关变了 / 阈值变了）。残差模式删掉后只剩两种。 */}
        {scan.staleScan && <Alert style={{ marginBottom: 12 }} type="warning" showIcon
          message={scan.scanScope !== fieldScope
            ? `扫描结果是「${FIELD_SCOPE_LABEL[scan.scanScope]}」范围的，当前已切到「${FIELD_SCOPE_LABEL[fieldScope]}」，请重新扫描。`
            : `扫描结果是在 ${scan.scanThreshold}x 阈值下算的，当前已切到 ${threshold}x，请重新扫描。`} />}
        {scan.marginalStale && <Alert style={{ marginBottom: 12 }} type="warning" showIcon
          message="因子池/打分方式/缺失口径/阈值已变化，「边际ρ(test)」列是旧结果，请重新计算。" />}

        {/* 市值耦合体检：returnMax = max_mcap / initial_mcap，分母就是进场市值。这个 ρ 越强，
            "小盘更容易翻倍"这条恒等式对候选表的影响就越大，越多字段其实只是市值的影子。 */}
        {/* 2026-07-29：耦合弱的时候这里原本也是一整块 info Alert，说的却是"没事，不用管"——
            一条常驻的好消息横幅，把旁边真正需要处理的橙色告警一起稀释掉了。现在只有 |ρ|≥0.2
            （小盘效应真的在污染候选表）才升级成告警块；弱耦合降成一行灰字，数字仍在，随时可查。 */}
        {mcapAudit && !mcapAudit.error && (() => {
          const rho = mcapAudit.rhoMcapReturn;
          const strong = Number.isFinite(rho) && Math.abs(rho) >= 0.2;
          const mcapLine = <>进场市值中位 ${formatNumberSmart(mcapAudit.medianMcap)}
            （P10 ${formatNumberSmart(mcapAudit.p10Mcap)} / P90 ${formatNumberSmart(mcapAudit.p90Mcap)}）；
            ρ(进场市值, returnMax) = <b style={{ color: strong ? '#ff9f0a' : undefined }}>{Number.isFinite(rho) ? rho.toFixed(3) : '-'}</b></>;
          if (!strong) {
            return <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
              <Tooltip title='returnMax 的分母就是进场市值，所以"小盘更容易翻倍"是条恒等式。这个 ρ 弱 = 候选表受它污染不大；仍可用「与市值ρ」列逐字段复核。'>
                <span>市值耦合体检：{mcapLine}（弱耦合，无需处理）</span>
              </Tooltip>
            </Typography.Paragraph>;
          }
          return <Alert style={{ marginBottom: 12 }} type="warning" showIcon
            message={<span style={{ fontSize: 12 }}><b>市值耦合体检</b>：{mcapLine}</span>}
            description={<span style={{ fontSize: 12, opacity: .8 }}>
              returnMax 的分母就是进场市值，这个 ρ 明显不为 0 说明"盘子多大"本身就在决定倍数。候选表里「与市值ρ」大的字段（不只是名字带 mcap 的那些）很可能只是这条恒等式的投影——挑它们等于在挑"买小盘"，不是新规律。
            </span>} />;
        })()}

        {/* 置换零分布：给"边际ρ 多大才算超出噪声"一个经验标尺，替掉 SOP 里那条拍脑袋的 0.005 */}
        {scan.permNull && (scan.permNull.error
          ? <Alert style={{ marginBottom: 12 }} type="warning" showIcon message={`置换零分布：${scan.permNull.error}`} />
          : <Alert style={{ marginBottom: 12 }} type={scan.permNullStale ? 'warning' : 'success'} showIcon
              message={<span style={{ fontSize: 12 }}>
                <b>边际ρ 置换零分布</b>{scan.permNullStale ? '（因子池已变，标尺已过期，建议重跑）' : ''}：
                打乱 returnMax 重跑 {scan.permNull.permutations} 轮 × {scan.permNull.candidates} 个候选，
                得到 {scan.permNull.n} 个纯噪声 Δρ —— 中位 {scan.permNull.q50.toFixed(4)}、
                q90 <b>{scan.permNull.q90.toFixed(4)}</b>、q95 <b>{scan.permNull.q95.toFixed(4)}</b>、
                q99 <b>{scan.permNull.q99.toFixed(4)}</b>、最大 {scan.permNull.max.toFixed(4)}
              </span>}
              description={<Space size={8} wrap style={{ fontSize: 12, opacity: .85 }}>
                <span>把「边际ρ(test) ≥」设到 q95 以上，才算真正筛掉了噪声候选。</span>
                <Button size="small" type="primary" ghost
                  onClick={() => setCandFilter(f => ({ ...f, minMarginal: Math.max(0, Math.ceil(scan.permNull.q95 * 10000) / 10000) }))}>
                  按 q95 设阈值（{scan.permNull.q95.toFixed(4)}）
                </Button>
              </Space>} />)}

        {(scan.scanHero || scan.scanEvil) && (
          <Space wrap size={12} style={{ marginBottom: 12, padding: '8px 12px', background: 'rgba(127,127,127,.08)', borderRadius: 6 }}>
            {/* 2026-07-29：过滤控件从 6 个减到 3 个。删掉的三个——
                「AUC 偏离 ≥」：AUC 定死一个单调方向，跟下游的区间/梯形打分口径自相矛盾（见 readme 第 4 节，
                  驼峰型字段会被它判成"没区分度"），SOP 也明写"别按 AUC 挑因子"。留着这个输入框
                  等于在鼓励用一个已知口径不符的指标筛候选，AUC 列仍在表里当诊断参考。
                「区间 n ≥」：跟扫描阶段的 minCoverage=0.3 与 interval.score 里的 √coverage 惩罚重复，
                  "字段本身样本太少"由「缺失率≤」覆盖。
                「lift ≥」：挖区间用的 score=(wilsonLo/base)×√coverage（见 scanIntervalCore）本来就是拿
                  lift 换捕获率——捕获率越高的窗口，lift 越必然被拉回接近 1（捕获率100%时区间≈全样本，
                  lift 必然≈1），这是算法设计使然，不代表候选没用。单独设一道"lift≥"阈值筛，筛掉的
                  恰恰可能是"覆盖广、边际ρ也可能不低"的候选，筛选口径反而跟真正决定因子有没有用的
                  「边际ρ(test)」对不上。lift 列仍在候选表里，跟捕获率一起看，判断区间是"窄而强"还是
                  "宽而弱"，只是不该单独拿来当候选池的门槛。
                没动的是"谁影响候选池"这条规则：只有「缺失率≤」限制推荐候选池，其余只影响展示。
                readme 4.1 记着——把显著性类门槛接进候选池，真实数据上会直接把池子筛空。 */}
            <Typography.Text style={{ fontSize: 12, opacity: .65 }}>候选表过滤（只影响展示/勾选不受影响；「缺失率≤」额外会限制「因子推荐」的候选池）：</Typography.Text>
            <Input allowClear size="small" placeholder="搜字段名/含义" style={{ width: 180 }}
              value={candSearch} onChange={e => setCandSearch(e.target.value)} />
            <Tooltip title={!scan.marginalRho ? '先点「计算候选边际ρ贡献（held-out）」才能按这个筛' : '只保留【验证段】边际贡献 deltaTest ≥ 该值的候选（正贡献=加进池子能提升排序信息量）。负贡献、以及只有 train 涨的候选都会被挡掉，哪怕绝对值大。设 0 = 显示全部（含负贡献）'}>
              <Space size={4}><span style={{ fontSize: 12 }}>边际ρ(test) ≥</span>
                <InputNumber size="small" min={0} max={1} step={0.005} style={{ width: 70 }} disabled={!scan.marginalRho}
                  value={candFilter.minMarginal} onChange={v => setCandFilter(f => ({ ...f, minMarginal: v || 0 }))} /></Space>
            </Tooltip>
            <Tooltip title="非缺失样本太少的字段，held-out评估容易只是在极小样本上凑巧——这道过滤除了控制候选表展示，也会真正限制「因子推荐」能选到的候选（「边际ρ」只影响候选表展示）。设 100 = 不限制。">
              <Space size={4}><span style={{ fontSize: 12 }}>缺失率 ≤</span>
                <InputNumber size="small" min={0} max={100} step={5} style={{ width: 70 }} suffix="%"
                  value={candFilter.maxMissRate} onChange={v => setCandFilter(f => ({ ...f, maxMissRate: v ?? 100 }))} /></Space>
            </Tooltip>
            {candFilterActive && <Button size="small" onClick={() => { setCandFilter({ minMarginal: 0, maxMissRate: 100 }); setCandSearch(''); }}>清空过滤</Button>}
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
              {scan.excludedHero.length > 0 && (
                <Popconfirm title={`一键恢复全部 ${scan.excludedHero.length} 个已移除的勇者阵营字段？`}
                  okText="全部恢复" cancelText="取消" onConfirm={() => scan.handleRestoreAllExcluded('hero')}>
                  <Typography.Link style={{ fontSize: 12 }}>一键恢复全部</Typography.Link>
                </Popconfirm>
              )}
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
              {scan.excludedEvil.length > 0 && (
                <Popconfirm title={`一键恢复全部 ${scan.excludedEvil.length} 个已移除的邪恶阵营字段？`}
                  okText="全部恢复" cancelText="取消" onConfirm={() => scan.handleRestoreAllExcluded('evil')}>
                  <Typography.Link style={{ fontSize: 12 }}>一键恢复全部</Typography.Link>
                </Popconfirm>
              )}
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
        {/* 因子推荐（2026-07-29 由原「因子推荐」+「因子推荐2」合并成一张）：
            held-out 贪心选字段 → 全样本精配权 → 影子权重过拟合校验 → K折 k*。
            onAdopt 收 spec 列表（点路径某一步，合并进池、按区间自动配权），
            onAdoptFactors 收带精配权重的完整因子对象（整体替换）。两模式：基于当前池 / 从零探索。 */}
        {(scan.scanHero || scan.scanEvil) && (
          <FactorRecommendCard rows={rows} factors={factors} threshold={threshold}
            missingPolicy={missingPolicy} scoreShape={scoreShape}
            onAdopt={adoptRecommended} onAdoptFactors={adoptRecommendedFactors}
            candidates={recommendCandidates} onResultChange={setRecommendResult} />
        )}
      </Card>

      {/* 3. 因子权重（可编辑） */}
      {factors.length > 0 && (
        <Card id="fl-weights" size="small" title={`因子权重（${factors.length} 个，可编辑）`}
          extra={<Space>
            <Typography.Text type={Math.abs(weightSum - 100) > 0.5 ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
              权重合计 {weightSum.toFixed(1)}{Math.abs(weightSum - 100) > 0.5 ? '（≠100，总分会按合计归一）' : ''}
            </Typography.Text>
            {/* 打分形状/缺失口径两个 Segmented 已删（2026-07-29），理由见文件上方 scoreShape/missingPolicy
                两个常量处的注释——前者梯形是超集，后者选了就跟线上代码对不上。 */}
            <Tooltip title='默认口径——全程点对点 spearman(score, returnMax)，不分档、不用命中率、不绑 cutoff。搜非负权重让这个值最大（前 70% 拟合、后 30% 验证），会把对整体排序无贡献/有害的因子权重压到 0。配完权重后，点右边「推荐阈值」单独定 cutoff，不要先猜 cutoff 再配权。'>
              <Button size="small" type="primary" ghost loading={rhoOptBusy}
                disabled={factors.length < 2 || !rows.length}
                onClick={runRhoOptimize}>🎯 按 ρ 最优配权</Button>
            </Tooltip>
            <Button size="small" onClick={() => (scan.scanHero || scan.scanEvil) && scan.rebuildFactors(scan.scanHero, scan.scanEvil, scan.selectedHero, scan.selectedEvil, [])}>全部重置为自动</Button>
            <Popconfirm title="清空整个因子池？" description="会移除全部因子并清掉本地持久化，无法撤销。" okText="清空" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={clearAllFactors}>
              <Button size="small" danger>一键清空</Button>
            </Popconfirm>
            {/* 「发送到策略」的唯一入口在本卡片下方的 fl-send 卡（带前提/行为说明）。这里曾经也放过
                一个同功能按钮，两处调同一个 sendToStrategy——CUTOFF 是在「回测」卡里定的，从权重卡
                直接发容易在还没定阈值时就发出去，且 ScrollNav 只指向 fl-send。留一个入口。 */}
          </Space>}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
            <Tag color="success" style={{ marginRight: 4 }}>勇者</Tag>命中核心区 = +权重×命中度（加分）；
            <Tag color="error" style={{ marginRight: 4 }}>邪恶</Tag>命中核心区 = -权重×命中度（减分）。
            梯形打分：值落在 [核心起, 核心止] 满效应，向两侧的 0 效应界线性衰减，界外 0；留空 = 该侧不设界（∞）。
            字段缺失记 0（不加不减，惩罚数据不全的盘，保守；跟线上「生成上线代码」口径一致）。
            总分 = Σ(±权重×命中度)/权重合计×100，纯勇者阵营时落在 0~100，含邪恶阵营命中时可能为负。
            权重自动按区间打分（Wilson下界×√coverage，区间感知，不假设方向单调）分配，可手工调整；
            点「🎯 按 ρ 最优配权」直接优化全程点对点 spearman(score, returnMax)，配完权重后用「推荐阈值」单独定 cutoff——先排序、再从排序里读 cutoff，不要反过来。
          </Typography.Paragraph>
          {rhoOpt && (() => {
            const fmt = v => (Number.isFinite(v) ? v.toFixed(3) : '—');
            const dTrain = rhoOpt.rhoTrainAfter - rhoOpt.rhoTrainBefore;
            const dTest = rhoOpt.rhoTestAfter - rhoOpt.rhoTestBefore;
            const testUp = Number.isFinite(dTest) && dTest > 0;
            return (
              <Alert style={{ marginBottom: 12 }} type={testUp ? 'success' : 'warning'} showIcon
                message={<span style={{ fontSize: 12 }}>
                  🎯 ρ最优配权结果（默认口径 = 全程 score↔returnMax 的 Spearman）：
                  <b> train</b> {fmt(rhoOpt.rhoTrainBefore)} → {fmt(rhoOpt.rhoTrainAfter)}（{dTrain >= 0 ? '+' : ''}{fmt(dTrain)}），
                  <b> held-out test</b> {fmt(rhoOpt.rhoTestBefore)} → {fmt(rhoOpt.rhoTestAfter)}（{dTest >= 0 ? '+' : ''}{fmt(dTest)}）
                  <Typography.Text type="secondary">　train {rhoOpt.nTrain} / test {rhoOpt.nTest} 条</Typography.Text>
                </span>}
                description={<span style={{ fontSize: 12 }}>
                  {testUp
                    ? 'test 也涨 = 排序质量真实提升，可放心采用——接下来点右上角「推荐阈值」单独定 cutoff，不要用旧 cutoff。'
                    : '⚠️ 只有 train 涨、held-out test 没涨 —— 大概率过拟合。别急着用，考虑减因子或点「全部重置为自动」还原。'}
                  {rhoOpt.zeroedFields.length > 0 && <>　被压到 0（对 ρ 无贡献或有害，建议删）：{rhoOpt.zeroedFields.map(f => <code key={f} style={{ fontSize: 11, marginLeft: 4 }}>{f}</code>)}</>}
                </span>} />
            );
          })()}
          {/* 上线尺度检查：池里有映射不回 ctx 的因子时，线上分数跟这里的回测分数不是一个尺度
              （线上取不到值 → 记 0 分，权重却还在分母里），照搬 cutoff 必然偏紧。常驻提醒，
              不能只在点「发送到策略」那一下才说——阈值是在这张卡片上定的。 */}
          {unmappableFactors.length > 0 && (
            <Alert style={{ marginBottom: 12 }} type="warning" showIcon
              message={<span style={{ fontSize: 12 }}>
                ⚠️ 有 {unmappableFactors.length} 个因子映射不回原始 ctx，上线后取不到值：
                {unmappableFactors.map(f => <code key={f.camp + ':' + f.field} style={{ fontSize: 11, marginLeft: 4 }}>{f.field}</code>)}
              </span>}
              description={<span style={{ fontSize: 12 }}>
                它们在实盘会恒判"缺失"记 0 分，但权重（合计 {unmappableFactors.reduce((a, f) => a + (Number(f.weight) || 0), 0).toFixed(1)}）
                仍留在分母里——<b>线上总分会系统性低于这里的回测总分，当前 cutoff={cutoff} 直接上线会偏紧、触发数大幅缩水</b>。
                要么把它们删掉后重新点「推荐阈值」，要么在实盘侧自己复刻这几个字段的计算逻辑。
              </span>} />
          )}
          {/* 去冗余检查：始终有态——有高相关对就橙色告警二选一；没有就给绿色"无冗余"确认，
              避免"告警不出现"让人分不清是"没冗余(好)"还是"功能没了"。需 ≥2 个因子才有意义。 */}
          {factors.length >= 2 && (
            factorCorrHigh.length > 0 ? (
              <Alert style={{ marginBottom: 12 }} type="warning" showIcon
                message={<span style={{ fontSize: 12 }}>
                  🔁 去冗余：以下因子高度相关（|Spearman ρ|≥0.7），同一份信息在重复计分——建议二选一（留边际ρ更高的，点 ✕ 直接删）或手动降权：
                  {factorCorrHigh.map((c, i) => (
                    <div key={i} style={{ paddingLeft: 8 }}>
                      · <code style={{ fontSize: 11 }}>{c.a}</code>
                      <Tooltip title={`删除因子「${c.a}」`}><a onClick={() => removeFactorByField(c.a)}
                        style={{ color: '#ff4d4f', fontWeight: 700, margin: '0 6px 0 4px' }}>✕</a></Tooltip>
                      ↔ <code style={{ fontSize: 11 }}>{c.b}</code>
                      <Tooltip title={`删除因子「${c.b}」`}><a onClick={() => removeFactorByField(c.b)}
                        style={{ color: '#ff4d4f', fontWeight: 700, margin: '0 6px 0 4px' }}>✕</a></Tooltip>
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
            <Tooltip title="把候选字段清单/配置/因子池/去冗余/北极星ρ最优配权结果/当前回测/cutoff扫描/分段表/时间外推/基线库对比/因子推荐分档诊断/漏网之鱼——凡是已经算出来的，全部拼成一份 markdown 复制到剪贴板，直接粘给 AI 让它诊断调试，不用再一节一节分开导出手工拼。">
              <Button size="small" type="primary" ghost onClick={exportFullReport}>📋 导出完整报告（喂 AI）</Button>
            </Tooltip>
            <Tooltip title="导出原始样本数据 JSON（rows + 当前因子池 + 候选 + 配置），跟 buildRows() 产出的形状完全一致——可以直接在 Node 里 import factorLab.js 重放 scoreRows/recommendFactorPath/computeRankBuckets 等原函数，在内存中验证方案，不用等实现完再回测。">
              <Button size="small" onClick={exportRawDataJson}>💾 导出原始数据（供内存验证）</Button>
            </Tooltip>
          </Space>}>
          {hasEvil && <Alert style={{ marginBottom: 12 }} type="info" showIcon
            message="已包含邪恶阵营因子，总分可能为负——阈值滑块下限已相应放宽到 -100。" />}
          {/* 阈值失效检测。真实踩过、而且一直被误记成"推荐阈值选出了 0 触发的档"：
              recommendCutoff 自带 minN=max(20, 5%n) 保护，【不可能】返回触发数为 0 的档位——
              0/128 那种画面的真正来源是【当前 cutoff 高于因子池能打出的最高分】：
              因子越多、命中区越不重叠，总分上限越低（score=Σ(±w·s)/Σw，没有样本能命中所有因子，
              6 个互斥弱因子的池子上限只有 16.7），而 cutoff 默认 60、还是【持久化】的——
              换一份数据、换一批因子、改一次阈值/缺失口径，分数分布整个变了，cutoff 却原地不动。
              于是触发 0、命中率 NaN（显示"-"）、捕获率 0.0%，看着像"策略彻底失效"，其实只是刻度错了。 */}
          {(() => {
            const p = sweepAt(backtest, cutoff);
            const maxScore = backtest.scored.reduce((m, s) => Math.max(m, s.score), -Infinity);
            const minTrig = Math.max(20, Math.ceil(base.n * 0.05));   // 跟 recommendCutoff 同一把尺子
            if (p.triggered === 0) {
              return <Alert style={{ marginBottom: 12 }} type="error" showIcon
                message={<span style={{ fontSize: 12 }}>
                  ⚠️ 当前阈值 {cutoff} 下<b>没有任何样本触发</b>——因子池打得出的最高分只有 {maxScore.toFixed(1)}
                </span>}
                description={<span style={{ fontSize: 12 }}>
                  下面这些数字（命中率"-"、捕获率 0.0%、lift"-"）不是策略失效，是阈值定在了分数分布之外。
                  因子越多、各自的命中区越不重叠，总分上限就越低（总分 = Σ权重×命中 ÷ 权重和，没有样本能同时命中所有因子），
                  而 cutoff 是持久化的、不会跟着因子池自动变。
                  {cutoffRecommend
                    ? <>　点右上角「🎯 推荐阈值（{cutoffRecommend.cut}）」重新定一次。</>
                    : <>　样本太少，推荐阈值也给不出来，先把阈值拉到 {Math.floor(maxScore)} 以下再看。</>}
                </span>} />;
            }
            if (p.triggered < minTrig) {
              return <Alert style={{ marginBottom: 12 }} type="warning" showIcon
                message={<span style={{ fontSize: 12 }}>
                  当前阈值 {cutoff} 下只有 {p.triggered} 个样本触发（少于 {minTrig}，最高分 {maxScore.toFixed(1)}）——
                  命中率/lift 的抽样噪声很大，别据此下结论
                </span>}
                description={cutoffRecommend
                  ? <span style={{ fontSize: 12 }}>「🎯 推荐阈值（{cutoffRecommend.cut}）」按钮挑的是触发数够（≥{minTrig}）里净超额命中数最大的一档，可以先用它对照。</span>
                  : null} />;
            }
            return null;
          })()}
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
              分数 vs 倍数散点（Y 轴对数）：橙=高倍（{'>'}{threshold}x），灰=普通；红竖线=当前 cutoff，绿虚横线=高倍阈值。
              高倍点是否靠右堆、有没有大量橙点落在竖线左侧（漏网），一眼可看。
            </Typography.Text>
            <PlotlyChart traces={scoreScatterFigure.traces} layout={scoreScatterFigure.layout} height={380} />
          </>)}
          <Table style={{ marginTop: 12 }} size="small" rowKey="bin" columns={decileColumns}
            dataSource={backtest.deciles} pagination={false} scroll={{ x: 700 }} />
          <div style={{ marginTop: 16 }}>
            <Space align="center">
              <Button loading={oosBusy} onClick={runOOS}>时间外推验证（walk-forward：前 70% 起步 → 后 30% 切多段滚动检验）</Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                区间与权重只用各段训练集重新自动推导（不含手工编辑），原样套到该段验证——不再只切一刀，滚动切出多段，
                单段可能只是运气好/坏，多段一起看才知道是不是真的稳。
              </Typography.Text>
            </Space>
            {oosBusy && oosProgress && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              验证第 {oosProgress.completed}/{oosProgress.total} 段…</div>}
            {oos && !oos.error && (() => {
              const foldRows = oosFoldRows;
              const nSignificant = foldRows.filter(r => r.decay?.significant).length;
              const fold = oos.folds[Math.min(oosFoldIdx, oos.folds.length - 1)];
              const fmtT = ts => Number.isFinite(ts) ? new Date(ts * 1000).toLocaleDateString() : '-';
              return (
                <div style={{ marginTop: 12 }}>
                  <Alert type={nSignificant > 0 ? 'warning' : 'success'} showIcon
                    message={`共 ${oos.folds.length} 段滚动验证，其中 ${nSignificant} 段判定「验证段命中率显著低于训练段」（两比例检验 p<0.05，不是固定比例阈值）。`} />
                  {/* 各段是独立重训的，分数分布跟全样本不一样；而这里用的是全样本上定的那一个 cutoff。
                      某段在这个 cutoff 下触发 0，读表的人很容易当成"这一段策略失效了"——先把话说在前面。 */}
                  {(() => {
                    const noTrig = foldRows.filter(r => !r.error && r.te.triggered === 0).length;
                    if (!noTrig) return null;
                    return <Alert style={{ marginTop: 8 }} type="info" showIcon
                      message={<span style={{ fontSize: 12 }}>
                        有 {noTrig} 段在当前 cutoff={cutoff} 下验证窗口内<b>没有任何样本触发</b>（表里标红的 0）
                      </span>}
                      description={<span style={{ fontSize: 12 }}>
                        这不是衰减：每段都是独立重训的，各段样本量小、分数分布本来就会漂，而 cutoff 用的是全样本上定的那一个。
                        这些段的命中率/lift 无定义，衰减判定也会标成"样本不足，不下结论"——看整体结论时请把它们排除，
                        或者把 cutoff 调低一点再跑一次看趋势。
                      </span>} />;
                  })()}
                  <Table style={{ marginTop: 8 }} size="small" pagination={false} rowKey="key"
                    onRow={r => ({ onClick: () => setOosFoldIdx(r.idx),
                      style: { cursor: 'pointer', background: r.idx === oosFoldIdx ? 'rgba(10,132,255,.12)' : undefined } })}
                    columns={[
                      { title: '段', dataIndex: 'idx', width: 50, render: i => `#${i + 1}` },
                      { title: '验证窗口时间', width: 160, render: (_, r) => r.error ? '-' : `${fmtT(r.testStart)} ~ ${fmtT(r.testEnd)}` },
                      { title: 'train n', width: 70, align: 'right', dataIndex: 'trainSize' },
                      { title: 'test n', width: 70, align: 'right', dataIndex: 'testSize' },
                      // 触发数为 0 的一侧标红：这一格是"命中率/lift 为什么是 -"的唯一解释，
                      // 不标出来就会被读成"策略在这一段彻底失效"，实际是 cutoff 高过了这一段的分数分布
                      { title: `触发数@${cutoff}(train/test)`, width: 130, align: 'right',
                        render: (_, r) => {
                          if (r.error) return '-';
                          const cell = (v) => v === 0
                            ? <Tooltip title={`这一段在 cutoff=${cutoff} 下没有任何样本达标——不是衰减，是阈值高过了这一段的分数分布（各段样本量小、分数分布本来就会漂）`}>
                                <span style={{ color: '#ff453a', fontWeight: 600 }}>0</span></Tooltip>
                            : <span>{v}</span>;
                          return <span>{cell(r.tr.triggered)} / {cell(r.te.triggered)}</span>;
                        } },
                      { title: '命中率(train/test)', width: 150, align: 'right',
                        render: (_, r) => {
                          if (r.error) return '-';
                          const cell = (p) => p.triggered === 0
                            ? <Tooltip title="该侧无触发样本，命中率无定义"><span style={{ opacity: .5 }}>无触发</span></Tooltip>
                            : <span>{fmtPct(p.hitRate)}</span>;
                          return <span>{cell(r.tr)} / {cell(r.te)}</span>;
                        } },
                      { title: 'lift(train/test)', width: 120, align: 'right',
                        render: (_, r) => r.error ? '-' : `${Number.isFinite(r.tr.lift) ? r.tr.lift.toFixed(2) : '-'} / ${Number.isFinite(r.te.lift) ? r.te.lift.toFixed(2) : '-'}` },
                      { title: '衰减判定', width: 160, render: (_, r) => {
                          if (r.error) return <Typography.Text type="danger" style={{ fontSize: 12 }}>{r.error}</Typography.Text>;
                          if (r.decay.insufficientN) return <Tag>样本不足，不下结论</Tag>;
                          if (r.decay.significant) return <Tag color="error">⚠️ 显著衰减 p={r.decay.p.toFixed(3)}</Tag>;
                          if (r.decay.decayed) return <Tag color="warning">略降，未达显著</Tag>;
                          return <Tag color="success">未衰减</Tag>;
                        } },
                    ]} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>点某一行可切换下面的详情面板（曲线对比 + 逐因子归因）。</Typography.Text>

                  {fold && !fold.error && (
                    <div style={{ marginTop: 12 }}>
                      <Typography.Text strong style={{ fontSize: 13 }}>第 #{oosFoldIdx + 1} 段详情</Typography.Text>
                      {oosFoldSweepFigure && <>
                        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
                          完整 cutoff 扫描曲线对照（不只看当前一个 cutoff）：两条线整体贴合 = 全程都稳；
                          只在某一段cutoff区间分叉 = 只有那个区间衰减，别的区间还站得住。红色竖线=当前cutoff。
                        </Typography.Paragraph>
                        <PlotlyChart traces={oosFoldSweepFigure.traces} layout={oosFoldSweepFigure.layout} height={300} />
                      </>}
                      {fold.factorDecay?.length > 0 && (() => {
                        const rowsD = fold.factorDecay.slice()
                          .sort((a, b) => (Number.isFinite(b.aucDrop) ? b.aucDrop : -1) - (Number.isFinite(a.aucDrop) ? a.aucDrop : -1));
                        return (
                          <>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              逐因子归因（粗略诊断，不是严格检验）：该字段独立算的 AUC 在训练段/验证段的差值，跌得最多的排最前——
                              总分lift塌了，先看这里排最前的几个字段。<b>"test样本量(正类数)"很小时（比如正类数&lt;10），AUC跌幅/涨幅别当真</b>——
                              AUC是排序统计量，正类数太少方差极大，一段之间大幅波动多半是噪声，不是这个字段真的变强/变弱了。
                            </Typography.Text>
                            <Table style={{ marginTop: 4 }} size="small" pagination={false} rowKey="field"
                              dataSource={rowsD.map((r, i) => ({ ...r, key: i }))}
                              columns={[
                                { title: '阵营', dataIndex: 'camp', width: 60, render: c => c === 'evil' ? '☠邪恶' : '🛡勇者' },
                                { title: '字段', dataIndex: 'field', render: f => <code style={{ fontSize: 12 }}>{f}</code> },
                                { title: 'train AUC', width: 90, align: 'right', render: (_, r) => Number.isFinite(r.trainAuc) ? r.trainAuc.toFixed(3) : '-' },
                                { title: 'test AUC', width: 90, align: 'right', render: (_, r) => Number.isFinite(r.testAuc) ? r.testAuc.toFixed(3) : '-' },
                                { title: 'AUC 跌幅', width: 90, align: 'right', render: (_, r) => Number.isFinite(r.aucDrop)
                                    ? <span style={{ color: r.aucDrop > 0.1 ? 'var(--ng,#ff453a)' : undefined }}>{r.aucDrop >= 0 ? '+' : ''}{r.aucDrop.toFixed(3)}</span> : '-' },
                                { title: 'test样本量(正类数)', width: 130, align: 'right', render: (_, r) => {
                                    const thin = Number.isFinite(r.testPos) && r.testPos < 10;
                                    return <span style={{ color: thin ? 'var(--warn,#ff9f0a)' : undefined }}>
                                      {r.testN ?? '-'}（{r.testPos ?? '-'}）{thin && ' ⚠️'}
                                    </span>;
                                  } },
                              ]} />
                          </>
                        );
                      })()}
                      {fold.skipped?.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        该段训练时跳过：{fold.skipped.map(s => `${s.field}（${s.reason}）`).join('；')}</Typography.Text>}
                    </div>
                  )}
                </div>);
            })()}
            {oos && oos.error && <Alert style={{ marginTop: 8 }} type="warning" showIcon message={oos.error} />}
          </div>
        </Card>)}

      {/* 4.4 基线库 vs 训练集(按天) 对比：监控现成策略在不同数据来源/时间上是否漂移，
          跟上面"时间外推验证"不是一回事——那个是当前样本内自动切分+重新训练，这个是用户在
          「数据与过滤」手动按天归类的基准库/训练集，这里只是拿现成因子池原样打分对比 */}
      {factors.length > 0 && (
        <Card size="small" title="基线库 vs 训练集(按天) 对比"
          extra={strategyOptions.length > 1 && (
            <Select size="small" style={{ width: 200 }} value={baselineVsTrainStrategy}
              onChange={setBaselineVsTrainStrategy}
              options={strategyOptions.map(s => ({ value: s.strategyName, label: `${s.strategyName}（${s.count}条）` }))} />
          )}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            用<b>当前因子池原样打分</b>（不重新推导任何区间/权重）——「基准库」当一个整体算一次，「训练集」按天各自算一次，
            跟基准库做两比例检验，看训练集哪几天的命中率已经显著偏离基准库。基准库/训练集的归类入口在「数据与过滤」tab 的时间切片。
            {strategyOptions.length > 1 && <>归类按"策略+天"两个维度记，<b>不同策略的样本不会混在一起</b>，右上角可切换策略。</>}
          </Typography.Paragraph>
          {!archiveAllRows?.length ? (
            <Alert type="info" showIcon message='还没有归档数据——先在「数据与过滤」tab 把部分天归为"基准库"、部分天归为"训练集"。' />
          ) : !baselineVsTrain ? (
            <Alert type="info" showIcon message="先建好因子池再看这个对比。" />
          ) : baselineVsTrain.error ? (
            <Alert type="warning" showIcon message={baselineVsTrain.error} />
          ) : (() => {
            const nSig = baselineVsTrain.groups.filter(g => g.decay?.significant).length;
            const dataSource = [
              { key: 'baseline', label: '基准库(整体)', isBaseline: true, ...baselineVsTrain.baseline },
              ...baselineVsTrain.groups.map(g => ({ key: g.label, label: g.label, ...g })),
            ];
            return (
              <>
                <Alert type={nSig > 0 ? 'warning' : 'success'} showIcon
                  message={`训练集共 ${baselineVsTrain.groups.length} 天，其中 ${nSig} 天判定「命中率显著低于基准库」（两比例检验 p<0.05，不是固定比例阈值）。`} />
                <Table style={{ marginTop: 8 }} size="small" pagination={false} rowKey="key"
                  dataSource={dataSource}
                  columns={[
                    { title: '', width: 130, render: (_, r) => r.isBaseline
                        ? <Typography.Text strong>{r.label}</Typography.Text> : r.label },
                    { title: 'n', dataIndex: 'n', width: 70, align: 'right' },
                    // 同 walk-forward 分段表：0 触发标红，命中率写"无触发"而不是一个看着像"很差"的 -
                    { title: '触发数', width: 80, align: 'right',
                      render: (_, r) => r.error ? '-' : (r.triggered === 0
                        ? <Tooltip title={`这一天在 cutoff=${cutoff} 下没有任何样本达标——不是命中率差，是没有样本进入统计`}>
                            <span style={{ color: '#ff453a', fontWeight: 600 }}>0</span></Tooltip>
                        : r.triggered) },
                    { title: '命中率', width: 90, align: 'right',
                      render: (_, r) => r.error ? '-' : (r.triggered === 0
                        ? <span style={{ opacity: .5 }}>无触发</span> : fmtPct(r.hitRate)) },
                    { title: 'lift', width: 80, align: 'right', render: (_, r) => r.error ? '-' : (Number.isFinite(r.lift) ? r.lift.toFixed(2) : '-') },
                    { title: '判定', width: 170, render: (_, r) => {
                        if (r.isBaseline) return <Tag>参照基准</Tag>;
                        if (r.error) return <Typography.Text type="danger" style={{ fontSize: 12 }}>{r.error}</Typography.Text>;
                        const d = r.decay;
                        if (d.insufficientN) return <Tag>样本不足，不下结论</Tag>;
                        if (d.significant) return <Tag color="error">⚠️ 显著偏离 p={d.p.toFixed(3)}</Tag>;
                        if (d.decayed) return <Tag color="warning">略降，未达显著</Tag>;
                        return <Tag color="success">正常</Tag>;
                      } },
                  ]}
                  scroll={{ y: 360 }} />
              </>
            );
          })()}
        </Card>
      )}

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
