import React, { useState } from 'react';
import { Card, Upload, Button, Space, Table, Alert, Typography } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { compareGroups } from '../lib/compare.js';
import { buildRows, readJson } from '../lib/data.js';

const pct = v => (v * 100).toFixed(1) + '%';

export default function ComparePanel({ activeRows }) {
  const [callsFile, setCallsFile] = useState(null);
  const [snapsFile, setSnapsFile] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function loadOther() {
    if (!callsFile || !snapsFile) { setErr('请选择对照组的两个 JSON'); return; }
    setBusy(true); setErr('');
    try {
      const [calls, snapshots] = await Promise.all([readJson(callsFile), readJson(snapsFile)]);
      const rows = await buildRows(calls, snapshots);
      setResult(compareGroups(activeRows, rows, { labelA: '当前数据源', labelB: '对照组' }));
    } catch (e) { setErr('加载失败：' + (e?.message || e)); }
    finally { setBusy(false); }
  }

  const rowsData = result && !result.error ? [
    { key: 'med', 指标: '中位数', a: result.medianA.toFixed(3) + 'x', b: result.medianB.toFixed(3) + 'x',
      diff: (result.medianDiff > 0 ? '+' : '') + result.medianDiff.toFixed(3), good: result.medianDiff > 0, p: null },
    { key: 'mean', 指标: '均值（右尾主导，仅供参考）', a: result.meanA.toFixed(3) + 'x', b: result.meanB.toFixed(3) + 'x',
      diff: (result.meanB - result.meanA).toFixed(3), p: null },
    { key: 'max', 指标: '最大倍数', a: result.maxA.toFixed(2) + 'x', b: result.maxB.toFixed(2) + 'x',
      diff: (result.maxB - result.maxA).toFixed(2), p: null },
    ...result.rates.map(r => ({
      key: 't' + r.threshold, 指标: `胜率 >${r.threshold}x`,
      a: `${pct(r.pA)}　[${pct(r.ciA.lo)}~${pct(r.ciA.hi)}]`,
      b: `${pct(r.pB)}　[${pct(r.ciB.lo)}~${pct(r.ciB.hi)}]`,
      diff: (r.diff > 0 ? '+' : '') + pct(r.diff), good: r.diff > 0, bad: r.diff < 0,
      p: Number.isFinite(r.p) ? r.p.toFixed(3) : '-',
    })),
  ] : [];

  const columns = [
    { title: '指标', dataIndex: '指标', width: 200 },
    { title: result ? `${result.labelA}（n=${result.nA}）` : 'A', dataIndex: 'a', align: 'right', width: 210 },
    { title: result ? `${result.labelB}（n=${result.nB}）` : 'B', dataIndex: 'b', align: 'right', width: 210 },
    { title: '差异', dataIndex: 'diff', align: 'right', width: 110,
      render: (v, r) => <span style={{ color: r.good ? '#30d158' : r.bad ? '#ff453a' : undefined }}>{v}</span> },
    { title: 'p', dataIndex: 'p', align: 'right', width: 80, render: v => v ?? '—' },
  ];

  return (
    <Card size="small" title="批量对比"
      extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>
        不做均值 t 检验——收益是极端右尾分布，少数几个 50x 就能主导均值
      </Typography.Text>}>
      <Space wrap size={24} align="start">
        <Upload beforeUpload={f => { setCallsFile(f); return false; }} maxCount={1} accept=".json"
          fileList={callsFile ? [{ uid: '1', name: callsFile.name }] : []} onRemove={() => setCallsFile(null)}>
          <Button icon={<UploadOutlined />}>对照组 calls</Button>
        </Upload>
        <Upload beforeUpload={f => { setSnapsFile(f); return false; }} maxCount={1} accept=".json"
          fileList={snapsFile ? [{ uid: '1', name: snapsFile.name }] : []} onRemove={() => setSnapsFile(null)}>
          <Button icon={<UploadOutlined />}>对照组 snapshots</Button>
        </Upload>
        <Button type="primary" loading={busy} onClick={loadOther} disabled={!activeRows.length}>载入并对比</Button>
      </Space>
      {err && <Alert style={{ marginTop: 12 }} type="error" showIcon message={err} />}
      {result?.error && <Alert style={{ marginTop: 12 }} type="warning" showIcon message={result.error} />}
      {result && !result.error && (
        <>
          {result.underpowered && (
            <Alert style={{ margin: '12px 0' }} type="warning" showIcon
              message={<>以当前样本量（{result.nA} vs {result.nB} 条），能可靠检出的最小胜率差约为 <b>{pct(result.mde)}</b>，
                而实际观察到的最大差异还不到这个数。也就是说<b>这个样本量看不出两组的区别</b>——
                下面的数字更可能是噪声，不要据此判断策略改好了还是改差了。</>} />
          )}
          <Table style={{ marginTop: 12 }} size="small" columns={columns} dataSource={rowsData} pagination={false} />
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
            方括号里是 Wilson 95% 置信区间。两组区间大幅重叠时，即使中间的点估计差得多，也说不上谁更好。
          </Typography.Text>
        </>
      )}
    </Card>
  );
}
