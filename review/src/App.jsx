import React, { useMemo, useState } from 'react';
import { ConfigProvider, Layout, Tabs, Space, Switch, Typography, Tag, Empty, App as AntApp } from 'antd';
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
import { loadCampLibrary, saveCampLibrary, addCampEntry, removeCampEntry,
         loadCampActiveGroup, saveCampActiveGroup, renameCampGroup, moveCampEntriesToGroup,
         groupCampEntries, DEFAULT_CAMP_GROUP, applyCampEntryInterval,
         loadCampGroupThresholds, saveCampGroupThresholds, setCampGroupThreshold } from './lib/campLibrary.js';
import CampLibrary from './ui/CampLibrary.jsx';
import CorrTable from './ui/CorrTable.jsx';
import BinBarCard from './ui/BinBarCard.jsx';
import AucPanel from './ui/AucPanel.jsx';
import FieldHealth from './ui/FieldHealth.jsx';
import StrategyReplay from './ui/StrategyReplay.jsx';
import CustomFields from './ui/CustomFields.jsx';
import FieldBrowser from './ui/FieldBrowser.jsx';
import ScatterBoard from './ui/ScatterBoard.jsx';
import FactorLab from './ui/FactorLab.jsx';
import { isNonAnalyticField, getFeature, ROW_LEVEL_FIELDS } from './lib/data.js';

const { Header, Content } = Layout;

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
  const setCampActiveGroup = name => {
    const g = name && String(name).trim() ? String(name).trim() : DEFAULT_CAMP_GROUP;
    setCampActiveGroupState(g); saveCampActiveGroup(g);
  };
  const addToCampLibrary = entry => {
    // 图表收藏时 entry 若没带 group，就落进当前分组（camp 库 tab 里选的那个）
    const next = addCampEntry(campLibrary, { ...entry, group: entry.group || campActiveGroup });
    setCampLibrary(next); saveCampLibrary(next);
  };
  const removeCampLibraryEntry = id => {
    const next = removeCampEntry(campLibrary, id);
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
          <DataLoader onRows={r => { setRows(r); setActiveRows(filterExcludedTokens(applyLabels(r, labels), excludedTokens)); setFiltered(false); }} />
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
      // 散点/相关性/AUC/字段体检是复核视角，折叠在其后，减少重复入口、tab 数 7→5。
      key: 'findFactor', label: '找因子', disabled: !hasData,
      children: (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <ErrorBoundary title="回测·因子面板渲染出错" resetKey={activeRows.length}>
            <FactorLab rows={activeRows} fields={fields} light={!dark} />
          </ErrorBoundary>
          <ScatterBoard rows={activeRows} fields={fields} light={!dark} onAddToCampLibrary={addToCampLibrary}
            campGroups={groupCampEntries(campLibrary, [campActiveGroup]).map(g => g.group)}
            campActiveGroup={campActiveGroup} onCampActiveGroupChange={setCampActiveGroup} />
          <CorrTable rows={activeRows} />
          <AucPanel rows={activeRows} fields={fields} />
          <FieldHealth rows={activeRows} fields={fields} />
          <BinBarCard rows={activeRows} fields={fields} light={!dark} />
        </Space>
      ),
    },
    {
      key: 'campLibrary', label: '阵营库',
      children: (
        <CampLibrary library={campLibrary} rows={activeRows} onRemove={removeCampLibraryEntry} onSendToStrategy={sendCampEntryToStrategy}
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
            onConsumePendingLines={() => setPendingStrategyLines([])} />
        </Space>
      ),
    },
    {
      key: 'fields', label: '字段', disabled: !hasData,
      children: (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <CustomFields rows={workingRows} fields={fields}
            onApplied={() => { setCustomVersion(v => v + 1); setActiveRows(a => [...a]); }} />
          <FieldBrowser fields={fields} />
          {hasData && <ErrorBoundary title="快照速查渲染出错" resetKey={rows.length}><SnapshotInspector rows={workingRows} labels={labels} onLabel={setOneLabel} light={!dark} /></ErrorBoundary>}
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
      </AntApp>
    </ConfigProvider>
  );
}
