import assert from 'node:assert';
import { excludeToken, unexcludeToken, isExcludedToken, filterExcludedTokens } from '../src/lib/excludedTokens.js';

export function run(test) {
  test('excludeToken: 按 CA 加入排除清单，CA 大小写不敏感，重复删除同一个不产生第二条', () => {
    let list = excludeToken([], { ca: 'AbC', symbol: 'X' });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].ca, 'abc', 'CA 应统一转小写存');
    assert.strictEqual(list[0].symbol, 'X');
    assert.ok(Number.isFinite(list[0].excludedAt));
    list = excludeToken(list, { ca: 'abc', symbol: 'X' });
    assert.strictEqual(list.length, 1, '重复删除同一个 CA 不应产生第二条');
  });

  test('unexcludeToken: 按 CA 精确移出（大小写不敏感），不影响其它条目', () => {
    let list = excludeToken([], { ca: 'aaa', symbol: 'A' });
    list = excludeToken(list, { ca: 'bbb', symbol: 'B' });
    list = unexcludeToken(list, 'AAA');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].ca, 'bbb');
  });

  test('isExcludedToken: 大小写不敏感判定', () => {
    const list = excludeToken([], { ca: 'aaa', symbol: 'A' });
    assert.strictEqual(isExcludedToken(list, 'AAA'), true);
    assert.strictEqual(isExcludedToken(list, 'zzz'), false);
  });

  test('filterExcludedTokens: 真的把匹配的行从数组里拿掉（长度变小），不是标注/降级', () => {
    const rows = [
      { tokenAddress: 'AAA', returnMax: 134.8 },
      { tokenAddress: 'bbb', returnMax: 2.0 },
      { tokenAddress: 'CCC', returnMax: 5.0 },
    ];
    const list = excludeToken([], { ca: 'aaa', symbol: 'X' });
    const next = filterExcludedTokens(rows, list);
    assert.strictEqual(next.length, 2, '排除的那条应该被整条拿掉');
    assert.deepStrictEqual(next.map(r => r.tokenAddress), ['bbb', 'CCC']);
    // 原数组不应被修改
    assert.strictEqual(rows.length, 3);
  });

  test('filterExcludedTokens: 排除清单为空时应原样返回', () => {
    const rows = [{ tokenAddress: 'AAA', returnMax: 1 }];
    assert.strictEqual(filterExcludedTokens(rows, []), rows);
  });

  test('filterExcludedTokens: 同一个 CA 出现多条（比如多天导入重复记录）应该全部一起被剔除', () => {
    const rows = [
      { tokenAddress: 'AAA', returnMax: 134.8, snapTime: 1 },
      { tokenAddress: 'AAA', returnMax: 134.8, snapTime: 2 },
      { tokenAddress: 'bbb', returnMax: 2.0, snapTime: 1 },
    ];
    const list = excludeToken([], { ca: 'aaa', symbol: 'X' });
    const next = filterExcludedTokens(rows, list);
    assert.strictEqual(next.length, 1);
    assert.strictEqual(next[0].tokenAddress, 'bbb');
  });
}
