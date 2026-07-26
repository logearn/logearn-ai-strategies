import React, { useMemo, useRef, useState } from 'react';
import { Card, Select, Input, Button, Space, Table, Alert, Typography, Checkbox } from 'antd';
import { PictureOutlined, FileTextOutlined } from '@ant-design/icons';
import PlotlyChart from './PlotlyChart.jsx';
import { buildBins, parseBreakpoints, quantileEdges, buildBinBarAiReport } from '../lib/binning.js';
import { recommendBreakpoints, mineBreakpointsOOS, calibrateOOSMining } from '../lib/analytics.js';
import { themeColors } from '../lib/scatterFigure.js';
import { getFeature } from '../lib/data.js';
import { useGroupedFieldOptions, renderFieldOption, fieldFilterOption } from './fieldOptions.jsx';
import FieldNameWithDesc from './FieldNameWithDesc.jsx';
import FieldPickerModal from './FieldPickerModal.jsx';

const METRICS = [
  { value: 'winRate', label: '胜率（>2倍）' },
  { value: 'median', label: '中位数' },
  { value: 'mean', label: '均值' },
];

export default function BinBarCard({ rows, fields, light }) {
  const [binField, setBinField] = useState();
  const [bpText, setBpText] = useState('');
  const [metric, setMetric] = useState('winRate');
  const [mined, setMined] = useState(null);
  const [lightExport, setLightExport] = useState(false);
  const plotRef = useRef(null);
  const fieldOptions = useGroupedFieldOptions(fields);

  const auto = () => {
    const vals = rows.map(r => Number(getFeature(r, binField))).filter(Number.isFinite);
    const e = quantileEdges(vals, 4);
    setBpText(e.length ? e.map(v => Number(v.toPrecision(4))).join(', ') : '');
  };

  // 断点挖掘：样本内推荐 + 样本外验证 + 置换校准。
  // 样本内挑出来的"最佳断点"几乎总是好看的（同一份数据既选点又评估 = 过拟合）。
  const mine = () => {
    if (!binField) return;
    const rec = recommendBreakpoints(rows, binField, 'returnMax');
    const minSide = Math.max(10, Math.round(rows.length * 0.08));
    const oos = mineBreakpointsOOS(rows, binField, 'returnMax', minSide);
    const cal = oos.error ? null : calibrateOOSMining(rows, binField, 'returnMax', minSide, 20);
    setMined({ rec, oos, cal });
    if (rec?.breakpoints?.length) setBpText(rec.breakpoints.map(v => Number(Number(v).toPrecision(4))).join(', '));
  };

  const result = useMemo(() => (binField && rows.length)
    ? buildBins({ rows, binField, breakpoints: parseBreakpoints(bpText) }) : null, [rows, binField, bpText]);

  const fig = useMemo(() => {
    if (!result) return null;
    const T = themeColors(light);
    const bins = result.bins;
    const err = metric === 'winRate' ? bins.map(b => (b.winCI ? b.winCI.hi - b.winRate : 0))
      : bins.map(b => (Number.isFinite(b.ci95) ? b.ci95 : 0));
    const errMinus = metric === 'winRate' ? bins.map(b => (b.winCI ? b.winRate - b.winCI.lo : 0)) : err;
    return {
      traces: [{
        type: 'bar', x: bins.map(b => b.label),
        y: bins.map(b => (Number.isFinite(b[metric]) ? b[metric] : null)),
        // 误差棒用 Wilson 区间（胜率）或 95%CI（均值）：每箱可能只有十几条，
        // 没有误差棒的柱状图会让人把噪声读成趋势。
        error_y: { type: 'data', symmetric: false, array: err, arrayminus: errMinus, color: '#ff453a' },
        text: bins.map(b => (b.n ? `n=${b.n}` : '空')), textposition: 'outside',
        marker: { color: '#0a84ff' },
      }],
      layout: {
        paper_bgcolor: T.paperBg, plot_bgcolor: T.paperBg, font: { color: T.textColor },
        xaxis: { title: binField, ...T.axis }, yaxis: { title: METRICS.find(m => m.value === metric).label, ...T.axis },
        margin: { t: 20, b: 60 }, showlegend: false,
        shapes: (Number.isFinite(result.overallWin) && metric === 'winRate') ? [{
          type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y',
          y0: result.overallWin, y1: result.overallWin, line: { color: '#8e8e93', width: 1, dash: 'dot' },
        }] : [],
      },
    };
  }, [result, metric, light, binField]);

  function exportReport() {
    if (!result) return;
    const bestIdx = result.bins.reduce((bi, b, i, arr) =>
      (b.n >= 10 && (bi < 0 || b.winRate > arr[bi].winRate) ? i : bi), -1);
    const R = { binField, valueField: 'returnMax', breakpoints: result.breakpoints, primary: metric,
      bins: result.bins.map(b => ({ label: b.label, lo: b.lo, hi: b.hi, n: b.n,
        winRate: b.winRate, median: b.median, mean: b.mean, std: b.std, ci: b.ci95 })), bestIdx };
    // 报告读的是 M.rows 且每行要带 consistent，而 mineBreakpointsOOS 返回的是 results 且不含它
    // （旧版在渲染层算完才存进全局）。consistent = 训练段和验证段都跑赢基准。
    const M = mined?.oos && !mined.oos.error ? {
      field: binField, targetField: 'returnMax',
      trainSize: mined.oos.trainSize, testSize: mined.oos.testSize,
      trainBase: mined.oos.trainBase, testBase: mined.oos.testBase,
      rows: mined.oos.results.map(r => ({ ...r,
        consistent: Number.isFinite(r.testLift) && r.trainLift > 1 && r.testLift > 1 })),
    } : null;
    const md = buildBinBarAiReport(R, rows, M);
    if (!md) return;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `分箱分析_${binField}_${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  const columns = [
    { title: '区间', dataIndex: 'label' },
    { title: 'n', dataIndex: 'n', align: 'right', width: 70 },
    { title: '胜率', dataIndex: 'winRate', align: 'right', width: 90,
      render: v => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-') },
    { title: '胜率 95%CI', align: 'right', width: 130,
      render: (_, b) => (b.winCI ? `${(b.winCI.lo * 100).toFixed(0)}~${(b.winCI.hi * 100).toFixed(0)}%` : '-') },
    { title: '中位数', dataIndex: 'median', align: 'right', width: 90,
      render: v => (Number.isFinite(v) ? v.toFixed(3) : '-') },
    { title: '均值', dataIndex: 'mean', align: 'right', width: 90,
      render: v => (Number.isFinite(v) ? v.toFixed(3) : '-') },
  ];

  return (
    <Card size="small" title={<Space size={6}><span>分箱柱状图</span>
      {binField && <FieldNameWithDesc field={binField} style={{ fontWeight: 400, fontSize: 12, opacity: .7 }} />}</Space>}
      extra={<Space>
        <Button size="small" icon={<PictureOutlined />} disabled={!binField}
          onClick={() => plotRef.current?.exportPng(`分箱_${binField}`, lightExport)}>导出 PNG</Button>
        <Checkbox checked={lightExport} onChange={e => setLightExport(e.target.checked)}>
          <span style={{ fontSize: 12 }}>浅色导出</span></Checkbox>
        <Button size="small" icon={<FileTextOutlined />} disabled={!result} onClick={exportReport}
          title="导出含统计能力边界和已知局限的 Markdown，可直接丢给 AI 做诊断">导出分析报告</Button>
      </Space>}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select showSearch placeholder="分箱字段（按分组浏览，可搜中文含义）" style={{ width: 340 }}
          value={binField} onChange={setBinField} options={fieldOptions}
          optionRender={renderFieldOption} filterOption={fieldFilterOption} listHeight={420} />
        <Input style={{ width: 240 }} placeholder="断点，逗号分隔（留空=单箱）" value={bpText}
          onChange={e => setBpText(e.target.value)} />
        <FieldPickerModal fields={fields} onPick={setBinField} buttonText="按分组浏览" />
        <Button onClick={auto} disabled={!binField}>按四分位自动断点</Button>
        <Button onClick={mine} disabled={!binField}>断点挖掘（含样本外验证）</Button>
        <Select style={{ width: 150 }} value={metric} onChange={setMetric} options={METRICS} />
      </Space>

      {result?.skipped > 0 && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }}
          message={`${result.skipped} 条样本因 ${binField} 或 returnMax 缺值被排除（缺值不会被当成 0 计入最低箱）`} />
      )}

      {mined && (
        <Alert type="info" style={{ marginBottom: 12 }} message={
          <div style={{ lineHeight: 1.9, fontSize: 12 }}>
            {mined.rec?.error ? <>样本内推荐：{mined.rec.error}</>
              : <>样本内推荐断点：<b>{(mined.rec?.breakpoints || []).map(v => Number(Number(v).toPrecision(4))).join(', ') || '无'}</b></>}
            <br />
            {mined.oos?.error ? <>样本外验证：{mined.oos.error}</> : (() => {
              const rs = mined.oos.results;
              const best = rs.slice().sort((a, b) => b.testLift - a.testLift)[0];
              if (!best) return <>样本外验证：无可用切点</>;
              return <>
                样本外验证（训练 {mined.oos.trainSize} / 测试 {mined.oos.testSize} 条，按时间切分）：
                最佳切点 <b>{best.better === 'right' ? '>' : '<'} {Number(best.cut.toPrecision(4))}</b>，
                训练集胜率 {(best.trainWin * 100).toFixed(1)}%（提升 {best.trainLift.toFixed(2)}x），
                测试集胜率 <b>{(best.testWin * 100).toFixed(1)}%</b>（提升 <b>{best.testLift.toFixed(2)}x</b>，n={best.testN}）
                {best.testN < 30 && <span style={{ color: '#ff9f0a' }}>；测试集通过侧只有 {best.testN} 条，结论很不稳</span>}
                {mined.cal && !mined.cal.error && (() => {
                  const c = mined.cal, ok = c.observed > c.null95 && c.p <= 0.1;
                  return <><br />
                    置换校准（{rs.length} 个候选切点，打散目标重跑 {c.permN} 次）：
                    测试集提升中位数 <b>{c.observed.toFixed(2)}x</b>，
                    零分布中位数 {c.nullMedian.toFixed(2)}x、95 分位 {c.null95.toFixed(2)}x，p = <b>{c.p.toFixed(3)}</b>
                    <span style={{ color: ok ? '#30d158' : '#ff9f0a' }}>
                      {ok ? ' ✓ 明显超出随机水平，这个区间像是真的'
                          : ' ⚠️ 没有超出随机水平——纯噪声字段也能挑出这种"最佳切点"，不要当成发现'}
                    </span></>;
                })()}
              </>;
            })()}
          </div>
        } />
      )}

      {fig && <PlotlyChart ref={plotRef} traces={fig.traces} layout={fig.layout} height={340} />}
      {result && <Table style={{ marginTop: 12 }} size="small" rowKey="label"
        columns={columns} dataSource={result.bins} pagination={false} />}
      {!binField && <Typography.Text type="secondary">选一个字段开始分箱</Typography.Text>}
    </Card>
  );
}
