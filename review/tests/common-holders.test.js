import assert from 'node:assert';
import { extractCommonHolders } from '../src/lib/commonHolders.js';

const tok = (ca, ret, holders) => ({ tokenAddress: ca, symbol: ca, returnMax: ret, features: {}, rawCtx: { holders } });
const H = (addr, pct, t = 0) => ({ address: addr, amount_percentage: pct, addr_type: t, tags: [], maker_token_tags: [] });

export function run(test) {
  test('extractCommonHolders: 应找出在多个币里都出现的地址，按出现次数降序', () => {
    const rows = [
      tok('CA1', 5, [H('WHALE', 0.1), H('A', 0.05)]),
      tok('CA2', 3, [H('WHALE', 0.08), H('B', 0.05)]),
      tok('CA3', 8, [H('WHALE', 0.06), H('A', 0.04)]),
    ];
    const { addresses } = extractCommonHolders(rows, { minTokens: 2 });
    assert.strictEqual(addresses[0].address, 'WHALE');
    assert.strictEqual(addresses[0].count, 3, 'WHALE 出现在 3 个币里');
    assert.strictEqual(addresses[1].address, 'A', 'A 出现在 2 个');
    assert.ok(!addresses.some(a => a.address === 'B'), 'B 只出现 1 次，达不到 minTokens');
  });

  test('extractCommonHolders: 默认剔除交易所/流动性地址（addr_type=2）', () => {
    const rows = [
      tok('CA1', 5, [H('POOL', 0.3, 2), H('X', 0.05)]),
      tok('CA2', 3, [H('POOL', 0.2, 2), H('X', 0.04)]),
    ];
    const { addresses } = extractCommonHolders(rows);
    assert.ok(!addresses.some(a => a.address === 'POOL'), '交易所/池地址应被剔除');
    assert.ok(addresses.some(a => a.address === 'X'), '真实地址保留');
  });

  test('extractCommonHolders: 同一个币里同一地址只算一次', () => {
    const rows = [
      tok('CA1', 5, [H('DUP', 0.1), H('DUP', 0.1)]),   // 同币重复
      tok('CA2', 3, [H('DUP', 0.1)]),
    ];
    const { addresses } = extractCommonHolders(rows, { minTokens: 2 });
    assert.strictEqual(addresses.find(a => a.address === 'DUP').count, 2, '同币去重后应是 2 不是 3');
  });

  test('extractCommonHolders: 应算出常客持有币的平均涨幅（跟单价值）', () => {
    const rows = [
      tok('CA1', 10, [H('SMART', 0.1)]),
      tok('CA2', 8, [H('SMART', 0.1)]),
      tok('CA3', 1, [H('NOISE', 0.1)]),
      tok('CA4', 0.5, [H('NOISE', 0.1)]),
    ];
    const { addresses } = extractCommonHolders(rows, { minTokens: 2 });
    const smart = addresses.find(a => a.address === 'SMART');
    const noise = addresses.find(a => a.address === 'NOISE');
    assert.ok(smart.avgRet > 5, 'SMART 总在赢家里，平均涨幅高');
    assert.ok(noise.avgRet < 2, 'NOISE 啥都买，平均涨幅低');
  });

  test('extractCommonHolders: 没有 holders 数据不崩溃', () => {
    const rows = [{ tokenAddress: 'CA1', returnMax: 5, features: {}, rawCtx: {} }, { tokenAddress: 'CA2', returnMax: 3, features: {} }];
    const r = extractCommonHolders(rows);
    assert.strictEqual(r.addresses.length, 0);
    assert.strictEqual(r.withHolders, 0);
  });
}
