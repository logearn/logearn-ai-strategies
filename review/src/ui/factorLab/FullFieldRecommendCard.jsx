import React, { useMemo, useRef, useState } from 'react';
import { Card, Button, Space, Tag, Alert, Typography, Tooltip, Checkbox, InputNumber, Progress } from 'antd';
import { runRecommendInWorker } from './workerPool.js';
import { recommendFromAllFields, normalizeCampFields } from '../../lib/fullFieldRecommend.js';

// 「全字段贪心」——跟上面那张「因子推荐」并列的第二个入口，刻意不合并成一张卡的理由：
// 两者的候选池口径完全不同（那张吃候选表筛过的 candidates，这张吃全量 fields 现挖的区间），
// 结果的可信度也不同（这张跳过了 AUC bootstrap / 区间置换检验），混在一张卡里用户分不清
// 手上这份路径到底是哪种搜索出来的。上面那张卡的行为一行未动。
//
// 三个搜索增强的默认值在这里是【开】的（beam=3 + 后向剔除 + 单调性闸门），跟 lib 层默认全关
// 正好相反——lib 的默认要守住原入口的历史行为，这张新卡没有历史包袱，直接上最强配置。
export default function FullFieldRecommendCard({ rows, fields, factors, threshold, missingPolicy,
  scoreShape, maxMissRate = 100, blacklist = [], onAdopt, onAdoptFactors }) {
  const [beamWidth, setBeamWidth] = useState(3);
  const [backward, setBackward] = useState(true);
  const [monotoneGate, setMonotoneGate] = useState(true);
  const [useCurrentPool, setUseCurrentPool] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const runCtrl = useRef(null);

  // fields 是 { hero, evil } 两份已剔过「移除」的名单（调用方按阵营算好）。按钮上报的是并集大小
  // ——那才是真正要扫的字段数；两阵营各自的数量放 Tooltip 里，剔得不一样多时能一眼看出来。
  const campFields = useMemo(() => normalizeCampFields(fields), [fields]);
  const scanCount = useMemo(
    () => new Set([...campFields.hero, ...campFields.evil]).size, [campFields]);
  const canRun = scanCount > 0 && rows.length > 0;

  const run = async () => {
    if (!canRun) return;
    if (runCtrl.current) try { runCtrl.current.abort(); } catch (e) {}
    const ac = new AbortController(); runCtrl.current = ac;
    setBusy(true); setPct(0);
    await new Promise(r => setTimeout(r, 0));
    try {
      const opts = {
        threshold, missingPolicy, shape: scoreShape,
        startFactors: useCurrentPool ? factors : [],
        blacklist: (blacklist || []).map(b => ({ camp: b.camp, field: b.field })),
        // 缺失率沿用候选表那道闸（UI 上的滑块），理由同 FactorLab.jsx 的 recommendCandidates：
        // 它是数据可靠性问题不是显著性门槛，全字段模式下更要留着——候选表至少还有人眼过一遍。
        maxMissRate: maxMissRate / 100,
        beamWidth, backward, monotoneGate,
      };
      let res;
      try {
        res = await runRecommendInWorker('recommendAll', { rows, fields, opts },
          { signal: ac.signal, onProgress: p => { if (runCtrl.current === ac) setPct(p); } });
      } catch (e) {
        if (ac.signal.aborted) return;
        res = recommendFromAllFields(rows, fields, opts);   // 无 Worker 环境兜底
      }
      if (runCtrl.current !== ac || ac.signal.aborted) return;
      setResult(res);
    } finally {
      if (runCtrl.current === ac) { setBusy(false); setPct(0); }
    }
  };

  const fmt = v => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(3) : '-');
  const path = result?.path || [];
  const st = result?.scanStats;

  return (
    <Card size="small" style={{ marginTop: 8 }}
      title={<span>🌐 全字段贪心 <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
        （全量字段现挖区间 → 同一套 held-out 流水线）</Typography.Text></span>}
      extra={<Space size={4}>
        <Tooltip title="每步保留几条最优前缀。1=单路径贪心（跟上面那张卡一样），第一步被一个虚高的 Δρ 带偏，后面全在错误分支上找补。3~5 能明显缓解，代价是耗时约 ×N。">
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>beam</span>
        </Tooltip>
        <InputNumber size="small" style={{ width: 56 }} min={1} max={8} value={beamWidth}
          onChange={v => setBeamWidth(v || 1)} />
        <Tooltip title="每加一个新因子，回头逐个试删已选的——删掉后 held-out ρ 不降就真删。治前向贪心「只加不减、旧因子被顶替了还占着位置」。">
          <Checkbox checked={backward} onChange={e => setBackward(e.target.checked)}
            style={{ fontSize: 12 }}>后向剔除</Checkbox>
        </Tooltip>
        <Tooltip title="拒绝会让 held-out 分档倒挂变多的候选。注意：目标函数仍然只有 ρ，倒挂只是准入约束——换目标函数那条线（分层秩相关）试过并已大回退，不再走回去。">
          <Checkbox checked={monotoneGate} onChange={e => setMonotoneGate(e.target.checked)}
            style={{ fontSize: 12 }}>单调性闸门</Checkbox>
        </Tooltip>
        <Tooltip title="勾上=从当前因子池出发只找新增（组合路径）；不勾=从零探索。">
          <Checkbox checked={useCurrentPool} onChange={e => setUseCurrentPool(e.target.checked)}
            style={{ fontSize: 12 }}>基于当前池</Checkbox>
        </Tooltip>
        <Tooltip title={`勇者 ${campFields.hero.length} 个 / 邪恶 ${campFields.evil.length} 个（各自已剔除候选表上手点「移除」的字段），扫描按并集 ${scanCount} 个算`}>
          <Button size="small" type="primary" loading={busy} disabled={!canRun} onClick={run}>
            全字段搜索（{scanCount} 个）</Button>
        </Tooltip>
      </Space>}>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        只绕开<b>字段范围</b>这一道（候选表一次只扫原字段或组装字段其中一类，是扫描成本导致的分批，
        不代表任何人的判断），对<b>跨类字段</b>现挖区间。<b>候选池按阵营取候选表「移除」之后的名单</b>
        ——手点移除过的字段在这里也进不来。缺失率闸门照常生效（当前 ≤{maxMissRate}%），黑名单照常生效。
        为了跑得动，跳过了 AUC 的 bootstrap CI 和区间的置换检验——那两个只喂候选表的显著性列，
        <b>贪心一个都不看</b>。代价是这里的候选<b>没有区间显著性判定</b>（不是"不显著"，是"没检验"），
        要看回上面的候选表。目标函数仍是唯一的北极星：spearman(score, returnMax)。
      </Typography.Paragraph>

      {busy && <Progress percent={pct} size="small" status="active"
        format={p => `挖区间 ${p}%`} style={{ marginBottom: 8 }} />}

      {result && (
        <>
          {st && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
              扫了 <b>{st.scannedCount}</b> 个字段，挖出 <b>{st.candidateCount}</b> 个候选
              （勇者 {st.heroCount} / 邪恶 {st.evilCount}），{st.skippedCount} 个没挖出区间或被缺失率挡下。
              搜索配置：beam={result.search?.beamWidth ?? beamWidth}
              {result.search?.backward ? '、后向剔除' : ''}{result.search?.monotoneGate ? '、单调性闸门' : ''}。
            </div>
          )}

          {result.error ? <Alert type={result.stopReason === 'monotoneGate' ? 'warning' : 'info'}
            showIcon message={result.error} />
            : (
              <>
                <Space wrap size={4} style={{ marginBottom: 6 }}>
                  {path.map((p, i) => (
                    <React.Fragment key={p.camp + ':' + p.field}>
                      {i > 0 && <span style={{ color: 'var(--text-muted)' }}>→</span>}
                      <Tooltip title={`只采用到这一步（前 ${i + 1} 个合并进池、按区间自动配权）　held-out Δρ ${fmt(p.deltaTest)}　样本内 Δρ ${fmt(p.deltaIn)}${p.overfit ? '　⚠️ 样本内涨得多、验证段跟不上，疑似过拟合' : ''}${p.testZigzag ? `　held-out 分档倒挂 ${p.testZigzag.inversionCount} 处` : ''}`}>
                        <Tag color={p.overfit ? 'warning' : (p.camp === 'evil' ? 'red' : 'green')}
                          style={{ cursor: 'pointer', margin: 0 }}
                          onClick={() => onAdopt?.(path.slice(0, i + 1).map(x => ({ field: x.field, camp: x.camp })))}>
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
                  精配权后：全样本 ρ {fmt(result.rhoBefore)} → <b>{fmt(result.rhoAfter)}</b>
                  {result.zeroedFields?.length > 0 && <>　被压到 0（建议删）：{result.zeroedFields.map(f => (
                    <code key={f} style={{ fontSize: 11, marginLeft: 4 }}>{f}</code>))}</>}
                  　（train {result.nTrain}/test {result.nTest}）
                </div>

                <Alert style={{ marginTop: 8 }} type={result.overfit ? 'warning' : 'success'} showIcon
                  message={<span style={{ fontSize: 12 }}>
                    过拟合校验（影子权重：只用 train 拟合、对 test 完全盲）：
                    <b> train</b> ρ={fmt(result.rhoTrain)}　<b>held-out test</b> ρ={fmt(result.rhoTest)}
                  </span>}
                  description={<span style={{ fontSize: 12 }}>
                    {result.overfit
                      ? '⚠️ test 明显低于 train（<40%）——这份权重贴着训练区间的噪声/漂移，采用前先减因子再试一次。'
                      : 'test 没有明显塌陷，这份权重站得住脚。'}
                  </span>} />

                {result.heldoutCurve && (
                  <Alert style={{ marginTop: 8 }} showIcon
                    type={result.recommendedCount < path.length ? 'warning' : 'success'}
                    message={<span style={{ fontSize: 12 }}>
                      🔬 held-out {result.heldoutCurve.K}折验证曲线：1-SE 最省因子数 <b>k*={result.recommendedCount}</b>
                      （共 {path.length} 个）
                    </span>}
                    description={<div style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.9 }}>
                      {result.heldoutCurve.curve.map(c => (
                        <span key={c.k} style={{ marginRight: 8, opacity: c.k <= result.recommendedCount ? 1 : 0.4,
                          fontWeight: c.k === result.recommendedCount ? 700 : 400,
                          color: c.k === result.recommendedCount ? '#ff9f0a' : undefined }}>
                          k{c.k}:{Number.isFinite(c.testRho) ? c.testRho.toFixed(3) : '—'}
                        </span>
                      ))}
                    </div>} />
                )}

                <Space style={{ marginTop: 8 }}>
                  <Button size="small" type="primary"
                    onClick={() => onAdoptFactors?.(result.factorsTrimmed || result.factors)}>
                    ✅ 采用截断到 k*（{result.recommendedCount} 个）
                  </Button>
                  <Button size="small" onClick={() => onAdoptFactors?.(result.factors)}>
                    仍采用整条（{path.length} 个）
                  </Button>
                </Space>
              </>
            )}
        </>
      )}
    </Card>
  );
}
