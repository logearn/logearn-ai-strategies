import React from 'react';
import { Card, Button, Table, Alert, Input, Typography } from 'antd';

const fmtPct = v => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-');

// 对比现有硬门槛策略：把现有策略代码在全部样本上回放，与新打分（≥cutoff 触发）对比命中集质量。
// compare 的推导（compareWithHardGate）留在 FactorLab（依赖 backtest/replay 两份 state），
// 这里只管展示对比表。
export default function CompareHardGateCard({ strategySrc, setStrategySrc, replayBusy, onReplay,
  replay, compare, threshold, cutoff }) {
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
    <Card size="small" title="对比现有硬门槛策略"
      extra={<Button loading={replayBusy} onClick={onReplay}>回放对比</Button>}>
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
    </Card>
  );
}
