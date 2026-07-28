import React, { useMemo, useState } from 'react';
import { Card, Table, Select, InputNumber, Space, Tag, Tooltip, Typography, Button, Switch } from 'antd';
import { computeCorrelations } from '../lib/data.js';
import { getFieldDesc } from '../lib/dictionary.js';
import { loadHiddenFields, saveHiddenFields, addHidden, removeHidden, filterHidden } from '../lib/tableHiddenFields.js';
import HiddenFieldsBar from './HiddenFieldsBar.jsx';

const TARGETS = ['returnMax', 'logReturnMax'];
const num = (v, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : '-');

export default function CorrTable({ rows }) {
  const [target, setTarget] = useState('returnMax');
  const [minQuality, setMinQuality] = useState(0);
  // 只看显著：按主指标 Spearman ρ 的 p 值筛（p.p，见 computeCorrelations），不是线性 r 的 p——
  // 用户反馈过"p 数值不对"就是因为之前这列算的是 r 的 p，跟加★的 ρ 对不上。
  const [onlySignificant, setOnlySignificant] = useState(false);
  const [hidden, setHidden] = useState(() => loadHiddenFields('corr'));
  const hide = f => { const n = addHidden(hidden, f); setHidden(n); saveHiddenFields('corr', n); };
  const restore = f => { const n = removeHidden(hidden, f); setHidden(n); saveHiddenFields('corr', n); };
  const restoreAll = () => { setHidden([]); saveHiddenFields('corr', []); };
  const all = useMemo(() => (rows.length ? computeCorrelations(rows) : []), [rows]);
  const list = useMemo(
    () => filterHidden(all.filter(x => x.target === target && (x.quality ?? 100) >= minQuality
      && (!onlySignificant || (Number.isFinite(x.p) && x.p < 0.05))), hidden, r => r.feature),
    [all, target, minQuality, onlySignificant, hidden]);

  // 候选池治理摘要：这些字段不是"测了不显著"，是根本没进检验。
  // 说清楚很重要——多重比较校正的 m 按参与检验的字段数算，池子越干净真信号越容易冒头。
  const ex = all._excluded;
  const exLabels = { timestamp: '时间戳', internal: '内部标记', metadata: '元数据/常量', constant: '取值恒定' };
  const exEntries = ex ? Object.entries(ex).filter(([, v]) => Array.isArray(v) && v.length) : [];
  const exTotal = exEntries.reduce((n, [, v]) => n + v.length, 0);

  const columns = [
    { title: '字段', dataIndex: 'feature', width: 240, fixed: 'left',
      render: v => <code style={{ fontSize: 11 }}>{v}</code>,
      sorter: (a, b) => a.feature.localeCompare(b.feature) },
    { title: '中文含义', width: 260, ellipsis: true,
      render: (_, r) => <Tooltip title={getFieldDesc(r.feature)}>
        <span style={{ opacity: .65 }}>{getFieldDesc(r.feature)}</span></Tooltip> },
    { title: <Tooltip title="综合覆盖率/样本量/离群敏感性/线性一致性/时间稳定性的 0-100 评分">质量分</Tooltip>,
      dataIndex: 'quality', width: 90, align: 'right',
      sorter: (a, b) => (a.quality ?? 0) - (b.quality ?? 0),
      render: (v, r) => <Tooltip title={(r.qualityReasons || []).join('\n')}>{v ?? '-'}</Tooltip> },
    { title: <Tooltip title="Spearman 秩相关（主）——对 meme 极端右尾更可靠，默认按它排序。找因子以它 / AUC / 波峰为准">Spearman ρ ★</Tooltip>,
      dataIndex: 'rho', width: 120, align: 'right', defaultSortOrder: 'descend',
      sorter: (a, b) => Math.abs(a.rho ?? 0) - Math.abs(b.rho ?? 0), render: v => <b>{num(v)}</b> },
    { title: <Tooltip title="线性皮尔逊 r（仅参考）——对极端右尾会被少数高倍盘拉飞，容易误导，别单看它下结论">r · 参考</Tooltip>,
      dataIndex: 'r', width: 90, align: 'right',
      sorter: (a, b) => Math.abs(a.r ?? 0) - Math.abs(b.r ?? 0),
      render: v => <span style={{ opacity: .5 }}>{num(v)}</span> },
    { title: 'n', dataIndex: 'n', width: 70, align: 'right', sorter: (a, b) => a.n - b.n },
    { title: <Tooltip title="Spearman ρ 的双侧 p 值（Fisher z 变换近似）——对应加★的主指标，不是 r·参考 那一列的显著性">p</Tooltip>,
      dataIndex: 'p', width: 100, align: 'right',
      sorter: (a, b) => (Number.isFinite(a.p) ? a.p : 2) - (Number.isFinite(b.p) ? b.p : 2),
      render: v => <span style={{ color: Number.isFinite(v) && v < 0.05 ? '#30d158' : undefined }}>
        {Number.isFinite(v) ? v.toExponential(2) : '-'}
      </span> },
    { title: '提示', width: 150, render: (_, r) => <>
        {r.outlierDriven && <Tag color="warning" title="去掉极端值后相关性大幅变化，是被少数离群点带出来的">离群驱动</Tag>}
        {r.unstable && <Tag color="warning" title="前后两半数据的相关性方向或强度差异明显">不稳定</Tag>}
      </> },
    { title: '', width: 60, fixed: 'right', render: (_, r) => (
      <Button size="small" type="link" danger style={{ padding: 0 }}
        title="从本表移除该字段（只在相关性排行隐藏，可在表头「恢复」里加回来）"
        onClick={() => hide(r.feature)}>移除</Button>
    ) },
  ];

  if (!rows.length) return null;
  return (
    <Card size="small" title="相关性排行"
      extra={<Space>
        <HiddenFieldsBar hidden={hidden} onRestore={restore} onRestoreAll={restoreAll} />
        <Select size="small" value={target} onChange={setTarget} style={{ width: 140 }}
          options={TARGETS.map(t => ({ value: t, label: t }))} />
        <span style={{ fontSize: 12 }}>质量分 ≥</span>
        <InputNumber size="small" min={0} max={100} value={minQuality} onChange={v => setMinQuality(v || 0)} style={{ width: 70 }} />
        <Tooltip title="按 Spearman ρ 的 p 值筛（p<0.05），未经多重比较校正——字段多时假阳性会偏多，仅作粗筛">
          <Space size={4}>
            <Switch size="small" checked={onlySignificant} onChange={setOnlySignificant} />
            <span style={{ fontSize: 12 }}>仅显著（p&lt;0.05）</span>
          </Space>
        </Tooltip>
      </Space>}>
      {exTotal > 0 && (
        <Tooltip title={exEntries.map(([k, v]) => `${exLabels[k] || k}：${v.join('、')}`).join('\n')}>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            另有 {exTotal} 个无效字段已自动剔除、不占检验名额（
            {exEntries.map(([k, v]) => `${exLabels[k] || k} ${v.length}`).join('、')}）—— 悬浮看具体字段
          </Typography.Text>
        </Tooltip>
      )}
      <Table size="small" rowKey="feature" columns={columns} dataSource={list}
        scroll={{ x: 1100, y: 420 }} pagination={{ pageSize: 50, showSizeChanger: true, size: 'small' }} />
    </Card>
  );
}
