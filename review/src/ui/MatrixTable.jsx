import React, { useMemo, useState } from 'react';
import { Card, Table, Button, Space, Checkbox, Tag, Typography, message, InputNumber } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import FieldPickerModal from './FieldPickerModal.jsx';
import { getFeature } from '../lib/data.js';
import { formatNumberSmart, spearman } from '../lib/utils.js';
import { getFieldDesc } from '../lib/dictionary.js';
import { logearnUrl } from '../lib/utils.js';

// 每列按自身 min~max 归一，低→高映射成蓝→红的热力背景。
// 目的：一眼看出"高倍率的那几行，在某个字段上是不是普遍偏高/偏低"。
function heatColor(v, min, max) {
  if (!Number.isFinite(v) || !(max > min)) return 'transparent';
  const t = (v - min) / (max - min);              // 0..1
  // 蓝(220°) → 红(0°)，低饱和，深色浅色都能看
  const hue = (1 - t) * 220;
  return `hsla(${hue}, 70%, 50%, 0.22)`;
}

// Excel 式字段矩阵：行=代币（按倍率降序），列=各字段，格=字段值 + 热力染色。
export default function MatrixTable({ rows, fields, light }) {
  const [picked, setPicked] = useState([]);           // 选中要展示的字段
  const [heatmap, setHeatmap] = useState(true);
  const [topN, setTopN] = useState(0);                // 0=全部，>0=只看倍率最高的前 N 行
  const [smartSort, setSmartSort] = useState(false);  // 按与倍率的相关性重排列
  const WEAK_RHO = 0.1;                                // |ρ| 小于这个算"没啥关系"

  // 按倍率降序，可选只取前 N
  const dataRows = useMemo(() => {
    const sorted = rows.slice().sort((a, b) => (b.returnMax || 0) - (a.returnMax || 0));
    return topN > 0 ? sorted.slice(0, topN) : sorted;
  }, [rows, topN]);

  // 每列与 returnMax 的 Spearman 相关性 + 覆盖率（有数据的行占比）。
  // 用 Spearman（秩相关）而不是 Pearson：收益是极端右尾，秩相关抗那几个 50x 的干扰。
  const colStats = useMemo(() => {
    const m = {};
    for (const f of picked) {
      const pairs = [];
      for (const row of dataRows) {
        const v = Number(getFeature(row, f)), ret = Number(row.returnMax);
        if (Number.isFinite(v) && Number.isFinite(ret)) pairs.push([v, ret]);
      }
      const rho = pairs.length >= 3 ? spearman(pairs) : NaN;
      m[f] = { rho: Number.isFinite(rho) ? rho : null, n: pairs.length,
        coverage: dataRows.length ? pairs.length / dataRows.length : 0 };
    }
    return m;
  }, [dataRows, picked]);

  // 列顺序：智能排序开启时，按"正相关在前、负相关在后、没数据/没关系甩最后"重排。
  const orderedFields = useMemo(() => {
    if (!smartSort) return picked;
    const rank = f => {
      const st = colStats[f];
      if (!st || st.coverage === 0) return { grp: 3, key: 0 };          // 没数据 → 最后
      if (st.rho === null || Math.abs(st.rho) < WEAK_RHO) return { grp: 2, key: 0 };  // 没啥关系 → 倒数第二组
      return { grp: st.rho > 0 ? 0 : 1, key: -st.rho };                 // 正相关(0)在前、负相关(1)在后，组内按 |ρ| 降序
    };
    return picked.slice().sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      return ra.grp - rb.grp || ra.key - rb.key;
    });
  }, [smartSort, picked, colStats]);

  // 每列的 min/max，用于热力归一（含 returnMax）
  const ranges = useMemo(() => {
    const r = {};
    for (const f of ['returnMax', ...orderedFields]) {
      let mn = Infinity, mx = -Infinity;
      for (const row of dataRows) {
        const v = f === 'returnMax' ? Number(row.returnMax) : Number(getFeature(row, f));
        if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
      }
      r[f] = { min: mn, max: mx };
    }
    return r;
  }, [dataRows, orderedFields]);

  const cell = (f, v) => {
    const bg = heatmap ? heatColor(v, ranges[f]?.min, ranges[f]?.max) : 'transparent';
    return { props: { style: { background: bg, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } },
      children: Number.isFinite(v) ? formatNumberSmart(v) : <span style={{ opacity: .3 }}>—</span> };
  };

  const columns = [
    { title: 'symbol', dataIndex: 'symbol', width: 110, fixed: 'left',
      render: (v, r) => <a href={logearnUrl(r.tokenAddress)} target="_blank" rel="noopener noreferrer">{v || r.tokenAddress?.slice(0, 6)}</a> },
    { title: <b>returnMax</b>, dataIndex: 'returnMax', width: 110, fixed: 'left',
      defaultSortOrder: 'descend', sorter: (a, b) => a.returnMax - b.returnMax,
      render: v => { const c = cell('returnMax', Number(v)); return { props: c.props,
        children: <b>{Number(v).toFixed(2)}x</b> }; } },
    ...orderedFields.map(f => {
      const st = colStats[f] || {};
      const rho = st.rho;
      const weak = st.coverage === 0 || rho === null || Math.abs(rho) < WEAK_RHO;
      const rhoTag = st.coverage === 0 ? <span style={{ color: '#8e8e93' }}>无数据</span>
        : rho === null ? null
        : <span style={{ color: rho > 0 ? '#30d158' : '#ff453a', fontSize: 10 }}>ρ={rho > 0 ? '+' : ''}{rho.toFixed(2)}</span>;
      return {
        title: <div style={{ opacity: smartSort && weak ? 0.45 : 1 }}>
          <div title={getFieldDesc(f)} style={{ fontSize: 11 }}>{f.replace(/^chip_analysis\.|^gmgn\./, '')}</div>
          {smartSort && <div>{rhoTag}</div>}
        </div>,
        key: f, width: 130, align: 'right',
        sorter: (a, b) => (Number(getFeature(a, f)) || -Infinity) - (Number(getFeature(b, f)) || -Infinity),
        render: (_, r) => cell(f, Number(getFeature(r, f))),
      };
    }),
  ];

  function exportCsv() {
    const header = ['symbol', 'CA', 'returnMax', ...orderedFields];
    const lines = [header.join(',')];
    for (const r of dataRows) {
      const vals = [r.symbol || '', r.tokenAddress || '', r.returnMax,
        ...orderedFields.map(f => { const v = getFeature(r, f); return Number.isFinite(Number(v)) ? Number(v) : ''; })];
      lines.push(vals.map(x => (typeof x === 'string' && x.includes(',') ? `"${x}"` : x)).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `字段矩阵_${dataRows.length}行_${picked.length}列_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    message.success('已导出 CSV');
  }

  return (
    <Card size="small" title="字段矩阵表（Excel 式）"
      extra={<Space>
        <FieldPickerModal fields={fields} multiple selected={picked}
          onPickMany={fs => setPicked(p => [...new Set([...p, ...fs])])}
          buttonText="选字段（列）" />
        <Button icon={<DownloadOutlined />} onClick={exportCsv} disabled={!picked.length}>导出 CSV</Button>
      </Space>}>
      <Space wrap style={{ marginBottom: 10 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          每行一个代币（按 returnMax 降序），每列一个字段。开热力后，每列按自身高低染成蓝→红——
          扫最上面几行（高倍率）就能看出哪些字段普遍偏高/偏低。
        </Typography.Text>
      </Space>
      <Space wrap style={{ marginBottom: 10 }}>
        <Checkbox checked={heatmap} onChange={e => setHeatmap(e.target.checked)}>热力染色</Checkbox>
        <Checkbox checked={smartSort} onChange={e => setSmartSort(e.target.checked)}>
          <span title="按每列与 returnMax 的 Spearman 相关性重排：正相关在前、负相关在后、没数据/没关系的甩到最后">智能排序（按相关性）</span>
        </Checkbox>
        {smartSort && picked.length > 0 && (
          <Button size="small" onClick={() => {
            // 真的移除"没关系/没数据"的列——正相关、负相关都留下
            const keep = picked.filter(f => { const st = colStats[f]; return st && st.coverage > 0 && st.rho !== null && Math.abs(st.rho) >= WEAK_RHO; });
            setPicked(keep);
          }}>隐藏无关/空列</Button>
        )}
        <span style={{ fontSize: 12 }}>只看倍率最高的前</span>
        <InputNumber size="small" min={0} value={topN} onChange={v => setTopN(v || 0)} style={{ width: 90 }}
          placeholder="0=全部" />
        <span style={{ fontSize: 12, opacity: .6 }}>行（0=全部 {rows.length} 行）</span>
        {picked.map(f => (
          <Tag key={f} closable onClose={() => setPicked(p => p.filter(x => x !== f))}
            style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }}>{f}</Tag>
        ))}
        {picked.length > 0 && <Button size="small" type="text" danger onClick={() => setPicked([])}>清空列</Button>}
      </Space>

      {picked.length === 0
        ? <Typography.Text type="secondary">点「选字段（列）」挑几个字段当表头，就能看它们在各倍率下的取值。</Typography.Text>
        : <Table size="small" rowKey={r => r.id || r.tokenAddress} columns={columns} dataSource={dataRows}
            scroll={{ x: 320 + picked.length * 130, y: 560 }}
            pagination={{ pageSize: 100, size: 'small', showSizeChanger: true }}
            sticky />}
    </Card>
  );
}
