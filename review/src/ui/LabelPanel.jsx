import React from 'react';
import { Card, Table, Tag, Button, Space, Typography, Empty, message, Popconfirm } from 'antd';
import { DownloadOutlined, ClearOutlined } from '@ant-design/icons';
import { junkList, goodList } from '../lib/labels.js';
import { logearnUrl } from '../lib/utils.js';
import { downloadText } from '../lib/download.js';

// 人工标注管理：列出所有已标记的代币，支持黑名单导出；下面另有一块"已删除样本"——
// 那是彻底从工作集拿掉的（跟标垃圾不是一回事，标垃圾只降级 returnMax，样本还在），
// 这里只负责展示 + 恢复，删除动作本身在各分析面板的样本表里（比如策略回放的逐样本明细）。
export default function LabelPanel({ rows, labels, onLabel, onClearAll, excludedTokens = [], onUnexclude }) {
  const junk = junkList(labels);
  const good = goodList(labels);
  const byCa = new Map(rows.map(r => [String(r.tokenAddress).toLowerCase(), r]));

  const data = [...junk.map(ca => ({ ca, label: 'junk' })), ...good.map(ca => ({ ca, label: 'good' }))]
    .map(x => {
      const r = byCa.get(x.ca);
      return { key: x.ca, ca: x.ca, label: x.label,
        symbol: r?.symbol || '(不在当前数据里)',
        raw: r?.returnMaxRaw ?? r?.returnMax, eff: r?.returnMax };
    });

  function exportBlacklist() {
    if (!junk.length) { message.warning('还没有标记为垃圾的代币'); return; }
    const text = junk.join('\n');
    downloadText(text, `黑名单_${junk.length}个_${new Date().toISOString().slice(0, 10)}.txt`);
    message.success(`已导出 ${junk.length} 个黑名单 CA`);
  }

  const columns = [
    { title: '标记', dataIndex: 'label', width: 90,
      render: v => (v === 'junk' ? <Tag color="error">垃圾</Tag> : <Tag color="success">优良</Tag>) },
    { title: 'symbol', dataIndex: 'symbol', width: 130 },
    { title: 'CA', dataIndex: 'ca', width: 280,
      render: v => <a href={logearnUrl(v)} target="_blank" rel="noopener noreferrer"><code style={{ fontSize: 11 }}>{v}</code></a> },
    { title: 'returnMax', width: 150, align: 'right', render: (_, r) => r.raw == null ? '-'
      : r.label === 'junk'
        ? <span><s style={{ opacity: .5 }}>{Number(r.raw).toFixed(2)}x</s> → <b style={{ color: '#ff9f0a' }}>{Number(r.eff).toFixed(2)}x</b></span>
        : <b>{Number(r.eff).toFixed(2)}x</b> },
    { title: '', width: 80, render: (_, r) => <Button size="small" onClick={() => onLabel(r.ca, null)}>取消</Button> },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
    <Card size="small" title={<Space>人工标注
      <Tag color="error">垃圾 {junk.length}</Tag><Tag color="success">优良 {good.length}</Tag></Space>}
      extra={<Space>
        <Button icon={<DownloadOutlined />} onClick={exportBlacklist} disabled={!junk.length}>导出黑名单</Button>
        <Button danger icon={<ClearOutlined />} onClick={onClearAll} disabled={!data.length}>清空全部标注</Button>
      </Space>}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        标为「垃圾」的代币，returnMax 会被降级成保本（1.0x）——一个 10x 可能只是扎针，
        标记后所有分析（胜率/中位数/策略回放的每条 check 效果）都按降级后的真实收益重算，不再被假针撑高。
        在「数据与过滤」的<b>快照速查</b>里选中某个 CA 就能打标。标注存在本地浏览器，跨会话保留。
      </Typography.Paragraph>
      {data.length === 0
        ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有标注。去快照速查里给可疑代币打标（比如扎针的假 10x）" />
        : <Table size="small" columns={columns} dataSource={data} pagination={{ pageSize: 15, size: 'small' }} />}
    </Card>
    <Card size="small" title={<Space>已删除样本<Tag color="default">{excludedTokens.length}</Tag></Space>}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        这里的删除是彻底从工作集拿掉（样本数 n 会变小），跟上面的"标垃圾"不是一回事——常见场景：
        同一笔交易被多天导入批次重复记录，多出来的那几条得整条剔除才对，标垃圾只降级 returnMax、
        样本还在，解决不了这个问题。删除入口在各分析面板的样本明细表里（比如策略回放的逐样本明细）。
      </Typography.Paragraph>
      {excludedTokens.length === 0
        ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有删除任何样本" />
        : <Table size="small" rowKey="ca" pagination={{ pageSize: 15, size: 'small' }}
            dataSource={excludedTokens.slice().sort((a, b) => b.excludedAt - a.excludedAt)}
            columns={[
              { title: 'symbol', dataIndex: 'symbol', width: 130, render: v => v || '-' },
              { title: 'CA', dataIndex: 'ca', width: 280,
                render: v => <a href={logearnUrl(v)} target="_blank" rel="noopener noreferrer"><code style={{ fontSize: 11 }}>{v}</code></a> },
              { title: '删除时间', dataIndex: 'excludedAt', width: 160,
                render: v => new Date(v).toLocaleString('zh-CN', { hour12: false }) },
              { title: '', width: 80, render: (_, r) => (
                <Popconfirm title="恢复这条样本？会重新计入工作集" onConfirm={() => onUnexclude(r.ca)}>
                  <Button size="small">恢复</Button>
                </Popconfirm>
              ) },
            ]} />}
    </Card>
    </Space>
  );
}
