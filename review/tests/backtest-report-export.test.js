import assert from 'node:assert';
import { buildBacktestReport } from '../src/lib/backtestReportExport.js';

const input = {
  config: { sampleN: 422, threshold: 5, cutoff: 80, missingPolicy: 'zero', scoreShape: 'trap', fieldScope: 'original' },
  base: { n: 422, pos: 51, baseRate: 0.121, wilson: { lo: 0.09, hi: 0.15 } },
  factors: [
    { field: 'shit_volume', camp: 'hero', weight: 17.6, lo0: -Infinity, lo1: -Infinity, hi1: 0, hi0: 1.487, auc: 0.599, missRate: 0 },
    { field: 'gmgn.stat.top_10_holder_rate', camp: 'hero', weight: 25.2, lo0: 11.28, lo1: 19.88, hi1: Infinity, hi0: Infinity, auc: 0.528, missRate: 0 },
  ],
  corr: [{ a: 'shit_volume', b: 'gmgn.stat.top_10_holder_rate', rho: 0.18, n: 400 }],
  rhoOpt: { rhoTrainBefore: 0.256, rhoTrainAfter: 0.287, rhoTestBefore: 0.126, rhoTestAfter: 0.156, nTrain: 295, nTest: 127, zeroedFields: [] },
  current: { triggered: 185, hitRate: 0.195, capture: 0.706, lift: 1.61 },
  sweep: [{ cut: 80, triggered: 185, hitRate: 0.195, capture: 0.706, lift: 1.61 }],
  deciles: [{ bin: 1, scoreLo: 15.8, scoreHi: 46.2, n: 42, pos: 0, hiRate: 0, wilson: { lo: 0, hi: 0.084 }, avgRet: 1.55, medRet: 1.32 }],
  oos: { trainSize: 295, testSize: 127, skipped: [], train: { triggered: 99, hitRate: 0.172, capture: 0.548, lift: 1.63 }, test: { triggered: 53, hitRate: 0.17, capture: 0.45, lift: 1.08 } },
  missed: [{ ca: 'HONEYxxx', symbol: 'HONEY', score: 78.6, ret: 24.9 }],
};

export function run(test) {
  test('buildBacktestReport: 包含全部关键小节', () => {
    const r = buildBacktestReport(input);
    for (const h of ['## 1. 配置', '## 2. 因子池', '## 3. 去冗余', '## 4. 北极星',
      '## 5. 当前 cutoff', '## 6. Cutoff 扫描', '## 7. 分段表', '## 8. 时间外推验证',
      '## 9. 漏网之鱼', '## 10. 给 AI 的诊断清单']) {
      assert.ok(r.includes(h), `缺小节 ${h}`);
    }
  });

  test('buildBacktestReport: 关键数值/字段落进报告', () => {
    const r = buildBacktestReport(input);
    assert.ok(r.includes('shit_volume') && r.includes('0.599'), '因子与 AUC');
    assert.ok(r.includes('1.61'), '当前 lift');
    assert.ok(r.includes('1.63') && r.includes('1.08'), 'OOS train/val lift');
    assert.ok(r.includes('-∞') && r.includes('∞'), '无穷边界格式化');
    assert.ok(r.includes('HONEY'), '漏网之鱼');
  });

  test('buildBacktestReport: OOS 落差大应提示过拟合', () => {
    const r = buildBacktestReport(input); // 1.63→1.08，1.08 < 1.63*0.6=0.978? 否；落差0.55>0.3
    assert.ok(r.includes('落差偏大') || r.includes('疑似过拟合'), '应给过拟合提示');
  });

  test('buildBacktestReport: 缺 oos/rhoOpt 时不报错、给占位', () => {
    const r = buildBacktestReport({ ...input, oos: null, rhoOpt: null });
    assert.ok(r.includes('未跑时间外推验证'));
    assert.ok(r.includes('无 ρ 数据'));
  });

  test('buildBacktestReport: 空输入也不抛异常', () => {
    assert.doesNotThrow(() => buildBacktestReport({}));
    assert.doesNotThrow(() => buildBacktestReport());
  });
}
