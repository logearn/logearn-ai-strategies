import assert from 'node:assert';
import { applyWeightsToSrc, removeCheckLineFromSrc, applyChangeSetToSrc, reAddFactorLine, removeCheckLineByField,
         addCampEntry, campGroupOf, groupCampEntries, renameCampGroup, moveCampEntriesToGroup,
         DEFAULT_CAMP_GROUP, campGroupThresholdOf, setCampGroupThreshold, applyCampEntryInterval,
         intervalChanged, roundCampBound, DEFAULT_CAMP_WIN_THRESHOLD, dedupeCampEntries,
         buildAllChecksRow, parseVetoNames, replaceScoreRowsInAllChecks } from '../src/lib/campLibrary.js';

export function run(test) {
  // ---------- 发送到策略：整体替换打分段 ----------
  const baseStrategy = [
    "const CUTOFF = 60",
    "const ALL_CHECKS = [",
    "  ['平台', f('platform_ok'), 1, 1, 1, 1, 1, null, '白名单'],",   // 硬否决行（在 VETO_NAMES 里）
    "  ['旧因子A', f('old_a'), 20, 0, 0, 5, 5, null, '0~5'],",         // 旧打分行（要被替换）
    "  ['旧因子B', f('old_b'), 30, -Infinity, -Infinity, 2, 2, null, '~2'],",
    "]",
    "const VETO_NAMES = new Set(['平台'])",
    "for (const c of ALL_CHECKS) {}",
  ].join('\n');

  test('buildAllChecksRow: 给四点梯形应原样写出 lo0/lo1/hi1/hi0，不再零宽度', () => {
    const row = buildAllChecksRow({ field: 'x', camp: 'hero', weight: 12.5, lo0: -Infinity, lo1: -Infinity, hi1: 1.5, hi0: 31.7 });
    assert.ok(row.includes("f('x')"));
    assert.ok(row.includes('12.5'));
    assert.ok(row.includes('-Infinity, -Infinity, 1.5, 31.7'), row);
  });

  test('buildAllChecksRow: 邪恶阵营应写负权重', () => {
    const row = buildAllChecksRow({ field: 'y', camp: 'evil', weight: 8, lo0: 0, lo1: 0, hi1: 3, hi0: 3 });
    assert.ok(/,\s*-8,/.test(row), row);
  });

  test('buildAllChecksRow: 只给 lo/hi（阵营库老口径）应退回零宽度', () => {
    const row = buildAllChecksRow({ field: 'z', camp: 'hero', weight: 5, lo: 2, hi: 9 });
    assert.ok(row.includes('2, 2, 9, 9'), row);
  });

  test('parseVetoNames: 解析出 VETO_NAMES 集合', () => {
    const s = parseVetoNames(baseStrategy);
    assert.ok(s.has('平台'));
    assert.strictEqual(s.size, 1);
  });

  test('replaceScoreRowsInAllChecks: 保留硬否决行、替换打分行、同步 CUTOFF', () => {
    const factors = [
      { field: 'new_a', camp: 'hero', weight: 40, lo0: -Infinity, lo1: -Infinity, hi1: 1.5, hi0: 31.7 },
      { field: 'new_b', camp: 'evil', weight: 25, lo0: 5, lo1: 5, hi1: Infinity, hi0: Infinity },
    ];
    const res = replaceScoreRowsInAllChecks(baseStrategy, factors, { cutoff: 80 });
    assert.ok(!res.error, res.error);
    assert.strictEqual(res.removed, 2);      // 旧因子A/B 被删
    assert.strictEqual(res.inserted, 2);
    assert.ok(res.next.includes("f('platform_ok')"), '硬否决行必须保留');
    assert.ok(!res.next.includes("f('old_a')") && !res.next.includes("f('old_b')"), '旧打分行必须删除');
    assert.ok(res.next.includes("f('new_a')") && res.next.includes("f('new_b')"), '新因子必须写入');
    assert.ok(/,\s*-25,/.test(res.next), '邪恶因子应负权重');
    assert.ok(res.cutoffSynced && res.next.includes('const CUTOFF = 80'), 'CUTOFF 应同步为 80');
  });

  test('replaceScoreRowsInAllChecks: 非 ALL_CHECKS 架构应返回 error', () => {
    const res = replaceScoreRowsInAllChecks("const checks = []\nreturn true", [{ field: 'a', camp: 'hero', weight: 1, lo0: 0, lo1: 0, hi1: 1, hi0: 1 }], {});
    assert.ok(res.error);
  });

  test('replaceScoreRowsInAllChecks: VETO 行即便用 f() 取值也不被删', () => {
    const s = [
      "const ALL_CHECKS = [",
      "  ['防雷', f('scam'), 1, 1, 1, 1, 1, null, 'x'],",
      "  ['打分', f('sig'), 10, 0, 0, 5, 5, null, 'y'],",
      "]",
      "const VETO_NAMES = new Set(['防雷'])",
    ].join('\n');
    const res = replaceScoreRowsInAllChecks(s, [], {});
    assert.strictEqual(res.removed, 1);              // 只删打分行
    assert.ok(res.next.includes("f('scam')"));       // VETO 行（用 f()）保留
  });

  // ---------- 高倍落点校验：分组级阈值 + 区间比对 ----------
  test('campGroupThresholdOf: 分组没设过回落默认，设了用分组自己的', () => {
    assert.strictEqual(campGroupThresholdOf({}, '强势盘'), DEFAULT_CAMP_WIN_THRESHOLD);
    assert.strictEqual(campGroupThresholdOf({ '强势盘': 0 }, '强势盘'), DEFAULT_CAMP_WIN_THRESHOLD, '0/负数回落');
    assert.strictEqual(campGroupThresholdOf({ '强势盘': 10 }, '强势盘'), 10);
  });

  test('setCampGroupThreshold: 只改指定分组，别的分组不动', () => {
    const map = setCampGroupThreshold({ A: 2 }, 'B', 5);
    assert.strictEqual(map.A, 2);
    assert.strictEqual(map.B, 5);
  });

  test('applyCampEntryInterval: 只改指定 id 的区间', () => {
    const list = [{ id: 1, field: 'a', lo: null, hi: 5 }, { id: 2, field: 'b' }];
    const iv = applyCampEntryInterval(list, 1, 3, 8);
    assert.strictEqual(iv[0].lo, 3); assert.strictEqual(iv[0].hi, 8);
    assert.strictEqual(iv[1].lo, undefined, '别的条目不动');
  });

  test('removeCheckLineByField: 删掉含 f(\'字段\') 的那一行（供发送到策略 upsert）', () => {
    const src = "const A=[\n  ['甲', f('new_volume'), 10, 0,0,5,5],\n  ['乙', f('old_volume'), 8, 0,0,5,5],\n]";
    const { next, removed } = removeCheckLineByField(src, 'new_volume');
    assert.strictEqual(removed, 1);
    assert.ok(!next.includes("f('new_volume')"), 'new_volume 行已删');
    assert.ok(next.includes("f('old_volume')"), 'old_volume 行保留');
    // 点号字段名要正则转义，不能误删别的
    assert.strictEqual(removeCheckLineByField("['x', f('gmgn.stat.top_10_holder_rate'), 5]", 'gmgn.stat.top_10_holder_rate').removed, 1);
  });

  test('intervalChanged: 相对容差内不算变，超出/开闭翻转算变', () => {
    // 保存 ≤10（lo=null=开），实测 (-Inf, 9.8]：右界 9.8 vs 10 差 2% < 15% → 不变
    assert.strictEqual(intervalChanged({ lo: null, hi: 10 }, { lo: -Infinity, hi: 9.8 }), false);
    // 实测右界 6（vs 10 差 40%）→ 变了
    assert.strictEqual(intervalChanged({ lo: null, hi: 10 }, { lo: -Infinity, hi: 6 }), true);
    // 保存开区间的一侧，实测变成有界 → 变了
    assert.strictEqual(intervalChanged({ lo: null, hi: 10 }, { lo: 2, hi: 9.9 }), true);
    // 双界都吻合 → 不变
    assert.strictEqual(intervalChanged({ lo: 20, hi: 30 }, { lo: 20.5, hi: 29.6 }), false);
  });

  test('roundCampBound: ±Infinity→null（开区间），有限值保留 4 位有效数字', () => {
    assert.strictEqual(roundCampBound(Infinity), null);
    assert.strictEqual(roundCampBound(-Infinity), null);
    assert.strictEqual(roundCampBound(12.34567), 12.35);
  });

  // ---------- 阵营库分组 ----------
  test('campGroupOf: 有 group 用 group，空/缺省归到默认组', () => {
    assert.strictEqual(campGroupOf({ group: '强势盘v1' }), '强势盘v1');
    assert.strictEqual(campGroupOf({ group: '  ' }), DEFAULT_CAMP_GROUP, '空白 group 算默认组');
    assert.strictEqual(campGroupOf({}), DEFAULT_CAMP_GROUP, '老收藏没 group 归默认组');
  });

  test('addCampEntry: 带 group 时落进该组，不带时进默认组', () => {
    const withG = addCampEntry([], { field: 'x', camp: 'hero', lo: 1, hi: 5, group: '强势盘v1' })[0];
    assert.strictEqual(withG.group, '强势盘v1');
    const noG = addCampEntry([], { field: 'y', camp: 'evil' })[0];
    assert.strictEqual(noG.group, DEFAULT_CAMP_GROUP);
  });

  test('addCampEntry: 同一字段同一阵营再次收藏是更新，不是新增重复行', () => {
    const first = addCampEntry([], { field: 'x', camp: 'hero', lo: 1, hi: 5, group: 'A', weight: 10 });
    const second = addCampEntry(first, { field: 'x', camp: 'hero', lo: 2, hi: 8, group: 'B' });
    assert.strictEqual(second.length, 1, '同字段同阵营不应变成两条');
    assert.strictEqual(second[0].id, first[0].id, '就地更新，id 不变');
    assert.strictEqual(second[0].lo, 2);
    assert.strictEqual(second[0].hi, 8);
    assert.strictEqual(second[0].group, 'A', '重新收藏不应把已归好的分组挪走');
    assert.strictEqual(second[0].weight, 10, '没传新权重时保留原权重');
  });

  test('addCampEntry: 同字段不同阵营（hero/evil）各自独立，不互相覆盖', () => {
    const withHero = addCampEntry([], { field: 'x', camp: 'hero', lo: 1, hi: 5 });
    const withBoth = addCampEntry(withHero, { field: 'x', camp: 'evil', lo: -5, hi: -1 });
    assert.strictEqual(withBoth.length, 2);
  });

  test('dedupeCampEntries: 同字段同阵营只留 addedAt 最新的一条', () => {
    const list = [
      { field: 'x', camp: 'hero', addedAt: 1, id: 'old' },
      { field: 'x', camp: 'hero', addedAt: 2, id: 'new' },
      { field: 'y', camp: 'evil', addedAt: 1, id: 'y1' },
    ];
    const deduped = dedupeCampEntries(list);
    assert.strictEqual(deduped.length, 2);
    assert.ok(deduped.some(e => e.id === 'new'));
    assert.ok(!deduped.some(e => e.id === 'old'));
  });

  test('groupCampEntries: 按组归拢 + 注入空的额外分组（当前收藏组还没东西也要显示）', () => {
    const list = [
      { id: 1, field: 'a', group: '强势盘v1' },
      { id: 2, field: 'b', group: '强势盘v1' },
      { id: 3, field: 'c' }, // 老收藏 → 默认组
    ];
    const groups = groupCampEntries(list, ['新一轮']);
    const byName = Object.fromEntries(groups.map(g => [g.group, g.count]));
    assert.strictEqual(byName['强势盘v1'], 2);
    assert.strictEqual(byName[DEFAULT_CAMP_GROUP], 1);
    assert.strictEqual(byName['新一轮'], 0, '空的额外分组也列出来，count=0');
    assert.strictEqual(groups[0].group, '强势盘v1', '按 count 降序，最多的排前');
  });

  test('renameCampGroup: 把某组所有收藏迁到新名字（含默认组的老收藏）', () => {
    const list = [{ id: 1, field: 'a', group: '未分组' }, { id: 2, field: 'b' }, { id: 3, field: 'c', group: '别的' }];
    const next = renameCampGroup(list, DEFAULT_CAMP_GROUP, '强势盘v1');
    assert.strictEqual(campGroupOf(next[0]), '强势盘v1');
    assert.strictEqual(campGroupOf(next[1]), '强势盘v1', '没写 group 的老收藏也算默认组，一并迁走');
    assert.strictEqual(campGroupOf(next[2]), '别的', '别的组不动');
  });

  test('moveCampEntriesToGroup: 只挪选中的 id', () => {
    const list = [{ id: 1, field: 'a', group: 'G1' }, { id: 2, field: 'b', group: 'G1' }];
    const next = moveCampEntriesToGroup(list, [2], 'G2');
    assert.strictEqual(campGroupOf(next[0]), 'G1');
    assert.strictEqual(campGroupOf(next[1]), 'G2');
  });

  test('applyWeightsToSrc: 只替换 ALL_CHECKS 行里第 3 个数字（权重），不碰区间数字', () => {
    const src = `const ALL_CHECKS = [\n  ['字段A', f('a'), 10, 1, 1, 5, 5, null, '1~5'],\n];\n`;
    const { next, appliedCount } = applyWeightsToSrc(src, [{ name: '字段A', weight: 6 }]);
    assert.strictEqual(appliedCount, 1);
    assert.ok(next.includes("['字段A', f('a'), 6, 1, 1, 5, 5, null, '1~5')".replace(')', ']')) ||
      next.includes("f('a'), 6, 1, 1, 5, 5"));
  });

  test('applyWeightsToSrc: 支持负权重（邪恶阵营）', () => {
    const src = `const ALL_CHECKS = [\n  ['字段B', f('b'), -10, 0, 0, 1, 1, null, '0~1'],\n];\n`;
    const { next, appliedCount } = applyWeightsToSrc(src, [{ name: '字段B', weight: -4 }]);
    assert.strictEqual(appliedCount, 1);
    assert.ok(next.includes("f('b'), -4, 0, 0, 1, 1"));
  });

  test('applyWeightsToSrc: 找不到对应字段名的行时该条不计入 appliedCount，其余正常应用', () => {
    const src = `const ALL_CHECKS = [\n  ['字段A', f('a'), 10, 1, 1, 5, 5, null, '1~5'],\n];\n`;
    const { next, appliedCount } = applyWeightsToSrc(src, [
      { name: '字段A', weight: 7 },
      { name: '不存在的字段', weight: 99 },
    ]);
    assert.strictEqual(appliedCount, 1);
    assert.ok(next.includes("f('a'), 7, 1, 1, 5, 5"));
  });

  test('applyWeightsToSrc: 多条同时替换', () => {
    const src = `const ALL_CHECKS = [\n  ['字段A', f('a'), 10, 1, 1, 5, 5, null, '1~5'],\n  ['字段B', f('b'), -10, 0, 0, 1, 1, null, '0~1'],\n];\n`;
    const { next, appliedCount } = applyWeightsToSrc(src, [
      { name: '字段A', weight: 3 },
      { name: '字段B', weight: -8 },
    ]);
    assert.strictEqual(appliedCount, 2);
    assert.ok(next.includes("f('a'), 3, 1, 1, 5, 5"));
    assert.ok(next.includes("f('b'), -8, 0, 0, 1, 1"));
  });

  test('removeCheckLineFromSrc: 删掉指定 check 行，只删这条 tuple 不带走收尾括号，并返回原文', () => {
    const src = `const ALL_CHECKS = [\n  ['字段A', f('a'), 10, 0, 5],\n  ['字段B', f('b'), 8, 0, 5]]\n`;
    const { next, removedLine } = removeCheckLineFromSrc(src, ['字段B(分)', '字段B']);
    assert.strictEqual(removedLine, "['字段B', f('b'), 8, 0, 5]");
    // 收尾的 "]" 不能被带走：数组仍闭合
    assert.ok(next.includes("['字段A', f('a'), 10, 0, 5]"));
    assert.ok(!next.includes('字段B'));
    assert.ok(next.trimEnd().endsWith(']'), '数组收尾括号应保留');
  });

  test('removeCheckLineFromSrc: 找不到对应标签时返回 removedLine=null 且源码原样', () => {
    const src = `const ALL_CHECKS = [\n  ['字段A', f('a'), 10, 0, 5],\n]\n`;
    const { next, removedLine } = removeCheckLineFromSrc(src, ['不存在']);
    assert.strictEqual(removedLine, null);
    assert.strictEqual(next, src);
  });

  test('applyChangeSetToSrc: 同时调权重+删因子，返回 next / adjustedCount / removedLines', () => {
    const src = `const ALL_CHECKS = [\n  ['字段A', f('a'), 10, 0, 5],\n  ['字段B', f('b'), 8, 0, 5],\n  ['字段C', f('c'), 2, 0, 5],\n]\n`;
    const { next, adjustedCount, removedLines } = applyChangeSetToSrc(src, {
      adjusts: [{ name: '字段A', weight: 12 }],
      removes: [{ name: '字段C', candidates: ['字段C(分)', '字段C'] }],
    });
    assert.strictEqual(adjustedCount, 1);
    assert.strictEqual(removedLines.length, 1);
    assert.strictEqual(removedLines[0].name, '字段C');
    assert.ok(next.includes("f('a'), 12, 0, 5"));
    assert.ok(!next.includes('字段C'));
  });

  test('reAddFactorLine: 把删掉的行原样加回 ALL_CHECKS（补逗号，数组仍合法）', () => {
    const src = `const ALL_CHECKS = [\n  ['字段A', f('a'), 10, 0, 5],\n]\n`;
    const line = "['字段B', f('b'), 8, 0, 5]"; // removeCheckLineFromSrc 截出来的原文，不带尾逗号
    const next = reAddFactorLine(src, line);
    assert.ok(next.includes("['字段B', f('b'), 8, 0, 5],"), '加回来的行应补上尾逗号');
    assert.ok(next.includes("['字段A', f('a'), 10, 0, 5]"), '原有行保留');
  });

  test('删除→加回来 往返：先删再加回，因子仍在（区间/权重原样）', () => {
    const src = `const ALL_CHECKS = [\n  ['字段A', f('a'), 10, 0, 5],\n  ['字段B', f('b'), 8, 1, 9],\n]\n`;
    const { next: afterRemove, removedLine } = removeCheckLineFromSrc(src, ['字段B(分)', '字段B']);
    assert.ok(!afterRemove.includes('字段B'));
    const restored = reAddFactorLine(afterRemove, removedLine);
    assert.ok(restored.includes("['字段B', f('b'), 8, 1, 9]"), '加回来的因子区间/权重应原样');
  });
}
