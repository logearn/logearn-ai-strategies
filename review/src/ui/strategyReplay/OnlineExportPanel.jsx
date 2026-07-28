import React, { useState } from 'react';
import { Card, Button, Table, Alert, Typography, Input, Space, Tag, message } from 'antd';
import { exportWithVerify, generateOnlineCode } from '../../lib/onlineExport.js';

// 「生成上线代码」面板：把策略里的 f('字段') 翻译成【纯 native ctx 代码】直接贴到线上跑。
// - 直接字段 → 内联 __Vp('ctx路径', 倍率)（gmgn 占比字段 ×100）；
// - 派生字段 → 把计算逻辑内联进代码（__D 预算块）；
// - 无 f、无垫片。全直接字段的池子 = 零派生块。
// - 一致性自检：拿当前样本用 native 取值逐字段跟 review 的 getFeature 比对，红字定位不一致。
// 需要加载数据（路径解析要 rawCtx）。逻辑全部在 lib/onlineExport.js，这里只做交互与展示。
export default function OnlineExportPanel({ src, rows }) {
  const [result, setResult] = useState(null); // exportWithVerify 的返回

  const hasCode = src && src.trim();
  const hasRows = Array.isArray(rows) && rows.length > 0;

  const onGenerate = () => {
    if (!hasCode) { message.warning('策略代码为空'); return; }
    if (!hasRows) { message.warning('需要先加载数据——把 f(\'字段\') 解析成 ctx 路径要靠样本核对'); return; }
    try {
      const out = exportWithVerify(src, rows);
      setResult(out);
      if (out.unresolved.length) message.error(`${out.unresolved.length} 个字段无法映射回 ctx（见下表），这些因子上线会失效`);
      else if (!out.report.ok) message.error('自检发现口径不一致，请看下方标红字段');
      else message.success(`native 代码已生成，自检通过（${out.report.rowsChecked} 条样本）`);
    } catch (e) {
      message.error('生成失败：' + e.message);
      setResult(null);
    }
  };

  const onCopy = async () => {
    if (!result) return;
    try { await navigator.clipboard.writeText(result.code); message.success('已复制到剪贴板'); }
    catch { message.error('复制失败，请手动从下方文本框选择'); }
  };

  const onDownload = () => {
    if (!result) return;
    const blob = new Blob([result.code], { type: 'text/javascript;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'strategy-online.js';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const report = result?.report;
  const problemFields = report ? report.fields.filter(f => f.status === 'mismatch' || f.status === 'missing_online') : [];
  const nonnumFields = report ? report.fields.filter(f => f.status === 'nonnumeric') : [];
  const okCount = report ? report.fields.filter(f => f.status === 'ok').length : 0;

  const fmt = v => (v == null ? '缺失' : (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toPrecision(6)) : String(v)));

  const columns = [
    { title: '字段', dataIndex: 'field', key: 'field', render: t => <code style={{ fontSize: 12 }}>{t}</code> },
    { title: '类型', dataIndex: 'kind', key: 'kind', render: k =>
        k === 'direct' ? <Tag>直接</Tag> : k === 'derived' ? <Tag color="geekblue">派生</Tag> : <Tag color="error">无法解析</Tag> },
    { title: '状态', dataIndex: 'status', key: 'status', render: s =>
        s === 'mismatch' ? <Tag color="error">数值不一致</Tag>
        : s === 'missing_online' ? <Tag color="error">线上取不到</Tag>
        : <Tag color="warning">非数值·跳过</Tag> },
    { title: 'review 值', key: 'review', render: (_, r) => <span>{fmt(r.sample?.review)}</span> },
    { title: '线上值', key: 'online', render: (_, r) => <span>{fmt(r.sample?.online)}</span> },
    { title: '相对偏差', key: 'rel', render: (_, r) => (Number.isFinite(r.maxRel) ? r.maxRel.toExponential(2) : '—') },
    { title: '样本', key: 'tok', render: (_, r) => <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.sample?.tokenAddress || '—'}</span> },
  ];

  const preview = (hasCode && hasRows) ? generateOnlineCode(src, rows) : null;
  const directN = preview ? preview.direct.length : 0;
  const derivedN = preview ? preview.derived.length : 0;
  const unresolvedN = preview ? preview.unresolved.length : 0;

  return (
    <Card size="small" style={{ marginTop: 8 }}
      title={<span>📦 生成上线代码 <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
        （把 f('字段') 翻译成纯 native ctx 代码，无 f、无垫片，直接贴到线上跑）</Typography.Text></span>}
      extra={<Button size="small" type="primary" onClick={onGenerate} disabled={!hasCode || !hasRows}>生成并校验</Button>}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        {preview
          ? <>本策略用到 <b>{directN}</b> 个直接字段（内联 <code>ctx</code> 取值）
              {derivedN > 0 && <>、<b>{derivedN}</b> 个派生字段（计算逻辑内联）</>}
              {unresolvedN > 0 && <>、<Typography.Text type="danger"><b>{unresolvedN}</b> 个无法映射回 ctx</Typography.Text></>}。
              {derivedN === 0 && unresolvedN === 0 && <>全是直接字段 → 生成的是纯 native 代码，零派生块。</>}
            </>
          : (!hasCode ? '先在上方编辑/发送策略代码。'
             : <Typography.Text type="warning">未加载数据——native 生成要靠样本核对 ctx 路径，请先加载数据。</Typography.Text>)}
      </Typography.Paragraph>

      {result && (
        <>
          {result.unresolved.length > 0 && (
            <Alert type="error" showIcon style={{ marginBottom: 8 }}
              message={<span style={{ fontSize: 12 }}>⚠️ {result.unresolved.length} 个字段无法映射回 ctx，上线会当缺失（0 分）：
                {result.unresolved.map(u => <code key={u.field} style={{ fontSize: 11, marginLeft: 4 }}>{u.field}</code>)}
                <br />——多半是派生字段但 onlineExport 里还没有对应计算块，或字段名对不上。别直接上线，先处理这些。</span>} />
          )}
          {report && report.ok && result.unresolved.length === 0 ? (
            <Alert type="success" showIcon style={{ marginBottom: 8 }}
              message={<span style={{ fontSize: 12 }}>
                ✓ 一致性自检通过：{okCount} 个字段在 {report.rowsChecked} 条样本上与 review 口径完全一致（native 算的 = 回测口径）
                {nonnumFields.length > 0 && <>；另有 {nonnumFields.length} 个非数值字段已跳过</>}。
              </span>} />
          ) : report && !report.ok && result.unresolved.length === 0 ? (
            <Alert type="error" showIcon style={{ marginBottom: 8 }}
              message={<span style={{ fontSize: 12 }}>⚠️ 自检发现 {problemFields.length} 个字段口径不一致——native 取值与 review 特征层不符，<b>不要直接上线</b>。</span>} />
          ) : null}

          {(problemFields.length > 0 || nonnumFields.length > 0) && (
            <Table size="small" rowKey="field" pagination={false} style={{ marginBottom: 8 }}
              columns={columns} dataSource={[...problemFields, ...nonnumFields]} />
          )}

          <Space style={{ marginBottom: 6 }}>
            <Button size="small" type="primary" onClick={onCopy}>复制上线代码</Button>
            <Button size="small" onClick={onDownload}>下载 .js</Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {result.code.split('\n').length} 行 · {result.direct.length} 直接 / {result.derived.length} 派生
            </Typography.Text>
          </Space>
          <Input.TextArea value={result.code} readOnly rows={12} spellCheck={false}
            style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }} />
        </>
      )}
    </Card>
  );
}
