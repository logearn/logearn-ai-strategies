#!/usr/bin/env node
// ========== 核心纯函数单元测试（design doc §16.2） ==========
// 覆盖这次修复过的几个真实 bug（空字符串误判为0、0x地址被解析成数字）以及最容易踩坑的纯函数
// （flattenObject/flattenCtx/buildRows/pearson/linearRegression/compileCustomField），
// 防止未来重构时再次踩坑。不引入 Jest/Vitest，只用 Node 自带的 node:assert + 一个简单跑批脚本，
// 符合"轻量单文件工具"的定位——等模块拆分/测试规模进一步扩大再考虑引入正式测试框架。
//
// 运行方式：node tests/run-tests.js（在 review/ 目录下执行，或用绝对路径）

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const sandbox = { console };
vm.createContext(sandbox);
// data.js 的 isAssembledField / custom-fields.js 的部分函数会读取这几个全局状态变量，
// 本次测试只调用纯函数（不会真正触发这些依赖路径），但仍需要提前声明避免 ReferenceError。
sandbox.customFields = [];
sandbox.matchedRows = [];
sandbox.activeRows = [];
sandbox.FIELD_DESC = sandbox.FIELD_DESC || {};

function loadFile(relPath) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', relPath), 'utf8');
  vm.runInContext(code, sandbox, { filename: relPath });
}
// vm.runInContext 执行的顶层 const/let 声明不会挂到 sandbox 对象上（只有 function 声明会），
// 想从外部读取这类常量的值，需要在同一个 context 里再跑一段表达式取值
function ctxEval(expr) {
  return vm.runInContext(expr, sandbox);
}

loadFile('utils.js');
loadFile('dictionary.js');
loadFile('data.js');
loadFile('custom-fields.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}

// ---------- num() ----------
test('num: 空字符串应视为缺失（null），不能被 Number("") === 0 误判为合法的 0', () => {
  assert.strictEqual(sandbox.num(''), null);
  assert.strictEqual(sandbox.num('   '), null);
});
test('num: 正常数字字符串应正确解析', () => {
  assert.strictEqual(sandbox.num('3.14'), 3.14);
  assert.strictEqual(sandbox.num(0), 0);
});
test('num: 0x十六进制地址字符串不应被解析成数字', () => {
  assert.strictEqual(sandbox.num('0x1234abcd'), null);
});
test('num: base58 风格长地址字符串（Solana 地址）不应被解析成数字', () => {
  assert.strictEqual(sandbox.num('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), null);
});

async function main() {

// ---------- flattenObject ----------
test('flattenObject: 空字符串字段展开后应缺失，而不是变成数值 0', () => {
  const out = sandbox.flattenObject({ a: '' });
  assert.strictEqual(out.a, undefined);
});
test('flattenObject: 地址类字段名（如 creator_address）永远不参与数值展开', () => {
  const out = sandbox.flattenObject({ creator_address: '0x1234abcd' });
  assert.strictEqual(out.creator_address, undefined);
});
test('flattenObject: 非地址字段名但值形似地址字符串，应整体丢弃（不进 out 也不进 catOut）', () => {
  const cat = {};
  const out = sandbox.flattenObject({ note: '0x1234abcd' }, '', cat);
  assert.strictEqual(out.note, undefined);
  assert.strictEqual(cat.note, undefined);
});
test('flattenObject: 布尔值应转成 0/1', () => {
  const out = sandbox.flattenObject({ is_fake: true, is_scam: false });
  assert.strictEqual(out.is_fake, 1);
  assert.strictEqual(out.is_scam, 0);
});
test('flattenObject: 嵌套对象应按点号路径展开', () => {
  const out = sandbox.flattenObject({ pool: { liquidity: 100, address: 'xxx' } });
  assert.strictEqual(out['pool.liquidity'], 100);
});
test('flattenObject: 非分类非数值的普通字符串应进入 catOut', () => {
  const cat = {};
  sandbox.flattenObject({ platform: 'pump.fun' }, '', cat);
  assert.strictEqual(cat.platform, 'pump.fun');
});
test('flattenObject: 数组字段应被收集进 arrOut，且不出现在数值特征 out 里（§20.0 聚合能力的前提）', () => {
  const arr = {};
  const out = sandbox.flattenObject({ holders: [{ amount_percentage: 5 }] }, '', {}, arr);
  assert.strictEqual(out.holders, undefined);
  assert.deepStrictEqual(arr.holders, [{ amount_percentage: 5 }]);
});
test('flattenObject: 百分比小数字段应统一 ×100 转成百分比数值', () => {
  const out = sandbox.flattenObject({ stat: { top_10_holder_rate: 0.1234 } }, 'gmgn');
  assert.ok(Math.abs(out['gmgn.stat.top_10_holder_rate'] - 12.34) < 1e-9);
});

// ---------- flattenCtx ----------
test('flattenCtx: ctx.logearn 应被跳过（与 signal 100% 同源重复，已用真实数据核实）', () => {
  const out = sandbox.flattenCtx({ logearn: { mcap: 999 }, gmgn: { holder_count: 10 } });
  assert.strictEqual(out['logearn.mcap'], undefined);
  assert.strictEqual(out['gmgn.holder_count'], 10);
});
test('flattenCtx: 顶层数组字段（如 ctx.holders）应收集进 arrOut', () => {
  const arr = {};
  sandbox.flattenCtx({ holders: [{ a: 1 }] }, {}, arr);
  assert.deepStrictEqual(arr.holders, [{ a: 1 }]);
});

// ---------- buildRows ----------
async function makeMinimalCallSnapshot() {
  const call = { id: 1, token_address: 'TOKEN_A', swap_begin_time: 1000, symbol: 'AAA', initial_mcap: 100, current_mcap: 200, max_mcap: 300 };
  const snapshot = {
    timestamp: 1000,
    signal: { token_address: 'TOKEN_A', swap_begin_time: 1000, symbol: 'AAA', buy_wcoin_amount_d1: 10, sell_wcoin_amount_d1: 5 },
    ctx: {},
  };
  return { call, snapshot };
}
await testAsync('buildRows: 正常样本应正确匹配并计算 returnMax', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].returnMax, 3); // 300/100
  assert.ok(Math.abs(rows[0].features['buy_sell_amount_ratio'] - 2) < 1e-9); // 10/5
});
await testAsync('buildRows: initial_mcap 为 0 的样本应被过滤（避免除以0）', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  call.initial_mcap = 0;
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows.length, 0);
});
await testAsync('buildRows: call 与最近快照时间差超过阈值应被跳过', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.timestamp = call.swap_begin_time + ctxEval('MAX_SNAPSHOT_MATCH_DIFF_SECONDS') + 100;
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows.length, 0);
  assert.strictEqual(sandbox.buildRows.lastSkippedByTimeDiff, 1);
});
await testAsync('buildRows: mcap/fdv/current_mcap 冗余字段应合并只保留 mcap', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.mcap = 500;
  snapshot.signal.fdv = 500;
  snapshot.signal.current_mcap = 500;
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows[0].features.mcap, 500);
  assert.strictEqual(rows[0].features.fdv, undefined);
  assert.strictEqual(rows[0].features.current_mcap, undefined);
});
await testAsync('buildRows: last_alert_low_lower_than_pre_low 应在最近一次 V 转信号最低点更低时记为 1', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.last_alert = { low_price: 0.05, pre_low_price: 0.08 };
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows[0].features.last_alert_low_lower_than_pre_low, 1);
});
await testAsync('buildRows: last_alert_low_lower_than_pre_low 应在未创新低时记为 0', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.last_alert = { low_price: 0.09, pre_low_price: 0.08 };
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows[0].features.last_alert_low_lower_than_pre_low, 0);
});
await testAsync('buildRows: last_alert_low_lower_than_pre_low 在缺少 pre_low_price（只出现过一次 V 转信号）时不应参与，不强行给默认值', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.last_alert = { low_price: 0.05 };
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows[0].features.last_alert_low_lower_than_pre_low, undefined);
});
await testAsync('buildRows: v_turn_current_stage_pct 应取最新生效 V 转信号已突破的最高阶段', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [
    { n_pattern_confirmed: true, signalTime: 100, fibon_break1: 1, fibon_break2: 1, fibon_break3: 0, fibon_break4: 0 },
    { n_pattern_confirmed: true, signalTime: 200, fibon_break1: 1, fibon_break2: 0, fibon_break3: 0, fibon_break4: 0 }, // 更新的信号，只到20%
  ];
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows[0].features.v_turn_current_stage_pct, 20);
});
await testAsync('buildRows: v_turn_current_stage_pct 应在仅回撤确认、还未反弹时记为 0', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [
    { n_pattern_confirmed: true, signalTime: 100, fibon_break1: 0, fibon_break2: 0, fibon_break3: 0, fibon_break4: 0 },
  ];
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows[0].features.v_turn_current_stage_pct, 0);
});
await testAsync('buildRows: v_turn_current_stage_pct 在已反弹突破前高（fibon_break4，已收尾）时不应参与', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [
    { n_pattern_confirmed: true, signalTime: 100, fibon_break1: 1, fibon_break2: 1, fibon_break3: 1, fibon_break4: 1 },
  ];
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows[0].features.v_turn_current_stage_pct, undefined);
});
await testAsync('buildRows: v_turn_break_cost_line_duration_min 应按跌破/涨破成本价之间的K线根数×resolution换算成分钟', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  // 回撤高点 top_price_time=100，对应成本价从 avg_price_bars 回溯取到 60；
  // kline_bars（newest first）从 100 开始：100(70,>=60未跌破) 105(50,跌破,计数开始) 110(55,仍<60)
  // 115(65,涨破,结束，不计入)。跌破期间经历 2 根K线（105、110），resolution=5s → 2*5/60 分钟。
  snapshot.signal.v_breakout_volume_list = [
    { n_pattern_confirmed: true, signalTime: 90, top_price_time: 100, fibon_break4: 0 },
  ];
  snapshot.ctx.kline_and_indicators = {
    resolution: 5,
    current_avg_price: 60,
    avg_price_bars: [{ time: 100, value: 60 }],
    kline_bars: [
      { time: 115, close: 65 },
      { time: 110, close: 55 },
      { time: 105, close: 50 },
      { time: 100, close: 70 },
    ],
  };
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.ok(Math.abs(rows[0].features.v_turn_break_cost_line_duration_min - (2 * 5 / 60)) < 1e-9);
});
await testAsync('buildRows: v_turn_break_cost_line_duration_min 在跌破后到快照时刻仍未涨破（尚未走完）时不应参与', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [
    { n_pattern_confirmed: true, signalTime: 90, top_price_time: 100, fibon_break4: 0 },
  ];
  snapshot.ctx.kline_and_indicators = {
    resolution: 5,
    current_avg_price: 60,
    avg_price_bars: [{ time: 100, value: 60 }],
    kline_bars: [
      { time: 110, close: 55 }, // 仍在成本价以下，还没涨破
      { time: 105, close: 50 },
      { time: 100, close: 70 },
    ],
  };
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows[0].features.v_turn_break_cost_line_duration_min, undefined);
});
await testAsync('buildRows: above_cost_line/cost_line_distance_pct 应在 mcap 高于成本线时记为 1 且距离为正', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.mcap = 150;
  snapshot.ctx.kline_and_indicators = { current_avg_price: 100 };
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows[0].features.above_cost_line, 1);
  assert.ok(Math.abs(rows[0].features.cost_line_distance_pct - 50) < 1e-9); // (150-100)/100*100
});
await testAsync('buildRows: above_cost_line 应在 mcap 低于成本线时记为 0', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.mcap = 80;
  snapshot.ctx.kline_and_indicators = { current_avg_price: 100 };
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows[0].features.above_cost_line, 0);
});
await testAsync('buildRows: v_turn_low_cost_line_distance_pct 应按最低点发生时间从 avg_price_bars 回溯取成本线', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.mcap = 150;
  snapshot.signal.last_alert = { low_price_mcap: 90, low_price_time: 500 };
  snapshot.ctx.kline_and_indicators = {
    current_avg_price: 100, // 快照时刻的成本线，不应被用到（低点发生在更早的时间）
    avg_price_bars: [
      { time: 900, value: 100 }, // newest first
      { time: 400, value: 60 },  // <= 500，应取这一根
      { time: 100, value: 50 },
    ],
  };
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.ok(Math.abs(rows[0].features.v_turn_low_cost_line_distance_pct - 50) < 1e-9); // (90-60)/60*100
});
await testAsync('buildRows: v_turn_low_cost_line_distance_pct 在 avg_price_bars 里找不到历史 bar 时应退回当前成本线', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.mcap = 150;
  snapshot.signal.last_alert = { low_price_mcap: 90, low_price_time: 500 };
  snapshot.ctx.kline_and_indicators = { current_avg_price: 100, avg_price_bars: [] };
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.ok(Math.abs(rows[0].features.v_turn_low_cost_line_distance_pct - (-10)) < 1e-9); // (90-100)/100*100
});

// ---------- pearson / linearRegression / percentile ----------
test('pearson: 完全正相关数据 r 应为 1', () => {
  const pairs = [[1, 2], [2, 4], [3, 6], [4, 8]];
  assert.ok(Math.abs(sandbox.pearson(pairs) - 1) < 1e-9);
});
test('pearson: 完全负相关数据 r 应为 -1', () => {
  const pairs = [[1, 8], [2, 6], [3, 4], [4, 2]];
  assert.ok(Math.abs(sandbox.pearson(pairs) - (-1)) < 1e-9);
});
test('pearson: y 为常量（方差为0）时应返回 0，不应报错或返回 NaN', () => {
  const pairs = [[1, 5], [2, 5], [3, 5]];
  assert.strictEqual(sandbox.pearson(pairs), 0);
});
test('linearRegression: y=2x+1 精确拟合应得到 slope=2, intercept=1', () => {
  const pairs = [[0, 1], [1, 3], [2, 5], [3, 7]];
  const { slope, intercept } = sandbox.linearRegression(pairs);
  assert.ok(Math.abs(slope - 2) < 1e-9);
  assert.ok(Math.abs(intercept - 1) < 1e-9);
});
test('percentile: 中位数应等于排序后数组的中间值', () => {
  const sorted = [1, 2, 3, 4, 5];
  assert.strictEqual(sandbox.percentile(sorted, 0.5), 3);
});
test('WIN_THRESHOLD: "赢"的口径应是 returnMax > 2（翻倍），不是 > 1', () => {
  // returnMax 是期间最大倍数，>1 只要买入后任何一刻高于买入价就成立，几乎全样本命中、胜率没区分度；
  // 这条锁住"翻倍才算赢"的口径，避免以后有人手滑把阈值改回 1
  assert.strictEqual(ctxEval('WIN_THRESHOLD'), 2);
});
test('calcStats: winRate 应按 winThreshold 严格大于计数（等于阈值不算赢）', () => {
  const s = sandbox.calcStats([0.5, 1.5, 2, 2.5, 10], ctxEval('WIN_THRESHOLD'));
  assert.strictEqual(s.positive, 2); // 只有 2.5 和 10 严格大于 2；2 本身不算
  assert.ok(Math.abs(s.winRate - 0.4) < 1e-9);
});
test('spearman: 单调但非线性关系应得到 ρ=1（Pearson r 会明显小于1）', () => {
  const pairs = [[1, 1], [2, 4], [3, 9], [4, 16]]; // y = x^2，单调递增但非线性
  assert.ok(Math.abs(sandbox.spearman(pairs) - 1) < 1e-9);
});

// ---------- #6 log 目标（getFeature） ----------
test('getFeature: logReturnMax 应返回自然对数值', () => {
  const row = { returnMax: Math.E * Math.E, features: {}, categorical: {} };
  assert.ok(Math.abs(sandbox.getFeature(row, 'logReturnMax') - 2) < 1e-9);
});
test('getFeature: returnMax 非正值（脏数据）的 log 目标应返回 undefined，不参与计算', () => {
  const row = { returnMax: -1, features: {}, categorical: {} };
  assert.strictEqual(sandbox.getFeature(row, 'logReturnMax'), undefined);
});

// ---------- computeCorrelations（性能优化：多次行扫描合并为 1 次后的正确性回归） ----------
test('computeCorrelations: 合并行扫描后仍应对每个目标（含 log 目标）算出正确的 r 和 n', () => {
  // x 与 log(returnMax) 完全正相关；最后一行 returnMax 为负（脏数据），returnMax 目标仍收下它，
  // log 目标则跳过，用来验证两个目标的有效样本集合互相独立、不会因为合并扫描而串味
  const rows = [1, 2, 3, 4, 5, 6].map(k => ({
    returnMax: Math.exp(k), features: { x: k }, categorical: {}
  }));
  rows.push({ returnMax: -1, features: { x: 7 }, categorical: {} });
  const list = sandbox.computeCorrelations(rows);
  const rm = list.find(c => c.target === 'returnMax' && c.feature === 'x');
  const logRm = list.find(c => c.target === 'logReturnMax' && c.feature === 'x');
  assert.ok(rm, 'returnMax 应有 x 的相关性结果');
  assert.strictEqual(rm.n, 7);
  assert.ok(logRm, 'logReturnMax 应有 x 的相关性结果');
  assert.strictEqual(logRm.n, 6); // 有一行 returnMax 非正，log 目标不应收下它
  assert.ok(Math.abs(logRm.r - 1) < 1e-9);
});

// ---------- #9 锁定切分（mulberry32 / splitTrainTest） ----------
test('mulberry32: 同一个种子应产生完全相同的随机序列', () => {
  const seq1 = [], seq2 = [];
  const r1 = sandbox.mulberry32(42), r2 = sandbox.mulberry32(42);
  for (let i = 0; i < 5; i++) { seq1.push(r1()); seq2.push(r2()); }
  assert.deepStrictEqual(seq1, seq2);
});
test('splitTrainTest: 随机切分 + 相同种子，重复调用应得到完全相同的训练/测试集划分', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ swapBeginTime: i, tokenAddress: `T${i}` }));
  const s1 = sandbox.splitTrainTest(rows, 'random', 0.7, 'swapBeginTime', 42);
  const s2 = sandbox.splitTrainTest(rows, 'random', 0.7, 'swapBeginTime', 42);
  assert.deepStrictEqual(s1.train.map(r => r.tokenAddress), s2.train.map(r => r.tokenAddress));
  assert.deepStrictEqual(s1.test.map(r => r.tokenAddress), s2.test.map(r => r.tokenAddress));
});
test('splitTrainTest: 不同种子的随机切分大概率产生不同划分（验证种子确实生效，而非退化成固定顺序）', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ swapBeginTime: i, tokenAddress: `T${i}` }));
  const s1 = sandbox.splitTrainTest(rows, 'random', 0.7, 'swapBeginTime', 1);
  const s2 = sandbox.splitTrainTest(rows, 'random', 0.7, 'swapBeginTime', 2);
  assert.notDeepStrictEqual(s1.train.map(r => r.tokenAddress), s2.train.map(r => r.tokenAddress));
});
test('splitTrainTest: 未指定种子时随机切分仍应按比例正确划分训练/测试集大小', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ swapBeginTime: i }));
  const { train, test } = sandbox.splitTrainTest(rows, 'random', 0.7, 'swapBeginTime');
  assert.strictEqual(train.length, 7);
  assert.strictEqual(test.length, 3);
});

// ---------- compileCustomField / 公共函数库 / 聚合函数 ----------
test('compileCustomField: 合法的单表达式公式应正确求值', () => {
  const fn = sandbox.compileCustomField("f['a'] / f['b']");
  const v = sandbox.invokeCustomField(fn, { a: 10, b: 5 }, {}, () => null);
  assert.strictEqual(v, 2);
});
test('compileCustomField: 引用未定义的白名单外函数名应在执行时报错（而不是静默返回错误结果）', () => {
  const fn = sandbox.compileCustomField("notARealFunction(f['a'])");
  assert.throws(() => sandbox.invokeCustomField(fn, { a: 1 }, {}, () => null));
});
test('safeDiv: 除数为0或缺失应返回 null，而不是 Infinity/NaN', () => {
  assert.strictEqual(sandbox.safeDiv(10, 0), null);
  assert.strictEqual(sandbox.safeDiv(10, undefined), null);
  assert.strictEqual(sandbox.safeDiv(10, 5), 2);
});
test('pct: 等价于 safeDiv(a,b)*100', () => {
  assert.strictEqual(sandbox.pct(1, 4), 25);
});
test('clamp: 应把值限制在区间内', () => {
  assert.strictEqual(sandbox.clamp(15, 0, 10), 10);
  assert.strictEqual(sandbox.clamp(-5, 0, 10), 0);
  assert.strictEqual(sandbox.clamp(5, 0, 10), 5);
});
test('log1p: log(1+x)，x<=-1 应返回 null', () => {
  assert.ok(Math.abs(sandbox.log1p(Math.E - 1) - 1) < 1e-9);
  assert.strictEqual(sandbox.log1p(-1), null);
});
test('countWhere: 无条件时应返回数组长度，带条件时按条件计数', () => {
  const arr = [{ v: 1 }, { v: 2 }, { v: 3 }];
  assert.strictEqual(sandbox.countWhere(arr), 3);
  assert.strictEqual(sandbox.countWhere(arr, item => item.v > 1), 2);
});
test('avgField/sumField: 应正确对数组某字段求均值/求和，忽略非数字元素', () => {
  const arr = [{ v: 1 }, { v: 2 }, { v: 'x' }];
  assert.strictEqual(sandbox.sumField(arr, 'v'), 3);
  assert.strictEqual(sandbox.avgField(arr, 'v'), 1.5);
});
test('giniCoefficient: 完全平均分布应接近0，极度集中应接近1', () => {
  const equal = [{ v: 10 }, { v: 10 }, { v: 10 }, { v: 10 }];
  const concentrated = [{ v: 0 }, { v: 0 }, { v: 0 }, { v: 100 }];
  assert.ok(sandbox.giniCoefficient(equal, 'v') < 0.01);
  assert.ok(sandbox.giniCoefficient(concentrated, 'v') > 0.6);
});

} // end main()

main().then(() => {
  console.log(`\n共 ${passed + failed} 个测试，通过 ${passed} 个，失败 ${failed} 个。`);
  process.exit(failed ? 1 : 0);
});
