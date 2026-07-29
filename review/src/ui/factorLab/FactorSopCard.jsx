import React from 'react';
import { Collapse, Typography, Tag, Space } from 'antd';

// 找因子操作指引（SOP）：纯静态说明，默认折叠。把"扫→算边际ρ→按边际ρ挑→去冗余→
// 按ρ最优配权→看test是否也涨→生成上线"这套流程固化在页面里，用户不用记，对着点即可。
// 2026-07-28 大回退：中途试过统一到分层秩相关（自适应粗粒度分档、命中率、饱和度/锯齿双重
// 惩罚），真实数据上配权效果不理想，换回全程 ρ（默认口径，score↔returnMax 点对点 spearman）。
// 核心纪律：候选粗筛/初始权重走【区间打分】（区间感知，不假设方向单调，AUC只是给人看的诊断参考）、
// 挑因子看【held-out 边际ρ(test)】、配权固定按【ρ最优】、信不信看【held-out test】。
// 2026-07-29：挑因子这一步以前用的是样本内边际ρ（无切分），噪声候选可以带虚高增量进池——
// 已统一成 computeHeldOutDeltaRho 一套口径，候选表主数字即 deltaTest。
const step = (n, title, body) => (
  <div style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'baseline' }}>
    <Tag color="blue" style={{ margin: 0, minWidth: 22, textAlign: 'center' }}>{n}</Tag>
    <div style={{ fontSize: 12 }}><b>{title}</b>　<span style={{ opacity: .8 }}>{body}</span></div>
  </div>
);

export default function FactorSopCard() {
  const items = [{
    key: 'sop',
    label: <span style={{ fontSize: 13 }}>📖 找因子操作指引 —— 一切以北极星为准（默认口径：全程 ρ，score↔returnMax 点对点 spearman）</span>,
    children: (
      <div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          顺序记这一句：<b>扫 → 算 held-out 边际ρ → 按边际ρ(test) 挑（不是AUC）→ 去冗余 → 按ρ最优配权 → 看 test 是否也涨 → 生成上线</b>。
          候选粗筛和初始权重走区间打分（不假设方向单调），AUC/显著性只是给人看的诊断参考，不进决策。
        </Typography.Paragraph>

        {step('1', '定阈值 + 看样本', '上方选高倍阈值；若提示"高倍盘只有 XX 个"，说明样本太少，先调低阈值或多攒数据，否则全是噪声。字段范围先用「原字段」。')}
        {step('2', '扫描', '点「扫描…两阵营」出勇者/邪恶候选表。此刻先别按 AUC 挑 —— AUC 假设方向单调，"驼峰型"字段（中段区间最强、两头都弱）在AUC上会显得没区分度，实际区间打分可能很强，只是"可能有用"的参考。')}
        {step('3', '算边际ρ（held-out）', '点「计算候选边际ρ贡献（held-out）」。主数字 = 把该字段并进池子后【验证段】spearman(score, returnMax) 的增量（按时间切 70/30，梯形边界只在训练段推），是唯一该看的挑选标准；下面小字的 train 只用来看背离——train 涨、test 不涨（带⚠）= 这份贡献只存在于推边界的那批样本里，不要。想知道"多大的增量才算超出噪声"，再点「跑置换零分布」——打乱 returnMax 重跑同一条流水线，给出纯噪声能凑到的 q95，一键回填成下面那条阈值，比拍脑袋的 0.005 靠谱。')}
        {step('3.5', '看字段是不是市值的影子', '挑之前扫一眼「与市值ρ」列：|ρ| 大 = 这字段只是进场市值的另一种写法（returnMax 的分母就是进场市值），效果来自"买小盘"不是新规律。名字带 mcap/fdv 的一眼能认，这列真正的价值是抓住名字上看不出来的——总供应量、流动性、持有人数这类跟盘子大小同涨同落的字段。')}
        {step('4', '按边际ρ挑', '候选表默认已叠两道粗筛：「边际ρ(test) ≥ 0.005」只留验证段正贡献（加进去能提升排序信息量的；负贡献绝对值再大也不要）+「lift ≥ 1.05」滤掉没区分度的。跑过置换零分布就改用它给的 q95。想看全部把两者分别设 0 / 1。勾一个就重算一次 —— 池子变了别的候选贡献会变（AUC 看不见的冗余）。注：过滤里只有「缺失率≤」会真正限制「因子推荐」能选到的候选，其余只影响这张表的展示。')}
        {step('5', '去冗余', '选够≥2个因子后，权重卡里会有一条去冗余状态：绿色「✓ 无冗余」=放心；橙色告警=列出 |ρ|≥0.7 的高相关对，二选一（留边际贡献更高的），别都留。没选够2个则不显示。')}
        {step('6', '按ρ最优配权', '点「🎯 按 ρ 最优配权」——全程点对点 spearman，不分档、不绑 cutoff。只认结果条里的 held-out test：train+test 都涨=采用；只 train 涨(橙告警)=过拟合别用，回第 5 步减因子。被压到 0 的因子直接删。配完权重后点「推荐阈值」单独定 cutoff，不要反过来先猜cutoff再配权。')}
        {/* 原第 7 步「残差补漏」随残差模式一起删除（2026-07-29）：它想挖的"当前池子没打对的子集里
            还差什么"，正是第 3 步 held-out 边际ρ 的定义——每个候选算的就是"并进现有池子后还能再涨多少"。
            想看具体是哪些盘漏了，用回测下方的「低分高倍复盘」卡片。 */}
        {step('7', '发送到策略 + 上线', '点「时间外推验证」确认排序质量站得住 → 点「发送到策略」：整体替换策略里的打分段（硬否决段原样保留）、CUTOFF 同步，自动跳到「策略」tab。代码只在策略侧生成一处；上线再用「策略」tab 的「生成上线代码」——把 f(\'字段\') 翻译成纯 native ctx 代码（无 f、无垫片，直接字段内联取值、派生字段内联计算），并逐字段自检。找因子只找因子，不再自己生成代码。')}

        {/* 2026-07-29：这一节原本常驻在「因子发现」卡顶部（7 行 Typography.Paragraph），
            跟"扫描结果已过期"那类必须当场处理的有态告警抢同一屏注意力。内容本身"看一次就够"，
            所以整体收进这张默认折叠的 SOP 卡，发现卡上只留一句定义 + 指回这里。 */}
        <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(127,127,127,.08)', borderRadius: 6 }}>
          <Typography.Text strong style={{ fontSize: 12 }}>两阵营与字段范围</Typography.Text>
          <Space direction="vertical" size={2} style={{ marginTop: 6, fontSize: 12 }}>
            <span>· <b>勇者阵营</b>挖"高倍盘集中的取值区间"，命中 = 好迹象、加分；<b>邪恶阵营</b>挖"输家（未达高倍阈值）集中的取值区间"，命中 = 危险迹象、减分。两边各自独立扫描，复用同一套 AUC + 区间挖掘算法（lift/捕获率评分口径一致，只是目标类从"赢"换成"输"）。</span>
            <span>· <b>原字段</b>＝数据源直接给的，能映射回实盘 ctx，可以进上线代码。</span>
            <span>· <b>组装字段</b>＝本工具聚合/派生的，实盘 ctx 里没有对应值，仅供探索审核，不能直接进上线代码。</span>
            <span>· <b>全部</b>＝两者一起扫，都能做因子发现；但组装字段命中的规律，仍需你人工在实盘侧复刻计算。</span>
          </Space>
        </div>

        <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(255,159,10,.10)', borderRadius: 6 }}>
          <Typography.Text strong style={{ fontSize: 12 }}>⚠️ 三个别踩的坑</Typography.Text>
          <Space direction="vertical" size={2} style={{ marginTop: 6, fontSize: 12 }}>
            <span>· <b>别按 AUC/显著性挑因子</b>：显著≠有用（可能和已选完全冗余，边际贡献≈0）。挑因子只看边际ρ(test)。</span>
            <span>· <b>别只看 train 涨高兴</b>：没涨 held-out test 的提升都是假的。因子宁少勿滥。</span>
            <span>· <b>别堆相关因子</b>：三个同味道的字段一起塞，排序质量不会三倍好，只会过拟合。</span>
          </Space>
        </div>
      </div>
    ),
  }];
  return <Collapse size="small" items={items} style={{ background: 'transparent' }} />;
}
