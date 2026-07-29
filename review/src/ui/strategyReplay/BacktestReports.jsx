import React, { useEffect, useState } from 'react';
import { Card, Space, Button, Table, Popconfirm, Typography, Modal, Tag, Alert } from 'antd';
import { loadBacktestReports, saveBacktestReports, removeBacktestReport, todayDateStr } from '../../lib/backtestReports.js';
import { suggestFromReportMetrics } from '../../lib/strategyReplayLogic.js';
import { buildDailyReportMarkdown, buildDailyReportsMarkdown } from '../../lib/backtestReportExport.js';
import PlotlyChart from '../PlotlyChart.jsx';
import { plotColors } from '../../theme.js';
import { downloadText } from '../../lib/download.js';

const kindTag = kind => (kind === 'optimized'
  ? <Tag color="purple">优化</Tag> : <Tag>日报</Tag>);

const fmtPct = v => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-');
const fmtNum = (v, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits) : '-');

// 报告存档的"存"这个动作留在「策略」tab（StrategyReplay.jsx，跑完回放就地存，不用切 tab）——
// 这里只管已存报告的查看、跨天对比、导出。
export default function BacktestReports({ light, reportsVersion }) {
  const [reports, setReports] = useState(loadBacktestReports);
  const [selectedIds, setSelectedIds] = useState([]);
  const [compareOpen, setCompareOpen] = useState(false);

  // 存报告（策略 tab 手动存 / 应用调权建议自动存优化前后对）都直接写 localStorage，不经过这个
  // 组件的 setReports——靠 reportsVersion 这个信号量重新读一次存档，保证新报告马上出现在表里。
  useEffect(() => {
    if (reportsVersion != null) setReports(loadBacktestReports());
  }, [reportsVersion]);

  const handleRemove = id => {
    const next = removeBacktestReport(reports, id);
    setReports(next);
    saveBacktestReports(next);
  };

  const selected = reports.filter(r => selectedIds.includes(r.id))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.savedAt - b.savedAt));

  // 对比建议：拿最早 vs 最晚那份的 metrics 算方向（>=2 份时才有意义），口径跟
  // StrategyReplay.jsx 试算弹窗的 netHint 一致，见 strategyReplayLogic.js 的 suggestFromReportMetrics。
  const compareSuggestion = selected.length >= 2
    ? suggestFromReportMetrics(selected[0].metrics, selected[selected.length - 1].metrics)
    : null;

  const exportOne = r => downloadText(buildDailyReportMarkdown(r), `回测报告_${r.date}_${r.kind === 'optimized' ? '优化' : '日报'}_${r.id.slice(0, 8)}.md`, 'text/markdown;charset=utf-8;');
  const exportAll = () => downloadText(buildDailyReportsMarkdown(reports), `回测报告汇总_${reports.length}份_${todayDateStr()}.md`, 'text/markdown;charset=utf-8;');

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
    <Card size="small" title="回测报告存档 · 对比 · 导出">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        每天/每次应用调权建议的策略表现留痕："存为今天报告"挪到了「策略」tab（跑完回放就地存，不用切来这里）；
        应用调权建议时会自动存一对"优化前/后"报告。这里勾选 ≥2 份可对比走势并给优化建议；单份/全部报告都能导出成 markdown。
      </Typography.Paragraph>
      <Space wrap>
        <Button size="small" disabled={selectedIds.length < 2} onClick={() => setCompareOpen(true)}>
          对比选中（{selectedIds.length}）
        </Button>
        <Button size="small" disabled={!reports.length} onClick={exportAll}>导出全部（{reports.length}）</Button>
      </Space>
      {reports.length > 0 && (
        <Table style={{ marginTop: 8 }} size="small" rowKey="id" pagination={{ pageSize: 8, size: 'small' }}
          dataSource={reports}
          rowSelection={{ selectedRowKeys: selectedIds, onChange: setSelectedIds }}
          columns={[
            { title: '日期', dataIndex: 'date', width: 110,
              sorter: (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0), defaultSortOrder: 'descend' },
            { title: '类型', width: 80, render: (_, r) => kindTag(r.kind) },
            { title: '样本数', width: 80, align: 'right', render: (_, r) => r.metrics.total },
            { title: '命中率', width: 90, align: 'right', render: (_, r) => fmtPct(r.metrics.hitRate) },
            { title: '命中中位数', width: 100, align: 'right',
              render: (_, r) => Number.isFinite(r.metrics.hitMedian) ? r.metrics.hitMedian.toFixed(2) + 'x' : '-' },
            { title: 'r(log)', width: 90, align: 'right', render: (_, r) => fmtNum(r.metrics.scoreReturn?.rLog) },
            { title: 'p(log)', width: 100, align: 'right',
              render: (_, r) => Number.isFinite(r.metrics.scoreReturn?.pLog) ? r.metrics.scoreReturn.pLog.toExponential(2) : '-' },
            { title: <span title="桶序 vs 胜率的 spearman ρ——越接近 1 说明 score 排序能力越强">单调性ρ</span>, width: 90, align: 'right',
              render: (_, r) => fmtNum(r.metrics.monotonicity?.rho, 2) },
            { title: '备注', dataIndex: 'note', ellipsis: true },
            { title: '存入时间', width: 150, render: (_, r) => new Date(r.savedAt).toLocaleString() },
            { title: '操作', width: 130, render: (_, r) => (
              <Space size={4}>
                <Button size="small" onClick={() => exportOne(r)}>导出</Button>
                <Popconfirm title="删除这份报告？" onConfirm={() => handleRemove(r.id)}>
                  <Button size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ) },
          ]} />
      )}
      <Modal open={compareOpen} onCancel={() => setCompareOpen(false)} footer={null} width={820}
        title={`对比 ${selected.length} 份回测报告`}>
        {compareSuggestion && <Alert style={{ marginBottom: 12 }} type={compareSuggestion.type} showIcon
          message={compareSuggestion.text}
          description={compareSuggestion.detail ? <span style={{ fontSize: 12 }}>{compareSuggestion.detail}</span> : null} />}
        {compareFig && <PlotlyChart traces={compareFig.traces} layout={compareFig.layout} height={compareFig.layout.height} />}
        <Table style={{ marginTop: 8 }} size="small" rowKey="id" pagination={false} dataSource={selected}
          columns={[
            { title: '日期', dataIndex: 'date', width: 100 },
            { title: '类型', width: 80, render: (_, r) => kindTag(r.kind) },
            { title: '样本数', width: 80, align: 'right', render: (_, r) => r.metrics.total },
            { title: '命中率', width: 90, align: 'right', render: (_, r) => fmtPct(r.metrics.hitRate) },
            { title: '命中中位数', width: 100, align: 'right',
              render: (_, r) => Number.isFinite(r.metrics.hitMedian) ? r.metrics.hitMedian.toFixed(2) + 'x' : '-' },
            { title: 'r(log)', width: 90, align: 'right', render: (_, r) => fmtNum(r.metrics.scoreReturn?.rLog) },
            { title: 'p(log)', width: 100, align: 'right',
              render: (_, r) => Number.isFinite(r.metrics.scoreReturn?.pLog) ? r.metrics.scoreReturn.pLog.toExponential(2) : '-' },
            { title: '单调性ρ', width: 90, align: 'right', render: (_, r) => fmtNum(r.metrics.monotonicity?.rho, 2) },
            { title: '备注', dataIndex: 'note', ellipsis: true },
          ]} />
      </Modal>
    </Card>
  );
}
