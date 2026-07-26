import React, { useMemo, useState } from 'react';
import { Modal, Button, Input, Card, Tag, Tooltip, Space, Empty, message } from 'antd';
import { AppstoreOutlined, CopyOutlined, PlusOutlined } from '@ant-design/icons';
import { computeFieldGroups, GROUP_LABELS, GROUP_ORDER } from '../lib/fieldGroups.js';
import { getFieldDesc } from '../lib/dictionary.js';

// 分组字段看板。200+ 个字段光靠下拉联想很难"逛"——
// 这里把 8 个主题分组平铺出来，可以整组加、也可以点单个字段加。
// 分组口径与字段浏览器、字段说明导出共用同一个 computeFieldGroups，不会漂移。
export default function FieldPickerModal({
  fields, selected = [], onPick, onPickMany, multiple = false,
  buttonText = '按分组浏览字段', buttonProps,
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const groups = useMemo(() => computeFieldGroups(fields), [fields]);

  const match = f => !q.trim() || f.toLowerCase().includes(q.trim().toLowerCase())
    || getFieldDesc(f).toLowerCase().includes(q.trim().toLowerCase());

  const pick = f => {
    if (multiple) { onPickMany?.([f]); }
    else { onPick?.(f); setOpen(false); }
  };

  const visible = GROUP_ORDER
    .map(key => ({ key, list: groups[key].filter(match) }))
    .filter(g => g.list.length);
  const totalShown = visible.reduce((n, g) => n + g.list.length, 0);

  return (
    <>
      <Button icon={<AppstoreOutlined />} onClick={() => setOpen(true)} {...buttonProps}>{buttonText}</Button>
      <Modal open={open} onCancel={() => setOpen(false)} footer={null} width="min(1500px, 94vw)"
        title={<Space>
          <span>按分组浏览字段</span>
          <Input.Search allowClear placeholder="搜字段名或中文含义" value={q}
            onChange={e => setQ(e.target.value)} style={{ width: 300 }} />
          <span style={{ fontSize: 12, opacity: .55, fontWeight: 400 }}>
            {totalShown} / {fields.length} 个字段{multiple && ` · 已选 ${selected.length} 个`}
          </span>
        </Space>}
        styles={{ body: { maxHeight: '72vh', overflow: 'auto' } }}>
        {visible.length === 0 && <Empty description="没有匹配的字段" />}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 12 }}>
          {visible.map(({ key, list }) => (
            <Card key={key} size="small" title={<span style={{ fontSize: 13 }}>{GROUP_LABELS[key]}（{list.length}）</span>}
              extra={<Space size={4}>
                <Tooltip title="复制该组全部字段名，每行一个">
                  <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => {
                    navigator.clipboard?.writeText(list.join('\n'));
                    message.success(`已复制 ${list.length} 个字段名`);
                  }} />
                </Tooltip>
                {multiple && (
                  <Tooltip title="整组加入">
                    <Button size="small" type="text" icon={<PlusOutlined />}
                      onClick={() => { onPickMany?.(list); message.success(`已加入 ${list.length} 个字段`); }} />
                  </Tooltip>
                )}
              </Space>}
              styles={{ body: { maxHeight: 210, overflow: 'auto', padding: 10 } }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {list.map(f => {
                  const on = selected.includes(f);
                  return (
                    <Tooltip key={f} title={getFieldDesc(f) || f} mouseEnterDelay={0.3}>
                      <Tag color={on ? 'blue' : undefined} onClick={() => pick(f)}
                        style={{ cursor: 'pointer', margin: 0, fontSize: 11,
                          fontFamily: 'ui-monospace, Menlo, monospace' }}>
                        {f}{on ? ' ✓' : ''}
                      </Tag>
                    </Tooltip>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      </Modal>
    </>
  );
}
