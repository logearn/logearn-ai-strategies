import React, { useMemo, useState } from 'react';
import { Card, Input, Button, Collapse, Tag, Tooltip, Typography, message } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { computeFieldGroups, GROUP_LABELS, GROUP_ORDER } from '../lib/fieldGroups.js';
import { buildFieldDocs } from '../lib/fieldDocs.js';
import { getFieldDesc } from '../lib/dictionary.js';

export default function FieldBrowser({ fields }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => computeFieldGroups(fields), [fields]);
  const match = f => !q.trim() || f.toLowerCase().includes(q.trim().toLowerCase())
    || getFieldDesc(f).toLowerCase().includes(q.trim().toLowerCase());

  function exportDocs() {
    const { markdown, total, rawCount, madeCount } = buildFieldDocs(fields);
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `字段说明_${total}字段_${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    message.success(`已导出 ${total} 个字段（原生 ${rawCount} / 组装 ${madeCount}）`);
  }

  const items = GROUP_ORDER.map(key => {
    const list = groups[key].filter(match);
    if (!list.length) return null;
    return {
      key, label: `${GROUP_LABELS[key]}（${list.length}）`,
      children: <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 220, overflow: 'auto' }}>
        {list.map(f => (
          <Tooltip key={f} title={getFieldDesc(f)}>
            <Tag style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, margin: 0 }}>{f}</Tag>
          </Tooltip>
        ))}
      </div>,
    };
  }).filter(Boolean);

  return (
    <Card size="small" title="字段浏览器"
      extra={<Button icon={<DownloadOutlined />} onClick={exportDocs}>导出字段说明（Markdown）</Button>}>
      <Input.Search allowClear placeholder="搜索字段名或中文含义" value={q}
        onChange={e => setQ(e.target.value)} style={{ maxWidth: 360, marginBottom: 12 }} />
      <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 12 }}>共 {fields.length} 个字段</Typography.Text>
      <Collapse size="small" items={items} defaultActiveKey={q.trim() ? items.map(i => i.key) : ['holding']}
        activeKey={q.trim() ? items.map(i => i.key) : undefined} />
    </Card>
  );
}
