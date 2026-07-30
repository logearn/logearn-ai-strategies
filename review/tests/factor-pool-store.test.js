import assert from 'node:assert';
import { loadFactorPoolState, saveFactorPoolState, clearFactorPoolState, SCORE_SCALE_VERSION } from '../src/lib/factorPoolStore.js';

// Node 测试环境没有 localStorage，这个模块全部逻辑都是围绕它做 I/O（无独立可测的纯函数），
// 用一份最小内存实现顶上——只为验证 JSON 序列化/反序列化 + 异常兜底这几条边界行为。
class MemoryStorage {
  constructor() { this.store = new Map(); }
  getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }
  setItem(k, v) { this.store.set(k, String(v)); }
  removeItem(k) { this.store.delete(k); }
  clear() { this.store.clear(); }
}

export function run(test) {
  const original = globalThis.localStorage;
  const mem = new MemoryStorage();
  globalThis.localStorage = mem;
  const KEY = 'chart_factor_pool_v1';

  test('loadFactorPoolState: 从未存过应返回 null', () => {
    mem.clear();
    assert.strictEqual(loadFactorPoolState(), null);
  });

  test('saveFactorPoolState + loadFactorPoolState: 应完整往返存取（存档自动盖上分数尺度版本号）', () => {
    mem.clear();
    const state = { factors: [{ field: 'a', camp: 'hero', weight: 60 }], threshold: 5, cutoff: 60,
      fieldScope: 'original', scoreShape: 'trap', missingPolicy: 'zero' };
    saveFactorPoolState(state);
    assert.deepStrictEqual(loadFactorPoolState(), { ...state, scoreScaleVersion: SCORE_SCALE_VERSION });
  });

  // ---------- 分数尺度换代：旧存档里的 cutoff 必须作废（readme 第 33 节） ----------
  // 2026-07-29 归一分母从「Σ全部权重」改成「Σ勇者权重」，同一个池子的分数整体乘了一个正常数倍。
  // 秩序不变，但 cutoff 的绝对数值全变了（用户真实池子实测 3.37×）。直接恢复旧 cutoff 的后果是
  // 静默的：页面照常显示那个数、触发数却跟上次完全不同，没有任何地方说得清为什么。
  test('loadFactorPoolState: 旧版本存档应摘掉 cutoff 并打 cutoffScaleStale 标记', () => {
    mem.clear();
    mem.setItem(KEY, JSON.stringify({
      factors: [{ field: 'a', camp: 'hero', weight: 60 }, { field: 'b', camp: 'evil', weight: 40 }],
      threshold: 5, cutoff: -42, fieldScope: 'original',
    }));
    const got = loadFactorPoolState();
    assert.ok(!('cutoff' in got), '旧尺度的 cutoff 必须摘掉，不能静默沿用');
    assert.strictEqual(got.cutoffScaleStale, true);
    assert.strictEqual(got.scoreScaleVersion, SCORE_SCALE_VERSION);
    // 因子池本身跟归一分母无关，一个都不该丢——那才是耗时的手工成果
    assert.strictEqual(got.factors.length, 2);
    assert.strictEqual(got.threshold, 5);
    assert.strictEqual(got.fieldScope, 'original');
  });

  test('loadFactorPoolState: 旧存档本来就没存过 cutoff 时不误报 stale', () => {
    mem.clear();
    mem.setItem(KEY, JSON.stringify({ factors: [{ field: 'a' }], threshold: 5 }));
    const got = loadFactorPoolState();
    assert.strictEqual(got.cutoffScaleStale, false, '没有 cutoff 可作废，就不该弹提示');
  });

  test('loadFactorPoolState: 当前版本存档原样返回，不重复报 stale', () => {
    mem.clear();
    saveFactorPoolState({ factors: [{ field: 'a' }], cutoff: -42 });
    const got = loadFactorPoolState();
    assert.strictEqual(got.cutoff, -42, '同版本的 cutoff 是新尺度的，应照常恢复');
    assert.ok(!('cutoffScaleStale' in got));
  });

  test('loadFactorPoolState: 存储内容是损坏的 JSON 应返回 null，不抛错', () => {
    mem.clear();
    mem.setItem(KEY, '{not valid json');
    assert.strictEqual(loadFactorPoolState(), null);
  });

  test('loadFactorPoolState: 存储内容解析出来不是对象（比如纯字符串/数字）应返回 null', () => {
    mem.clear();
    mem.setItem(KEY, JSON.stringify('hello'));
    assert.strictEqual(loadFactorPoolState(), null);
    mem.setItem(KEY, JSON.stringify(42));
    assert.strictEqual(loadFactorPoolState(), null);
  });

  test('clearFactorPoolState: 清空后应读不到，且不影响其它 key', () => {
    mem.clear();
    mem.setItem('unrelated_key', 'keep-me');
    saveFactorPoolState({ factors: [{ field: 'a' }] });
    clearFactorPoolState();
    assert.strictEqual(loadFactorPoolState(), null);
    assert.strictEqual(mem.getItem('unrelated_key'), 'keep-me', '不应误删其它 localStorage key');
  });

  test('saveFactorPoolState: localStorage 抛错（如隐私模式配额满）时不应向外抛出', () => {
    mem.clear();
    const throwing = { setItem() { throw new Error('quota exceeded'); } };
    globalThis.localStorage = throwing;
    assert.doesNotThrow(() => saveFactorPoolState({ factors: [] }));
    globalThis.localStorage = mem;
  });

  
  // ---------- 缺失率闸门必须活过刷新（readme 第 39 节） ----------
  // 它是唯一真正限制「因子推荐」能选到什么的过滤器（其余只影响候选表展示）。
  // 原来默认 100=全放行、又不进持久化 → 每次刷新静默回到全放行，
  // readme 第 102 节"算推荐挑进缺失率 95%+ 字段"的事故就是这么复发的。
  test('candFilter 必须往返持久化（缺失率闸门不能一刷新就丢）', () => {
    mem.clear();
    const candFilter = { minMarginal: 0.005, maxMissRate: 10 };
    saveFactorPoolState({ factors: [{ field: 'a', camp: 'hero', weight: 60 }], candFilter });
    assert.deepStrictEqual(loadFactorPoolState().candFilter, candFilter);
  });

  test('candFilter: 只改了一项也要整体存下来', () => {
    mem.clear();
    saveFactorPoolState({ factors: [{ field: 'a' }], candFilter: { minMarginal: 0, maxMissRate: 5 } });
    const got = loadFactorPoolState().candFilter;
    assert.strictEqual(got.maxMissRate, 5);
    assert.strictEqual(got.minMarginal, 0, '0 是有效值，不能被当成"未设置"丢掉');
  });

  test('旧存档没有 candFilter 时不报错（调用方用默认值兜底）', () => {
    mem.clear();
    mem.setItem(KEY, JSON.stringify({ factors: [{ field: 'a' }], threshold: 5 }));
    const got = loadFactorPoolState();
    assert.strictEqual(got.candFilter, undefined);
    assert.ok(Array.isArray(got.factors), '其余字段照常恢复');
  });

  globalThis.localStorage = original;
}
