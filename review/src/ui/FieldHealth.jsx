import React, { useState } from 'react';
import { Card, Button, Table, Tag, Typography, Space, Alert } from 'antd';
import { collinearityReport } from '../lib/proAnalytics.js';
import { loadHiddenFields, saveHiddenFields, addHidden, removeHidden, filterHidden } from '../lib/tableHiddenFields.js';
import HiddenFieldsBar from './HiddenFieldsBar.jsx';

// 字段体检：哪些字段其实是彼此的复制品（共线性），留着只会稀释多重比较校正。
// 2026-07-29：原来还有一半"波峰扫描"（scanFieldsForPeaks，找非单调"甜蜜区间"），跟 FactorLab
// 自己的 findHotInterval 回答同一个问题——后者统计量更严谨（wilson下界×√coverage，直接喂进
// 打分因子），前者是纯只读发现工具、结果不接回任何后续步骤，删掉了（连同 lib/analytics.js 里
// 只服务它的 scanFieldsForPeaks/permutationPeakTest/longestAboveRun/requiredPermN 一并删除）。
export default function FieldHealth({ rows, fields }) {
  const [vif, setVif] = useState(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(() => loadHiddenFields('health'));
  const hide = f => { const n = addHidden(hidden, f); setHidden(n); saveHiddenFields('health', n); };
  const restore = f => { const n = removeHidden(hidden, f); setHidden(n); saveHiddenFields('health', n); };
  const restoreAll = () => { setHidden([]); saveHiddenFields('health', []); };
  const removeCol = { title: '', width: 56, fixed: 'right', render: (_, r) => (
    <Button size="small" type="link" danger style={{ padding: 0 }}
      title="从字段体检移除该字段（只在本面板隐藏，可在表头「恢复」里加回来）"
      onClick={() => hide(r.field)}>移除</Button>) };

  async function runVif() {
    setBusy(true); await new Promise(r => setTimeout(r, 0));
    try {
      // returnMax 与 logReturnMax 互为单调变换，VIF 必然偏高，但那是定义决定的不是字段冗余
      const T = new Set(['returnMax', 'logReturnMax']);
      setVif(collinearityReport(rows, fields.filter(f => !T.has(f)).slice(0, 25)));
    } finally { setBusy(false); }
  }

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
    <Card size="small" title="字段体检（共线性诊断 VIF）"
      extra={<Space>
        <HiddenFieldsBar hidden={hidden} onRestore={restore} onRestoreAll={restoreAll} />
        <Button type="primary" loading={busy} onClick={runVif} disabled={busy || !rows.length}>共线性诊断（VIF）</Button>
      </Space>}>
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
