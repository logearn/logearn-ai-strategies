import React from 'react';
import { Card, Button, Typography, Input } from 'antd';

// 从现有策略代码导入因子池：不用从零扫描/勾选，直接把「策略」页那份代码里已经在打分的字段
// 搬进来，权重/阵营原样保留，再用因子表修正或过滤它们。纯展示组件——具体解析/导入
// 逻辑（importFromStrategy）留在 FactorLab 里，因为它要读 rows 并直接写 factors/selectedHero
// 等好几个跟扫描流程强绑定的 state，抽到这里反而要来回传一堆东西，得不偿失。
export default function ImportStrategyCard({ strategySrc, setStrategySrc, onImport }) {
  return (
    <Card id="fl-import" size="small" title="从现有策略导入因子池（可选）"
      extra={<Button type="primary" onClick={onImport}>导入为可编辑因子池</Button>}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        粘贴当前实盘策略代码（跟「策略」页共用同一份，那边粘过这里也有），导入后会把里面所有
        "满分/危险区 ... 权重 w" 格式的打分因子原样搬进下面的因子权重表——权重、阵营（勇者/邪恶）
        按代码里的真实值保留，不会被自动配权覆盖。核心区 [lo1,hi1] 能还原，硬界 lo0/hi0 因为代码里
        没有编码进 checks 文案，暂时按矩形（区间命中）近似，进表后可手工把过渡带拉开。
        导入之后就能在因子表里<b>直接编辑</b>某个字段的边界/权重（修正），或<b>删除</b>某个字段（过滤）；
        也可以马上重新扫描一遍，用「计算候选边际ρ贡献（held-out）」找这份策略目前漏掉、该补进去的字段。
      </Typography.Paragraph>
      <Input.TextArea rows={4} value={strategySrc} onChange={e => setStrategySrc(e.target.value)}
        placeholder="粘贴现有策略代码（如 强势盘策略/code-score.js 的函数体）" style={{ fontFamily: 'monospace', fontSize: 12 }} />
    </Card>
  );
}
