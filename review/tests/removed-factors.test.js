import assert from 'node:assert';
import { addRemovedFactor, dropRemovedFactor } from '../src/lib/removedFactors.js';

export function run(test) {
  test('addRemovedFactor: 追加到最前，带 name/line', () => {
    let list = [];
    list = addRemovedFactor(list, { name: '字段A', line: "['字段A', f('a'), 10, 0, 5]" });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, '字段A');
    assert.ok(list[0].line.includes('字段A'));
    assert.ok(list[0].id);
  });

  test('addRemovedFactor: 同名重复删除时，去掉旧记录、保留最新原文（避免堆积重复条目）', () => {
    let list = [];
    list = addRemovedFactor(list, { name: '字段A', line: "['字段A', f('a'), 10, 0, 5]" });
    list = addRemovedFactor(list, { name: '字段A', line: "['字段A', f('a'), 4, 0, 5]" }); // 权重变了
    assert.strictEqual(list.length, 1, '同名只留一条');
    assert.ok(list[0].line.includes(', 4,'), '保留最新那次的原文');
  });

  test('dropRemovedFactor: 按 id 移除（加回来之后从回收站拿掉）', () => {
    let list = [];
    list = addRemovedFactor(list, { name: '字段A', line: "['字段A', 1]" });
    list = addRemovedFactor(list, { name: '字段B', line: "['字段B', 1]" });
    const idA = list.find(x => x.name === '字段A').id;
    list = dropRemovedFactor(list, idA);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, '字段B');
  });
}
