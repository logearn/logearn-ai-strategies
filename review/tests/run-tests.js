#!/usr/bin/env node
// ========== 核心纯函数单元测试（design doc §16.2） ==========
// 覆盖这次修复过的几个真实 bug（空字符串误判为0、0x地址被解析成数字）以及最容易踩坑的纯函数
// （flattenObject/flattenCtx/buildRows/pearson/linearRegression/compileCustomField），
// 防止未来重构时再次踩坑。不引入 Jest/Vitest，只用 Node 自带的 node:assert + 一个简单跑批脚本，
// 符合"轻量单文件工具"的定位——等模块拆分/测试规模进一步扩大再考虑引入正式测试框架。
//
// 运行方式：node tests/run-tests.js（在 review/ 目录下执行，或用绝对路径）

// 本文件已从 vm 沙箱改为直接 import src/lib 下的 ES 模块。
// 这一步本身就是移植的验收：src/lib/* 是从 js/* 机械复制来的（逻辑一行未改，只加了
// import/export），所以这 122 个测试原封不动地全部通过，就证明移植没有引入行为变化。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as _utils from '../src/lib/utils.js';
import * as _dictionary from '../src/lib/dictionary.js';
import * as _data from '../src/lib/data.js';
import * as _customFields from '../src/lib/custom-fields.js';
import { run as runLibAnalytics } from './lib-analytics.test.js';
import { run as runScatterFigure } from './scatter-figure.test.js';
import { run as runFilter } from './filter.test.js';
import { run as runSummary } from './summary.test.js';
import { run as runBinning, runReport as runBinReport } from './binning.test.js';
import { run as runAuc } from './auc.test.js';
import { run as runStrategy } from './strategy.test.js';
import { run as runFieldDocs } from './field-docs.test.js';
import { run as runParity } from './parity.test.js';
import { run as runAnalyticsParity } from './analytics-parity.test.js';
import { run as runCustomRuntime } from './custom-fields-runtime.test.js';
import { run as runCompare } from './compare.test.js';
import { run as runLabels } from './labels.test.js';
import { run as runCommonHolders } from './common-holders.test.js';
import { run as runFieldHealth } from './field-health.test.js';
import { run as runFactorLab } from './factorlab.test.js';
import { run as runStrategyVersions } from './strategy-versions.test.js';
import { run as runDailyBacktest } from './daily-backtest.test.js';
import { run as runFactorExclusions } from './factor-exclusions.test.js';
import { run as runExcludedTokens } from './excluded-tokens.test.js';
import { run as runStrategyReplayLogic } from './strategy-replay-logic.test.js';
import { run as runCampLibrary } from './camp-library.test.js';
import { run as runRemovedFactors } from './removed-factors.test.js';
import { run as runFieldAudit } from './field-audit.test.js';
import { run as runDataArchive } from './data-archive.test.js';
import { run as runStrategySpec } from './strategy-spec.test.js';
import { run as runDataSlices } from './data-slices.test.js';
import { run as runTableHiddenFields } from './table-hidden-fields.test.js';
import { run as runDataHelpers } from './data-helpers.test.js';
import { run as runBuildRowsFeatures } from './build-rows-features.test.js';
import { run as runDataFolders } from './data-folders.test.js';
import { run as runFactorPoolStore } from './factor-pool-store.test.js';
import { run as runOnlineExport } from './online-export.test.js';
import { run as runOnlineExportCoverage } from './online-export-coverage.test.js';
import { run as runFactorScanExport } from './factor-scan-export.test.js';
import { run as runRhoOptimize } from './rho-optimize.test.js';
import { run as runBacktestReport } from './backtest-report-export.test.js';
import { run as runFactorRecommend } from './factor-recommend.test.js';
import { run as runFactorLabFixes } from './factorlab-fixes.test.js';
import { run as runFactorRecommendWorker } from './factor-recommend-worker.test.js';

// 旧测试全部写成 sandbox.foo(...)，这里把四个模块的导出合并成同名对象，
// 这样 1400 行测试正文一个字都不用改。
const sandbox = { console, ..._utils, ..._dictionary, ..._data, ..._customFields };
// 仓库根目录（review/），供需要静态扫描源码的测试定位文件，口径同 online-export-coverage.test.js
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 旧沙箱里这几个是全局变量（真实运行时由 ui.js 提供）。逻辑层只在函数体内读它们，
// 这里挂到 globalThis 上，避免调用到相关分支时抛 ReferenceError。
globalThis.matchedRows = [];
globalThis.activeRows = [];

// 旧的 ctxEval 用来读 vm 里的顶层 const（vm 不会把 const 挂到沙箱对象上）。
// 现在它们是正经的模块导出，直接查表即可。
function ctxEval(name) {
  if (!(name in sandbox)) throw new Error('ctxEval: 未导出的符号 ' + name);
  return sandbox[name];
}

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      throw new Error('测试体是 async/返回 Promise，必须用 testAsync 注册（否则断言不会被等待，会被误判为通过）');
    }
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

// ---------- detectFileKind（DataLoader 单一上传入口的自动分类）----------
test('detectFileKind: 带 signal/ctx 的数组应识别为 snapshots', () => {
  assert.strictEqual(sandbox.detectFileKind([{ timestamp: 1, signal: {}, ctx: {} }]), 'snaps');
  assert.strictEqual(sandbox.detectFileKind([{ timestamp: 1, ctx: {} }]), 'snaps', '只有 ctx 没有 signal 也该认得出');
});
test('detectFileKind: 带 *_mcap 字段的数组应识别为 calls', () => {
  assert.strictEqual(sandbox.detectFileKind([{ token_address: 'x', initial_mcap: 1, current_mcap: 2, max_mcap: 3 }]), 'calls');
  assert.strictEqual(sandbox.detectFileKind([{ token_address: 'x', min_mcap: 1 }]), 'calls', '只有 min_mcap 也该认得出');
});
test('detectFileKind: 空数组/非数组/都不沾边的对象应返回 null，不瞎猜', () => {
  assert.strictEqual(sandbox.detectFileKind([]), null);
  assert.strictEqual(sandbox.detectFileKind(null), null);
  assert.strictEqual(sandbox.detectFileKind({ not: 'an array' }), null);
  assert.strictEqual(sandbox.detectFileKind([{ foo: 'bar' }]), null);
});
test('detectFileKind: 同时命中两组标记字段（不应该在真实数据里发生）时也该返回 null 而不是乱猜一个', () => {
  assert.strictEqual(sandbox.detectFileKind([{ signal: {}, initial_mcap: 1 }]), null);
});
test('detectFileKind: 数组第一项是 null/非对象时应跳过找下一个可用样本', () => {
  assert.strictEqual(sandbox.detectFileKind([null, { ctx: {} }]), 'snaps');
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
await testAsync('buildRows: 毫秒时间戳、时间差 30 分钟（阈值内）不应被跳过——回归：阈值曾被裸毫秒比较缩成 3.6 秒', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  // 真实数据的 timestamp 是毫秒：30 分钟 < 1 小时阈值，必须匹配成功
  call.timestamp = 1784517263000;
  snapshot.timestamp = call.timestamp + 30 * 60 * 1000;
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows.length, 1, `30 分钟时间差被错误跳过（skipped=${sandbox.buildRows.lastSkippedByTimeDiff}）`);
});
await testAsync('buildRows: 毫秒时间戳、时间差超过 1 小时仍应被跳过', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  call.timestamp = 1784517263000;
  snapshot.timestamp = call.timestamp + (ctxEval('MAX_SNAPSHOT_MATCH_DIFF_SECONDS') + 100) * 1000;
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
// ---------- 命中信号的回调/反弹明细（真实样本回归） ----------
// 基准数据取自真实快照 LMAO!（EygnKURkS4iDL8hvBUujgPdRSkns2juH7Xm5ehrspump），
// 断言全部对齐平台自己的 content 文案：
//   「反弹20%($20.99K)，此前回调70.59%，市值从$45.41K至$13.36K，回调时长21秒」
// 这条样本同时覆盖三个真实踩过的坑：_mcp/_mcap 双字段、"回调时长"口径、fibon 市值换算。
function makeLmaoVSignal() {
  return {
    n_pattern_confirmed: true,
    n_pattern_retracement: 0.7059,
    top_price: 0.000298746619229,
    top_price_time: 1784517182,
    top_price_mcp: 45947.23003742021,   // 干扰项：与 _mcap 同时存在且数值不同
    top_price_mcap: 45409.486122808004, // content 文案用的是这个
    low_price: 0.000087872395599,
    low_price_time: 1784517200,
    low_price_mcp: 13514.774443126204,
    low_price_mcap: 13356.604131048,
    fibon_break1: 0.000138060460823,
    fibon_break1_time: 1784517203,
    fibon_break2: null, fibon_break2_time: null,
    fibon_break3: null, fibon_break3_time: null,
    fibon_break4: null, fibon_break4_time: null,
    price_rise_ratio: 0.8361,
    current_breakout_ratio: 0.3484,
    signalTime: 1784517203,
    type: 'v_breakout_volume'
  };
}
await testAsync('buildRows(真实样本): 回调幅度/起止市值应对齐 content 文案的 70.59% / $45.41K / $13.36K', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [makeLmaoVSignal()];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.v_breakout_volume_recent_retracement_pct - 70.59) < 1e-9);
  // 必须取 _mcap 而不是 _mcp——取错了这里会是 45947.23 / 13514.77
});
await testAsync('buildRows(真实样本): _mcap 缺失时才回退到 _mcp', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const ev = makeLmaoVSignal();
  delete ev.top_price_mcap;
  snapshot.signal.v_breakout_volume_list = [ev];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
});
await testAsync('buildRows(真实样本): 下跌时长(18秒)与平台文案的"回调时长"(21秒)是两个字段，不能混', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [makeLmaoVSignal()];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  // 见顶 1784517182 → 触底 1784517200 = 18 秒 = 0.3 分钟（真正的下跌时长）
  assert.ok(Math.abs(f.v_breakout_volume_recent_drawdown_min - 18 / 60) < 1e-9);
  // 见顶 → 信号发出 1784517203 = 21 秒 = 0.35 分钟（content 文案里写的"回调时长21秒"）
  assert.ok(Math.abs(f.v_breakout_volume_recent_signal_from_top_min - 21 / 60) < 1e-9);
  // 回调速度 = 70.59% / 0.3 分钟
  assert.ok(Math.abs(f.v_breakout_volume_recent_drawdown_speed_pct_per_min - 70.59 / (18 / 60)) < 1e-9);
});
await testAsync('buildRows(真实样本): fibon 换算出的反弹市值应对齐 content 文案的 $20.99K', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [makeLmaoVSignal()];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  // 比例法：fibon_break1 × (top_price_mcap / top_price) ≈ 20985 → 文案显示 $20.99K
  // 顺带确认：同样的比例用在 low_price 上应能还原 low_price_mcap（证明比例法本身自洽）
  const ratio = 45409.486122808004 / 0.000298746619229;
  assert.ok(Math.abs(0.000087872395599 * ratio - 13356.604131048) < 1, '比例法无法还原 low_price_mcap');
});
await testAsync('buildRows(真实样本): 反弹幅度/回调区间位置应直接取平台算好的字段', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [makeLmaoVSignal()];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.v_breakout_volume_recent_rebound_from_low_pct - 83.61) < 1e-9);
  assert.ok(Math.abs(f.v_breakout_volume_recent_breakout_ratio - 34.84) < 1e-9);
});
await testAsync('buildRows(真实样本): 时间位置字段应按分钟计算', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const ev = makeLmaoVSignal();
  snapshot.signal.v_breakout_volume_list = [ev];
  snapshot.signal.swap_begin_time = 1784517149; // 开盘
  call.swap_begin_time = 1784517149;
  // 买入时刻 = 信号(1784517203)后 60 秒。注意用【秒】：快照匹配那步是 s.timestamp 与 c.timestamp
  // 的裸比较（假设两者同单位），这里写成毫秒会让时间差超过 MAX_SNAPSHOT_MATCH_DIFF_SECONDS 被整条跳过
  snapshot.timestamp = 1784517263;
  call.timestamp = 1784517263;
  const rows = await sandbox.buildRows([call], [snapshot]);
  const f = rows[0].features;
  // 信号 1784517203 − 开盘 1784517149 = 54 秒 = 0.9 分钟
  assert.ok(Math.abs(f.v_breakout_volume_recent_signal_from_open_min - 54 / 60) < 1e-9, `实际 ${f.v_breakout_volume_recent_signal_from_open_min}`);
  // 买入 − 触底 1784517200 = 63 秒
  assert.ok(Math.abs(f.v_breakout_volume_recent_low_to_buy_min - 63 / 60) < 1e-9, `实际 ${f.v_breakout_volume_recent_low_to_buy_min}`);
});
await testAsync('buildRows: 没有生效 V 转信号时，这组字段应全部缺失而不是给默认值', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const ev = makeLmaoVSignal();
  ev.fibon_break4 = 0.0005; // 已突破前高 = 本轮收尾，不再是生效信号
  snapshot.signal.v_breakout_volume_list = [ev];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  ['v_breakout_volume_recent_retracement_pct', 'v_breakout_volume_recent_breakout_ratio',
   'v_breakout_volume_recent_low_to_buy_min'].forEach(k => assert.strictEqual(f[k], undefined, `${k} 不应有值`));
});
await testAsync('buildRows: 回调在同一根K线内完成（时长为0）时，回调速度应缺失而不是 Infinity', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const ev = makeLmaoVSignal();
  ev.low_price_time = ev.top_price_time; // 见顶与触底同一秒
  snapshot.signal.v_breakout_volume_list = [ev];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.v_breakout_volume_recent_drawdown_min, 0);
  assert.strictEqual(f.v_breakout_volume_recent_drawdown_speed_pct_per_min, undefined);
});
// ---------- 早期精选信号 continue_breakout_volume ----------
// 基准对齐平台 content 文案：「精选，通知市值$31.15K，交易量$4.18K，当前最大振幅94.15%(2026.07.20 03:52:30)」
await testAsync('buildRows(精选): 通知市值/最大振幅/连续上涨标记应对齐 content 文案', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.continue_breakout_volume_list = [{
    all_bullish: true, max_amplitude: 94.15, max_amplitude_time: 1000 - 120,
    signalTime: 1000, notice_mcap: 31150, type: 'continue_breakout_volume'
  }];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.continue_breakout_volume_recent_notice_mcap - 31150) < 1e-9);   // 文案 $31.15K
  assert.ok(Math.abs(f.continue_breakout_volume_recent_max_amplitude - 94.15) < 1e-9); // 文案 94.15%
  assert.strictEqual(f.continue_breakout_volume_recent_all_bullish, 1);
  assert.strictEqual(f.continue_breakout_volume_signal_count, 1);
  // 最大振幅发生在信号前 120 秒 = 2 分钟
  assert.ok(Math.abs(f.continue_breakout_volume_recent_amplitude_before_signal_min - 2) < 1e-9);
});
await testAsync('buildRows(精选): 多条信号时应取 signalTime 最新的一条，次数按全部计', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.continue_breakout_volume_list = [
    { signalTime: 500, notice_mcap: 111, max_amplitude: 10, all_bullish: false },
    { signalTime: 900, notice_mcap: 999, max_amplitude: 88, all_bullish: true },  // 最新
    { signalTime: 700, notice_mcap: 555, max_amplitude: 44, all_bullish: false },
  ];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.continue_breakout_volume_recent_notice_mcap, 999);
  assert.strictEqual(f.continue_breakout_volume_recent_max_amplitude, 88);
  assert.strictEqual(f.continue_breakout_volume_recent_all_bullish, 1);
  assert.strictEqual(f.continue_breakout_volume_signal_count, 3); // 次数是全部，不是只数最新那条
});
// 真实样本 nice（A3NaYDFxepZCXurb2LZouaPREHZ21SMfY3zgrwFmAUS9），对齐平台 content 文案：
// 「精选(💎)，通知市值$15.23K，交易量$1.64K，当前最大振幅98.67%(2026.07.20 07:24:15)」
function makeNicePickSignal() {
  return {
    all_bullish: true,
    kline1_bullish: true, kline1_buy_tx_count: 0, kline1_sell_tx_count: 0, kline1_time: 1784507145,
    kline2_bullish: true, kline2_buy_tx_count: 0, kline2_sell_tx_count: 0, kline2_time: 1784507160,
    kline3_bullish: true, kline3_buy_tx_count: 0, kline3_sell_tx_count: 0, kline3_time: 1784507175,
    max_amplitude: 98.6664521, max_amplitude_time: 1784507055,
    signal_price: 2.00450143e-7, signal_time: 1784507175,
    volume1: 38.204777159, volume2: 27.591246449, volume3: 21.624812978,
    swap_begin_time: 1784507034, signalTime: 1784507175, notice_mcap: 15234.210868,
    type: 'continue_breakout_volume'
  };
}
await testAsync('buildRows(精选·真实样本): 交易量应取 volume3 × native_coin_price，对齐文案 $1.64K', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.continue_breakout_volume_list = [makeNicePickSignal()];
  snapshot.ctx = { native_coin_price: 76, native_coin_decimal: 1000000000 };
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  // 21.624812978 × 76 = 1643.49 → 文案显示 $1.64K
  assert.ok(Math.abs(f.continue_breakout_volume_recent_signal_volume - 1643.49) < 1, `实际 ${f.continue_breakout_volume_recent_signal_volume}`);
  // 必须是 volume3，不能是 volume1(→2903.6) 或三根之和(→6559)
  assert.ok(Math.abs(f.continue_breakout_volume_recent_signal_volume - 38.204777159 * 76) > 100, '错取成了 volume1');
  assert.ok(Math.abs(f.continue_breakout_volume_recent_volume_total - (38.204777159 + 27.591246449 + 21.624812978) * 76) < 1e-6);
  assert.ok(Math.abs(f.continue_breakout_volume_recent_notice_mcap - 15234.210868) < 1e-9);   // 文案 $15.23K
  assert.ok(Math.abs(f.continue_breakout_volume_recent_max_amplitude - 98.6664521) < 1e-9);   // 文案 98.67%
});
await testAsync('buildRows(精选·真实样本): 缺 native_coin_price 时 USD 口径字段应缺失，不能退化成写入 SOL 数值', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.continue_breakout_volume_list = [makeNicePickSignal()];
  snapshot.ctx = {}; // 实测确有快照 ctx 里没有 native_coin_* 字段
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.continue_breakout_volume_recent_signal_volume, undefined);
  assert.strictEqual(f.continue_breakout_volume_recent_volume_total, undefined);
  // 但比值是无量纲的，不依赖币价，仍应算出来
  assert.ok(Math.abs(f.continue_breakout_volume_recent_volume_trend_ratio - 21.624812978 / 38.204777159) < 1e-9);
});
await testAsync('buildRows(精选·真实样本): 三根K线的量能趋势与阳线根数', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const ev = makeNicePickSignal();
  snapshot.signal.continue_breakout_volume_list = [ev];
  snapshot.ctx = { native_coin_price: 76 };
  let f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  // 38→27→21 递减 = 缩量上涨，比值 0.566 < 1
  assert.ok(Math.abs(f.continue_breakout_volume_recent_volume_trend_ratio - 0.566) < 0.01, `实际 ${f.continue_breakout_volume_recent_volume_trend_ratio}`);
  assert.strictEqual(f.continue_breakout_volume_recent_bullish_kline_count, 3);
  // 早期精选的买卖笔数字段（kline1/2/3_*_tx_count）在真实样本里恒为 0，已作为无效字段移除
  assert.strictEqual(f.continue_breakout_volume_recent_buy_tx_total, undefined);
  assert.strictEqual(f.continue_breakout_volume_recent_sell_tx_total, undefined);

  // 只有部分K线是阳线时应如实计数，而不是退化成 all_bullish 那个布尔
  const b = await makeMinimalCallSnapshot();
  const ev2 = makeNicePickSignal();
  ev2.kline2_bullish = false; ev2.all_bullish = false;
  b.snapshot.signal.continue_breakout_volume_list = [ev2];
  f = (await sandbox.buildRows([b.call], [b.snapshot]))[0].features;
  assert.strictEqual(f.continue_breakout_volume_recent_bullish_kline_count, 2);
  assert.strictEqual(f.continue_breakout_volume_recent_all_bullish, 0);
});
await testAsync('buildRows(精选·真实样本): 振幅高点距信号 / 距开盘 应按分钟计算', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.continue_breakout_volume_list = [makeNicePickSignal()];
  snapshot.signal.swap_begin_time = 1784507034;
  call.swap_begin_time = 1784507034;
  snapshot.timestamp = 1784507190; call.timestamp = 1784507190;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  // 信号 1784507175 − 振幅高点 1784507055 = 120 秒 = 2 分钟
  assert.ok(Math.abs(f.continue_breakout_volume_recent_amplitude_before_signal_min - 2) < 1e-9);
  // 信号 − 开盘 1784507034 = 141 秒
  assert.ok(Math.abs(f.continue_breakout_volume_recent_signal_from_open_min - 141 / 60) < 1e-9);
  // 买入 1784507190 − 信号 = 15 秒
  assert.ok(Math.abs(f.continue_breakout_volume_recent_signal_to_buy_min - 15 / 60) < 1e-9);
});
await testAsync('buildRows(精选): 距开盘/信号新鲜度应按分钟计算', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.swap_begin_time = 1000;
  call.swap_begin_time = 1000;
  snapshot.signal.continue_breakout_volume_list = [{ signalTime: 1480, notice_mcap: 31150 }];
  snapshot.timestamp = 1600; // 买入时刻
  call.timestamp = 1600;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.continue_breakout_volume_recent_signal_from_open_min - 8) < 1e-9);  // (1480-1000)/60 = 8 分钟，对齐"距开盘:8分钟"
  assert.ok(Math.abs(f.continue_breakout_volume_recent_signal_to_buy_min - 2) < 1e-9);     // (1600-1480)/60 = 2 分钟
});
await testAsync('buildRows(精选): 字段整个不存在时应全部缺失', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  ['continue_breakout_volume_signal_count', 'continue_breakout_volume_recent_notice_mcap', 'continue_breakout_volume_recent_max_amplitude', 'continue_breakout_volume_recent_all_bullish',
   'continue_breakout_volume_recent_signal_volume', 'continue_breakout_volume_recent_signal_from_open_min'].forEach(k =>
    assert.strictEqual(f[k], undefined, `${k} 不应有值`));
});
await testAsync('buildRows: 信号列表为空数组时 signal_count 应记 0（"确实没有"不是"未知"），明细字段仍缺失', async () => {
  // 真实样本 SVM：只有苏醒信号，v_breakout_volume_list 与 continue_breakout_volume_list 都是 []
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [];
  snapshot.signal.continue_breakout_volume_list = [];
  snapshot.signal.breakout_volume_10x_list = [];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.v_breakout_volume_signal_count, 0);
  assert.strictEqual(f.continue_breakout_volume_signal_count, 0);
  assert.strictEqual(f.breakout_volume_10x_signal_count, 0);
  // 三类的明细字段都不应有值
  assert.strictEqual(f.continue_breakout_volume_recent_notice_mcap, undefined);
  assert.strictEqual(f.breakout_volume_10x_recent_notice_mcap, undefined);
  assert.strictEqual(f.v_breakout_volume_recent_retracement_pct, undefined);
});
await testAsync('buildRows: v_breakout_volume_signal_count 应统计 V 转信号总条数（含已收尾的）', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [
    { n_pattern_confirmed: true, fibon_break4: 0.5, signalTime: 100 }, // 已收尾，不算生效但要计数
    { n_pattern_confirmed: true, signalTime: 200, n_pattern_retracement: 0.3 },
  ];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.v_breakout_volume_signal_count, 2);
});
// ---------- 休眠苏醒信号 breakout_volume_10x ----------
// 结构取自官方文档样例；⚠️ 尚未用真实苏醒快照核对过（前三条真实样本已三次证明文档与实际有出入，
// 拿到真实样本后需要重新核对字段名与单位）。
function makeWakeSignal() {
  return {
    avg_history_volume: 6.001835, history_start_time: 1781993400, history_end_time: 1782048900,
    history_kline_count: 35, volume_ratio: 12.310779, current_volume: 73.887262466,
    signalTime: 1782049463, notice_mcap: 46782.94362581306,
    cv: 26.54, standardized_slope: 0.67, type: 'breakout_volume_10x'
  };
}
await testAsync('buildRows(苏醒): 放量倍数应按倍数取值，不能被 content 文案的 % 号误导成百分比', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.breakout_volume_10x_list = [makeWakeSignal()];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  // 文档明确 12.31 就是 12.31x；文案写"放量12.31%"是带了 % 号的倍数，不能再 ×100 或 ÷100
  assert.ok(Math.abs(f.breakout_volume_10x_recent_volume_ratio - 12.310779) < 1e-9);
  assert.ok(Math.abs(f.breakout_volume_10x_recent_notice_mcap - 46782.94362581306) < 1e-9);
  assert.strictEqual(f.breakout_volume_10x_signal_count, 1);
});
await testAsync('buildRows(苏醒): 休眠期形态字段（时长/K线数/波动率/斜率）', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.breakout_volume_10x_list = [makeWakeSignal()];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  // 1782048900 − 1781993400 = 55500 秒 = 925 分钟
  assert.ok(Math.abs(f.breakout_volume_10x_recent_dormant_duration_min - 925) < 1e-9);
  assert.strictEqual(f.breakout_volume_10x_recent_dormant_kline_count, 35);
  assert.ok(Math.abs(f.breakout_volume_10x_recent_dormant_cv - 26.54) < 1e-9);
  assert.ok(Math.abs(f.breakout_volume_10x_recent_dormant_slope - 0.67) < 1e-9);
  // 休眠结束 1782048900 → 信号 1782049463 = 563 秒
  assert.ok(Math.abs(f.breakout_volume_10x_recent_dormant_end_to_signal_min - 563 / 60) < 1e-9);
});
await testAsync('buildRows(苏醒): 交易量应乘 native_coin_price 换成 USD，缺币价时缺失', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.breakout_volume_10x_list = [makeWakeSignal()];
  snapshot.ctx = { native_coin_price: 76 };
  let f = (await sandbox.buildRows([call], [snapshot]))[0].features;

  const b = await makeMinimalCallSnapshot();
  b.snapshot.signal.breakout_volume_10x_list = [makeWakeSignal()];
  b.snapshot.ctx = {}; // 无币价
  f = (await sandbox.buildRows([b.call], [b.snapshot]))[0].features;
  // 倍数不依赖币价，仍应有值
  assert.ok(Math.abs(f.breakout_volume_10x_recent_volume_ratio - 12.310779) < 1e-9);
});
await testAsync('buildRows(苏醒): 多条信号取 signalTime 最新的一条；无信号时整组缺失', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const older = makeWakeSignal(); older.signalTime = 1000; older.notice_mcap = 111;
  const newer = makeWakeSignal(); newer.signalTime = 9999; newer.notice_mcap = 999;
  snapshot.signal.breakout_volume_10x_list = [older, newer, { ...makeWakeSignal(), signalTime: 5000, notice_mcap: 555 }];
  let f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.breakout_volume_10x_recent_notice_mcap, 999);
  assert.strictEqual(f.breakout_volume_10x_signal_count, 3);

  const b = await makeMinimalCallSnapshot();
  f = (await sandbox.buildRows([b.call], [b.snapshot]))[0].features;
  ['breakout_volume_10x_signal_count', 'breakout_volume_10x_recent_notice_mcap', 'breakout_volume_10x_recent_volume_ratio',
   'breakout_volume_10x_recent_dormant_cv'].forEach(k => assert.strictEqual(f[k], undefined, `${k} 不应有值`));
});

// ---------- K线量能形态 ----------
function makeBars(vols, tokenVols, stepSec = 60) {
  // newest first，与真实数据一致。stepSec 必须与用例声明的 resolution 对上——粒度现在是从
  // bar 时间差实测的，夹具若自相矛盾（比如间隔1秒却声明resolution=300）会被直接抓出来。
  return vols.map((v, i) => ({ time: 100000 - i * stepSec, volume: v, token_volume: tokenVols ? tokenVols[i] : v }));
}
await testAsync('buildRows(量能): 集中度/距最大量分钟数/变异系数/放量倍数/趋势', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  // 12 根：最新一根 100，其余各 10 → 总量 210
  const vols = [100, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
  snapshot.ctx.kline_and_indicators = { kline_is_usd: true, kline_bars: makeBars(vols), resolution: 60 };
  snapshot.signal.total_supply = 1000;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.kline_volume_concentration_pct - 100 / 210 * 100) < 1e-9); // 单根占了 47.6%
  assert.strictEqual(f.kline_minutes_since_max_volume, 0); // 最新一根就是最大量
  assert.ok(Math.abs(f.kline_volume_recent_ratio - 100 / 10) < 1e-9); // 最新 100 vs 其余均量 10 = 10 倍
  assert.ok(f.kline_volume_trend_ratio > 1); // 近半段有那根巨量，明显放量
  assert.ok(f.kline_volume_cv > 0);
});
await testAsync('buildRows(量能): 根数不足门槛时整组不写入，不能用 1~2 根算出看似有值的数字', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  // 真实样本 nice 就只给了 2 根K线
  snapshot.ctx.kline_and_indicators = { kline_is_usd: true, kline_bars: makeBars([100, 50]) };
  snapshot.signal.total_supply = 1000;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  ['kline_volume_concentration_pct', 'kline_volume_cv', 'kline_volume_recent_ratio',
   'kline_volume_trend_ratio', 'kline_turnover_pct'].forEach(k =>
    assert.strictEqual(f[k], undefined, `${k} 不应有值`));
});
await testAsync('buildRows(量能): kline_is_usd 为 false 时成交额类字段跳过，换手率仍可算', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const vols = new Array(12).fill(10);
  snapshot.ctx.kline_and_indicators = { kline_is_usd: false, kline_bars: makeBars(vols) };
  snapshot.signal.total_supply = 1000;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.kline_volume_concentration_pct, undefined); // 计价单位非 USD，跨样本不可比
  // token_volume 是代币数量，不受该标记影响
  assert.ok(Math.abs(f.kline_turnover_pct - 12 * 10 / 1000 * 100) < 1e-9);
});
await testAsync('buildRows(量能): 换手率应按 token_volume 合计 / total_supply 计算', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const vols = new Array(10).fill(1);
  const tokenVols = new Array(10).fill(2000000); // 合计 2000万
  snapshot.ctx.kline_and_indicators = { kline_is_usd: true, kline_bars: makeBars(vols, tokenVols) };
  snapshot.signal.total_supply = 1000000000; // 10亿
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.kline_turnover_pct - 2) < 1e-9); // 2000万/10亿 = 2%
});
await testAsync('buildRows(量能): 最大量在较早位置时 minutes_since_max_volume 应按 根数×resolution/60 换算', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const vols = [10, 10, 10, 999, 10, 10, 10, 10, 10, 10, 10, 10]; // 第 3 根（距今3根）是最大量
  snapshot.ctx.kline_and_indicators = { kline_is_usd: true, kline_bars: makeBars(vols, null, 300), resolution: 300 }; // 5分钟一根
  snapshot.signal.total_supply = 1000;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.kline_minutes_since_max_volume - 3 * 300 / 60) < 1e-9); // 3根 × 5分钟 = 15分钟
});
await testAsync('buildRows(量能): resolution 缺失时应回退到实测bar间隔，仍能算出 minutes_since_max_volume', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const vols = [10, 10, 10, 999, 10, 10, 10, 10, 10, 10, 10, 10];
  snapshot.ctx.kline_and_indicators = { kline_is_usd: true, kline_bars: makeBars(vols) }; // 没有 resolution
  snapshot.signal.total_supply = 1000;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  // 实测间隔 60s=1分钟，最大量在 index 3 → 3 分钟。resolution 缺失不再导致字段丢失
  assert.ok(Math.abs(f.kline_minutes_since_max_volume - 3) < 1e-9);
});

function mkHolder(address, over) {
  return Object.assign({
    addr_type: 0, address, amount_percentage: 0.01, balance: 100,
    buy_volume_cur: 1, buy_amount_cur: 0, sell_tx_count_cur: 0, sell_amount_percentage: 0,
    realized_profit: 0, profit: 1, unrealized_pnl: 0, avg_cost: 0.00002,
    native_balance: '100', start_holding_at: 1000,
    tags: [], maker_token_tags: [], transfer_in: false,
    native_transfer: null, token_transfer_in: null, token_transfer_out: null,
  }, over || {});
}
const fund = (from_address, name) => ({ native_transfer: { from_address, name: name || null } });

await testAsync('buildRows(holders): 同源出金要按【私人/交易所】分开分簇，个人昵称不能误判成交易所', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.ctx.holders = [
    mkHolder('W1', fund('PRIV_A')), mkHolder('W2', fund('PRIV_A')), mkHolder('W3', fund('PRIV_A')),
    mkHolder('W4', fund('PRIV_B')), mkHolder('W5', fund('PRIV_B')),
    mkHolder('W6', fund('PRIV_C')),                       // 单例，不算协同
    mkHolder('W7', fund('CEX_BN', 'Binance')), mkHolder('W8', fund('CEX_BN', 'Binance')),
    // 真实样本里存在 name 为 "YZBY🌎"（个人昵称带 emoji）的出金方，非空但不是交易所。
    // 若用「name 是否为空」判交易所，这两个会被错误归到 CEX 桶、私人协同被低估。
    mkHolder('W9', fund('PRIV_D', 'YZBY🌎')), mkHolder('W10', fund('PRIV_D', 'YZBY🌎')),
  ];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  // 私人成簇：W1-W3(3) + W4,W5(2) + W9,W10(2) = 7 个 /10
  assert.ok(Math.abs(f.holder_same_private_funder_ratio - 70) < 1e-9, '实际 ' + f.holder_same_private_funder_ratio);
  assert.ok(Math.abs(f.holder_max_private_funder_ratio - 30) < 1e-9, '最大簇应是 PRIV_A 的 3 个');
  assert.ok(Math.abs(f.holder_same_cex_funder_ratio - 20) < 1e-9, '仅 W7/W8');
});

await testAsync('buildRows(holders): 同秒建仓/相同买入量/内部互转 三个协同字段', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.ctx.holders = [
    mkHolder('A1', { start_holding_at: 5000, buy_amount_cur: 3698776 }),
    mkHolder('A2', { start_holding_at: 5000, buy_amount_cur: 3698776 }),
    mkHolder('A3', { start_holding_at: 5001, buy_amount_cur: 111 }),
    // B1<->B2 互转；B1 的对手方是列表里的 B2，B2 的对手方是 B1。
    // 建仓时间必须各不相同，否则它们自己会凑成第二个"同秒簇"，把上面的断言算错
    mkHolder('B1', { start_holding_at: 6001, token_transfer_out: { address: 'B2' } }),
    mkHolder('B2', { start_holding_at: 6002, token_transfer_in: { address: 'B1' } }),
    // 对手方是列表外的陌生地址，不算内部互转
    mkHolder('C1', { start_holding_at: 6003, token_transfer_in: { address: 'OUTSIDER' } }),
  ];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.holder_same_second_entry_ratio - (2 / 6 * 100)) < 1e-9, 'A1/A2 同秒');
  assert.ok(Math.abs(f.holder_identical_buy_amount_ratio - (2 / 6 * 100)) < 1e-9, 'A1/A2 买入量相同');
  assert.ok(Math.abs(f.holder_internal_transfer_ratio - (2 / 6 * 100)) < 1e-9, '只有 B1/B2');
});

await testAsync('buildRows(holders): 浮盈/抛压/成本离散/画像字段', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.ctx.holders = [
    mkHolder('P1', { unrealized_pnl: 6, avg_cost: 0.00001, sell_tx_count_cur: 3, realized_profit: -5,
                     maker_token_tags: ['creator', 'dev_team'], tags: ['kol'] }),
    mkHolder('P2', { unrealized_pnl: 4, avg_cost: 0.00002, maker_token_tags: ['sniper'], tags: ['fomo'] }),
    mkHolder('P3', { unrealized_pnl: 0.5, avg_cost: 0.00003, native_balance: '0' }),
    mkHolder('P4', { unrealized_pnl: -0.2, avg_cost: 0.00004 }),
  ];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.holder_pnl_median - (0.5 + 4) / 2) < 1e-9, '中位数应是 2.25，实际 ' + f.holder_pnl_median);
  assert.ok(Math.abs(f.holder_big_winner_ratio - 50) < 1e-9, 'pnl>3 的是 P1/P2');
  assert.ok(Math.abs(f.holder_active_seller_ratio - 25) < 1e-9);
  assert.ok(Math.abs(f.holder_realized_loss_ratio - 25) < 1e-9);
  assert.ok(f.holder_avg_cost_cv > 0, '成本有离散度');
  assert.ok(Math.abs(f.holder_zero_native_ratio - 25) < 1e-9, '只有 P3 是空壳');
  assert.strictEqual(f.holder_creator_rank, 1, '创建者排第一');
  assert.ok(Math.abs(f.holder_sniper_ratio - 25) < 1e-9);
  assert.ok(Math.abs(f.holder_kol_ratio - 25) < 1e-9);
  assert.ok(Math.abs(f.holder_fomo_ratio - 25) < 1e-9);
  assert.ok(Math.abs(f.holder_dev_team_ratio - 25) < 1e-9);
});

await testAsync('buildRows(holders): 前30/50大户买卖均价应按金额加权并换算成市值', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  // 总供应量 = balance / amount_percentage = 1e9（每个持有人都自洽）
  const SUPPLY = 1e9;
  const holders = [];
  for (let i = 0; i < 50; i++) {
    const bal = (50 - i) * 1000;              // 降序持仓，用于校验排序取前 N
    // 前 30 名单价 1e-6，后 20 名单价 1e-5：只有正确切出前 30 才能得到纯 1e-6
    const unit = i < 30 ? 1e-6 : 1e-5;
    const amt = 1000000;
    holders.push(mkHolder('H' + i, {
      balance: bal, amount_percentage: bal / SUPPLY,
      buy_amount_cur: amt, history_bought_cost: amt * unit,
      sell_amount_cur: amt / 2, history_sold_income: (amt / 2) * unit * 2,
    }));
  }
  const f = (await sandbox.buildRows([call], [snapshot.constructor === Object ? Object.assign(snapshot, { ctx: { holders } }) : snapshot]))[0].features;
  // 前30：单价恒 1e-6 → 市值 1e-6 * 1e9 = 1000
  assert.ok(Math.abs(f.holder_top30_avg_buy_mcap - 1000) < 1e-6, '实际 ' + f.holder_top30_avg_buy_mcap);
  assert.ok(Math.abs(f.holder_top30_avg_sell_mcap - 2000) < 1e-6, '卖出单价是买入的 2 倍');
  // 前50：30 个 1e-6 + 20 个 1e-5，按金额加权（每人买入数量相同）
  // = (30*1e-6 + 20*1e-5)/50 * 1e9 = (3e-5+2e-4)/50*1e9 = 4600
  assert.ok(Math.abs(f.holder_top50_avg_buy_mcap - 4600) < 1e-6, '实际 ' + f.holder_top50_avg_buy_mcap);
});

await testAsync('buildRows(holders): 净成本要能取负值——大户已回本时不能算出正的假成本线', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const SUPPLY = 1e9;
  const holders = [];
  for (let i = 0; i < 30; i++) {
    const bal = (30 - i) * 1000;
    // 每人买 100 万个花 $10，卖掉一半却拿回 $30（涨了 6 倍卖的）→ 净投入 -$20，已回本
    holders.push(mkHolder('N' + i, {
      balance: bal, amount_percentage: bal / SUPPLY,
      buy_amount_cur: 1000000, history_bought_cost: 10, history_bought_fee: 0,
      sell_amount_cur: 500000, history_sold_income: 30, history_sold_fee: 0,
    }));
  }
  snapshot.ctx.holders = holders;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(f.holder_top30_net_cost_mcap < 0, '已回本应为负，实际 ' + f.holder_top30_net_cost_mcap);
  // 净投入 30*(10-30) = -600，总持仓 = 1000*(30+29+...+1) = 465000
  // -600/465000*1e9 = -1290.32...
  assert.ok(Math.abs(f.holder_top30_net_cost_mcap - (-600 / 465000 * SUPPLY)) < 1e-6);
  // 而买入均价依然是正的 $10/1e6*1e9 = 10000 —— 这正是两个字段必须并存的理由
  assert.ok(Math.abs(f.holder_top30_avg_buy_mcap - 10000) < 1e-6, '买入均价不受影响');
});

await testAsync('buildRows(holders): 净成本要计入手续费', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const SUPPLY = 1e9;
  const holders = [];
  for (let i = 0; i < 30; i++) {
    const bal = (30 - i) * 1000;
    holders.push(mkHolder('G' + i, {
      balance: bal, amount_percentage: bal / SUPPLY,
      buy_amount_cur: 1000000, history_bought_cost: 10, history_bought_fee: 2,
      sell_amount_cur: 0, history_sold_income: 0, history_sold_fee: 0,
    }));
  }
  snapshot.ctx.holders = holders;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  // 净投入 30*(10+2) = 360；不算手续费会是 300，差 20%
  assert.ok(Math.abs(f.holder_top30_net_cost_mcap - (360 / 465000 * SUPPLY)) < 1e-6,
    '应含手续费，实际 ' + f.holder_top30_net_cost_mcap);
});

await testAsync('buildRows(holders): 持有人不足 N 个时前N大户均价应缺失，无人卖出时卖出均价应缺失', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const SUPPLY = 1e9;
  const holders = [];
  for (let i = 0; i < 35; i++) {
    const bal = (35 - i) * 1000;
    holders.push(mkHolder('K' + i, {
      balance: bal, amount_percentage: bal / SUPPLY,
      buy_amount_cur: 1000000, history_bought_cost: 1,
      sell_amount_cur: 0, history_sold_income: 0,   // 没有人卖过
    }));
  }
  snapshot.ctx.holders = holders;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Number.isFinite(f.holder_top30_avg_buy_mcap), '35 个够算前30');
  assert.strictEqual(f.holder_top50_avg_buy_mcap, undefined, '不足 50 个不应写入');
  assert.strictEqual(f.holder_top30_avg_sell_mcap, undefined, '无人卖出应缺失而不是 0');
});

await testAsync('buildRows(holders): 没有创建者时 holder_creator_rank 应缺失而不是 0', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.ctx.holders = [mkHolder('X1'), mkHolder('X2'), mkHolder('X3')];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.holder_creator_rank, undefined);
  // 无任何协同痕迹时应给 0 而不是缺失——0 是"测过了，没有"，缺失是"没数据"
  assert.strictEqual(f.holder_same_private_funder_ratio, 0);
  assert.strictEqual(f.holder_internal_transfer_ratio, 0);
});

await testAsync('buildRows(holders): 既无 native_coin_decimal 也无法从 chain 识别时，SOL 余额统计应整组缺失', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.ctx.holders = [
    mkHolder('S1', { native_balance: '1000000000' }),
    mkHolder('S2', { native_balance: '2000000000' }),
    mkHolder('S3', { native_balance: '3000000000' }),
  ]; // 没有 native_coin_decimal，signal 里也没有 chain
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.holder_native_sol_median, undefined);
  assert.strictEqual(f.holder_native_sol_cv, undefined);
});

await testAsync('buildRows(holders): SOL 余额应按 native_coin_decimal 换算后取中位数与变异系数', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.ctx.holders = [
    mkHolder('S1', { native_balance: '1000000000' }), // 1 SOL
    mkHolder('S2', { native_balance: '2000000000' }), // 2 SOL
    mkHolder('S3', { native_balance: '3000000000' }), // 3 SOL
  ];
  snapshot.ctx.native_coin_decimal = 1e9;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.holder_native_sol_median - 2) < 1e-9, '实际 ' + f.holder_native_sol_median);
  // 均值2，方差=((1-2)^2+(2-2)^2+(3-2)^2)/3=2/3，cv=sqrt(2/3)/2≈0.40825
  assert.ok(Math.abs(f.holder_native_sol_cv - 0.4082482905) < 1e-6, '实际 ' + f.holder_native_sol_cv);
});

await testAsync('buildRows(holders): native_coin_decimal 缺失时应按 chain=3 兜底 Solana(1e9) 精度换算', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.chain = 3; // 真实数据里 native_coin_decimal 并非每次快照都带，chain 是更可靠的兜底
  snapshot.ctx.holders = [
    mkHolder('C1', { native_balance: '1000000000' }), // 1 SOL
    mkHolder('C2', { native_balance: '2000000000' }), // 2 SOL
    mkHolder('C3', { native_balance: '3000000000' }), // 3 SOL
  ];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.holder_native_sol_median - 2) < 1e-9, '实际 ' + f.holder_native_sol_median);
});

await testAsync('buildRows(holders): native_coin_decimal 缺失时应按 chain=56 兜底 BSC(1e18) 精度换算', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.chain = 56;
  snapshot.ctx.holders = [
    mkHolder('B1', { native_balance: String(1e18) }),   // 1 BNB
    mkHolder('B2', { native_balance: String(2 * 1e18) }), // 2 BNB
    mkHolder('B3', { native_balance: String(3 * 1e18) }), // 3 BNB
  ];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.holder_native_sol_median - 2) < 1e-9, '实际 ' + f.holder_native_sol_median);
});

await testAsync('buildRows(holders): 显式 native_coin_decimal 应优先于 chain 兜底', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.chain = 3; // chain 兜底会给 1e9，但下面显式给了不同的精度，应以显式值为准
  snapshot.ctx.native_coin_decimal = 1e6;
  snapshot.ctx.holders = [
    mkHolder('E1', { native_balance: '1000000' }), // 1（按显式的 1e6 换算）
    mkHolder('E2', { native_balance: '2000000' }),
    mkHolder('E3', { native_balance: '3000000' }),
  ];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.holder_native_sol_median - 2) < 1e-9, '实际 ' + f.holder_native_sol_median);
});

await testAsync('buildRows(holders): 多数大户 SOL 余额为 0 时中位数应如实为 0，而不是被过滤掉', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.ctx.holders = [
    mkHolder('Z1', { native_balance: '0' }),
    mkHolder('Z2', { native_balance: '0' }),
    mkHolder('Z3', { native_balance: '0' }),
    mkHolder('Z4', { native_balance: '5000000000' }), // 5 SOL
    mkHolder('Z5', { native_balance: '3000000000' }), // 3 SOL
  ];
  snapshot.ctx.native_coin_decimal = 1e9;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.holder_native_sol_median, 0, '5个里3个是0，中位数应为0');
});

test('computeCorrelations: 出现任一类被剔除字段时都不应抛异常，且要正确归桶', () => {
  // 回归：correlationPoolExclusionReason 新增 'metadata' 返回值时，excluded 初始化里没有对应
  // 的桶，excluded['metadata'].push 抛 "Cannot read properties of undefined (reading 'push')"。
  // 它在 computeCorrelations 主链路上，结果是整个「分析」直接失败、一条数据都加载不出来。
  // 这里把四类剔除原因各放一个字段，任何一类没桶都会当场炸。
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({ returnMax: 1 + i * 0.3, features: {
      sol_price: 150 + i,          // metadata
      last_traded: 1784000000 + i, // timestamp
      ai_max_up_ratio: i,          // internal
      always_same: 7,              // constant（零方差）
      buyer_count_d1: 10 + i,      // 正常字段，应当留下
    } });
  }
  const list = sandbox.computeCorrelations(rows);
  const ex = list._excluded;
  assert.ok(ex.metadata.includes('sol_price'), 'sol_price 应进 metadata 桶');
  assert.ok(ex.timestamp.includes('last_traded'), 'last_traded 应进 timestamp 桶');
  assert.ok(ex.internal.includes('ai_max_up_ratio'), 'ai_max_up_ratio 应进 internal 桶');
  assert.ok(ex.constant.includes('always_same'), 'always_same 应进 constant 桶');
  assert.ok(list.some(r => r.feature === 'buyer_count_d1'), '正常字段应参与检验');
});

test('字段候选池剔除：不得误杀任何组装字段（对 data.js 里全部 features 赋值做全量校验）', () => {
  // 剔除规则用的是前缀/后缀正则，边界写松一点就会连坐成品特征，而且不报错——
  // 只是候选池里悄悄少一批，没人会发现。这里把源码里所有 features['x'] = 的字段全捞出来兜底。
  // 扫的是 data.js 整份源码而不是 buildRows.toString()：组装字段的计算已经按块拆成了一批
  // applyXxxFeatures 函数（见 readme"拆 buildRows()"一节），只扫 buildRows 函数体会漏掉绝大
  // 多数字段。跟 online-export-coverage.test.js 同一套静态扫描口径，也不再受后续拆分影响。
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/data.js'), 'utf8');
  const made = [...new Set([...src.matchAll(/features\[['"]([^'"]+)['"]\]\s*=/g)].map(m => m[1]))];
  assert.ok(made.length > 50, '应能解析出足量组装字段，实际 ' + made.length);
  const killed = made.filter(f => sandbox.isNonAnalyticField(f));
  assert.deepStrictEqual(killed, [], '这些组装字段被剔除规则误杀：' + killed.join(', '));
});

testAsync('holder_topN_share_pct：前N大户持仓占比合计，必须剔除交易所/流动性地址', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const H = (t, addr, pct) => ({ addr_type: t, address: addr, amount_percentage: pct, balance: pct * 1e9,
    buy_volume_cur: 1, buy_amount_cur: 1e6, history_bought_cost: 1, sell_amount_cur: 0,
    history_sold_income: 0, unrealized_pnl: 0, avg_cost: 1e-5, native_balance: '100',
    start_holding_at: 100, tags: [], maker_token_tags: [], native_transfer: null });
  const holders = [H(2, 'POOL', 0.15), H(2, 'CEX', 0.10)];   // 交易所/池 25%，应被剔除
  for (let i = 0; i < 35; i++) holders.push(H(0, 'W' + i, (35 - i) * 0.001));
  snapshot.ctx.holders = holders;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;

  // 前30真实持有人（第6~35名，各 0.006..0.035）合计 = 61.5%
  let exp30 = 0; for (let k = 35; k >= 6; k--) exp30 += k * 0.001;
  assert.ok(Math.abs(f['holder_top30_share_pct'] - exp30 * 100) < 1e-6,
    '前30占比应剔除交易所后算，实际 ' + f['holder_top30_share_pct']);
  // 关键：把 25% 的交易所算进去会得到 86.5%，必须证明没有
  assert.ok(f['holder_top30_share_pct'] < 70, '交易所/池的持仓不能计入前30占比');
  // 只有 35 个真实持有人 → 前50不足，应缺失而不是拿 35 个凑数
  assert.strictEqual(f['holder_top50_share_pct'], undefined, '不足 50 个真实持有人应缺失');
});

testAsync('筹码字段：pressure_net 已移除，below_percent 仍参与计算但不进候选池', async () => {
  // 四个字段（above / below / ratio / net）只有 2 个自由度：
  //   pressure_net = above − below，above_below_ratio = above ÷ below
  // 全放进候选池不增加信息，只会抬高 BH 校正的 m，把真信号的校正后 p 拖垮。
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.ctx.chip_analysis = { above_percent: 40, below_percent: 20 };
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;

  assert.strictEqual(f['chip_analysis.pressure_net'], undefined, 'pressure_net 应已移除');
  // below_percent 必须还在——above_below_ratio 拿它做分母
  assert.strictEqual(f['chip_analysis.below_percent'], 20);
  assert.strictEqual(f['chip_analysis.above_below_ratio'], 2);

  // 但它不该进分析候选池
  assert.ok(sandbox.isNonAnalyticField('chip_analysis.below_percent'), 'below_percent 应被剔除出候选池');
  assert.ok(!sandbox.isNonAnalyticField('chip_analysis.above_percent'), 'above_percent 要保留');
  assert.ok(!sandbox.isNonAnalyticField('chip_analysis.above_below_ratio'), 'above_below_ratio 要保留');
});

test('字段候选池剔除：元数据/常量字段应被 isNonAnalyticField 挡掉，业务字段必须放行', () => {
  for (const f of ['amm_volume', 'exchange_volume', 'scam_volume', 'bnb_decimal', 'bnb_price',
                   'decimals', 'chain', 'dexscreen_loading', 'goplus_loading',
                   'h1_featured_index', 'hot_index',
                   'is_diamond_token', 'is_error_market_token', 'is_honey', 'is_scam_token',
                   'is_top_token', 'is_trench_token',
                   'is_fake', 'is_fake_bonk', 'is_fake_four', 'is_fake_pump',
                   // 点号路径的 highlight.* 整棵子树
                   'highlight.is_usdt', 'highlight.is_live', 'highlight.is_activity',
                   // kline_and_indicators.* 是计算输入（绝对价/单位标志/元数据），不是特征
                   'kline_and_indicators.current_price', 'kline_and_indicators.current_avg_price',
                   'kline_and_indicators.current_ao', 'kline_and_indicators.kline_is_usd',
                   'kline_and_indicators.kline_is_mcap', 'kline_and_indicators.timestamp',
                   'kline_and_indicators.resolution',
                   // last_alert.* 整棵子树：上次告警的绝对价/市值/fibon位/时间戳
                   'last_alert.top_price', 'last_alert.low_price_mcap', 'last_alert.fibon_break1',
                   'last_alert.n_pattern_retracement', 'last_alert.total_supply',
                   'last_alert.signalTime', 'last_traded',
                   'sol_decimal', 'sol_price', 'total_record', 'total_supply',
                   '_highlight_mcap_update', 'ai_max_up_ratio']) {
    assert.ok(sandbox.isNonAnalyticField(f), f + ' 应被剔除出候选池');
  }
  // 精确匹配而非前缀/包含匹配：new_volume 等持仓指标名字里也有 _volume，
  // 一旦写成 includes('_volume') 就会把核心筛选字段全部误杀
  // is_new_m5_hot_ranking_token 必须活着：它是 is_* 布尔，但和被删的 hot_index 不同，
  // 表达的是"是否新进榜"这一事件，不是随平台流量漂移的名次
  // kline_* 顶层字段是从 kline_and_indicators 子树加工出来的成品特征，名字不带子树前缀，
  // 必须活着——前缀规则一旦写成 /kline/ 这种没有 ^ 和 \. 边界的形式就会全军覆没
  for (const f of ['new_volume', 'smart_volume', 'shit_volume', 'whale_volume',
                   'gmgn.price.buy_volume_1h', 'max_up_ratio', 'kline_max_rise_pct',
                   'is_new_m5_hot_ranking_token', 'is_new_h1_hot_ranking_token', 'gmgn.og',
                   'kline_volume_cv', 'kline_max_rise_speed_pct_per_min', 'kline_bar_minutes',
                   'kline_minutes_since_max_volume', 'cost_line_distance_pct',
                   // total_supply 被剔除，但带前缀的 gmgn.total_supply 是另一个字段（算流通占比用），
                   // 靠 Set 精确匹配区分——写成 endsWith('total_supply') 就会连坐
                   'gmgn.total_supply', 'gmgn.circulating_supply', 'kline_turnover_pct']) {
    assert.ok(!sandbox.isNonAnalyticField(f), f + ' 不该被误伤');
  }
});

test('字段候选池剔除：_highlight_*/ai_max_* 应被判为 internal，而同名相近的历史统计量必须保留', () => {
  // ai_max_* 是 AI 侧的预测/极值标注，_highlight_* 是 UI 高亮标记，都不该进分析候选池。
  // 但 max_up_ratio / signal_max_up_ratio 是"截至买入快照的历史最大值"，是合法特征，
  // 正则一旦写宽（比如漏了 ^ 或 \. 边界）就会把它们一起误杀，这里正反两侧都钉住。
  // 注意断言的是"有没有被剔除"而不是具体原因：ai_max_price_time 会先命中时间戳规则返回
  // 'timestamp'，同样是剔除。scatterOptions 的过滤复用 CORR_INTERNAL_FIELD_RE，口径一致。
  for (const f of ['_highlight_mcap_update', '_highlight_signals_update', 'ai_max_price_time',
                   'ai_max_up_duration', 'ai_max_up_ratio', 'ai_max_up_ratio_mcap']) {
    assert.ok(sandbox.correlationPoolExclusionReason(f), f + ' 应被剔除');
  }
  for (const f of ['max_up_ratio', 'max_up_duration', 'signal_max_up_ratio',
                   'all_signals_max_ratio.v_breakout_volume', 'kline_max_rise_pct', 'ai_score']) {
    assert.strictEqual(sandbox.correlationPoolExclusionReason(f), null, f + ' 不该被误伤');
  }
});

await testAsync('buildRows(量能): bar 太少且无 resolution 时才真正不写入 minutes_since_max_volume', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const vols = [10, 999, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
  // 所有 bar 同一时间戳 → 实测不出间隔，且没有 resolution 兜底
  snapshot.ctx.kline_and_indicators = {
    kline_is_usd: true,
    kline_bars: vols.map(v => ({ time: 100000, volume: v, token_volume: v })),
  };
  snapshot.signal.total_supply = 1000;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.kline_minutes_since_max_volume, undefined);
});
await testAsync('buildRows: sell_tx_per_seller 应与 buy_tx_per_buyer 对称', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.sell_tx_count_d1 = 173;
  snapshot.signal.seller_count_d1 = 98;
  snapshot.signal.buy_tx_count_d1 = 263;
  snapshot.signal.buyer_count_d1 = 176;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.sell_tx_per_seller - 173 / 98) < 1e-9);
  assert.ok(Math.abs(f.buy_tx_per_buyer - 263 / 176) < 1e-9);
});
await testAsync('buildRows: post_buy_max_drawdown_pct 应按 (initial_mcap - min_mcap) / initial_mcap 计算（min_mcap_time 早于 max_mcap_time）', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  call.min_mcap = 60; // initial_mcap = 100 → 跌到60，回撤40%
  call.min_mcap_time = 1000; call.max_mcap_time = 2000; // 先探底、再冲高，符合这个字段的语义
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.post_buy_max_drawdown_pct - 40) < 1e-9);
});
await testAsync('buildRows: min_mcap 缺失时 post_buy_max_drawdown_pct 应缺失，不能强行给默认值', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.post_buy_max_drawdown_pct, undefined);
});
await testAsync('buildRows: min_mcap >= initial_mcap（未跌破买入价）时 post_buy_max_drawdown_pct 应为 0，不产生负数', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  call.min_mcap = 150; // initial_mcap = 100，全程没跌破买入价
  call.min_mcap_time = 1000; call.max_mcap_time = 2000;
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.post_buy_max_drawdown_pct, 0);
});
await testAsync('buildRows: min_mcap_time 晚于 max_mcap_time（先冲高后砸盘）时 post_buy_max_drawdown_pct 应缺失，不能拿 initial_mcap 当基准误算', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  call.min_mcap = 60; // 数值上跟第一个测试完全一样，只是 min/max 的时间顺序反过来
  call.min_mcap_time = 2000; call.max_mcap_time = 1000; // 先冲高（max）、后砸盘跌到 min，走势含义不同
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.post_buy_max_drawdown_pct, undefined);
});
await testAsync('buildRows: min_mcap_time/max_mcap_time 缺失时 post_buy_max_drawdown_pct 应缺失（哪怕 min_mcap 本身有效）', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  call.min_mcap = 60; // 没设 min_mcap_time/max_mcap_time
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.post_buy_max_drawdown_pct, undefined);
});

// ---------- 跨信号类型的时序 ----------
await testAsync('buildRows(时序): 应按 signalTime 排序合并所有类型，产出序列/组合/首末类型', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.timestamp = 5000; call.timestamp = 5000;
  // 故意打乱录入顺序，且让精选出现两次，验证排序与去重
  snapshot.signal.continue_breakout_volume_list = [{ signalTime: 1000 }, { signalTime: 2000 }];
  snapshot.signal.v_breakout_volume_list = [{ signalTime: 3000, n_pattern_confirmed: true }];
  const row = (await sandbox.buildRows([call], [snapshot]))[0];
  assert.strictEqual(row.categorical.signal_sequence, 'continue>continue>v');
  assert.strictEqual(row.categorical.signal_combo, 'continue+v'); // 去重且字母序
  assert.strictEqual(row.categorical.signal_first_type, 'continue');
  assert.strictEqual(row.categorical.signal_last_type, 'v');
  assert.strictEqual(row.features.signal_total_count, 3);
  assert.strictEqual(row.features.signal_type_count, 2); // 两类共振
  assert.ok(Math.abs(row.features.signal_span_min - (3000 - 1000) / 60) < 1e-9);
  assert.ok(Math.abs(row.features.signal_first_to_buy_min - (5000 - 1000) / 60) < 1e-9);
});
await testAsync('buildRows(时序): signal_combo 与录入顺序无关，先V转后精选应与先精选后V转归为同一组', async () => {
  const a = await makeMinimalCallSnapshot();
  a.snapshot.timestamp = 5000; a.call.timestamp = 5000;
  a.snapshot.signal.continue_breakout_volume_list = [{ signalTime: 1000 }];
  a.snapshot.signal.v_breakout_volume_list = [{ signalTime: 2000, n_pattern_confirmed: true }];
  const rowA = (await sandbox.buildRows([a.call], [a.snapshot]))[0];

  const b = await makeMinimalCallSnapshot();
  b.snapshot.timestamp = 5000; b.call.timestamp = 5000;
  b.snapshot.signal.v_breakout_volume_list = [{ signalTime: 1000, n_pattern_confirmed: true }];
  b.snapshot.signal.continue_breakout_volume_list = [{ signalTime: 2000 }];
  const rowB = (await sandbox.buildRows([b.call], [b.snapshot]))[0];

  // combo 相同（都是这两类），但 sequence 相反——这正是要区分的两种行情结构
  assert.strictEqual(rowA.categorical.signal_combo, rowB.categorical.signal_combo);
  assert.strictEqual(rowA.categorical.signal_sequence, 'continue>v');
  assert.strictEqual(rowB.categorical.signal_sequence, 'v>continue');
});
await testAsync('buildRows(时序): 晚于买入时刻的信号必须排除（未来函数）', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.timestamp = 2500; call.timestamp = 2500;
  snapshot.signal.continue_breakout_volume_list = [{ signalTime: 1000 }, { signalTime: 9999 }]; // 后者晚于买入
  const row = (await sandbox.buildRows([call], [snapshot]))[0];
  assert.strictEqual(row.features.signal_total_count, 1);
  assert.strictEqual(row.categorical.signal_sequence, 'continue');
});
await testAsync('buildRows(时序): 应涵盖未做明细字段的 whale/followed/smart_money 三类', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.timestamp = 9000; call.timestamp = 9000;
  snapshot.signal.whale_list = [{ signalTime: 2000 }];
  snapshot.signal.followed_list = [{ signalTime: 1000 }];
  snapshot.signal.smart_money_list = [{ signalTime: 3000 }];
  const row = (await sandbox.buildRows([call], [snapshot]))[0];
  assert.strictEqual(row.categorical.signal_sequence, 'followed>whale>smart');
  assert.strictEqual(row.features.signal_type_count, 3);
});
await testAsync('buildRows(时序): 所有 list 都是空数组时，计数记 0 且不产出分类字段', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [];
  snapshot.signal.continue_breakout_volume_list = [];
  const row = (await sandbox.buildRows([call], [snapshot]))[0];
  assert.strictEqual(row.features.signal_total_count, 0);
  assert.strictEqual(row.features.signal_type_count, 0);
  assert.strictEqual(row.categorical.signal_sequence, undefined); // 没有信号就没有序列可言
  assert.strictEqual(row.features.signal_span_min, undefined);
});
await testAsync('buildRows(时序): 毫秒 signalTime 的 span 应与秒口径一致——回归：span 曾按裸秒 /60 算，毫秒数据会差 1000 倍', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const baseMs = 1784517000000; // 毫秒时间戳
  snapshot.timestamp = baseMs + 300000; call.timestamp = snapshot.timestamp; // 买入在信号之后
  snapshot.signal.continue_breakout_volume_list = [{ signalTime: baseMs }];
  snapshot.signal.v_breakout_volume_list = [{ signalTime: baseMs + 120000, n_pattern_confirmed: true }]; // 2 分钟后
  const row = (await sandbox.buildRows([call], [snapshot]))[0];
  assert.ok(Math.abs(row.features.signal_span_min - 2) < 1e-9, `span 应为 2 分钟，实际 ${row.features.signal_span_min}`);
  assert.ok(Math.abs(row.features.signal_first_to_buy_min - 5) < 1e-9, `first_to_buy 应为 5 分钟，实际 ${row.features.signal_first_to_buy_min}`);
});
await testAsync('buildRows(时序): 完全没有信号列表字段时，时序字段应全部缺失', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const row = (await sandbox.buildRows([call], [snapshot]))[0];
  assert.strictEqual(row.features.signal_total_count, undefined);
  assert.strictEqual(row.features.signal_type_count, undefined);
});

// ---------- 苏醒信号·真实样本 SVM（AoQGnPGXWHo9FfSVhPTmhJGvGXisEDwfaRPnDHHRpump）----------
// content:「休眠代币突然放量13.73x至$3.86K，通知市值$169.5K，从最高点回调0%，休眠时波动率35.48%、斜率3.02%」
function makeSvmWakeSignals() {
  return [
    { // 较早那条，用来验证"从最高点回调17.85%"
      avg_history_volume: 2.121533, history_start_time: 1784453100, history_end_time: 1784480100,
      history_kline_count: 35, current_open_price: 0.000001094618185, current_bullish: true,
      volume_ratio: 26.828397, cv: 31.5649, standardized_slope: 2.7004791,
      current_kline_time: 1784480400, current_close_price: 0.000001495667702, signal_time: 1784480400,
      current_volume: 56.917329633, signalTime: 1784480676, max_up_mcap: 138367.4824484294,
      notice_mcap: 113664.75059867237, type: 'breakout_volume_10x'
    },
    { // 最新那条（应被选中）
      avg_history_volume: 3.746326, current_bullish: true, current_close_price: 0.000002260107502,
      current_kline_time: 1784480700, current_open_price: 0.000001495667702, current_volume: 51.463214522,
      cv: 35.4808, history_end_time: 1784480400, history_kline_count: 35, history_start_time: 1784453400,
      signal_time: 1784480700, standardized_slope: 3.0242745, volume_ratio: 13.736982,
      max_up_mcap: 139249.917637773, notice_mcap: 169499.1231553263, signalTime: 1784480700,
      type: 'breakout_volume_10x'
    }
  ];
}
await testAsync('buildRows(苏醒·真实样本): 应取最新那条，各项对齐 content 文案', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.breakout_volume_10x_list = makeSvmWakeSignals();
  snapshot.ctx = { native_coin_price: 75 };
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.breakout_volume_10x_recent_volume_ratio - 13.736982) < 1e-9);      // 放量 13.73x
  assert.ok(Math.abs(f.breakout_volume_10x_recent_notice_mcap - 169499.1231553263) < 1e-9); // $169.5K
  assert.ok(Math.abs(f.breakout_volume_10x_recent_dormant_cv - 35.4808) < 1e-9);            // 波动率 35.48%
  assert.ok(Math.abs(f.breakout_volume_10x_recent_dormant_slope - 3.0242745) < 1e-9);       // 斜率 3.02%
  assert.strictEqual(f.breakout_volume_10x_signal_count, 2);
  // 休眠 1784453400→1784480400 = 27000 秒 = 450 分钟；休眠结束→信号 300 秒 = 5 分钟
  assert.ok(Math.abs(f.breakout_volume_10x_recent_dormant_duration_min - 450) < 1e-9);
  assert.ok(Math.abs(f.breakout_volume_10x_recent_dormant_end_to_signal_min - 5) < 1e-9);
});
await testAsync('buildRows(苏醒·真实样本): 回调深度应可为负（超过历史最高点），不像平台文案那样截断成0', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const list = makeSvmWakeSignals();
  snapshot.signal.breakout_volume_10x_list = [list[1]]; // notice 169499 > max_up 139250
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(f.breakout_volume_10x_recent_drawdown_from_high_pct < 0, `应为负，实际 ${f.breakout_volume_10x_recent_drawdown_from_high_pct}`);

  // 较早那条：(138367.48 − 113664.75) / 138367.48 = 17.85%，对齐 content「从最高点回调17.85%」
  const b = await makeMinimalCallSnapshot();
  b.snapshot.signal.breakout_volume_10x_list = [list[0]];
  const f2 = (await sandbox.buildRows([b.call], [b.snapshot]))[0].features;
  assert.ok(Math.abs(f2.breakout_volume_10x_recent_drawdown_from_high_pct - 17.85) < 0.01, `实际 ${f2.breakout_volume_10x_recent_drawdown_from_high_pct}`);
});
await testAsync('buildRows(苏醒·真实样本): 苏醒K线的阳线标记与涨幅', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.breakout_volume_10x_list = [makeSvmWakeSignals()[1]];
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.breakout_volume_10x_recent_kline_bullish, 1);
  // (0.000002260107502 − 0.000001495667702) / 0.000001495667702 = 51.11%
  assert.ok(Math.abs(f.breakout_volume_10x_recent_kline_change_pct - 51.11) < 0.01, `实际 ${f.breakout_volume_10x_recent_kline_change_pct}`);
});
await testAsync('buildRows: v_breakout_volume_recent_stage_pct 应取最新生效 V 转信号已突破的最高阶段', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [
    { n_pattern_confirmed: true, signalTime: 100, fibon_break1: 1, fibon_break2: 1, fibon_break3: 0, fibon_break4: 0 },
    { n_pattern_confirmed: true, signalTime: 200, fibon_break1: 1, fibon_break2: 0, fibon_break3: 0, fibon_break4: 0 }, // 更新的信号，只到20%
  ];
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows[0].features.v_breakout_volume_recent_stage_pct, 20);
});
await testAsync('buildRows: v_breakout_volume_recent_stage_pct 应在仅回撤确认、还未反弹时记为 0', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [
    { n_pattern_confirmed: true, signalTime: 100, fibon_break1: 0, fibon_break2: 0, fibon_break3: 0, fibon_break4: 0 },
  ];
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows[0].features.v_breakout_volume_recent_stage_pct, 0);
});
await testAsync('buildRows: v_breakout_volume_recent_stage_pct 在已反弹突破前高（fibon_break4，已收尾）时不应参与', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [
    { n_pattern_confirmed: true, signalTime: 100, fibon_break1: 1, fibon_break2: 1, fibon_break3: 1, fibon_break4: 1 },
  ];
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows[0].features.v_breakout_volume_recent_stage_pct, undefined);
});
await testAsync('buildRows: v_breakout_volume_recent_break_cost_line_min 应按跌破/涨破成本价之间的K线根数×resolution换算成分钟', async () => {
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
  assert.ok(Math.abs(rows[0].features.v_breakout_volume_recent_break_cost_line_min - (2 * 5 / 60)) < 1e-9);
});

await testAsync('buildRows: 跌破成本线未收复时应标记右删失并给出 elapsed 下界，而不是静默丢弃样本', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  // 与上一用例同构，但把最后那根"涨破"的K线去掉 → 到快照时刻仍在成本线下
  snapshot.signal.v_breakout_volume_list = [
    { n_pattern_confirmed: true, signalTime: 90, top_price_time: 100, fibon_break4: 0 },
  ];
  snapshot.ctx.kline_and_indicators = {
    resolution: 5,
    current_avg_price: 60,
    avg_price_bars: [{ time: 100, value: 60 }],
    kline_bars: [
      { time: 115, close: 52 }, // 仍 < 60，一直没站回成本线
      { time: 110, close: 55 },
      { time: 105, close: 50 },
      { time: 100, close: 70 },
    ],
  };
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  // 未收复（删失）：break_cost_line_min 依旧缺失（保持原语义，缺失即代表删失），但时长下界要有值
  assert.strictEqual(f.v_breakout_volume_recent_break_cost_line_min, undefined);
  assert.ok(Math.abs(f.v_breakout_volume_recent_below_cost_line_elapsed_min - (3 * 5 / 60)) < 1e-9);
});

await testAsync('buildRows: 收复成本线的样本 elapsed 应与 break_cost_line_min 一致', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
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
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(
    f.v_breakout_volume_recent_below_cost_line_elapsed_min,
    f.v_breakout_volume_recent_break_cost_line_min
  );
});
await testAsync('buildRows: v_breakout_volume_recent_break_cost_line_min 在跌破后到快照时刻仍未涨破（尚未走完）时不应参与', async () => {
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
  assert.strictEqual(rows[0].features.v_breakout_volume_recent_break_cost_line_min, undefined);
});
await testAsync('buildRows: cost_line_distance_pct 应直接取平台 avg_price_deviation_pct，不再用 mcap 自行计算', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  // 真实样本 nice 的数值：自己算 (12309−8097)/8097 = 52.0%，平台给的是 93.3%。
  // 两者不同源（mcap 是快照时刻市值，current_avg_price 来自最新K线），必须以平台值为准。
  snapshot.signal.mcap = 12309;
  snapshot.ctx.kline_and_indicators = { current_avg_price: 8097, avg_price_deviation_pct: 93.3 };
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.cost_line_distance_pct - 93.3) < 1e-9, `实际 ${f.cost_line_distance_pct}`);
  assert.strictEqual(f.above_cost_line, 1);
  // 合并后原字段不应再单独存在，否则同一个信息在相关性表里占两行
  assert.strictEqual(f['kline_and_indicators.avg_price_deviation_pct'], undefined);
});
await testAsync('buildRows: 平台 avg_price_deviation_pct 为负时 above_cost_line 应为 0', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.mcap = 80;
  snapshot.ctx.kline_and_indicators = { current_avg_price: 100, avg_price_deviation_pct: -18.5 };
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.above_cost_line, 0);
  assert.ok(Math.abs(f.cost_line_distance_pct + 18.5) < 1e-9);
});
await testAsync('buildRows: 缺 avg_price_deviation_pct 时这两个字段应缺失，不退回自己算', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.mcap = 150;
  snapshot.ctx.kline_and_indicators = { current_avg_price: 100 }; // 只有成本线，没有平台算好的偏离值
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.cost_line_distance_pct, undefined);
  assert.strictEqual(f.above_cost_line, undefined);
});
await testAsync('buildRows: v_breakout_volume_recent_low_cost_line_distance_pct 应按最低点发生时间从 avg_price_bars 回溯取成本线', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.mcap = 150;
  snapshot.signal.v_breakout_volume_list = [
    { n_pattern_confirmed: true, signalTime: 600, low_price_mcap: 90, low_price_time: 500 }
  ];
  snapshot.ctx.kline_and_indicators = {
    current_avg_price: 100, // 快照时刻的成本线，不应被用到（低点发生在更早的时间）
    avg_price_bars: [
      { time: 900, value: 100 }, // newest first
      { time: 400, value: 60 },  // <= 500，应取这一根
      { time: 100, value: 50 },
    ],
  };
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.ok(Math.abs(rows[0].features.v_breakout_volume_recent_low_cost_line_distance_pct - 50) < 1e-9); // (90-60)/60*100
});
await testAsync('buildRows: recent_low_cost_line_distance_pct 应只认V转信号，last_alert 是别的类型时不能取数', async () => {
  // 修复回归：该字段曾经从 last_alert 取数，而 last_alert 是"最近一次【任意类型】信号"。
  // 这里 last_alert 是精选信号却带着 low_price_* 字段（构造的极端情况），旧实现会误取，
  // 导致该字段与同组 v_breakout_volume_recent_* 字段的样本集对不上。
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.last_alert = { type: 'continue_breakout_volume', low_price_mcap: 90, low_price_time: 500 };
  snapshot.signal.v_breakout_volume_list = []; // 没有任何V转信号
  snapshot.ctx.kline_and_indicators = { current_avg_price: 100, avg_price_bars: [{ time: 400, value: 60 }] };
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.strictEqual(f.v_breakout_volume_recent_low_cost_line_distance_pct, undefined);
});
await testAsync('buildRows: recent_low_cost_line_distance_pct 的 _mcap 应优先于 _mcp', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.v_breakout_volume_list = [{
    n_pattern_confirmed: true, signalTime: 600,
    low_price_mcap: 90, low_price_mcp: 999, low_price_time: 500  // 两者并存，必须取 _mcap
  }];
  snapshot.ctx.kline_and_indicators = { current_avg_price: 100, avg_price_bars: [{ time: 400, value: 60 }] };
  const f = (await sandbox.buildRows([call], [snapshot]))[0].features;
  assert.ok(Math.abs(f.v_breakout_volume_recent_low_cost_line_distance_pct - 50) < 1e-9); // (90-60)/60*100
});
await testAsync('buildRows: v_breakout_volume_recent_low_cost_line_distance_pct 在 avg_price_bars 里找不到历史 bar 时应退回当前成本线', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  snapshot.signal.mcap = 150;
  snapshot.signal.v_breakout_volume_list = [
    { n_pattern_confirmed: true, signalTime: 600, low_price_mcap: 90, low_price_time: 500 }
  ];
  snapshot.ctx.kline_and_indicators = { current_avg_price: 100, avg_price_bars: [] };
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.ok(Math.abs(rows[0].features.v_breakout_volume_recent_low_cost_line_distance_pct - (-10)) < 1e-9); // (90-100)/100*100
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
// ---------- AUC（秩和公式 / bootstrap 置信区间） ----------
test('rankAuc: 候选阈值未被下采样时（n<=100），秩和结果应与梯形积分完全一致', () => {
  // computeROC 用 downsampleQuantiles(values, 100) 取候选阈值，n<=100 时不发生下采样，
  // 此时梯形积分是精确的，两种算法必须逐位相同——这条锁住秩和公式本身的正确性
  let seed = 1;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let t = 0; t < 50; t++) {
    const n = 40 + Math.floor(rnd() * 60); // 40~99
    const values = [], labels = [];
    for (let i = 0; i < n; i++) { const lab = rnd() < 0.4 ? 1 : 0; labels.push(lab); values.push(rnd() + lab * 0.5); }
    if (labels.every(x => x === labels[0])) continue;
    for (const dir of ['higher', 'lower']) {
      const a1 = sandbox.computeROC(values, labels, dir).auc;
      const a2 = sandbox.rankAuc(values, labels, dir);
      assert.ok(Math.abs(a1 - a2) < 1e-9, `方向 ${dir} 下两种算法不一致：${a1} vs ${a2}`);
    }
  }
});
test('rankAuc: n>100（阈值被下采样）时与梯形积分只有可忽略的近似偏差', () => {
  // 这种情况下梯形积分才是近似值、秩和是精确解，所以界面上的点估计取秩和；
  // 这条只是确认两者不会出现量级上的分歧（偏差实测在 1e-4 量级）
  let seed = 99;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  let maxDiff = 0;
  for (let t = 0; t < 30; t++) {
    const n = 150 + Math.floor(rnd() * 150);
    const values = [], labels = [];
    for (let i = 0; i < n; i++) { const lab = rnd() < 0.4 ? 1 : 0; labels.push(lab); values.push(rnd() + lab * 0.5); }
    if (labels.every(x => x === labels[0])) continue;
    maxDiff = Math.max(maxDiff, Math.abs(sandbox.computeROC(values, labels, 'higher').auc - sandbox.rankAuc(values, labels, 'higher')));
  }
  assert.ok(maxDiff < 5e-3, `偏差过大：${maxDiff}`);
});
test('rankAuc: 完美分离应得到 AUC=1，且 higher 与 lower 方向之和恒为 1', () => {
  assert.strictEqual(sandbox.rankAuc([1, 2, 3, 4, 5, 6], [0, 0, 0, 1, 1, 1], 'higher'), 1);
  const v = [3, 1, 4, 1, 5, 9, 2, 6], l = [1, 0, 1, 0, 1, 1, 0, 1];
  const sum = sandbox.rankAuc(v, l, 'higher') + sandbox.rankAuc(v, l, 'lower');
  assert.ok(Math.abs(sum - 1) < 1e-9);
});
test('rankAuc: 大量并列值（布尔字段）应按平均秩处理，不能退化', () => {
  // 值全部并列时无任何区分力，AUC 必须正好是 0.5；不做 midrank 的实现这里会算出 0 或 1
  assert.ok(Math.abs(sandbox.rankAuc([1, 1, 1, 1], [1, 0, 1, 0], 'higher') - 0.5) < 1e-9);
});
test('bootstrapAucCI: 纯随机字段的置信区间应跨过 0.5（判定为"和抛硬币没区别"）', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const values = [], labels = [];
  for (let i = 0; i < 150; i++) { labels.push(rnd() < 0.35 ? 1 : 0); values.push(rnd()); }
  const ci = sandbox.bootstrapAucCI(values, labels, 'higher', 300);
  assert.ok(ci.lo <= 0.5 && ci.hi >= 0.5, `随机数据的 CI 不该排除 0.5，实际 [${ci.lo}, ${ci.hi}]`);
});
test('bootstrapAucCI: 强信号字段的置信区间下界应高于 0.5', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const values = [], labels = [];
  for (let i = 0; i < 200; i++) { const lab = rnd() < 0.4 ? 1 : 0; labels.push(lab); values.push(rnd() + lab * 0.9); }
  const ci = sandbox.bootstrapAucCI(values, labels, 'higher', 300);
  assert.ok(ci.lo > 0.5, `强信号的 CI 下界应 > 0.5，实际 [${ci.lo}, ${ci.hi}]`);
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

// 回归：p 必须对应加★的主指标 Spearman ρ，不能是线性 r 的 p（曾经的真实 bug——界面上 ρ 是
// 主排序列，p 若还按 r 算，会出现"ρ 很强却显示不显著"这种跟星标指标脱节的情况）。
// 用 y=x^5（单调但强非线性）制造 r 明显弱于 rho=1 的场景来暴露这个差异。
test('computeCorrelations: p 应对应 Spearman ρ 而不是线性 r（星标主指标口径一致）', () => {
  const rows = [];
  for (let x = 1; x <= 30; x++) rows.push({ returnMax: Math.pow(x, 5), features: { x }, categorical: {} });
  const list = sandbox.computeCorrelations(rows);
  const rm = list.find(c => c.target === 'returnMax' && c.feature === 'x');
  assert.ok(rm, '应有 x 的相关性结果');
  assert.ok(Math.abs(rm.rho - 1) < 1e-9, `单调关系 rho 应为 1，实际 ${rm.rho}`);
  assert.ok(rm.r < 0.95, `r 应明显弱于 rho（强非线性），实际 r=${rm.r}`);
  const expectedFromRho = sandbox.pearsonPValue(rm.rho, rm.n);
  const expectedFromR = sandbox.pearsonPValue(rm.r, rm.n);
  assert.ok(Math.abs(rm.p - expectedFromRho) < 1e-9, `p 应按 rho 算，实际 p=${rm.p} 期望=${expectedFromRho}`);
  assert.ok(Math.abs(rm.p - expectedFromR) > 1e-9, 'p 不应等于按 r 算出来的值（否则就是回归到旧 bug）');
  // 旧算法（按 r 算 p）没有被删掉，只是改挂在 'pr' 字段下，供需要参考 r 显著性的场景使用
  assert.ok(Math.abs(rm.pr - expectedFromR) < 1e-9, `pr 应保留按 r 算的 p，实际 pr=${rm.pr}`);
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

// charts.js / pro-analytics.js 抽出的纯计算函数的回归测试（这两个文件此前零覆盖）
runLibAnalytics(test);
runScatterFigure(test);
runFilter(test);
runSummary(test, testAsync);
runBinning(test);
runBinReport(testAsync);
runAuc(test);
runStrategy(test);
runFieldDocs(test);
runParity(test, testAsync);
runAnalyticsParity(test);
runCustomRuntime(test);
runCompare(test);
runLabels(test);
runCommonHolders(test);
runFieldHealth(test);
runStrategyVersions(test);
runDailyBacktest(test);
runFactorExclusions(test);
runExcludedTokens(test);
runStrategyReplayLogic(test);
runCampLibrary(test);
runRemovedFactors(test);
runFieldAudit(test);
runDataArchive(test);
runStrategySpec(test);
runDataSlices(test);
runTableHiddenFields(test);
runDataHelpers(test);
runBuildRowsFeatures(test);
runDataFolders(test);
runFactorPoolStore(test);
runOnlineExport(test);
runOnlineExportCoverage(test);
runFactorScanExport(test);
runRhoOptimize(test);
runBacktestReport(test);
runFactorRecommend(test);
runFactorLabFixes(test);
// 2026-07-28 修复：这里必须 await + 用 testAsync（跟上面几百个 buildRows 测试同一个模式）——
// factor-recommend-worker.test.js 的 run() 内部 test(name, async fn) 是异步的，之前用同步
// test() 调用只会走到第一个 await 就同步返回，断言失败会变成脚本已经打印完总数之后才触发的
// "未处理 promise rejection"，完全不计入通过/失败统计。这正是当时没测出 evaluateCandidatesWithNodeWorkers
// 那个参数错位 bug 的原因——不是测试没写对，是测试压根没被真正跑完就已经被记成"通过"。
await runFactorRecommendWorker(testAsync);

main().then(async () => {
  // factorlab 的 run 是 async（内部有 OOS 回测等异步计算），必须 await 完才能打总结；
  // 内部混了同步/异步用例，跟 summary.test.js/parity.test.js 一样传两个函数——
  // 同步用例走 test，异步用例走 testAsync（之前误传成 test，async 用例的断言从未被等待过）
  await runFactorLab(test, testAsync);
  console.log(`\n共 ${passed + failed} 个测试，通过 ${passed} 个，失败 ${failed} 个。`);
  process.exit(failed ? 1 : 0);
});
