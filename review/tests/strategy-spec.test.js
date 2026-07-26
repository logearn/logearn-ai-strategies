import assert from 'node:assert';
import { checkStrategySpec, applySpecFix, applyAllSpecFixes, dupCheckNames, F_SHIM } from '../src/lib/strategySpec.js';

const has = (viols, id) => viols.some(v => v.id === id);

export function run(test) {
  test('checkStrategySpec: 用了 f() 但没垫片 → 报 f-without-shim（error）', () => {
    const v = checkStrategySpec("const checks=[['x', f('frequent_volume'), 10, 0,0,1,1]]");
    assert.ok(has(v, 'f-without-shim'));
    assert.strictEqual(v.find(x => x.id === 'f-without-shim').level, 'error');
  });

  test('checkStrategySpec: 有 f 垫片时不报 f-without-shim', () => {
    const v = checkStrategySpec(F_SHIM + "\nconst checks=[['x', f('frequent_volume'), 10, 0,0,1,1]]");
    assert.ok(!has(v, 'f-without-shim'));
  });

  test('checkStrategySpec: 完全不用 f 的策略（1.5段老写法）不报 f-without-shim', () => {
    const v = checkStrategySpec("const checks=[['市值', ctx.logearn.mcap<120000?1:0, 1,1,1,1,1]]; return checks.every(c=>c[1])");
    assert.ok(!has(v, 'f-without-shim'));
  });

  test('checkStrategySpec: VETO_NAMES=new Set(ALL_CHECKS.map(...)) → veto-from-map（error，不可自动修）', () => {
    const v = checkStrategySpec("const ALL_CHECKS=[]; const VETO_NAMES = new Set(ALL_CHECKS.map(c => c[0]))");
    const hit = v.find(x => x.id === 'veto-from-map');
    assert.ok(hit); assert.strictEqual(hit.level, 'error'); assert.strictEqual(hit.fixable, false);
  });

  test('checkStrategySpec: 显式 VETO_NAMES 不报 veto-from-map', () => {
    const v = checkStrategySpec("const VETO_NAMES = new Set(['平台','市值'])");
    assert.ok(!has(v, 'veto-from-map'));
  });

  test('applySpecFix: score>=score → score>=CUTOFF', () => {
    const bad = "checks.push(['总分', score >= score, score.toFixed(1), '>= '+CUTOFF]) SCORE=";
    assert.ok(has(checkStrategySpec(bad), 'score-self-compare'));
    const fixed = applySpecFix(bad, 'score-self-compare');
    assert.ok(/score >= CUTOFF/.test(fixed) && !/score\s*>=\s*score\b/.test(fixed));
    assert.ok(!has(checkStrategySpec(fixed), 'score-self-compare'));
  });

  test('applySpecFix: wsum += weight → wsum += Math.max(0, weight)', () => {
    const bad = "total += s*weight; wsum += weight  // SCORE=";
    assert.ok(has(checkStrategySpec(bad), 'wsum-no-clamp'));
    const fixed = applySpecFix(bad, 'wsum-no-clamp');
    assert.ok(/wsum \+= Math\.max\(0, weight\)/.test(fixed));
    assert.ok(!has(checkStrategySpec(fixed), 'wsum-no-clamp'));
  });

  test('checkStrategySpec: 已经用 Math.max(0,weight) 时不报 wsum-no-clamp', () => {
    assert.ok(!has(checkStrategySpec('wsum += Math.max(0, weight) // SCORE='), 'wsum-no-clamp'));
  });

  test('checkStrategySpec: 缺 SCORE= 标记 → missing-score-mark（warn）', () => {
    assert.ok(has(checkStrategySpec('const checks=[]'), 'missing-score-mark'));
    assert.ok(!has(checkStrategySpec("ctx.log.success('SCORE='+s)"), 'missing-score-mark'));
  });

  test('dupCheckNames: 只在 ALL_CHECKS 块里找重名（不误伤 VETO_NAMES 名单）', () => {
    const code = "const ALL_CHECKS=[['v_re', f('a'),1], ['v_re', f('b'),1], ['x', f('c'),1]]\nconst VETO_NAMES=new Set(['x'])";
    assert.deepStrictEqual(dupCheckNames(code), ['v_re×2'], 'ALL_CHECKS 内 v_re 重复；VETO 里的 x 不算 check 重名');
    const v = checkStrategySpec(code + ' SCORE=');
    assert.ok(has(v, 'dup-check-name'));
    assert.deepStrictEqual(v.find(x => x.id === 'dup-check-name').extra, ['v_re×2']);
  });

  test('dupCheckNames: VETO_NAMES 首元素与 ALL_CHECKS 同名不算重复（回归：平台×2 误报）', () => {
    const code = "const ALL_CHECKS=[['平台', 1,1,1,1,1,1]]\nconst VETO_NAMES=new Set(['平台','市值'])";
    assert.deepStrictEqual(dupCheckNames(code), [], 'ALL_CHECKS 里平台只有一条，VETO 名单不该被算进来');
  });

  test('applyAllSpecFixes: 一次修好可自动修的（补垫片 + score>=CUTOFF + wsum 夹正）', () => {
    const bad = "const checks=[['x', f('frequent_volume'),10,0,0,1,1]]\ntotal+=s*weight; wsum += weight\nchecks.push(['总分', score >= score, '0', ''])\n// SCORE=";
    const fixed = applyAllSpecFixes(bad);
    const v = checkStrategySpec(fixed);
    assert.ok(!has(v, 'f-without-shim'), '垫片已补');
    assert.ok(!has(v, 'score-self-compare'), 'score 已修');
    assert.ok(!has(v, 'wsum-no-clamp'), 'wsum 已夹正');
  });

  test('checkStrategySpec: 合规策略（有垫片/显式veto/正确打分/SCORE）应零 error', () => {
    const good = F_SHIM + "\nconst VETO_NAMES=new Set(['平台'])\ntotal+=s*weight; wsum += Math.max(0, weight)\nchecks.push(['总分', score >= CUTOFF, '0', ''])\nctx.log.success('SCORE='+score)";
    const errs = checkStrategySpec(good).filter(v => v.level === 'error');
    assert.strictEqual(errs.length, 0, '合规代码不应有 error：' + JSON.stringify(errs));
  });
}
