import React, { useEffect, useState } from 'react';
import { Modal, Alert, Typography, Table, Checkbox } from 'antd';

// 调权建议"试算"弹窗：把改动前后的顶层指标并排列出来——命中率、命中/未命中中位数、
// score-收益 r(log)、单调性ρ。绿色=这次调整让它变好，红色=变差，灰色=基本没动。
// 关键判断口径：这几个指标全是"越大越好"（命中率高、命中中位数高、r(log) 越正说明分数越能
// 排序收益、单调性越接近 1 越说明分越高越容易赢），所以 after>before 一律算改善。
// 用户可以据此决定到底确认应用还是取消——这就是"删了到底提升没有"的答案，也是删除是否
// 合理的验证：删完指标不降反升（或持平）才是合理的删除。
export default function WeightSuggestionPreview({ preview, onCancel, onConfirm }) {
  // 样本外闸门没过时，允许勾"仍要强制应用"覆盖——闸门是默认拦，但不剥夺你硬要落地的权利。
  // 每次换一次试算（preview 变化）都要重置这个勾，不能把上一次的强制状态带过来。
  const [forceApply, setForceApply] = useState(false);
  useEffect(() => { setForceApply(false); }, [preview]);
  if (!preview) return null;
  const { title, before, after, oos, removedLines, adjustedCount } = preview;
  const err = (before && !before.ok) ? before.error : (after && !after.ok ? after.error : null);
  const fmtPct = v => (v == null ? '-' : (v * 100).toFixed(1) + '%');
  const fmtX = v => (v == null ? '-' : v.toFixed(2) + 'x');
  const fmtR = v => (v == null ? '-' : v.toFixed(3));
  // 判定北极星默认口径＝score↔倍率的强单调性（spearman ρ），跟散点图底下那个 ρ 同口径：高倍集中高分、
  // 低倍落低分，越强越好（筛垃圾类策略的北极星走分层台阶例外，此弹窗仍按默认 ρ 口径展示试算对比）。
  // 高倍率命中率（>2x/>5x/>10x）是"高倍有没有真的落到高分侧"的体现，共同判据。
  // 通过率中性不上色；r(log) 佐证。
  const hasRemoves = removedLines.length > 0;
  const fmtRho = v => (v == null ? '-' : v.toFixed(3));
  // 样本外闸门：测试段 ρ 前→后。可算（测试段够大、两头 ρ 都非空）时才纳入判定。
  const oosOk = oos && !oos.tooSmall && oos.before?.ok && oos.after?.ok
    && oos.before.spearmanRho != null && oos.after.spearmanRho != null;
  const dOosRho = oosOk ? oos.after.spearmanRho - oos.before.spearmanRho : null;
  const OOS_EPS = 1e-4;
  const oosWorse = oosOk && dOosRho < -OOS_EPS;   // 样本外明确变差 → 闸门拦下
  const metricRows = [
    { key: 'spearmanRho', label: '单调性 spearman ρ（分数↔倍率·核心）', b: before?.spearmanRho, a: after?.spearmanRho, fmt: fmtRho, strong: true },
    ...(oosOk ? [{ key: 'oosRho', label: `样本外·测试段单调性 ρ（落地闸门，n=${oos.n}）`, b: oos.before.spearmanRho, a: oos.after.spearmanRho, fmt: fmtRho, strong: true }] : []),
    { key: 'decileRho', label: '十分位单调性 ρ', b: before?.decileRho, a: after?.decileRho, fmt: fmtRho },
    { key: 'hit2', label: '通过组 >2x 命中率', b: before?.hit2, a: after?.hit2, fmt: fmtPct },
    { key: 'hit5', label: '通过组 >5x 命中率', b: before?.hit5, a: after?.hit5, fmt: fmtPct },
    { key: 'hit10', label: '通过组 >10x 命中率', b: before?.hit10, a: after?.hit10, fmt: fmtPct },
    { key: 'hitMedian', label: '通过组中位数', b: before?.hitMedian, a: after?.hitMedian, fmt: fmtX },
    { key: 'passRate', label: '通过率（触发占比·中性）', b: before?.passRate, a: after?.passRate, fmt: fmtPct, neutral: true },
    { key: 'rLog', label: 'score-收益 r(log)·佐证', b: before?.rLog, a: after?.rLog, fmt: fmtR, faint: true },
  ];
  const color = (row) => {
    if (row.neutral) return 'var(--muted, #8e8e93)';
    const { b, a, lowerBetter } = row;
    if (b == null || a == null) return 'inherit';
    const d = a - b;
    if (Math.abs(d) < 1e-9) return 'var(--muted, #8e8e93)';
    const good = lowerBetter ? d < 0 : d > 0;
    return good ? '#30d158' : '#ff453a';
  };
  const arrow = (b, a) => {
    if (b == null || a == null || Math.abs(a - b) < 1e-9) return '';
    return a > b ? ' ↑' : ' ↓';
  };
  // 结论主看单调性 spearman ρ 有没有变强（高倍更集中到高分）；高倍率命中率（>2x）作为共同判据一起看。
  // 原则：验证不了"更单调"就别改——尤其是删除，没让 ρ 变强就建议留着。ρ 算不出（样本<5/打分池空）
  // 时退回只看 >2x 高倍率命中率。
  const netHint = (() => {
    if (err || !before?.ok || !after?.ok) return null;
    const EPS = 1e-4; // ρ 的有效变化门槛，避免把 0.0001 的浮动也算成"变强/变弱"
    const dRho = (before.spearmanRho != null && after.spearmanRho != null)
      ? after.spearmanRho - before.spearmanRho : null;
    const d2 = (after.hit2 ?? 0) - (before.hit2 ?? 0);
    if (dRho != null) {
      if (dRho > EPS && d2 >= -1e-9) return { type: 'success', text: `单调性变强了（ρ ${before.spearmanRho.toFixed(3)}→${after.spearmanRho.toFixed(3)}，高倍更集中到高分），高倍率命中率没变差——方向对，可以应用。` };
      if (dRho > EPS) return { type: 'warning', text: `单调性变强了（ρ↑）但通过组高倍率有降——逐项看清楚再决定，拿不准就留着。` };
      if (dRho < -EPS) return { type: 'error', text: hasRemoves
        ? `单调性反而变弱了（ρ ${before.spearmanRho.toFixed(3)}→${after.spearmanRho.toFixed(3)}）——删了让图更不单调，按"验证不了更单调就留着"的原则，建议保留（取消）。`
        : `单调性反而变弱了（ρ ${before.spearmanRho.toFixed(3)}→${after.spearmanRho.toFixed(3)}）——这次调权把图搞得更不单调，建议取消。` };
      // ρ 基本没动
      return { type: hasRemoves ? 'warning' : 'info', text: hasRemoves
        ? '删掉这些因子对单调性（分数↔倍率）没有任何影响——既然验证不出删了更单调，按原则建议留着（取消）。'
        : '单调性没变化——调权影响很小，应用与否都行。' };
    }
    // ρ 算不出（样本太少/打分池空），退回看 >2x 高倍率命中率
    if (d2 > 1e-9) return { type: 'success', text: '样本不够算单调性 ρ，退回看高倍率命中率：>2x 提升了，可以应用。' };
    if (d2 < -1e-9) return { type: 'error', text: '样本不够算单调性 ρ，退回看高倍率命中率：>2x 变差了，建议取消。' };
    return { type: hasRemoves ? 'warning' : 'info', text: '样本不够算单调性 ρ，且高倍率命中率也没变——按原则建议留着（取消）。' };
  })();
  const gated = oosWorse && !forceApply;   // 样本外没过且没勾强制 → 禁用确认
  return (
    <Modal open width={680} onCancel={onCancel} onOk={onConfirm}
      okText="确认应用" cancelText="取消" title={title || '试算调权建议'}
      okButtonProps={{ disabled: !!err || gated }}>
      {err
        ? <Alert type="error" showIcon message="试算失败" description={`改完的代码编译不过：${err}`} />
        : (
        <>
          <Typography.Paragraph style={{ fontSize: 13, marginBottom: 8 }}>
            将 <b>调整 {adjustedCount}</b> 个因子权重、<b>删除 {removedLines.length}</b> 个因子
            {removedLines.length > 0 && <span style={{ color: 'var(--muted,#8e8e93)' }}>（{removedLines.map(r => r.name).join('、')}）</span>}。
            核心目标是让 <b>分数↔倍率更单调</b>（高倍集中高分、低倍落低分）——主看第一行 spearman ρ 有没有变强，
            确认更单调（或至少不变弱）再应用；删掉的因子之后可以在"已删因子"里加回来。
          </Typography.Paragraph>
          <Table size="small" pagination={false} rowKey="key" dataSource={metricRows}
            columns={[
              { title: '指标', dataIndex: 'label', width: 240,
                render: (v, r) => <span style={{ opacity: (r.faint || r.neutral) ? .6 : 1, fontWeight: r.strong ? 700 : 400 }}>{v}</span> },
              { title: '当前', width: 100, align: 'right', render: (_, r) => r.fmt(r.b) },
              { title: '应用后', width: 120, align: 'right',
                render: (_, r) => <b style={{ color: color(r) }}>{r.fmt(r.a)}{arrow(r.b, r.a)}</b> },
            ]} />
          {netHint && <Alert style={{ marginTop: 12 }} type={netHint.type} showIcon message={netHint.text} />}
          {oosWorse && (
            <Alert style={{ marginTop: 8 }} type="error" showIcon
              message={`样本外落地闸门没通过：测试段 ρ ${oos.before.spearmanRho.toFixed(3)} → ${oos.after.spearmanRho.toFixed(3)}（变差）`}
              description={
                <>
                  <div style={{ fontSize: 12 }}>全量看着变好、但在没参与调参的测试段上单调性反而变差——大概率是过拟合到了训练段的噪声，默认不让落地。</div>
                  <Checkbox style={{ marginTop: 6 }} checked={forceApply} onChange={e => setForceApply(e.target.checked)}>
                    我知道样本外没过，仍要强制应用
                  </Checkbox>
                </>
              } />
          )}
          {oos && oos.tooSmall && (
            <Alert style={{ marginTop: 8 }} type="warning" showIcon
              message={`样本外验证不了：按时间切分后测试段只有 ${oos.n} 条（<30），ρ 不可信，这次不做样本外拦截`} />
          )}
          {oosOk && !oosWorse && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#30d158' }}>
              ✓ 样本外闸门通过：测试段 ρ {oos.before.spearmanRho.toFixed(3)} → {oos.after.spearmanRho.toFixed(3)}（没变差）
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
