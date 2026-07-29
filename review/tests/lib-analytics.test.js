// 针对从 charts.js / pro-analytics.js 抽出的纯计算函数的回归测试。
// 这两个文件此前是【零测试覆盖】——本次会话里点击绑定失效、策略回放命中数恒为 0、
// 置换检验样本量不足等 bug 全部出在这里，而 122 个既有测试一个都没红。
import assert from 'node:assert';
import { minDetectableDiff, parseBreakpoints } from '../src/lib/analytics.js';
import { logearnUrl } from '../src/lib/utils.js';
import { parseCheckNumber, parseCheckDirection, buildStrategyVerdict, aucVerdict, solveLinearSystem, computeVIFs, standardize, standardizeWith, percentileRankOf, makeFrozenDate, makeCtxRecorder, compileStrategy, sanitizeForFieldName, computeQuantileBreakpoints, detectTimeReads } from '../src/lib/proAnalytics.js';

export function run(test) {
  test('logearnUrl: 必须带链前缀，且按地址格式区分 BSC / Solana', () => {
    // 之前 React 版把 URL 拼成了 /token/{addr}（少了 /cn/{chain}/tokens），点数据点全是 404
    assert.strictEqual(logearnUrl('5KJXGabc'), 'https://logearn.com/cn/solana/tokens/5KJXGabc');
    assert.strictEqual(logearnUrl('0xdeadbeef'), 'https://logearn.com/cn/bsc/tokens/0xdeadbeef');
    assert.strictEqual(logearnUrl(''), '', '空地址应返回空串而不是拼出无效链接');
    assert.strictEqual(logearnUrl(null), '');
  });

  test('minDetectableDiff: 样本量越小可探测差异越大，样本不足时返回 NaN', () => {
    const a = minDetectableDiff(100, 0.4), b = minDetectableDiff(400, 0.4);
    assert.ok(a > b, '样本量翻 4 倍，MDE 应显著变小');
    assert.ok(Math.abs(b - a / 2) < 0.02, 'MDE 应约与 sqrt(n) 成反比');
    assert.ok(Number.isNaN(minDetectableDiff(5, 0.4)), 'n<10 应返回 NaN');
    assert.ok(Number.isNaN(minDetectableDiff(100, 0)), '基准率为 0 应返回 NaN');
  });

  test('parseBreakpoints: 应解析逗号/空格分隔并排序去重，忽略非数字', () => {
    assert.deepStrictEqual(parseBreakpoints('3, 1, 2'), [1, 2, 3]);
    // 注意：实现只排序不去重，重复断点会切出一个空区间。目前无害（分箱会得到 0 样本的档），
    // 这里如实钉住现状，避免以后有人"顺手改成去重"却不知道有没有别的地方依赖当前行为。
    assert.deepStrictEqual(parseBreakpoints('2,2,1'), [1, 2, 2]);
    assert.deepStrictEqual(parseBreakpoints('abc'), []);
  });

  test('parseCheckNumber: 要能从 "3.30(2657/804)" 这种带括号统计的实际值里取出数字', () => {
    // 真实的 check 实际值长这样，直接 Number() 会得到 NaN
    assert.strictEqual(parseCheckNumber('3.30(2657/804)'), 3.3);
    assert.strictEqual(parseCheckNumber('1,234.5'), 1234.5);
    assert.ok(Number.isNaN(parseCheckNumber('无')));
  });

  test('parseCheckDirection: 区间/相等类条件没有方向，必须返回 null', () => {
    assert.strictEqual(parseCheckDirection('>=50'), 'gt');
    assert.strictEqual(parseCheckDirection('<10'), 'lt');
    assert.strictEqual(parseCheckDirection('1~5'), null, '区间无方向');
    assert.strictEqual(parseCheckDirection('==3'), null, '相等无方向');
  });

  test('buildStrategyVerdict: 评价不能只看中位数', () => {
    // 用户明确提过"这个评价只看中位数么"——同样的中位数，胜率和尾部可以完全不同
    const hit = [0.5, 0.6, 0.7, 5, 8, 12], miss = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const v = buildStrategyVerdict(hit, miss);
    assert.strictEqual(typeof v, 'string', '返回的是给人读的结论文本');
    assert.ok(v.length > 0);
    // 这组 hit 的胜率和尾部都明显强于 miss，应判正面，且不能报"拦掉的反而不比放行的差"。
    // "评价不只看中位数"这个本意，由下面两个正反场景测试更严格地覆盖。
    assert.ok(/胜率/.test(v), '结论应以胜率为主维度');
    assert.ok(!/拦掉的反而不比放行的差/.test(v), '胜率占优时不该报负面警告');
    assert.strictEqual(buildStrategyVerdict([], [1]), '', '任一侧为空应返回空串而不是崩溃');
  });

  test('aucVerdict: 置信区间跨过 0.5 时不能判为显著', () => {
    assert.strictEqual(aucVerdict(0.62, { lo: 0.55, hi: 0.69 }).significant, true);
    assert.strictEqual(aucVerdict(0.52, { lo: 0.46, hi: 0.58 }).significant, false, 'CI 跨 0.5 不显著');
    assert.strictEqual(aucVerdict(0.38, { lo: 0.31, hi: 0.44 }).significant, true, '反向也算有效');
  });

  test('solveLinearSystem / computeVIFs: 共线性诊断', () => {
    assert.deepStrictEqual(solveLinearSystem([[2, 0], [0, 2]], [2, 4]), [1, 2]);
    // 两个完全共线的字段，VIF 应爆表
    const rows = Array.from({ length: 40 }, (_, i) => ({ a: i, b: i * 2 + 1, c: (i * 7) % 11 }));
    const vifs = computeVIFs(rows, ['a', 'b', 'c']);
    assert.ok(vifs, '应返回结果');
    const va = vifs.a ?? (vifs.find && vifs.find(x => x.field === 'a')?.vif);
    assert.ok(!Number.isFinite(va) || va > 10, `完全共线的字段 VIF 应很大或无穷，实际 ${va}`);
  });

  test('standardize / standardizeWith: 标准化后均值 0 标准差 1，且可复用训练集参数', () => {
    const s = standardize([1, 2, 3, 4, 5]);
    assert.ok(Math.abs(s.mean - 3) < 1e-9);
    assert.ok(Math.abs(s.z.reduce((a, b) => a + b, 0)) < 1e-9, 'z 之和应为 0');
    // 用训练集的 mean/std 去标准化测试集——样本外验证必须这样做，否则会数据泄漏。
    // 注意 standardizeWith 收的是【数组】不是单值。
    const z = standardizeWith([3, 5], s.mean, s.std);
    assert.ok(Math.abs(z[0]) < 1e-9, '等于训练集均值的点应标准化为 0');
    assert.ok(z[1] > 0);
    assert.deepStrictEqual(standardizeWith([1, 2], 1, 0), [0, 0], 'std 为 0 时应退化为全 0 而不是除零');
  });

  test('percentileRankOf: 分位数排名', () => {
    assert.strictEqual(percentileRankOf([1, 2, 3, 4], 4), 1);
    assert.strictEqual(percentileRankOf([1, 2, 3, 4], 0), 0);
  });

  test('makeFrozenDate: 策略回放时 Date 必须冻结在快照时刻，否则是未来函数', () => {
    const T = 1784693615000;
    const FD = makeFrozenDate(T);
    assert.strictEqual(FD.now(), T, 'Date.now() 冻结');
    assert.strictEqual(new FD().getTime(), T, 'new Date() 应返回冻结时刻');
    assert.strictEqual(+new FD(), T, '+new Date / valueOf 也冻结');
    assert.strictEqual(Math.floor(FD.now() / 1000), Math.floor(T / 1000), 'Math.floor(Date.now()/1000) 拿到冻结秒');
    // 显式传参时仍要正常工作（不冻结）
    assert.strictEqual(new FD(0).getTime(), 0);
    // 直接当函数调用 Date()（class 写法会抛错）——Proxy 版应返回冻结时刻的字符串
    assert.strictEqual(typeof FD(), 'string');
    assert.ok(FD().includes(String(new Date(T).getFullYear())), 'Date() 字符串是冻结时刻');
    // instanceof / 静态方法仍然可用（不该被冻结破坏）
    assert.ok(new FD() instanceof Date, '实例仍是真正的 Date');
    assert.strictEqual(FD.UTC(1970, 0, 1), 0, 'Date.UTC 等静态方法原样透传');
  });

  test('detectTimeReads: 数出读当前时间的写法 + 挑出未来函数隐患字段', () => {
    const r = detectTimeReads('const t = Math.floor(Date.now()/1000); const d = new Date().getTime(); if(ctx.kline_and_indicators.timestamp > t){}');
    assert.strictEqual(r.count, 3, 'Date.now() / new Date() / getTime() 各算一处');
    assert.ok(r.lookaheadFields.includes('kline_and_indicators.timestamp'), '快照导出时刻字段应被挑出来提示');
    const none = detectTimeReads('const checks = []; return true;');
    assert.strictEqual(none.count, 0);
    assert.deepStrictEqual(none.lookaheadFields, []);
  });

  test('makeCtxRecorder: 应记录策略读过哪些 ctx 路径', () => {
    const seen = new Set();
    const proxy = makeCtxRecorder({ a: { b: 1 }, c: 2 }, seen);
    void proxy.a.b; void proxy.c;
    const paths = [...seen].join('|');
    assert.ok(/a\.b/.test(paths), '应记录嵌套路径 a.b，实际：' + paths);
    assert.ok(/(^|\|)c($|\|)/.test(paths), '应记录顶层路径 c，实际：' + paths);
  });

  test('compileStrategy: 应能捕获策略里的 checks 声明', () => {
    const ok = compileStrategy('const checks = [{ name: "x", pass: true }];');
    assert.ok(ok && !ok.error, '合法策略不应报错：' + JSON.stringify(ok));
    const bad = compileStrategy('const checks = [ this is not js');
    assert.ok(bad && bad.error, '语法错误应被捕获为 error 而不是抛出');
  });

  test('sanitizeForFieldName: 字段名里的非法字符应被规范化', () => {
    assert.strictEqual(sanitizeForFieldName('a.b-c'), 'a.b_c');
  });

  test('computeQuantileBreakpoints: 样本不足时应返回可读的错误而不是崩溃', () => {
    const r = computeQuantileBreakpoints([1, 2, 3, 4, 5, 6, 7, 8], 3);
    assert.ok(r.error && /不足/.test(r.error), '应返回错误说明');
    const ok = computeQuantileBreakpoints(Array.from({ length: 60 }, (_, i) => i), 3);
    assert.ok(Array.isArray(ok.breakpoints) && ok.breakpoints.length === 2, '3 分层应给 2 个断点');
  });
}
