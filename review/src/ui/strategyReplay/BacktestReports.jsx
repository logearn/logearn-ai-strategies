import React, { useState } from 'react';
import { Space, Input, Button, Table, Popconfirm, Typography, message, Modal } from 'antd';
import { loadBacktestReports, saveBacktestReports, addBacktestReport,
         removeBacktestReport, todayDateStr } from '../../lib/backtestReports.js';
import { median } from '../../lib/utils.js';
import PlotlyChart from '../PlotlyChart.jsx';
import { plotColors } from '../../theme.js';

const fmtPct = v => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-');
const fmtNum = (v, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits) : '-');

// 把当前这次回放的聚合结果压成一份可存档的快照——只留核心统计量和这次用的策略代码，
// 不留逐样本明细（明细能从代码 + 当时的数据源原样重新跑一遍拿到，没必要重复占地方）。
function buildMetrics({ agg, scoreAgg, scoreReturnStats, scoreBuckets }) {
  return {
    total: agg.total,
    hits: agg.hits,
    hitRate: agg.valid ? agg.hits / agg.valid : null,
    hitMedian: agg.hitRets.length ? median(agg.hitRets) : null,
    missMedian: agg.missRets.length ? median(agg.missRets) : null,
    cutoff: Number.isFinite(scoreAgg?.cutoff) ? scoreAgg.cutoff : null,
    scoreReturn: (scoreReturnStats && !scoreReturnStats.constant)
      ? { n: scoreReturnStats.n, rRaw: scoreReturnStats.rRaw, pRaw: scoreReturnStats.pRaw,
          rLog: scoreReturnStats.rLog, pLog: scoreReturnStats.pLog, rho: scoreReturnStats.rho }
      : null,
    monotonicity: scoreBuckets ? { rho: scoreBuckets.rho, K: scoreBuckets.K } : null,
    // 阵营因子明细留着不在这版界面展示，是给以后做"逐因子跨天对比"这类更细的功能预留的——
    // 反正数据已经算好了，存下来不费事，没有就得等真的需要那天回去重新跑历史数据才能补上。
    campFactors: scoreAgg?.factors ?? null,
  };
}

// 每日回测报告存档 + 跨天对比：手动把当前这次"策略回放看板"的结果存一份快照，
// 攒够几天之后挑几份对比，看策略/数据的效果是在变好还是变差。
export default function BacktestReports({ agg, scoreAgg, scoreReturnStats, scoreBuckets, code, light, onSaved }) {
  const [reports, setReports] = useState(loadBacktestReports);
  const [date, setDate] = useState(todayDateStr);
  const [note, setNote] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [compareOpen, setCompareOpen] = useState(false);

  const canSave = !!agg;

  const handleSave = () => {
    if (!canSave || !date.trim()) return;
    const metrics = buildMetrics({ agg, scoreAgg, scoreReturnStats, scoreBuckets });
    const next = addBacktestReport(reports, { date: date.trim(), code, note, metrics });
    setReports(next);
    saveBacktestReports(next);
    setNote('');
    message.success(`已存为 ${date.trim()} 的回测报告`);
    onSaved?.();
  };

  const handleRemove = id => {
    const next = removeBacktestReport(reports, id);
    setReports(next);
    saveBacktestReports(next);
  };

  const selected = reports.filter(r => selectedIds.includes(r.id))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.savedAt - b.savedAt));

  const compareFig = (() => {
    if (selected.length < 2) return null;
    const c = plotColors(!light);
    const labels = selected.map(r => r.date);
    return {
      traces: [
        { type: 'scatter', mode: 'lines+markers', name: '命中率',
          x: labels, y: selected.map(r => r.metrics.hitRate == null ? null : r.metrics.hitRate * 100),
          marker: { color: '#0a84ff' }, yaxis: 'y' },
        { type: 'scatter', mode: 'lines+markers', name: 'r(log 倍数)',
          x: labels, y: selected.map(r => r.metrics.scoreReturn?.rLog ?? null),
          marker: { color: '#ff9f0a' }, yaxis: 'y2' },
      ],
      layout: {
        height: 300, margin: { t: 30, b: 40, l: 55, r: 55 },
        paper_bgcolor: c.paperBg, plot_bgcolor: c.paperBg, font: { color: c.textColor, size: 12 },
        legend: { orientation: 'h', y: 1.15 },
        xaxis: { title: { text: '日期' }, ...c.axis },
        yaxis: { title: { text: '命中率 %' }, ...c.axis },
        yaxis2: { title: { text: 'r(log)' }, overlaying: 'y', side: 'right', ...c.axis },
      },
    };
  })();

  return (
    <div style={{ marginTop: 12 }}>
      <Space wrap>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>回测报告存档：</Typography.Text>
        <Input style={{ width: 140 }} value={date} onChange={e => setDate(e.target.value)} placeholder="日期 YYYY-MM-DD" />
        <Input style={{ width: 220 }} value={note} onChange={e => setNote(e.target.value)} placeholder="备注（可选）" onPressEnter={handleSave} />
        <Button size="small" type="primary" disabled={!canSave || !date.trim()} onClick={handleSave}
          title={canSave ? '' : '先点上面「在当前数据源回放」跑出结果，才能存档'}>
          存为今天报告
        </Button>
        <Button size="small" disabled={selectedIds.length < 2} onClick={() => setCompareOpen(true)}>
          对比选中（{selectedIds.length}）
        </Button>
      </Space>
      {reports.length > 0 && (
        <Table style={{ marginTop: 8 }} size="small" rowKey="id" pagination={{ pageSize: 8, size: 'small' }}
          dataSource={reports}
          rowSelection={{ selectedRowKeys: selectedIds, onChange: setSelectedIds }}
          columns={[
            { title: '日期', dataIndex: 'date', width: 110,
              sorter: (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0), defaultSortOrder: 'descend' },
            { title: '样本数', width: 80, align: 'right', render: (_, r) => r.metrics.total },
            { title: '命中率', width: 90, align: 'right', render: (_, r) => fmtPct(r.metrics.hitRate) },
            { title: '命中中位数', width: 100, align: 'right',
              render: (_, r) => Number.isFinite(r.metrics.hitMedian) ? r.metrics.hitMedian.toFixed(2) + 'x' : '-' },
            { title: 'r(log)', width: 90, align: 'right', render: (_, r) => fmtNum(r.metrics.scoreReturn?.rLog) },
            { title: 'p(log)', width: 100, align: 'right',
              render: (_, r) => r.metrics.scoreReturn ? r.metrics.scoreReturn.pLog.toExponential(2) : '-' },
            { title: <span title="桶序 vs 胜率的 spearman ρ——越接近 1 说明 score 排序能力越强">单调性ρ</span>, width: 90, align: 'right',
              render: (_, r) => fmtNum(r.metrics.monotonicity?.rho, 2) },
            { title: '备注', dataIndex: 'note', ellipsis: true },
            { title: '存入时间', width: 150, render: (_, r) => new Date(r.savedAt).toLocaleString() },
            { title: '操作', width: 70, render: (_, r) => (
              <Popconfirm title="删除这份报告？" onConfirm={() => handleRemove(r.id)}>
                <Button size="small" danger>删除</Button>
              </Popconfirm>
            ) },
          ]} />
      )}
      <Modal open={compareOpen} onCancel={() => setCompareOpen(false)} footer={null} width={820}
        title={`对比 ${selected.length} 份回测报告`}>
        {compareFig && <PlotlyChart traces={compareFig.traces} layout={compareFig.layout} height={compareFig.layout.height} />}
        <Table style={{ marginTop: 8 }} size="small" rowKey="id" pagination={false} dataSource={selected}
          columns={[
            { title: '日期', dataIndex: 'date', width: 100 },
            { title: '样本数', width: 80, align: 'right', render: (_, r) => r.metrics.total },
            { title: '命中率', width: 90, align: 'right', render: (_, r) => fmtPct(r.metrics.hitRate) },
            { title: '命中中位数', width: 100, align: 'right',
              render: (_, r) => Number.isFinite(r.metrics.hitMedian) ? r.metrics.hitMedian.toFixed(2) + 'x' : '-' },
            { title: 'r(log)', width: 90, align: 'right', render: (_, r) => fmtNum(r.metrics.scoreReturn?.rLog) },
            { title: 'p(log)', width: 100, align: 'right',
              render: (_, r) => r.metrics.scoreReturn ? r.metrics.scoreReturn.pLog.toExponential(2) : '-' },
            { title: '单调性ρ', width: 90, align: 'right', render: (_, r) => fmtNum(r.metrics.monotonicity?.rho, 2) },
            { title: '备注', dataIndex: 'note', ellipsis: true },
          ]} />
      </Modal>
    </div>
  );
}
