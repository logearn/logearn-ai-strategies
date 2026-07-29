// 剔除 JS 源码里的注释（// 行注释 + /* */ 块注释），保留字符串字面量原样。
//
// 谁在用、为什么必须共用一份：
//   - onlineExport.extractUsedFields：扫策略里真正调用的 f('字段')，注释里的示例名不能算数。
//   - strategySpec.checkStrategySpec：策略规范 lint 的规则全是正则匹配，跑在带注释的源码上会误报。
// 这两处原来各自为政（lint 那边压根没剥注释），于是同一个坑踩了两次，抽出来共用。
//
// 【2026-07-29 修的真实缺陷：不认正则字面量】
// 原实现只认字符串定界符（' " `），不认 /.../ 正则。而 CLAUDE.md 明确建议 off_meta 这类字段用正则
// 匹配，策略里出现正则是预期内的。两个方向都会出错，都实测复现过：
//
//   ① 多提取——正则里带单引号：
//        const hasApos = /don't/.test(meta)
//        // 说明：以前这里用过 f('已废弃字段')，现在不用了     ← 这行注释剥不掉
//        const a = f('new_volume')
//      那个 ' 让扫描器以为进了字符串，后面的注释就不再被识别，
//      extractUsedFields 实际返回 ['已废弃字段', 'new_volume'] —— 把只在注释里出现的字段当成了真字段。
//
//   ② 少提取——正则里带转义斜杠：
//        const isUrl = /https:\/\//.test(x) && f('shit_volume') > 0
//      末尾那对 `//` 被当成行注释起点，**同一行后面的 f('字段') 整段被吞** →
//      生成的上线代码少一个 const，对应因子恒 null（回测有分、线上没有）。
//
// 现在按"上一个有意义的字符"判断 `/` 是除号还是正则开头——这是 JS 词法层面本来就无法只靠局部
// 字符解决的老问题（需要语法上下文），这里用业界通用的启发式：前一个非空白字符是标识符/数字/
// 右括号/右方括号 → 除号，否则 → 正则；再补一张关键字表（return /re/、typeof /re/ 这类）。
// 判断错了也不会崩：正则不能跨行，扫到换行就收手，最坏退化成原来的行为。

// 这些关键字后面出现的 `/` 一定是正则开头，不是除号（`return /x/` 合法，`return / x` 不是表达式）
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await',
]);

// prevSig：上一个非空白字符；prevWord：上一个连续标识符（用来查上面那张关键字表）
function startsRegex(prevSig, prevWord) {
  if (!prevSig) return true;                              // 文件开头
  if (REGEX_PRECEDING_KEYWORDS.has(prevWord)) return true;
  // 标识符/数字/右括号/右方括号后面的 `/` 是除法（a / b、arr[0] / 2、fn() / 3）
  if (/[A-Za-z0-9_$)\]]/.test(prevSig)) return false;
  return true;                                            // 其余（= ( , : [ ! & | ? { } ; 运算符…）都当正则
}

export function stripComments(src) {
  const s = String(src == null ? '' : src);
  const n = s.length;
  let out = '';
  let i = 0;
  let quote = null;      // 当前所在字符串的定界符
  let prevSig = '';      // 上一个有意义（非空白）的字符
  let prevWord = '';     // 上一个连续标识符

  while (i < n) {
    const c = s[i], d = s[i + 1];

    if (quote) {
      out += c;
      if (c === '\\') { out += d ?? ''; i += 2; continue; }   // 转义，整体跳过下一个字符
      if (c === quote) quote = null;
      i++; continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      quote = c; out += c; i++; prevSig = c; prevWord = ''; continue;
    }

    if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') i++; continue; }   // 行注释
    if (c === '/' && d === '*') {                                                   // 块注释
      i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2; continue;
    }

    if (c === '/' && startsRegex(prevSig, prevWord)) {
      // 正则字面量：整段原样搬过去，里面的引号和斜杠都不再参与上面的判定
      out += c; i++;
      let inClass = false;   // [...] 字符类里的 / 不是结束符
      while (i < n) {
        const r = s[i];
        if (r === '\\') { out += r + (s[i + 1] ?? ''); i += 2; continue; }
        if (r === '\n') break;               // 正则不能跨行 → 判断错了，就此收手（退化成原行为）
        out += r; i++;
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
      }
      while (i < n && /[a-z]/i.test(s[i])) { out += s[i]; i++; }   // 后缀 flags（gimsuy）
      prevSig = '/'; prevWord = '';
      continue;
    }

    out += c;
    if (!/\s/.test(c)) {
      prevSig = c;
      prevWord = /[A-Za-z0-9_$]/.test(c) ? prevWord + c : '';
    }
    i++;
  }
  return out;
}
