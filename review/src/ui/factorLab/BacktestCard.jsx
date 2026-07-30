import React from 'react';
import { Card, Space, Slider, InputNumber, Tooltip, Button, Alert, Row, Col, Statistic, Typography, Table, Tag, Checkbox } from 'antd';
import PlotlyChart from '../PlotlyChart.jsx';

const fmtPct = v => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-');
// 纯函数，跟 FactorLab.jsx 里那份定义一致——那边还有别的调用点（时间外推逐段扫描）用得上，
// 这里独立拷贝一份而不是当 prop 传，减少一个不必要的函数类型 prop。
const sweepAt = (bt, cut) => bt.sweep.points.reduce((best, p) => (p.cut <= cut ? p : best), bt.sweep.points[0]);

// 「回测」卡片：cutoff 滑块 + 触发数/命中率/lift 统计 + cutoff 扫描曲线 + 分数-倍数散点 +
// 十分位表 + 时间外推验证(walk-forward)。数据全部由 FactorLab 算好传入（backtest/sweepFigure/
// scoreScatterFigure/oos 等 useMemo 结果、cutoffRecommend 等衍生值），这里只管展示——
// 这些计算在 FactorLab.jsx 里还有其它调用点（exportFullReport 等），不能整体搬过来。
export default function BacktestCard({
  backtest, cutoff, setCutoff, cutoffMin, cutoffRecommend, applyRecommendedCutoff,
  exportFullReport, exportRawDataJson, hasEvil, base, sweepFigure, scoreScatterFigure,
  threshold, oosBusy, runOOS, oosProgress, oos, oosFoldRows, oosFoldIdx, setOosFoldIdx,
  oosFoldSweepFigure, oosKeepWeights, setOosKeepWeights,
}) {
  const decileColumns = [
    { title: '分段', dataIndex: 'bin', width: 60 },
    { title: '分数区间', width: 130, render: (_, d) => `${d.scoreLo.toFixed(1)} ~ ${d.scoreHi.toFixed(1)}` },
    { title: 'n', dataIndex: 'n', width: 60, align: 'right' },
    { title: `>${threshold}x 数`, dataIndex: 'pos', width: 80, align: 'right' },
    { title: '高倍率', width: 150, align: 'right',
      render: (_, d) => `${fmtPct(d.hiRate)}（${fmtPct(d.wilson.lo)}~${fmtPct(d.wilson.hi)}）` },
    { title: '倍数均值', width: 90, align: 'right', render: (_, d) => d.avgRet.toFixed(2) + 'x' },
    { title: '倍数中位', width: 90, align: 'right', render: (_, d) => d.medRet.toFixed(2) + 'x' },
  ];

  return (
    <Card id="fl-backtest" size="small" title="回测"
      extra={<Space size={16}>
        <span style={{ fontSize: 12, opacity: .65 }}>触发阈值</span>
        <Slider style={{ width: 180 }} min={cutoffMin} max={100} value={cutoff}
          onChange={v => setCutoff(v)} />
        <InputNumber size="small" min={cutoffMin} max={100} value={cutoff}
          onChange={v => setCutoff(v ?? 0)} />
        <Tooltip title={cutoffRecommend
          ? `在触发数≥样本量5%（且≥20）的档位里，挑净超额命中数（触发数×(命中率−基准命中率)）最大的一档：cut=${cutoffRecommend.cut}，触发 ${cutoffRecommend.triggered}，命中率 ${fmtPct(cutoffRecommend.hitRate)}，捕获率 ${fmtPct(cutoffRecommend.capture)}，lift ${cutoffRecommend.lift.toFixed(2)}`
          : '样本不足，暂无法推荐'}>
          <Button size="small" onClick={applyRecommendedCutoff} disabled={!cutoffRecommend}>
            🎯 推荐阈值{cutoffRecommend ? `（${cutoffRecommend.cut}）` : ''}
          </Button>
        </Tooltip>
        <Tooltip title="把候选字段清单/配置/因子池/去冗余/北极星ρ最优配权结果/当前回测/cutoff扫描/分段表/时间外推/基线库对比/因子推荐分档诊断/漏网之鱼——凡是已经算出来的，全部拼成一份 markdown 复制到剪贴板，直接粘给 AI 让它诊断调试，不用再一节一节分开导出手工拼。">
          <Button size="small" type="primary" ghost onClick={exportFullReport}>📋 导出完整报告（喂 AI）</Button>
        </Tooltip>
        <Tooltip title="导出原始样本数据 JSON（rows + 当前因子池 + 候选 + 配置），跟 buildRows() 产出的形状完全一致——可以直接在 Node 里 import factorLab.js 重放 scoreRows/recommendFactorPath/computeRankBuckets 等原函数，在内存中验证方案，不用等实现完再回测。">
          <Button size="small" onClick={exportRawDataJson}>💾 导出原始数据（供内存验证）</Button>
        </Tooltip>
      </Space>}>
      {hasEvil && <Alert style={{ marginBottom: 12 }} type="info" showIcon
        message="已包含邪恶阵营因子，总分可能为负——阈值滑块下限已相应放宽到 -100。" />}
      {/* 阈值失效检测。真实踩过、而且一直被误记成"推荐阈值选出了 0 触发的档"：
          recommendCutoff 自带 minN=max(20, 5%n) 保护，【不可能】返回触发数为 0 的档位——
          0/128 那种画面的真正来源是【当前 cutoff 高于因子池能打出的最高分】：
          因子越多、命中区越不重叠，总分上限越低（score=Σ(±w·s)/Σw，没有样本能命中所有因子，
          6 个互斥弱因子的池子上限只有 16.7），而 cutoff 默认 60、还是【持久化】的——
          换一份数据、换一批因子、改一次阈值/缺失口径，分数分布整个变了，cutoff 却原地不动。
          于是触发 0、命中率 NaN（显示"-"）、捕获率 0.0%，看着像"策略彻底失效"，其实只是刻度错了。 */}
      {(() => {
        const p = sweepAt(backtest, cutoff);
        const maxScore = backtest.scored.reduce((m, s) => Math.max(m, s.score), -Infinity);
        const minTrig = Math.max(20, Math.ceil(base.n * 0.05));   // 跟 recommendCutoff 同一把尺子
        if (p.triggered === 0) {
          return <Alert style={{ marginBottom: 12 }} type="error" showIcon
            message={<span style={{ fontSize: 12 }}>
              ⚠️ 当前阈值 {cutoff} 下<b>没有任何样本触发</b>——因子池打得出的最高分只有 {maxScore.toFixed(1)}
            </span>}
            description={<span style={{ fontSize: 12 }}>
              下面这些数字（命中率"-"、捕获率 0.0%、lift"-"）不是策略失效，是阈值定在了分数分布之外。
              因子越多、各自的命中区越不重叠，总分上限就越低（总分 = Σ(±权重×命中) ÷ Σ勇者权重，没有样本能同时命中所有因子），
              而 cutoff 是持久化的、不会跟着因子池自动变。
              {cutoffRecommend
                ? <>　点右上角「🎯 推荐阈值（{cutoffRecommend.cut}）」重新定一次。</>
                : <>　样本太少，推荐阈值也给不出来，先把阈值拉到 {Math.floor(maxScore)} 以下再看。</>}
            </span>} />;
        }
        if (p.triggered < minTrig) {
          return <Alert style={{ marginBottom: 12 }} type="warning" showIcon
            message={<span style={{ fontSize: 12 }}>
              当前阈值 {cutoff} 下只有 {p.triggered} 个样本触发（少于 {minTrig}，最高分 {maxScore.toFixed(1)}）——
              命中率/lift 的抽样噪声很大，别据此下结论
            </span>}
            description={cutoffRecommend
              ? <span style={{ fontSize: 12 }}>「🎯 推荐阈值（{cutoffRecommend.cut}）」按钮挑的是触发数够（≥{minTrig}）里净超额命中数最大的一档，可以先用它对照。</span>
              : null} />;
        }
        return null;
      })()}
      {(() => { const p = sweepAt(backtest, cutoff); return (
        <Row gutter={24} style={{ marginBottom: 12 }}>
          <Col><Statistic title="触发数" value={p.triggered} suffix={`/ ${base.n}`} /></Col>
          <Col><Statistic title={`高倍命中率（基准 ${fmtPct(base.baseRate)}）`} value={fmtPct(p.hitRate)} /></Col>
          <Col><Statistic title="高倍捕获率" value={fmtPct(p.capture)} /></Col>
          <Col><Statistic title="lift" value={Number.isFinite(p.lift) ? p.lift.toFixed(2) : '-'} /></Col>
        </Row>); })()}
      {sweepFigure && <PlotlyChart traces={sweepFigure.traces} layout={sweepFigure.layout} height={340} />}
      {scoreScatterFigure && (<>
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
          分数 vs 倍数散点（Y 轴对数）：橙=高倍（{'>'}{threshold}x），灰=普通；红竖线=当前 cutoff，绿虚横线=高倍阈值。
          高倍点是否靠右堆、有没有大量橙点落在竖线左侧（漏网），一眼可看。
        </Typography.Text>
        <PlotlyChart traces={scoreScatterFigure.traces} layout={scoreScatterFigure.layout} height={380} />
      </>)}
      <Table style={{ marginTop: 12 }} size="small" rowKey="bin" columns={decileColumns}
        dataSource={backtest.deciles} pagination={false} scroll={{ x: 700 }} />
      <div style={{ marginTop: 16 }}>
        <Space align="center" wrap>
          <Button loading={oosBusy} onClick={runOOS}>时间外推验证（walk-forward：前 70% 起步 → 后 30% 切多段滚动检验）</Button>
          <Checkbox checked={oosKeepWeights} onChange={e => setOosKeepWeights(e.target.checked)}>
            <Tooltip title="默认关闭：每段连权重也重新自动配，检验「整套参数」能不能外推。打开后只重挖区间、沿用因子池里现在这套权重（含手调/ρ最优写回的），把「配权变了」这个变量摘掉，单独看区间是不是过拟合。">
              <span style={{ fontSize: 12 }}>沿用因子池权重</span>
            </Tooltip>
          </Checkbox>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            区间与权重只用各段训练集重新自动推导（不含手工编辑），原样套到该段验证——不再只切一刀，滚动切出多段，
            单段可能只是运气好/坏，多段一起看才知道是不是真的稳。<b>cutoff 也是每段各自在训练段上重新定的</b>
            （净超额命中数最大），不是页面上那个全样本 cutoff——各段独立重训、分数分布对不上，套同一个数值会让阈值失效。
          </Typography.Text>
        </Space>
        {oosBusy && oosProgress && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
          验证第 {oosProgress.completed}/{oosProgress.total} 段…</div>}
        {oos && !oos.error && (() => {
          const foldRows = oosFoldRows;
          const nSignificant = foldRows.filter(r => r.decay?.significant).length;
          const fold = oos.folds[Math.min(oosFoldIdx, oos.folds.length - 1)];
          const fmtT = ts => Number.isFinite(ts) ? new Date(ts * 1000).toLocaleDateString() : '-';
          return (
            <div style={{ marginTop: 12 }}>
              <Alert type={nSignificant > 0 ? 'warning' : 'success'} showIcon
                message={`共 ${oos.folds.length} 段滚动验证，其中 ${nSignificant} 段判定「验证段命中率显著低于训练段」（两比例检验 p<0.05，不是固定比例阈值）。`} />
              {/* 每段 cutoff 现在是各自在训练段上训出来的（不再套全样本那个），但仍有两种要单独说清楚的情况：
                  ① 训练段太薄、recommendCutoff 定不出来 → 退回全样本 cutoff，可能触发 0；
                  ② 阈值几乎把训练段全放行 → 命中率退化成基准率、lift 恒 1.00，那一段等于没测到。 */}
              {(() => {
                const noTrig = foldRows.filter(r => !r.error && r.te.triggered === 0).length;
                if (!noTrig) return null;
                return <Alert style={{ marginTop: 8 }} type="info" showIcon
                  message={<span style={{ fontSize: 12 }}>
                    有 {noTrig} 段在该段 cutoff 下验证窗口内<b>没有任何样本触发</b>（表里标红的 0）
                  </span>}
                  description={<span style={{ fontSize: 12 }}>
                    这不是衰减：各段样本量小、分数分布本来就会漂。这些段的命中率/lift 无定义，衰减判定也会标成
                    "样本不足，不下结论"——看整体结论时请把它们排除。
                  </span>} />;
              })()}
              {(() => {
                const inert = foldRows.filter(r => !r.error && r.inert?.inert);
                if (!inert.length) return null;
                return <Alert style={{ marginTop: 8 }} type="warning" showIcon
                  message={<span style={{ fontSize: 12 }}>
                    有 {inert.length} 段的 cutoff <b>形同虚设</b>：训练段触发率 ≥95%（
                    {inert.map(r => `#${r.idx + 1} ${fmtPct(r.inert.frac)}`).join('、')}）
                  </span>}
                  description={<span style={{ fontSize: 12 }}>
                    阈值几乎放行了全部训练样本，命中率会退化成该段的<b>基准高倍率</b>、lift 恒等于 1.00 —— 这不代表
                    "泛化好"，而是这一段<b>根本没测到</b>。多半是该段训练集正类太少、recommendCutoff 找不到净超额为正
                    的档位。请把这些段从结论里排除。
                  </span>} />;
              })()}
              <Table style={{ marginTop: 8 }} size="small" pagination={false} rowKey="key"
                onRow={r => ({ onClick: () => setOosFoldIdx(r.idx),
                  style: { cursor: 'pointer', background: r.idx === oosFoldIdx ? 'rgba(10,132,255,.12)' : undefined } })}
                columns={[
                  { title: '段', dataIndex: 'idx', width: 50, render: i => `#${i + 1}` },
                  { title: '验证窗口时间', width: 160, render: (_, r) => r.error ? '-' : `${fmtT(r.testStart)} ~ ${fmtT(r.testEnd)}` },
                  { title: 'train n', width: 70, align: 'right', dataIndex: 'trainSize' },
                  { title: 'test n', width: 70, align: 'right', dataIndex: 'testSize' },
                  // 每段自己的 cutoff：'train'=在该段训练集上训出来的（正常情况）；
                  // 'fallback'=该段太薄、recommendCutoff 定不出来，退回了页面上那个全样本 cutoff
                  { title: '该段cutoff', width: 110, align: 'right',
                    render: (_, r) => r.error ? '-' : (
                      <Tooltip title={r.cutoffSource === 'train'
                        ? '在该段训练集上重新定的阈值（净超额命中数最大，触发数不足时不取）'
                        : `该段训练集太薄，定不出阈值，退回页面上的全样本 cutoff=${cutoff}——这一段的外推结论请打折扣看`}>
                        <span style={{ color: r.cutoffSource === 'train' ? undefined : '#ff9f0a' }}>
                          {r.cutoff}{r.cutoffSource === 'train' ? '' : ' ⚠'}
                        </span></Tooltip>) },
                  // 触发数为 0 的一侧标红：这一格是"命中率/lift 为什么是 -"的唯一解释，
                  // 不标出来就会被读成"策略在这一段彻底失效"，实际是 cutoff 高过了这一段的分数分布。
                  // 训练段触发率 ≥95% 也标出来——那是反过来的失效：阈值没在筛任何东西。
                  { title: '触发数(train/test)', width: 140, align: 'right',
                    render: (_, r) => {
                      if (r.error) return '-';
                      const zero = (v) => v === 0
                        ? <Tooltip title="这一段在该段 cutoff 下没有任何样本达标——不是衰减，是阈值高过了这一段的分数分布（各段样本量小、分数分布本来就会漂）">
                            <span style={{ color: '#ff453a', fontWeight: 600 }}>0</span></Tooltip>
                        : <span>{v}</span>;
                      const trCell = r.inert?.inert
                        ? <Tooltip title={`训练段触发率 ${fmtPct(r.inert.frac)} ≥95%，阈值形同虚设：命中率退化成基准高倍率、lift 恒为 1.00，这一段没测到东西`}>
                            <span style={{ color: '#ff9f0a', fontWeight: 600 }}>{r.tr.triggered} ⚠</span></Tooltip>
                        : zero(r.tr.triggered);
                      return <span>{trCell} / {zero(r.te.triggered)}</span>;
                    } },
                  { title: '命中率(train/test)', width: 150, align: 'right',
                    render: (_, r) => {
                      if (r.error) return '-';
                      const cell = (p) => p.triggered === 0
                        ? <Tooltip title="该侧无触发样本，命中率无定义"><span style={{ opacity: .5 }}>无触发</span></Tooltip>
                        : <span>{fmtPct(p.hitRate)}</span>;
                      return <span>{cell(r.tr)} / {cell(r.te)}</span>;
                    } },
                  { title: 'lift(train/test)', width: 120, align: 'right',
                    render: (_, r) => r.error ? '-' : `${Number.isFinite(r.tr.lift) ? r.tr.lift.toFixed(2) : '-'} / ${Number.isFinite(r.te.lift) ? r.te.lift.toFixed(2) : '-'}` },
                  { title: '衰减判定', width: 160, render: (_, r) => {
                      if (r.error) return <Typography.Text type="danger" style={{ fontSize: 12 }}>{r.error}</Typography.Text>;
                      // 阈值失效时两侧命中率都只是各自的基准高倍率，这个检验比的是"两段行情的基准率差异"，
                      // 跟因子池一点关系都没有——不能让它输出"未衰减"这种让人放心的结论
                      if (r.inert?.inert) return <Tooltip title="训练段触发率≥95%，两侧命中率退化成各自的基准高倍率，这个检验比的是两段行情本身的差异，跟因子池无关"><Tag color="warning">阈值失效，判定无意义</Tag></Tooltip>;
                      if (r.decay.insufficientN) return <Tag>样本不足，不下结论</Tag>;
                      if (r.decay.significant) return <Tag color="error">⚠️ 显著衰减 p={r.decay.p.toFixed(3)}</Tag>;
                      if (r.decay.decayed) return <Tag color="warning">略降，未达显著</Tag>;
                      return <Tag color="success">未衰减</Tag>;
                    } },
                ]} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>点某一行可切换下面的详情面板（曲线对比 + 逐因子归因）。</Typography.Text>

              {fold && !fold.error && (
                <div style={{ marginTop: 12 }}>
                  <Typography.Text strong style={{ fontSize: 13 }}>第 #{oosFoldIdx + 1} 段详情</Typography.Text>
                  {oosFoldSweepFigure && <>
                    <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
                      完整 cutoff 扫描曲线对照（不只看一个 cutoff）：两条线整体贴合 = 全程都稳；
                      只在某一段cutoff区间分叉 = 只有那个区间衰减，别的区间还站得住。红色竖线=<b>该段自己训出来的 cutoff</b>。
                    </Typography.Paragraph>
                    <PlotlyChart traces={oosFoldSweepFigure.traces} layout={oosFoldSweepFigure.layout} height={300} />
                  </>}
                  {fold.factorDecay?.length > 0 && (() => {
                    const rowsD = fold.factorDecay.slice()
                      .sort((a, b) => (Number.isFinite(b.aucDrop) ? b.aucDrop : -1) - (Number.isFinite(a.aucDrop) ? a.aucDrop : -1));
                    return (
                      <>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          逐因子归因（粗略诊断，不是严格检验）：该字段独立算的 AUC 在训练段/验证段的差值，跌得最多的排最前——
                          总分lift塌了，先看这里排最前的几个字段。<b>"test样本量(正类数)"很小时（比如正类数&lt;10），AUC跌幅/涨幅别当真</b>——
                          AUC是排序统计量，正类数太少方差极大，一段之间大幅波动多半是噪声，不是这个字段真的变强/变弱了。
                        </Typography.Text>
                        <Table style={{ marginTop: 4 }} size="small" pagination={false} rowKey="field"
                          dataSource={rowsD.map((r, i) => ({ ...r, key: i }))}
                          columns={[
                            { title: '阵营', dataIndex: 'camp', width: 60, render: c => c === 'evil' ? '☠邪恶' : '🛡勇者' },
                            { title: '字段', dataIndex: 'field', render: f => <code style={{ fontSize: 12 }}>{f}</code> },
                            { title: 'train AUC', width: 90, align: 'right', render: (_, r) => Number.isFinite(r.trainAuc) ? r.trainAuc.toFixed(3) : '-' },
                            { title: 'test AUC', width: 90, align: 'right', render: (_, r) => Number.isFinite(r.testAuc) ? r.testAuc.toFixed(3) : '-' },
                            { title: 'AUC 跌幅', width: 90, align: 'right', render: (_, r) => Number.isFinite(r.aucDrop)
                                ? <span style={{ color: r.aucDrop > 0.1 ? 'var(--ng,#ff453a)' : undefined }}>{r.aucDrop >= 0 ? '+' : ''}{r.aucDrop.toFixed(3)}</span> : '-' },
                            { title: 'test样本量(正类数)', width: 130, align: 'right', render: (_, r) => {
                                const thin = Number.isFinite(r.testPos) && r.testPos < 10;
                                return <span style={{ color: thin ? 'var(--warn,#ff9f0a)' : undefined }}>
                                  {r.testN ?? '-'}（{r.testPos ?? '-'}）{thin && ' ⚠️'}
                                </span>;
                              } },
                          ]} />
                      </>
                    );
                  })()}
                  {fold.skipped?.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    该段训练时跳过：{fold.skipped.map(s => `${s.field}（${s.reason}）`).join('；')}</Typography.Text>}
                </div>
              )}
            </div>);
        })()}
        {oos && oos.error && <Alert style={{ marginTop: 8 }} type="warning" showIcon message={oos.error} />}
      </div>
    </Card>
  );
}
