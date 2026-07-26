import React from 'react';
import { Card, Statistic, Row, Col, Alert, Button, Space } from 'antd';
import { buildSummary, dedupPerToken } from '../lib/summary.js';

export default function SummaryPanel({ activeRows, allRows, onDedup }) {
  const s = buildSummary(activeRows, allRows);
  return (
    <Card size="small" title="总览统计"
      extra={s.filtered ? <span style={{ fontSize: 12, opacity: .65 }}>已应用全局过滤，原始 {s.total} 条</span> : null}>
      <Row gutter={[16, 16]}>
        {s.tiles.map(t => (
          <Col key={t.label} xs={12} sm={8} md={6} lg={4}>
            <Statistic title={<span title={t.tip || ''}>{t.label}</span>} value={t.value}
              valueStyle={t.accent ? { color: '#0a84ff' } : undefined} />
          </Col>
        ))}
      </Row>
      {s.warnings.map((w, i) => (
        <Alert key={i} type="warning" showIcon style={{ marginTop: 12 }}
          message={
            <Space wrap size={8}>
              <span>{w.text}</span>
              {w.canDedup && onDedup && (
                <Button size="small" onClick={() => onDedup(dedupPerToken(activeRows))}>
                  每 token 只保留首条信号
                </Button>
              )}
            </Space>
          } />
      ))}
    </Card>
  );
}
