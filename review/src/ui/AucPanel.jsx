import React, { useState } from 'react';
import { Card, Button, Table, Tag, Tooltip, Typography, Space } from 'antd';
import { scanFieldsAuc } from '../lib/auc.js';
import { getFieldDesc } from '../lib/dictionary.js';
import { loadHiddenFields, saveHiddenFields, addHidden, removeHidden, filterHidden } from '../lib/tableHiddenFields.js';
import HiddenFieldsBar from './HiddenFieldsBar.jsx';

export default function AucPanel({ rows, fields }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(() => loadHiddenFields('auc'));
  const hide = f => { const n = addHidden(hidden, f); setHidden(n); saveHiddenFields('auc', n); };
  const restore = f => { const n = removeHidden(hidden, f); setHidden(n); saveHiddenFields('auc', n); };
  const restoreAll = () => { setHidden([]); saveHiddenFields('auc', []); };

  async function run() {
    setBusy(true);
    await new Promise(r => setTimeout(r, 0));   // 让出一帧，按钮 loading 才能画出来
    try { setResult(scanFieldsAuc(rows, fields, { bootstrapB: 300 })); }
    finally { setBusy(false); }
  }

  const columns = [
    { title: '字段', dataIndex: 'field', width: 240, fixed: 'left',
      render: v => <code style={{ fontSize: 11 }}>{v}</code> },
    { title: '含义', width: 240, ellipsis: true,
      render: (_, r) => <Tooltip title={getFieldDesc(r.field)}>
        <span style={{ opacity: .65 }}>{getFieldDesc(r.field)}</span></Tooltip> },
    { title: 'AUC', dataIndex: 'auc', width: 90, align: 'right',
      defaultSortOrder: 'descend',
      sorter: (a, b) => Math.abs(a.auc - .5) - Math.abs(b.auc - .5),
      render: v => v.toFixed(4) },
    { title: '95% CI', width: 150, align: 'right',
      render: (_, r) => `${r.ci.lo.toFixed(3)} ~ ${r.ci.hi.toFixed(3)}` },
    { title: '方向', dataIndex: 'direction', width: 90,
      render: v => (v === 'high' ? '值大更好' : '值小更好') },
    { title: 'n', dataIndex: 'n', width: 70, align: 'right', sorter: (a, b) => a.n - b.n },
    { title: '校正后 p', dataIndex: 'pAdj', width: 100, align: 'right',
      sorter: (a, b) => (a.pAdj ?? 1) - (b.pAdj ?? 1),
      render: v => (Number.isFinite(v) ? v.toExponential(2) : '-') },
    { title: '判定', width: 130, render: (_, r) => r.significantAdj
      ? <Tag color="success">校正后显著</Tag>
      : r.significant
        ? <Tooltip title="未经多重比较校正，批量扫描时这一档有大量假阳性"><Tag color="warning">仅未校正显著</Tag></Tooltip>
        : <Tag>不显著</Tag> },
    { title: '', width: 60, fixed: 'right', render: (_, r) => (
      <Button size="small" type="link" danger style={{ padding: 0 }}
        title="从本表移除该字段（只在 AUC 表隐藏，可在表头「恢复」里加回来）"
        onClick={() => hide(r.field)}>移除</Button>
    ) },
  ];

  return (
    <Card size="small" title="AUC 批量检测"
      extra={<Space>
        <HiddenFieldsBar hidden={hidden} onRestore={restore} onRestoreAll={restoreAll} />
        {result && <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {result.usable.length} 个可用 / {result.results.length} 个</Typography.Text>}
        <Button type="primary" loading={busy} onClick={run} disabled={!rows.length || !fields.length}>
          检测全部 {fields.length} 个字段</Button>
      </Space>}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
        AUC 衡量"按该字段排序能否把赢家排在输家前面"：0.5 = 完全没区分度。比相关系数更抗收益的极端右尾。
        批量扫描时单看「CI 不跨 0.5」会有大量假阳性，所以额外给出 BH 校正后的判定。
      </Typography.Paragraph>
      {result && (
        <>
          <Table size="small" rowKey="field" columns={columns} dataSource={filterHidden(result.usable, hidden, r => r.field)}
            scroll={{ x: 1100, y: 400 }} pagination={{ pageSize: 30, size: 'small' }} />
          {result.results.filter(r => r.reason).length > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              未参与检验：{result.results.filter(r => r.reason).map(r => `${r.field}（${r.reason}）`).join('；')}
            </Typography.Text>
          )}
        </>
      )}
    </Card>
  );
}
