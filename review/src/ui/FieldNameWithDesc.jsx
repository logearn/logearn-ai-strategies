import React from 'react';
import { Tooltip } from 'antd';
import { getFieldDesc } from '../lib/dictionary.js';

// 字段名 + 悬浮看中文含义。
// 含义常常很长（有的字段说明带了完整的口径推导和踩坑记录），直接平铺会把标题挤爆，
// 所以只在 hover 时出现；名字下面加一条虚线下划线，提示"这里可以悬浮"。
export default function FieldNameWithDesc({ field, style }) {
  const desc = getFieldDesc(field);
  if (!desc) return <span style={style}>{field}</span>;
  return (
    <Tooltip title={desc} styles={{ root: { maxWidth: 520 } }} mouseEnterDelay={0.2}>
      <span style={{ borderBottom: '1px dotted currentColor', cursor: 'help', ...style }}>{field}</span>
    </Tooltip>
  );
}
