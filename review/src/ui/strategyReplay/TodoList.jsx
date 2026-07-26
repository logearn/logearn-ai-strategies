import React, { useEffect, useState } from 'react';
import { List, Checkbox, Input, Button, Space, Tag, Typography, Popconfirm, Empty } from 'antd';
import { listBatches } from '../../lib/dataStore.js';
import { loadBacktestReports } from '../../lib/backtestReports.js';
import { loadTodos, saveTodos, addTodo, toggleTodo, removeTodo,
         loadIgnoredDates, saveIgnoredDates, ignoreDate,
         findMissingReportDates } from '../../lib/todoList.js';

// 待办清单：自动提醒"哪天有数据但还没存回测报告"（跟下面的回测报告存档联动，
// 存完当天报告提醒自动消失，不需要手动勾掉）+ 手动记的自由待办。合并展示成一个列表。
export default function TodoList({ refreshKey }) {
  const [todos, setTodos] = useState(loadTodos);
  const [ignoredDates, setIgnoredDates] = useState(loadIgnoredDates);
  const [missingDates, setMissingDates] = useState([]);
  const [text, setText] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const metas = await listBatches();
        const reports = loadBacktestReports();
        const missing = findMissingReportDates(metas, reports.map(r => r.date), ignoredDates);
        if (!cancelled) setMissingDates(missing);
      } catch { /* IndexedDB 不可用（隐私模式等）——自动提醒本来就是锦上添花，静默跳过 */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, ignoredDates]);

  const handleAdd = () => {
    if (!text.trim()) return;
    const next = addTodo(todos, text);
    setTodos(next);
    saveTodos(next);
    setText('');
  };

  const handleToggle = id => {
    const next = toggleTodo(todos, id);
    setTodos(next);
    saveTodos(next);
  };

  const handleRemove = id => {
    const next = removeTodo(todos, id);
    setTodos(next);
    saveTodos(next);
  };

  const handleIgnore = date => {
    const next = ignoreDate(ignoredDates, date);
    setIgnoredDates(next);
    saveIgnoredDates(next);
  };

  const hasAny = missingDates.length > 0 || todos.length > 0;

  return (
    <div style={{ marginBottom: 12 }}>
      <Space wrap style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>待办：</Typography.Text>
        <Input style={{ width: 260 }} value={text} onChange={e => setText(e.target.value)}
          onPressEnter={handleAdd} placeholder="添加一条待办（比如调 xxx 因子权重）" />
        <Button size="small" onClick={handleAdd} disabled={!text.trim()}>添加</Button>
      </Space>
      {!hasAny ? null : (
        <List size="small" bordered
          dataSource={[
            ...missingDates.map(d => ({ kind: 'auto', date: d })),
            ...todos.map(t => ({ kind: 'manual', ...t })),
          ]}
          renderItem={item => item.kind === 'auto' ? (
            <List.Item
              actions={[<Button key="ignore" size="small" onClick={() => handleIgnore(item.date)}>忽略</Button>]}>
              <Tag color="warning">自动</Tag>
              <span style={{ fontSize: 13 }}>{item.date} 有数据，但还没存回测报告——去"策略"tab 跑一遍回放并存档</span>
            </List.Item>
          ) : (
            <List.Item
              actions={[<Popconfirm key="del" title="删除这条待办？" onConfirm={() => handleRemove(item.id)}>
                <Button size="small" danger>删除</Button>
              </Popconfirm>]}>
              <Checkbox checked={item.done} onChange={() => handleToggle(item.id)}>
                <span style={{ fontSize: 13, textDecoration: item.done ? 'line-through' : 'none', opacity: item.done ? .55 : 1 }}>
                  {item.text}
                </span>
              </Checkbox>
            </List.Item>
          )} />
      )}
    </div>
  );
}
