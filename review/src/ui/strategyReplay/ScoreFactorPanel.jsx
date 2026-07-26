import React from 'react';
import { Typography, Table, Tag, Alert, Modal, Button, Popconfirm } from 'antd';
import PlotlyChart from '../PlotlyChart.jsx';
import { logearnUrl } from '../../lib/utils.js';
import { describeFactorLabel } from '../../lib/dictionary.js';
import { prettyBound, factorVerdict, suggestWeightAdjustment } from '../../lib/strategyReplayLogic.js';

// 打分版策略识别出来之后的整块：勇者/邪恶两阵营因子表 + 逐样本打分明细表 + 两个钻取弹窗
// （点因子表一行看该因子的样本明细；点样本表一行看该样本的加减分条形图）。
export default function ScoreFactorPanel({
  scoreAgg, sampleRows, onLabel, onExclude,
  drillDown, setDrillDown, barFigure, failedVetoes,
  factorDrill, setFactorDrillName,
  onApplyWeightSuggestion, onApplyAllWeightSuggestions, crossDayOf,
  removedFactors, onRestoreFactor,
}) {
  if (!scoreAgg) return null;

  // 建议判定走跨天累计（crossDayOf）：连续 N 天同向才可执行，防单日噪声把因子来回调权/误删。
  // 没传 crossDayOf（比如单测/旧调用）时退回单日 factorVerdict，行为不变。
  const verdictOf = crossDayOf
    ? (f) => { const cd = crossDayOf(f); return { verdict: cd.verdict, cd }; }
    : (f) => ({ verdict: factorVerdict(f).verdict, cd: null });

  // 删除跟"标垃圾"不是一回事——标垃圾（onLabel）只把 returnMax 降级成保本，样本还在，n 不变；
  // 删除（onExclude）是真的把这条样本从工作集里拿掉，n 会变小。常见场景：同一笔交易被多天
  // 导入批次重复记录，多出来的那几条只能靠删除处理，标垃圾解决不了"重复计数"这件事。
  // 需要二次确认——不像标垃圾可以随手点一下再点回去撤销，删除之后要去"字段"tab 的
  // 已删除样本里才能恢复，成本更高，值得一个 Popconfirm。
  const deleteColumn = onExclude ? [{
    title: '', width: 70, render: (_, r) => (
      <Popconfirm title={`彻底删除「${r.symbol || r.addr}」这条样本？会从当前工作集拿掉（样本数变小），不是标垃圾——可以在"字段"tab 的已删除样本里恢复`}
        onConfirm={e => { e?.stopPropagation?.(); onExclude(r.addr, r.symbol); }}>
        <Button size="small" danger type="text" onClick={e => e.stopPropagation()}>删除</Button>
      </Popconfirm>
    ),
  }] : [];

  const scoreFactorColumns = [
    { title: '打分因子', dataIndex: 'name', width: 200,
      render: v => <span title={describeFactorLabel(v)} style={{ wordBreak: 'break-all' }}>{v}</span> },
    { title: <span title="核心区（[满分起,满分止] 或 [危险起,危险止]），从生成代码的 checks 期望文本里解析出来">范围</span>,
      width: 130, render: (_, f) => f.coreLo != null
        ? <code style={{ fontSize: 11 }}>{prettyBound(f.coreLo)}~{prettyBound(f.coreHi)}</code>
        : <span style={{ opacity: .5 }}>-</span> },
    { title: '权重', dataIndex: 'weight', width: 70, align: 'right',
      defaultSortOrder: 'descend', sorter: (a, b) => a.weight - b.weight },
    { title: '命中组均分', width: 100, align: 'right',
      render: (_, f) => Number.isFinite(f.avgHit) ? f.avgHit.toFixed(1) : '-' },
    { title: <span title="仅统计硬否决已过、只因分低未命中的样本——被否决的盘分数可能很高，不该混进来">分低组均分</span>,
      width: 100, align: 'right',
      render: (_, f) => Number.isFinite(f.avgMiss) ? f.avgMiss.toFixed(1) : '-' },
    { title: <span title="勇者阵营=拿满 +权重 的样本占比；邪恶阵营=扣满 -权重（命中危险区最深）的样本占比">满效应率</span>,
      width: 80, align: 'right', render: (_, f) => (f.fullRate * 100).toFixed(0) + '%' },
    { title: <span title="完全没起作用（贡献≈0）的样本占比，含缺失——勇者阵营是没沾上光，邪恶阵营是没踩中危险区（好事）">无效应率</span>,
      width: 80, align: 'right', render: (_, f) => (f.zeroRate * 100).toFixed(0) + '%' },
    { title: '缺失率', width: 80, align: 'right',
      render: (_, f) => (f.missingRate * 100).toFixed(0) + '%' },
    { title: <span title="「起作用」样本 vs 「无效应」样本的高倍率对比——衡量该因子是否真在区分好坏盘。勇者阵营期望起作用组胜率更高；邪恶阵营期望起作用组（踩中危险区）胜率更低。用 Wilson 95% 置信区间判断，两组样本量常常悬殊（比如 11 vs 270），不重叠才敢下结论">区分效果</span>,
      width: 230, render: (_, f) => {
        const { verdict, ciScored, ciZero } = factorVerdict(f);
        if (verdict === 'insufficient') return <span style={{ opacity: .5 }}>某侧样本&lt;5，看不出</span>;
        const sw = (f.scoredWin * 100).toFixed(1), zw = (f.zeroWin * 100).toFixed(1);
        const isEvil = f.camp === 'evil';
        const scoredLabel = isEvil ? '踩中危险区' : '起作用';
        const zeroLabel = isEvil ? '未踩中' : '无效应';
        const ciText = `${scoredLabel} ${sw}%（${(ciScored.lo * 100).toFixed(0)}%~${(ciScored.hi * 100).toFixed(0)}%） vs ${zeroLabel} ${zw}%（${(ciZero.lo * 100).toFixed(0)}%~${(ciZero.hi * 100).toFixed(0)}%）`;
        if (verdict === 'worse') return <Tag color="error" title={ciText}>反向 · {zeroLabel} {zw}% &gt; {scoredLabel} {sw}%</Tag>;
        if (verdict === 'better') return <Tag color="success" title={ciText}>有效 · {isEvil ? `${zeroLabel} ${zw}% > ${scoredLabel} ${sw}%` : `${scoredLabel} ${sw}% > ${zeroLabel} ${zw}%`}</Tag>;
        return <span style={{ opacity: .5 }} title={ciText}>置信区间有重叠，分不出真假（{sw}% vs {zw}%）</span>;
      } },
    { title: <span title="硬否决已过、只因分低未命中；勇者阵营=把这项补满就能过线，邪恶阵营=如果没被这项扣分就能过线——都是最值得先调的因子">差此一项</span>,
      dataIndex: 'lackOne', width: 90, align: 'right',
      sorter: (a, b) => a.lackOne - b.lackOne, render: v => <b>{v}</b> },
    { title: <span title="已命中、但去掉该因子贡献就跌破阈值的样本数（仅勇者阵营有意义——邪恶阵营的扣分项去掉只会让分数更高，天然算不出「依赖」）">依赖此项</span>,
      dataIndex: 'dependOn', width: 90, align: 'right', sorter: (a, b) => a.dependOn - b.dependOn },
    ...(onApplyWeightSuggestion ? [{
      title: <span title="根据「区分效果」的判定给调权建议，且要跨天连续同向才动手（防单日噪声）：连续 N 天都判【真反向】(worse) 才 -2，降到≤1 直接建议删除；连续 N 天都判有效(better) → +2；只连了一天、或分不出真假(close)、样本不够(insufficient) 都不动——今天判反向但还没连够，只显示「再观察」不给按钮。点「试算」会先算应用前后的单调性 ρ/命中率对比（含样本外闸门），确认提升再应用">调权建议</span>,
      width: 160, render: (_, f) => {
        const { verdict, cd } = verdictOf(f);
        const suggestion = suggestWeightAdjustment(verdict, f.weight);
        if (suggestion.action === 'none') {
          // 今天判出方向了、但还没连够 minStreak 天——显示"再观察"，先不动手
          if (cd && cd.verdict === 'hold' && (cd.today === 'worse' || cd.today === 'better')) {
            const dirLabel = cd.today === 'worse' ? '反向' : '有效';
            return <Tag color="default" title={`今天判${dirLabel}，但要连续 ${cd.minStreak} 天同向才调权——已连 ${cd.streak}/${cd.minStreak} 天，再观察`}>
              {dirLabel} {cd.streak}/{cd.minStreak}天 · 再观察
            </Tag>;
          }
          return <span style={{ opacity: .5 }}>-</span>;
        }
        const streakTip = cd ? `（已连续 ${cd.streak} 天判${cd.direction === 'worse' ? '反向' : '有效'}）` : '';
        if (suggestion.action === 'remove') return (
          <span onClick={e => e.stopPropagation()}>
            <Tag color="error" title={streakTip}>建议删除</Tag>
            <Button size="small" type="link" onClick={() => onApplyWeightSuggestion(f)}>试算</Button>
          </span>
        );
        return (
          <span onClick={e => e.stopPropagation()}>
            <Tag color={suggestion.newWeight > f.weight ? 'success' : 'warning'} title={streakTip}>
              {f.weight} → {suggestion.newWeight}
            </Tag>
            <Button size="small" type="link" onClick={() => onApplyWeightSuggestion(f)}>试算</Button>
          </span>
        );
      },
    }] : []),
  ];
  const heroFactors = scoreAgg.factors.filter(f => f.camp !== 'evil');
  const evilFactors = scoreAgg.factors.filter(f => f.camp === 'evil');

  // 汇总一下批量按钮点了会试算些什么——按钮文案里直接报数（调 N · 删 M），点了先弹试算对比，
  // 不是立刻应用。
  const suggestionSummary = onApplyAllWeightSuggestions ? scoreAgg.factors.reduce((acc, f) => {
    const suggestion = suggestWeightAdjustment(verdictOf(f).verdict, f.weight);
    if (suggestion.action === 'adjust') acc.adjust++;
    else if (suggestion.action === 'remove') acc.remove++;
    return acc;
  }, { adjust: 0, remove: 0 }) : null;

  return (
    <>
      <Alert type="info" showIcon style={{ marginTop: 12 }} message={
        <span style={{ fontSize: 12 }}>
          识别到<b>打分版策略</b>：未命中拆成 硬否决拦截 <b>{scoreAgg.vetoBlocked}</b> 条 +
          分数不足 <b>{scoreAgg.scoreBlocked}</b> 条（阈值 {scoreAgg.cutoff}）；
          命中组平均总分 <b>{Number.isFinite(scoreAgg.avgScoreHit) ? scoreAgg.avgScoreHit.toFixed(1) : '-'}</b>，
          分低未命中组平均 <b>{Number.isFinite(scoreAgg.avgScoreMiss) ? scoreAgg.avgScoreMiss.toFixed(1) : '-'}</b>。
          硬否决与总分仍在下方硬条件表，可看推荐阈值；下面按阵营分两张表，每次调完区间/权重、
          重新粘代码回放，就能看这两张表和下面的逐样本明细有没有变好。
        </span>
      } />
      {suggestionSummary && (suggestionSummary.adjust + suggestionSummary.remove > 0) && (
        <Button size="small" style={{ marginTop: 8 }} type="primary" ghost onClick={onApplyAllWeightSuggestions}>
          试算全部调权建议（调 {suggestionSummary.adjust} · 删 {suggestionSummary.remove}）
        </Button>
      )}
      {removedFactors && removedFactors.length > 0 && (
        <Alert type="warning" showIcon style={{ marginTop: 10 }}
          message={<span style={{ fontSize: 12 }}>已删因子 {removedFactors.length} 个（可加回来）</span>}
          description={
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {removedFactors.map(item => (
                <span key={item.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2,
                  border: '1px solid var(--border,#d9d9d9)', borderRadius: 4, padding: '1px 4px 1px 8px' }}>
                  <span title={item.line} style={{ fontSize: 12, wordBreak: 'break-all' }}>{item.name}</span>
                  {onRestoreFactor && <Button size="small" type="link" onClick={() => onRestoreFactor(item)}>加回来</Button>}
                </span>
              ))}
            </div>
          } />
      )}
      {heroFactors.length > 0 && (
        <>
          <Typography.Text strong style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
            🛡 勇者阵营（{heroFactors.length} 个，加分，点一行看对应样本明细）
          </Typography.Text>
          <Table style={{ marginTop: 6 }} size="small" rowKey="name" pagination={false}
            dataSource={heroFactors} columns={scoreFactorColumns} scroll={{ x: 1100 }}
            onRow={record => ({ onClick: () => setFactorDrillName(record.name), style: { cursor: 'pointer' } })} />
        </>
      )}
      {evilFactors.length > 0 && (
        <>
          <Typography.Text strong style={{ fontSize: 12, display: 'block', marginTop: 16 }}>
            ☠ 邪恶阵营（{evilFactors.length} 个，减分，点一行看对应样本明细）
          </Typography.Text>
          <Table style={{ marginTop: 6 }} size="small" rowKey="name" pagination={false}
            dataSource={evilFactors} columns={scoreFactorColumns} scroll={{ x: 1100 }}
            onRow={record => ({ onClick: () => setFactorDrillName(record.name), style: { cursor: 'pointer' } })} />
        </>
      )}

      <Typography.Text strong style={{ fontSize: 12, display: 'block', marginTop: 16 }}>
        逐样本打分明细（{sampleRows.length} 条，点击一行看该样本的因子加减分条形图）
      </Typography.Text>
      <Table style={{ marginTop: 6 }} size="small" rowKey="id" pagination={{ pageSize: 20, size: 'small' }}
        dataSource={sampleRows}
        rowClassName={r => (!r.vetoOk ? 'row-hurts' : '')}
        onRow={record => ({ onClick: () => setDrillDown(record), style: { cursor: 'pointer' } })}
        columns={[
          { title: 'symbol', dataIndex: 'symbol', width: 110 },
          { title: 'CA', dataIndex: 'addr', width: 260, render: v => v
            ? <a href={logearnUrl(v)} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
                <code style={{ fontSize: 11 }}>{v}</code></a> : null },
          { title: 'returnMax', dataIndex: 'ret', width: 110, align: 'right',
            sorter: (a, b) => a.ret - b.ret,
            render: v => <span style={{ color: v >= 2 ? '#30d158' : 'var(--muted, #8e8e93)' }}>
              {v.toFixed(2)}x{v >= 2 ? ' ✓赢' : ''}</span> },
          { title: '总分', dataIndex: 'score', width: 100, align: 'right',
            defaultSortOrder: 'descend', sorter: (a, b) => a.score - b.score,
            render: v => v.toFixed(1) },
          { title: '通过', dataIndex: 'passed', width: 110,
            filters: [{ text: '通过', value: true }, { text: '未过', value: false }],
            onFilter: (v, r) => r.passed === v,
            render: (v, r) => v ? <Tag color="success">通过</Tag>
              : (r.vetoOk ? <Tag>未过</Tag>
                : <Tag color="error" title="硬否决条件没过，跟分数够不够无关——整行标红就是这个原因">硬条件未过</Tag>) },
          ...(onLabel ? [{
            title: <span title="标垃圾＝人工判定这笔其实没赚到（比如只是一根扎针没法真的卖出去），把它的 returnMax 降级成 1.0x，让上面的胜率/中位数/打分对比表都按真实情况重算——不删样本，只是不再算赢家">标注</span>,
            width: 100,
            render: (_, r) => (
              <Button size="small" danger={r.label === 'junk'}
                type={r.label === 'junk' ? 'primary' : 'text'}
                onClick={e => { e.stopPropagation(); onLabel(r.addr, r.label === 'junk' ? null : 'junk'); }}>
                {r.label === 'junk' ? '🗑 已标' : '🗑 标垃圾'}
              </Button>
            ),
          }] : []),
          ...deleteColumn,
        ]} />
      <Modal open={!!drillDown} onCancel={() => setDrillDown(null)} footer={null} width={720}
        title={drillDown ? `${drillDown.symbol}（${drillDown.ret.toFixed(2)}x，总分 ${drillDown.score.toFixed(1)}）因子加减分明细` : ''}>
        {failedVetoes.length > 0 && (
          <Alert type="error" showIcon style={{ marginBottom: 12 }}
            message={`硬否决未通过，共 ${failedVetoes.length} 条（跟分数无关，分再高也不能过）`}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {failedVetoes.map((c, i) => (
                  <li key={i}><b>{c.name}</b>：{String(c.value)}（期望 {c.expect}）</li>
                ))}
              </ul>
            } />
        )}
        {barFigure
          ? <PlotlyChart traces={barFigure.traces} layout={barFigure.layout} height={barFigure.layout.height} />
          : <Typography.Text type="secondary">该样本没有可解析的因子明细</Typography.Text>}
      </Modal>
      {/* 点勇者/邪恶阵营表的一行，看这个因子具体是哪些样本——尤其是"区分效果"显示"反向"
          （负相关）的时候，不能只信一个汇总百分比就下结论，得点开看是哪几个具体的盘，
          人工审核到底是这个因子真的选反了、还是被这批数据本身的样本量/幸存者偏差带偏了。*/}
      <Modal open={!!factorDrill} onCancel={() => setFactorDrillName(null)} footer={null} width={820}
        title={factorDrill ? `「${factorDrill.name}」样本明细（${factorDrill.camp === 'evil' ? '☠ 邪恶' : '🛡 勇者'}阵营，权重 ${factorDrill.weight}）` : ''}>
        {factorDrill && (() => {
          const isEvil = factorDrill.camp === 'evil';
          const scoredLabel = isEvil ? '踩中危险区' : '起作用';
          const zeroLabel = isEvil ? '未踩中' : '无效应';
          const scoredSamples = factorDrill.samples.filter(s => !s.isZero)
            .sort((a, b) => (b.ret || 0) - (a.ret || 0));
          const zeroSamples = factorDrill.samples.filter(s => s.isZero)
            .sort((a, b) => (b.ret || 0) - (a.ret || 0));
          const sampleColumns = [
            { title: 'symbol', dataIndex: 'symbol', width: 110 },
            { title: 'CA', dataIndex: 'addr', width: 260, render: v => v
              ? <a href={logearnUrl(v)} target="_blank" rel="noopener noreferrer">
                  <code style={{ fontSize: 11 }}>{v}</code></a> : null },
            { title: 'returnMax', dataIndex: 'ret', width: 100, align: 'right',
              sorter: (a, b) => a.ret - b.ret,
              render: v => Number.isFinite(v)
                ? <span style={{ color: v >= 2 ? '#30d158' : 'var(--muted, #8e8e93)' }}>
                    {v.toFixed(2)}x{v >= 2 ? ' ✓赢' : ''}</span>
                : '-' },
            { title: '贡献', dataIndex: 'contrib', width: 90, align: 'right',
              render: v => Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(1) : '-' },
            ...(onLabel ? [{
              title: '标注', width: 100,
              render: (_, r) => (
                <Button size="small" danger={r.label === 'junk'}
                  type={r.label === 'junk' ? 'primary' : 'text'}
                  onClick={() => onLabel(r.addr, r.label === 'junk' ? null : 'junk')}>
                  {r.label === 'junk' ? '🗑 已标' : '🗑 标垃圾'}
                </Button>
              ),
            }] : []),
            ...deleteColumn,
          ];
          return (
            <>
              {(() => {
                const { verdict } = factorVerdict({
                  scoredWin: factorDrill.scoredWin, scoredN: factorDrill.scoredN,
                  zeroWin: factorDrill.zeroWin, zeroN: factorDrill.zeroN, camp: factorDrill.camp,
                });
                return verdict === 'worse' ? (
                  <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                    message={`这个因子当前是"反向"的——${zeroLabel}组胜率反而高于${scoredLabel}组（两组 Wilson 95% 置信区间不重叠，不是样本噪声），下面两组样本人工核对一下是不是真的选反了`} />
                ) : null;
              })()}
              <Typography.Text strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                {scoredLabel}组（{scoredSamples.length} 条）
              </Typography.Text>
              <Table size="small" rowKey={(r, i) => r.addr || i} pagination={{ pageSize: 10, size: 'small' }}
                dataSource={scoredSamples} columns={sampleColumns} />
              <Typography.Text strong style={{ fontSize: 12, display: 'block', margin: '16px 0 6px' }}>
                {zeroLabel}组（{zeroSamples.length} 条）
              </Typography.Text>
              <Table size="small" rowKey={(r, i) => r.addr || i} pagination={{ pageSize: 10, size: 'small' }}
                dataSource={zeroSamples} columns={sampleColumns} />
            </>
          );
        })()}
      </Modal>
    </>
  );
}
