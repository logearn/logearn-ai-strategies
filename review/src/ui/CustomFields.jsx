import React, { useState } from 'react';
import { Card, Input, Button, Space, Table, Alert, Typography, message } from 'antd';
import { loadDefs, saveDefs, applyDefs, testDef, validateName } from '../lib/customFieldsRuntime.js';

// 自定义字段：用表达式从已有字段算新字段。
export default function CustomFields({ rows, fields, onApplied }) {
  const [defs, setDefs] = useState(loadDefs);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [editIdx, setEditIdx] = useState(-1);
  const [preview, setPreview] = useState(null);
  const [stats, setStats] = useState(null);

  const persist = next => { setDefs(next); saveDefs(next); };
  function apply(next = defs) {
    if (!rows.length) return;
    const st = applyDefs(rows, next);
    setStats(st);
    onApplied && onApplied([...st.values()]);
  }
  function save() {
    const v = validateName(name, defs, fields, editIdx);
    if (v.error) { message.error(v.error); return; }
    if (!code.trim()) { message.error('请填写表达式'); return; }
    const next = editIdx >= 0 ? defs.map((d, i) => (i === editIdx ? { name: v.name, code } : d))
                              : [...defs, { name: v.name, code }];
    persist(next);
    setName(''); setCode(''); setEditIdx(-1); setPreview(null);
    message.success(`已保存 ${v.name}`);
    apply(next);
  }
  function test() {
    if (!rows.length) { message.error('请先加载数据'); return; }
    const r = testDef(rows, code);
    setPreview(r);
    if (r.error) message.error(r.error);
  }

  const columns = [
    { title: '字段', dataIndex: 'name', width: 220, render: v => <code style={{ fontSize: 11 }}>{v}</code> },
    { title: '表达式', dataIndex: 'code', ellipsis: true,
      render: v => <code style={{ fontSize: 11 }}>{v}</code> },
    { title: '有效/总数', width: 110, align: 'right',
      render: (_, d) => { const st = stats?.get(d.name); return st ? `${st.ok}/${st.total}` : '-'; } },
    { title: '取值范围', width: 180, align: 'right',
      render: (_, d) => { const st = stats?.get(d.name);
        return st && st.ok ? `${Number(st.min).toPrecision(3)} ~ ${Number(st.max).toPrecision(3)}` : '-'; } },
    { title: '', width: 130, render: (_, d, i) => (
      <Space size={4}>
        <Button size="small" onClick={() => { setEditIdx(i); setName(d.name); setCode(d.code); }}>编辑</Button>
        <Button size="small" danger onClick={() => {
          const next = defs.filter((_, j) => j !== i);
          persist(next);
          for (const r of rows) delete r.features[d.name];
          apply(next);
        }}>删除</Button>
      </Space>) },
  ];

  return (
    <Card size="small" title="自定义字段"
      extra={<Button onClick={() => apply()} disabled={!rows.length || !defs.length}>
        重新计算全部（{defs.length} 个）</Button>}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        <code>f['字段名']</code> 取字段值，<code>row</code> 取行级信息，可用{' '}
        <code>safeDiv / pct / clamp / log1p / zscore</code> 和 <code>countWhere / avgField / sumField</code>。
        定义顺序即计算顺序，后面的可以引用前面的结果。
      </Typography.Paragraph>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input style={{ width: 240 }} placeholder="字段名（自动加 custom. 前缀）"
          value={name} onChange={e => setName(e.target.value)} />
        <Input style={{ width: 420 }} placeholder="表达式，如 safeDiv(f['smart_volume'], f['new_volume'])"
          value={code} onChange={e => setCode(e.target.value)} />
        <Button onClick={test} disabled={!code.trim()}>试算</Button>
        <Button type="primary" onClick={save}>{editIdx >= 0 ? '保存修改' : '添加'}</Button>
        {editIdx >= 0 && <Button onClick={() => { setEditIdx(-1); setName(''); setCode(''); }}>取消</Button>}
      </Space>

      {preview && !preview.error && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message={
          <div style={{ fontSize: 12 }}>
            试算：{preview.total} 条里 <b>{preview.ok}</b> 条算出有效数值
            {preview.ok < preview.total && <>（{preview.total - preview.ok} 条无值——可能是缺字段或除零，
              这些样本该字段会<b>缺失而不是记 0</b>）</>}
            {preview.samples.length > 0 && <><br />样例：
              {preview.samples.map(s => `${s.symbol}=${Number(s.value).toPrecision(4)}`).join('　')}</>}
            {preview.errors.length > 0 && <><br /><span style={{ color: '#ff9f0a' }}>报错样例：{preview.errors[0]}</span></>}
          </div>} />
      )}

      {defs.length > 0 && <Table size="small" rowKey="name" columns={columns} dataSource={defs} pagination={false} />}
      {stats && [...stats.values()].some(s => s.err > 0) && (
        <Alert type="warning" showIcon style={{ marginTop: 12 }}
          message={`有字段计算报错：${[...stats.values()].filter(s => s.err > 0).map(s => `${s.name}(${s.err}条)`).join('、')}`} />
      )}
    </Card>
  );
}
