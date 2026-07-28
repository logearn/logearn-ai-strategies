// ==============================================================
// 上线代码生成器（onlineExport）—— 把 review 里的 f('字段') 策略翻译成【纯 native ctx 代码】
//
// 【设计：线上代码是独立交付物，不该依赖 review 的 f】
// review 回放时 f('字段') 是注入的（getFeature 查 buildRows 预算好的特征）。线上 logearn
// 平台只给 ctx、没有 f。所以「生成上线代码」把每个 f('字段') 就地翻译成从 ctx 直接现算：
//   - 直接字段（能映射到原始 ctx 路径）→ 内联 __Vp('路径', 倍率)（gmgn 占比字段 ×100）；
//   - 派生字段（算出来的、ctx 里没有）→ 把它的计算逻辑内联进代码（__D 预算块），行里引用；
//   - 结果是一份纯 native 策略：没有 f、没有 typeof 守卫、没有垫片。全直接字段的池子 = 零派生块。
//
// 【口径对齐 / 防漂移】派生块逐段照抄 data.js buildRows；×100 的 PCT 与 PERCENT_FRACTION_FIELDS
// 一致；直接字段的路径+倍率由 resolveCtxAccessor 在样本上核对得出。generateOnlineCode 后走
// verifyParity 逐字段跟 review 的 getFeature 比对（容差 REL_TOL），native 代码算的必须 == 回测口径。
//
// 依赖已加载样本：路径解析(resolveCtxAccessor)与自检都要 rawCtx，所以生成需要先加载数据。
// ==============================================================

import { getFeature } from './data.js';
import { resolveCtxAccessor } from './factorLab.js';
import { makeFrozenDate } from './proAnalytics.js';

// 自检数值容差：同一份算法在 review（buildRows）和线上（垫片）两次浮点重算之间的正常抖动，
// 相对误差超过这个值就判为"口径不一致"报警。1e-9 足够严（远小于任何真实算法差异），又能容忍
// 浮点结合律带来的最后几位 ulp 抖动。
const REL_TOL = 1e-9;

// ---- 垫片头部（总是包含）：ctx 解构 + 工具函数 + PCT 集合 + F 缓存 ----
const HEADER = `  var L = ctx.logearn || {};
  var G = ctx.gmgn || {};
  var dev = G.dev || {};
  var stat = G.stat || {};
  var chip = ctx.chip_analysis || {};
  var ki = ctx.kline_and_indicators || {};

  var fin = Number.isFinite;
  var toMs = function (ts) { var n = Number(ts); return fin(n) ? (n >= 1e12 ? n : n * 1000) : NaN; };
  var buyMs = Date.now();                 // 线上：策略在买点当刻运行，now = 买入时刻（= data.js 的 s.timestamp）
  var swapBeginMs = toMs(L.swap_begin_time);

  // 需要 ×100 的比例字段（0-1 小数 → 百分比），必须跟 data.js 的 PERCENT_FRACTION_FIELDS 完全一致
  var PCT = {
    'gmgn.stat.top_rat_trader_percentage': 1, 'gmgn.stat.top_bundler_trader_percentage': 1,
    'gmgn.stat.top_entrapment_trader_percentage': 1, 'gmgn.stat.top_bot_degen_percentage': 1,
    'gmgn.stat.bot_degen_rate': 1, 'gmgn.stat.fresh_wallet_rate': 1, 'gmgn.stat.top_10_holder_rate': 1,
    'gmgn.stat.dev_team_hold_rate': 1, 'gmgn.stat.creator_hold_rate': 1, 'gmgn.stat.private_vault_hold_rate': 1,
    'gmgn.stat.top70_sniper_hold_rate': 1, 'gmgn.dev.top_10_holder_rate': 1, 'gmgn.locked_ratio': 1,
  };

  var F = {}; // 派生字段缓存`;

// ---- 派生字段功能块：每块声明它产出哪些派生字段（produces）+ 块代码（code）----
// 精简模式：某块的 produces 与策略实际用到的字段有交集才装配它。块与块之间只依赖 HEADER 里的
// 变量（L/chip/dev/ki/fin/toMs/buyMs/PCT/F），彼此独立，装配顺序按数组顺序即可。
const BLOCKS = [
  {
    id: 'simple',
    produces: ['buy_sell_count_ratio', 'avg_buy_amount', 'chip_analysis.above_below_ratio', 'open_to_buy_duration'],
    code: `  // ---- 简单派生（data.js 407~431 / 498~501）----
  var buy = Number(L.buy_wcoin_amount_d1), buyers = Number(L.buyer_count_d1), sellers = Number(L.seller_count_d1);
  if (fin(buyers) && fin(sellers) && sellers !== 0) F['buy_sell_count_ratio'] = buyers / sellers;
  if (fin(buy) && fin(buyers) && buyers !== 0) F['avg_buy_amount'] = buy / buyers;
  var cAbove = Number(chip.above_percent), cBelow = Number(chip.below_percent);
  if (fin(cAbove) && fin(cBelow) && cBelow !== 0) F['chip_analysis.above_below_ratio'] = cAbove / cBelow;
  if (fin(buyMs) && fin(swapBeginMs)) F['open_to_buy_duration'] = (buyMs - swapBeginMs) / 60000;`,
  },
  {
    id: 'top5',
    produces: ['chip_analysis.top5_hold_percent', 'chip_analysis.top5_transfer_in_ratio'],
    code: `  // ---- top5 头部持仓（data.js 479~492）----
  var top5 = chip.top5_holders;
  if (Array.isArray(top5) && top5.length) {
    var sumHold = 0, sumTransfer = 0;
    for (var i = 0; i < top5.length; i++) {
      var h = top5[i]; var hold = Number(h && h.total_hold_percent), tin = Number(h && h.transfer_in_percent);
      if (fin(hold)) sumHold += hold;
      if (fin(tin)) sumTransfer += tin;
    }
    if (sumHold > 0) { F['chip_analysis.top5_hold_percent'] = sumHold; F['chip_analysis.top5_transfer_in_ratio'] = sumTransfer / sumHold * 100; }
  }`,
  },
  {
    id: 'twitterRename',
    produces: ['gmgn.dev.twitter_name_change_count'],
    code: `  // ---- 创建者推特改名次数（data.js 691~692）----
  if (Array.isArray(dev.twitter_name_change_history)) F['gmgn.dev.twitter_name_change_count'] = dev.twitter_name_change_history.length;`,
  },
  {
    id: 'vBreakout',
    // V 转信号族（含成本线回溯）—— 深度互相依赖 recentV/measureBarMin，整族当一个块，不再细拆
    produces: [
      'buy_max_retracement',
      'v_breakout_volume_signal_count',
      'v_breakout_volume_recent_stage_pct',
      'v_breakout_volume_recent_prior_count',
      'v_breakout_volume_recent_retracement_pct',
      'v_breakout_volume_recent_drawdown_speed_pct_per_min',
      'v_breakout_volume_recent_signal_from_top_min',
      'v_breakout_volume_recent_rebound_from_low_pct',
      'v_breakout_volume_recent_below_cost_line_elapsed_min',
      'v_breakout_volume_recent_break_cost_line_min',
      'v_breakout_volume_recent_low_cost_line_distance_pct',
    ],
    code: `  // ---- V 转信号族（data.js 504~686、735~753）----
  var breakouts = L.v_breakout_volume_list || [];
  // 周期去重 key（data.js 525~529）
  var vCycleKey = function (ev) {
    var top = Number(ev && ev.top_price_time), low = Number(ev && ev.low_price_time);
    if (fin(top) && fin(low) && (top || low)) return 'c_' + top + '_' + low;
    return 's_' + (Number(ev && ev.signalTime) || Math.random());
  };
  var vReached = function (val, t) { return (Number(val) > 0) || (t !== undefined && t !== null && Number(t) > 0); };

  // buy 之前最大回撤（data.js 509~516）
  var maxRetracement = 0;
  if (Array.isArray(breakouts)) {
    for (var b1 = 0; b1 < breakouts.length; b1++) { var v1 = Number(breakouts[b1] && breakouts[b1].n_pattern_retracement); if (fin(v1) && v1 > maxRetracement) maxRetracement = v1; }
    F['buy_max_retracement'] = maxRetracement;
    // 周期去重后的信号次数（data.js 531）
    var setC = {}; var cnt = 0; for (var b2 = 0; b2 < breakouts.length; b2++) { var k2 = vCycleKey(breakouts[b2]); if (!setC[k2]) { setC[k2] = 1; cnt++; } }
    F['v_breakout_volume_signal_count'] = cnt;
  }

  // 生效 V 转信号 recentV（data.js 542~548）：n_pattern_confirmed 且未收尾，取 signalTime 最新
  var recentV = null;
  if (Array.isArray(breakouts)) {
    for (var b3 = 0; b3 < breakouts.length; b3++) {
      var ev = breakouts[b3];
      if (!ev || ev.n_pattern_confirmed !== true) continue;
      if (vReached(ev.fibon_break4, ev.fibon_break4_time)) continue;
      if (!recentV || (ev.signalTime || 0) > (recentV.signalTime || 0)) recentV = ev;
    }
  }
  if (recentV) {
    // 反弹阶段（data.js 550~554）
    var stage = 0;
    if (vReached(recentV.fibon_break3, recentV.fibon_break3_time)) stage = 60;
    else if (vReached(recentV.fibon_break2, recentV.fibon_break2_time)) stage = 40;
    else if (vReached(recentV.fibon_break1, recentV.fibon_break1_time)) stage = 20;
    F['v_breakout_volume_recent_stage_pct'] = stage;

    // 之前的 V 转周期数（data.js 561~572）
    var recentVSec = Number(recentV.signalTime);
    if (fin(recentVSec)) {
      var recentKey = vCycleKey(recentV); var priorKeys = {}; var pc = 0;
      for (var b4 = 0; b4 < breakouts.length; b4++) {
        var t4 = Number(breakouts[b4] && breakouts[b4].signalTime);
        if (!fin(t4) || t4 >= recentVSec) continue;
        var k4 = vCycleKey(breakouts[b4]);
        if (k4 !== recentKey && !priorKeys[k4]) { priorKeys[k4] = 1; pc++; }
      }
      F['v_breakout_volume_recent_prior_count'] = pc;
    }

    // 回撤幅度/回撤速度/距顶时长/反弹幅度（data.js 580~617）
    var retr = Number(recentV.n_pattern_retracement);
    if (fin(retr)) F['v_breakout_volume_recent_retracement_pct'] = retr * 100;
    var topMs = toMs(recentV.top_price_time), lowMs = toMs(recentV.low_price_time), sigMs0 = toMs(recentV.signalTime);
    if (fin(topMs) && fin(lowMs) && lowMs >= topMs) {
      var drawdownMin = (lowMs - topMs) / 60000;
      if (drawdownMin > 0 && fin(retr)) F['v_breakout_volume_recent_drawdown_speed_pct_per_min'] = retr * 100 / drawdownMin;
    }
    if (fin(topMs) && fin(sigMs0) && sigMs0 >= topMs) F['v_breakout_volume_recent_signal_from_top_min'] = (sigMs0 - topMs) / 60000;
    var riseRatio = Number(recentV.price_rise_ratio);
    if (fin(riseRatio)) F['v_breakout_volume_recent_rebound_from_low_pct'] = riseRatio * 100;
  }

  // 成本线回溯取值（data.js 640~686）：跌破成本线的持续/收复时长
  var measureBarMin = function (bars) {
    if (!Array.isArray(bars) || bars.length < 4) return NaN;
    var ts = bars.map(function (b) { return toMs(b && b.time); }).filter(fin).sort(function (a, b) { return a - b; });
    var gaps = []; for (var i = 1; i < ts.length; i++) { var d = (ts[i] - ts[i - 1]) / 60000; if (d > 0) gaps.push(d); }
    if (gaps.length < 3) return NaN; gaps.sort(function (a, b) { return a - b; }); return gaps[gaps.length >> 1];
  };
  var currentAvgPrice = Number(ki.current_avg_price);
  var klineBars = ki.kline_bars || [];
  var avgBars = ki.avg_price_bars || [];
  var resolutionSec = Number(ki.resolution);
  var mBar = measureBarMin(klineBars);
  var barMinForGap = (fin(mBar) && mBar > 0) ? mBar : ((fin(resolutionSec) && resolutionSec > 0) ? resolutionSec / 60 : NaN);
  var secOf = function (t) { return Number(t) >= 1e12 ? Math.floor(Number(t) / 1000) : Number(t); };
  if (recentV && fin(recentV.top_price_time) && klineBars.length && fin(barMinForGap) && barMinForGap > 0) {
    var topTimeSec = secOf(recentV.top_price_time);
    var costAtTop = currentAvgPrice;
    for (var a1 = 0; a1 < avgBars.length; a1++) { var ba = avgBars[a1]; var bt = secOf(ba && ba.time); if (fin(bt) && bt <= topTimeSec && typeof ba.value === 'number') { costAtTop = ba.value; break; } }
    if (fin(costAtTop) && costAtTop > 0) {
      var chrono = klineBars.map(function (b) { return { time: secOf(b && b.time), close: Number(b && b.close) }; })
        .filter(function (b) { return fin(b.time) && fin(b.close) && b.time >= topTimeSec; })
        .sort(function (a, b) { return a.time - b.time; });
      var breakdownIdx = -1; for (var c1 = 0; c1 < chrono.length; c1++) { if (chrono[c1].close < costAtTop) { breakdownIdx = c1; break; } }
      if (breakdownIdx >= 0) {
        var breakoutIdx = -1; for (var c2 = breakdownIdx + 1; c2 < chrono.length; c2++) { if (chrono[c2].close > costAtTop) { breakoutIdx = c2; break; } }
        var belowBars = (breakoutIdx >= 0 ? breakoutIdx : chrono.length) - breakdownIdx;
        F['v_breakout_volume_recent_below_cost_line_elapsed_min'] = belowBars * barMinForGap;
        if (breakoutIdx >= 0) F['v_breakout_volume_recent_break_cost_line_min'] = belowBars * barMinForGap;
      }
    }
  }
  // V 转最低点距成本线（data.js 735~753）
  if (recentV) {
    var lowMcap = fin(recentV.low_price_mcap) ? recentV.low_price_mcap : (fin(recentV.low_price_mcp) ? recentV.low_price_mcp : undefined);
    var lowTimeRaw = recentV.low_price_time;
    if (fin(lowMcap) && fin(lowTimeRaw)) {
      var lowTimeSec = secOf(lowTimeRaw); var costAtLow = currentAvgPrice;
      for (var a2 = 0; a2 < avgBars.length; a2++) { var bl = avgBars[a2]; var blt = secOf(bl && bl.time); if (fin(blt) && blt <= lowTimeSec && typeof bl.value === 'number') { costAtLow = bl.value; break; } }
      if (fin(costAtLow) && costAtLow !== 0) F['v_breakout_volume_recent_low_cost_line_distance_pct'] = (lowMcap - costAtLow) / costAtLow * 100;
    }
  }`,
  },
];

// 所有派生字段名 → 它所在的块 id（供精简装配、以及自检判断"某字段是派生的但块没装进来"）
const FIELD_TO_BLOCK = (() => {
  const m = new Map();
  for (const b of BLOCKS) for (const f of b.produces) m.set(f, b.id);
  return m;
})();

// 剔除注释（// 行注释 + /* */ 块注释），避免注释里写的 f('字段') 示例被误当成真用到的字段。
// 用最小字符扫描器识别字符串（'、"、`）里的 // 不算注释，只对提取用的临时副本做，不影响产出代码。
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null; // 当前所在字符串的定界符
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += d ?? ''; i += 2; continue; } // 转义，整体跳过下一个字符
      if (c === quote) quote = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }        // 行注释
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; } // 块注释
    out += c; i++;
  }
  return out;
}

// 删掉源码里遗留的 f 垫片块（历史策略顶部可能有一段 var f=(typeof f...)；native 输出不需要，
// 且所有 f('字段') 都会被重写成 native 取值，f 根本没人调用）。按 banner 界定整段剥掉。
function stripFShim(src) {
  return String(src).replace(/^.*f 兼容垫片[\s\S]*?f 垫片结束.*$\n?/m, '');
}

// 扫策略源码里所有 f('字段') / f("字段") 的字段名（去重）；先剔注释，避免示例文字污染
function extractUsedFields(src) {
  const re = /\bf\(\s*['"]([^'"]+)['"]\s*\)/g;
  const set = new Set();
  let m;
  const code = stripComments(src);
  while ((m = re.exec(code)) !== null) set.add(m[1]);
  return [...set];
}

// ---- native 取值助手源（既内联进上线代码，也在自检里 new Function 出来用，同一份源不漂移）----
const P_SRC = "function (o, p) { var a = String(p).split('.'), x = o; for (var i = 0; i < a.length; i++) { if (x == null) return undefined; x = x[a[i]]; } return x; }";
const V_SRC = "function (x) { if (x === null || x === undefined) return null; if (typeof x === 'boolean') return x ? 1 : 0; if (typeof x === 'string' && x.trim() === '') return null; var n = Number(x); return Number.isFinite(n) ? n : null; }";

const jsStr = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

// 用到的派生字段 → 需要装配的块 id
const derivedBlockIdsFor = derivedFields => {
  const used = new Set(derivedFields);
  return BLOCKS.filter(b => b.produces.some(f => used.has(f))).map(b => b.id);
};

// 派生预算块：HEADER + 需要的功能块 + return F（把用到的派生字段算进一个 map）
function derivedFactorySrc(blockIds) {
  const parts = [HEADER];
  for (const b of BLOCKS) if (blockIds.includes(b.id)) parts.push(b.code);
  return parts.join('\n\n') + '\n\n  return F;';
}

// 把 usedFields 分成 直接/派生/无法解析 三类。
// direct: Map field -> { path, mul }（path==='__effMcap__' 表示 mcap 三级回退）；需要 rows 核对路径。
function classifyFields(usedFields, rows) {
  const direct = new Map(), derived = [], unresolved = [];
  for (const field of usedFields) {
    const r = resolveCtxAccessor(rows || [], field);
    if (r.ok) direct.set(field, { path: r.path, mul: r.mul });
    else if (FIELD_TO_BLOCK.has(field)) derived.push(field);
    else unresolved.push({ field, reason: r.reason || '无法映射回 ctx' });
  }
  return { direct, derived, unresolved };
}

// —— 对外 API 1：生成 native 上线代码 ——
// 每个用到的字段翻译成一个【命名 const + 单位注释】，ALL_CHECKS 行引用命名——可读、像手写。
// 取值缺失→null（跟 review 一致；不用会把缺失当 0 的 num——那会让"满分区间含 0"的因子把缺数据的
// 盘误打成满分，破坏线上/回测口径）。返回 { code, usedFields, direct, derived, unresolved }
function generateOnlineCode(src, rows) {
  const clean = stripFShim(src); // 剥掉源码里遗留的 f 垫片
  const usedFields = extractUsedFields(clean);
  const cls = classifyFields(usedFields, rows || []);
  const constName = field => 'F_' + String(field).replace(/[^a-zA-Z0-9]/g, '_');

  const pre = [];
  if (cls.direct.size) {
    pre.push(`var __P = ${P_SRC};`);
    pre.push(`var __V = ${V_SRC};`);
    pre.push(`var __Vp = function (p, m) { var x = __V(__P(ctx, p)); return x === null ? null : x * m; };`);
  }
  if (cls.derived.length) {
    pre.push(`// 派生字段：计算逻辑内联（口径同 review 的 data.js buildRows），结果存进 __D`);
    pre.push(`var __D = (function () {\n${derivedFactorySrc(derivedBlockIdsFor(cls.derived))}\n})();`);
    pre.push(`var __Dget = function (n) { var d = __D[n]; return Number.isFinite(Number(d)) ? Number(d) : null; };`);
  }

  // 打分因子取值：每字段一行命名 const + 单位注释
  const factorLines = usedFields.length
    ? [`// ---------- 打分因子取值（f('字段')→原始 ctx 取值；缺失→null 与 review 一致；占比字段 ×100）----------`]
    : [];
  for (const field of usedFields) {
    const d = cls.direct.get(field);
    let expr, note;
    if (d && d.path === '__effMcap__') {
      expr = `(function () { var a = __V(__P(ctx, 'logearn.mcap')); if (a !== null) return a; var b = __V(__P(ctx, 'logearn.current_mcap')); if (b !== null) return b; return __V(__P(ctx, 'logearn.fdv')); })()`;
      note = 'mcap→current_mcap→fdv 回退';
    } else if (d) {
      expr = `__Vp(${jsStr(d.path)}, ${d.mul})`;
      note = d.mul === 100 ? '占比 0-1 → %' : '原始值';
    } else if (cls.derived.includes(field)) {
      expr = `__Dget(${jsStr(field)})`;
      note = '派生（计算见上方 __D）';
    } else {
      expr = 'null';
      note = '⚠️ 无法映射回 ctx，当缺失';
    }
    factorLines.push(`const ${constName(field)} = ${expr};  // ${field}  ${note}`);
  }

  // ALL_CHECKS 里的 f('字段') 换成对应命名 const（只替换真用到的字段；注释里的示例名不碰）
  const rewritten = clean
    .replace(/\bf\(\s*(['"])([^'"]+)\1\s*\)/g, (m, q, field) => (usedFields.includes(field) ? constName(field) : m))
    .replace(/\n{3,}/g, '\n\n'); // 顺手压掉「发送到策略」删行留下的多余空行

  const banner = `// ===== 上线代码（review「生成上线代码」自动翻译成 native ctx，请勿手改）=====
// 每个 f('字段') 翻译成一个命名 const（见下方"打分因子取值"块）：直接字段 → __Vp('ctx路径', 倍率)、
// 派生字段 → 内联计算 __D。无 f、无垫片；缺失→null 与 review 回测口径一致（已逐字段自检）。`;

  const parts = [banner];
  if (pre.length) parts.push(pre.join('\n'));
  if (factorLines.length) parts.push(factorLines.join('\n'));
  parts.push('');
  parts.push(rewritten.replace(/^﻿/, ''));

  return {
    code: parts.join('\n'),
    usedFields,
    direct: [...cls.direct.entries()].map(([field, d]) => ({ field, ...d })),
    derived: cls.derived,
    unresolved: cls.unresolved,
  };
}

// 把某个字段的 online 值与 review 值比一比，返回 { status, rel, online, review }
// status: 'ok' 一致 | 'mismatch' 数值不一致 | 'missing_online' review 有值线上取不到（如无法解析的字段）
//         | 'nonnumeric' review 是非数值（地址/平台名等，native 只给数值，无法复现，仅提示）
function compareValue(online, review) {
  const miss = x => x == null || (typeof x === 'number' && !Number.isFinite(x));
  const oMiss = miss(online), rMiss = miss(review);
  if (rMiss) return { status: 'ok', rel: 0, online, review };
  if (typeof review !== 'number' && !Number.isFinite(Number(review))) {
    return { status: 'nonnumeric', rel: NaN, online, review };
  }
  const y = Number(review);
  if (oMiss) return { status: 'missing_online', rel: Infinity, online, review };
  const x = Number(online);
  const rel = Math.abs(x - y) / Math.max(1, Math.abs(x), Math.abs(y));
  return { status: rel <= REL_TOL ? 'ok' : 'mismatch', rel, online, review };
}

// —— 对外 API 2：逐字段一致性自检 ——
// 用 native 取值（直接字段走 路径×倍率、派生字段走内联块）在每条 rawCtx 上算值，跟 getFeature 比。
// Date 冻结在 row.buyTimestamp（同 runStrategyOnRow），否则 open_to_buy_duration 会因 Date.now() 对不上。
// 返回 { ok, fields:[{field,kind,checked,mismatches,maxRel,status,sample}], rowsChecked }。
function verifyParity(src, rows) {
  const usedFields = extractUsedFields(src);
  const cls = classifyFields(usedFields, rows || []);
  const usable = (rows || []).filter(r => r && r.rawCtx);
  // eslint-disable-next-line no-new-func
  const P = new Function('return (' + P_SRC + ')')();
  // eslint-disable-next-line no-new-func
  const V = new Function('return (' + V_SRC + ')')();
  const directVal = (rawCtx, path, mul) => {
    if (path === '__effMcap__') {
      const a = V(P(rawCtx, 'logearn.mcap')); if (a !== null) return a;
      const b = V(P(rawCtx, 'logearn.current_mcap')); if (b !== null) return b;
      return V(P(rawCtx, 'logearn.fdv'));
    }
    const x = V(P(rawCtx, path)); return x === null ? null : x * mul;
  };
  let derivedFactory = null;
  if (cls.derived.length) {
    // eslint-disable-next-line no-new-func
    derivedFactory = new Function('ctx', 'Date', derivedFactorySrc(derivedBlockIdsFor(cls.derived)));
  }

  const kindOf = field => (cls.direct.has(field) ? 'direct' : (cls.derived.includes(field) ? 'derived' : 'unresolved'));
  const stat = new Map();
  for (const field of usedFields) stat.set(field, { field, kind: kindOf(field), checked: 0, mismatches: 0, maxRel: 0, status: 'ok', sample: null });

  for (const row of usable) {
    const nowMs = Number.isFinite(row.buyTimestamp) ? row.buyTimestamp * 1000 : Date.now();
    let D = null;
    if (derivedFactory) { try { D = derivedFactory(row.rawCtx, makeFrozenDate(nowMs)); } catch { D = null; } }
    for (const field of usedFields) {
      const s = stat.get(field);
      let online = null;
      try {
        const d = cls.direct.get(field);
        if (d) online = directVal(row.rawCtx, d.path, d.mul);
        else if (cls.derived.includes(field) && D) { const v = D[field]; online = Number.isFinite(Number(v)) ? Number(v) : null; }
        else online = null;
      } catch { online = null; }
      const review = getFeature(row, field);
      const cmp = compareValue(online, review);
      s.checked++;
      if (cmp.status === 'mismatch' || cmp.status === 'missing_online') {
        s.mismatches++;
        if (cmp.rel > s.maxRel) s.maxRel = cmp.rel;
        if (s.status === 'ok' || s.status === 'nonnumeric') s.status = cmp.status;
        if (!s.sample) s.sample = { tokenAddress: row.tokenAddress, online: cmp.online, review: cmp.review, rel: cmp.rel };
      } else if (cmp.status === 'nonnumeric' && s.status === 'ok') {
        s.status = 'nonnumeric';
        if (!s.sample) s.sample = { tokenAddress: row.tokenAddress, online: cmp.online, review: cmp.review, rel: NaN };
      }
    }
  }
  const fields = [...stat.values()];
  const ok = fields.every(f => f.status !== 'mismatch' && f.status !== 'missing_online');
  return { ok, fields, rowsChecked: usable.length };
}

// —— 对外 API 3：一键生成 + 自检 ——
// 返回 { code, report, direct, derived, unresolved }
function exportWithVerify(src, rows) {
  const gen = generateOnlineCode(src, rows);
  const report = verifyParity(src, rows);
  return { code: gen.code, report, direct: gen.direct, derived: gen.derived, unresolved: gen.unresolved };
}

export {
  REL_TOL,
  BLOCKS,
  FIELD_TO_BLOCK,
  extractUsedFields,
  classifyFields,
  generateOnlineCode,
  verifyParity,
  exportWithVerify,
};
