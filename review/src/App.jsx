import React, { useMemo, useState } from 'react';
import { ConfigProvider, Layout, Tabs, Space, Switch, Typography, Tag, Empty, Button, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { makeTheme } from './theme.js';
import DataLoader from './ui/DataLoader.jsx';
import FilterPanel from './ui/FilterPanel.jsx';
import SummaryPanel from './ui/SummaryPanel.jsx';
import SnapshotInspector from './ui/SnapshotInspector.jsx';
import LabelPanel from './ui/LabelPanel.jsx';
import ErrorBoundary from './ui/ErrorBoundary.jsx';
import { loadLabels, saveLabels, setLabel, applyLabels } from './lib/labels.js';
import { loadExcludedTokens, saveExcludedTokens, excludeToken, unexcludeToken, filterExcludedTokens } from './lib/excludedTokens.js';
import { loadCampLibrary, saveCampLibrary, addCampEntry, removeCampEntry, removeCampEntries,
         loadCampActiveGroup, saveCampActiveGroup, renameCampGroup, moveCampEntriesToGroup,
         groupCampEntries, DEFAULT_CAMP_GROUP, applyCampEntryInterval,
         loadCampGroupThresholds, saveCampGroupThresholds, setCampGroupThreshold } from './lib/campLibrary.js';
import CampLibrary from './ui/CampLibrary.jsx';
import CorrTable from './ui/CorrTable.jsx';
import BinBarCard from './ui/BinBarCard.jsx';
import FieldHealth from './ui/FieldHealth.jsx';
import StrategyReplay from './ui/StrategyReplay.jsx';
import BacktestReports from './ui/strategyReplay/BacktestReports.jsx';
import CustomFields from './ui/CustomFields.jsx';
import FieldBrowser from './ui/FieldBrowser.jsx';
import ScatterBoard from './ui/ScatterBoard.jsx';
import FactorLab from './ui/FactorLab.jsx';
import PerfMonitor from './ui/PerfMonitor.jsx';
import { isNonAnalyticField, getFeature, ROW_LEVEL_FIELDS } from './lib/data.js';
import { compileStrategy, runStrategyOnRow, parseFactorCheck } from './lib/proAnalytics.js';

const { Header, Content } = Layout;

// 策略源码：原来「找因子」（FactorLab）和「策略」（StrategyReplay）两个 tab 各自 useState 一份、
// 只在挂载时读一次 localStorage——两边常驻挂载（destroyInactiveTabPane=false）时，在一边编辑后
// 切到另一边，读到的都是各自挂载时的旧值，不会互相同步。提升到这里做唯一数据源，两边都改成消费
// 同一份 state + 同一个持久化 setter，彻底避免"改了白改/导入到旧代码"这类问题。
const STRATEGY_CODE_KEY = 'chart_strategy_diag_code_react';
function loadStrategyCode() {
  try { return localStorage.getItem(STRATEGY_CODE_KEY) || ''; } catch { return ''; }
}

// 「找因子」tab 合并了 FactorLab 内部好几张卡片 + 散点/相关性/共线性体检/分箱共 8 张卡片
// （AUC 批量检测、字段体检里的波峰扫描已删——前者跟 FactorLab 候选表已有的 AUC 列重复，且
// SOP 明写"别按 AUC 挑因子"；后者是纯只读发现工具，结果不接回任何后续步骤，FactorLab 自己的
// findHotInterval 已经在做同一件事、还更严谨。字段体检现在只剩 VIF 共线性诊断，其它工具都没有），
// 纵向堆叠很长，靠滚轮翻找成本高。给一条吸顶的锚点导航条，点了平滑滚动到对应卡片——
// 目标 id 有的在 FactorLab 内部（因子池为空/未回测时那几个 id 不存在于 DOM），
// 找不到就静默不跳，不报错。
function ScrollNav({ items }) {
  const scrollTo = id => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <Space wrap size={4} style={{ position: 'sticky', top: 0, zIndex: 5, padding: '6px 8px',
      background: 'var(--surface-1,#141414)', borderRadius: 6, marginBottom: 4 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 4 }}>跳转：</Typography.Text>
      {items.map(it => (
        <Button key={it.id} size="small" type="text" onClick={() => scrollTo(it.id)}>{it.label}</Button>
      ))}
    </Space>
  );
}

// 候选字段：从行数据现算，并复用 data.js 的剔除规则（内部标记/元数据/绝对时间戳）
function useFieldOptions(rows, customVersion = 0) {
  return useMemo(() => {
    if (!rows.length) return [];
    const keys = new Set(['returnMax', 'logReturnMax']);
    for (const r of rows.slice(0, 200)) for (const k of Object.keys(r.features || {})) keys.add(k);
    const numeric = [];
    for (const k of keys) {
      if (isNonAnalyticField(k)) continue;
      if (ROW_LEVEL_FIELDS && ROW_LEVEL_FIELDS.includes(k)) continue;
      let ok = false, bad = false;
      for (const r of rows) {
        const v = getFeature(r, k);
        if (v === undefined || v === null) continue;
        if (Number.isFinite(Number(v))) ok = true; else { bad = true; break; }
      }
      if (ok && !bad) numeric.push(k);
    }
    return numeric.sort();
  }, [rows, customVersion]);
}

export default function App() {
  const [dark, setDark] = useState(true);
  const [rows, setRows] = useState([]);
  // activeRows = 全局过滤后的工作集。所有分析面板消费它，而不是 rows。
  const [activeRows, setActiveRows] = useState([]);
  const [filtered, setFiltered] = useState(false);
  const [customVersion, setCustomVersion] = useState(0);
  const [labels, setLabels] = useState(loadLabels);
  const fields = useFieldOptions(rows, customVersion);
  // 人工标注在过滤/分析【之前】应用：junk 的 returnMax 被降级，这样所有下游
  // （胜率/中位数/相关性/策略回放的每条 check 效果）都按降级后的真实收益算。
  const labeledRows = useMemo(() => applyLabels(rows, labels), [rows, labels]);
  // 手动删除的样本（跟"标垃圾"不同，这个是真的从工作集里拿掉，n 会变小）——同一笔交易被多天
  // 导入批次重复记录这类脏数据，标垃圾只是不算赢家但样本还在，得靠这层再筛掉一次。
  const [excludedTokens, setExcludedTokens] = useState(loadExcludedTokens);
  const workingRows = useMemo(() => filterExcludedTokens(labeledRows, excludedTokens), [labeledRows, excludedTokens]);
  // 全量样本 + 天→类别归类表（基准库/训练集，见 lib/dataSlices.js）——DataLoader 内部本来就有，
  // 这里接住往下传给 FactorLab，让"基线库 vs 训练集按天"对比不受当前分析范围（sliceSel）影响，
  // 独立从归类表里现分基准库/训练集。
  const [archive, setArchive] = useState({ allRows: [], sliceCats: {} });
  // 标注变化后：没在过滤态就直接用最新的 workingRows 当工作集
  React.useEffect(() => { if (!filtered) setActiveRows(workingRows); }, [workingRows, filtered]);
  const setOneLabel = (ca, label) => {
    const next = setLabel(labels, ca, label);
    setLabels(next); saveLabels(next);
  };
  const excludeOneToken = (ca, symbol) => {
    const next = excludeToken(excludedTokens, { ca, symbol });
    setExcludedTokens(next); saveExcludedTokens(next);
  };
  const unexcludeOneToken = ca => {
    const next = unexcludeToken(excludedTokens, ca);
    setExcludedTokens(next); saveExcludedTokens(next);
  };
  const hasData = rows.length > 0;

  // 阵营库：跟具体策略无关的公用收藏夹（详见 lib/campLibrary.js）。"发送到策略"不是直接改
  // StrategyReplay 内部的 localStorage——那个组件常驻挂载（destroyInactiveTabPane=false），
  // 直接写 localStorage 它也不会感知到；改成一个"待插入"的队列传给它，它自己消费掉再清空，
  // 同时把 Tabs 切到"策略"这一页，体验上是"发送后自动跳转"。
  const [campLibrary, setCampLibrary] = useState(loadCampLibrary);
  // "新增归入哪个分组"：图表里收藏新因子时默认落进这个组（跨会话记住）。分组本身从收藏的
  // group 字段推导，这里只记"当前往哪个组收"这个偏好。
  const [campActiveGroup, setCampActiveGroupState] = useState(loadCampActiveGroup);
  // 高倍阈值按分组存一个（整组共用），不是每条收藏一个
  const [campGroupThresholds, setCampGroupThresholds] = useState(loadCampGroupThresholds);
  const [activeTabKey, setActiveTabKey] = useState('data');
  const [pendingStrategyLines, setPendingStrategyLines] = useState([]);
  const [strategyCode, setStrategyCodeState] = useState(loadStrategyCode);
  // "存报告"这个动作就地留在"策略"tab（StrategyReplay 自己算好 agg/scoreAgg 等顶层指标后直接
  // 存档），"报告"tab（BacktestReports）只负责查看/对比/导出已存的报告——reportsVersion 是两边
  // 之间唯一需要的信号：存了新报告 +1，"报告"tab 据此重新读一次存档列表。
  const [reportsVersion, setReportsVersion] = useState(0);
  const setStrategyCode = next => {
    setStrategyCodeState(next);
    try { localStorage.setItem(STRATEGY_CODE_KEY, next); } catch { /* 隐私模式 */ }
  };
  const setCampActiveGroup = name => {
    const g = name && String(name).trim() ? String(name).trim() : DEFAULT_CAMP_GROUP;
    setCampActiveGroupState(g); saveCampActiveGroup(g);
  };
  const addToCampLibrary = entry => {
    // 图表收藏时 entry 若没带 group，就落进当前分组（camp 库 tab 里选的那个）
    const next = addCampEntry(campLibrary, { ...entry, group: entry.group || campActiveGroup });
    setCampLibrary(next); saveCampLibrary(next);
  };
  // 收藏前判断是不是已经在库里——决定弹出的提示文案是"已收藏"还是"已更新"
  const isCampFieldExisting = (field, camp) =>
    campLibrary.some(x => x.field === field && (x.camp === 'evil' ? 'evil' : 'hero') === (camp === 'evil' ? 'evil' : 'hero'));
  // 当前「策略」tab 那份代码里，已经实际在打分的字段集合——散点图标题上标一下"当前已作为因子"，
  // 跟阵营库的收藏状态（isCampFieldExisting）不是一回事：阵营库是暂存候选，这里是已经在线上
  // 判定逻辑里生效的。只需要一条能跑通的样本取 checks 结构（权重/字段名对全部样本是常量）。
  const activeStrategyFactorFields = useMemo(() => {
    const set = new Set();
    if (!strategyCode || !strategyCode.trim() || !activeRows.length) return set;
    const compiled = compileStrategy(strategyCode);
    if (compiled.error) return set;
    for (const row of activeRows) {
      if (!row.rawCtx) continue;
      const res = runStrategyOnRow(compiled, row);
      if (res.error || !Array.isArray(res.checks)) continue;
      for (const c of res.checks) {
        const parsed = parseFactorCheck(c);
        if (parsed) set.add(parsed.name);
      }
      break;
    }
    return set;
  }, [strategyCode, activeRows]);
  const isStrategyFactorField = field => activeStrategyFactorFields.has(field);
  const removeCampLibraryEntry = id => {
    const next = removeCampEntry(campLibrary, id);
    setCampLibrary(next); saveCampLibrary(next);
  };
  const removeCampLibraryEntries = ids => {
    const next = removeCampEntries(campLibrary, ids);
    setCampLibrary(next); saveCampLibrary(next);
  };
  const renameCampLibraryGroup = (from, to) => {
    const next = renameCampGroup(campLibrary, from, to);
    setCampLibrary(next); saveCampLibrary(next);
    if (campActiveGroup === from) setCampActiveGroup(to); // 当前组被改名，指针跟着走
  };
  const moveCampLibraryEntries = (ids, to) => {
    const next = moveCampEntriesToGroup(campLibrary, ids, to);
    setCampLibrary(next); saveCampLibrary(next);
  };
  const setCampGroupThresholdValue = (group, t) => {
    const next = setCampGroupThreshold(campGroupThresholds, group, t);
    setCampGroupThresholds(next); saveCampGroupThresholds(next);
  };
  const applyCampLibraryCorrection = (id, lo, hi) => {
    const next = applyCampEntryInterval(campLibrary, id, lo, hi);
    setCampLibrary(next); saveCampLibrary(next);
  };
  // 一键修正全部：一次性把多条收藏的区间改成实测高倍落点（单次 setState，避免逐条调用的闭包过期）
  const applyCampLibraryCorrections = (items) => {
    let next = campLibrary;
    for (const it of items) next = applyCampEntryInterval(next, it.id, it.lo, it.hi);
    setCampLibrary(next); saveCampLibrary(next);
  };
  // 传原始记录（不在这里提前拼成字符串）：插到 ALL_CHECKS 还是插独立 tuple，取决于目标策略
  // 自己是什么架构，只有 StrategyReplay 自己能看到当前的策略源码，这一步不能在这里决定。
  const sendCampEntryToStrategy = entry => {
    setPendingStrategyLines(prev => [...prev, entry]);
    setActiveTabKey('strategy');
  };

  const tabs = [
    {
      key: 'data', label: '数据与过滤',
      children: (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <DataLoader onRows={r => { setRows(r); setActiveRows(filterExcludedTokens(applyLabels(r, labels), excludedTokens)); setFiltered(false); }}
            onArchiveChange={setArchive} />
          {hasData && <ErrorBoundary title="快照速查渲染出错" resetKey={rows.length}><SnapshotInspector rows={workingRows} labels={labels} onLabel={setOneLabel} light={!dark} /></ErrorBoundary>}
          {hasData && <FilterPanel rows={workingRows} fields={fields}
            onActiveRows={(r, isF) => { setActiveRows(r); setFiltered(isF); }} />}
          {hasData && <SummaryPanel activeRows={activeRows} allRows={workingRows}
            onDedup={r => { setActiveRows(r); setFiltered(true); }} />}
        </Space>
      ),
    },
    {
      // P2-1：原「相关性与显著性」+「图表」+「回测·因子」三个并列的"找因子"入口合一。
      // FactorLab（回测·因子）是超集（挖区间+lift+捕获率+样本外+生成代码），放最前面当主体；
      // 散点/相关性/字段体检是复核视角，折叠在其后，减少重复入口、tab 数 7→5。
      key: 'findFactor', label: '找因子', disabled: !hasData,
      children: (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <ScrollNav items={[
            { id: 'fl-threshold', label: '阈值总览' },
            { id: 'fl-import', label: '导入策略' },
            { id: 'fl-discover', label: '因子发现' },
            { id: 'fl-weights', label: '因子权重' },
            { id: 'fl-backtest', label: '回测' },
            // 曾经是 'fl-generate'（FactorLab 自己生成上线代码那张卡）。代码生成已统一到策略侧的
            // 「生成上线代码」，那张卡随之删掉，锚点却留着——点了不跳，是个死链。现在指向真正的末节。
            { id: 'fl-send', label: '发送到策略' },
            { id: 'section-scatter', label: '散点图' },
            { id: 'section-corr', label: '相关性' },
            { id: 'section-health', label: '体检/分箱' },
          ]} />
          <ErrorBoundary title="回测·因子面板渲染出错" resetKey={activeRows.length}>
            <FactorLab rows={activeRows} fields={fields} light={!dark}
              archiveAllRows={archive.allRows} archiveSliceCats={archive.sliceCats}
              strategyCode={strategyCode} onStrategyCodeChange={setStrategyCode}
              onGoToStrategy={() => setActiveTabKey('strategy')} />
          </ErrorBoundary>
          <div id="section-scatter">
            <ScatterBoard rows={activeRows} fields={fields} light={!dark} onAddToCampLibrary={addToCampLibrary}
              campGroups={groupCampEntries(campLibrary, [campActiveGroup]).map(g => g.group)}
              campActiveGroup={campActiveGroup} onCampActiveGroupChange={setCampActiveGroup}
              isCampFieldExisting={isCampFieldExisting} isStrategyFactorField={isStrategyFactorField} />
          </div>
          <div id="section-corr"><CorrTable rows={activeRows} /></div>
          <div id="section-health" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <FieldHealth rows={activeRows} fields={fields} />
            <BinBarCard rows={activeRows} fields={fields} light={!dark} />
          </div>
        </Space>
      ),
    },
    {
      key: 'campLibrary', label: '阵营库',
      children: (
        <CampLibrary library={campLibrary} rows={activeRows} onRemove={removeCampLibraryEntry}
          onRemoveMany={removeCampLibraryEntries} onSendToStrategy={sendCampEntryToStrategy}
          activeGroup={campActiveGroup} onActiveGroupChange={setCampActiveGroup}
          onRenameGroup={renameCampLibraryGroup} onMoveEntries={moveCampLibraryEntries}
          groupThresholds={campGroupThresholds} onSetGroupThreshold={setCampGroupThresholdValue}
          onApplyCorrection={applyCampLibraryCorrection} onApplyCorrections={applyCampLibraryCorrections} />
      ),
    },
    {
      key: 'strategy', label: '策略', disabled: !hasData,
      children: (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <StrategyReplay rows={activeRows} fields={fields} light={!dark} onLabel={setOneLabel}
            onExclude={excludeOneToken}
            pendingLines={pendingStrategyLines}
            onConsumePendingLines={() => setPendingStrategyLines([])}
            strategyCode={strategyCode} onStrategyCodeChange={setStrategyCode}
            reportsVersion={reportsVersion} onReportsChange={() => setReportsVersion(v => v + 1)} />
        </Space>
      ),
    },
    {
      // 报告的查看/对比/导出独立成一个 tab；"存为今天报告"这个动作留在"策略"tab 里就地完成
      // （见 StrategyReplay.jsx），这里只读 reportsVersion 感知新存的报告，不需要接收顶层指标。
      key: 'reports', label: '报告', disabled: !hasData,
      children: <BacktestReports light={!dark} reportsVersion={reportsVersion} />,
    },
    {
      key: 'fields', label: '字段', disabled: !hasData,
      children: (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <CustomFields rows={workingRows} fields={fields}
            onApplied={() => { setCustomVersion(v => v + 1); setActiveRows(a => [...a]); }} />
          <FieldBrowser fields={fields} />
          <LabelPanel rows={labeledRows} labels={labels} onLabel={setOneLabel}
            onClearAll={() => { setLabels({}); saveLabels({}); }}
            excludedTokens={excludedTokens} onUnexclude={unexcludeOneToken} />
        </Space>
      ),
    },
  ];

  return (
    <ConfigProvider locale={zhCN} theme={makeTheme(dark)}>
      <AntApp>
        <Layout style={{ minHeight: '100vh' }}>
          <Header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 24px', position: 'sticky', top: 0, zIndex: 10 }}>
            <Space size={12}>
              <Typography.Title level={5} style={{ margin: 0, color: '#fff' }}>
                收益与快照字段关系分析
              </Typography.Title>
              {hasData && (
                // 不只看 filtered 这个"手动点过筛选"的标记——删除样本（onExclude）也会让 activeRows
                // 比 rows 少，如果只认 filtered，头部会照样显示原始总数，跟下面所有分析面板看到的
                // 条数对不上（明明策略回放显示 4 条，头部却还说 5 条样本）。
                <Tag color={(filtered || activeRows.length !== rows.length) ? 'orange' : 'blue'}>
                  {(filtered || activeRows.length !== rows.length)
                    ? `已过滤 ${activeRows.length} / ${rows.length} 条` : `${rows.length} 条样本`}
                </Tag>
              )}
              {hasData && <Tag>{fields.length} 个可用字段</Tag>}
            </Space>
            <Space size={8}>
              <Typography.Text style={{ color: 'rgba(255,255,255,.65)', fontSize: 12 }}>深色</Typography.Text>
              <Switch size="small" checked={dark} onChange={setDark} />
            </Space>
          </Header>
          <Content style={{ padding: '16px 24px 48px', maxWidth: 1600, margin: '0 auto', width: '100%' }}>
            {hasData
              ? <Tabs items={tabs} destroyInactiveTabPane={false} activeKey={activeTabKey} onChange={setActiveTabKey} />
              : <Tabs items={[tabs[0]]} />}
            {!hasData && (
              <Empty style={{ marginTop: 48 }}
                description="先在上方选择 calls / snapshots 数据文件（可混选，自动识别）并点「分析」" />
            )}
          </Content>
        </Layout>
        <PerfMonitor />
      </AntApp>
    </ConfigProvider>
  );
}
