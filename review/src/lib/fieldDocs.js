// 字段说明导出：字段名 + 中文含义 +（组装字段的）公式。
//
// 公式来源换了做法：旧版用 Function.prototype.toString() 从运行时函数体反查，
// 那在未打包的全局脚本下可行，但 Vite 生产构建会压缩混淆——变量被改名、注释全部丢失，
// 反查出来的"公式"会变成一堆 t.a=n(e)/o 之类的乱码。
// 改用 Vite 的 ?raw：构建期把源码原文内联进产物，注释和变量名都完整保留，
// 而且和运行的是同一份文件，不存在文档与代码不同步的问题。
import dataSrc from './data.js?raw';
import { getFieldDesc } from './dictionary.js';
import { computeFieldGroups, GROUP_LABELS, GROUP_ORDER } from './fieldGroups.js';

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 只取赋值号右边的表达式作为公式，不带上下文
export function findFieldFormula(field, src = dataSrc) {
  const m = src.match(new RegExp(`features\\[['"]${esc(field)}['"]\\]\\s*=\\s*([^\\n]*)`));
  if (!m) return '';
  const rhs = m[1].replace(/;\s*$/, '').replace(/\s*\/\/.*$/, '').trim();
  return resolveIdentifier(rhs, src);
}

// 右边只是个中间变量名（features['x'] = drawdownMin）时公式等于没写，往回查一层它的 const 声明。
// 只认 const：let 意味着变量会被反复改写（典型是循环里累积的 bestSpeed），
// 拿它的初始值（往往是 NaN）当公式比留变量名更误导。
function resolveIdentifier(rhs, src) {
  if (!/^[A-Za-z_$][\w$]*$/.test(rhs)) return rhs;
  const d = src.match(new RegExp(`\\bconst\\s+${esc(rhs)}\\s*=\\s*([^\\n]*)`));
  if (!d) return rhs;
  const expr = d[1].replace(/;\s*$/, '').replace(/\s*\/\/.*$/, '').trim();
  return expr && expr !== rhs ? expr : rhs;
}

export function buildFieldDocs(fields, customFields = []) {
  const groups = computeFieldGroups(fields);
  const customByName = new Map(customFields.map(c => [c.name, c.code]));
  const cell = t => String(t ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

  // 按"有没有公式"切成原生/组装两块：有 features['x']=... 赋值的是本工具算的，
  // 没有的就是平台快照原样给的。用这个判定而不是另维护清单，它跟着代码自动走。
  const raw = {}, made = {};
  let rawCount = 0, madeCount = 0;
  for (const key of GROUP_ORDER) {
    for (const f of groups[key]) {
      const formula = customByName.has(f) ? customByName.get(f) : findFieldFormula(f);
      (formula ? made : raw)[key] = ((formula ? made : raw)[key] || []).concat([{ field: f, formula }]);
      formula ? madeCount++ : rawCount++;
    }
  }

  const L = ['# 字段说明', '',
    `生成时间：${new Date().toLocaleString('zh-CN')}　字段总数：${rawCount + madeCount}（原生 ${rawCount} / 组装 ${madeCount}）`, ''];

  L.push(`## 一、原生字段（${rawCount}）`, '', '直接来自平台快照 JSON，没有二次计算。', '');
  if (!rawCount) L.push('_（无）_', '');
  for (const key of GROUP_ORDER) {
    const items = raw[key];
    if (!items?.length) continue;
    L.push(`### ${GROUP_LABELS[key]}（${items.length}）`, '', '| 字段 | 含义 |', '| --- | --- |');
    for (const it of items) L.push(`| \`${cell(it.field)}\` | ${cell(getFieldDesc(it.field))} |`);
    L.push('');
  }

  L.push(`## 二、组装字段（${madeCount}）`, '', '本工具从原生字段计算得到，公式如下。', '');
  if (!madeCount) L.push('_（无）_', '');
  for (const key of GROUP_ORDER) {
    const items = made[key];
    if (!items?.length) continue;
    L.push(`### ${GROUP_LABELS[key]}（${items.length}）`, '', '| 字段 | 含义 | 公式 |', '| --- | --- | --- |');
    for (const it of items) L.push(`| \`${cell(it.field)}\` | ${cell(getFieldDesc(it.field))} | \`${cell(it.formula)}\` |`);
    L.push('');
  }
  L.push(`_共 ${rawCount + madeCount} 个字段：原生 ${rawCount} 个，组装 ${madeCount} 个。_`);

  return { markdown: L.join('\n'), rawCount, madeCount, total: rawCount + madeCount };
}
