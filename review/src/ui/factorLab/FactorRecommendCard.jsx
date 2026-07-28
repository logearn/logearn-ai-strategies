import React, { useState, useEffect, useRef } from 'react';
import { Card, Button, Segmented, Tag, Typography, Space, Tooltip, Alert, Checkbox, message } from 'antd';
import { recommendFactorPath, scorePoolBucketRho } from '../../lib/factorLab.js';
import { buildRecommendPathReport } from '../../lib/backtestReportExport.js';
import { evaluateCandidatesWithWorkers } from './workerPool.js';

// 🧭 因子推荐：贪心前向、按 held-out 边际分层秩相关排——只推能泛化的，抗过拟合。
// 两个路径模式：
//  - combo（组合路径）：从【当前因子池】出发推下一步→再下一步；池子变了自动重算（动态）。
//  - explore（探索全路径）：从空开始，独立于当前池，给"从零最优组合"，可对照。
// 2026-07-28：北极星口径固定分层秩相关（不吃cutoff、粗粒度抗噪声），不再提供全局ρ选项——
// 跟"按分层秩相关配权"用同一把尺子。scoreMode 传给 worker 时是字符串常量'bucketRho'
// （worker 跨线程不能传函数引用），worker 内部本地用 scorePoolBucketRho 构造 scoreFn；
// 主线程这边调用 recommendFactorPath 是直接函数调用，可以传真正的 scoreFn。
// 点路径上的某一步 = 采用到该步（把它和它之前的都加进池子）。计算较重，按需触发 + loading。
export default function FactorRecommendCard({ rows, factors, candidates, threshold, missingPolicy, scoreShape, onAdopt }) {
  const [mode, setMode] = useState('combo');
  const scoreMode = 'bucketRho';
  // 只看勇者阵营：邪恶阵营候选量通常远大于勇者（"高倍盘"永远是少数类，反过来"输家/红旗"样本
  // 天然多得多），贪心搜索天然会一边倒选邪恶——不是算法偏心，是数据本身的类别不平衡（详见项目
  // 记忆 north-star-monotonicity）。勾选后彻底把邪恶候选排除在搜索范围外，逼着看勇者阵营单独
  // 能不能挖出真实、经得住 held-out 检验的正向信号，而不是被邪恶候选"抢跑"掩盖掉。
  const [heroOnly, setHeroOnly] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const ranOnce = useRef(false);
  const timer = useRef(null);
  const runCtrl = useRef(null);

  const canRun = Array.isArray(candidates) && candidates.length > 0 && rows.length > 0;

  const run = async (m = mode) => {
    if (!canRun) return;
    // cancel previous run if any
    if (runCtrl.current) try { runCtrl.current.abort(); } catch (e) {}
    const ac = new AbortController(); runCtrl.current = ac;
    setProgress(null);
    setBusy(true);
    await new Promise(r => setTimeout(r, 0)); // 让 loading 画出来
    try {
      const start = m === 'combo' ? factors : [];
      const scopedCandidates = heroOnly ? candidates.filter(c => c.camp !== 'evil') : candidates;
      const isActive = () => runCtrl.current === ac && !ac.signal.aborted;
      // use workers to pre-evaluate candidate held-out deltas in parallel, then run greedy path on smaller pool
      const pre = await evaluateCandidatesWithWorkers(rows, start, scopedCandidates, {
        concurrency: 4,
        batchSize: 12,
        signal: ac.signal,
        onProgress: ({ completed, total }) => {
          if (isActive()) setProgress({ completed, total });
        },
        threshold, missingPolicy, shape: scoreShape, scoreMode,
      });
      if (!isActive()) return;
      // merge pre results back into candidates (attach deltaTest for quick prefilter)
      const mergedCandidates = scopedCandidates.map(c => {
        const hit = pre.find(p => p.field === c.field && p.camp === c.camp);
        return { ...c, _pre: hit?.result };
      }).filter(c => c._pre && Number.isFinite(c._pre.deltaTest));
      // 主线程直接调用 recommendFactorPath（不经过 worker），可以直接传函数引用；
      // 绑定 winThreshold=threshold，形状对齐 scoreFn(rows,factors,missingPolicy)。
      const scoreFnOpt = { scoreFn: (rowsSet, factorSet, mp) => scorePoolBucketRho(rowsSet, factorSet, mp, threshold) };
      const res = await recommendFactorPath(rows, start, mergedCandidates,
        { threshold, missingPolicy, shape: scoreShape, batchSize: 12, ...scoreFnOpt });
      if (!isActive()) return;
      setResult({ ...res, mode: m });
      ranOnce.current = true;
    } finally {
      if (runCtrl.current === ac) setBusy(false);
    }
  };

  // combo 模式动态：池子变了、且已经算过一次，自动重算（防抖）
  useEffect(() => {
    if (!ranOnce.current || mode !== 'combo' || !canRun) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => run('combo'), 600);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factors]);

  const fmt = v => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(3) : '-');
  const path = result?.path || [];

  // 每一步"打架"处数，之前只能靠人工点每一步再对照散点图紫线才能定位是哪步引入锯齿——
  // 现在 recommendFactorPath 每步都自带 testZigzag/inZigzag，直接导出 markdown 数据定位。
  async function exportPathDiagnosis() {
    if (!path.length) { message.warning('先算出推荐路径再导出'); return; }
    const report = buildRecommendPathReport(path, { threshold });
    try { await navigator.clipboard.writeText(report); message.success('推荐路径分档诊断已复制（markdown），直接粘给 AI 定位打架的那一步即可'); }
    catch { message.error('复制失败'); }
  }

  return (
    <Card size="small" style={{ marginTop: 8 }}
      title={<span>🧭 因子推荐 <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
        （按 held-out 边际分层秩相关 贪心推路径——只推能泛化的，不是样本内好看的）</Typography.Text></span>}
      extra={<Space>
        <Segmented size="small" value={mode}
          onChange={v => { setMode(v); if (ranOnce.current) run(v); }}
          options={[{ label: '组合路径(基于当前池)', value: 'combo' }, { label: '探索全路径(从零)', value: 'explore' }]} />
        <Tooltip title='邪恶阵营候选量通常远大于勇者（"高倍盘"永远是少数类，"输家/红旗"样本天然多得多），贪心搜索一边倒选邪恶不是算法偏心，是数据类别不平衡（详见项目记忆）。勾选后把邪恶候选彻底排除在搜索范围外，逼着看勇者阵营单独能不能挖出真实、经得住held-out检验的正向信号。'>
          <Checkbox checked={heroOnly} onChange={e => { setHeroOnly(e.target.checked); if (ranOnce.current) run(); }}
            style={{ fontSize: 12 }}>只看勇者阵营</Checkbox>
        </Tooltip>
        <Button size="small" type="primary" loading={busy} disabled={!canRun} onClick={() => run()}>算推荐</Button>
      </Space>}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        {mode === 'combo'
          ? <>从<b>当前 {factors.length} 个因子</b>出发，逐步推"下一个加什么最能提升验证段分层秩相关"。加/删因子后自动重算。</>
          : <>忽略当前池，<b>从零</b>贪心建一条最优组合路径，对照"从零最优"和你现在这套。</>}
        {!canRun && <Typography.Text type="warning">先扫描出候选、加载数据再算。</Typography.Text>}
      </Typography.Paragraph>
      {busy && progress && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>预评估候选：{progress.completed}/{progress.total}</div>}

      {result && (() => {
        const metricLabel = '分层秩相关';
        return result.error ? <Alert type="warning" showIcon message={result.error} />
        : path.length === 0
          ? <Alert type="info" showIcon message={mode === 'combo'
              ? `当前池子已经不错——没有候选能让验证段${metricLabel}再明显提升（或都是负贡献）。`
              : `没挖到能提升验证段${metricLabel}的组合。`} />
          : (
            <>
              <Space wrap size={4} style={{ marginBottom: 6 }}>
                {path.map((p, i) => (
                  <React.Fragment key={p.camp + ':' + p.field}>
                    {i > 0 && <span style={{ color: 'var(--text-muted)' }}>→</span>}
                    <Tooltip title={`采用到这一步（把前 ${i + 1} 个都加进池子）　held-out Δ${metricLabel} ${fmt(p.deltaTest)}　样本内 Δ${metricLabel} ${fmt(p.deltaIn)}${p.overfit ? '　⚠️ 样本内涨得多、验证段跟不上，疑似过拟合' : ''}${p.testZigzag ? `　held-out 分档打架 ${p.testZigzag.inversionCount} 处（最大回落 ${(p.testZigzag.worstDrop * 100).toFixed(1)}%）` : ''}`}>
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
                标签数字 = 加进去后<b>验证段</b>{metricLabel}的增量(held-out Δ{metricLabel})；点某一步 = 把它和之前的一起加进池子。
                ⚠️=样本内涨但验证段跟不上(过拟合)，🌀N=held-out 分档命中率打架 N 处（曲线倒挂，秩相关感受不到但眼睛能看出来）。
                别选。（train {result.nTrain}/test {result.nTest}）
              </div>
              <Space size={4} style={{ marginTop: 2 }}>
                <Button size="small" type="link" style={{ paddingLeft: 0 }}
                  onClick={() => onAdopt(path.map(x => ({ field: x.field, camp: x.camp })))}>
                  采用整条路径（{path.length} 个）
                </Button>
                <Button size="small" type="link" onClick={exportPathDiagnosis}>
                  📋 导出分档诊断（喂 AI 定位打架的那一步）
                </Button>
              </Space>
            </>
          );
      })()}
    </Card>
  );
}
