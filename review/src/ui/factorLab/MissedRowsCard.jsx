import React from 'react';
import { Card, Button, Table, Tag, Tooltip, Typography } from 'antd';
import { getFieldDesc } from '../../lib/dictionary.js';
import { getFeature } from '../../lib/data.js';
import { formatNumberSmart } from '../../lib/utils.js';

const fmtBound = v => (v === -Infinity ? '-∞' : v === Infinity ? '∞' : formatNumberSmart(v));

// 低分高倍复盘（漏网之鱼）：分数没过触发线（用「回测」卡片同一个 cutoff）却真的翻倍的样本——
// 当前因子池对它们基本没识别出来，是排查"漏因子/区间没覆盖/权重太小/数据缺失"的重点对象。
// missedRows 的推导（依赖 backtest.scored）留在 FactorLab，这里只管展示 + 展开行看单因子明细。
export default function MissedRowsCard({ missedRows, factors, threshold, cutoff, onCopy }) {
  const missedColumns = [
    { title: 'CA', dataIndex: ['row', 'tokenAddress'], width: 220,
      render: v => v ? <code style={{ fontSize: 11 }}>{v}</code> : <Typography.Text type="secondary">-</Typography.Text> },
    { title: 'symbol', dataIndex: ['row', 'symbol'], width: 100 },
    { title: '得分', dataIndex: 'score', width: 80, align: 'right',
      sorter: (a, b) => a.score - b.score, render: v => v.toFixed(1) },
    { title: `倍数（>${threshold}x 触发线）`, width: 120, align: 'right',
      sorter: (a, b) => Number(a.row.returnMax) - Number(b.row.returnMax),
      render: (_, s) => Number(s.row.returnMax).toFixed(2) + 'x' },
    { title: '缺失因子数', width: 90, align: 'right',
      render: (_, s) => factors.filter(f => !Number.isFinite(getFeature(s.row, f.field))).length },
  ];
  // 展开行：逐因子给出取值/命中度/该因子对总分的实际贡献——判断"漏因子/区间没覆盖/权重太小/数据缺失"
  // 就看这张明细：命中度接近 0 且有取值＝区间没覆盖；取值缺失＝数据缺失；命中度高但贡献小＝权重太小。
  function renderMissedFactorDetail(s) {
    const cols = [
      { title: '字段', dataIndex: 'field', width: 200,
        render: v => <Tooltip title={getFieldDesc(v)}><code style={{ fontSize: 11 }}>{v}</code></Tooltip> },
      { title: '阵营', dataIndex: 'camp', width: 70,
        render: v => v === 'evil' ? <Tag color="error">邪恶</Tag> : <Tag color="success">勇者</Tag> },
      { title: '取值', width: 100, render: (_, f) => {
        const v = getFeature(s.row, f.field);
        return Number.isFinite(Number(v)) ? formatNumberSmart(Number(v)) : <Typography.Text type="danger">缺失</Typography.Text>;
      } },
      { title: '核心区 [lo1,hi1]', width: 160, render: (_, f) => `[${fmtBound(f.lo1)}, ${fmtBound(f.hi1)}]` },
      { title: '命中度', width: 80, align: 'right', render: (_, f) => {
        const i = factors.indexOf(f);
        const hit = s.perFactor[i];
        return Number.isFinite(hit) ? Math.abs(hit).toFixed(2) : '-';
      } },
      { title: '权重', dataIndex: 'weight', width: 70, align: 'right' },
      { title: '实际贡献', width: 90, align: 'right', render: (_, f) => {
        const i = factors.indexOf(f);
        const hit = s.perFactor[i];
        return Number.isFinite(hit) ? (hit * f.weight).toFixed(1) : '-';
      } },
    ];
    return <Table size="small" rowKey={f => f.camp + ':' + f.field} columns={cols} dataSource={factors}
      pagination={false} scroll={{ x: 700 }} />;
  }

  return (
    <Card size="small" title={`低分高倍复盘（漏网之鱼，共 ${missedRows.length} 个）`}
      extra={<Button disabled={!missedRows.length} onClick={onCopy}>
        复制 {missedRows.length} 个 CA
      </Button>}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        分数 &lt; {cutoff}（当前"回测"卡片的触发阈值）但实际 &gt;{threshold}x 的样本——当前因子池对它们
        基本没识别出来，是排查"漏因子 / 区间没覆盖 / 权重太小 / 数据缺失"的重点对象。点开一行看每个
        已选因子在这个样本上的取值、命中度与实际贡献；也可以复制 CA 贴到下方散点图的查找框里高亮定位。
      </Typography.Paragraph>
      {missedRows.length === 0
        ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>当前 cutoff 下没有漏网之鱼。</Typography.Text>
        : <Table size="small" rowKey={s => s.row.id} columns={missedColumns} dataSource={missedRows}
            expandable={{ expandedRowRender: renderMissedFactorDetail }}
            pagination={{ pageSize: 10, size: 'small' }} scroll={{ x: 700 }} />}
    </Card>
  );
}
