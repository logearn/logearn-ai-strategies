import assert from 'node:assert';
import { buildSummary, dedupPerToken, formatDuration } from '../src/lib/summary.js';

const R = (o) => ({ id: o.id, tokenAddress: o.ca, returnMax: o.ret, features: {}, ...o });

export function run(test, testAsync) {
  test('buildSummary: 空数据集不应崩溃', () => {
    const s = buildSummary([], [1, 2, 3]);
    assert.strictEqual(s.empty, true);
    assert.strictEqual(s.total, 3);
  });

  test('buildSummary: 同一 token 多次信号应触发非独立样本警告', () => {
    // 5 条样本只有 2 个 token —— 收益高度相关，当独立样本算会虚增显著性
    const rows = [R({ id: 1, ca: 'A', ret: 2 }), R({ id: 2, ca: 'A', ret: 3 }), R({ id: 3, ca: 'A', ret: 4 }),
                  R({ id: 4, ca: 'B', ret: 1 }), R({ id: 5, ca: 'B', ret: 5 })];
    const s = buildSummary(rows, rows);
    assert.strictEqual(s.uniqueTokens, 2);
    const w = s.warnings.find(x => x.kind === 'dup');
    assert.ok(w && w.canDedup, '应给出去重入口');
  });

  test('buildSummary: token 基本不重复时不应误报', () => {
    const rows = Array.from({ length: 10 }, (_, i) => R({ id: i, ca: 'T' + i, ret: 2 }));
    assert.ok(!buildSummary(rows, rows).warnings.some(w => w.kind === 'dup'));
  });

  test('buildSummary: 不应再产出"观察时长不足"这类恒真警告', () => {
    // 该检测在结构上不可能成立：匹配逻辑强制 call/snapshot 时间差 ≤1 小时，
    // 而观察窗口正是这个差 —— 永远小于 6 小时阈值，会对 100% 样本无条件告警。
    const rows = [{ id: 1, tokenAddress: 'A', returnMax: 2, features: {}, buyTimestamp: 0, exportTimestamp: 60 }];
    const s2 = buildSummary(rows, rows);
    assert.ok(!s2.warnings.some(w => w.kind === 'obs'), '不应有观察窗口警告');
  });

  test('buildSummary: 胜率按 returnMax > 2 算', () => {
    const rows = [R({ id: 1, ca: 'A', ret: 1.5 }), R({ id: 2, ca: 'B', ret: 2.5 }),
                  R({ id: 3, ca: 'C', ret: 3 }), R({ id: 4, ca: 'D', ret: 0.5 })];
    const s = buildSummary(rows, rows);
    const win = s.tiles.find(t => /胜率/.test(t.label));
    assert.strictEqual(win.value, '50.0%', '4 条里 2 条 > 2');
  });

  test('dedupPerToken: 每个 token 只保留买入时间最早的一条', () => {
    const rows = [R({ id: 1, ca: 'A', ret: 2, buyTimestamp: 300 }),
                  R({ id: 2, ca: 'A', ret: 9, buyTimestamp: 100 }),
                  R({ id: 3, ca: 'B', ret: 4, buyTimestamp: 200 })];
    const out = dedupPerToken(rows).sort((a, b) => a.id - b.id);
    assert.deepStrictEqual(out.map(r => r.id), [2, 3], '应保留 A 的最早那条(id2) 和 B');
  });

  testAsync('buildRows: 秒/毫秒两种时间戳都应能匹配，且 buyTimestamp 口径一致', async () => {
    const { buildRows } = await import('../src/lib/data.js');
    const mk = unit => {
      const t = 1784690000 * unit;
      return [[{ id: 1, token_address: 'CA', swap_begin_time: 1784690000, timestamp: t,
                 initial_mcap: 100, current_mcap: 200, max_mcap: 300 }],
              [{ timestamp: t, signal: { token_address: 'CA', swap_begin_time: 1784690000 }, ctx: {} }]];
    };
    const [sec, ms] = await Promise.all([buildRows(...mk(1)), buildRows(...mk(1000))]);
    assert.strictEqual(sec.length, 1, '秒时间戳应能匹配');
    assert.strictEqual(ms.length, 1, '毫秒时间戳应能匹配');
    // 关键：归一化之后两种单位得到同一个绝对时刻，而不是差 1000 倍
    assert.strictEqual(sec[0].buyTimestamp, ms[0].buyTimestamp, '两种单位的 buyTimestamp 必须一致');
    assert.strictEqual(sec[0].buyTimestamp, 1784690000);
  });

  test('formatDuration: 应按量级选单位', () => {
    assert.strictEqual(formatDuration(1800), '30分钟');
    assert.strictEqual(formatDuration(7200), '2.0小时');
    assert.strictEqual(formatDuration(172800), '2.0天');
  });
}
