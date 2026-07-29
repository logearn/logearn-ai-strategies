import React, { useState, useEffect, useRef } from 'react';
import { Card, Button, Segmented, Tag, Typography, Space, Tooltip, Alert, Checkbox } from 'antd';
import { recommendFactorPool } from '../../lib/factorLab.js';
import { runRecommendInWorker } from './workerPool.js';

// 🧭 因子推荐（2026-07-29 由原「因子推荐」+「因子推荐2」两张卡片合并而来）
//
// 合并的原因不是省代码，是原来两张卡对同一个问题给两个答案，用户还得判断信哪个——而且两者的
// 差异恰好在方法论最要害的地方：旧「因子推荐1」选字段做 held-out（每步 train 推边界、test 评增量），
// 旧「因子推荐2」选字段在全样本内做、靠事后校验兜底。后者正是 computeHeldOutDeltaRho 那次统一
// 要修的毛病。合并取长：**选字段用 held-out**（1 的纪律）+ **收尾用精配权/影子权重/K折 k***（2 的能力）。
// 底层是单个 recommendFactorPool，UI 上一张卡、一个「算推荐」按钮。
//
// 两个路径模式（沿用两张卡都有的语义）：
//  - combo（组合路径）：从【当前因子池】出发，只找新增字段；起点池不重复挑选、不计入 k*。
//  - explore（探索全路径）：从空开始，独立于当前池，给"从零最优组合"，可对照。
//
// 2026-07-28 去掉"池子变了自动重算"（历史，勿删）：这条贪心遍历全部候选、跑起来不便宜，而自动
// 重算原来是"factors 变化就触发"（防抖 600ms）——删一个因子、改一个权重数字都会在 600ms 后
// 在主线程跑一遍贪心，用户反馈"点删除很卡"，根因就是这个。改成手动触发 + "结果可能过期"提示。
//
// 2026-07-29 顺带去掉了 evaluateCandidatesWithWorkers 那道候选预评估：它对全部候选算一遍
// held-out Δρ 只为过滤掉"评估不出来"的，而贪心内部本来就会跳过 testRho 非有限的候选，
// 且候选表的「计算候选边际ρ贡献」算的就是同一个数——纯重复一遍全量计算。
// 因子池的轻量签名（字段+阵营+权重），只用来判断"结果算完之后池子是不是又变了"，不用做深比较。
const poolSignature = factors => factors.map(f => `${f.camp}:${f.field}:${f.weight}`).join('|');

export default function FactorRecommendCard({ rows, factors, candidates, threshold, missingPolicy,
  scoreShape, onAdopt, onAdoptFactors, onResultChange }) {
  const [mode, setMode] = useState('combo');
  // 只看勇者阵营：邪恶阵营候选量通常远大于勇者（"高倍盘"永远是少数类，反过来"输家/红旗"样本
  // 天然多得多），贪心搜索天然会一边倒选邪恶——不是算法偏心，是数据本身的类别不平衡（详见项目
  // 记忆 north-star-monotonicity）。勾选后彻底把邪恶候选排除在搜索范围外，逼着看勇者阵营单独
  // 能不能挖出真实、经得住 held-out 检验的正向信号，而不是被邪恶候选"抢跑"掩盖掉。
  const [heroOnly, setHeroOnly] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [staleFactorsAt, setStaleFactorsAt] = useState(null); // 结果算出来之后 factors 又变了
  const runCtrl = useRef(null);

  const canRun = Array.isArray(candidates) && candidates.length > 0 && rows.length > 0;

  const run = async (m = mode) => {
    if (!canRun) return;
    if (runCtrl.current) try { runCtrl.current.abort(); } catch (e) {}
    const ac = new AbortController(); runCtrl.current = ac;
    setBusy(true);
    await new Promise(r => setTimeout(r, 0)); // 让 loading 画出来
    try {
      const start = m === 'combo' ? factors : [];
      const scopedCandidates = heroOnly ? candidates.filter(c => c.camp !== 'evil') : candidates;
      const opts = { threshold, missingPolicy, shape: scoreShape, startFactors: start };
      // 整条推荐（选字段贪心 + 精配权 + K折曲线）搬进 worker；无 Worker/失败兜底回主线程直算。
      let res;
      try {
        res = await runRecommendInWorker('recommend',
          { rows, candidates: scopedCandidates, opts }, { signal: ac.signal });
      } catch (e) {
        if (ac.signal.aborted) return;
        res = recommendFactorPool(rows, scopedCandidates, opts);
      }
      if (runCtrl.current !== ac || ac.signal.aborted) return;
      setResult({ ...res, mode: m, factorsSignature: poolSignature(factors) });
      setStaleFactorsAt(null);
    } finally {
      if (runCtrl.current === ac) setBusy(false);
    }
  };

  // combo 模式下，结果算出来之后因子池又变了（删因子/改权重/加因子）——只提示"可能过期"，
  // 不再自动重算（见文件头注释：自动重算曾经在这里悄悄冻住整个页面）。
  useEffect(() => {
    if (!result || mode !== 'combo') return;
    if (poolSignature(factors) !== result.factorsSignature) setStaleFactorsAt(Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factors]);

  const fmt = v => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(3) : '-');
  const path = result?.path || [];

  // 分档诊断不再自己导出——结果通过 onResultChange 抛给 FactorLab，并入顶部「导出完整报告」
  // 统一出一份 markdown（2026-07-29 8个导出按钮合并成2个，见 FactorLab.jsx exportFullReport）。
  useEffect(() => {
    onResultChange?.(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  return (
    <Card size="small" style={{ marginTop: 8 }}
      title={<span>🧭 因子推荐 <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
        （held-out 贪心选字段 → 全样本精配权 → 过拟合校验 → K折定因子数）</Typography.Text></span>}
      extra={<Space>
        <Segmented size="small" value={mode}
          onChange={v => { setMode(v); if (result) run(v); }}
          options={[{ label: '组合路径(基于当前池)', value: 'combo' }, { label: '探索全路径(从零)', value: 'explore' }]} />
        <Tooltip title='邪恶阵营候选量通常远大于勇者（"高倍盘"永远是少数类，"输家/红旗"样本天然多得多），贪心搜索一边倒选邪恶不是算法偏心，是数据类别不平衡（详见项目记忆）。勾选后把邪恶候选彻底排除在搜索范围外，逼着看勇者阵营单独能不能挖出真实、经得住held-out检验的正向信号。'>
          <Checkbox checked={heroOnly} onChange={e => { setHeroOnly(e.target.checked); if (result) run(); }}
            style={{ fontSize: 12 }}>只看勇者阵营</Checkbox>
        </Tooltip>
        <Button size="small" type="primary" loading={busy} disabled={!canRun} onClick={() => run()}>算推荐</Button>
      </Space>}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        选字段<b>逐步做 train/test 切分</b>——每步在训练段推边界、在验证段看 ρ 涨多少，只收验证段真涨的候选
        （跟候选表「边际ρ(test)」同一套纪律）。选完立刻在<b>全样本</b>上精配一次权重，这份权重就是"采用即用"的，
        不必再手动点「🎯按ρ最优配权」；另配一份只用 train 拟合、对 test 全盲的<b>影子权重</b>做过拟合校验，
        再用 <b>held-out K折曲线</b>给出推荐因子数 k*，甩掉过拟合尾巴。
        {mode === 'combo'
          ? <>本模式从<b>当前 {factors.length} 个因子</b>出发，只找【新增】字段——起点池不会被重新挑选，也不计入 k*。</>
          : <>本模式忽略当前池，<b>从零</b>遍历全部候选，采用时整体替换当前因子池。</>}
        {!canRun && <Typography.Text type="warning">先扫描出候选、加载数据再算。</Typography.Text>}
      </Typography.Paragraph>
      {staleFactorsAt && !busy && (
        <Alert style={{ marginBottom: 8 }} type="info" showIcon
          message="因子池变了，下面这份推荐结果可能已经过期——点「算推荐」重新算一次。" />
      )}

      {result && (result.error ? <Alert type="warning" showIcon message={result.error} />
        : path.length === 0
          ? <Alert type="info" showIcon message={mode === 'combo'
              ? '当前池子已经不错——没有候选能让验证段 ρ 再明显提升（或都是负贡献）。'
              : '没挖到能提升验证段 ρ 的组合。'} />
          : (
            <>
              <Space wrap size={4} style={{ marginBottom: 6 }}>
                {path.map((p, i) => (
                  <React.Fragment key={p.camp + ':' + p.field}>
                    {i > 0 && <span style={{ color: 'var(--text-muted)' }}>→</span>}
                    <Tooltip title={`只采用到这一步（把前 ${i + 1} 个合并进池，按区间自动配权——想要精配好的权重请用下面的采用按钮）　held-out Δρ ${fmt(p.deltaTest)}　样本内 Δρ ${fmt(p.deltaIn)}${p.overfit ? '　⚠️ 样本内涨得多、验证段跟不上，疑似过拟合' : ''}${p.testZigzag ? `　held-out 分档打架 ${p.testZigzag.inversionCount} 处（最大回落 ${(p.testZigzag.worstDrop * 100).toFixed(1)}%）` : ''}`}>
                      <Tag color={p.overfit ? 'warning' : (p.camp === 'evil' ? 'red' : 'green')}
                        style={{ cursor: 'pointer', margin: 0 }}
                        onClick={() => onAdopt(path.slice(0, i + 1).map(x => ({ field: x.field, camp: x.camp })))}>
                        {p.camp === 'evil' ? '☠' : '🛡'} <code style={{ fontSize: 11 }}>{p.field}</code>
                        <span style={{ marginLeft: 4, color: p.deltaTest > 0 ? 'var(--ok,#30d158)' : 'var(--text-muted)' }}>{fmt(p.deltaTest)}</span>
                        {p.overfit && ' ⚠️'}
                        {p.testZigzag?.inversionCount > 0 && <span style={{ marginLeft: 4 }}>🌀{p.testZigzag.inversionCount}</span>}
                      </Tag>
                    </Tooltip>
                  </React.Fragment>
                ))}
              </Space>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                标签数字 = 加进去后<b>验证段</b> ρ 的增量(held-out Δρ)；点某一步 = 只把它和之前的合并进池（按区间自动配权）。
                ⚠️=样本内涨但验证段跟不上(过拟合)，🌀N=held-out 分档命中率打架 N 处（曲线倒挂，秩相关感受不到但眼睛能看出来）——别选。
                （train {result.nTrain}/test {result.nTest}）
                <br />精配权后：全样本 ρ {fmt(result.rhoBefore)} → {fmt(result.rhoAfter)}
                {result.zeroedFields?.length > 0 && <>　被压到 0（建议删）：{result.zeroedFields.map(f => <code key={f} style={{ fontSize: 11, marginLeft: 4 }}>{f}</code>)}</>}
              </div>

              <Alert style={{ marginTop: 8 }} type={result.overfit ? 'warning' : 'success'} showIcon
                message={<span style={{ fontSize: 12 }}>
                  过拟合校验（影子权重：只用 train 拟合、对 test 完全盲）：
                  <b> train</b> ρ={fmt(result.rhoTrain)}　<b>held-out test</b> ρ={fmt(result.rhoTest)}
                  <Typography.Text type="secondary">　train {result.nTrain} / test {result.nTest} 条</Typography.Text>
                </span>}
                description={<span style={{ fontSize: 12 }}>
                  {result.overfit
                    ? '⚠️ test 明显低于 train（<40%）——这份因子池的【权重】贴着训练区间的噪声/漂移，采用前先减因子再试一次。'
                    : 'test 没有明显塌陷，这份权重站得住脚，可以采用。'}
                </span>} />

              {result.heldoutCurve && (() => {
                const hc = result.heldoutCurve;
                const rec = result.recommendedCount, kMax = hc.kMax, tail = rec < kMax;
                return (
                  <Alert style={{ marginTop: 8 }} type={tail ? 'warning' : 'success'} showIcon
                    message={<span style={{ fontSize: 12 }}>
                      🔬 held-out {hc.K}折验证曲线：test ρ 在 <b>k={hc.kBest}</b> 见顶（ρ={fmt(hc.bestTestRho)}），1-SE 最省因子数 <b>k*={rec}</b>
                    </span>}
                    description={<span style={{ fontSize: 12 }}>
                      {tail
                        ? <>{result.mode === 'combo' ? '这次新增' : '选出来'} {kMax} 个，但第 <b>{rec + 1}~{kMax}</b> 个在 K 折 held-out 上不再有增益（<b>过拟合尾巴</b>）——建议只留<b>前 {rec} 个</b>。{result.mode === 'combo' && '（起点池不参与这个计数，视为已采信）'}</>
                        : <>{result.mode === 'combo' ? '这次新增的' : ''} {kMax} 个因子在 K 折 held-out 上都还在涨（k*={rec}），没有明显过拟合尾巴。</>}
                      <div style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.9 }}>
                        {hc.curve.map(c => (
                          <span key={c.k} style={{ marginRight: 8, opacity: c.k <= rec ? 1 : 0.4,
                            fontWeight: c.k === rec ? 700 : 400, color: c.k === rec ? '#ff9f0a' : undefined }}>
                            k{c.k}:{Number.isFinite(c.testRho) ? c.testRho.toFixed(3) : '—'}
                          </span>
                        ))}
                      </div>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        注：选字段用的是固定那一刀 train/test；这条曲线换成 K 折、每折重新推边界+配权，
                        专门回答"加到第几个开始不泛化"——贪心一路对着同一段 test 做决策，走到后面难免开始贴着它。
                      </Typography.Text>
                    </span>} />
                );
              })()}

              <Space size={4} style={{ marginTop: 2 }} wrap>
                {result.recommendedCount < path.length && result.factorsTrimmed && (
                  <Button size="small" type="link" style={{ paddingLeft: 0 }}
                    onClick={() => onAdoptFactors(result.factorsTrimmed)}>
                    {result.mode === 'combo'
                      ? `✅ 应用截断到 k*（新增留 ${result.recommendedCount} 个，共 ${result.factorsTrimmed.length} 个）`
                      : `✅ 采用截断到 k*（${result.recommendedCount} 个）替换池`}
                  </Button>
                )}
                <Button size="small" type={result.recommendedCount < path.length ? 'text' : 'link'}
                  style={result.recommendedCount < path.length ? {} : { paddingLeft: 0 }}
                  onClick={() => onAdoptFactors(result.factors)}>
                  {result.recommendedCount < path.length
                    ? `仍采用整条（共 ${result.factors.length} 个）`
                    : result.mode === 'combo'
                      ? `应用到当前池（新增 ${path.length} 个，共 ${result.factors.length} 个，含精配权重）`
                      : `采用整条路径 + 权重（${path.length} 个因子，替换当前因子池）`}
                </Button>
              </Space>
            </>
          ))}
    </Card>
  );
}
