import assert from 'node:assert';
import { compileStrategy, runStrategyOnRow, aggregateCheckStats, buildStrategyVerdict } from '../src/lib/proAnalytics.js';

const SRC = `
  const checks = [
    ['买家数', ctx.buyer_count > 100, ctx.buyer_count, '> 100'],
    ['聪明钱', ctx.smart > 30, ctx.smart, '> 30'],
  ];
  return checks.every(c => c[1]);
`;
const row = (buyer, smart, ret, extra) => ({
  symbol: 'S', tokenAddress: 'CA' + buyer, returnMax: ret, buyTimestamp: 1784690000,
  rawCtx: { buyer_count: buyer, smart, ...extra },
});

export function run(test) {
  test('runStrategyOnRow: 应返回逐条 check 的通过情况和期望值', () => {
    const c = compileStrategy(SRC);
    assert.ok(!c.error, JSON.stringify(c));
    const r = runStrategyOnRow(c, row(200, 50, 3));
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.checks.length, 2);
    assert.strictEqual(r.checks[0].expect, '> 100', '期望条件要保留——只看"值=14"判断不出阈值是多少');
  });

  test('runStrategyOnRow: 策略可用 f(\'字段名\') 按分析字段过滤，不只是 ctx 原始路径', () => {
    // features 里的字段（如 holder_top30_share_pct）在 ctx 里不存在，必须通过 f 访问
    const c = compileStrategy("const checks = [['前30集中度', f('holder_top30_share_pct') > 50, f('holder_top30_share_pct'), '> 50']]; return checks.every(cc => cc[1]);");
    assert.ok(!c.error, JSON.stringify(c));
    const row = { symbol: 'S', tokenAddress: 'CA', returnMax: 3, buyTimestamp: 1784690000,
      rawCtx: { anything: 1 }, features: { 'holder_top30_share_pct': 61.5 } };
    const r = runStrategyOnRow(c, row);
    assert.strictEqual(r.passed, true, '61.5 > 50 应通过');
    assert.strictEqual(Number(r.checks[0].value), 61.5, 'f 应取到 features 里的值');
  });

  test('runStrategyOnRow: 老策略只用 ctx 不受 f 参数影响', () => {
    const c = compileStrategy('const checks = [["x", ctx.a > 5, ctx.a, "> 5"]]; return checks.every(cc => cc[1]);');
    const row = { symbol: 'S', tokenAddress: 'CA', returnMax: 2, buyTimestamp: 1784690000, rawCtx: { a: 9 }, features: {} };
    assert.strictEqual(runStrategyOnRow(c, row).passed, true);
  });

  test('aggregateCheckStats: 策略在 checks 赋值前 return 的样本，应算作未命中而不是消失', () => {
    // 用户 v34 场景：策略有前置 if(...) return false，checks 还没赋值就退出。
    // 以前这些样本从所有统计里消失（命中 0、未命中也空、看板"暂无数据"）。
    const c = compileStrategy('try { if (ctx.a < 5) return false; const checks = [["x", true, 1, ""]]; return checks.every(cc => cc[1]); } catch(e) { ctx.log.error("失败:" + e.message); return false; }');
    const mk = (a, ret) => ({ symbol: 'S', tokenAddress: 'CA', returnMax: ret, buyTimestamp: 1784690000, rawCtx: { a }, features: {} });
    // 一半提前退出（a<5），一半正常有 checks
    const rows = [mk(1, 3), mk(1, 2), mk(1, 1), mk(9, 5), mk(9, 8)];
    const agg = aggregateCheckStats(rows.map(r => ({ input: '', row: r, res: runStrategyOnRow(c, r) })));
    assert.strictEqual(agg.valid, 5, '5 条都跑通了');
    assert.strictEqual(agg.noChecks, 3, '3 条提前退出、无 checks 明细');
    assert.strictEqual(agg.noChecksMiss, 3, '这 3 条都算未命中');
    assert.strictEqual(agg.missRets.length, 3, '未命中组应含这 3 条（不再消失）');
    assert.strictEqual(agg.hits, 2, '另 2 条正常命中');
    assert.ok(agg.noCheckReasons.length > 0, '应给出退出原因');
  });

  test('runStrategyOnRow: 没有 rawCtx 的样本应给出可读错误而不是抛异常', () => {
    const c = compileStrategy(SRC);
    const r = runStrategyOnRow(c, { returnMax: 2 });
    assert.ok(r.error && /ctx/.test(r.error));
  });

  test('runStrategyOnRow: Date 必须冻结在买入时刻，否则是未来函数', () => {
    const c = compileStrategy('const checks=[["t", true, Date.now(), ""]]; return true;');
    const r = runStrategyOnRow(c, row(200, 50, 3));
    assert.strictEqual(Number(r.checks[0].value), 1784690000 * 1000, '应是买入时刻而不是运行时的现在');
  });

  test('runStrategyOnRow: 策略抛异常应被捕获成 error', () => {
    const c = compileStrategy('const checks = []; return ctx.a.b.c;');
    const r = runStrategyOnRow(c, row(1, 1, 1));
    assert.ok(r.error, '应捕获而不是把异常抛给调用方');
  });

  test('runStrategyOnRow: 策略不应污染原始 ctx', () => {
    const c = compileStrategy('ctx.injected = 1; const checks=[["x",true,1,""]]; return true;');
    const r0 = row(200, 50, 3);
    runStrategyOnRow(c, r0);
    assert.strictEqual(r0.rawCtx.injected, undefined, 'ctx 是浅拷贝，写入不能落到原始快照上');
  });

  test('aggregateCheckStats: 命中数要从 res 里取，不能取 r.passed', () => {
    // 旧版误写成 r.passed（永远 undefined），命中数恒为 0，跑全量才暴露
    const c = compileStrategy(SRC);
    const rows = [row(200, 50, 5), row(200, 10, 3), row(50, 50, 2), row(10, 10, 1)];
    const results = rows.map(rw => ({ input: rw.tokenAddress, row: rw, res: runStrategyOnRow(c, rw) }));
    const agg = aggregateCheckStats(results);
    assert.strictEqual(agg.hits, 1, '只有第一条两项都过');
    assert.deepStrictEqual(agg.hitRets, [5]);
  });

  test('aggregateCheckStats: 单点否决（soleBlock）= 只卡在这一条', () => {
    const c = compileStrategy(SRC);
    // 第2条只卡"聪明钱"，第3条只卡"买家数"，第4条两条都卡（不算任何一条的单点否决）
    const rows = [row(200, 50, 5), row(200, 10, 3), row(50, 50, 2), row(10, 10, 1)];
    const results = rows.map(rw => ({ input: '', row: rw, res: runStrategyOnRow(c, rw) }));
    const { ranked } = aggregateCheckStats(results);
    const byName = Object.fromEntries(ranked.map(r => [r.name, r]));
    assert.strictEqual(byName['聪明钱'].soleBlock, 1);
    assert.strictEqual(byName['买家数'].soleBlock, 1);
    assert.strictEqual(byName['聪明钱'].fail, 2, '被卡 2 次，但只有 1 次是单点否决');
  });

  test('aggregateCheckStats: 通过的样本也要记 value，否则没法扫阈值', () => {
    const c = compileStrategy(SRC);
    const rows = [row(200, 50, 5), row(50, 50, 2)];
    const results = rows.map(rw => ({ input: '', row: rw, res: runStrategyOnRow(c, rw) }));
    const { ranked } = aggregateCheckStats(results);
    const st = ranked.find(r => r.name === '买家数');
    assert.strictEqual(st.all.length, 2, '两侧都要有值才能搜出最佳阈值');
    assert.ok(st.all.some(a => a.ok) && st.all.some(a => !a.ok));
  });

  test('aggregateCheckStats: 未命中账要拆开——命中 + 只卡1条 + 卡≥2条 = 总数，且单点否决之和 = 只卡1条', () => {
    // 用户困惑点：单点否决合计 ≠ 未命中数。差额是"卡多条"的样本。这里把账钉死。
    const c = compileStrategy('const checks = [["A", ctx.a > 5, ctx.a, "> 5"], ["B", ctx.b > 5, ctx.b, "> 5"]]; return checks.every(cc => cc[1]);');
    const mk = (a, b) => ({ symbol: 'S', tokenAddress: 'CA', returnMax: 2, buyTimestamp: 1784690000, rawCtx: { a, b } });
    const rows = [
      mk(9, 9),  // 都过 → 命中
      mk(9, 9),  // 都过 → 命中
      mk(1, 9),  // 只卡 A → 单点否决
      mk(9, 1),  // 只卡 B → 单点否决
      mk(1, 1),  // A、B 都卡 → 多条拦截，不算任何单点否决
    ];
    const results = rows.map(r => ({ input: '', row: r, res: runStrategyOnRow(c, r) }));
    const agg = aggregateCheckStats(results);
    assert.strictEqual(agg.hits, 2, '2 条全过');
    assert.strictEqual(agg.soleBlocked, 2, '2 条只卡 1 条');
    assert.strictEqual(agg.multiBlocked, 1, '1 条卡 2 条');
    // 账要平：命中 + 只卡1条 + 卡≥2条 = 总数
    assert.strictEqual(agg.hits + agg.soleBlocked + agg.multiBlocked, agg.valid);
    // 各条单点否决之和 应等于 soleBlocked
    const soleSum = agg.ranked.reduce((n, r) => n + r.soleBlock, 0);
    assert.strictEqual(soleSum, agg.soleBlocked, '单点否决之和必须等于"只卡1条"的样本数');
  });

  test('aggregateCheckStats: 应标出"退步"的 check——拦掉的样本反而比放行的更能赢', () => {
    // 造一条"帮倒圈"的 check：它拦掉的全是大赢家，放行的全是输家
    const c = compileStrategy('const checks = [["坏过滤", ctx.x < 5, ctx.x, "< 5"]]; return checks.every(cc => cc[1]);');
    const mk = (x, ret) => ({ symbol: 'S', tokenAddress: 'CA', returnMax: ret, buyTimestamp: 1784690000, rawCtx: { x } });
    // x>=5 被拦（ret=8 大赢）；x<5 放行（ret=1 输）
    const rows = [
      mk(9, 8), mk(9, 9), mk(9, 7), mk(9, 8),   // 被拦，全是赢家
      mk(1, 1), mk(1, 1.2), mk(1, 0.8), mk(1, 1.1),  // 放行，全是输家
    ];
    const results = rows.map(r => ({ input: '', row: r, res: runStrategyOnRow(c, r) }));
    const agg = aggregateCheckStats(results);
    const st = agg.ranked.find(r => r.name === '坏过滤');
    assert.strictEqual(st.effect, 'hurts', '拦掉赢家的 check 应判为退步，实际 ' + st.effect);
    assert.ok(st.winLift < 0, '放行组胜率应低于拦掉组');
  });

  test('aggregateCheckStats: 真正有效的 check 应判为 helps', () => {
    const c = compileStrategy('const checks = [["好过滤", ctx.x > 5, ctx.x, "> 5"]]; return checks.every(cc => cc[1]);');
    const mk = (x, ret) => ({ symbol: 'S', tokenAddress: 'CA', returnMax: ret, buyTimestamp: 1784690000, rawCtx: { x } });
    // x>5 放行（ret=8 赢）；x<=5 拦掉（ret=1 输）—— 这条正确地过滤掉了差样本
    const rows = [mk(9, 8), mk(9, 9), mk(9, 7), mk(1, 1), mk(1, 1.1), mk(1, 0.9)];
    const results = rows.map(r => ({ input: '', row: r, res: runStrategyOnRow(c, r) }));
    const agg = aggregateCheckStats(results);
    assert.strictEqual(agg.ranked.find(r => r.name === '好过滤').effect, 'helps');
  });

  test('aggregateCheckStats: 单点否决多是赢家时应标 soleHurts——松绑这条能净抓赢家', () => {
    // 用户真实场景：全局看"有效"，但只卡这一条的样本（单点否决）多是赢家。
    // 松绑这条 check，能放回来的正好是这些单点否决样本——它们是赢家，所以这条在误杀。
    const c = compileStrategy('const checks = [["A", ctx.a < 50, ctx.a, "< 50"], ["B", ctx.b > 5, ctx.b, "> 5"]]; return checks.every(cc => cc[1]);');
    const mk = (a, b, ret) => ({ symbol: 'S', tokenAddress: 'CA', returnMax: ret, buyTimestamp: 1784690000, rawCtx: { a, b } });
    const rows = [
      // 只卡 A（b 都过）的样本，多是赢家 → A 的单点否决里赢家过半
      mk(90, 9, 5), mk(90, 9, 8), mk(90, 9, 3), mk(90, 9, 0.5),  // 4 条单点否决 A：3 赢 1 亏
      // 一些正常通过的输家，压低通过组胜率，让全局 effect 仍算"有效"
      mk(10, 9, 0.5), mk(10, 9, 0.6), mk(10, 9, 0.7), mk(10, 9, 0.8), mk(10, 9, 0.9), mk(10, 9, 1.0),
    ];
    const results = rows.map(r => ({ input: '', row: r, res: runStrategyOnRow(c, r) }));
    const agg = aggregateCheckStats(results);
    const A = agg.ranked.find(r => r.name === 'A');
    assert.strictEqual(A.soleTotal, 4, 'A 有 4 个单点否决');
    assert.strictEqual(A.soleWins, 3, '其中 3 个是赢家');
    assert.strictEqual(A.soleHurts, true, '单点否决赢家过半应标 soleHurts');
  });

  test('aggregateCheckStats: 单点否决多是输家时不标 soleHurts', () => {
    const c = compileStrategy('const checks = [["A", ctx.a < 50, ctx.a, "< 50"]]; return checks.every(cc => cc[1]);');
    const mk = (a, ret) => ({ symbol: 'S', tokenAddress: 'CA', returnMax: ret, buyTimestamp: 1784690000, rawCtx: { a } });
    const rows = [mk(90, 0.5), mk(90, 0.6), mk(90, 0.7), mk(90, 1.0), mk(10, 3), mk(10, 5)];
    const results = rows.map(r => ({ input: '', row: r, res: runStrategyOnRow(c, r) }));
    const A = aggregateCheckStats(results).ranked.find(r => r.name === 'A');
    assert.ok(!A.soleHurts, '单点否决全是输家，这条正确过滤，不该标 soleHurts');
  });

  test('aggregateCheckStats: 拦截数为 0 的 check 判为 idle（不下退步结论）', () => {
    const c = compileStrategy('const checks = [["永真", ctx.x > 0, ctx.x, "> 0"]]; return checks.every(cc => cc[1]);');
    const mk = (ret) => ({ symbol: 'S', tokenAddress: 'CA', returnMax: ret, buyTimestamp: 1784690000, rawCtx: { x: 5 } });
    const results = [1, 8, 2, 0.5].map(ret => ({ input: '', row: mk(ret), res: runStrategyOnRow(c, mk(ret)) }));
    const agg = aggregateCheckStats(results);
    assert.strictEqual(agg.ranked.find(r => r.name === '永真').effect, 'idle', '什么都没拦应是 idle');
  });

  test('aggregateCheckStats: 拦截样本太少（<3）时不轻易判退步', () => {
    const c = compileStrategy('const checks = [["少拦", ctx.x < 5, ctx.x, "< 5"]]; return checks.every(cc => cc[1]);');
    const mk = (x, ret) => ({ symbol: 'S', tokenAddress: 'CA', returnMax: ret, buyTimestamp: 1784690000, rawCtx: { x } });
    const rows = [mk(9, 8), mk(1, 1), mk(1, 1), mk(1, 1)];  // 只拦 1 条
    const results = rows.map(r => ({ input: '', row: r, res: runStrategyOnRow(c, r) }));
    const agg = aggregateCheckStats(results);
    assert.notStrictEqual(agg.ranked.find(r => r.name === '少拦').effect, 'hurts', '拦截样本太少不应下退步结论');
  });

  test('buildStrategyVerdict: 命中/未命中两组都要参与评价', () => {
    // 命中组全是大赢家、未命中组全是输家 → 应判正面、以胜率为主
    const v = buildStrategyVerdict([5, 8, 12], [0.5, 0.8, 1.2]);
    assert.ok(v.length > 0);
    assert.ok(/胜率/.test(v), '应以胜率为主维度');
    assert.ok(/过滤方向是对的|✓/.test(v), '胜率碾压时应判正面');
  });
}
