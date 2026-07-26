import React, { useState } from 'react';
import { Card, Select, Input, Button, Space, Table, Alert, Typography, message } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { applyFilter, FILTER_OPS } from '../lib/filter.js';
import { getFeature } from '../lib/data.js';
import { formatNumberSmart, logearnUrl } from '../lib/utils.js';
import { useGroupedFieldOptions, renderFieldOption, fieldFilterOption } from './fieldOptions.jsx';
import FieldPickerModal from './FieldPickerModal.jsx';

const PRESET_KEY = 'chart_filter_presets_v2';
const loadPresets = () => { try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || {}; } catch { return {}; } };
const savePresets = p => { try { localStorage.setItem(PRESET_KEY, JSON.stringify(p)); } catch { /* 隐私模式 */ } };

export default function FilterPanel({ rows, fields, onActiveRows }) {
  const [conds, setConds] = useState([{ field: undefined, op: '>=', threshold: '' }]);
  const [result, setResult] = useState(null);
  const [presets, setPresets] = useState(loadPresets);
  const [presetName, setPresetName] = useState('');
  const [picked, setPicked] = useState();

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
    onActiveRows(rows, false);
  }

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
    <Card size="small" title="全局条件过滤 & 筛选 CA"
      extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>
        条件之间是「与」关系；筛选后下方所有分析都基于过滤结果
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
