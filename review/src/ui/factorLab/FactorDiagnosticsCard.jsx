// 因子体检卡片：把 readme 42/43 两轮【手算】出来的三件事变成常驻输出。
//   ① 权重 ↔ 证据 是否对齐（摆幅最大的因子证据最弱 = 诊断清单第 2 条）
//   ② 缺失样本的影响【按阵营】——邪恶缺失是奖励不是惩罚，42.2 那次顶档塌陷的根因
//   ③ 留一法：逐个删因子看 ρ / lift@cutoff / 顶档 lift 三个口径各自怎么变
// 都不是新算法，是把"每轮收尾时人拿五份报告交叉比对"的固定套路固化下来。
import React, { useState, useMemo } from 'react';
import { Card, Table, Alert, Button, Tooltip, Tag, Space, Typography } from 'antd';
import { weightEvidenceAlignment, missingImpact, leaveOneOutFactors } from '../../lib/factorDiagnostics.js';

const { Text } = Typography;
const num = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const pct = v => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-');
const code = s => <code style={{ fontSize: 11 }}>{s}</code>;
const campTag = c => (c === 'evil' ? <Tag color="error">☠</Tag> : <Tag color="success">🛡</Tag>);

export default function FactorDiagnosticsCard({
  rows, factors, influences, threshold, recommendPath, onRemoveFactor,
}) {
  const [loo, setLoo] = useState(null);
  const [looBusy, setLooBusy] = useState(false);

  // 权重↔证据：只有拿到过推荐路径（里面才有 held-out Δρ）时才能判。没有路径就不显示——
  // 拿 AUC 冒充"证据"是错的（36.4 第 4 条：79 个候选的 AUC 置信区间几乎全跨 0.5）。
  const align = useMemo(
    () => (recommendPath?.length ? weightEvidenceAlignment(influences, recommendPath) : null),
    [influences, recommendPath]);

  const missing = useMemo(
    () => missingImpact(rows, factors, threshold), [rows, factors, threshold]);
  // 只有邪恶阵营的缺失才是"白得分"这种反直觉的方向，单独拎出来告警
  const missingBonus = missing.filter(m => m.direction === 'bonus');

  const runLoo = () => {
    setLooBusy(true);
    // 留一法要把整个池子重算 k+1 遍，样本多时会卡一下主线程；先让按钮进 loading 再算
    setTimeout(() => {
      try { setLoo(leaveOneOutFactors(rows, factors, threshold)); }
      finally { setLooBusy(false); }
    }, 0);
  };

  if (!factors?.length) return null;

  return (
    <Card id="fl-diagnostics" size="small" style={{ marginTop: 12 }}
      title={<span>因子体检 <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
        —— 权重是不是配在有证据的因子上 · 缺失样本被打到了哪一档 · 每个因子删掉会怎样
      </Text></span>}>

      {/* ① 权重 ↔ 证据对齐 */}
      {align && align.rows.length >= 2 && (
        align.inversions > 0 ? (
          <Alert style={{ marginBottom: 12 }} type="warning" showIcon
            message={<span style={{ fontSize: 12 }}>
              ⚖️ 权重跟证据<b>没对齐</b>：{align.inversions} 处倒挂（摆幅更大的因子，held-out Δρ 反而更小）
            </span>}
            description={<div style={{ fontSize: 12 }}>
              {align.worst && <div style={{ marginBottom: 6 }}>
                最刺眼的一对：{campTag(align.worst.heavy.camp)}{code(align.worst.heavy.field)}
                <b style={{ color: '#fa8c16' }}> 摆幅 {num(align.worst.heavy.swingAbs, 1)}</b>
                / Δρ 仅 {num(align.worst.heavy.deltaTest)}
                <span style={{ margin: '0 6px' }}>vs</span>
                {campTag(align.worst.strong.camp)}{code(align.worst.strong.field)}
                <b> 摆幅 {num(align.worst.strong.swingAbs, 1)}</b>
                / Δρ <b style={{ color: '#52c41a' }}>{num(align.worst.strong.deltaTest)}</b>
              </div>}
              <div style={{ color: 'var(--text-muted)' }}>
                摆幅与证据的秩相关 ρ={num(align.rankRho, 2)}（越接近 −1 越是完全反着来）。
                成因是 <code style={{ fontSize: 11 }}>autoWeights ∝ interval.score = (wilsonLo/base)×√coverage</code> ——
                正类少时它<b>系统性偏好"几乎不筛"的宽窗</b>，于是覆盖面最广、区分力最弱的因子拿到最高权重。
                <br />⚠️ 别用「按 ρ 最优配权」去修它（原字段轮实测 held-out 0.202→0.193、0.346→0.288，反而更差）；
                先用下面的留一法确认那个重因子到底有没有用，再决定手动降权还是直接删。
              </div>
            </div>} />
        ) : (
          <Alert style={{ marginBottom: 12 }} type="success" showIcon
            message={<span style={{ fontSize: 12 }}>
              ✓ 权重与证据对齐：摆幅排序跟 held-out Δρ 排序一致（0 处倒挂，秩相关 ρ={num(align.rankRho, 2)}）
            </span>} />
        ))}

      {/* ② 缺失按阵营 —— 42.2 那次事故 */}
      {missingBonus.length > 0 && (
        <Alert style={{ marginBottom: 12 }} type="error" showIcon
          message={<span style={{ fontSize: 12 }}>
            🕳️ 有 {missingBonus.length} 个<b>邪恶</b>因子存在缺失样本 —— 缺失记 0 分在邪恶阵营下是<b>奖励</b>，不是惩罚
          </span>}
          description={<div style={{ fontSize: 12 }}>
            {missingBonus.map(m => (
              <div key={m.camp + ':' + m.field} style={{ paddingLeft: 8, marginBottom: 2 }}>
                · {code(m.field)}
                <span style={{ color: 'var(--text-muted)' }}>
                  　{m.missingN} 个缺失样本（{pct(m.missingRate)}）躲掉扣分、<b style={{ color: '#ff4d4f' }}>白得 {num(m.points, 1)} 分</b>
                  　它们的分数中位排在全样本 <b>{pct(m.medScorePct)}</b> 分位
                  　这批样本自己的高倍率 {pct(m.hiRate)}（lift {num(m.lift, 2)}）
                </span>
              </div>
            ))}
            <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>
              分位越高 + lift 越接近 1，问题越严重：<b>顶档被"我们对它一无所知"的样本占据，等于不筛</b>。
              42 轮的真实事故就是这个形状（40 个缺失样本白得 22.5 分，把顶档高倍率压到基准以下）。
              缺失口径必须跟上线代码一致（不能只在这里改），所以处理方式是<b>删掉这个邪恶因子</b>
              或换一个缺失率更低的同维度字段，不是改口径。
            </div>
          </div>} />
      )}
      {missing.length > 0 && missingBonus.length === 0 && (
        <Alert style={{ marginBottom: 12 }} type="info" showIcon
          message={<span style={{ fontSize: 12 }}>
            ℹ️ 池里有缺失的都是勇者因子（缺失 = 拿不到加分 = 惩罚，方向保守）：
            {missing.map(m => <span key={m.field} style={{ marginLeft: 6 }}>
              {code(m.field)} {m.missingN} 个 / 分位 {pct(m.medScorePct)}</span>)}
          </span>} />
      )}

      {/* ③ 留一法 */}
      <Space style={{ marginBottom: 8 }} wrap>
        <Tooltip title="逐个删掉因子重算：ρ / lift@cutoff / 顶档 lift。不重新配权（否则会把「删因子」和「权重变了」混成一个变量），cutoff 每次重新推荐（删邪恶因子等于给所有分数加常数，沿用旧 cutoff 测的是阈值漂移不是因子有没有用）。">
          <Button size="small" type="primary" ghost loading={looBusy}
            disabled={factors.length < 2} onClick={runLoo}>
            🔬 留一法：逐个删因子看会怎样
          </Button>
        </Tooltip>
        {factors.length < 2 && <Text type="secondary" style={{ fontSize: 12 }}>需要至少 2 个因子</Text>}
        {loo && <Text type="secondary" style={{ fontSize: 12 }}>
          完整池：ρ={num(loo.full.rho)}　cutoff={num(loo.full.cut, 0)} 时 lift={num(loo.full.lift, 2)}
          （触发 {loo.full.triggered}）　顶档 lift={num(loo.full.topLift, 2)}
        </Text>}
      </Space>

      {loo && (
        <>
          <Table size="small" rowKey={r => r.removed.camp + ':' + r.removed.field}
            pagination={false} scroll={{ x: 860 }} dataSource={loo.items}
            columns={[
              { title: '删掉这个因子', width: 240, render: (_, r) => (
                <span>{campTag(r.removed.camp)}{code(r.removed.field)}
                  <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>w={num(r.removed.weight, 1)}</Text>
                </span>) },
              { title: <Tooltip title="删掉之后北极星 ρ 的变化。≈0 = 这个因子对排序没贡献（准常数因子的典型特征）；明显为负 = 它在干活。">Δρ</Tooltip>,
                width: 100, align: 'right', render: (_, r) => {
                  if (r.pureEvil) return <Tag color="error">纯邪恶池</Tag>;
                  if (r.degenerate) return <Tooltip title="删剩下的池子人人同分，ρ 测不出来（不是「没变化」）"><Tag>无法测</Tag></Tooltip>;
                  if (!Number.isFinite(r.dRho)) return '-';
                  const flat = Math.abs(r.dRho) < 0.005;
                  return <b style={{ color: flat ? '#fa8c16' : (r.dRho < 0 ? '#52c41a' : '#ff4d4f') }}>
                    {r.dRho > 0 ? '+' : ''}{num(r.dRho)}</b>;
                } },
              { title: 'ρ（删后）', width: 92, align: 'right', render: (_, r) => num(r.rho) },
              { title: <Tooltip title="删掉之后、在【重新推荐的】cutoff 上的 lift 变化。ρ 和 lift 会打架（43 轮 ρ 掉 0.024 但 lift 反而涨），两个都要看。">Δlift</Tooltip>,
                width: 96, align: 'right', render: (_, r) => Number.isFinite(r.dLift)
                  ? <span style={{ color: r.dLift > 0.01 ? '#52c41a' : (r.dLift < -0.01 ? '#ff4d4f' : 'inherit') }}>
                      {r.dLift > 0 ? '+' : ''}{num(r.dLift, 2)}</span> : '-' },
              { title: 'cutoff / 触发 / lift', width: 170, align: 'right', render: (_, r) =>
                  Number.isFinite(r.cut) ? `${num(r.cut, 0)} / ${r.triggered} / ${num(r.lift, 2)}` : '-' },
              { title: <Tooltip title="删掉之后顶档（最高分那一档）的 lift。<1 = 分数最高的那批样本表现低于不筛，顶部反转。">Δ顶档</Tooltip>,
                width: 96, align: 'right', render: (_, r) => Number.isFinite(r.dTopLift)
                  ? <span style={{ color: r.dTopLift > 0.02 ? '#52c41a' : (r.dTopLift < -0.02 ? '#ff4d4f' : 'inherit') }}>
                      {r.dTopLift > 0 ? '+' : ''}{num(r.dTopLift, 2)}</span> : '-' },
              { title: '', width: 60, render: (_, r) => {
                  const f = factors.find(x => x.field === r.removed.field && x.camp === r.removed.camp);
                  return f ? <Button size="small" type="text" danger onClick={() => onRemoveFactor?.(f)}>删除</Button> : null;
                } },
            ]} />
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
            按 Δρ 从大到小排（<b>排最前的最没用</b>：删掉它 ρ 反而涨或不动）。
            <b>Δρ ≈ 0 标黄</b>：说明这个因子对排序零贡献 —— 邪恶阵营下这尤其常见，
            因为邪恶因子不进归一分母，一个准常数的邪恶因子删掉就等于给所有样本<b>加同一个常数</b>，
            ρ / 十分位 / lift 逐位不变、<b>只有 cutoff 平移</b>（readme 41.3）。
            <br />三列会打架时以你的用途为准：<b>北极星看 Δρ，实盘看 Δlift 和 Δ顶档</b> ——
            43 轮就是 ρ 掉 0.024 而 lift@cutoff、基线库四天、顶档全面变好，最后采用了后者。
            <br />⚠️ 删完之后<b>分数尺度会变，旧 cutoff 不能沿用</b>，重新点「推荐阈值」。
          </div>
        </>
      )}
    </Card>
  );
}
