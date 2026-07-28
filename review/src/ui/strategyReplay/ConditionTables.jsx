import React, { useState } from 'react';
import { Typography, Table, Tag, Button, Modal } from 'antd';
import { describeFactorLabel } from '../../lib/dictionary.js';
import { logearnUrl } from '../../lib/utils.js';

// 硬性条件表：agg.ranked 里 expect 文案不含"权重"字样的就是硬否决项（打分因子的 expect
// 固定是"满分 x~y 权重 w"格式，见 SCORE_FACTOR_EXPECT_RE，父组件的 hardConditions 已经筛好）。
// 点一行 → 弹窗列出这条硬条件拦掉的所有 CA（aggregateCheckStats 里每条 check 都存了 st.blocked，
// 含 symbol/addr/实际值/期望/是否单点否决/returnMax），方便人工核对"到底拦掉了谁、有没有误杀赢家"。
export function HardConditionsTable({ hardConditions }) {
  const [drill, setDrill] = useState(null); // 当前点开查看被拦 CA 的那条硬条件（st 对象，带 .blocked）
  if (!hardConditions.length) return null;
  const blocked = (drill && Array.isArray(drill.blocked) ? drill.blocked : [])
    .slice().sort((a, b) => (Number(b.ret) || 0) - (Number(a.ret) || 0)); // 倍率降序：先看有没有误杀大票
  const soleCount = blocked.filter(b => b.sole).length;
  const winCount = blocked.filter(b => Number(b.ret) > 2).length;
  return (
    <>
      <Typography.Text strong style={{ fontSize: 12, display: 'block', marginTop: 16 }}>
        硬性条件（{hardConditions.length} 条，一票否决，不参与打分；点一行看这条拦掉了哪些 CA）
      </Typography.Text>
      <Table style={{ marginTop: 6 }} size="small" rowKey="name" pagination={false}
        dataSource={hardConditions}
        onRow={record => ({
          onClick: () => record.fail > 0 && setDrill(record),
          style: { cursor: record.fail > 0 ? 'pointer' : 'default' },
        })}
        columns={[
          { title: 'check', dataIndex: 'name', width: 160,
            render: v => <span title={describeFactorLabel(v)}>{v}</span> },
          { title: '期望', dataIndex: 'expect', width: 200, render: v => <code style={{ fontSize: 11 }}>{v || '-'}</code> },
          { title: '通过', dataIndex: 'pass', width: 90, align: 'right', sorter: (a, b) => a.pass - b.pass },
          { title: '拦截', dataIndex: 'fail', width: 90, align: 'right',
            defaultSortOrder: 'descend', sorter: (a, b) => a.fail - b.fail,
            render: (v, st) => v > 0
              ? <a onClick={e => { e.stopPropagation(); setDrill(st); }} style={{ color: '#ff453a', fontWeight: 700 }}>{v}</a>
              : v },
          { title: <span title="对比这条硬条件拦掉的样本 vs 放行的样本，各自的胜率——判断这条阈值到底卡对了还是在误杀赢家">效果</span>,
            width: 260, render: (_, st) => {
              if (st.effect === 'idle') return <Tag>未拦截</Tag>;
              const pw = Number.isFinite(st.passWin) ? (st.passWin * 100).toFixed(1) : '-';
              const bw = Number.isFinite(st.blockWin) ? (st.blockWin * 100).toFixed(1) : '-';
              if (st.effect === 'hurts') return (
                <Tag color="error" title={`放行组胜率 ${pw}% 低于被拦组 ${bw}%`}>
                  退步 · 拦掉的更能赢（拦 {bw}% &gt; 放行 {pw}%）
                </Tag>);
              const soleWarn = st.soleHurts ? (
                <div style={{ marginTop: 4 }}>
                  <Tag color="warning" title="只卡这一条的样本里赢家过半——松绑这条阈值放回来的正好是这些人，能净抓赢家">
                    ⚠️ 单点否决 {st.soleWins}/{st.soleTotal} 是赢家，松绑能多抓
                  </Tag>
                </div>
              ) : null;
              if (st.effect === 'helps') return (
                <div>
                  <Tag color="success" title={`放行组胜率 ${pw}% 高于被拦组 ${bw}%`}>
                    有效 · 放行 {pw}% &gt; 拦 {bw}%
                  </Tag>{soleWarn}
                </div>);
              return <div><span style={{ opacity: .5 }}>拦掉/放行胜率接近</span>{soleWarn}</div>;
            } },
        ]} />
      <Modal open={!!drill} onCancel={() => setDrill(null)} footer={null} width={860}
        title={drill ? `「${drill.name}」拦掉的 CA（${blocked.length} 条，期望 ${drill.expect || '-'}）` : ''}>
        {drill && (
          <>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
              共拦掉 <b>{blocked.length}</b> 条；其中 <b style={{ color: '#faad14' }}>{soleCount}</b> 条<b>只卡这一条</b>
              （松绑这条阈值就能直接放回来），<b style={{ color: '#30d158' }}>{winCount}</b> 条是赢家（&gt;2x）
              {winCount > 0 && soleCount > 0 ? '——重点看下面既是赢家又是单点否决的行，那是被这条误杀的大票。' : '。'}
              按 returnMax 倍率降序，先看有没有误杀大票。
            </Typography.Paragraph>
            <Table size="small" rowKey={(r, i) => r.addr || i} pagination={{ pageSize: 15, size: 'small' }}
              dataSource={blocked}
              rowClassName={r => (r.sole && Number(r.ret) > 2 ? 'row-hurts' : '')}
              columns={[
                { title: 'symbol', dataIndex: 'symbol', width: 110 },
                { title: 'CA', dataIndex: 'addr', width: 300, render: v => v
                  ? <a href={logearnUrl(v)} target="_blank" rel="noopener noreferrer"><code style={{ fontSize: 11 }}>{v}</code></a>
                  : <span style={{ opacity: .4 }}>-</span> },
                { title: 'returnMax', dataIndex: 'ret', width: 110, align: 'right',
                  defaultSortOrder: 'descend', sorter: (a, b) => (Number(a.ret) || 0) - (Number(b.ret) || 0),
                  render: v => Number.isFinite(Number(v))
                    ? <span style={{ color: Number(v) >= 2 ? '#30d158' : 'var(--muted, #8e8e93)' }}>
                        {Number(v).toFixed(2)}x{Number(v) >= 2 ? ' ✓赢' : ''}</span>
                    : '-' },
                { title: <span title="这条 check 在该样本上读到的实际值">实际值</span>,
                  dataIndex: 'val', width: 150, render: v => <code style={{ fontSize: 11 }}>{v === '' || v == null ? '-' : String(v)}</code> },
                { title: <span title="只卡这一条：放宽这条阈值就能直接把它放回命中集">单点否决</span>,
                  dataIndex: 'sole', width: 100,
                  filters: [{ text: '只看单点否决', value: true }], onFilter: (val, r) => r.sole === val,
                  render: v => v ? <Tag color="warning">只卡这条</Tag> : <span style={{ opacity: .4 }}>否</span> },
              ]} />
          </>
        )}
      </Modal>
    </>
  );
}

// 因子有效性一键分析表：只看已经在打分池里的项（硬条件不参与打分、这里不重复列——想看硬条件
// 用上面的硬性条件清单表），把它的"实际值"跟 log(收益) 算过单变量相关性（父组件算好传下来，
// 已做 BH-FDR 多重比较校正），这里只负责展示 + 应用推荐权重 / 删除 两个操作入口。
export function FactorEffectivenessTable({ factorEffectiveness, recommendedWeights, onApplyRecommendedWeights, onRemoveCheck }) {
  if (!factorEffectiveness.length) return null;
  const recMap = new Map(recommendedWeights.map(f => [f.name, f.recommended]));
  return (
    <>
      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography.Text strong style={{ fontSize: 12 }}>
          因子有效性一键分析（打分项的原始值 vs log(收益) 单变量相关性，已按 BH-FDR 做多重比较校正）
        </Typography.Text>
        {recommendedWeights.length > 0 ? (
          <Button size="small" type="primary" onClick={onApplyRecommendedWeights}>
            应用推荐权重到代码（{recommendedWeights.length} 项）
          </Button>
        ) : (
          <span style={{ fontSize: 12, opacity: .55 }}
            title={factorEffectiveness.length
              ? '这批字段的相关性都没能扛住 BH 多重比较校正——可能是噪声，不建议据此调权重'
              : '当前打分池是空的，全是硬条件——推荐权重只对打分池里的字段生效'}>
            {factorEffectiveness.length ? '没有字段校正后仍显著，不推荐调权重' : '当前打分池为空，没有可推荐权重的字段'}
          </span>
        )}
      </div>
      <Table style={{ marginTop: 6 }} size="small" rowKey="name" pagination={false}
        dataSource={factorEffectiveness}
        columns={[
          { title: '字段', dataIndex: 'name', width: 220,
            render: v => <span title={describeFactorLabel(v)} style={{ wordBreak: 'break-all' }}>{v}</span> },
          { title: 'n', dataIndex: 'n', width: 70, align: 'right' },
          { title: 'r', dataIndex: 'r', width: 90, align: 'right',
            defaultSortOrder: 'descend', sorter: (a, b) => Math.abs(a.r) - Math.abs(b.r),
            render: v => v.toFixed(3) },
          { title: 'p', dataIndex: 'p', width: 100, align: 'right',
            render: v => v.toExponential(2) },
          { title: <span title="同批检验了多个字段，BH-FDR 校正后的 p 值——比原始 p 更保守，是判断显著性该看的那一列">校正后 p</span>,
            dataIndex: 'pAdj', width: 100, align: 'right',
            render: v => Number.isFinite(v) ? <span style={{ color: v < 0.05 ? '#30d158' : undefined }}>{v.toExponential(2)}</span> : '-' },
          { title: '', width: 90, render: (_, f) => Number.isFinite(f.pAdj) && f.pAdj < 0.05
            ? <Tag color="success">校正后显著</Tag> : <span style={{ opacity: .5 }}>不显著</span> },
          { title: <span title="按 |r| 等比例缩放，最强的因子给 10，下限 1">推荐权重</span>,
            width: 90, align: 'right',
            render: (_, f) => recMap.has(f.name) ? <b>{recMap.get(f.name)}</b> : '-' },
          { title: '操作', width: 70, render: (_, f) => (
            <Button size="small" danger onClick={() => onRemoveCheck(f)}>删除</Button>
          ) },
        ]} />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 6 }}>
        这里的 r 是在【当前整批数据】上算的单变量相关性，没做样本外验证——只用来初筛"哪些打分项
        权重该调大/调小"。"应用推荐权重"只改权重数字，不动区间形状。
        应用之后记得重新点"在当前数据源回放"，再看一眼上面"总分 vs 收益"的样本外验证有没有变好。
      </Typography.Paragraph>
    </>
  );
}
