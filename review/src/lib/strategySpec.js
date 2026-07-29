// 策略代码规范校验器（纯函数，不依赖 React/DOM）——一处实现，三处复用：
//   1) tests/strategy-spec.test.js 单测这套规则；
//   2) 策略回放看板（StrategyReplay）实时校验编辑框代码 + 一键修正；
//   3) tests/lint-strategies.js 扫真实的 ../*/code-score.js。
//
// 规范背景见 策略代码规范.md。核心目标：策略【只依赖 ctx】、review 与线上同一份代码都能跑、
// 打分/硬否决口径统一，避免反复踩的坑（f 未定义、VETO_NAMES 扫掉打分项、score>=score、
// 分母不夹正、占位权重、重复计分…）。

import { stripComments } from './stripComments.js';

// 标准 f 兼容垫片：策略用了 f('字段') 时必须在顶部放它，线上（只有 ctx、没有 f）才不会报错。
// 这是「模板骨架 / 一键修正 / 强势盘·1.5段 顶部」的唯一真源——改这里即可同步所有出处。
export const F_SHIM = `// ===== f 兼容垫片（standalone）：让含 f('字段') 的打分因子在线上（只有 ctx、没有 f）也能跑 =====
// review 里 f 是注入参数（typeof==='function'）→ 保留、垫片不生效；线上没有 f → 用垫片从 ctx 现算
// （算法照抄 src/lib/data.js）。必须用 var（不是 const/let），否则和 review 注入的同名参数冲突报"已声明"。
var f = (typeof f === 'function') ? f : (function () {
  var L = ctx.logearn || {}, G = ctx.gmgn || {}, devd = G.dev || {}, chipd = ctx.chip_analysis || {}, kid = ctx.kline_and_indicators || {};
  var fin = Number.isFinite;
  var toMs = function (ts) { var n = Number(ts); return fin(n) ? (n >= 1e12 ? n : n * 1000) : NaN; };
  var buyMs = Date.now(), swapBeginMs = toMs(L.swap_begin_time);
  var PCT = { 'gmgn.stat.top_rat_trader_percentage': 1, 'gmgn.stat.top_bundler_trader_percentage': 1, 'gmgn.stat.top_entrapment_trader_percentage': 1, 'gmgn.stat.top_bot_degen_percentage': 1, 'gmgn.stat.bot_degen_rate': 1, 'gmgn.stat.fresh_wallet_rate': 1, 'gmgn.stat.top_10_holder_rate': 1, 'gmgn.stat.dev_team_hold_rate': 1, 'gmgn.stat.creator_hold_rate': 1, 'gmgn.stat.private_vault_hold_rate': 1, 'gmgn.stat.top70_sniper_hold_rate': 1, 'gmgn.dev.top_10_holder_rate': 1, 'gmgn.locked_ratio': 1 };
  var F = {};
  var buy = Number(L.buy_wcoin_amount_d1), buyers = Number(L.buyer_count_d1), sellers = Number(L.seller_count_d1);
  if (fin(buyers) && fin(sellers) && sellers !== 0) F['buy_sell_count_ratio'] = buyers / sellers;
  if (fin(buy) && fin(buyers) && buyers !== 0) F['avg_buy_amount'] = buy / buyers;
  var cAbove = Number(chipd.above_percent), cBelow = Number(chipd.below_percent);
  if (fin(cAbove) && fin(cBelow) && cBelow !== 0) F['chip_analysis.above_below_ratio'] = cAbove / cBelow;
  if (fin(buyMs) && fin(swapBeginMs)) F['open_to_buy_duration'] = (buyMs - swapBeginMs) / 60000;
  var top5 = chipd.top5_holders;
  if (Array.isArray(top5) && top5.length) { var sh = 0, st = 0; for (var i = 0; i < top5.length; i++) { var h = top5[i], hd = Number(h && h.total_hold_percent), ti = Number(h && h.transfer_in_percent); if (fin(hd)) sh += hd; if (fin(ti)) st += ti; } if (sh > 0) { F['chip_analysis.top5_hold_percent'] = sh; F['chip_analysis.top5_transfer_in_ratio'] = st / sh * 100; } }
  if (Array.isArray(devd.twitter_name_change_history)) F['gmgn.dev.twitter_name_change_count'] = devd.twitter_name_change_history.length;
  var breakouts = L.v_breakout_volume_list || [];
  var vKey = function (ev) { var tp = Number(ev && ev.top_price_time), lo = Number(ev && ev.low_price_time); return (fin(tp) && fin(lo) && (tp || lo)) ? 'c_' + tp + '_' + lo : 's_' + (Number(ev && ev.signalTime) || Math.random()); };
  var vReached = function (val, t) { return (Number(val) > 0) || (t !== undefined && t !== null && Number(t) > 0); };
  if (Array.isArray(breakouts)) { var mr = 0; for (var b1 = 0; b1 < breakouts.length; b1++) { var v1 = Number(breakouts[b1] && breakouts[b1].n_pattern_retracement); if (fin(v1) && v1 > mr) mr = v1; } F['buy_max_retracement'] = mr; var seen = {}, cc = 0; for (var b2 = 0; b2 < breakouts.length; b2++) { var k2 = vKey(breakouts[b2]); if (!seen[k2]) { seen[k2] = 1; cc++; } } F['v_breakout_volume_signal_count'] = cc; }
  var recentV = null;
  for (var b3 = 0; b3 < breakouts.length; b3++) { var ev = breakouts[b3]; if (!ev || ev.n_pattern_confirmed !== true) continue; if (vReached(ev.fibon_break4, ev.fibon_break4_time)) continue; if (!recentV || (ev.signalTime || 0) > (recentV.signalTime || 0)) recentV = ev; }
  if (recentV) {
    var stg = 0; if (vReached(recentV.fibon_break3, recentV.fibon_break3_time)) stg = 60; else if (vReached(recentV.fibon_break2, recentV.fibon_break2_time)) stg = 40; else if (vReached(recentV.fibon_break1, recentV.fibon_break1_time)) stg = 20; F['v_breakout_volume_recent_stage_pct'] = stg;
    var rvs = Number(recentV.signalTime); if (fin(rvs)) { var rk = vKey(recentV), pk = {}, pc = 0; for (var b4 = 0; b4 < breakouts.length; b4++) { var t4 = Number(breakouts[b4] && breakouts[b4].signalTime); if (!fin(t4) || t4 >= rvs) continue; var k4 = vKey(breakouts[b4]); if (k4 !== rk && !pk[k4]) { pk[k4] = 1; pc++; } } F['v_breakout_volume_recent_prior_count'] = pc; }
    var retr = Number(recentV.n_pattern_retracement); if (fin(retr)) F['v_breakout_volume_recent_retracement_pct'] = retr * 100;
    var topMs = toMs(recentV.top_price_time), lowMs = toMs(recentV.low_price_time), sigMs = toMs(recentV.signalTime);
    if (fin(topMs) && fin(lowMs) && lowMs >= topMs) { var dd = (lowMs - topMs) / 60000; if (dd > 0 && fin(retr)) F['v_breakout_volume_recent_drawdown_speed_pct_per_min'] = retr * 100 / dd; }
    if (fin(topMs) && fin(sigMs) && sigMs >= topMs) F['v_breakout_volume_recent_signal_from_top_min'] = (sigMs - topMs) / 60000;
    var rr = Number(recentV.price_rise_ratio); if (fin(rr)) F['v_breakout_volume_recent_rebound_from_low_pct'] = rr * 100;
  }
  var mBar = function (bars) { if (!Array.isArray(bars) || bars.length < 4) return NaN; var ts = bars.map(function (b) { return toMs(b && b.time); }).filter(fin).sort(function (a, b) { return a - b; }); var g = []; for (var i = 1; i < ts.length; i++) { var d = (ts[i] - ts[i - 1]) / 60000; if (d > 0) g.push(d); } if (g.length < 3) return NaN; g.sort(function (a, b) { return a - b; }); return g[g.length >> 1]; };
  var cap = Number(kid.current_avg_price), kb = kid.kline_bars || [], ab = kid.avg_price_bars || [], rsec = Number(kid.resolution);
  var mb = mBar(kb), bmg = (fin(mb) && mb > 0) ? mb : ((fin(rsec) && rsec > 0) ? rsec / 60 : NaN);
  var secOf = function (t) { return Number(t) >= 1e12 ? Math.floor(Number(t) / 1000) : Number(t); };
  if (recentV && fin(recentV.top_price_time) && kb.length && fin(bmg) && bmg > 0) {
    var tts = secOf(recentV.top_price_time), cAtTop = cap;
    for (var a1 = 0; a1 < ab.length; a1++) { var ba = ab[a1], bt = secOf(ba && ba.time); if (fin(bt) && bt <= tts && typeof ba.value === 'number') { cAtTop = ba.value; break; } }
    if (fin(cAtTop) && cAtTop > 0) {
      var chr = kb.map(function (b) { return { time: secOf(b && b.time), close: Number(b && b.close) }; }).filter(function (b) { return fin(b.time) && fin(b.close) && b.time >= tts; }).sort(function (a, b) { return a.time - b.time; });
      var bdi = -1; for (var c1 = 0; c1 < chr.length; c1++) { if (chr[c1].close < cAtTop) { bdi = c1; break; } }
      if (bdi >= 0) { var boi = -1; for (var c2 = bdi + 1; c2 < chr.length; c2++) { if (chr[c2].close > cAtTop) { boi = c2; break; } } var below = (boi >= 0 ? boi : chr.length) - bdi; F['v_breakout_volume_recent_below_cost_line_elapsed_min'] = below * bmg; if (boi >= 0) F['v_breakout_volume_recent_break_cost_line_min'] = below * bmg; }
    }
  }
  if (recentV) { var lm = fin(recentV.low_price_mcap) ? recentV.low_price_mcap : (fin(recentV.low_price_mcp) ? recentV.low_price_mcp : undefined), lt = recentV.low_price_time; if (fin(lm) && fin(lt)) { var lts = secOf(lt), cAtLow = cap; for (var a2 = 0; a2 < ab.length; a2++) { var bl = ab[a2], blt = secOf(bl && bl.time); if (fin(blt) && blt <= lts && typeof bl.value === 'number') { cAtLow = bl.value; break; } } if (fin(cAtLow) && cAtLow !== 0) F['v_breakout_volume_recent_low_cost_line_distance_pct'] = (lm - cAtLow) / cAtLow * 100; } }
  var walk = function (root, path) { var p = path.split('.'), o = root; for (var i = 0; i < p.length; i++) { if (o == null) return undefined; o = o[p[i]]; } return o; };
  var direct = function (name) { var v; if (name.indexOf('.') >= 0) v = walk(ctx, name); else { v = L[name]; if (v === undefined) v = ctx[name]; } if (v === undefined || v === null || v === '') return null; var n = Number(v); if (!fin(n)) return null; return PCT[name] ? n * 100 : n; };
  return function (name) { if (Object.prototype.hasOwnProperty.call(F, name)) { var d = F[name]; return fin(Number(d)) ? Number(d) : null; } return direct(name); };
})();
// ===== f 垫片结束 =====`;

// 每条规则：{ id, level, title, detail, test(code)->bool 命中即违规, fixable, fix(code)->code }
const RULES = [
  {
    id: 'f-without-shim', level: 'error',
    title: '用了 f(\'字段\') 但没有 f 垫片 → 线上会 f is not defined',
    detail: '策略里出现 f(\'…\') 取值，但顶部没有 f 兼容垫片。review 里 f 是注入的，线上（只有 ctx）没有，贴上去直接报错。点「修正」在顶部插入标准垫片。',
    test: (c) => /\bf\s*\(\s*['"]/.test(c) && !/typeof\s+f\s*===\s*['"]function['"]/.test(c),
    fixable: true,
    fix: (c) => F_SHIM + '\n\n' + c,
  },
  {
    id: 'veto-from-map', level: 'error',
    title: 'VETO_NAMES = new Set(ALL_CHECKS.map(...)) → 打分项会被全扫成硬否决',
    detail: '这样写会把 ALL_CHECKS 里【每一项】都当硬否决，后续追加的打分因子也会被扫进来变成一票否决（1.5段踩过）。改成【显式列出】真正的硬否决名字。无法自动修（工具无从判断哪些该留作硬否决），请手动把硬否决名字显式写进 new Set([...])。',
    test: (c) => /VETO_NAMES\s*=\s*new\s+Set\s*\(\s*ALL_CHECKS\s*\.\s*map/.test(c),
    fixable: false,
  },
  {
    id: 'score-self-compare', level: 'error',
    title: '总分行写成了 score >= score（恒真笔误）',
    detail: '应为 score >= CUTOFF。score>=score 永远为真，会让「总分」这条 check 的通过标记失真。点「修正」改回 score >= CUTOFF。',
    test: (c) => /score\s*>=\s*score\b/.test(c),
    fixable: true,
    fix: (c) => c.replace(/score\s*>=\s*score\b/g, 'score >= CUTOFF'),
  },
  {
    id: 'wsum-no-clamp', level: 'warn',
    title: 'wsum 累加没夹正（wsum += weight）→ 有邪恶负权重时 score 可能 >100',
    detail: '归一化分母应只累加正权重：wsum += Math.max(0, weight)。否则邪恶阵营负权重把分母拉小，score 会被推过 100（实测跑出过 120）。点「修正」改成 Math.max(0, weight)。',
    test: (c) => /wsum\s*\+=\s*weight\b/.test(c) && !/wsum\s*\+=\s*Math\.max\s*\(\s*0/.test(c),
    fixable: true,
    fix: (c) => c.replace(/wsum\s*\+=\s*weight\b/g, 'wsum += Math.max(0, weight)'),
  },
  {
    id: 'missing-score-mark', level: 'warn',
    title: '没有 SCORE= 输出标记 → review 解析不到分数',
    detail: 'review 只消费 ctx.log 里的 SCORE=x VER=y GRADE=z 标记。缺了它，回放看板拿不到 score，无法做「总分 vs 收益」等分析。补一行形如 mark = \'SCORE=\'+score.toFixed(1)+\' VER=\'+VERSION+\' GRADE=\'+grade 并打进 ctx.log。',
    test: (c) => !/SCORE=/.test(c),
    fixable: false,
  },
  {
    id: 'dup-check-name', level: 'warn',
    title: 'ALL_CHECKS 里有重复的 name → review 聚合会按 name 合并、互相覆盖',
    detail: '每条 check 的 name 在 ALL_CHECKS 内应唯一（review 的因子聚合按 name 分组，重名会被合并成一个）。下面列出重名，改成不同标签。',
    test: (c) => dupCheckNames(c).length > 0,
    fixable: false,
    extra: (c) => dupCheckNames(c),
  },
];

// 抠出 ALL_CHECKS = [ … ] 这段数组文本（按方括号配平找到匹配的收尾 ]）。抠不出返回 ''。
// 只在这段里找重名——不能扫全文，否则会把 VETO_NAMES = new Set(['平台', …]) 的首元素也算进来误报。
function extractAllChecksBlock(code) {
  const m = /ALL_CHECKS\s*=\s*\[/.exec(code);
  if (!m) return '';
  let i = m.index + m[0].length - 1;   // 指向开头的 [
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    const ch = code[j];
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return code.slice(i, j + 1); }
  }
  return code.slice(i);   // 没配平（代码写坏了）就返回到末尾，尽力而为
}

// 从 ALL_CHECKS 里抠出每行 check 的第一个元素（name），找重复的。只认形如 ['名字', ... 的行首字面量。
// 只在 ALL_CHECKS 块内找，避免把 VETO_NAMES 名单误当 check 名。抠不出块就当没有（宁可漏报不误报）。
export function dupCheckNames(code) {
  const block = extractAllChecksBlock(String(code || ''));
  if (!block) return [];
  const names = [];
  const re = /\[\s*(['"])([^'"]+)\1\s*,/g;
  let m;
  while ((m = re.exec(block)) !== null) names.push(m[2]);
  const seen = new Map();
  for (const n of names) seen.set(n, (seen.get(n) || 0) + 1);
  return [...seen.entries()].filter(([, cnt]) => cnt > 1).map(([n, cnt]) => `${n}×${cnt}`);
}

// 校验一段策略代码，返回命中的违规列表（已按 error 在前排序）。
export function checkStrategySpec(code) {
  const src = String(code || '');
  // 规则全是正则匹配，必须跑在**剥掉注释**的副本上（2026-07-29 修）。
  // 原来直接拿原始源码跑，于是 1.5段策略/code-score.js 被报"用了 f('字段') 但没有 f 垫片"——
  // 那个文件里三处 f(' 全在注释里，其中一处恰恰是在说明"本策略不调用 f('字段')，所以不需要垫片"。
  // 后果：① `node tests/lint-strategies.js` 唯一的 error 级输出是假的、退出码 1，挂 CI 就是长红，
  // 人会习惯性忽略真违规；② 这条规则 fixable，UI 上点「修正」会插入一段根本不需要的垫片。
  // 注意只剥注释、**不能连字符串一起剥**——f('字段') 的字段名本身就是字符串字面量。
  const scan = stripComments(src);
  const out = [];
  for (const r of RULES) {
    if (!r.test(scan)) continue;
    out.push({
      id: r.id, level: r.level, title: r.title, detail: r.detail,
      fixable: !!r.fixable,
      // extra 也走剥注释后的副本：它是给违规补细节的（比如列出重名的 check name），
      // 跟 test 必须看同一份文本，否则会出现"没报违规却列出了细节"这种自相矛盾
      extra: r.extra ? r.extra(scan) : null,
    });
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

// 对某条规则应用自动修正，返回修好的代码；不可自动修/规则不存在时原样返回。
export function applySpecFix(code, id) {
  const r = RULES.find(x => x.id === id);
  if (!r || !r.fixable || !r.fix) return code;
  return r.fix(String(code || ''));
}

// 一键全修：把所有可自动修的规则依次应用（顺序：先补垫片再改其它，避免相互干扰）。
export function applyAllSpecFixes(code) {
  let c = String(code || '');
  for (const r of RULES) {
    if (r.fixable && r.fix && r.test(c)) c = r.fix(c);
  }
  return c;
}
