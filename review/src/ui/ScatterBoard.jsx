import React, { useState, useMemo } from 'react';
import { Card, Select, Button, Space, Empty, Input, Typography, Tag } from 'antd';
import ScatterCard from './ScatterCard.jsx';
import { useGroupedFieldOptions, renderFieldOption, fieldFilterOption } from './fieldOptions.jsx';
import FieldPickerModal from './FieldPickerModal.jsx';

export default function ScatterBoard({ rows, fields, light, onAddToCampLibrary,
  campGroups = [], campActiveGroup, onCampActiveGroupChange }) {
  const fieldOptions = useGroupedFieldOptions(fields);
  const [pick, setPick] = useState();
  const [charts, setCharts] = useState([]);
  const [colorField, setColorField] = useState();
  // 查找 CA：粘一批地址（逗号/空格/换行/顿号分隔），命中的点在所有散点图里用红星高亮（跨图共享）
  const [caInput, setCaInput] = useState('');
  const highlightCAs = useMemo(
    () => new Set(caInput.split(/[\s,，、;；]+/).map(s => s.trim().toLowerCase()).filter(Boolean)),
    [caInput]);
  // 有多少高亮 CA 真的落在当前工作集里（给个反馈，免得粘了一堆却一个都没匹配上还不知道为什么）
  const matchedCount = useMemo(() => {
    if (!highlightCAs.size) return 0;
    let n = 0;
    for (const r of rows) if (r.tokenAddress && highlightCAs.has(String(r.tokenAddress).toLowerCase())) n++;
    return n;
  }, [rows, highlightCAs]);

  return (
    <>
      <Card size="small" title="散点图">
        <Space wrap>
          <Select showSearch placeholder="选择 X 字段（按分组浏览，可搜中文含义）" style={{ width: 360 }}
            value={pick} onChange={setPick} options={fieldOptions}
            optionRender={renderFieldOption} filterOption={fieldFilterOption} listHeight={420} />
          <Button type="primary" disabled={!pick || charts.includes(pick)}
            onClick={() => setCharts(c => [...c, pick])}>添加</Button>
          <FieldPickerModal fields={fields} multiple selected={charts}
            onPickMany={fs => setCharts(c => [...new Set([...c, ...fs])])} />
          <Select allowClear showSearch placeholder="颜色字段（可选）" style={{ width: 280 }}
            value={colorField} onChange={setColorField} options={fieldOptions}
            optionRender={renderFieldOption} filterOption={fieldFilterOption} listHeight={420} />
          {charts.length > 0 && <Button danger onClick={() => setCharts([])}>清空全部图表</Button>}
        </Space>
        {/* 查找 CA：粘一批地址，命中的点在所有散点图里红星高亮（逗号/空格/换行分隔） */}
        <Space wrap style={{ marginTop: 8, width: '100%' }} align="start">
          <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap', lineHeight: '24px' }}>查找 CA（高亮）：</Typography.Text>
          <Input.TextArea value={caInput} onChange={e => setCaInput(e.target.value)} autoSize={{ minRows: 1, maxRows: 3 }}
            style={{ width: 520, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}
            placeholder="粘一批 CA（逗号/空格/换行分隔），命中的点在所有散点图里用红星高亮" />
          {highlightCAs.size > 0 && (
            <Tag color={matchedCount ? 'success' : 'warning'} style={{ lineHeight: '22px' }}>
              {matchedCount ? `已高亮 ${matchedCount}/${highlightCAs.size} 个` : `${highlightCAs.size} 个都没匹配到当前工作集`}
            </Tag>
          )}
          {caInput && <Button size="small" onClick={() => setCaInput('')}>清空</Button>}
        </Space>
        {charts.length === 0 && (
          <Empty style={{ margin: '16px 0 0' }} image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="选一个字段加图。Y 轴固定为 returnMax，可在图内交换 X/Y" />
        )}
      </Card>
      {charts.map(f => (
        <ScatterCard key={f} rows={rows} xField={f} yField="returnMax"
          colorField={colorField} light={light} onAddToCampLibrary={onAddToCampLibrary}
          campGroups={campGroups} campActiveGroup={campActiveGroup} onCampActiveGroupChange={onCampActiveGroupChange}
          highlightCAs={highlightCAs}
          onRemove={() => setCharts(c => c.filter(x => x !== f))} />
      ))}
    </>
  );
}
