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
await testAsync('buildRows: 正常样本应正确匹配并计算 returnCurrent/returnMax', async () => {
  const { call, snapshot } = await makeMinimalCallSnapshot();
  const rows = await sandbox.buildRows([call], [snapshot]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].returnCurrent, 2); // 200/100
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
