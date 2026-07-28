import React, { useMemo, useRef, useState } from 'react';
import { Card, Select, Descriptions, Tabs, Button, Input, Empty, Space, Tag, message, Segmented, Table, Radio, Statistic, Row, Col, Typography, Alert, Checkbox } from 'antd';
import { CopyOutlined, DownloadOutlined, PictureOutlined } from '@ant-design/icons';
import JsonTree from './JsonTree.jsx';
import PlotlyChart from './PlotlyChart.jsx';
import { logearnUrl, formatNumberSmart } from '../lib/utils.js';
import { getFeature, resolveNativeDecimals } from '../lib/data.js';
import { themeColors } from '../lib/scatterFigure.js';
import { useGroupedFieldOptions, renderFieldOption, fieldFilterOption } from './fieldOptions.jsx';
import { getLabel } from '../lib/labels.js';
import { dayOf } from '../lib/dataSlices.js';

// 快照数据速查：输入 CA 直接看这条样本的原始 JSON。
// 用途——分析里看到某个字段值奇怪时，回原始数据核对是"算错了"还是"数据本来就这样"。
// 这个会话里排查字段问题时反复要干这件事，之前只能手动翻几十 MB 的 JSON 文件。
export default function SnapshotInspector({ rows, labels = {}, onLabel, light }) {
  const [mode, setMode] = useState('ca');
  const [ca, setCa] = useState();
  const [q, setQ] = useState('');
  const [searchMode, setSearchMode] = useState('locate');  // locate=高亮定位 / filter=只留命中
  const [field, setField] = useState();
  const [coverFilter, setCoverFilter] = useState('all');
  // 字段全集必须扫多行取并集，不能只看第 0 条——很多字段是"某类信号才有"，
  // 第 0 条恰好没有的话，整个字段就从选项里消失了（这正好是这个功能要暴露的"部分缺失"情况）。
  const allFieldKeys = useMemo(() => {
    const keys = new Set();
    for (const r of rows.slice(0, 500)) for (const k of Object.keys(r.features || {})) keys.add(k);
    return [...keys];
  }, [rows]);
  const fieldOptions = useGroupedFieldOptions(allFieldKeys);

  // "有值"的判定口径：0 算有值（这正是上一个问题的关键——holder_max_private_funder_ratio=0
  // 是"真的没簇"而不是"没数据"），只有 undefined/null/空串/非有限数才算缺失。
  const hasValue = v => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));

  const fieldRows = useMemo(() => {
    if (!field) return [];
    return rows.map(r => {
      const v = getFeature(r, field);
      return { key: r.tokenAddress || r.id, row: r, symbol: r.symbol, ca: r.tokenAddress,
        returnMax: r.returnMax, value: v, present: hasValue(v) };
    });
  }, [rows, field]);

  const coverage = useMemo(() => {
    const present = fieldRows.filter(r => r.present).length;
    return { present, missing: fieldRows.length - present, total: fieldRows.length };
  }, [fieldRows]);

  const shownFieldRows = useMemo(() => {
    if (coverFilter === 'present') return fieldRows.filter(r => r.present);
    if (coverFilter === 'missing') return fieldRows.filter(r => !r.present);
    return fieldRows;
  }, [fieldRows, coverFilter]);

  const options = useMemo(() => rows.map((r, i) => ({
    value: r.tokenAddress,
    label: `${i + 1}. ${r.symbol || '(无symbol)'} · ${r.tokenAddress}`,
    row: r,
  })).filter(o => o.value), [rows]);

  const row = useMemo(() => rows.find(r => r.tokenAddress === ca), [rows, ca]);

  // 持仓 SOL 余额下钻：把 ctx.holders 里每个持有人的 native_balance（lamports/wei）换算成
  // 人类可读的 SOL 数量。精度换算跟组装字段 holder_native_sol_median/cv 复用同一个
  // resolveNativeDecimals（native_coin_decimal 缺失时按 chain 兜底），保证图上数字和字段浏览器
  // 里的聚合统计对得上账，不会出现"图上看着不对但字段数值又不一样"的割裂。
  // 交易所/流动性池地址（addr_type===2）直接剔除，不进图——这批地址的 SOL 余额跟"大户是否有
  // 协同/gas 充足"无关，动辄大几十上百 SOL 会把 Y 轴压得没法看真正持有人之间的差异，
  // 和 buildRows 里 H（排除 addr_type===2）的口径保持一致，不能图和聚合字段各算各的。
  const holderSolItems = useMemo(() => {
    const holders = Array.isArray(row?.rawCtx?.holders) ? row.rawCtx.holders : [];
    if (!holders.length) return { items: [], nativeDecimals: null, usedChainFallback: false };
    const nativeDecimals = resolveNativeDecimals(row.features);
    const usedChainFallback = !(Number(row.features?.['native_coin_decimal']) > 0);
    const items = holders
      .filter(h => h && typeof h.address === 'string' && h.address && Number(h.addr_type) !== 2)
      .map(h => ({
        address: h.address,
        amountPct: Number(h.amount_percentage),
        sol: (Number.isFinite(nativeDecimals) && nativeDecimals > 0)
          ? Number(h.native_balance) / nativeDecimals : NaN,
      }))
      .sort((a, b) => (Number.isFinite(b.sol) ? b.sol : -1) - (Number.isFinite(a.sol) ? a.sol : -1));
    return { items, nativeDecimals, usedChainFallback };
  }, [row]);

  const [logSolY, setLogSolY] = useState(false);
  const solPlotRef = useRef(null);
  const holderSolFig = useMemo(() => {
    const valid = holderSolItems.items.filter(h => Number.isFinite(h.sol) && (!logSolY || h.sol > 0));
    if (!valid.length) return null;
    const T = themeColors(light);
    const median = row?.features?.['holder_native_sol_median'];
    const shortAddr = a => `${a.slice(0, 4)}…${a.slice(-4)}`;
    return {
      traces: [{
        type: 'bar',
        x: valid.map((_, i) => i + 1),
        y: valid.map(h => h.sol),
        marker: { color: '#0a84ff' },
        text: valid.map(h => `${shortAddr(h.address)}<br>SOL 余额：${h.sol.toFixed(4)}` +
          (Number.isFinite(h.amountPct) ? `<br>持仓占比：${(h.amountPct * 100).toFixed(2)}%` : '') +
          '<br><i>点击复制完整地址</i>'),
        hovertemplate: '%{text}<extra></extra>',
        // customdata 存完整钱包地址（不是缩写），供 PlotlyChart 的 onPointClick 拿去复制——
        // 这套点击回调是 ScatterCard 那边"点散点跳转"复用的同一个机制，这里换成"点柱子复制地址"
        customdata: valid.map(h => h.address),
      }],
      layout: {
        paper_bgcolor: T.paperBg, plot_bgcolor: T.paperBg, font: { color: T.textColor },
        xaxis: { title: '持仓名次（按 SOL 余额降序）', ...T.axis },
        yaxis: { title: 'SOL 余额', type: logSolY ? 'log' : 'linear', ...T.axis },
        margin: { t: 20, b: 50 }, showlegend: false,
        shapes: Number.isFinite(median) ? [{
          type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y',
          y0: median, y1: median, line: { color: '#ff9f0a', width: 1, dash: 'dot' },
        }] : [],
      },
    };
  }, [holderSolItems, logSolY, light, row]);

  // 按关键字过滤：只留 key 路径或值命中的分支。快照里字段几百个，没有过滤基本没法看。
  const filtered = useMemo(() => {
    if (!row || searchMode !== 'filter' || !q.trim()) return null;
    const needle = q.trim().toLowerCase();
    const walk = (v, key) => {
      if (v === null || typeof v !== 'object') {
        return (String(key).toLowerCase().includes(needle)
          || String(v).toLowerCase().includes(needle)) ? v : undefined;
      }
      const out = Array.isArray(v) ? [] : {};
      let hit = String(key).toLowerCase().includes(needle);
      for (const [k, cv] of (Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v))) {
        const sub = walk(cv, k);
        if (sub !== undefined) { out[k] = sub; hit = true; }
      }
      return hit ? out : undefined;
    };
    return {
      ctx: walk(row.rawCtx, 'ctx') ?? {},
      signal: walk(row.rawSignal, 'signal') ?? {},
      call: walk(row.rawCall, 'call') ?? {},
    };
  }, [row, q, searchMode]);

  const copy = obj => {
    navigator.clipboard?.writeText(JSON.stringify(obj, null, 2));
    message.success('已复制 JSON');
  };
  const download = (obj, name) => {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}_${row.symbol || row.tokenAddress}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  };

  const ctxData = filtered ? filtered.ctx : row?.rawCtx;
  const signalData = filtered ? filtered.signal : row?.rawSignal;
  const callData = filtered ? filtered.call : row?.rawCall;

  return (
    <Card size="small" title="快照数据速查"
      extra={<span style={{ fontSize: 12, opacity: .55 }}>
        字段值看着不对时，回原始 JSON 核对是算错了还是数据本来就这样
      </span>}>
      <Segmented value={mode} onChange={setMode} style={{ marginBottom: 12 }}
        options={[{ label: '按 CA 查', value: 'ca' }, { label: '按字段查（看哪些样本有值）', value: 'field' }]} />

      {mode === 'ca' && (<>
        <Space wrap style={{ marginBottom: 12 }}>
          <Select showSearch allowClear placeholder="输入或选择 CA / symbol" style={{ width: 460 }}
            value={ca} onChange={setCa} options={options}
            filterOption={(input, o) => o.label.toLowerCase().includes(input.toLowerCase())}
            listHeight={400} />
          {row && (
            <Space.Compact>
              <Select value={searchMode} onChange={setSearchMode} style={{ width: 110 }}
                options={[{ value: 'locate', label: '定位' }, { value: 'filter', label: '过滤' }]} />
              <Input.Search allowClear style={{ width: 320 }}
                placeholder={searchMode === 'locate' ? '定位字段：高亮并展开到命中处' : '过滤：只显示命中的分支'}
                value={q} onChange={e => setQ(e.target.value)} />
            </Space.Compact>
          )}
        </Space>
        {!ca && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选一个 CA 查看它的原始快照" />}
      </>)}

      {mode === 'field' && (
        <div style={{ marginBottom: row ? 16 : 0 }}>
          <Space wrap style={{ marginBottom: 12 }}>
            <Select showSearch allowClear placeholder="选择字段，看每条样本有没有值" style={{ width: 380 }}
              value={field} onChange={setField} options={fieldOptions}
              optionRender={renderFieldOption} filterOption={fieldFilterOption} listHeight={420} />
            {field && (
              <Radio.Group value={coverFilter} onChange={e => setCoverFilter(e.target.value)} optionType="button" buttonStyle="solid" size="small">
                <Radio.Button value="all">全部 {coverage.total}</Radio.Button>
                <Radio.Button value="present">有值 {coverage.present}</Radio.Button>
                <Radio.Button value="missing">缺失 {coverage.missing}</Radio.Button>
              </Radio.Group>
            )}
          </Space>
          {!field && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选一个字段，列出哪些样本有值、哪些缺失" />}
          {field && (<>
            <Row gutter={16} style={{ marginBottom: 12 }}>
              <Col><Statistic title="总样本" value={coverage.total} /></Col>
              <Col><Statistic title="有值" value={coverage.present}
                suffix={`/ ${(coverage.present / (coverage.total || 1) * 100).toFixed(0)}%`}
                valueStyle={{ color: '#30d158' }} /></Col>
              <Col><Statistic title="缺失" value={coverage.missing}
                valueStyle={{ color: coverage.missing ? '#ff9f0a' : undefined }} /></Col>
            </Row>
            {coverage.missing > 0 && coverage.present > 0 && (
              <Tag color="orange" style={{ marginBottom: 8 }}>
                注意：这个字段有 {coverage.missing} 条缺失。做散点/分箱/AUC 时这些样本会被自动排除，
                但如果缺失是系统性的（比如某类信号才有），结论会带偏差。
              </Tag>
            )}
            <Table size="small" rowKey="key" dataSource={shownFieldRows} pagination={{ pageSize: 20, size: 'small', showSizeChanger: true }}
              onRow={r => ({ onClick: () => { setCa(r.ca); setMode('ca'); }, style: { cursor: 'pointer' } })}
              columns={[
                { title: 'symbol', dataIndex: 'symbol', width: 120 },
                { title: 'CA', dataIndex: 'ca', width: 260, render: v => <code style={{ fontSize: 11 }}>{v}</code> },
                { title: '该字段值', width: 180, align: 'right',
                  sorter: (a, b) => (a.present ? Number(a.value) : -Infinity) - (b.present ? Number(b.value) : -Infinity),
                  render: (_, r) => r.present
                    ? <b>{typeof r.value === 'number' ? formatNumberSmart(r.value) : String(r.value)}</b>
                    : <Tag color="orange">缺失</Tag> },
                { title: 'returnMax', dataIndex: 'returnMax', width: 110, align: 'right',
                  defaultSortOrder: 'descend', sorter: (a, b) => a.returnMax - b.returnMax,
                  render: v => Number(v).toFixed(3) + 'x' },
                { title: '', width: 60, render: () => <span style={{ fontSize: 11, opacity: .5 }}>点开看快照 ›</span> },
              ]} />
          </>)}
        </div>
      )}

      {mode === 'ca' && row && (
        <>
          <Descriptions size="small" column={4} bordered style={{ marginBottom: 12 }}
            items={[
              { key: 's', label: 'symbol', children: row.symbol || '-' },
              { key: 'r', label: 'returnMax', children: <b>{Number(row.returnMax).toFixed(4)}x</b> },
              { key: 't', label: '信号类型', children: row.signalType || '-' },
              { key: 'n', label: '策略', children: row.strategyName || '-' },
              { key: 'm', label: '初始市值', children: Number(row.initialMcap).toFixed(0) },
              { key: 'x', label: '最高市值', children: Number(row.maxMcap).toFixed(0) },
              { key: 'd', label: '日期（买入时刻，本地时区）',
                children: dayOf(row.buyTimestamp)
                  ? new Date(Number(row.buyTimestamp) * 1000).toLocaleString() : '-' },
              { key: 'c', label: 'CA', span: 2,
                children: <a href={logearnUrl(row.tokenAddress)} target="_blank" rel="noopener noreferrer">
                  <code style={{ fontSize: 11 }}>{row.tokenAddress}</code></a> },
            ]} />

          {onLabel && (() => {
            const cur = getLabel(labels, row.tokenAddress);
            return (
              <Space style={{ marginBottom: 12 }} wrap>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>人工标注：</Typography.Text>
                <Button size="small" type={cur === 'good' ? 'primary' : 'default'}
                  onClick={() => onLabel(row.tokenAddress, cur === 'good' ? null : 'good')}>👍 优良</Button>
                <Button size="small" danger={cur === 'junk'}
                  onClick={() => onLabel(row.tokenAddress, cur === 'junk' ? null : 'junk')}>🗑 垃圾（降级为保本）</Button>
                {cur === 'junk' && row.returnMaxRaw != null && (
                  <Tag color="warning">已降级：{Number(row.returnMaxRaw).toFixed(2)}x → 1.00x</Tag>)}
                {cur === 'good' && <Tag color="success">已标优良</Tag>}
              </Space>
            );
          })()}
          {searchMode === 'filter' && q.trim() && <Tag color="orange" style={{ marginBottom: 8 }}>已过滤：只显示命中「{q.trim()}」的分支</Tag>}
          {searchMode === 'locate' && q.trim() && <Tag color="gold" style={{ marginBottom: 8 }}>已定位：高亮并自动展开到「{q.trim()}」，其余分支保持原样</Tag>}

          <Tabs size="small" items={[
            { key: 'solBalance', label: `持仓 SOL 余额${holderSolItems.items.length ? `（${holderSolItems.items.length}）` : ''}`,
              children: <>
                {!holderSolItems.items.length && (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这条快照没有 ctx.holders 持仓数据" />
                )}
                {holderSolItems.items.length > 0 && holderSolItems.nativeDecimals == null && (
                  <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                    message="无法确定 SOL/BNB 精度，余额换算不出来"
                    description="这条快照既没有 native_coin_decimal 字段，chain 也不是已知的 3(Solana)/56(BSC)，无法把 native_balance 从链上最小单位换算成人类可读的 SOL/BNB 数量。" />
                )}
                {holderSolItems.nativeDecimals != null && (<>
                  <Row gutter={16} style={{ marginBottom: 12 }}>
                    <Col><Statistic title="持有人数" value={holderSolItems.items.length} /></Col>
                    <Col><Statistic title="中位数（holder_native_sol_median）"
                      value={Number.isFinite(row.features?.['holder_native_sol_median']) ? row.features['holder_native_sol_median'] : '-'}
                      precision={4} suffix="SOL" /></Col>
                    <Col><Statistic title="变异系数（holder_native_sol_cv）"
                      value={Number.isFinite(row.features?.['holder_native_sol_cv']) ? row.features['holder_native_sol_cv'] : '-'}
                      precision={3} /></Col>
                    <Col><Statistic title="精度来源"
                      valueRender={() => <span style={{ fontSize: 14 }}>
                        {holderSolItems.usedChainFallback ? `按 chain 兜底（${row.features?.chain === 56 ? 'BSC' : 'Solana'}）` : 'native_coin_decimal（快照自带）'}
                      </span>} /></Col>
                  </Row>
                  <Space style={{ marginBottom: 8 }}>
                    <Checkbox checked={logSolY} onChange={e => setLogSolY(e.target.checked)}>对数 Y 轴（余额差距悬殊时更好看）</Checkbox>
                    <Button size="small" icon={<PictureOutlined />} disabled={!holderSolFig}
                      onClick={() => solPlotRef.current?.exportPng(`SOL余额_${row.symbol || row.tokenAddress}`)}>导出 PNG</Button>
                    <span style={{ fontSize: 12, opacity: .55 }}>已剔除交易所/流动性池地址；橙色虚线 = 中位数</span>
                  </Space>
                  {holderSolFig
                    ? <PlotlyChart ref={solPlotRef} traces={holderSolFig.traces} layout={holderSolFig.layout} height={380}
                        onPointClick={addr => { navigator.clipboard?.writeText(addr); message.success('已复制持有人地址：' + addr); }} />
                    : <Typography.Text type="secondary">开启对数 Y 轴后没有可显示的正数余额</Typography.Text>}
                </>)}
              </> },
            { key: 'ctx', label: 'ctx（gmgn / K线 / 持有人 / 筹码）',
              children: <>
                <Space style={{ marginBottom: 8 }}>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => copy(ctxData)}>复制</Button>
                  <Button size="small" icon={<DownloadOutlined />} onClick={() => download(row.rawCtx, 'ctx')}>下载完整 ctx</Button>
                </Space>
                <div style={{ maxHeight: 520, overflow: 'auto' }}>
                  <JsonTree data={ctxData} rootLabel="ctx" defaultOpen highlight={searchMode === 'locate' ? q : ''} />
                </div>
              </> },
            { key: 'signal', label: 'signal（信号原始字段）',
              children: <>
                <Space style={{ marginBottom: 8 }}>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => copy(signalData)}>复制</Button>
                  <Button size="small" icon={<DownloadOutlined />} onClick={() => download(row.rawSignal, 'signal')}>下载完整 signal</Button>
                </Space>
                <div style={{ maxHeight: 520, overflow: 'auto' }}>
                  <JsonTree data={signalData} rootLabel="signal" defaultOpen highlight={searchMode === 'locate' ? q : ''} />
                </div>
              </> },
            { key: 'call', label: 'call（call 原始字段）',
              children: <>
                <Space style={{ marginBottom: 8 }}>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => copy(callData)}>复制</Button>
                  <Button size="small" icon={<DownloadOutlined />} onClick={() => download(row.rawCall, 'call')}>下载完整 call</Button>
                </Space>
                <div style={{ maxHeight: 520, overflow: 'auto' }}>
                  <JsonTree data={callData} rootLabel="call" defaultOpen highlight={searchMode === 'locate' ? q : ''} />
                </div>
              </> },
            { key: 'features', label: `features（算出来的 ${Object.keys(row.features || {}).length} 个字段）`,
              children: <>
                <Space style={{ marginBottom: 8 }}>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => copy(row.features)}>复制</Button>
                </Space>
                <div style={{ maxHeight: 520, overflow: 'auto' }}>
                  <JsonTree data={row.features} rootLabel="features" defaultOpen highlight={searchMode === 'locate' ? q : ''} />
                </div>
              </> },
          ]} />
        </>
      )}
    </Card>
  );
}
