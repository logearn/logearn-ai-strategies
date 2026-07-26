import React from 'react';
import { Typography, Alert, Row, Col, Statistic, Table, Checkbox } from 'antd';
import PlotlyChart from '../PlotlyChart.jsx';

// "总分 vs 收益"整块：score-return 相关性统计 + 散点图 + 分位桶胜率表 + 样本外验证。
// 不依赖 scoreAgg（那个要求打分池非空才非 null）——只要 checks 里能找到"总分"这一行就展示，
// 哪怕 score 恒为占位常数，也老实展示"没有变化，算不出相关性"，而不是这块直接消失。
export default function ScoreReturnPanel({
  scoreReturnStats, factorEffectiveness, scoreScatterFig, scoreBuckets, scoreReturnPairsLength,
  oosEnabled, onOosEnabledChange, scoreReturnOOS,
}) {
  if (!scoreReturnStats) return null;
  return (
    <>
      <Typography.Text strong style={{ fontSize: 12, display: 'block', marginTop: 16 }}>
        总分 vs 收益（回归到"score 是否真的跟高倍正相关"这个核心目标）
      </Typography.Text>
      {scoreReturnStats.constant ? (
        <Alert type="warning" showIcon style={{ marginTop: 8 }}
          message={`总分在全部 ${scoreReturnStats.n} 条样本上恒为同一个值，算不出相关性`}
          description={factorEffectiveness.some(f => f.isFactor)
            // 打分池不是空的，但这批数据里所有打分因子恰好都是满分——常见原因是这批 calls
            // 本身就是被差不多的阈值筛过的幸存者（这次实测就撞上了：垃圾钱包%/Top10持仓%
            // 挪进打分组后，区间跟原硬条件一样，而这批数据里所有样本本来就都满足硬条件，
            // 挪组后自然全部满分，不是工具的问题，是这批数据本身没有区分度）。
            // 想看到变化：换一批方差更大、没被同样标准筛过的数据，或者把打分因子的区间
            // 收紧到比原硬条件更严格（这样同一批"通过"的样本里才能分出高低）。
            ? '不是没测出来——打分池不是空的，但这批数据里所有打分因子恰好都是满分。常见原因：这批 calls 本身就是被差不多的阈值筛过的幸存者，挪进打分组的区间跟原硬条件一样严格，这批数据里的样本本来就全部满足，自然没有区分度。想让这个指标有意义，换一批方差更大的数据，或者把打分因子的区间收紧到比原硬条件更严格。'
            : '不是没测出来，是当前打分池是空的（所有检查项都在 VETO_NAMES 里，没有任何打分因子），score 只是个占位常数。想让这个指标有意义，得先把至少一项挪进打分组。'} />
      ) : (
        <>
          <Row gutter={16} style={{ marginTop: 8, marginBottom: 8 }}>
            <Col><Statistic title="样本数" value={scoreReturnStats.n} /></Col>
            <Col><Statistic title="r（原始倍数）" value={scoreReturnStats.rRaw.toFixed(3)}
              valueStyle={{ color: scoreReturnStats.pRaw < 0.05 ? '#30d158' : undefined }} /></Col>
            <Col><Statistic title="p（原始倍数）" value={scoreReturnStats.pRaw.toExponential(2)} /></Col>
            <Col><Statistic title="r（log 倍数，收窄长尾）" value={scoreReturnStats.rLog.toFixed(3)}
              valueStyle={{ color: scoreReturnStats.pLog < 0.05 ? '#30d158' : '#ff9f0a' }} /></Col>
            <Col><Statistic title="p（log 倍数）" value={scoreReturnStats.pLog.toExponential(2)} /></Col>
            <Col><Statistic title="spearman ρ" value={scoreReturnStats.rho.toFixed(3)} /></Col>
          </Row>
          <Alert type="info" showIcon style={{ marginBottom: 8 }} message={
            <span style={{ fontSize: 12 }}>
              {scoreReturnStats.pLog < 0.05
                ? <>log 倍数口径下 p&lt;0.05，有统计上站得住的正相关，但 r={scoreReturnStats.rLog.toFixed(2)} 只能算弱相关（R²≈{(scoreReturnStats.rLog**2*100).toFixed(0)}%），score 解释不了大部分收益差异，别过度解读。</>
                : <>p≥0.05，当前样本上还看不出显著相关——可能是样本量不够、可能是打分因子本身没抓到真信号，也可能这批数据本身同质度高（比如全部通过导致 score 分布很窄）。</>}
              在没见过的数据上重新验证之前，不建议直接拿这个相关系数去定权重。
            </span>
          } />
          {scoreScatterFig && <PlotlyChart traces={scoreScatterFig.traces} layout={scoreScatterFig.layout} />}
          {/* score 分位 vs 胜率：定/调 CUTOFF 之前先看这个——不单调就别调阈值。
              每桶胜率带 Wilson 95% 置信区间，桶样本量小（20 条上下）时区间宽到 ±20
              个百分点是常态，单个桶的点估计别当真，看的是整体趋势是否单调。 */}
          {scoreBuckets && (
            <>
              <Typography.Text strong style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
                score {scoreBuckets.K === 10 ? '十' : '五'}分位 vs 胜率（&gt;2x）——定打分阈值前先确认单调性
                {scoreBuckets.effectiveBuckets < scoreBuckets.K && `（同分已合并，实际 ${scoreBuckets.effectiveBuckets} 档）`}
              </Typography.Text>
              {scoreBuckets.maxTieFrac >= 0.5 && (
                <Alert showIcon type="warning" style={{ marginTop: 6, marginBottom: 6 }}
                  message={
                    <span style={{ fontSize: 12 }}>
                      score 高度饱和：{(scoreBuckets.maxTieFrac * 100).toFixed(0)}% 的样本挤在同一个分数上（大多是"全通过"打满分），
                      这批样本天然分不出高下，分位分析参考价值有限——下面的单调性 ρ 只在少数几个真正不同分的档之间算，别据此精调阈值。
                      想让 score 有区分度，得先让打分因子把这批同分样本区分开（收紧区间/加能分化它们的因子）。
                    </span>
                  } />
              )}
              <Alert showIcon style={{ marginTop: 6, marginBottom: 6 }}
                type={scoreBuckets.rho >= 0.7 ? 'success' : scoreBuckets.rho >= 0.3 ? 'warning' : 'error'}
                message={
                  <span style={{ fontSize: 12 }}>
                    {scoreBuckets.rho >= 0.7
                      ? <>单调性良好（桶序 vs 胜率 spearman ρ={scoreBuckets.rho.toFixed(2)}）——score 有排序能力，可以在这张表上挑阈值：找胜率明显跳升的那一档，把阈值定在它的分数下界附近（取整数）。</>
                      : scoreBuckets.rho >= 0.3
                        ? <>单调性偏弱（ρ={scoreBuckets.rho.toFixed(2)}）——趋势方向存在但不稳定，阈值只适合粗粒度二选一（比如"前一半 vs 后一半"），别指望精确到某一档。</>
                        : <>不单调（ρ={scoreBuckets.rho.toFixed(2)}）——score 对胜率没有排序能力，此时调阈值没有意义，先回去修因子（删掉反向/无效的，或重新校准区间），再回来看这张表。</>}
                  </span>
                } />
              <Table size="small" rowKey="idx" pagination={false}
                dataSource={scoreBuckets.buckets}
                columns={[
                  { title: '分位桶', dataIndex: 'idx', width: 80, render: v => `第 ${v} 档` },
                  { title: 'score 范围', width: 140,
                    render: (_, b) => <code style={{ fontSize: 11 }}>{b.scoreLo.toFixed(1)}~{b.scoreHi.toFixed(1)}</code> },
                  { title: 'n', dataIndex: 'n', width: 60, align: 'right' },
                  { title: '赢家数', dataIndex: 'wins', width: 80, align: 'right' },
                  { title: '胜率', width: 110, align: 'right',
                    render: (_, b) => <b>{(b.winRate * 100).toFixed(1)}%</b> },
                  { title: <span title="Wilson 95% 置信区间——桶样本量小时区间很宽，两个桶的区间大幅重叠就说明它们的胜率差异分不出真假">95% 置信区间</span>,
                    width: 140, align: 'right',
                    render: (_, b) => <span style={{ opacity: .65, fontSize: 12 }}>
                      {(b.ciLo * 100).toFixed(0)}%~{(b.ciHi * 100).toFixed(0)}%</span> },
                  { title: '', render: (_, b) => (
                    <div style={{ background: 'rgba(255,255,255,.06)', borderRadius: 4, height: 14, position: 'relative', minWidth: 120 }}>
                      <div style={{ position: 'absolute', left: `${b.ciLo * 100}%`, width: `${Math.max(0.5, (b.ciHi - b.ciLo) * 100)}%`, top: 3, bottom: 3, background: 'rgba(10,132,255,.25)', borderRadius: 2 }} />
                      <div style={{ position: 'absolute', left: `calc(${b.winRate * 100}% - 2px)`, width: 4, top: 0, bottom: 0, background: '#0a84ff', borderRadius: 2 }} />
                    </div>
                  ) },
                ]} />
            </>
          )}
          {scoreReturnStats && !scoreReturnStats.constant && !scoreBuckets && (
            <Alert type="info" style={{ marginTop: 8 }} message={
              <span style={{ fontSize: 12 }}>样本不足 60 条，分位桶每桶样本太少（不到 12 条），胜率的置信区间宽到没有参考意义，不出分位表。</span>
            } />
          )}
          <Checkbox checked={oosEnabled} onChange={e => onOosEnabledChange(e.target.checked)} style={{ marginTop: 8 }}>
            <span style={{ fontSize: 12 }}>
              样本外验证：按买入时间切 70% 训练 / 30% 测试——训练集显著不代表数，
              得看测试集是否依然显著（上次调强势盘权重就是训练集好看、测试集才见真章）
            </span>
          </Checkbox>
          {oosEnabled && (
            scoreReturnOOS ? (
              <>
                <Table style={{ marginTop: 8 }} size="small" rowKey="label" pagination={false}
                  dataSource={[
                    { label: '训练集（早）', ...scoreReturnOOS.train },
                    { label: '测试集（晚，样本外）', ...scoreReturnOOS.test },
                  ]}
                  columns={[
                    { title: '', dataIndex: 'label', width: 160 },
                    { title: 'n', dataIndex: 'n', width: 70, align: 'right' },
                    { title: 'r（log 倍数）', width: 110, align: 'right',
                      render: (_, s) => s.constant ? <span style={{ opacity: .5 }}>score恒定</span> : s.rLog.toFixed(3) },
                    { title: 'p（log 倍数）', width: 110, align: 'right',
                      render: (_, s) => s.constant ? '-' : (
                        <span style={{ color: s.pLog < 0.05 ? '#30d158' : undefined }}>{s.pLog.toExponential(2)}</span>) },
                    { title: 'spearman ρ', width: 100, align: 'right',
                      render: (_, s) => s.constant ? '-' : s.rho.toFixed(3) },
                  ]} />
                {!scoreReturnOOS.test.constant && (
                  <Alert type={scoreReturnOOS.test.pLog < 0.05 ? 'success' : 'warning'} showIcon
                    style={{ marginTop: 8 }} message={
                    <span style={{ fontSize: 12 }}>
                      {scoreReturnOOS.test.pLog < 0.05
                        ? '测试集（样本外）依然显著，这个相关性看起来不只是训练集的噪声，值得作为后续调权重的参考。'
                        : '测试集（样本外）p≥0.05——训练集上看到的相关性没能在没见过的数据上重现，很可能是训练集噪声，先别拿它去定权重。'}
                    </span>
                  } />
                )}
              </>
            ) : (
              <Alert type="info" style={{ marginTop: 8 }}
                message={`样本数不足 20 条（当前 ${scoreReturnPairsLength} 条），切了训练/测试之后每边都太少，样本外验证的结果没有参考意义`} />
            )
          )}
        </>
      )}
    </>
  );
}
