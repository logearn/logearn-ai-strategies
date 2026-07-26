import React from 'react';
import { Popover, Button, Space, Tag, Typography } from 'antd';

// 三张表共用的「已移除字段·恢复」条：显示移除数量，点开可逐个/全部恢复。
// hidden: string[]；onRestore(field)；onRestoreAll()。没有移除字段时不渲染。
export default function HiddenFieldsBar({ hidden, onRestore, onRestoreAll }) {
  if (!hidden || !hidden.length) return null;
  return (
    <Popover trigger="click" placement="bottomLeft"
      title={`已移除 ${hidden.length} 个字段（只在本表隐藏）`}
      content={
        <div style={{ maxWidth: 360, maxHeight: 260, overflow: 'auto' }}>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {hidden.map(f => (
              <div key={f} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{f}</code>
                <Button size="small" type="link" style={{ padding: 0 }} onClick={() => onRestore(f)}>恢复</Button>
              </div>
            ))}
          </Space>
          <div style={{ marginTop: 6, textAlign: 'right' }}>
            <Button size="small" onClick={onRestoreAll}>全部恢复</Button>
          </div>
        </div>
      }>
      <Button size="small">
        恢复 <Tag color="default" style={{ marginLeft: 4 }}>{hidden.length}</Tag>
      </Button>
    </Popover>
  );
}
