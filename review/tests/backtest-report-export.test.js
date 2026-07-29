import assert from 'node:assert';
import { buildBacktestReport, buildWalkForwardReport, buildBaselineVsTrainReport } from '../src/lib/backtestReportExport.js';

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

  // ---------- buildWalkForwardReport（时间外推验证专属导出，2026-07-28 新增）----------
  const wfOos = {
    trainRatio: 0.7, splits: 2,
    folds: [
      {
        splitIndex: 0, trainSize: 300, testSize: 60, testStart: 1700000000, testEnd: 1700086400,
        train: { base: { n: 300, pos: 40, baseRate: 0.133 } },
        test: { base: { n: 60, pos: 8, baseRate: 0.133 } },
        factorDecay: [
          { field: 'x', camp: 'hero', trainAuc: 0.6, testAuc: 0.55, testN: 60, testPos: 8, aucDrop: 0.05 },
          { field: 'y', camp: 'evil', trainAuc: 0.52, testAuc: 0.7, testN: 60, testPos: 8, aucDrop: -0.18 },
        ],
        skipped: [],
      },
      {
        splitIndex: 1, trainSize: 360, testSize: 60, testStart: 1700086400, testEnd: 1700172800,
        train: { base: { n: 360, pos: 45, baseRate: 0.125 } },
        test: { base: { n: 60, pos: 3, baseRate: 0.05 } },
        factorDecay: [
          { field: 'x', camp: 'hero', trainAuc: 0.6, testAuc: 0.4, testN: 60, testPos: 3, aucDrop: 0.2 },
        ],
        skipped: [{ field: 'z', reason: '样本不足' }],
      },
    ],
  };
  const wfFoldRows = [
    { idx: 0, trainSize: 300, testSize: 60, testStart: 1700000000, testEnd: 1700086400,
      tr: { triggered: 100, hit: 30, hitRate: 0.3, lift: 2.25 },
      te: { triggered: 20, hit: 5, hitRate: 0.25, lift: 1.88 },
      decay: { p: 0.6, decayed: true, significant: false, insufficientN: false } },
    { idx: 1, trainSize: 360, testSize: 60, testStart: 1700086400, testEnd: 1700172800,
      tr: { triggered: 120, hit: 40, hitRate: 0.33, lift: 2.67 },
      te: { triggered: 10, hit: 1, hitRate: 0.1, lift: 2.0 },
      decay: { p: NaN, decayed: true, significant: false, insufficientN: true } },
  ];

  test('buildWalkForwardReport: 包含全部关键小节', () => {
    const r = buildWalkForwardReport(wfOos, wfFoldRows, { cutoff: 60, threshold: 5 });
    for (const h of ['## 1. 切分配置', '## 2. 各段总览', '## 3. 逐段·逐因子归因', '## 4. 给 AI 的诊断清单']) {
      assert.ok(r.includes(h), `缺小节 ${h}`);
    }
  });

  test('buildWalkForwardReport: 每段的关键数值应该落进报告，包括testN/testPos这类判断可信度的数字', () => {
    const r = buildWalkForwardReport(wfOos, wfFoldRows, { cutoff: 60, threshold: 5 });
    assert.ok(r.includes('#1') && r.includes('#2'), '两段都应出现');
    assert.ok(r.includes('样本不足，不下结论'), '第2段触发数<5，应标样本不足');
    assert.ok(r.includes('x') && r.includes('0.600') && r.includes('0.550'), '因子归因：字段与train/test AUC');
    assert.ok(r.includes('60（8）') || r.includes('（8）'), 'test样本量(正类数)应带出来，供判断AUC可信度');
    assert.ok(r.includes('样本不足') && r.includes('z'), '跳过字段说明应带出来');
  });

  test('buildWalkForwardReport: 无 oos 或 oos.error 时给占位不抛异常', () => {
    assert.doesNotThrow(() => buildWalkForwardReport(null, null, { cutoff: 60, threshold: 5 }));
    const r = buildWalkForwardReport({ error: '样本太少' }, null, { cutoff: 60, threshold: 5 });
    assert.ok(r.includes('样本太少'));
  });

  test('buildWalkForwardReport: 某段训练失败(f.error)时该段应给出失败原因而不是崩溃', () => {
    const oosWithFail = { trainRatio: 0.7, splits: 1,
      folds: [{ splitIndex: 0, error: '训练段推导不出任何有效因子', trainSize: 300, testSize: 60 }] };
    const foldRowsWithFail = [{ idx: 0, error: '训练段推导不出任何有效因子', trainSize: 300, testSize: 60 }];
    const r = buildWalkForwardReport(oosWithFail, foldRowsWithFail, { cutoff: 60, threshold: 5 });
    assert.ok(r.includes('训练段推导不出任何有效因子'));
  });

  // ---------- buildBaselineVsTrainReport（基线库 vs 训练集按天 对比导出，2026-07-28 新增）----------
  const bvtResult = {
    baseline: { n: 300, cut: 0, triggered: 300, hit: 90, hitRate: 0.3, capture: 1, lift: 1.5 },
    groups: [
      { label: '2026-07-01', n: 60, cut: 0, triggered: 60, hit: 3, hitRate: 0.05, capture: 1, lift: 0.25,
        decay: { p: 0.001, decayed: true, significant: true, insufficientN: false } },
      { label: '2026-07-02', n: 60, cut: 0, triggered: 60, hit: 18, hitRate: 0.3, capture: 1, lift: 1.5,
        decay: { p: 0.98, decayed: false, significant: false, insufficientN: false } },
      { label: '2026-07-03', n: 0, error: '无样本' },
    ],
  };

  test('buildBaselineVsTrainReport: 基准库整体 + 每天一行都应出现在报告里', () => {
    const r = buildBaselineVsTrainReport(bvtResult, { cutoff: 0, threshold: 5 });
    assert.ok(r.includes('基准库'), '应有基准库小节');
    assert.ok(r.includes('2026-07-01') && r.includes('2026-07-02') && r.includes('2026-07-03'), '三天都应出现');
    assert.ok(r.includes('⚠️显著偏离'), '显著偏离那天应标出来');
    assert.ok(r.includes('无样本'), '无样本那天应给出原因而不是空白');
  });

  // 2026-07-28 真实数据实测发现：归类库有多个策略时，按天对比如果不按策略收窄范围，会把不同
  // 策略同一天的样本混到一起——报告里应该明确写出这次对比收窄到了哪个策略，避免误读成"全站数据"。
  test('buildBaselineVsTrainReport: 传入 strategyName 时应在报告里明确标出对比范围已收窄到该策略', () => {
    const r = buildBaselineVsTrainReport(bvtResult, { cutoff: 0, threshold: 5, strategyName: '强势盘策略' });
    assert.ok(r.includes('强势盘策略'), '应写明对比的是哪个策略');
    assert.ok(r.includes('收窄'), '应说明这是收窄到单策略的范围，不是跨策略汇总');
  });

  test('buildBaselineVsTrainReport: 无结果或 result.error 时给占位不抛异常', () => {
    assert.doesNotThrow(() => buildBaselineVsTrainReport(null, { cutoff: 0, threshold: 5 }));
    const r = buildBaselineVsTrainReport({ error: '基准库没有样本' }, { cutoff: 0, threshold: 5 });
    assert.ok(r.includes('基准库没有样本'));
  });
}
