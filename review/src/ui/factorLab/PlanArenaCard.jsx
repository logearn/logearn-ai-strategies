import React, { useMemo, useRef, useState } from 'react';
import { Card, Button, Space, Table, Tag, Alert, Typography, Tooltip, Progress, Checkbox } from 'antd';
import { runRecommendInWorker } from './workerPool.js';
import { compareRecommendPlans, DEFAULT_PLANS, normalizeCampFields } from '../../lib/fullFieldRecommend.js';

// 「方案擂台」：把几种"候选池 × 搜索策略"的组合在同一份数据上各跑一遍，纵向摆开比。
// 存在的理由：候选池扩大（全字段）和搜索加强（beam/后向/闸门）各自贡献多少，分成两张卡各跑各的
// 是看不出来的——每张卡只给自己那一个数字，跨卡比还得人肉记上一次是多少。
//
// 排名口径（跟 lib 里 compareRecommendPlans 的注释同一份，改一处要改两处）：
// 主键是 **K折曲线在 k* 处的 test ρ**，不是"精配权后的全样本 ρ"。后者在全样本上配权、又在全样本上
// 打分，方案越激进（池子越大、beam 越宽）越虚高，拿它排名等于奖励过拟合。
export default function PlanArenaCard({ rows, fields, candidates, factors, threshold, missingPolicy,
  scoreShape, maxMissRate = 100, blacklist = [], onAdoptFactors }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [note, setNote] = useState('');
  const [useCurrentPool, setUseCurrentPool] = useState(false);
  const runCtrl = useRef(null);

  // fields 跟全字段贪心那张卡同一个形态（{ hero, evil } 两份已剔过「移除」的名单），
  // full 系方案能不能跑看的是并集非空。
  const fullFieldCount = useMemo(() => {
    const c = normalizeCampFields(fields);
    return new Set([...c.hero, ...c.evil]).size;
  }, [fields]);
  const canRun = rows.length > 0 && (fullFieldCount > 0 || (candidates || []).length > 0);

  const run = async () => {
    if (!canRun) return;
    if (runCtrl.current) try { runCtrl.current.abort(); } catch (e) {}
    const ac = new AbortController(); runCtrl.current = ac;
    setBusy(true); setPct(0); setNote('');
    await new Promise(r => setTimeout(r, 0));
    try {
      const opts = {
        threshold, missingPolicy, shape: scoreShape,
        startFactors: useCurrentPool ? factors : [],
        blacklist: (blacklist || []).map(b => ({ camp: b.camp, field: b.field })),
        maxMissRate: maxMissRate / 100,
      };
      const payload = { rows, fields, candidates, plans: DEFAULT_PLANS, opts };
      let res;
      try {
        res = await runRecommendInWorker('comparePlans', payload, {
          signal: ac.signal,
          onProgress: (p, n) => { if (runCtrl.current === ac) { setPct(p); setNote(n || ''); } },
        });
      } catch (e) {
        if (ac.signal.aborted) return;
        res = compareRecommendPlans(rows, { ...opts, fields, candidates, plans: DEFAULT_PLANS });
      }
      if (runCtrl.current !== ac || ac.signal.aborted) return;
      setResult(res);
    } finally {
      if (runCtrl.current === ac) { setBusy(false); setPct(0); setNote(''); }
    }
  };

  const fmt = (v, d = 3) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) : '—');
  const bestKey = result?.best?.key;

  const columns = [
    { title: '', width: 44, align: 'center', render: (_, r) => (
      r.key === bestKey ? <Tooltip title="按 k* 处的 K折 test ρ 排第一">🏆</Tooltip>
        : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{r.rank}</span>) },
    { title: '方案', dataIndex: 'name', width: 190, render: (v, r) => (
      <Space size={4}>
        <Tag color={r.pool === 'full' ? 'purple' : 'default'} style={{ margin: 0, fontSize: 11 }}>
          {r.pool === 'full' ? '全字段' : '候选表'}</Tag>
        <span style={{ fontSize: 12 }}>{v.replace(/^(候选表|全字段) · /, '')}</span>
      </Space>) },
    { title: <Tooltip title="K折验证曲线在 1-SE 最省因子数 k* 处的 test ρ。每折重推边界+重配权、按 token 分组分折、已砍掉过拟合尾巴——这几个数里唯一跨方案可比的，排名就按它。">
        <b>k* 处 K折 ρ</b></Tooltip>, width: 120, align: 'right',
      render: (_, r) => <b style={{ color: r.key === bestKey ? '#ff9f0a' : undefined }}>{fmt(r.kStarRho)}</b> },
    { title: <Tooltip title="K折曲线的峰值 test ρ（可能在 k* 之后取得，那一段属于过拟合尾巴）">K折峰值</Tooltip>,
      width: 90, align: 'right', render: (_, r) => <span style={{ color: 'var(--text-muted)' }}>{fmt(r.kBestRho)}</span> },
    { title: <Tooltip title="影子权重（只用 train 拟合、对 test 全盲）在 test 上的 ρ。单次切分，方差比 K折 大，当次选参考。">影子 test ρ</Tooltip>,
      width: 105, align: 'right', render: (_, r) => (
        <span>{fmt(r.rhoTest)}{r.overfit && <Tooltip title="test 明显低于 train（<40%）"> ⚠️</Tooltip>}</span>) },
    { title: <Tooltip title="全样本精配权后的 ρ。在全样本上配权又在全样本上打分，方案越激进越虚高——【不要】拿这个排名，只看趋势。">全样本 ρ</Tooltip>,
      width: 95, align: 'right', render: (_, r) => <span style={{ color: 'var(--text-muted)' }}>{fmt(r.rhoAfter)}</span> },
    { title: <Tooltip title="k* / 贪心选出的总数。括号里是被 K折 判为过拟合尾巴、建议砍掉的个数。">因子数</Tooltip>,
      width: 95, align: 'right', render: (_, r) => (
        r.error ? '—' : <span>{r.kStar ?? r.factorCount}<span style={{ color: 'var(--text-muted)' }}> / {r.factorCount}</span></span>) },
    { title: <Tooltip title="最后一步 held-out 分档命中率的倒挂处数。ρ 感受不到，但眼睛能看出来——同样的 ρ，倒挂少的那个更可用。">倒挂</Tooltip>,
      width: 70, align: 'right', render: (_, r) => (
        r.zigzag == null ? '—' : <span style={{ color: r.zigzag > 0 ? '#ff9f0a' : 'var(--text-muted)' }}>
          {r.zigzag > 0 ? `🌀${r.zigzag}` : '0'}</span>) },
    { title: '耗时', width: 75, align: 'right',
      render: (_, r) => <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{(r.ms / 1000).toFixed(1)}s</span> },
    { title: '', width: 80, render: (_, r) => (
      r.factors && r.factors.length
        ? <Button size="small" type={r.key === bestKey ? 'primary' : 'default'}
            onClick={() => onAdoptFactors?.(r.factors)}>采用</Button>
        : null) },
  ];

  return (
    <Card size="small" style={{ marginTop: 8 }}
      title={<span>🏆 方案擂台 <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
        （{DEFAULT_PLANS.length} 种候选池×搜索策略同场跑，按 k* 处 K折 ρ 排名）</Typography.Text></span>}
      extra={<Space>
        <Tooltip title="勾上=每个方案都从当前因子池出发只找新增；不勾=全部从零探索（横向可比性更好）。">
          <Checkbox checked={useCurrentPool} onChange={e => setUseCurrentPool(e.target.checked)}
            style={{ fontSize: 12 }}>基于当前池</Checkbox>
        </Tooltip>
        <Button size="small" type="primary" loading={busy} disabled={!canRun} onClick={run}>开跑</Button>
      </Space>}>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        一次跑完，横向对比「候选池扩大」和「搜索加强」各自贡献多少。<b>全字段扫描只做一次</b>，
        三个全字段方案共用。排名按 <b>k* 处的 K折 test ρ</b>——它是这几个数里唯一每折重推边界+重配权、
        按 token 分组分折、还砍掉了过拟合尾巴的，跨方案可比；
        「全样本 ρ」越激进的方案越虚高，<b>不要拿它排名</b>。
        耗时提示：beam=5 的一档约是单路径的 5 倍，全套跑完可能要几十秒到几分钟。
      </Typography.Paragraph>

      {busy && <Progress percent={pct} size="small" status="active"
        format={p => `${p}%${note ? ' · ' + note : ''}`} style={{ marginBottom: 8 }} />}

      {result && (
        <>
          <Table size="small" rowKey="key" pagination={false}
            dataSource={result.ranked} columns={columns}
            rowClassName={r => (r.key === bestKey ? 'arena-best' : '')}
            scroll={{ x: 980 }} />
          {result.rows.some(r => r.error) && (
            <Alert style={{ marginTop: 8 }} type="info" showIcon
              message={<span style={{ fontSize: 12 }}>
                有方案没跑出结果：{result.rows.filter(r => r.error).map(r => `${r.name}（${r.error}）`).join('；')}
              </span>} />
          )}
          {result.best?.scanStats && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
              全字段扫描：{result.best.scanStats.scannedCount} 个字段 → {result.best.scanStats.candidateCount} 个候选
              （勇者 {result.best.scanStats.heroCount} / 邪恶 {result.best.scanStats.evilCount}）。
              候选表那份：{(candidates || []).length} 个。
            </div>
          )}
        </>
      )}
    </Card>
  );
}
