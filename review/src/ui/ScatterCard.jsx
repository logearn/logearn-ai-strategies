import React, { useMemo, useRef, useState } from 'react';
import { Card, Space, Checkbox, Button, InputNumber, Alert, Typography, Tooltip, Popover, Select, Segmented, message } from 'antd';
import { SwapOutlined, PictureOutlined, DeleteOutlined, StarOutlined } from '@ant-design/icons';
import PlotlyChart from './PlotlyChart.jsx';
import { buildScatterFigure } from '../lib/scatterFigure.js';
import { isNumericLike } from '../lib/dataHelpers.js';
import { logearnUrl } from '../lib/utils.js';
import { getFieldDesc } from '../lib/dictionary.js';
import { getFeature } from '../lib/data.js';
import FieldNameWithDesc from './FieldNameWithDesc.jsx';

const OPTIONS = [
  { key: 'logX', label: '对数 X', tip: 'X 轴取对数，适合重尾字段' },
  { key: 'logY', label: '对数 Y', tip: 'Y 轴取对数' },
  { key: 'clipOutliers', label: '剔除离群点', tip: '按 IQR(Tukey k=1.5) 收紧坐标轴，离群点不显示、也不参与 r/p/趋势线的计算' },
  { key: 'showConfBand', label: '趋势线置信区间', tip: '在趋势线周围显示 95% 置信区间' },
  { key: 'showBinned', label: '分档统计', tip: '按 X 字段分档，展示每档 Y 的均值±标准差' },
  { key: 'showMarginal', label: '边际分布', tip: '左侧显示 Y 的分布直方图' },
  { key: 'showVLine', label: '分割竖线', tip: '在 X 轴指定数值处画参考线' },
];
const DEFAULTS = { logX: false, logY: false, clipOutliers: false, showConfBand: true,
  showBinned: false, showMarginal: true, showVLine: false, vLineValue: 2 };

export default function ScatterCard({ rows, xField, yField, colorField, light, onRemove, onAddToCampLibrary,
  campGroups = [], campActiveGroup, onCampActiveGroupChange, highlightCAs }) {
  // 每张图各自独立的设置。旧版存在模块级 Map 里，加一个开关要同步改 6 处，漏一处就是静默失效。
  const [settings, setSettings] = useState(DEFAULTS);
  const [swapped, setSwapped] = useState(false);
  const [lightExport, setLightExport] = useState(false);
  const plotRef = useRef(null);
  const set = (k, v) => setSettings(s => ({ ...s, [k]: v }));
  const [xf, yf] = swapped ? [yField, xField] : [xField, yField];

  const numericColor = useMemo(
    () => (colorField ? isNumericLike(rows, colorField) : false), [rows, colorField]);

  const fig = useMemo(
    () => buildScatterFigure({ rows, xField: xf, yField: yf, colorField, numericColor, settings, light, highlightCAs }),
    [rows, xf, yf, colorField, numericColor, settings, light, highlightCAs]);

  // 收藏为候选打分因子：捕获的固定是 xField 这个 prop（真正被探索的字段），不是 xf——
  // "交换 X/Y" 只换显示，swapped 时 xf 会变成 yField（也就是 returnMax 本身）；
  // returnMax 是结果，不是因子，永远不该被当成候选打分因子收藏。打开时用当前数据在
  // xField 上的实际 min~max 预填区间，省得从头输入——用户看图眼熟哪一段"像是好的"，再手动收紧。
  // campRangeMode 三选一：区间(双边)/只设下限(≥，没有上限)/只设上限(≤，没有下限)——很多信号
  // 天然是单边的（比如"买入次数越多越好，没有上限"），逼着填一个假上限只会让条件比实际想要的更严格。
  const [campOpen, setCampOpen] = useState(false);
  const [campSide, setCampSide] = useState('hero');
  const [campRangeMode, setCampRangeMode] = useState('range');
  const [campLo, setCampLo] = useState(null);
  const [campHi, setCampHi] = useState(null);
  const openCampCapture = () => {
    const vals = rows.map(r => Number(getFeature(r, xField))).filter(Number.isFinite);
    if (vals.length) {
      setCampLo(Number(Math.min(...vals).toFixed(4)));
      setCampHi(Number(Math.max(...vals).toFixed(4)));
    }
    setCampRangeMode('range');
    setCampOpen(true);
  };
  const confirmCampCapture = () => {
    const lo = campRangeMode === 'lte' ? null : campLo;
    const hi = campRangeMode === 'gte' ? null : campHi;
    if (campRangeMode === 'range' && (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi)) {
      message.warning('区间不对，下限要小于上限');
      return;
    }
    if (campRangeMode === 'gte' && !Number.isFinite(lo)) { message.warning('下限没填对'); return; }
    if (campRangeMode === 'lte' && !Number.isFinite(hi)) { message.warning('上限没填对'); return; }
    onAddToCampLibrary?.({ field: xField, camp: campSide, lo, hi, group: campActiveGroup });
    message.success(`已收藏「${xField}」到阵营库${campActiveGroup ? `「${campActiveGroup}」组` : ''}（${campSide === 'evil' ? '邪恶' : '勇者'}阵营）`);
    setCampOpen(false);
  };

  return (
    <Card size="small" title={<Space size={6}>
      <FieldNameWithDesc field={xf} />
      <span style={{ opacity: .45 }}>vs</span>
      <FieldNameWithDesc field={yf} />
      <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{fig.stats.statsText}</Typography.Text></Space>}
      extra={<Space>
        <Button size="small" icon={<SwapOutlined />} onClick={() => setSwapped(s => !s)}>交换 X/Y</Button>
        <Button size="small" icon={<PictureOutlined />}
          onClick={() => plotRef.current?.exportPng(`${xf}_vs_${yf}`, lightExport)}>导出 PNG</Button>
        <Checkbox checked={lightExport} onChange={e => setLightExport(e.target.checked)}>
          <span style={{ fontSize: 12 }} title="深色图贴到白底文档会不协调；勾选后临时用浅色背景导出，不影响页面上的图">浅色导出</span>
        </Checkbox>
        {onAddToCampLibrary && (
          <Popover trigger="click" open={campOpen} onOpenChange={o => { if (!o) setCampOpen(false); }}
            title={`收藏「${xField}」为候选打分因子`}
            content={
              <Space direction="vertical" size={8} style={{ width: 280 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  区间默认填的是当前数据的实际 min~max，看图眼熟哪一段"像是好的"再手动收紧。
                  很多信号天然是单边的（比如"越大越好，没有上限"），选"只设下限/上限"就不用凑一个假边界。
                </Typography.Text>
                <Space>
                  <span style={{ fontSize: 12 }}>阵营</span>
                  <Select size="small" style={{ width: 110 }} value={campSide} onChange={setCampSide}
                    options={[{ value: 'hero', label: '🛡 勇者(加分)' }, { value: 'evil', label: '☠ 邪恶(扣分)' }]} />
                </Space>
                {onCampActiveGroupChange && (
                  <Space>
                    <span style={{ fontSize: 12 }}>归入分组</span>
                    <Select size="small" style={{ width: 160 }} value={campActiveGroup} onChange={onCampActiveGroupChange}
                      placeholder="选择分组"
                      title="收藏进阵营库的哪个分组——在「阵营库」tab 可新建/改名分组"
                      options={campGroups.map(g => ({ value: g, label: g }))} />
                  </Space>
                )}
                <Segmented size="small" block value={campRangeMode} onChange={setCampRangeMode}
                  options={[
                    { label: '区间', value: 'range' },
                    { label: '只设下限(≥)', value: 'gte' },
                    { label: '只设上限(≤)', value: 'lte' },
                  ]} />
                <Space>
                  <span style={{ fontSize: 12 }}>
                    {campRangeMode === 'gte' ? '下限' : campRangeMode === 'lte' ? '上限' : '区间'}
                  </span>
                  {campRangeMode !== 'lte' && (
                    <InputNumber size="small" value={campLo} onChange={setCampLo} style={{ width: 100 }} placeholder="下限" />
                  )}
                  {campRangeMode === 'range' && <span>~</span>}
                  {campRangeMode !== 'gte' && (
                    <InputNumber size="small" value={campHi} onChange={setCampHi} style={{ width: 100 }} placeholder="上限" />
                  )}
                </Space>
                <Button size="small" type="primary" block onClick={confirmCampCapture}>加入阵营库</Button>
              </Space>
            }>
            <Button size="small" icon={<StarOutlined />} onClick={openCampCapture}>收藏为打分因子</Button>
          </Popover>
        )}
        {onRemove && <Button size="small" danger icon={<DeleteOutlined />} onClick={onRemove} />}
      </Space>}>
      <Space wrap style={{ marginBottom: 8 }}>
        {OPTIONS.map(o => (
          <Checkbox key={o.key} checked={!!settings[o.key]} onChange={e => set(o.key, e.target.checked)}>
            <span title={o.tip} style={{ fontSize: 12 }}>{o.label}</span>
          </Checkbox>
        ))}
        {settings.showVLine && (
          <InputNumber size="small" value={settings.vLineValue} onChange={v => set('vLineValue', v ?? 0)} style={{ width: 90 }} />
        )}
      </Space>
      <PlotlyChart ref={plotRef} traces={fig.traces} layout={fig.layout}
        onPointClick={ca => { const u = logearnUrl(ca); if (u) window.open(u, '_blank', 'noopener'); }} />
      {fig.notices.map((t, i) => <Alert key={i} type="info" showIcon style={{ marginTop: 8 }} message={t} />)}
    </Card>
  );
}
