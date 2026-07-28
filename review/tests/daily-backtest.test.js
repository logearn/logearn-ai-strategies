import assert from 'node:assert';
import { addBacktestReport, removeBacktestReport, localDateStr,
         addOptimizationReportPair } from '../src/lib/backtestReports.js';
import { addTodo, toggleTodo, removeTodo, ignoreDate, unignoreDate,
         findMissingReportDates } from '../src/lib/todoList.js';

export function run(test) {
  // ---------- backtestReports ----------
  test('addBacktestReport: 新报告插到最前面，id 唯一，metrics 原样带过去', () => {
    const metrics = { total: 176, hits: 21, hitRate: 0.119 };
    const list = addBacktestReport([], { date: '2026-07-24', code: 'const a=1;', note: '', metrics });
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].date, '2026-07-24');
    assert.deepStrictEqual(list[0].metrics, metrics);
    assert.ok(Number.isFinite(list[0].savedAt));
  });

  test('addBacktestReport: 同一天允许存多份（比如调完参数再存一次），不互相覆盖', () => {
    let list = addBacktestReport([], { date: '2026-07-24', code: 'a', metrics: { total: 1 } });
    list = addBacktestReport(list, { date: '2026-07-24', code: 'b', metrics: { total: 2 } });
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].code, 'b', '新的排最前面');
  });

  test('removeBacktestReport: 按 id 精确删除', () => {
    let list = addBacktestReport([], { date: '2026-07-24', code: 'a', metrics: {} });
    list = addBacktestReport(list, { date: '2026-07-25', code: 'b', metrics: {} });
    const targetId = list.find(r => r.date === '2026-07-24').id;
    const next = removeBacktestReport(list, targetId);
    assert.strictEqual(next.length, 1);
    assert.strictEqual(next[0].date, '2026-07-25');
  });

  test('addBacktestReport: 默认 kind=daily，pairId/changeSummary 默认 null', () => {
    const list = addBacktestReport([], { date: '2026-07-24', code: 'a', metrics: {} });
    assert.strictEqual(list[0].kind, 'daily');
    assert.strictEqual(list[0].pairId, null);
    assert.strictEqual(list[0].changeSummary, null);
  });

  test('addOptimizationReportPair: 存两条 kind=optimized 的报告，共享同一个 pairId，各自带 before/after 的 metrics 和 code', () => {
    const before = { hitRate: 0.1, scoreReturn: { rho: 0.2 } };
    const after = { hitRate: 0.15, scoreReturn: { rho: 0.3 } };
    const list = addOptimizationReportPair([], {
      date: '2026-07-24', beforeCode: 'old code', afterCode: 'new code',
      beforeMetrics: before, afterMetrics: after, changeSummary: '调整2个权重、删除1个因子（foo）',
    });
    assert.strictEqual(list.length, 2);
    assert.ok(list.every(r => r.kind === 'optimized'));
    assert.strictEqual(list[0].pairId, list[1].pairId, '两条应共享同一个 pairId');
    assert.strictEqual(list[0].changeSummary, '调整2个权重、删除1个因子（foo）');
    // addBacktestReport 是"插到最前面"，所以 after 那条（后调用）应该排在最前面
    assert.deepStrictEqual(list[0].metrics, after);
    assert.deepStrictEqual(list[1].metrics, before);
    assert.strictEqual(list[0].code, 'new code');
    assert.strictEqual(list[1].code, 'old code');
  });

  test('addOptimizationReportPair: 追加到已有报告列表前面，不影响已有条目', () => {
    let list = addBacktestReport([], { date: '2026-07-23', code: 'x', metrics: {} });
    list = addOptimizationReportPair(list, {
      date: '2026-07-24', beforeCode: 'a', afterCode: 'b',
      beforeMetrics: { hitRate: 0.1 }, afterMetrics: { hitRate: 0.2 }, changeSummary: '调整1个权重',
    });
    assert.strictEqual(list.length, 3);
    assert.strictEqual(list[2].date, '2026-07-23', '旧报告应还在最后');
  });

  test('localDateStr: 按本地日历日格式化，不受时区跨天影响到"用哪一天"的判断逻辑本身', () => {
    // 只验证格式与月/日补零，不断言具体时区换算结果（那依赖运行环境时区）
    const s = localDateStr(new Date(2026, 6, 4)); // 月份从0开始，6=7月
    assert.strictEqual(s, '2026-07-04');
  });

  // ---------- todoList ----------
  test('addTodo/toggleTodo/removeTodo: 增删改基本行为', () => {
    let list = addTodo([], '  调 shit_volume 权重  ');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].text, '调 shit_volume 权重', '应去掉首尾空格');
    assert.strictEqual(list[0].done, false);
    list = toggleTodo(list, list[0].id);
    assert.strictEqual(list[0].done, true);
    list = toggleTodo(list, list[0].id);
    assert.strictEqual(list[0].done, false, '再切一次应变回 false');
    list = removeTodo(list, list[0].id);
    assert.strictEqual(list.length, 0);
  });

  test('addTodo: 空字符串/纯空格不应加进列表', () => {
    const list = addTodo(addTodo([], ''), '   ');
    assert.strictEqual(list.length, 0);
  });

  test('ignoreDate/unignoreDate: 忽略列表去重，撤销后能再次出现在差集里', () => {
    let ignored = ignoreDate([], '2026-07-20');
    ignored = ignoreDate(ignored, '2026-07-20'); // 重复忽略同一天不应出现两条
    assert.deepStrictEqual(ignored, ['2026-07-20']);
    ignored = unignoreDate(ignored, '2026-07-20');
    assert.deepStrictEqual(ignored, []);
  });

  test('findMissingReportDates: 有数据没报告的日期才出现，已存档/已忽略的都不出现', () => {
    const t = d => new Date(d).getTime();
    const batchMetas = [
      { addedAt: t('2026-07-20T10:00:00') },
      { addedAt: t('2026-07-21T10:00:00') },
      { addedAt: t('2026-07-22T10:00:00') },
    ];
    const reportDates = ['2026-07-20']; // 20 号已经存过报告
    const ignoredDates = ['2026-07-21']; // 21 号手动忽略过
    const missing = findMissingReportDates(batchMetas, reportDates, ignoredDates);
    assert.deepStrictEqual(missing, ['2026-07-22']);
  });

  test('findMissingReportDates: 同一天多个批次应去重成一条', () => {
    const t = d => new Date(d).getTime();
    const batchMetas = [
      { addedAt: t('2026-07-22T09:00:00') },
      { addedAt: t('2026-07-22T18:00:00') },
    ];
    const missing = findMissingReportDates(batchMetas, [], []);
    assert.deepStrictEqual(missing, ['2026-07-22']);
  });

  test('findMissingReportDates: 没有 addedAt（比如异常脏数据）的批次应跳过，不产生 NaN 日期', () => {
    const batchMetas = [{ addedAt: undefined }, { addedAt: new Date('2026-07-22').getTime() }];
    const missing = findMissingReportDates(batchMetas, [], []);
    assert.deepStrictEqual(missing, ['2026-07-22']);
  });
}
