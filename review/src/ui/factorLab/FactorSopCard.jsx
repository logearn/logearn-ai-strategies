import React from 'react';
import { Collapse, Typography, Tag, Space } from 'antd';

// 找因子操作指引（SOP）：纯静态说明，默认折叠。把"扫→算边际分层秩相关→按边际分层秩相关挑→去冗余→
// 按分层秩相关配权→看test是否也涨→残差补漏→生成上线"这套流程固化在页面里，用户不用记，对着点即可。
// 2026-07-28：北极星统一为分层秩相关（不再区分策略用途、不再有ρ最优/分层增益这些可选口径）——
// 核心纪律：候选粗筛/初始权重走【区间打分】（区间感知，不假设方向单调，AUC只是给人看的诊断参考）、
// 挑因子看【边际分层秩相关】、配权固定按【分层秩相关】、信不信看【held-out test】。
const step = (n, title, body) => (
  <div style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'baseline' }}>
    <Tag color="blue" style={{ margin: 0, minWidth: 22, textAlign: 'center' }}>{n}</Tag>
    <div style={{ fontSize: 12 }}><b>{title}</b>　<span style={{ opacity: .8 }}>{body}</span></div>
  </div>
);

export default function FactorSopCard() {
  const items = [{
    key: 'sop',
    label: <span style={{ fontSize: 13 }}>📖 找因子操作指引 —— 一切以北极星为准（统一口径：分层秩相关，不吃 cutoff，不再区分策略用途）</span>,
    children: (
      <div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          顺序记这一句：<b>扫 → 算边际分层秩相关 → 按边际分层秩相关挑（不是AUC）→ 去冗余 → 按分层秩相关配权 → 看 test 是否也涨 → 残差补漏 → 生成上线</b>。
          候选粗筛和初始权重走区间打分（不假设方向单调），AUC/显著性只是给人看的诊断参考，不进决策。
        </Typography.Paragraph>

        {step('1', '定阈值 + 看样本', '上方选高倍阈值；若提示"高倍盘只有 XX 个"，说明样本太少，先调低阈值或多攒数据，否则全是噪声。字段范围先用「原字段」。')}
        {step('2', '扫描', '点「扫描…两阵营」出勇者/邪恶候选表。此刻先别按 AUC 挑 —— AUC 假设方向单调，"驼峰型"字段（中段区间最强、两头都弱）在AUC上会显得没区分度，实际区间打分可能很强，只是"可能有用"的参考。')}
        {step('3', '算边际分层秩相关', '点「计算候选分层秩相关贡献」。这一列 = 把该字段并进池子后分层秩相关（自适应粗粒度分档、档内看倍数中位数、不吃cutoff）的增量，是唯一该看的挑选标准。')}
        {step('4', '按边际分层秩相关挑', '候选表默认已叠两道粗筛：「边际分层秩相关贡献 ≥ 0.005」只留正贡献（加进去能提升排序信息量的；负贡献绝对值再大也不要）+「lift ≥ 1.05」滤掉没区分度的。想更严把阈值拉到 0.01；想看全部把两者分别设 0 / 1。勾一个就重算一次 —— 池子变了别的候选贡献会变（AUC 看不见的冗余）。')}
        {step('5', '去冗余', '选够≥2个因子后，权重卡里会有一条去冗余状态：绿色「✓ 无冗余」=放心；橙色告警=列出 |ρ|≥0.7 的高相关对，二选一（留边际贡献更高的），别都留。没选够2个则不显示。')}
        {step('6', '按分层秩相关配权', '点「🎯 按分层秩相关配权」——不吃cutoff，只要求粗粒度分档递增，不追全程细粒度爬升。只认结果条里的 held-out test：train+test 都涨=采用；只 train 涨(橙告警)=过拟合别用，回第 5 步减因子。被压到 0 的因子直接删。配完权重后点「推荐阈值」单独定 cutoff，不要反过来先猜cutoff再配权。')}
        {step('7', '残差补漏（可选）', '池子稳定后切「残差模式」再扫，专挖当前池子没打对的子集（score<cutoff）里的漏网字段，同样按边际分层秩相关挑、按分层秩相关配权。')}
        {step('8', '发送到策略 + 上线', '点「时间外推验证」确认排序质量站得住 → 点「发送到策略」：整体替换策略里的打分段（硬否决段原样保留）、CUTOFF 同步，自动跳到「策略」tab。代码只在策略侧生成一处；上线再用「策略」tab 的「生成上线代码」——把 f(\'字段\') 翻译成纯 native ctx 代码（无 f、无垫片，直接字段内联取值、派生字段内联计算），并逐字段自检。找因子只找因子，不再自己生成代码。')}

        <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(255,159,10,.10)', borderRadius: 6 }}>
          <Typography.Text strong style={{ fontSize: 12 }}>⚠️ 三个别踩的坑</Typography.Text>
          <Space direction="vertical" size={2} style={{ marginTop: 6, fontSize: 12 }}>
            <span>· <b>别按 AUC/显著性挑因子</b>：显著≠有用（可能和已选完全冗余，边际贡献≈0）。挑因子只看边际分层秩相关。</span>
            <span>· <b>别只看 train 涨高兴</b>：没涨 held-out test 的提升都是假的。因子宁少勿滥。</span>
            <span>· <b>别堆相关因子</b>：三个同味道的字段一起塞，排序质量不会三倍好，只会过拟合。</span>
          </Space>
        </div>
      </div>
    ),
  }];
  return <Collapse size="small" items={items} style={{ background: 'transparent' }} />;
}
