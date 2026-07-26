import React, { useState } from 'react';
import { Card, Button, Table, Tag, Tooltip, Typography, Space, Alert } from 'antd';
import { scanFieldsForPeaks, requiredPermN } from '../lib/analytics.js';
import { collinearityReport } from '../lib/proAnalytics.js';
import { getFieldDesc } from '../lib/dictionary.js';
import { loadHiddenFields, saveHiddenFields, addHidden, removeHidden, filterHidden } from '../lib/tableHiddenFields.js';
import HiddenFieldsBar from './HiddenFieldsBar.jsx';

// 字段体检：一次回答两个问题——
//   1) 哪些字段存在真实的"甜蜜区间"（非单调关系，相关系数看不出来）
//   2) 哪些字段其实是彼此的复制品（共线性），留着只会稀释多重比较校正
export default function FieldHealth({ rows, fields }) {
  const [peaks, setPeaks] = useState(null);
  const [vif, setVif] = useState(null);
  const [busy, setBusy] = useState('');
  const [hidden, setHidden] = useState(() => loadHiddenFields('health'));
  const hide = f => { const n = addHidden(hidden, f); setHidden(n); saveHiddenFields('health', n); };
  const restore = f => { const n = removeHidden(hidden, f); setHidden(n); saveHiddenFields('health', n); };
  const restoreAll = () => { setHidden([]); saveHiddenFields('health', []); };
  const removeCol = { title: '', width: 56, fixed: 'right', render: (_, r) => (
    <Button size="small" type="link" danger style={{ padding: 0 }}
      title="从字段体检移除该字段（只在本面板隐藏，可在表头「恢复」里加回来）"
      onClick={() => hide(r.field)}>移除</Button>) };

  async function runPeaks() {
    setBusy('peaks'); await new Promise(r => setTimeout(r, 0));
    try {
      // 置换次数必须随字段数放大：m 个字段做 BH 校正需要 p 取到 <0.05/m，
      // 而置换 p 的下限是 1/(permN+1)。固定 200 次时 43 个字段就已数学上不可能显著。
      setPeaks(scanFieldsForPeaks(rows, fields, 'returnMax', Math.max(200, requiredPermN(fields.length)), 2));
    } finally { setBusy(''); }
  }
  async function runVif() {
    setBusy('vif'); await new Promise(r => setTimeout(r, 0));
    try {
      // returnMax 与 logReturnMax 互为单调变换，VIF 必然偏高，但那是定义决定的不是字段冗余
      const T = new Set(['returnMax', 'logReturnMax']);
      setVif(collinearityReport(rows, fields.filter(f => !T.has(f)).slice(0, 25)));
    } finally { setBusy(''); }
  }

  const peakCols = [
    { title: '字段', dataIndex: 'field', width: 220, fixed: 'left', render: v => <code style={{ fontSize: 11 }}>{v}</code> },
    { title: '含义', width: 220, ellipsis: true,
      render: (_, r) => <Tooltip title={getFieldDesc(r.field)}><span style={{ opacity: .65 }}>{getFieldDesc(r.field)}</span></Tooltip> },
    { title: '波峰区间', width: 190, render: (_, r) => Array.isArray(r.seg)
      ? <code style={{ fontSize: 11 }}>{Number(r.seg[0]).toPrecision(4)} ~ {Number(r.seg[1]).toPrecision(4)}</code> : '-' },
    { title: <Tooltip title="该区间里连续高于整体胜率的滑窗长度（样本数），越长说明优势越成片而不是零星">连续优势</Tooltip>,
      dataIndex: 'obs', width: 100, align: 'right', render: v => (Number.isFinite(v) ? `${v} 条` : '-') },
    { title: <Tooltip title="把标签打散后同样能凑出的长度的 95 分位——观测值要明显超过它才算数">随机基线</Tooltip>,
      dataIndex: 'perm95', width: 100, align: 'right', render: v => (Number.isFinite(v) ? v.toFixed(1) + ' 条' : '-') },
    { title: '整体胜率', dataIndex: 'base', width: 90, align: 'right',
      render: v => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-') },
    { title: '校正后 p', dataIndex: 'adjP', width: 100, align: 'right',
      defaultSortOrder: 'ascend', sorter: (a, b) => (a.adjP ?? 1) - (b.adjP ?? 1),
      render: v => (Number.isFinite(v) ? v.toFixed(3) : '-') },
    { title: '判定', width: 130, render: (_, r) => r.adjP < 0.05
      ? <Tag color="success">校正后显著</Tag>
      : r.p < 0.05 ? <Tooltip title="未经多重比较校正"><Tag color="warning">仅未校正显著</Tag></Tooltip> : null },
    removeCol,
  ];

  const vifCols = [
    { title: '字段', dataIndex: 'field', render: v => <code style={{ fontSize: 11 }}>{v}</code> },
    { title: 'VIF', dataIndex: 'vif', width: 110, align: 'right',
      render: v => (v === Infinity ? '∞' : v.toFixed(2)) },
    { title: '判定', width: 200, render: (_, r) => (r.vif === Infinity || r.vif > 10)
      ? <Tag color="error">严重共线，建议只留一个</Tag>
      : r.vif > 5 ? <Tag color="warning">中度</Tag> : <Tag color="success">独立</Tag> },
    removeCol,
  ];

  return (
    <Card size="small" title="字段体检"
      extra={<Space>
        <HiddenFieldsBar hidden={hidden} onRestore={restore} onRestoreAll={restoreAll} />
        <Button type="primary" loading={busy === 'peaks'} onClick={runPeaks} disabled={!!busy || !rows.length}>
          波峰扫描（{fields.length} 个字段）</Button>
        <Button loading={busy === 'vif'} onClick={runVif} disabled={!!busy || !rows.length}>共线性诊断（VIF）</Button>
      </Space>}>
      {peaks && (
        <>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            找的是"某个区间胜率明显高于整体"这种<b>非单调</b>关系——相关系数对这种形态基本失灵。
            衡量方式是<b>连续优势长度</b>：滑窗胜率高于整体基准的最长连续段有多少条样本。
            光看长度会被噪声骗（滑窗自带自相关，纯噪声也能凑出约一个窗口宽的连续段），所以要和打散标签后的随机基线比。
            本次扫了 {peaks.scanned} 个字段、每个 {peaks.effPermN} 次置换。
          </Typography.Paragraph>
          <Table size="small" rowKey="field" columns={peakCols} dataSource={filterHidden(peaks.rows, hidden)}
            scroll={{ x: 1150, y: 340 }} pagination={{ pageSize: 30, size: 'small' }} />
        </>
      )}
      {vif && (vif.error
        ? <Alert style={{ marginTop: 12 }} type="warning" showIcon message={vif.error} />
        : <>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
              VIF = 该字段能被其余字段线性解释的程度。<b>VIF &gt; 10 一般视为严重共线</b>，
              ∞ 表示已经是其余字段的线性组合（同一个信息重复计了好几次）。
              留着这些字段不会带来新信息，只会抬高多重比较校正的 m、把真信号的校正后 p 拖垮。
              基于 {vif.n} 条完整个案{vif.dropped?.length > 0 && <>；已剔除零方差字段：{vif.dropped.join('、')}</>}。
            </Typography.Paragraph>
            <Table size="small" rowKey="field" columns={vifCols} dataSource={filterHidden(vif.results, hidden)}
              pagination={false} scroll={{ y: 260 }} />
          </>)}
    </Card>
  );
}
