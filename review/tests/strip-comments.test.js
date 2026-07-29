import assert from 'node:assert';
import { stripComments } from '../src/lib/stripComments.js';
import { extractUsedFields } from '../src/lib/onlineExport.js';
import { checkStrategySpec } from '../src/lib/strategySpec.js';

// 2026-07-29：这个扫描器的两个使用方（onlineExport 提 f('字段')、strategySpec 跑 lint 规则）
// 都栽在同一件事上——它原来不认正则字面量，而 CLAUDE.md 明确建议 off_meta 这类字段用正则匹配。
export function run(test) {
  test('stripComments: 普通行注释/块注释照常剥掉，字符串里的 // 不算注释', () => {
    const src = `const a = 1; // 行注释\n/* 块\n注释 */\nconst url = 'http://x.com'; // 尾注释\n`;
    const out = stripComments(src);
    assert.ok(!out.includes('行注释') && !out.includes('块') && !out.includes('尾注释'), out);
    assert.ok(out.includes("'http://x.com'"), '字符串里的 // 必须原样保留：' + out);
  });

  test('stripComments: 正则里的单引号不能把后续注释带跑（否则注释剥不掉 → 多提取字段）', () => {
    const src = `const hasApos = /don't/.test(meta)\n// 以前这里用过 f('已废弃字段')\nconst a = f('new_volume')\n`;
    const out = stripComments(src);
    assert.ok(!out.includes('已废弃字段'), '正则后面的注释必须照样被剥掉：' + out);
    assert.ok(out.includes("f('new_volume')"), '真正的调用不能丢：' + out);
  });

  test('stripComments: 正则里的转义斜杠不能被当成行注释起点（否则同行后面的代码被吞 → 少提取字段）', () => {
    const src = `const isUrl = /https:\\/\\//.test(x) && f('shit_volume') > 0\n`;
    const out = stripComments(src);
    assert.ok(out.includes("f('shit_volume')"), '同一行正则之后的代码必须留着：' + out);
  });

  test('stripComments: 除号不能被误认成正则开头', () => {
    const src = `const r = a / b; const s = arr[0] / 2; const t = fn() / 3; // 注释\n`;
    const out = stripComments(src);
    assert.ok(!out.includes('注释'), '注释应被剥掉（说明没有把除号后面整段当成正则吞掉）：' + out);
    assert.ok(out.includes('a / b') && out.includes('arr[0] / 2') && out.includes('fn() / 3'), out);
  });

  test('stripComments: return / typeof 之后的 / 是正则不是除号', () => {
    const src = `function f(x) { return /a'b/.test(x) }\n// 注释\nconst y = 1\n`;
    const out = stripComments(src);
    assert.ok(!out.includes('注释'), out);
    assert.ok(out.includes('const y = 1'), out);
  });

  // —— 两个使用方的端到端回归 ——
  test('extractUsedFields: 含引号正则之后的注释里的 f() 不能被当成真字段', () => {
    const src = `const hasApos = /don't/.test(meta)\n// 说明：以前用过 f('已废弃字段')\nconst a = f('new_volume')\n`;
    assert.deepStrictEqual(extractUsedFields(src), ['new_volume']);
  });

  test('extractUsedFields: 含转义斜杠正则同一行后面的 f() 不能被吞掉', () => {
    const src = `const isUrl = /https:\\/\\//.test(x) && f('shit_volume') > 0\n`;
    assert.deepStrictEqual(extractUsedFields(src), ['shit_volume']);
  });

  test('checkStrategySpec: 注释里提到 f(\'字段\') 但代码没调用 → 不该报"缺 f 垫片"', () => {
    const src = `// 注意：本策略全程读 ctx.* 直算、不调用 f('字段')，所以线上不需要 f 垫片。\nconst ALL_CHECKS = [ ['x', ctx.logearn.shit_volume, 10, 0, 0, 1, 1, null, '~1'] ]\nconst mark = 'SCORE=' + score\n`;
    const viols = checkStrategySpec(src);
    assert.ok(!viols.some(v => v.id === 'f-without-shim'), '注释里的示例不该触发违规：' + JSON.stringify(viols.map(v => v.id)));
  });

  test('checkStrategySpec: 代码真的调用了 f(\'字段\') 且没垫片 → 仍然要报', () => {
    const src = `const ALL_CHECKS = [ ['x', f('shit_volume'), 10, 0, 0, 1, 1, null, '~1'] ]\nconst mark = 'SCORE=' + score\n`;
    const viols = checkStrategySpec(src);
    assert.ok(viols.some(v => v.id === 'f-without-shim'), '真违规必须还能被抓到');
  });
}
