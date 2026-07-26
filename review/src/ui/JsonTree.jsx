import React, { useEffect, useState } from 'react';
import { Typography } from 'antd';

const isObj = v => v !== null && typeof v === 'object';
const preview = v => {
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (isObj(v)) return `{${Object.keys(v).length} 个字段}`;
  if (typeof v === 'string') return `"${v.length > 60 ? v.slice(0, 60) + '…' : v}"`;
  return String(v);
};
const valueColor = v => {
  if (v === null || v === undefined) return '#8e8e93';
  if (typeof v === 'number') return '#0a84ff';
  if (typeof v === 'boolean') return '#bf5af2';
  if (typeof v === 'string') return '#30d158';
  return 'inherit';
};

// 把文本里命中 needle 的部分高亮。needle 已小写。
function highlight(text, needle) {
  const str = String(text);
  if (!needle) return str;
  const lower = str.toLowerCase();
  const out = [];
  let i = 0, from = 0;
  while ((i = lower.indexOf(needle, from)) !== -1) {
    if (i > from) out.push(str.slice(from, i));
    out.push(<mark key={i} style={{ background: '#ffd60a', color: '#1d1d1f', padding: '0 1px', borderRadius: 2 }}>{str.slice(i, i + needle.length)}</mark>);
    from = i + needle.length;
  }
  if (from < str.length) out.push(str.slice(from));
  return out;
}

// 子树里（含 key 自身）是否有命中——决定要不要自动展开到这个节点
function subtreeHasMatch(v, key, needle) {
  if (String(key).toLowerCase().includes(needle)) return true;
  if (!isObj(v)) return String(v).toLowerCase().includes(needle);
  const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
  return entries.some(([k, cv]) => subtreeHasMatch(cv, k, needle));
}

function Node({ k, v, depth, defaultOpen, needle }) {
  // override：用户手动点开/收起后的状态。needle 变化时重置，让搜索重新决定展开。
  const [override, setOverride] = useState(null);
  useEffect(() => { setOverride(null); }, [needle]);

  const keyHit = needle && String(k).toLowerCase().includes(needle);
  const pad = { paddingLeft: depth * 14 };

  if (!isObj(v)) {
    return (
      <div style={{ ...pad, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        <span style={{ color: keyHit ? undefined : '#ff9f0a' }}>{highlight(k, needle)}</span>
        <span style={{ opacity: .5 }}>: </span>
        <span style={{ color: valueColor(v) }}>{v === null ? 'null' : highlight(preview(v), needle)}</span>
      </div>
    );
  }

  const hasMatch = needle ? subtreeHasMatch(v, k, needle) : false;
  // 搜索时：命中子树的自动展开；没搜索时：用 defaultOpen。用户点击可覆盖。
  const open = override !== null ? override : (needle ? hasMatch : defaultOpen);
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);

  return (
    <div style={pad}>
      <div onClick={() => setOverride(o => !(o !== null ? o : open))} style={{ cursor: 'pointer', userSelect: 'none' }}>
        <span style={{ opacity: .5, display: 'inline-block', width: 12 }}>{open ? '▾' : '▸'}</span>
        <span style={{ color: '#ff9f0a' }}>{highlight(k, needle)}</span>
        <span style={{ opacity: .5 }}>: {preview(v)}</span>
      </div>
      {open && entries.map(([ck, cv]) => (
        <Node key={ck} k={ck} v={cv} depth={depth + 1} defaultOpen={false} needle={needle} />
      ))}
    </div>
  );
}

export default function JsonTree({ data, rootLabel = 'root', defaultOpen = true, highlight: hl = '' }) {
  if (data === null || data === undefined) {
    return <Typography.Text type="secondary">（无数据）</Typography.Text>;
  }
  const needle = String(hl || '').trim().toLowerCase();
  return (
    <div style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.7 }}>
      <Node k={rootLabel} v={data} depth={0} defaultOpen={defaultOpen} needle={needle} />
    </div>
  );
}
