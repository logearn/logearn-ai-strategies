import assert from 'node:assert';
import { applyDefs, testDef, validateName } from '../src/lib/customFieldsRuntime.js';

const mkRows = () => Array.from({ length: 10 }, (_, i) => ({
  id: 'i' + i, symbol: 'S' + i, returnMax: 1 + i, features: { a: i, b: i === 3 ? 0 : 2 },
}));

export function run(test) {
  test('applyDefs: 应把结果写进 features 并统计成功/失败', () => {
    const rows = mkRows();
    const stats = applyDefs(rows, [{ name: 'custom.ratio', code: "f['a'] / f['b']" }]);
    const st = stats.get('custom.ratio');
    assert.strictEqual(st.total, 10);
    assert.ok(st.ok >= 9, `大部分应成功，实际 ${st.ok}`);
    assert.strictEqual(rows[4].features['custom.ratio'], 2);
  });

  test('applyDefs: 除零等无效结果应删除该字段而不是写 0', () => {
    // 缺值和 0 在筛选/分箱/AUC 里语义完全不同，写 0 会静默污染统计
    const rows = mkRows();
    applyDefs(rows, [{ name: 'custom.r', code: "f['a'] / f['b']" }]);
    assert.strictEqual(rows[3].features['custom.r'], undefined, 'b=0 那条应无值');
    assert.ok(!('custom.r' in rows[3].features));
  });

  test('applyDefs: 编译失败应记录原因而不是抛出', () => {
    const rows = mkRows();
    const stats = applyDefs(rows, [{ name: 'custom.bad', code: 'this is not js' }]);
    const st = stats.get('custom.bad');
    assert.ok(/编译失败/.test(st.firstError));
    assert.strictEqual(st.err, 10);
  });

  test('applyDefs: 定义顺序即计算顺序，后面的可引用前面的', () => {
    const rows = mkRows();
    applyDefs(rows, [
      { name: 'custom.x2', code: "f['a'] * 2" },
      { name: 'custom.x4', code: "f['custom.x2'] * 2" },
    ]);
    assert.strictEqual(rows[3].features['custom.x4'], 12);
  });

  test('testDef: 试算应返回样例值和成功率，不改动原数据', () => {
    const rows = mkRows();
    const before = JSON.stringify(rows[0].features);
    const r = testDef(rows, "f['a'] + 1", 3);
    assert.strictEqual(r.ok, 10);
    assert.strictEqual(r.samples.length, 3);
    assert.strictEqual(r.samples[0].value, 1);
    assert.strictEqual(JSON.stringify(rows[0].features), before, '试算不应写入 features');
  });

  test('validateName: 重名/非法字符/与已有字段冲突都要拦住', () => {
    const defs = [{ name: 'custom.dup', code: '1' }];
    assert.ok(validateName('', defs, []).error);
    assert.ok(validateName('a b', defs, []).error, '空格非法');
    assert.ok(validateName('dup', defs, []).error, '与已有自定义字段重名');
    assert.ok(validateName('smart_volume', defs, ['custom.smart_volume']).error, '与数据字段重名');
    assert.strictEqual(validateName('ok_1', defs, []).name, 'custom.ok_1');
    assert.strictEqual(validateName('custom.ok_1', defs, []).name, 'custom.ok_1', '带前缀也应正确归一');
  });
}
