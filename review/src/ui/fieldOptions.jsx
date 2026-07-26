import React, { useMemo } from 'react';
import { computeFieldGroups, GROUP_LABELS, GROUP_ORDER } from '../lib/fieldGroups.js';
import { getFieldDesc } from '../lib/dictionary.js';

// 字段选择器的分组选项。200+ 个字段拉成一个平铺列表根本找不到东西——
// 按"持仓指标 / 组装字段 / 信号字段 / K线量能 / dev / stat / 筹码 / 持有人"分组，
// 这套分组口径和字段浏览器、字段说明导出共用同一个 computeFieldGroups，不会漂移。
export function useGroupedFieldOptions(fields) {
  return useMemo(() => {
    const g = computeFieldGroups(fields);
    return GROUP_ORDER.map(key => {
      const list = g[key];
      if (!list.length) return null;
      return {
        label: `${GROUP_LABELS[key]}（${list.length}）`,
        options: list.map(f => ({
          value: f,
          // label 用于选中后的回显，必须是纯文本，否则输入框里会渲染出整块 JSX
          label: f,
          desc: getFieldDesc(f),
        })),
      };
    }).filter(Boolean);
  }, [fields]);
}

// 下拉项的渲染：字段名 + 中文含义。含义占一行灰字，扫起来比纯字段名快得多。
export function renderFieldOption(option) {
  if (!option.data || !option.data.desc) return option.label;
  return (
    <div style={{ lineHeight: 1.4, padding: '2px 0' }}>
      <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{option.value}</div>
      <div style={{ fontSize: 11, opacity: .55, whiteSpace: 'normal' }}>{option.data.desc}</div>
    </div>
  );
}

// 搜索同时匹配字段名和中文含义——很多时候只记得"聪明钱"记不住 smart_volume
export function fieldFilterOption(input, option) {
  if (!option || option.options) return false;   // 分组标题本身不参与匹配
  const q = input.toLowerCase();
  return String(option.value).toLowerCase().includes(q)
      || String(option.desc || '').toLowerCase().includes(q);
}
