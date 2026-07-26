import assert from 'node:assert';
import { addStrategyVersion, removeStrategyVersion, extractVersionHint,
         updateStrategyVersion, duplicateStrategyVersion } from '../src/lib/strategyVersions.js';

export function run(test) {
  test('updateStrategyVersion: 就地用新代码覆盖某版本，名字不变、刷新时间、别的不动', () => {
    let list = addStrategyVersion([], { name: 'v1', code: 'a' });
    list = addStrategyVersion(list, { name: 'v2', code: 'b' });
    const v1 = list.find(v => v.name === 'v1');
    const oldSaved = v1.savedAt;
    const next = updateStrategyVersion(list, v1.id, 'a-updated');
    const nv1 = next.find(v => v.id === v1.id);
    assert.strictEqual(nv1.code, 'a-updated');
    assert.strictEqual(nv1.name, 'v1', '名字不变');
    assert.ok(nv1.savedAt >= oldSaved, '时间刷新');
    assert.strictEqual(next.find(v => v.name === 'v2').code, 'b', '别的版本不动');
    assert.strictEqual(next.length, 2, '不新增条目');
  });

  test('duplicateStrategyVersion: 克隆一份、名字加副本、新 id、插到最前', () => {
    let list = addStrategyVersion([], { name: 'v1', code: 'a' });
    const src = list[0];
    const next = duplicateStrategyVersion(list, src.id);
    assert.strictEqual(next.length, 2);
    assert.strictEqual(next[0].name, 'v1 副本', '副本排最前、名字加后缀');
    assert.strictEqual(next[0].code, 'a', '代码原样克隆');
    assert.notStrictEqual(next[0].id, src.id, 'id 不同');
  });

  test('duplicateStrategyVersion: id 不存在时原样返回', () => {
    const list = addStrategyVersion([], { name: 'v1', code: 'a' });
    assert.strictEqual(duplicateStrategyVersion(list, 'nope').length, 1);
  });

  test('addStrategyVersion: 新版本插到最前面，id 唯一，名字去掉首尾空格', () => {
    const v1 = addStrategyVersion([], { name: '  v1  ', code: 'const a = 1;' });
    assert.strictEqual(v1.length, 1);
    assert.strictEqual(v1[0].name, 'v1');
    assert.strictEqual(v1[0].code, 'const a = 1;');
    assert.ok(Number.isFinite(v1[0].savedAt));
    const v2 = addStrategyVersion(v1, { name: 'v2', code: 'const b = 2;' });
    assert.strictEqual(v2.length, 2);
    assert.strictEqual(v2[0].name, 'v2', '新的排最前面');
    assert.notStrictEqual(v2[0].id, v2[1].id, 'id 应唯一');
  });

  test('addStrategyVersion: 允许同名多次保存（保留完整历史，不是覆盖）', () => {
    let list = addStrategyVersion([], { name: 'v1', code: 'a' });
    list = addStrategyVersion(list, { name: 'v1', code: 'b' });
    assert.strictEqual(list.length, 2, '同名应保留两条，不是互相覆盖');
    assert.strictEqual(list[0].code, 'b');
    assert.strictEqual(list[1].code, 'a');
  });

  test('removeStrategyVersion: 按 id 精确删除，不影响其它条目', () => {
    let list = addStrategyVersion([], { name: 'v1', code: 'a' });
    list = addStrategyVersion(list, { name: 'v2', code: 'b' });
    const targetId = list.find(v => v.name === 'v1').id;
    const next = removeStrategyVersion(list, targetId);
    assert.strictEqual(next.length, 1);
    assert.strictEqual(next[0].name, 'v2');
  });

  test('extractVersionHint: 能从形如 code-score.js 的 VERSION 声明里抓出版本号', () => {
    const code = `const VERSION = 'score-v2.1.0'\nconst CUTOFF = 60`;
    assert.strictEqual(extractVersionHint(code), 'score-v2.1.0');
  });

  test('extractVersionHint: 双引号声明也应识别', () => {
    assert.strictEqual(extractVersionHint('VERSION = "v1.0.0"'), 'v1.0.0');
  });

  test('extractVersionHint: 没有 VERSION 声明时应返回 null', () => {
    assert.strictEqual(extractVersionHint('const checks = [];'), null);
  });
}
