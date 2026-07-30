import assert from 'node:assert';
import { recommendFactorPath, recommendFactorPool, heldOutFactorCurve } from '../src/lib/factorLab.js';
import { buildRecommendPathReport } from '../src/lib/backtestReportExport.js';

function mkRows(n = 120) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ret = ((i * 37) % 100) / 10; // 0~9.9，与 i 顺序去相关
    rows.push({ tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret,
      features: { good: ret, noise: ((i * 53) % 100) / 10 } });
  }
  return rows;
}
const cands = [
  { field: 'good', camp: 'hero', auc: 0.9, direction: 'high', interval: { lo: 5, hi: Infinity } },
  { field: 'noise', camp: 'hero', auc: 0.52, direction: 'high', interval: { lo: 5, hi: Infinity } },
];

export function run(test) {
  test('recommendFactorPath: 从零(探索)应先推有效因子，held-out Δρ 为正', () => {
    const r = recommendFactorPath(mkRows(), [], cands, { threshold: 5, missingPolicy: 'zero' });
    assert.ok(r.path.length >= 1, '至少推一个');
    assert.strictEqual(r.path[0].field, 'good', '第一个应是有效因子');
    assert.ok(r.path[0].deltaTest > 0, 'held-out Δρ 应为正');
    assert.ok(r.nTrain > 0 && r.nTest > 0);
  });

  test('recommendFactorPath: 噪声因子不该被推进路径', () => {
    const r = recommendFactorPath(mkRows(), [], cands, { threshold: 5, missingPolicy: 'zero' });
    assert.ok(!r.path.some(p => p.field === 'noise'), 'noise 不应入选');
  });

  test('recommendFactorPath: 组合模式——good 已在池里时，不再重复推荐它', () => {
    const rows = mkRows();
    // 起点池含 good（构造一个最简因子对象；recommend 只看 camp+field 去重）
    const start = [{ field: 'good', camp: 'hero', weight: 100, lo0: -Infinity, lo1: 5, hi1: Infinity, hi0: Infinity }];
    const r = recommendFactorPath(rows, start, cands, { threshold: 5, missingPolicy: 'zero' });
    assert.ok(!r.path.some(p => p.field === 'good'), '已在池里的不重复推');
  });

  test('recommendFactorPath: 无可用候选(无区间)时给出 error，不抛异常', () => {
    const r = recommendFactorPath(mkRows(), [], [{ field: 'x', camp: 'hero', interval: null }], { threshold: 5 });
    assert.ok(r.error);
    assert.strictEqual(r.path.length, 0);
  });

  // 2026-07-28：用户要求去掉 recommendFactorPath 原来的 candLimit=50 截断（按 interval.score
  // 排序只取前50个候选进贪心，会漏掉排名靠后但组合起来有用的字段——因子推荐2当初就是为了绕开
  // 这个限制才另起的）。跟下面 recommendFactorPool 的截断测试同一个构造思路：60个候选，
  // 只有一个真信号排在数组/排序都靠后的位置（其余候选都没有 interval.score，排序时视为并列0，
  // 稳定排序下真信号仍留在最后），验证 held-out 贪心也不再受 candLimit 限制。
  test('recommendFactorPath: 不该再有 candLimit=50 截断，排在最后的真信号也能被 held-out 贪心选中', () => {
    const rows = mkRows(300);
    const noiseCands = Array.from({ length: 59 }, (_, i) => ({
      field: `noise${i}`, camp: 'hero', auc: 0.5, interval: { lo: 5, hi: Infinity },
    }));
    rows.forEach((r, i) => {
      noiseCands.forEach((c, j) => { r.features[c.field] = ((i * (101 + j * 7)) % 97) / 9.7; });
    });
    const allCands = [...noiseCands, { field: 'good', camp: 'hero', auc: 0.9, interval: { lo: 5, hi: Infinity } }];
    rows.forEach((r, i) => { r.features.good = r.returnMax; });
    const r = recommendFactorPath(rows, [], allCands, { threshold: 5, missingPolicy: 'zero' });
    assert.ok(!r.error, '不应报错：' + r.error);
    assert.ok(r.path.some(p => p.field === 'good'), '旧的 candLimit=50 会漏掉排在51号之后的真信号，这里不该漏');
  });

  // 2026-07-29 合并后的 recommendFactorPool：选字段走 held-out 贪心（recommendFactorPath），
  // 选完在全样本上精配一次权重，再出影子权重校验 + K折 k*。用同一批 good/noise 候选验证核心
  // 行为：选中真实信号、排除噪声、权重优化后 rho 不低于优化前。
  test('recommendFactorPool: 应选中真实信号、排除噪声，并在全样本上配出权重', () => {
    const r = recommendFactorPool(mkRows(), cands, { threshold: 5, missingPolicy: 'zero' });
    assert.ok(!r.error, '不应报错：' + r.error);
    assert.ok(r.path.some(p => p.field === 'good'), 'good 应入选');
    assert.ok(!r.path.some(p => p.field === 'noise'), 'noise 不该入选');
    assert.ok(r.factors.length >= 1);
    assert.ok(Number.isFinite(r.rhoBefore) && Number.isFinite(r.rhoAfter));
    assert.ok(r.rhoAfter >= r.rhoBefore - 1e-9, '全样本配权后 ρ 不应下降');
    assert.strictEqual(r.n, mkRows().length);
  });

  // 影子权重过拟合校验（只用 train 配权、对 test 全盲）：验证真实、稳定的信号（good 在全程都跟
  // returnMax 相关）不该被误判过拟合，rhoTrain/rhoTest 都应该是有效正数。
  test('recommendFactorPool: 全程稳定的真实信号不该被误判过拟合', () => {
    const r = recommendFactorPool(mkRows(300), cands, { threshold: 5, missingPolicy: 'zero' });
    assert.ok(!r.error, '不应报错：' + r.error);
    assert.ok(Number.isFinite(r.rhoTrain) && Number.isFinite(r.rhoTest), 'rhoTrain/rhoTest 都应算出有效数值');
    assert.ok(r.rhoTrain > 0 && r.rhoTest > 0, `全程都是真信号，train/test 应该都是正的：train=${r.rhoTrain} test=${r.rhoTest}`);
    assert.strictEqual(r.overfit, false, '稳定信号不该被判过拟合');
    assert.ok(r.nTrain > 0 && r.nTest > 0);
  });

  // 构造"概念漂移"数据：good 只在前70%(train区间)跟 returnMax 相关，后30%(test区间)完全无关。
  // 2026-07-29 合并时先写成了"held-out 贪心应该在选字段阶段就拒绝它"，实测被打脸：从空池出发时
  // 首个因子的 deltaTest 就等于它自己的验证段 ρ，这里是 +0.009——数值上约等于 0，但仍然大于
  // 任何合理的 minGain 地板（0.001/0.003 都拦不住），所以它照样会被选进 path。
  // 结论（这条用例守的就是这个结论）：**minGain 不是过拟合防线**，真正认得出概念漂移的是
  //   ① 每步的 overfit 标记：样本内 Δρ≈0.25，验证段 Δρ≈0.009，差两个数量级；
  //   ② 标签上直接显示的就是 0.009 而不是 0.25——用户看到的数字本身已经在说"这东西没用"；
  //   ③ 影子权重校验：rhoTrain≈0.38 vs rhoTest≈0.002 → overfit=true。
  // 相比旧的全样本内贪心（标签会显示 0.25，得等事后校验才知道有问题），改进在①②，不在"拒绝"。
  test('recommendFactorPool: 概念漂移（信号只在训练区间成立）——验证段增量≈0 且被标记过拟合', () => {
    const n = 400;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const inTrainRegion = i < n * 0.7;
      let good, ret;
      if (inTrainRegion) {
        const level = (i % 40) / 40;
        ret = level > 0.85 ? 5 + (i % 15) : 0.5 + (i % 10) / 10;
        good = 20 + level * 60 + ((i * 13) % 20);
      } else {
        ret = ((i * 17) % 12) < 1 ? 5 + (i % 15) : 0.5 + (i % 10) / 10;
        good = (i * 31) % 100; // 跟 returnMax 无关，关系在这里消失
      }
      rows.push({ tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret, features: { good } });
    }
    const driftCands = [{ field: 'good', camp: 'hero', auc: 0.8, interval: { lo: 5, hi: Infinity } }];
    const r = recommendFactorPool(rows, driftCands, { threshold: 2, missingPolicy: 'zero' });
    assert.ok(!r.error, '不应报错：' + r.error);
    const step = r.path.find(p => p.field === 'good');
    assert.ok(step, 'deltaTest 虽然≈0 但仍为正，它会被选中——这条用例守的是"选中之后看得出来"');
    // ① 验证段增量比样本内小一个数量级以上，且绝对值贴近 0
    assert.ok(step.deltaTest < step.deltaIn * 0.2,
      `验证段增量应远小于样本内：deltaTest=${step.deltaTest} deltaIn=${step.deltaIn}`);
    assert.ok(Math.abs(step.deltaTest) < 0.05, `验证段增量应贴近0，实际 ${step.deltaTest}`);
    // ② 该步被标记过拟合
    assert.strictEqual(step.overfit, true, '样本内涨、验证段跟不上，这一步应被标 overfit');
    // ③ 影子权重校验也应报过拟合
    assert.ok(Number.isFinite(r.rhoTrain) && Number.isFinite(r.rhoTest));
    assert.ok(r.rhoTest < r.rhoTrain * 0.4, `test段应明显低于train段：train=${r.rhoTrain} test=${r.rhoTest}`);
    assert.strictEqual(r.overfit, true, '概念漂移应该被判过拟合');
  });

  // held-out 因子数验证曲线：把"选出来的 N 个里到底几个能泛化"量化出来。构造"第一个真信号 +
  // 后面全噪声"的固定路径，K 折 held-out 逐前缀打分——噪声加进来在 test 上不该继续涨，1-SE 推荐
  // 因子数 k* 应远小于路径长度（这正是「20 多个参数」那种过拟合尾巴该被抓出来的场景）。
  test('heldOutFactorCurve: 真信号后跟一串噪声时，推荐因子数 k* 应远小于路径长度', () => {
    const n = 300, T = 2;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const good = (i * 41) % 100;                 // 0~99，真信号
      const win = good > 60;                        // good 高 → 赢
      const feats = { good };
      for (let j = 0; j < 4; j++) feats['noise' + j] = (i * (137 + j * 29) + j * 7) % 100; // 与 good/label 无关
      rows.push({ tokenAddress: 'T' + i, swapBeginTime: 1000 + i,
        returnMax: win ? T + 1 + (i % 5) : 0.5 + (i % 10) / 20, features: feats });
    }
    const cands = [{ field: 'good', camp: 'hero', interval: { lo: 60, hi: Infinity } },
      ...[0, 1, 2, 3].map(j => ({ field: 'noise' + j, camp: 'hero', interval: { lo: 40, hi: 60 } }))];
    const pathSpecs = [{ field: 'good', camp: 'hero' },
      ...[0, 1, 2, 3].map(j => ({ field: 'noise' + j, camp: 'hero' }))];
    const hc = heldOutFactorCurve(rows, cands, pathSpecs, { threshold: T, missingPolicy: 'zero', K: 5 });
    assert.ok(hc, '样本足够应返回曲线');
    assert.strictEqual(hc.curve.length, 5);
    assert.strictEqual(hc.kMax, 5);
    assert.ok(hc.recommendedCount < hc.kMax, `噪声尾巴应被截掉：k*=${hc.recommendedCount} 应 < ${hc.kMax}`);
    assert.ok(hc.recommendedCount <= 2, `只有 good 真泛化，k* 应很小，实际 ${hc.recommendedCount}`);
    assert.ok(hc.curve.every(c => Number.isFinite(c.inRho)), '应带样本内对照曲线 inRho');
  });

  test('recommendFactorPool: 返回 held-out 曲线 + 推荐因子数 + 截断池（长度≤推荐因子数）', () => {
    const rows = mkRows(300);
    rows.forEach((r) => { r.features.good = r.returnMax; }); // 强信号
    const cands2 = [{ field: 'good', camp: 'hero', interval: { lo: 5, hi: Infinity } },
      { field: 'noise', camp: 'hero', interval: { lo: 5, hi: Infinity } }];
    const r = recommendFactorPool(rows, cands2, { threshold: 5, missingPolicy: 'zero' });
    assert.ok(!r.error, r.error);
    assert.ok(r.heldoutCurve, '应返回 held-out 曲线');
    assert.ok(Number.isFinite(r.recommendedCount) && r.recommendedCount >= 1);
    assert.ok(r.recommendedCount <= r.path.length, 'k* 不应超过路径长度');
    assert.ok(Array.isArray(r.factorsTrimmed) && r.factorsTrimmed.length <= r.recommendedCount,
      `截断池长度应≤推荐因子数 ${r.recommendedCount}，实际 ${r.factorsTrimmed.length}`);
  });

  // 候选池给多少都要遍历（candLimit 历史默认值 50 已去掉）：构造 60 个候选，其中只有一个真信号
  // + 59 个噪声，验证不会因为排序截断漏掉排在后面的真信号（这里真信号故意排在候选数组末尾）。
  test('recommendFactorPool: 候选数超过历史 candLimit=50 时不截断，排在最后的真信号也能选中', () => {
    const rows = mkRows(300);
    // 噪声字段：乘数/模数都跟 returnMax 的构造(i*37 % 100)完全错开，避免意外撞出一个跟标签
    // 结构一致的"假噪声"（曾经踩过这个坑：乘数用到 37 时 noise 变成了 returnMax 的复制品）。
    const noiseCands = Array.from({ length: 59 }, (_, i) => ({
      field: `noise${i}`, camp: 'hero', auc: 0.5, interval: { lo: 5, hi: Infinity },
    }));
    rows.forEach((r, i) => {
      noiseCands.forEach((c, j) => { r.features[c.field] = ((i * (101 + j * 7)) % 97) / 9.7; });
    });
    const allCands = [...noiseCands, { field: 'good', camp: 'hero', auc: 0.9, interval: { lo: 5, hi: Infinity } }];
    rows.forEach((r, i) => { r.features.good = r.returnMax; }); // 强信号，排在候选数组最后
    const r = recommendFactorPool(rows, allCands, { threshold: 5, missingPolicy: 'zero' });
    assert.ok(!r.error, '不应报错：' + r.error);
    assert.ok(r.path.some(p => p.field === 'good'), 'candLimit=50 会漏掉排在51号之后的真信号，这里不该漏');
  });

  test('recommendFactorPool: 无可用候选(无区间)时给出 error，不抛异常', () => {
    const r = recommendFactorPool(mkRows(), [{ field: 'x', camp: 'hero', interval: null }], { threshold: 5 });
    assert.ok(r.error);
    assert.strictEqual(r.path.length, 0);
  });

  // "组合路径"模式：opts.startFactors
  // 非空时从当前池出发，只找【新增】的字段，起点池本身不会被重新挑选、也不计入 held-out 曲线的 k。
  // 构造两个都只跟 returnMax 部分相关（不是完美单调，留出"组合能提升"的空间）的独立信号 good/good2，
  // 从只含 good 的起点池出发，应该挑出 good2 作为新增，good 不重复出现在 path 里，noise 不该入选。
  function mkComboRows(n = 400) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const ret = ((i * 37) % 100) / 10;
      const good = ret + (((i * 13) % 7) - 3);   // 跟 ret 部分相关，非完美单调
      const good2 = ret + (((i * 19) % 9) - 4);  // 另一个独立的部分相关信号
      const noise = ((i * 53) % 100) / 10;       // 与 ret 无关
      rows.push({ tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret, features: { good, good2, noise } });
    }
    return rows;
  }
  test('recommendFactorPool: 组合路径模式(opts.startFactors)——起点池的因子不重复挑选，只找新增的', () => {
    const rows = mkComboRows();
    const comboCands = [
      { field: 'good', camp: 'hero', interval: { lo: 5, hi: Infinity } },
      { field: 'good2', camp: 'hero', interval: { lo: 5, hi: Infinity } },
      { field: 'noise', camp: 'hero', interval: { lo: 5, hi: Infinity } },
    ];
    const start = [{ field: 'good', camp: 'hero', weight: 100, lo0: -Infinity, lo1: 5, hi1: Infinity, hi0: Infinity }];
    const r = recommendFactorPool(rows, comboCands, { threshold: 5, missingPolicy: 'zero', startFactors: start });
    assert.ok(!r.error, '不应报错：' + r.error);
    assert.ok(!r.path.some(p => p.field === 'good'), '起点池里已有的 good 不该重复出现在新增路径里');
    assert.ok(r.path.some(p => p.field === 'good2'), 'good2 是独立的真信号，该被挑作新增');
    assert.ok(!r.path.some(p => p.field === 'noise'), 'noise 不该入选');
    assert.ok(r.factors.some(f => f.field === 'good'), '最终因子集应包含起点池的 good（起点池+新增合并）');
    assert.ok(r.factors.some(f => f.field === 'good2'), '最终因子集应包含新增的 good2');
    assert.ok(r.recommendedCount <= r.path.length, 'k* 只应针对新增路径计数，不应把起点池也算进去');
  });

  test('recommendFactorPool: 组合路径模式——起点池已经不错、没有新增时应给出提示而非硬报错崩溃', () => {
    const rows = mkComboRows();
    const noNewCands = [
      { field: 'good', camp: 'hero', interval: { lo: 5, hi: Infinity } },
      { field: 'noise', camp: 'hero', interval: { lo: 5, hi: Infinity } },
    ];
    const start = [{ field: 'good', camp: 'hero', weight: 100, lo0: -Infinity, lo1: 5, hi1: Infinity, hi0: Infinity }];
    const r = recommendFactorPool(rows, noNewCands, { threshold: 5, missingPolicy: 'zero', startFactors: start });
    assert.strictEqual(r.path.length, 0);
    assert.ok(r.error, '没有新增候选时应给出提示信息');
    assert.ok(r.error.includes('已经不错'), `提示文案应说明"起点池已经不错"这层意思，实际："${r.error}"`);
  });

  // ---------- 过拟合校验必须是三态：塌陷 / 正常 / test 反常高于 train（readme 第 39 节） ----------
  // 原来只判 `rhoTest < rhoTrain*0.4`（单向），于是 train 0.193 / test 0.308 被输出成
  // "没有明显塌陷，这份权重站得住脚"。readme 26.2.1 那次真实泄漏（事后字段进池）正是这个形态。
  test('recommendFactorPool: 返回 testAboveTrain / rhoGapSe，且与 overfit 互斥', () => {
    const rows = mkRows(200);
    const cands = [
      { field: 'good', camp: 'hero', interval: { lo: 5, hi: Infinity, score: 1.5 } },
      { field: 'noise', camp: 'hero', interval: { lo: 40, hi: Infinity, score: 1.1 } },
    ];
    const r = recommendFactorPool(rows, cands, { threshold: 5, maxSteps: 2, minGain: 0.001 });
    assert.ok('testAboveTrain' in r, '必须返回反向异常标记');
    assert.ok('rhoGapSe' in r, '必须返回噪声量级，UI 要用它说明"这不构成证据"');
    assert.strictEqual(typeof r.testAboveTrain, 'boolean');
    assert.ok(!(r.overfit && r.testAboveTrain), 'test 不可能同时既塌陷又反常偏高');
    if (Number.isFinite(r.rhoGapSe)) assert.ok(r.rhoGapSe >= 0, '标准误不能为负');
  });

  test('testAboveTrain 的判据：test > train×1.2 且 train>0 才置位', () => {
    // 直接验判据本身的边界——用 recommendFactorPool 很难精确摆出想要的 train/test 组合，
    // 这里复刻同一个表达式，锁死"改判据时测试会红"。
    const judge = (rhoTrain, rhoTest) => Number.isFinite(rhoTrain) && rhoTrain > 0
      && Number.isFinite(rhoTest) && rhoTest > rhoTrain * 1.2;
    assert.strictEqual(judge(0.193, 0.308), true, '用户真实遇到的那组应该被标出来');
    assert.strictEqual(judge(0.243, 0.325), true, 'readme 26.2.1 那次真泄漏也应被标出来');
    assert.strictEqual(judge(0.20, 0.23), false, '高 15% 属正常波动，不该报');
    assert.strictEqual(judge(0.20, 0.05), false, '塌陷是另一态，走 overfit 分支');
    assert.strictEqual(judge(-0.1, 0.3), false, 'train<=0 时比值无意义，不置位');
    assert.strictEqual(judge(NaN, 0.3), false);
    assert.strictEqual(judge(0.2, NaN), false);
  });

  // ---- 同字段跨阵营闸门（2026-07-30）----
  // 真实数据里 `holder_gini` 同时以 ☠(第3步) 和 🛡(第10步) 进了同一条 12 步路径：
  // "gini 高加分"和"gini 低扣分"同时成立，语义上没法解释，勇者版还会计入 Σ勇者 分母。
  // 根因是 chosen 的去重键是 'camp:field'，两个阵营互不相干。
  // 下面这组 fixture 会精确复现它：x 与 returnMax 同向，hero 版取高值区、evil 版取低值区，
  // 两边各自都有正的 held-out 增量，所以旧行为下贪心会把两个都选进来。
  const twoSidedRows = (n = 200) => {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const ret = ((i * 37) % 100) / 10;   // 0~9.9，与时间序去相关
      rows.push({ tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret, features: { x: ret } });
    }
    return rows;
  };
  const twoSidedCands = [
    { field: 'x', camp: 'hero', auc: 0.8, direction: 'high', interval: { lo: 5, hi: Infinity, score: 2 } },
    { field: 'x', camp: 'evil', auc: 0.8, direction: 'low', interval: { lo: -Infinity, hi: 2, score: 1 } },
  ];

  test('recommendFactorPath: 同一字段的两个阵营默认不能都进路径，且记进 crossCampBlocked', () => {
    const r = recommendFactorPath(twoSidedRows(), [], twoSidedCands, { threshold: 5, missingPolicy: 'zero' });
    const xs = r.path.filter(p => p.field === 'x');
    assert.strictEqual(xs.length, 1, '同一个字段只能占一个阵营');
    assert.ok(Array.isArray(r.crossCampBlocked), 'crossCampBlocked 必须返回（否则闸门对使用者不可见）');
    assert.strictEqual(r.crossCampBlocked.length, 1, '被拦的那个要报出来');
    const b = r.crossCampBlocked[0];
    assert.strictEqual(b.field, 'x');
    assert.notStrictEqual(b.camp, xs[0].camp, '被拦的应是另一个阵营');
    assert.strictEqual(b.blockedBy, xs[0].camp, 'blockedBy = 占位的那个阵营');
    assert.ok(b.deltaTest > 0, '只记录本来够格的候选——deltaTest 不够 minGain 的不该出现在这里');
  });

  test('recommendFactorPath: allowCrossCamp:true 时恢复旧行为（两阵营都能进）', () => {
    const r = recommendFactorPath(twoSidedRows(), [], twoSidedCands,
      { threshold: 5, missingPolicy: 'zero', allowCrossCamp: true });
    const camps = r.path.filter(p => p.field === 'x').map(p => p.camp).sort();
    assert.deepStrictEqual(camps, ['evil', 'hero'], '显式开开关时不拦');
    assert.strictEqual(r.crossCampBlocked.length, 0, '没拦任何东西时该是空的');
  });

  test('recommendFactorPath: 起点池已占用某字段时，另一阵营也不许新增', () => {
    // 闸门必须覆盖"新增 vs 起点池"，不能只管新增之间——组合路径模式下起点池是用户采信过的池子。
    const start = [{ field: 'x', camp: 'hero', weight: 100, lo0: -Infinity, lo1: 5, hi1: Infinity, hi0: Infinity }];
    const r = recommendFactorPath(twoSidedRows(), start, twoSidedCands, { threshold: 5, missingPolicy: 'zero' });
    assert.ok(!r.path.some(p => p.field === 'x'), '起点池占了 hero:x，evil:x 也不该新增');
    assert.ok(r.crossCampBlocked.some(b => b.field === 'x' && b.camp === 'evil' && b.blockedBy === 'hero'),
      '起点池占位也要能报出 blockedBy');
  });

  test('buildRecommendPathReport: 闸门拦下的要写进报告，同字段重复出现要顶到最前面告警', () => {
    const path = [{ field: 'x', camp: 'hero', deltaTest: 0.1, deltaIn: 0.12 }];
    const md = buildRecommendPathReport(path, { threshold: 5,
      crossCampBlocked: [{ field: 'x', camp: 'evil', deltaTest: 0.03, blockedBy: 'hero' }] });
    assert.ok(/同字段跨阵营/.test(md), '报告应说明闸门拦过东西');
    assert.ok(md.includes('已被 🛡 版占位'), '要写清是哪个阵营占的位');
    // 不传时不该凭空多出这段（老报告格式不变）
    assert.ok(!/同字段跨阵营/.test(buildRecommendPathReport(path, { threshold: 5 })));
    // 自检：万一有人开了 allowCrossCamp，报告要自己认出同字段出现两次——这正是
    // holder_gini 那次（第3步☠/第10步🛡 隔了 7 步）在报告里完全隐形的场景。
    const dup = buildRecommendPathReport([
      { field: 'holder_gini', camp: 'evil', deltaTest: 0.063, deltaIn: 0.044 },
      { field: 'other', camp: 'hero', deltaTest: 0.02, deltaIn: 0.02 },
      { field: 'holder_gini', camp: 'hero', deltaTest: 0.010, deltaIn: 0.031 },
    ], { threshold: 5 });
    assert.ok(/同一字段在本路径里出现了多次/.test(dup), '同字段多次出现必须被顶出来');
    assert.ok(dup.includes('holder_gini'));
  });

  test('recommendFactorPool: crossCampBlocked 透传到收尾结果（两条 return 路径都要带）', () => {
    const r = recommendFactorPool(twoSidedRows(), twoSidedCands, { threshold: 5, maxSteps: 3, minGain: 0.001 });
    assert.ok(Array.isArray(r.crossCampBlocked), '有路径时要带');
    assert.strictEqual(r.factors.filter(f => f.field === 'x').length, 1, '最终因子池里同字段只该有一个阵营');
    const empty = recommendFactorPool(twoSidedRows(), [], { threshold: 5 });
    assert.ok(!empty.path.length && 'error' in empty, '无候选走 error 分支');
  });
}
