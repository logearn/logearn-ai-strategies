import assert from 'node:assert';
import { addFolder, removeFolder, renameFolder } from '../src/lib/dataFolders.js';

export function run(test) {
  test('addFolder: 新建文件夹追加到名单末尾', () => {
    const list = addFolder(['A'], 'B');
    assert.deepStrictEqual(list, ['A', 'B']);
  });

  test('addFolder: 名字前后空白应去除', () => {
    const list = addFolder([], '  强势盘v1  ');
    assert.deepStrictEqual(list, ['强势盘v1']);
  });

  test('addFolder: 空字符串/纯空白名字应被忽略，原样返回原数组', () => {
    const original = ['A'];
    assert.strictEqual(addFolder(original, '   '), original);
    assert.strictEqual(addFolder(original, ''), original);
  });

  test('addFolder: 重复名字不产生第二条', () => {
    const list = addFolder(['A'], 'A');
    assert.deepStrictEqual(list, ['A']);
  });

  test('removeFolder: 按名字精确移除，不影响其它条目', () => {
    const list = removeFolder(['A', 'B', 'C'], 'B');
    assert.deepStrictEqual(list, ['A', 'C']);
  });

  test('removeFolder: 移除不存在的名字应原样返回', () => {
    assert.deepStrictEqual(removeFolder(['A'], 'Z'), ['A']);
  });

  test('renameFolder: 保持原位置，只替换名字', () => {
    const list = renameFolder(['A', 'B', 'C'], 'B', 'B2');
    assert.deepStrictEqual(list, ['A', 'B2', 'C']);
  });

  test('renameFolder: 改名后与已有名字重复，应去重合并成一个', () => {
    const list = renameFolder(['A', 'B'], 'B', 'A');
    assert.deepStrictEqual(list, ['A']);
  });

  test('renameFolder: 新名字为空/纯空白应忽略，原样返回原数组', () => {
    const original = ['A', 'B'];
    assert.strictEqual(renameFolder(original, 'B', ''), original);
    assert.strictEqual(renameFolder(original, 'B', '   '), original);
  });

  test('renameFolder: from 不在名单里应原样返回（去重后等价，但不应报错）', () => {
    const list = renameFolder(['A', 'B'], 'Z', 'Y');
    assert.deepStrictEqual(list, ['A', 'B']);
  });
}
