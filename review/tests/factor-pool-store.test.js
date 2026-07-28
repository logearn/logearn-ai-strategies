import assert from 'node:assert';
import { loadFactorPoolState, saveFactorPoolState, clearFactorPoolState } from '../src/lib/factorPoolStore.js';

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

  test('saveFactorPoolState + loadFactorPoolState: 应完整往返存取', () => {
    mem.clear();
    const state = { factors: [{ field: 'a', camp: 'hero', weight: 60 }], threshold: 5, cutoff: 60,
      fieldScope: 'original', scoreShape: 'trap', missingPolicy: 'zero' };
    saveFactorPoolState(state);
    assert.deepStrictEqual(loadFactorPoolState(), state);
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

  globalThis.localStorage = original;
}
