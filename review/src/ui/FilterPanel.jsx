import React, { useMemo, useState } from 'react';
import { Card, Select, Input, Button, Space, Table, Alert, Typography, Tag, message } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { applyFilter, FILTER_OPS } from '../lib/filter.js';
import { getFeature } from '../lib/data.js';
import { formatNumberSmart, logearnUrl } from '../lib/utils.js';
import { useGroupedFieldOptions, renderFieldOption, fieldFilterOption } from './fieldOptions.jsx';
import FieldPickerModal from './FieldPickerModal.jsx';

const PRESET_KEY = 'chart_filter_presets_v2';
const loadPresets = () => { try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || {}; } catch { return {}; } };
const savePresets = p => { try { localStorage.setItem(PRESET_KEY, JSON.stringify(p)); } catch { /* 隐私模式 */ } };

// 数据完备性检测：这三个顶层节点都是"整段可能整体缺失"的外部数据源（不是某个字段偶尔是 0/null），
// gmgn 约四成快照没有、holders/chip_analysis 也可能因为抓取失败整段缺失——缺失时下面依赖它们的
// 组装字段会大片是 undefined，分析出来的规律其实是"有没有这段数据"而不是真实信号。
const COMPLETENESS_NODES = [
  { value: 'gmgn', label: 'gmgn（GMGN 行情/交易者画像）' },
  { value: 'holders', label: 'holders（持有人列表）' },
  { value: 'chip_analysis', label: 'chip_analysis（筹码分布）' },
];
function hasNodeContent(ctx, node) {
  const v = ctx && ctx[node];
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

export default function FilterPanel({ rows, fields, onActiveRows }) {
  const [conds, setConds] = useState([{ field: undefined, op: '>=', threshold: '' }]);
  const [result, setResult] = useState(null);
  const [presets, setPresets] = useState(loadPresets);
  const [presetName, setPresetName] = useState('');
  const [picked, setPicked] = useState();
  const [requiredNodes, setRequiredNodes] = useState([]);
  const [completenessApplied, setCompletenessApplied] = useState(false);

  const fieldOptions = useGroupedFieldOptions(fields);
  const isValidField = f => fields.includes(f);
  const upd = (i, k, v) => setConds(cs => cs.map((c, j) => (j === i ? { ...c, [k]: v } : c)));

  function run() {
    const r = applyFilter(rows, conds, isValidField);
    setResult(r);
    onActiveRows(r.rows, r.conditions.length > 0);
  }
  function clear() {
    setConds([{ field: undefined, op: '>=', threshold: '' }]);
    setResult(null);
    setCompletenessApplied(false);
    onActiveRows(rows, false);
  }

  // 完备性检测按 rows（当前工作集，不是已过滤结果）现算，跟条件过滤各自独立算，互不影响。
  const completeness = useMemo(() => {
    if (!requiredNodes.length) return null;
    const missingBy = Object.fromEntries(requiredNodes.map(n => [n, 0]));
    const completeRows = [], incompleteRows = [];
    for (const r of rows) {
      let ok = true;
      for (const n of requiredNodes) if (!hasNodeContent(r.rawCtx, n)) { missingBy[n]++; ok = false; }
      (ok ? completeRows : incompleteRows).push(r);
    }
    return { total: rows.length, complete: completeRows.length, incomplete: incompleteRows.length, missingBy, completeRows, incompleteRows };
  }, [rows, requiredNodes]);

  const columns = [
    { title: 'symbol', dataIndex: 'symbol', width: 110 },
    { title: 'token_address', dataIndex: 'tokenAddress', width: 260,
      render: v => <code style={{ fontSize: 11 }}>{v}</code> },
    { title: 'returnMax', dataIndex: 'returnMax', width: 110, align: 'right',
      defaultSortOrder: 'descend', sorter: (a, b) => a.returnMax - b.returnMax,
      render: v => Number(v).toFixed(4) + 'x' },
    { title: '匹配值', render: (_, r) => (result?.conditions || []).map(c => {
        const v = getFeature(r, c.field);
        return `${c.field}: ${typeof v === 'number' ? formatNumberSmart(v) : v}`;
      }).join('　') },
    { title: '', width: 60, render: (_, r) => r.tokenAddress
      ? <a href={logearnUrl(r.tokenAddress)} target="_blank" rel="noopener noreferrer">打开</a> : null },
  ];

  return (
    <Card size="small" title={<Space size={6}>全局条件过滤 & 筛选 CA
        <Tag color="orange" style={{ marginInlineEnd: 0 }}>全局生效</Tag></Space>}
      extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>
        条件之间是「与」关系；筛选后<b>下方所有 tab 的分析</b>都基于过滤结果——跟各卡片里那些"仅筛选本表展示"的过滤器不是一回事
      </Typography.Text>}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {conds.map((c, i) => (
          <Space key={i} wrap>
            <Select showSearch allowClear placeholder="字段名（按分组浏览，可搜中文含义）" style={{ width: 360 }}
              value={c.field} onChange={v => upd(i, 'field', v)}
              status={c.field && !isValidField(c.field) ? 'error' : ''}
              options={fieldOptions} optionRender={renderFieldOption}
              filterOption={fieldFilterOption} listHeight={420} />
            <Select style={{ width: 100 }} value={c.op} onChange={v => upd(i, 'op', v)}
              options={FILTER_OPS.map(o => ({ value: o.value, label: o.label }))} />
            <Input style={{ width: 140 }} placeholder="阈值" value={c.threshold}
              onChange={e => upd(i, 'threshold', e.target.value)} />
            <FieldPickerModal fields={fields} onPick={v => upd(i, 'field', v)}
              buttonText="" buttonProps={{ title: '按分组浏览字段' }} />
            {conds.length > 1 && <Button danger type="text" icon={<DeleteOutlined />}
              onClick={() => setConds(cs => cs.filter((_, j) => j !== i))} />}
          </Space>
        ))}
        <Space wrap>
          <Button icon={<PlusOutlined />} onClick={() => setConds(cs => [...cs, { field: undefined, op: '>=', threshold: '' }])}>
            添加条件</Button>
          <Button type="primary" onClick={run} disabled={!rows.length}>筛选 CA</Button>
          <Button disabled={!result?.rows.length} onClick={() => {
            navigator.clipboard?.writeText((result?.rows || []).map(r => r.tokenAddress).filter(Boolean).join('\n'));
            message.success(`已复制 ${result.rows.length} 个 CA`);
          }}>复制 CA</Button>
          <Button danger onClick={clear}>清除</Button>
        </Space>
        <Space wrap>
          <Input style={{ width: 160 }} placeholder="预设方案名" value={presetName}
            onChange={e => setPresetName(e.target.value)} />
          <Button disabled={!presetName.trim()} onClick={() => {
            const p = { ...presets, [presetName.trim()]: conds };
            setPresets(p); savePresets(p); setPresetName(''); message.success('已保存预设');
          }}>保存为预设</Button>
          <Select allowClear placeholder="选择预设" style={{ width: 180 }} value={picked} onChange={setPicked}
            options={Object.keys(presets).map(k => ({ value: k, label: k }))} />
          <Button disabled={!picked} onClick={() => setConds(presets[picked])}>应用</Button>
          <Button danger disabled={!picked} onClick={() => {
            const p = { ...presets }; delete p[picked];
            setPresets(p); savePresets(p); setPicked(undefined);
          }}>删除预设</Button>
        </Space>
        <Space wrap>
          <Typography.Text style={{ fontSize: 12 }}>数据完备性检测：</Typography.Text>
          <Select mode="multiple" allowClear placeholder="选择 ctx 下必须有内容的节点" style={{ minWidth: 340 }}
            value={requiredNodes} onChange={v => { setRequiredNodes(v); setCompletenessApplied(false); }}
            options={COMPLETENESS_NODES} />
          {completeness && (<>
            <Tag color={completeness.incomplete ? 'warning' : 'success'}>
              完整 {completeness.complete} / {completeness.total}（缺 {completeness.incomplete} 条）
            </Tag>
            {requiredNodes.map(n => (
              <Tag key={n}>{COMPLETENESS_NODES.find(x => x.value === n)?.label.split('（')[0] || n} 缺 {completeness.missingBy[n]}</Tag>
            ))}
            <Button size="small" disabled={!completeness.incomplete} onClick={() => {
              navigator.clipboard?.writeText(completeness.incompleteRows.map(r => r.tokenAddress).filter(Boolean).join('\n'));
              message.success(`已复制 ${completeness.incompleteRows.length} 个缺失样本的 CA`);
            }}>复制缺失 CA</Button>
            {!completenessApplied
              ? <Button size="small" type="primary" disabled={!completeness.incomplete}
                  onClick={() => { onActiveRows(completeness.completeRows, true); setCompletenessApplied(true); }}>
                  只保留完整数据
                </Button>
              : <Button size="small" onClick={() => { onActiveRows(rows, false); setCompletenessApplied(false); }}>
                  取消应用
                </Button>}
          </>)}
        </Space>
      </Space>

      {result && (
        <div style={{ marginTop: 12 }}>
          {result.invalidFields.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 8 }}
            message={`以下字段名未匹配到数据里的实际字段，已忽略：${result.invalidFields.join('、')}`} />}
          {result.emptyThresholds.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 8 }}
            message={`以下字段的阈值为空，已忽略：${result.emptyThresholds.join('、')}`} />}
          <Alert type={result.rows.length ? 'success' : 'warning'} showIcon style={{ marginBottom: 8 }}
            message={<>命中 <b>{result.rows.length}</b> / {result.total} 条，平均 returnMax = <b>
              {result.avgReturn === null ? '-' : result.avgReturn.toFixed(4)}</b>
              {result.conditions.length ? `（已生效 ${result.conditions.length} 个条件，已同步应用到所有分析）` : '（无有效条件，使用完整数据）'}</>} />
          {result.rows.length > 0 && (
            <Table size="small" rowKey="id" columns={columns} dataSource={result.rows}
              scroll={{ x: 800, y: 300 }} pagination={{ pageSize: 20, size: 'small', showSizeChanger: true }} />
          )}
        </div>
      )}
    </Card>
  );
}
