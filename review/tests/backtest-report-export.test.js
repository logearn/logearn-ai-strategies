import assert from 'node:assert';
import { buildBacktestReport, buildWalkForwardReport, buildBaselineVsTrainReport,
  buildRecommendPathReport } from '../src/lib/backtestReportExport.js';
import { backtestFactors } from '../src/lib/factorLab.js';

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
  // ---------- 第 4 节：北极星必须无条件出 ----------
  // 回归的是这个缺口：三种配权都要点按钮才有数，都没点时第 4 节只剩三行"未跑"，
  // 于是"当前这套权重此刻几分"从来没进过报告，诊断只能靠 lift@cutoff 反推。
  const northStar = { rho: 0.234, n: 728, tieScore: 0.1, tieN: 145, tieRatio: 145 / 728, distinct: 402 };

  test('buildBacktestReport: 没跑任何配权时，北极星 ρ 仍要出现在第 4 节', () => {
    const r = buildBacktestReport({ ...input, rhoOpt: null, northStar });
    assert.ok(r.includes('0.234'), '当前因子池原样打分的 ρ 要落进报告');
    assert.ok(r.includes('未跑「按 ρ 最优配权」'), '"没优化过"这件事仍要说明，不能被北极星顶掉');
  });

  test('buildBacktestReport: 同分饱和给出块大小/占比/不同分值个数', () => {
    const r = buildBacktestReport({ ...input, northStar });
    assert.ok(r.includes('145'), '最大同分块样本数');
    assert.ok(r.includes('19.9%'), '同分块占比');
    assert.ok(r.includes('402'), '不同分值个数');
    assert.ok(r.includes('⚠️'), '占比 ≥10% 要给警告');
  });

  test('buildBacktestReport: 同分块占比低于 10% 时不报警', () => {
    const r = buildBacktestReport({ ...input,
      northStar: { ...northStar, tieN: 20, tieRatio: 20 / 728 } });
    assert.ok(r.includes('同分饱和'), '这一行照常出');
    assert.ok(!r.includes('⚠️'), '占比小就不该加警告');
  });

  test('buildBacktestReport: 没有 northStar 时不崩、也不硬造数字', () => {
    const r = buildBacktestReport({ ...input, northStar: undefined });
    assert.ok(r.includes('## 4. 北极星'));
    // 断言的是【数据行】不出现，不能断言 '同分饱和' 四个字——第 10 节诊断清单里也提到了它
    assert.ok(!r.includes('个不同分值'), '没有 northStar 就不该出同分饱和的数据行');
  });

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

  // 第 8 节同样的坑：阈值失效时 lift 两侧都≈1.00、落差必然 0.00，旧版会照常打出
  // "落差小，泛化较好"——那是把"没测到"说成了"泛化好"，必须换成明确的无效声明。
  test('buildBacktestReport: 第8节 cutoff 失效时不能输出「泛化较好」，要声明本节无效', () => {
    const r = buildBacktestReport({ ...input, oos: { ...input.oos,
      cutoff: -58, cutoffSource: 'train', weightSource: 'auto', inert: { frac: 0.997, inert: true },
      train: { triggered: 294, hitRate: 0.133, capture: 1, lift: 1.0 },
      test: { triggered: 127, hitRate: 0.064, capture: 1, lift: 1.0 } } });
    assert.ok(!r.includes('泛化较好'), '失效时绝不能输出"泛化较好"');
    assert.ok(r.includes('本节无效'), '要明确声明本节结论不成立');
    assert.ok(r.includes('99.7%'), '要给出训练段触发率');
  });

  test('buildBacktestReport: 第8节应标明 cutoff 是该段训出来的、跟全样本 cutoff 不可比', () => {
    const r = buildBacktestReport({ ...input, oos: { ...input.oos,
      cutoff: -58, cutoffSource: 'train', weightSource: 'pool', inert: { frac: 0.4, inert: false } } });
    assert.ok(r.includes('本节 cutoff = **-58**'), '要显示该段自己的 cutoff');
    assert.ok(r.includes('触发数@-58'), '表格标签也要用该段 cutoff，不是全样本那个');
    assert.ok(r.includes('沿用因子池现有权重'), 'keepWeights 口径要写清楚');
    assert.ok(r.includes('两套分数不同源'), '要提醒不可跟第5/6节比大小');
    assert.ok(r.includes('train→val lift 落差'), '没失效时照常走正常的落差结论分支');
    assert.ok(!r.includes('本节无效'), '没失效就不该声明无效');
  });

  test('buildBacktestReport: 旧版 oos（没有 cutoff 字段）应退回全样本 cutoff 且不凭空报警', () => {
    const r = buildBacktestReport({ ...input, northStar: { ...northStar, tieN: 20, tieRatio: 20 / 728 } });
    assert.ok(r.includes('触发数@80'), '缺 cutoff 时退回 config.cutoff');
    assert.ok(!r.includes('本节 cutoff'), '旧版数据不打这段说明');
    assert.ok(!r.includes('⚠️'), '不该凭空报警');
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

  // 2026-07-29：cutoff 改成每段各自在训练段上定，报告必须把这件事和"阈值失效"说清楚——
  // 回归的是这个真实缺口：以前各段套的是全样本 cutoff，重新配权后阈值放行了 99% 的训练样本，
  // 命中率退化成基准高倍率、lift 恒 1.00，报告却照常输出"未衰减/落差小，泛化较好"。
  test('buildWalkForwardReport: 每段的 cutoff 与来源应落进报告，并声明与全样本 cutoff 不可比', () => {
    const rows = wfFoldRows.map((r, i) => ({ ...r, cutoff: i === 0 ? 12 : -34, cutoffSource: i === 0 ? 'train' : 'fallback' }));
    const r = buildWalkForwardReport(wfOos, rows, { cutoff: 60, threshold: 5 });
    assert.ok(r.includes('该段cutoff'), '应有「该段cutoff」列');
    assert.ok(r.includes('12') && r.includes('-34'), '两段各自的 cutoff 都要出现');
    assert.ok(r.includes('⚠兜底'), '定不出阈值退回全样本 cutoff 的段要标出来');
    assert.ok(r.includes('不是页面上那个全样本 cutoff=60'), '必须声明跟全样本 cutoff 不同源');
  });

  // 第 4 节「给 AI 的诊断清单」是固定文案、本来就提到"阈值失效"/"未衰减"这些词，
  // 断言整篇会被它污染——只截第 2 节（各段总览表）来断言实际判定。
  const section2 = r => r.split('## 3.')[0];

  test('buildWalkForwardReport: 阈值失效的段判定要换成「无意义」，不能输出未衰减', () => {
    const rows = [
      { ...wfFoldRows[0], cutoff: 12, cutoffSource: 'train', inert: { frac: 0.99, inert: true },
        decay: { p: 0.6, decayed: false, significant: false, insufficientN: false } },
      { ...wfFoldRows[1], cutoff: 8, cutoffSource: 'train', inert: { frac: 0.4, inert: false } },
    ];
    const s = section2(buildWalkForwardReport(wfOos, rows, { cutoff: 60, threshold: 5 }));
    assert.ok(s.includes('阈值失效'), '失效段要明确标出来');
    assert.ok(s.includes('99.0%'), '要给出触发率，让人知道失效到什么程度');
    assert.ok(!s.includes('未衰减'), '失效段绝不能输出"未衰减"这种让人放心的结论');
    assert.ok(s.includes('1 段阈值失效不计入'), '总览标题要把失效段排除在显著性统计之外');
  });

  test('buildWalkForwardReport: 全部段都正常时不该出现阈值失效的告警', () => {
    const rows = wfFoldRows.map(r => ({ ...r, cutoff: 12, cutoffSource: 'train', inert: { frac: 0.33, inert: false } }));
    const s = section2(buildWalkForwardReport(wfOos, rows, { cutoff: 60, threshold: 5 }));
    // 标题里那句"0 段阈值失效不计入"照常出（它是计数，不是告警）；不该出的是告警段落和表格标记
    assert.ok(s.includes('0 段阈值失效不计入'));
    assert.ok(!s.includes('⚠️ 标「阈值失效」'), '没有失效段就不该出那段告警');
    assert.ok(!s.includes('判定无意义'), '不该有任何一段被判成无意义');
    assert.ok(!s.includes('⚠兜底'), 'cutoff 都是训出来的，不该标兜底');
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

  // ---------- 第 4 节同分饱和：三条后果分开报，ρ 代价用估计值不用笼统断言 ----------
  // 原来是一句"⚠️ 同分块内部无法排序，直接压住 ρ 的上限，也让第 7 节…失去意义"，触发线 10%。
  // 问题在【第一句】：ρ 代价 = f(块大小, 信号强度)，弱信号下小得多，而 10%（触发线本身）
  // 的实际代价是 0.000。后两条（分段表、cutoff 没中间档位）在 10% 就成立，照常报。
  const ns = (over) => ({ ...northStar, ...over });

  test('buildBacktestReport: ρ 代价小时要明说"瓶颈不在分数粒度上"，不许喊压住上限', () => {
    const r = buildBacktestReport({ ...input, northStar:
      ns({ tieN: 262, tieRatio: 262 / 728, tieRhoCost: 0.004, rhoUntiedEst: 0.194 }) });
    assert.ok(r.includes('代价估计只有 +0.004'), '要给出估计值本身');
    assert.ok(r.includes('瓶颈**不在分数粒度上**'), '要明确指路：别去拉宽梯形');
    assert.ok(!r.includes('直接压住 ρ 的上限'), '不该再出现那句笼统断言');
    assert.ok(r.includes('模型估计不是测量值'), '必须写明是估计，不是测出来的');
  });

  test('buildBacktestReport: ρ 代价大时才说值得拉宽梯形', () => {
    const r = buildBacktestReport({ ...input, northStar:
      ns({ tieN: 550, tieRatio: 550 / 728, tieRhoCost: 0.059, rhoUntiedEst: 0.249 }) });
    assert.ok(r.includes('代价估计 +0.059'));
    assert.ok(r.includes('值得去拉宽梯形过渡带'));
    assert.ok(!r.includes('瓶颈'), '够大的时候不该再劝人别动手');
  });

  test('buildBacktestReport: 同分块 ≥10% 要报分段表跨档 + cutoff 没有中间档位', () => {
    const r = buildBacktestReport({ ...input, northStar:
      ns({ tieScore: -77.3, tieN: 262, tieRatio: 262 / 728, tieRhoCost: 0.004, rhoUntiedEst: 0.194 }) });
    assert.ok(/约 4 个十分位/.test(r), '36% 约横跨 4 个十分位，要算出来告诉人');
    assert.ok(r.includes('cutoff 在这里没有中间档位'), 'cutoff 断崖是这个块的真实代价');
    assert.ok(r.includes('262'), '要给出一步跳掉多少样本');
  });

  test('buildBacktestReport: 同分块 <10% 不报后两条（但 ρ 代价那行照常）', () => {
    const r = buildBacktestReport({ ...input, northStar:
      ns({ tieN: 20, tieRatio: 20 / 728, tieRhoCost: 0.000, rhoUntiedEst: 0.190 }) });
    assert.ok(r.includes('代价估计只有'), 'ρ 代价那行不看 10% 这条线');
    assert.ok(!r.includes('个十分位落在这同一个分数上'));
    assert.ok(!r.includes('没有中间档位'));
  });

  test('buildBacktestReport: 旧数据没有 tieRhoCost 时整段不崩、也不漏 NaN', () => {
    let r;
    assert.doesNotThrow(() => { r = buildBacktestReport({ ...input, northStar:
      ns({ tieN: 262, tieRatio: 262 / 728 }) }); });
    assert.ok(r.includes('同分饱和'), '同分饱和那一行照常出');
    assert.ok(!r.includes('代价估计'), '没有数据就不硬造这一行');
    assert.ok(!/代价估计 \+?(NaN|-)/.test(r));
  });

  // ---------- 第 1 节字段范围：三档都要显示对（readme 第 37 节） ----------
  // 原来这里是 `fieldScope === 'assembled' ? '组装字段' : '原字段'`，于是 'all' 落进 else
  // 被标成「原字段」——真实数据上把一次全量轮的结果写成了原字段轮，而同一次的候选表导出
  // （走 UI 那份三档 map）写的是「全部字段」，两份文件对同一次扫描给出矛盾口径。
  // 根因是重复实现，已去重到 lib 的 fieldScopeLabel，这几条守着三档 + 兜底。
  test('buildBacktestReport: fieldScope 三档分别显示对', () => {
    for (const [scope, label] of [['original', '原字段'], ['assembled', '组装字段'], ['all', '全部字段']]) {
      const r = buildBacktestReport({ ...input, config: { ...input.config, fieldScope: scope } });
      assert.ok(r.includes(`字段范围：${label}`), `fieldScope=${scope} 应显示「${label}」`);
    }
  });

  test('buildBacktestReport: fieldScope=all 绝不能被标成「原字段」（这次的 bug）', () => {
    const r = buildBacktestReport({ ...input, config: { ...input.config, fieldScope: 'all' } });
    assert.ok(!r.includes('字段范围：原字段'));
    assert.ok(r.includes('字段范围：全部字段'));
  });

  test('buildBacktestReport: 未登记的 fieldScope 原样显示，不静默归到某一档', () => {
    const r = buildBacktestReport({ ...input, config: { ...input.config, fieldScope: 'kline' } });
    assert.ok(r.includes('字段范围：kline'), '宁可显示原始值也别显示一个看起来正常实际是错的标签');
    const r2 = buildBacktestReport({ ...input, config: { ...input.config, fieldScope: undefined } });
    assert.ok(r2.includes('字段范围：未指定'));
  });

  // ---------- 第 8 节判定：先看绝对水平，再看相对落差 ----------
  // 真实数据上撞到的：用户 4 因子那轮 train lift=1.13 → val lift=0.96，落差只有 0.17，
  // 报告照样输出"落差小，泛化较好"——可 lift<1 的意思是【这个筛子比不筛还差】，
  // 触发的那批里高倍率低于基准。原判定只比 trL/teL 的差值，从不看 teL 有没有过 1。
  const oosWith = (train, test) => ({
    ...input,
    oos: { trainSize: 681, testSize: 47, skipped: [], train, test },
  });

  test('buildBacktestReport: 验证段 lift<1 时不许说"泛化较好"，要点明比不筛还差', () => {
    const r = buildBacktestReport({ ...oosWith(
      { triggered: 556, hitRate: 0.246, capture: 0.926, lift: 1.13 },
      { triggered: 35, hitRate: 0.143, capture: 0.714, lift: 0.96 }), northStar });
    assert.ok(!r.includes('泛化较好'), '落差 0.17 但验证段 lift<1，绝不能说泛化较好');
    assert.ok(r.includes('比不筛还差'), '要直说 lift<1 的含义');
  });

  test('buildBacktestReport: 验证段 lift≈1 时说"没筛出超额"，同样不算泛化好', () => {
    const r = buildBacktestReport({ ...oosWith(
      { triggered: 500, hitRate: 0.22, capture: 0.9, lift: 1.02 },
      { triggered: 40, hitRate: 0.21, capture: 0.9, lift: 1.01 }), northStar });
    assert.ok(!r.includes('泛化较好'));
    assert.ok(r.includes('没筛出超额'));
  });

  test('buildBacktestReport: 验证段 lift>1 且落差小才给"泛化较好"', () => {
    const r = buildBacktestReport({ ...oosWith(
      { triggered: 300, hitRate: 0.3, capture: 0.7, lift: 1.40 },
      { triggered: 30, hitRate: 0.29, capture: 0.7, lift: 1.35 }), northStar });
    assert.ok(r.includes('泛化较好'));
    assert.ok(r.includes('验证段 lift>1'), '结论里要写清楚前提，免得又被简化成只看落差');
  });

  test('buildBacktestReport: 验证段 lift>1 但落差大，仍按过拟合报', () => {
    const r = buildBacktestReport({ ...oosWith(
      { triggered: 300, hitRate: 0.4, capture: 0.7, lift: 1.90 },
      { triggered: 30, hitRate: 0.25, capture: 0.6, lift: 1.15 }), northStar });
    assert.ok(!r.includes('泛化较好'));
    assert.ok(/过拟合/.test(r));
  });

  // ---------- 第 2 节的分数公式：口径必须写对，且要标出跟线上的尺度差 ----------
  // 原文案写的是「/Σ正权重」，含糊到会被读成"分母只有勇者那一半"。review 的 scoreRow 是
  // `wsum += f.weight`（全部权重，邪恶的符号在 s 上、weight 恒非负），而【策略模板】是
  // `wsum += Math.max(0, weight)` + 邪恶权重写成负数 —— 分母真的只有勇者那一半。
  // 两边分子一致、分母差一个正数倍：排序完全一致（ρ/十分位/AUC 不受影响），但 cutoff 不通用。
  // 见 readme 第 32 节。
  const mixedPool = {
    ...input,
    config: { ...input.config, cutoff: -42 },
    factors: [
      { field: 'mcap', camp: 'evil', weight: 70.5, lo0: 4786, lo1: 14389, hi1: Infinity, hi0: Infinity, auc: 0.541, missRate: 0 },
      { field: 'chip_analysis.above_percent', camp: 'hero', weight: 29.7, lo0: -1.7, lo1: 6.8, hi1: Infinity, hi0: Infinity, auc: 0.532, missRate: 0 },
    ],
  };

  test('buildBacktestReport: 分数公式的分母写成「Σ勇者权重（=满分上限）」，并写明 cutoff 两边通用', () => {
    const r = buildBacktestReport({ ...mixedPool, northStar });
    assert.ok(r.includes('Σ勇者权重（=满分上限 29.7）'), '应写出真实分母和它的数值');
    assert.ok(!r.includes('/Σ正权重'), '不该再出现会被误读的旧措辞');
    assert.ok(r.includes('cutoff 可直接搬'), '对齐之后要说明 cutoff 不用换算');
  });

  test('buildBacktestReport: 混合池要标出分数下界不是 −100（邪恶占比越高越负）', () => {
    const r = buildBacktestReport({ ...mixedPool, northStar });
    // 邪恶 70.5 / 勇者 29.7 → 全踩中最低 -70.5/29.7*100 = -237.4
    assert.ok(r.includes('-237.4'), '应算出该池子的真实分数下界');
    assert.ok(r.includes('下界不是 −100'), '要点明下界不再是 −100，否则 cutoff 会被按旧直觉设');
  });

  test('buildBacktestReport: 纯勇者阵营池子不输出下界那一行（分数本来就落在 0~100）', () => {
    const heroOnly = { ...input, factors: input.factors.map(f => ({ ...f, camp: 'hero' })) };
    const r = buildBacktestReport({ ...heroOnly, northStar });
    assert.ok(r.includes('Σ勇者权重'), '公式本身照常写');
    assert.ok(!r.includes('下界不是'), '没有邪恶因子就没有负分，不该凭空多一行');
  });

  test('buildBacktestReport: 纯邪恶池要显式报"分数恒为 0"，不能让下面的数字看着像真的', () => {
    const evilOnly = { ...input, factors: input.factors.map(f => ({ ...f, camp: 'evil' })) };
    const r = buildBacktestReport({ ...evilOnly, northStar });
    assert.ok(r.includes('没有勇者因子'), '应点名这个池子没有勇者因子');
    assert.ok(r.includes('恒为 0'), '应说明所有样本分数恒为 0');
  });

  test('buildBacktestReport: 因子池为空时不做除零，也不误报"没有勇者因子"', () => {
    const empty = { ...input, factors: [] };
    let r;
    assert.doesNotThrow(() => { r = buildBacktestReport({ ...empty, northStar }); });
    assert.ok(!r.includes('没有勇者因子'), '空池是"还没建因子"，不是"缺勇者阵营"，别误报');
    assert.ok(!/NaN|Infinity/.test(r.split('## 3.')[0]), '第 2 节不该漏出 NaN/Infinity');
  });

  // ---------- 因子体检并进报告（readme 第 44 节） ----------
  // 这几条守的是"报告要给结论、不是给素材"：以前这些数字全靠人拿五份表交叉手算。
  test('buildBacktestReport: 因子池表补摆幅/满命中/有效n 三列', () => {
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push({ returnMax: i < 20 ? 5 : 1, features: { x: i < 90 ? 5 : 0 } });
    const factors = [{ field: 'x', camp: 'hero', weight: 50, lo0: 0.5, lo1: 0.5, hi1: Infinity, hi0: Infinity }];
    const r = buildBacktestReport({ config: { threshold: 3, cutoff: 50 }, base: { n: 100, pos: 20, baseRate: 0.2 },
      factors, rows });
    assert.ok(r.includes('摆幅'), '表头要有摆幅列');
    assert.ok(r.includes('满命中'), '表头要有满命中列');
    assert.ok(r.includes('有效n'), '表头要有有效n列');
    assert.ok(r.includes('+100.0'), '单勇者因子摆幅 = 权重/Σ勇者×100 = 100');
    assert.ok(r.includes('90%'), '90% 的样本满命中');
    assert.ok(r.includes('⚠️'), '≥90% 满命中要标记');
    assert.ok(r.includes('优先考虑删掉'), '标记了就要给出图例说明');
  });

  test('buildBacktestReport: 没有 rows 时三列退回 "-"，不凭空造数、也不报警', () => {
    const r = buildBacktestReport({ config: { threshold: 3, cutoff: 50 }, base: { n: 10, pos: 2, baseRate: 0.2 },
      factors: [{ field: 'x', camp: 'hero', weight: 50 }] });
    assert.ok(r.includes('摆幅'), '表头照常有（口径要稳定）');
    assert.ok(!r.includes('⚠️'), '算不出来就不能报警');
  });

  test('buildBacktestReport: 8.5 节报出顶档反转与邪恶缺失白得分', () => {
    const rows = [];
    // 高分段（x 命中 + e 缺失 → 躲掉扣分）表现反而差 → 顶档反转 + 缺失白得分
    for (let i = 0; i < 100; i++) rows.push({ returnMax: i < 30 ? 5 : 1, features: { x: 1, e: 0 } });
    for (let i = 0; i < 100; i++) rows.push({ returnMax: i < 10 ? 5 : 1, features: { x: 1 } });
    const factors = [
      { field: 'x', camp: 'hero', weight: 50, lo0: 0, lo1: 0, hi1: Infinity, hi0: Infinity },
      { field: 'e', camp: 'evil', weight: 50, lo0: -Infinity, lo1: -Infinity, hi1: 1, hi0: 1 },
    ];
    const bt = backtestFactors(rows, factors, 3);
    const r = buildBacktestReport({ config: { threshold: 3, cutoff: 50 },
      base: bt.base, factors, rows, backtest: bt, deciles: bt.deciles, sweep: bt.sweep.points });
    assert.ok(r.includes('因子体检'), '8.5 节要出现');
    assert.ok(r.includes('低于基准'), '顶档 lift<1 要明说');
    assert.ok(r.includes('白得'), '邪恶缺失要说成"白得分"，不是"缺失率 x%"');
    assert.ok(r.includes('分位'), '要报出缺失样本被打到了哪个分位');
  });

  test('buildBacktestReport: cutoff 扫描补倍数中位列 + 临界大鱼告警', () => {
    const rows = [];
    for (let i = 0; i < 100; i++) rows.push({ returnMax: 1 + i / 50, features: { x: i }, symbol: 'S' + i });
    // 临界分下方塞一条超大倍数
    rows.push({ returnMax: 208.35, features: { x: 48 }, symbol: 'looong' });
    const factors = [{ field: 'x', camp: 'hero', weight: 100, lo0: 0, lo1: 100, hi1: Infinity, hi0: Infinity }];
    const bt = backtestFactors(rows, factors, 3);
    const cut = bt.scored.find(s => s.row.symbol === 'looong').score + 1;
    const r = buildBacktestReport({ config: { threshold: 3, cutoff: cut }, base: bt.base, factors, rows,
      backtest: bt, sweep: bt.sweep.points, deciles: bt.deciles });
    assert.ok(r.includes('倍数中位'), 'cutoff 扫描表要有倍数中位列');
    assert.ok(r.includes('looong'), '差几分没进的大鱼必须点名——lift 结构上看不见它');
    assert.ok(r.includes('208.35x'));
  });

  test('buildRecommendPathReport: 按噪声地板给出"建议采纳前 N 步"', () => {
    const path = [0.153, 0.110, 0.063, 0.044].map((d, i) => ({
      field: 'f' + i, camp: 'hero', deltaTest: d, deltaIn: d,
      testBuckets: [{ lo: 0, hi: 1, n: 10, pos: 2, hiRate: 0.2 }],
    }));
    const r = buildRecommendPathReport(path, { threshold: 3, nTest: 218 });
    assert.ok(r.includes('建议只采纳前 2 步'), `地板 0.068 → 前 2 步。实际报告：${r.slice(0, 400)}`);
    assert.ok(r.includes('噪声地板'));
  });

  test('buildRecommendPathReport: 第一步就在噪声里要明确说整条别用', () => {
    const path = [{ field: 'a', camp: 'hero', deltaTest: 0.01, deltaIn: 0.01 }];
    const r = buildRecommendPathReport(path, { threshold: 3, nTest: 218 });
    assert.ok(r.includes('整条路径都在噪声里'));
  });

  test('buildRecommendPathReport: 没有 nTest 时不瞎猜地板（旧调用方不受影响）', () => {
    const r = buildRecommendPathReport([{ field: 'a', camp: 'hero', deltaTest: 0.5, deltaIn: 0.5 }], { threshold: 3 });
    assert.ok(!r.includes('噪声地板'), '算不出地板就不能编一个出来');
  });

  test('buildRecommendPathReport: 非 ρ 目标要声明，否则读的人会把 Δlift 当 Δρ', () => {
    const path = [{ field: 'a', camp: 'hero', deltaTest: 0.3, deltaIn: 0.3 }];
    const r = buildRecommendPathReport(path, { threshold: 3, objective: 'topLift' });
    assert.ok(r.includes('顶档 lift'));
    assert.ok(r.includes('不可比'));
  });
}
