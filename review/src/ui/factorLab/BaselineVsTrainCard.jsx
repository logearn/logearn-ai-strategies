import React from 'react';
import { Card, Select, Typography, Alert, Table, Tag, Tooltip } from 'antd';

const fmtPct = v => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-');

// 基线库 vs 训练集(按天) 对比：监控现成策略在不同数据来源/时间上是否漂移，跟「时间外推验证」
// 不是一回事——那个是当前样本内自动切分+重新训练，这个是用户在「数据与过滤」手动按天归类的
// 基准库/训练集，这里只是拿现成因子池原样打分对比。strategyOptions/baselineVsTrain 的推导
// （依赖 archiveAllRows/archiveSliceCats）留在 FactorLab，这里只管展示 + 切换策略。
export default function BaselineVsTrainCard({
  strategyOptions, baselineVsTrainStrategy, onStrategyChange,
  archiveAllRows, baselineVsTrain, cutoff,
}) {
  return (
    <Card size="small" title="基线库 vs 训练集(按天) 对比"
      extra={strategyOptions.length > 1 && (
        <Select size="small" style={{ width: 200 }} value={baselineVsTrainStrategy}
          onChange={onStrategyChange}
          options={strategyOptions.map(s => ({ value: s.strategyName, label: `${s.strategyName}（${s.count}条）` }))} />
      )}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        用<b>当前因子池原样打分</b>（不重新推导任何区间/权重）——「基准库」当一个整体算一次，「训练集」按天各自算一次，
        跟基准库做两比例检验，看训练集哪几天的命中率已经显著偏离基准库。基准库/训练集的归类入口在「数据与过滤」tab 的时间切片。
        {strategyOptions.length > 1 && <>归类按"策略+天"两个维度记，<b>不同策略的样本不会混在一起</b>，右上角可切换策略。</>}
      </Typography.Paragraph>
      {!archiveAllRows?.length ? (
        <Alert type="info" showIcon message='还没有归档数据——先在「数据与过滤」tab 把部分天归为"基准库"、部分天归为"训练集"。' />
      ) : !baselineVsTrain ? (
        <Alert type="info" showIcon message="先建好因子池再看这个对比。" />
      ) : baselineVsTrain.error ? (
        <Alert type="warning" showIcon message={baselineVsTrain.error} />
      ) : (() => {
        const nSig = baselineVsTrain.groups.filter(g => g.decay?.significant).length;
        const dataSource = [
          { key: 'baseline', label: '基准库(整体)', isBaseline: true, ...baselineVsTrain.baseline },
          ...baselineVsTrain.groups.map(g => ({ key: g.label, label: g.label, ...g })),
        ];
        return (
          <>
            <Alert type={nSig > 0 ? 'warning' : 'success'} showIcon
              message={`训练集共 ${baselineVsTrain.groups.length} 天，其中 ${nSig} 天判定「命中率显著低于基准库」（两比例检验 p<0.05，不是固定比例阈值）。`} />
            <Table style={{ marginTop: 8 }} size="small" pagination={false} rowKey="key"
              dataSource={dataSource}
              columns={[
                { title: '', width: 130, render: (_, r) => r.isBaseline
                    ? <Typography.Text strong>{r.label}</Typography.Text> : r.label },
                { title: 'n', dataIndex: 'n', width: 70, align: 'right' },
                // 同 walk-forward 分段表：0 触发标红，命中率写"无触发"而不是一个看着像"很差"的 -
                { title: '触发数', width: 80, align: 'right',
                  render: (_, r) => r.error ? '-' : (r.triggered === 0
                    ? <Tooltip title={`这一天在 cutoff=${cutoff} 下没有任何样本达标——不是命中率差，是没有样本进入统计`}>
                        <span style={{ color: '#ff453a', fontWeight: 600 }}>0</span></Tooltip>
                    : r.triggered) },
                { title: '命中率', width: 90, align: 'right',
                  render: (_, r) => r.error ? '-' : (r.triggered === 0
                    ? <span style={{ opacity: .5 }}>无触发</span> : fmtPct(r.hitRate)) },
                { title: 'lift', width: 80, align: 'right', render: (_, r) => r.error ? '-' : (Number.isFinite(r.lift) ? r.lift.toFixed(2) : '-') },
                { title: '判定', width: 170, render: (_, r) => {
                    if (r.isBaseline) return <Tag>参照基准</Tag>;
                    if (r.error) return <Typography.Text type="danger" style={{ fontSize: 12 }}>{r.error}</Typography.Text>;
                    const d = r.decay;
                    if (d.insufficientN) return <Tag>样本不足，不下结论</Tag>;
                    if (d.significant) return <Tag color="error">⚠️ 显著偏离 p={d.p.toFixed(3)}</Tag>;
                    if (d.decayed) return <Tag color="warning">略降，未达显著</Tag>;
                    return <Tag color="success">正常</Tag>;
                  } },
              ]}
              scroll={{ y: 360 }} />
          </>
        );
      })()}
    </Card>
  );
}
