import React, { useState } from 'react';
import { Space, Input, Button, Table, Popconfirm, Typography, message } from 'antd';
import { loadStrategyVersions, saveStrategyVersions, addStrategyVersion,
         removeStrategyVersion, extractVersionHint, updateStrategyVersion,
         duplicateStrategyVersion } from '../../lib/strategyVersions.js';

// 策略版本库：手动存档当前代码框里的策略，跟数据源无关——自己选哪个版本、在当前数据源上跑。
// 只存/命名，不清空编辑框（归档 = 留一份存档，不是"提交"语义）；加载版本会覆盖编辑框内容。
export default function StrategyVersions({ code, onLoad }) {
  const [versions, setVersions] = useState(loadStrategyVersions);
  const [name, setName] = useState('');

  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed || !code.trim()) return;
    const next = addStrategyVersion(versions, { name: trimmed, code });
    setVersions(next);
    saveStrategyVersions(next);
    setName('');
    message.success(`已存为版本「${trimmed}」`);
  };

  const handleRemove = id => {
    const next = removeStrategyVersion(versions, id);
    setVersions(next);
    saveStrategyVersions(next);
  };

  // 就地更新：用编辑框当前代码覆盖这个版本（名字不变、刷新时间）
  const handleUpdate = id => {
    if (!code.trim()) { message.warning('编辑框是空的，没什么可更新'); return; }
    const next = updateStrategyVersion(versions, id, code);
    setVersions(next);
    saveStrategyVersions(next);
    message.success('已用当前代码更新这个版本');
  };

  // 复制：克隆一份（名字加"副本"），插到最前，方便在某版基础上另起分支调
  const handleDuplicate = id => {
    const next = duplicateStrategyVersion(versions, id);
    setVersions(next);
    saveStrategyVersions(next);
    message.success('已复制一份副本');
  };

  return (
    <div style={{ marginTop: 8 }}>
      <Space wrap>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>策略版本库：</Typography.Text>
        <Input style={{ width: 220 }} value={name} onChange={e => setName(e.target.value)}
          onPressEnter={handleSave}
          placeholder={extractVersionHint(code) || '版本名（比如 score-v2.1.0）'} />
        <Button size="small" disabled={!name.trim() || !code.trim()} onClick={handleSave}>存为新版本</Button>
      </Space>
      {versions.length > 0 && (
        <Table style={{ marginTop: 6 }} size="small" rowKey="id" pagination={{ pageSize: 5, size: 'small' }}
          dataSource={versions}
          columns={[
            { title: '版本名', dataIndex: 'name' },
            { title: '存入时间', width: 160, render: (_, v) => new Date(v.savedAt).toLocaleString() },
            { title: '操作', width: 320, render: (_, v) => (
              <Space size={8}>
                <Button size="small" onClick={() => onLoad(v.code)}>加载到编辑框</Button>
                <Popconfirm title="用编辑框当前代码覆盖这个版本？（名字不变，原代码会被替换）"
                  onConfirm={() => handleUpdate(v.id)}>
                  <Button size="small" type="primary" ghost disabled={!code.trim()}>更新为当前代码</Button>
                </Popconfirm>
                <Button size="small" onClick={() => handleDuplicate(v.id)}>复制</Button>
                <Popconfirm title="删除这个版本？" onConfirm={() => handleRemove(v.id)}>
                  <Button size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ) },
          ]} />
      )}
    </div>
  );
}
