// 策略规范 lint：扫仓库里所有 */code-score.js（review 的上级目录下各策略文件夹），
// 按 策略代码规范.md 逐条检查，打印违规。用法：
//   node tests/lint-strategies.js
// 有 error 级违规时退出码 1（可挂 CI）；只有 warn 时退出码 0。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStrategySpec } from '../src/lib/strategySpec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../');   // review/tests -> 仓库根

// 找 <repoRoot>/*/code-score.js
const targets = [];
for (const name of fs.readdirSync(repoRoot)) {
  const p = path.join(repoRoot, name, 'code-score.js');
  try { if (fs.statSync(p).isFile()) targets.push(p); } catch { /* 没有就跳过 */ }
}

if (!targets.length) { console.log('没找到任何 */code-score.js'); process.exit(0); }

let errorCount = 0, warnCount = 0;
for (const file of targets) {
  const rel = path.relative(repoRoot, file);
  const code = fs.readFileSync(file, 'utf8');
  const viols = checkStrategySpec(code);
  if (!viols.length) { console.log(`\n✓ ${rel} —— 规范校验通过`); continue; }
  const errs = viols.filter(v => v.level === 'error').length;
  const warns = viols.filter(v => v.level === 'warn').length;
  errorCount += errs; warnCount += warns;
  console.log(`\n${errs ? '✗' : '⚠'} ${rel} —— ${errs} 错误 / ${warns} 警告`);
  for (const v of viols) {
    console.log(`  [${v.level === 'error' ? '错误' : '警告'}] ${v.title}${v.extra && v.extra.length ? '（' + v.extra.join('、') + '）' : ''}`);
  }
}

console.log(`\n共扫 ${targets.length} 个策略；${errorCount} 个错误、${warnCount} 个警告。`);
process.exit(errorCount ? 1 : 0);
