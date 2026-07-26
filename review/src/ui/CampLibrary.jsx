import React, { useState, useMemo } from 'react';
import { Card, Table, Tag, Button, Typography, Empty, Popconfirm, Space, Select, Modal, Input, message } from 'antd';
import { EditOutlined, FolderAddOutlined, StarFilled, DownOutlined, RightOutlined } from '@ant-design/icons';
import { getFieldDesc } from '../lib/dictionary.js';
import { groupCampEntries, campGroupOf, campGroupThresholdOf, intervalChanged, roundCampBound,
         CAMP_WIN_THRESHOLDS } from '../lib/campLibrary.js';
import { findHotInterval, findColdInterval } from '../lib/factorLab.js';

// 开区间（null 或 ±Infinity）统一判定
const isOpenBound = v => v == null || !Number.isFinite(v);
const fmtBound = v => (Number.isFinite(v) ? Number(v.toPrecision(4)) : v);
const fmtInterval = (lo, hi) => {
  if (isOpenBound(lo) && isOpenBound(hi)) return '全域';
  if (isOpenBound(lo)) return `≤ ${fmtBound(hi)}`;
  if (isOpenBound(hi)) return `≥ ${fmtBound(lo)}`;
  return `${fmtBound(lo)}~${fmtBound(hi)}`;
};

// 阵营库：跟具体策略无关的公用收藏夹——从"图表"tab 的散点图里收藏候选打分因子
// （字段/阵营/区间/权重），点"发送到策略"会把它转成一行 check 插进"策略"tab 正在编辑的代码里。
// 分组：一批收藏往往来自同一轮策略调参（比如"强势盘v1"测出来的一组因子），用分组把它们归拢，
// 可改名、可把选中的收藏挪到别的组；图表里新收藏默认落进"当前分组"（activeGroup）。
export default function CampLibrary({ library, rows = [], onRemove, onSendToStrategy,
  activeGroup, onActiveGroupChange, onRenameGroup, onMoveEntries,
  groupThresholds = {}, onSetGroupThreshold, onApplyCorrection, onApplyCorrections }) {
  // 多选批量发送/移动：onSendToStrategy 每次调用往 App 的 pendingStrategyLines 队列追加一条，
  // 同一处理器里连续调用会被 React 合并成一次更新，不需要单独的批量接口。
  const [selectedIds, setSelectedIds] = useState([]);
  const [moveTo, setMoveTo] = useState();
  const [groupModal, setGroupModal] = useState(null); // { mode:'new'|'rename', from?, value }
  const [collapsed, setCollapsed] = useState({}); // 分组名 → 是否收起（收起就只显示组头，藏掉下面的表）
  const toggleCollapse = name => setCollapsed(c => ({ ...c, [name]: !c[name] }));

  const groups = groupCampEntries(library, activeGroup ? [activeGroup] : []);
  const groupNames = groups.map(g => g.group);

  const sendSelected = () => {
    library.filter(r => selectedIds.includes(r.id)).forEach(r => onSendToStrategy(r));
    setSelectedIds([]);
  };
  const doMove = () => {
    if (!moveTo || !selectedIds.length) return;
    onMoveEntries?.(selectedIds, moveTo);
    message.success(`已把 ${selectedIds.length} 条收藏移到「${moveTo}」`);
    setSelectedIds([]); setMoveTo(undefined);
  };
  const submitGroupModal = () => {
    const name = (groupModal.value || '').trim();
    if (!name) { message.warning('分组名不能为空'); return; }
    if (groupModal.mode === 'new') onActiveGroupChange?.(name);          // 新建即设为当前收藏组
    else onRenameGroup?.(groupModal.from, name);                          // 改名
    setGroupModal(null);
  };

  // 高倍落点校验：对每条收藏，用当前数据实测"高倍盘（returnMax>该条阈值）集中在字段的哪个区间"，
  // 跟保存的区间比。有实质变化就在末列给出建议区间 + 一键"修正"。阈值逐条可调（不同因子看不同倍数）。
  // 依赖 rows/library——只在这俩变时重算；数据没加载时 calib 为空，末列显示占位。
  const calib = useMemo(() => {
    const map = {};
    if (!rows.length) return map;
    for (const e of library || []) {
      const th = campGroupThresholdOf(groupThresholds, campGroupOf(e));  // 阈值按分组取
      const find = e.camp === 'evil' ? findColdInterval : findHotInterval;
      const data = find(rows, e.field, { winThreshold: th });
      if (!data || data.error) { map[e.id] = { error: data ? data.error : '无数据' }; continue; }
      map[e.id] = { data, changed: intervalChanged({ lo: e.lo, hi: e.hi }, data) };
    }
    return map;
  }, [rows, library, groupThresholds]);

  // 有"建议区间"（实测跟保存的不一致）的收藏——供「一键修正全部」
  const correctable = useMemo(() => (library || [])
    .filter(e => calib[e.id] && calib[e.id].changed)
    .map(e => ({ id: e.id, lo: roundCampBound(calib[e.id].data.lo), hi: roundCampBound(calib[e.id].data.hi) })),
    [library, calib]);
  const applyAllCorrections = () => {
    if (!correctable.length) return;
    onApplyCorrections?.(correctable);
    message.success(`已按实测高倍落点修正 ${correctable.length} 条`);
  };

  const columns = [
    { title: '字段', dataIndex: 'field', render: v => <span title={getFieldDesc(v) || ''}>{v}</span> },
    { title: '阵营', dataIndex: 'camp', width: 90,
      render: v => v === 'evil' ? <Tag color="error">☠ 邪恶</Tag> : <Tag color="blue">🛡 勇者</Tag> },
    { title: '区间', width: 120, render: (_, r) => (
      <code style={{ fontSize: 11 }}>
        {r.lo == null ? `≤ ${r.hi}` : r.hi == null ? `≥ ${r.lo}` : `${r.lo}~${r.hi}`}
      </code>
    ) },
    { title: '权重', dataIndex: 'weight', width: 56, align: 'right' },
    { title: <span title="用当前数据回测：高倍盘（阈值在分组头部设，整组共用）实际集中在这个字段的哪个区间，跟你收藏的区间比。有变化给出建议区间，点「修正」写回">高倍落点校验</span>,
      width: 260, render: (_, r) => {
        const c = calib[r.id];
        if (!c) return <span style={{ opacity: .4 }}>先在"数据"tab 分析数据</span>;
        if (c.error) return <span style={{ opacity: .5, fontSize: 12 }} title={c.error}>数据不足，测不出（{c.error}）</span>;
        const { data, changed } = c;
        const liftTxt = `实测 ${fmtInterval(data.lo, data.hi)} · ${data.lift.toFixed(1)}x基准胜率 · 覆盖${(data.coverage * 100).toFixed(0)}%`;
        if (!changed) return <span style={{ color: '#30d158', fontSize: 12 }} title={liftTxt}>✓ 吻合（{fmtInterval(data.lo, data.hi)}）</span>;
        return (
          <Space size={6} onClick={e => e.stopPropagation()}>
            <Tag color="warning" title={liftTxt} style={{ margin: 0 }}>建议 {fmtInterval(data.lo, data.hi)}</Tag>
            <Popconfirm title={`把区间改成实测高倍落点 ${fmtInterval(data.lo, data.hi)}？`}
              onConfirm={() => onApplyCorrection?.(r.id, roundCampBound(data.lo), roundCampBound(data.hi))}>
              <Button size="small" type="link" style={{ padding: 0 }}>修正</Button>
            </Popconfirm>
          </Space>
        );
      } },
    { title: '收藏时间', width: 140, render: (_, r) => new Date(r.addedAt).toLocaleString() },
    { title: '操作', width: 170, render: (_, r) => (
      <Space size={8}>
        <Button size="small" type="primary" onClick={() => onSendToStrategy(r)}>发送到策略</Button>
        <Popconfirm title="删除这条收藏？" onConfirm={() => onRemove(r.id)}>
          <Button size="small" danger>删除</Button>
        </Popconfirm>
      </Space>
    ) },
  ];

  return (
    <Card size="small" title="阵营库"
      extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>
        从散点图收藏的候选打分因子，跟具体策略无关，可发送到"策略"tab 变成任意一份策略里的一行 check
      </Typography.Text>}>
      {/* 分组工具条：选"当前收藏组"（图表新增落进它）+ 新建分组 */}
      <Space wrap style={{ marginBottom: 10 }}>
        <StarFilled style={{ color: '#faad14' }} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>图表新收藏归入：</Typography.Text>
        <Select size="small" style={{ width: 200 }} value={activeGroup}
          onChange={onActiveGroupChange} options={groupNames.map(g => ({ value: g, label: g }))}
          placeholder="选择当前收藏分组" />
        <Button size="small" icon={<FolderAddOutlined />}
          onClick={() => setGroupModal({ mode: 'new', value: '' })}>新建分组</Button>
        {onApplyCorrections && correctable.length > 0 && (
          <Popconfirm title={`把 ${correctable.length} 条收藏的区间都改成实测的高倍落点区间？`}
            onConfirm={applyAllCorrections}>
            <Button size="small" type="primary" ghost>一键修正全部（{correctable.length}）</Button>
          </Popconfirm>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          在"图表"tab 收藏因子时，会自动归到这个分组
        </Typography.Text>
      </Space>

      {selectedIds.length > 0 && (
        <Space wrap style={{ marginBottom: 10, padding: '6px 10px', background: 'var(--surface-2,#1f1f1f)', borderRadius: 6 }}>
          <Typography.Text style={{ fontSize: 12 }}>已选 {selectedIds.length} 条</Typography.Text>
          <Button size="small" type="primary" onClick={sendSelected}>批量发送到策略</Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>移动到：</Typography.Text>
          <Select size="small" style={{ width: 180 }} value={moveTo} onChange={setMoveTo}
            placeholder="选择目标分组" options={groupNames.map(g => ({ value: g, label: g }))} />
          <Button size="small" disabled={!moveTo} onClick={doMove}>确认移动</Button>
          <Button size="small" type="text" onClick={() => setSelectedIds([])}>取消选择</Button>
        </Space>
      )}

      {!library.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<>还没有收藏。去"图表"tab 的散点图里，点某张图右上角的"收藏为打分因子"</>} />
      ) : (
        groups.map(g => (
          <div key={g.group} style={{ marginBottom: 16 }}>
            <Space style={{ marginBottom: 6 }}>
              {/* 点组头（图标/名字）收起或展开这个分组，收藏多时（比如 36 条）可以先折起来 */}
              <Typography.Text strong style={{ fontSize: 13, cursor: 'pointer', userSelect: 'none' }}
                onClick={() => toggleCollapse(g.group)}>
                {collapsed[g.group] ? <RightOutlined style={{ fontSize: 11 }} /> : <DownOutlined style={{ fontSize: 11 }} />}
                {' '}📁 {g.group}
              </Typography.Text>
              <Tag>{g.count} 条</Tag>
              {activeGroup === g.group
                ? <Tag color="gold">当前收藏组</Tag>
                : <Button size="small" type="link" onClick={() => onActiveGroupChange?.(g.group)}>设为当前</Button>}
              <Button size="small" type="text" icon={<EditOutlined />}
                onClick={() => setGroupModal({ mode: 'rename', from: g.group, value: g.group })}>改名</Button>
              {/* 高倍阈值：整组一个，改了整组的"高倍落点校验"都按这个倍数重算 */}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>高倍阈值</Typography.Text>
              <Select size="small" style={{ width: 76 }} value={campGroupThresholdOf(groupThresholds, g.group)}
                onChange={v => onSetGroupThreshold?.(g.group, v)}
                options={CAMP_WIN_THRESHOLDS.map(t => ({ value: t, label: `>${t}x` }))} />
              {g.count > 0 && (
                <Button size="small" type="link" onClick={() => toggleCollapse(g.group)}>
                  {collapsed[g.group] ? '展开' : '收起'}
                </Button>
              )}
            </Space>
            {collapsed[g.group] ? null : g.count === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', paddingLeft: 8 }}>
                空分组——去"图表"tab 收藏因子会落进这里（当前收藏组），或把别的收藏移动过来
              </Typography.Text>
            ) : (
              <Table size="small" rowKey="id" pagination={false} dataSource={g.entries} columns={columns}
                rowSelection={{ selectedRowKeys: selectedIds, onChange: setSelectedIds, preserveSelectedRowKeys: true }} />
            )}
          </div>
        ))
      )}

      <Modal open={!!groupModal} onCancel={() => setGroupModal(null)} onOk={submitGroupModal}
        okText="确定" cancelText="取消"
        title={groupModal?.mode === 'rename' ? `分组改名：${groupModal.from}` : '新建分组（并设为当前收藏组）'}>
        <Input autoFocus value={groupModal?.value || ''} placeholder="分组名，比如 强势盘v1"
          onChange={e => setGroupModal(m => ({ ...m, value: e.target.value }))}
          onPressEnter={submitGroupModal} />
      </Modal>
    </Card>
  );
}
