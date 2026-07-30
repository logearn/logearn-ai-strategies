import assert from 'node:assert';
import {
  extractUsedFields, generateOnlineCode, verifyParity, exportWithVerify, classifyFields,
} from '../src/lib/onlineExport.js';

// 造带 rawCtx + features 的样本：resolveCtxAccessor 靠"raw×倍率 === feature"核对路径。
//   - shit_volume（直接、倍率1）：ctx.logearn.shit_volume === feature
//   - gmgn.stat.bot_degen_rate（直接、倍率100）：ctx.gmgn.stat.bot_degen_rate × 100 === feature
//   - buy_sell_count_ratio（派生）：ctx 里没有，靠 simple 块从 buyer/seller 现算
function mkRows(n = 12, { tamperDerived = false } = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const shit = (i % 5) + 0.5;
    const frac = ((i * 7) % 100) / 1000; // 0~0.099
    const buyers = (i % 4) + 3, sellers = (i % 3) + 1;
    const ratio = buyers / sellers;
    rows.push({
      tokenAddress: 'T' + i, buyTimestamp: 1000 + i, returnMax: 2,
      features: {
        shit_volume: shit,
        'gmgn.stat.bot_degen_rate': frac * 100,
        buy_sell_count_ratio: tamperDerived ? ratio + 99 : ratio, // tamper 时 review 值故意写错
      },
      rawCtx: {
        logearn: { shit_volume: shit, buyer_count_d1: buyers, seller_count_d1: sellers },
        gmgn: { stat: { bot_degen_rate: frac } },
      },
    });
  }
  return rows;
}

const directSrc = `const ALL_CHECKS = [
  ['垃圾量', f('shit_volume'), 10, -Infinity, -Infinity, 0, 2, null, '~0'],
  ['bot', f('gmgn.stat.bot_degen_rate'), 20, 30, 45, 55, 62, null, '45~55'],
]`;

export function run(test) {
  test('extractUsedFields: 注释里的示例 f() 不算数', () => {
    const s = `// 示例 f('foobar_x')\n${directSrc}`;
    assert.deepStrictEqual(extractUsedFields(s).sort(), ['gmgn.stat.bot_degen_rate', 'shit_volume']);
  });

  test('generateOnlineCode: 直接字段→命名 const（__Vp 路径,倍率），行里引用命名，无 f、无垫片', () => {
    const g = generateOnlineCode(directSrc, mkRows());
    assert.ok(g.code.includes("const F_shit_volume = __Vp('logearn.shit_volume', 1);"), g.code);
    assert.ok(g.code.includes("const F_gmgn_stat_bot_degen_rate = __Vp('gmgn.stat.bot_degen_rate', 100);"), '占比字段应 ×100');
    assert.ok(g.code.includes("['垃圾量', F_shit_volume,"), '行里应引用命名 const');
    assert.ok(!/f\('shit_volume'\)/.test(g.code), 'f() 应被替换掉');
    assert.ok(!/\bvar f =/.test(g.code) && !g.code.includes('typeof f ==='), '不应有 f 垫片构造');
    assert.strictEqual(g.direct.length, 2);
    assert.strictEqual(g.derived.length, 0);
    assert.strictEqual(g.unresolved.length, 0);
  });

  test('generateOnlineCode: 剥掉源码里遗留的 f 垫片', () => {
    const withShim = `// ===== f 兼容垫片 =====\nvar f = (typeof f === 'function') ? f : (function () { return function(){}; })();\n// ===== f 垫片结束 =====\n${directSrc}`;
    const g = generateOnlineCode(withShim, mkRows());
    assert.ok(!/\bvar f =/.test(g.code), '遗留垫片应被剥掉');
    assert.ok(!g.code.includes('f 兼容垫片'), '垫片 banner 应被剥掉');
  });

  test('generateOnlineCode: 派生字段→命名 const（__Dget），内联 __D 预算块', () => {
    const src = `const ALL_CHECKS = [ ['买卖比', f('buy_sell_count_ratio'), 10, 1, 1, 5, 5, null, '1~5'] ]`;
    const g = generateOnlineCode(src, mkRows());
    assert.ok(g.derived.includes('buy_sell_count_ratio'));
    assert.ok(g.code.includes('var __D = (function () {'), '应内联派生预算块');
    assert.ok(g.code.includes("const F_buy_sell_count_ratio = __Dget('buy_sell_count_ratio');"), g.code);
    assert.ok(g.code.includes("['买卖比', F_buy_sell_count_ratio,"));
    assert.ok(!/f\('buy_sell_count_ratio'\)/.test(g.code));
  });

  // ---------- 内盘毕业哨兵：两边必须同口径 ----------
  // 这四个字段是 ctx 原生的，但 review 侧做了「未毕业→缺失」的变换。如果上线代码把它们当
  // direct 内联 ctx 路径，线上未毕业的盘会拿到 0（落进核心区算满分）而 review 是缺失——
  // 静默的口径破裂，回测再准也没用。所以它们必须走 graduation 块。
  function mkGradRows(n = 12) {
    return Array.from({ length: n }, (_, i) => {
      const graduated = i % 3 !== 0;          // 1/3 未毕业
      const duration = graduated ? 100 + i * 10 : 0;
      return {
        tokenAddress: 'G' + i, buyTimestamp: 1000 + i, returnMax: 2,
        features: graduated ? { launch_time_duration: duration, is_graduated: 1 } : { is_graduated: 0 },
        rawCtx: { logearn: { launch_time: graduated ? 500 : 0, launch_time_duration: duration } },
      };
    });
  }

  test('classifyFields: 毕业哨兵字段走派生块，不能被判成 direct', () => {
    const cls = classifyFields(['launch_time_duration', 'is_graduated'], mkGradRows());
    assert.ok(!cls.direct.has('launch_time_duration'), '内联 ctx 路径会让线上未毕业的盘拿到 0');
    assert.ok(cls.derived.includes('launch_time_duration'));
    assert.ok(cls.derived.includes('is_graduated'));
  });

  test('verifyParity: 毕业哨兵字段两边口径一致（未毕业→null，已毕业→原值）', () => {
    const src = `const ALL_CHECKS = [ ['毕业耗时', f('launch_time_duration'), 10, 0, 0, 45, 2425, null, '快'],
      ['已毕业', f('is_graduated'), 10, 1, 1, 1, 1, null, '是'] ]`;
    const r = verifyParity(src, mkGradRows());
    assert.strictEqual(r.ok, true, JSON.stringify(r.fields));
    assert.ok(r.rowsChecked > 0);
  });

  test('classifyFields: 直接/派生/无法解析三类正确', () => {
    const cls = classifyFields(['shit_volume', 'buy_sell_count_ratio', 'nope_field_xyz'], mkRows());
    assert.ok(cls.direct.has('shit_volume'));
    assert.ok(cls.derived.includes('buy_sell_count_ratio'));
    assert.strictEqual(cls.unresolved[0].field, 'nope_field_xyz');
  });

  test('verifyParity: native 取值与 review 一致时 ok，标注 kind', () => {
    const r = verifyParity(directSrc, mkRows());
    assert.strictEqual(r.ok, true);
    assert.ok(r.rowsChecked > 0);
    assert.ok(r.fields.every(f => f.kind === 'direct'));
  });

  test('verifyParity: 派生字段口径不一致（review 被篡改）→ 自检失败并定位字段', () => {
    const src = `const ALL_CHECKS = [ ['买卖比', f('buy_sell_count_ratio'), 10, 1, 1, 5, 5, null, '1~5'] ]`;
    const r = verifyParity(src, mkRows(12, { tamperDerived: true }));
    assert.strictEqual(r.ok, false);
    const f = r.fields.find(x => x.field === 'buy_sell_count_ratio');
    assert.strictEqual(f.status, 'mismatch');
    assert.ok(f.mismatches > 0 && f.sample);
  });

  // 2026-07-29：这条方向以前 100% 漏检——compareValue 里写的是 `if (rMiss) return {status:'ok'}`，
  // 只要 review 侧算不出值，无论线上算出什么都判"一致"。它是有实际代价的：因子的满分区间若覆盖到
  // 线上那个值，线上给分、回测记 0 分，同一个 cutoff 在两边含义就不同了，而这套自检的全部理由就是防这个。
  test('verifyParity: 线上算得出、review 缺失 → 单独报 missing_review，不能混进 ok', () => {
    const rows = mkRows(6);
    // 只把 review 侧的特征删掉，rawCtx 原样保留 → 线上派生块照样算得出 buy_sell_count_ratio
    for (const r of rows) delete r.features.buy_sell_count_ratio;
    const src = `const ALL_CHECKS = [ ['买卖比', f('buy_sell_count_ratio'), 10, 1, 1, 5, 5, null, '1~5'] ]`;
    const r = verifyParity(src, rows);
    const f = r.fields.find(x => x.field === 'buy_sell_count_ratio');
    assert.strictEqual(f.status, 'missing_review', '应被单列出来，而不是判成 ok');
    assert.ok(f.missingReview > 0, '应统计到具体有多少条样本是这种情况');
    assert.strictEqual(f.mismatches, 0, '它不是"两边算错了"，不该计进 mismatches');
    assert.strictEqual(r.ok, true, '不该让整份自检报告变红——review 缺失往往是样本本身没这个字段');
  });

  test('verifyParity: 两边都缺失仍然算 ok（真正的一致）', () => {
    const rows = mkRows(6);
    for (const r of rows) { delete r.features.buy_sell_count_ratio; delete r.rawCtx.logearn.buyer_count_d1; }
    const src = `const ALL_CHECKS = [ ['买卖比', f('buy_sell_count_ratio'), 10, 1, 1, 5, 5, null, '1~5'] ]`;
    const r = verifyParity(src, rows);
    const f = r.fields.find(x => x.field === 'buy_sell_count_ratio');
    assert.strictEqual(f.status, 'ok');
    assert.strictEqual(f.missingReview, 0);
  });

  test('generateOnlineCode: 无法解析的字段退化成 null，并列进 unresolved', () => {
    const src = `const ALL_CHECKS = [ ['x', f('nope_field_xyz'), 10, 0, 0, 1, 1, null, '~1'] ]`;
    const g = generateOnlineCode(src, mkRows());
    assert.strictEqual(g.unresolved.length, 1);
    assert.strictEqual(g.unresolved[0].field, 'nope_field_xyz');
    assert.ok(g.code.includes('const F_nope_field_xyz = null;'), '无法解析 → 命名 const = null');
    assert.ok(g.code.includes("['x', F_nope_field_xyz,"), '行里引用命名 const');
  });

  test('exportWithVerify: 返回 code + report + 三类字段', () => {
    const out = exportWithVerify(directSrc, mkRows());
    assert.ok(out.code.includes('__Vp'));
    assert.strictEqual(out.report.ok, true);
    assert.strictEqual(out.direct.length, 2);
    assert.strictEqual(out.unresolved.length, 0);
  });

  test('生成的 native 代码可被编译（语法正确）', () => {
    const g = generateOnlineCode(directSrc, mkRows());
    // 包一层 function(ctx){...} 编译，确认无语法错误
    // eslint-disable-next-line no-new-func
    assert.doesNotThrow(() => new Function('ctx', g.code + '\nreturn true;'));
  });
}
