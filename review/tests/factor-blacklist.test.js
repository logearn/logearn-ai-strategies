import assert from 'node:assert';
import { blacklistFactor, unblacklistFactor, clearFactorBlacklist, isFactorBlacklisted,
         sortBlacklistByRecency, blacklistKeySet } from '../src/lib/factorBlacklist.js';
import { recommendFactorPath, recommendFactorPool } from '../src/lib/factorLab.js';
import { buildRecommendPathReport } from '../src/lib/backtestReportExport.js';

// 跟 factor-recommend.test.js 同一套 fixture：good 与 returnMax 完全同序（强信号），
// noise 与之去相关。黑名单的验收点就是"把 good 拉黑之后，贪心必须选不到它"。
function mkRows(n = 120) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ret = ((i * 37) % 100) / 10;
    rows.push({ tokenAddress: 'T' + i, swapBeginTime: 1000 + i, returnMax: ret,
      features: { good: ret, noise: ((i * 53) % 100) / 10 } });
  }
  return rows;
}
const cands = [
  { field: 'good', camp: 'hero', auc: 0.9, direction: 'high', interval: { lo: 5, hi: Infinity } },
  { field: 'noise', camp: 'hero', auc: 0.52, direction: 'high', interval: { lo: 5, hi: Infinity } },
];

export function run(test) {
  // ---------- store ----------
  test('blacklistFactor: 加入黑名单，重复拉黑同一 camp+field 不产生重复条目', () => {
    let list = blacklistFactor([], { camp: 'hero', field: 'shit_volume' });
    assert.strictEqual(list.length, 1);
    list = blacklistFactor(list, { camp: 'hero', field: 'shit_volume' });
    assert.strictEqual(list.length, 1, '重复拉黑不应产生第二条');
  });

  test('blacklistFactor: 同一字段在两个阵营各自独立——允许当勇者因子、不许当邪恶因子', () => {
    let list = blacklistFactor([], { camp: 'hero', field: 'x' });
    assert.ok(isFactorBlacklisted(list, 'hero', 'x'));
    assert.strictEqual(isFactorBlacklisted(list, 'evil', 'x'), false, '阵营不对不算拉黑');
    list = blacklistFactor(list, { camp: 'evil', field: 'x' });
    assert.strictEqual(list.length, 2);
  });

  test('unblacklistFactor: 按 camp+field 精确解除，不影响其它条目', () => {
    let list = blacklistFactor(blacklistFactor([], { camp: 'hero', field: 'a' }), { camp: 'hero', field: 'b' });
    list = unblacklistFactor(list, { camp: 'hero', field: 'a' });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].field, 'b');
  });

  test('clearFactorBlacklist: 一键清空（不分阵营）', () => {
    const list = blacklistFactor(blacklistFactor([], { camp: 'hero', field: 'a' }), { camp: 'evil', field: 'b' });
    assert.strictEqual(clearFactorBlacklist(list).length, 0);
  });

  test('sortBlacklistByRecency: 最近拉黑的排最前（方便解除刚手滑拉黑的）', () => {
    const list = [{ camp: 'hero', field: 'old', blacklistedAt: 100 },
                  { camp: 'hero', field: 'new', blacklistedAt: 900 }];
    assert.deepStrictEqual(sortBlacklistByRecency(list).map(x => x.field), ['new', 'old']);
    assert.strictEqual(list[0].field, 'old', '不应原地修改入参');
  });

  test('blacklistKeySet: 产出 camp:field 的 key 集合，空/未定义安全', () => {
    const s = blacklistKeySet([{ camp: 'evil', field: 'a' }]);
    assert.ok(s.has('evil:a'));
    assert.strictEqual(s.has('hero:a'), false);
    assert.strictEqual(blacklistKeySet(undefined).size, 0);
  });

  // ---------- 接进贪心算法 ----------
  test('recommendFactorPath: 黑名单里的字段不进候选池——拉黑强信号后它不该出现在路径里', () => {
    const base = recommendFactorPath(mkRows(), [], cands, { threshold: 5, missingPolicy: 'zero' });
    assert.strictEqual(base.path[0].field, 'good', '前置条件：不拉黑时 good 会被选中');

    const r = recommendFactorPath(mkRows(), [], cands,
      { threshold: 5, missingPolicy: 'zero', blacklist: [{ camp: 'hero', field: 'good' }] });
    assert.ok(!r.path.some(p => p.field === 'good'), '被拉黑的 good 不该入选');
  });

  test('recommendFactorPath: 拉黑只按 camp+field 精确匹配，拉黑另一阵营不影响本阵营', () => {
    const r = recommendFactorPath(mkRows(), [], cands,
      { threshold: 5, missingPolicy: 'zero', blacklist: [{ camp: 'evil', field: 'good' }] });
    assert.strictEqual(r.path[0]?.field, 'good', '拉黑的是 evil:good，hero:good 应照常入选');
  });

  test('recommendFactorPath: 候选全被拉黑时给出黑名单专属提示，不是"先扫描"', () => {
    const r = recommendFactorPath(mkRows(), [], cands, { threshold: 5, missingPolicy: 'zero',
      blacklist: [{ camp: 'hero', field: 'good' }, { camp: 'hero', field: 'noise' }] });
    assert.strictEqual(r.path.length, 0);
    assert.ok(/黑名单/.test(r.error || ''), `错误信息应点明是黑名单挡的，实际：${r.error}`);
  });

  test('recommendFactorPath: 黑名单不影响起点池——已采信的因子照常当基座参与打分', () => {
    // good 既在起点池里、又被拉黑：拉黑只挡"新增挑选"，不该把它从基座上踢掉，
    // 所以 baseTestRho 应当还是那份含 good 的池子的分数（有限值，且明显为正）。
    const start = [{ field: 'good', camp: 'hero', weight: 100, lo0: -Infinity, lo1: 5, hi1: Infinity, hi0: Infinity }];
    const r = recommendFactorPath(mkRows(), start, cands,
      { threshold: 5, missingPolicy: 'zero', blacklist: [{ camp: 'hero', field: 'good' }] });
    assert.ok(Number.isFinite(r.baseTestRho), '起点池应照常算得出 baseTestRho');
    assert.ok(r.baseTestRho > 0, `起点池里的 good 仍应贡献正的 ρ，实际 ${r.baseTestRho}`);
  });

  test('recommendFactorPool: blacklist 透传到选字段那一步（整条流水线口径一致）', () => {
    const r = recommendFactorPool(mkRows(200), cands,
      { threshold: 5, missingPolicy: 'zero', blacklist: [{ camp: 'hero', field: 'good' }] });
    assert.ok(!(r.path || []).some(p => p.field === 'good'), '被拉黑的字段不该出现在推荐结果里');
  });

  test('buildRecommendPathReport: 报告里要写明这次排除了哪些黑名单字段', () => {
    const path = [{ field: 'good', camp: 'hero', deltaTest: 0.1, deltaIn: 0.12 }];
    const md = buildRecommendPathReport(path, { threshold: 5,
      blacklist: [{ camp: 'hero', field: 'holder_sniper_ratio' }] });
    assert.ok(/黑名单/.test(md), '报告应说明有黑名单');
    assert.ok(md.includes('holder_sniper_ratio'), '应列出被排除的字段名');
    // 不传时不该凭空多出这段（老报告格式不变）
    assert.ok(!/黑名单/.test(buildRecommendPathReport(path, { threshold: 5 })));
  });

  test('recommendFactorPool: 不传 blacklist 时行为跟以前完全一致（默认空清单）', () => {
    const a = recommendFactorPool(mkRows(200), cands, { threshold: 5, missingPolicy: 'zero' });
    const b = recommendFactorPool(mkRows(200), cands, { threshold: 5, missingPolicy: 'zero', blacklist: [] });
    assert.deepStrictEqual((a.path || []).map(p => p.field), (b.path || []).map(p => p.field));
    assert.ok((a.path || []).some(p => p.field === 'good'), '默认不拉黑时 good 仍应入选');
  });
}
