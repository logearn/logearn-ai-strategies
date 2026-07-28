// ==============================================================
// 单代币强势盘策略【打分版】score-v2.1.0
//
// 【这一版是什么】v2.0.0 是纯硬条件版（v1.0.1 的 12 项全在 VETO_NAMES 里，没有打分项）。
// 这一版在那 12 项硬条件基础上，往打分池里加了一批真正的打分因子（都不在 VETO_NAMES 里，
// 走 ALL_CHECKS 里 for 循环的"打分"分支，真实计入 total）：frequent_volume/new_volume/
// old_volume/smart_volume（勇者，加分）、shit_volume（邪恶，扣分）、chip_analysis 系列
// （above_below_ratio/top5_hold_percent/top5_transfer_in_ratio/total_holding_percent）、
// gmgn.dev/gmgn.stat 系列（top_10_holder_rate/creator_open_count/bot_degen_rate/
// creator_hold_rate/dev_team_hold_rate/fresh_wallet_rate/top70_sniper_hold_rate/
// top_bot_degen_percentage/top_bundler_trader_percentage/top_entrapment_trader_percentage
// 等，多数勇者，twitter_create_token_count/twitter_del_post_token_count/
// twitter_name_change_count 是邪恶/扣分）。清理时发现并去掉了几组完全重复的 ALL_CHECKS
// 行（同一字段被加了两遍，参数一模一样）——这批是之前用 review 工具反复加/批量发送时
// 不小心重复加入的，保留其中一份即可，删掉的都是无条件的字面量重复，不影响判定逻辑。
// 想再挪某一项进/出打分组：加一项就从 VETO_NAMES 删掉对应名字（并把 weight 从占位的 1
// 改成真实权重）；退回硬条件就反过来，把名字加回 VETO_NAMES（weight 多少无所谓，反正
// VETO_NAMES 里的项不看 weight）。
//
// 【score 公式：这版改回归一化】v2.0.0 曾经改成"score = total"原始累加分（那时打分池要么
// 是空的、要么只有一两项，归一化会让单个因子直接顶格）；现在打分池有 20+ 个因子，原始累加
// 分早就没有上限（实测跑出过 260 分），CUTOFF 的含义随着"加了多少项"一直漂移，不是个稳定
// 尺度。改回 score = wsum>0 ? total/wsum*100 : 0——归一化到 0~100，因子池再扩也不会失控；
// 空打分池给 0 分（谁都过不了打分关，硬条件依然只管一票否决，跟 score 无关）。CUTOFF=60
// 的含义也跟着变回"百分比阈值"，用真实数据在 review 工具里重新验证过再上线。
//
// 【继续沿用的规则，见"强势盘打分版" v1.3~v1.5 的教训】
// ALL_CHECKS 里每一项都必须有真实权重，不用 0 占位——上次因为占位的 0 没人记得改，
// 导致 9 项防雷指标被挪出硬否决后完全隐形失效。
//
// 说明：checks 顺序=判定优先级；chip_analysis 系列这版已经参与判定（不再是仅展示）；
// gmgn 里的占比字段均为 0-1 小数，×100 转成百分比（部分因子直接用原始小数取值，注意
// 区间单位是否已经转换）。
// ==============================================================

// ===== f 兼容垫片（standalone）：让含 f('字段') 的打分因子在线上（只有 ctx、没有 f）也能跑 =====
// review 里 f 是注入参数（typeof==='function'）→ 保留、垫片不生效，回放口径不变；线上没有 f →
// 用垫片从 ctx 现算（算法逐段照抄 review 的 src/lib/data.js）。用 var（不是 const）避免与注入的同名
// 参数冲突。完整注释见 强势盘策略/f-shim.js。1.5段与本策略共用同一份垫片，保持统一。
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
// ===== f 垫片结束 =====

const VERSION = 'score-v2.1.0'
const CUTOFF = 80

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }
const sma = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
// 梯形打分：[lo1,hi1] 满分 1，[lo0,lo1]/[hi1,hi0] 线性过渡，界外 0，缺失 0；±Infinity=该侧不设界。
// lo1===hi1（或 lo0=lo1=hi1=hi0）时过渡带宽度为 0，退化成普通布尔阶跃——ALL_CHECKS 里
// 目前所有行（打分因子和硬性条件都算）都是这种零宽度写法，没有用到真正的线性过渡带。
const trap = (x, lo0, lo1, hi1, hi0) => {
  if (x === null || !Number.isFinite(Number(x))) return 0
  const v = Number(x)
  if (v >= lo1 && v <= hi1) return 1
  if (v <= lo0 || v >= hi0) return 0
  if (v < lo1) { const w = lo1 - lo0; return Number.isFinite(w) && w > 0 ? (v - lo0) / w : 0 }
  const w = hi0 - hi1
  return Number.isFinite(w) && w > 0 ? (hi0 - v) / w : 0
}

// ---------- 阈值常量（沿用 v1.0.1 命名与数值）----------
const MCAP_MAX = 120000     // 有效市值上限（USD）
const DEV_MIN = 2           // 成本线偏离下限（%）
const DEV_MAX = 120         // 成本线偏离上限（%）
const AGE_MIN_SEC = 60      // 生命周期下限：< 1 分钟直接淘汰
const AGE_MAX_MIN = 500     // 生命周期上限（分钟）
const TOP10_MAX = 30        // Top10 持仓% 上限
const CREATOR_MAX = 1       // 创建者持仓% 上限
const RAT_MAX = 10          // 内鬼/插队交易者% 上限
const SHIT_MAX = 5          // 垃圾钱包占比上限（%）
const BUYTX_MIN = 50        // 24h 买入次数下限

// 发射平台白名单
const ALLOW_PLATFORMS = [
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump 内盘
  'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1', // LetsBonk 1
  'BuM6KDpWiTcxvrpXywWFiw45R2RNH8WURdvqoTDV1BW4', // LetsBonk 2
  'four.meme',                                    // Four.meme
  'binance_four.meme'                             // Binance Four.meme
]

// ---------- 取数据 ----------
const ki = ctx.kline_and_indicators || {}
const aoBars = Array.isArray(ki.ao_bars) ? ki.ao_bars : []
const logearn = ctx.logearn || {}
const gmgn = ctx.gmgn || {}
const dev = gmgn.dev || {}
const stat = gmgn.stat || {}
const chip = ctx.chip_analysis || {}
const symbol = logearn.symbol || ki.symbol || 'UNKNOWN'
const Holders = ctx.holders || [] // 当前未参与判定/日志，预留（沿用 v1.0.1 原样）
const visitingCount = gmgn.visiting_count != null ? gmgn.visiting_count : 0

// gmgn 占比字段（0-1 小数 → 百分比）
const top10Pct = num(dev.top_10_holder_rate) * 100
const creatorPct = num(stat.creator_hold_rate) * 100
const ratPct = num(stat.top_rat_trader_percentage) * 100

// ---------- 筹码分析（仅展示，不参与判定）----------
const chipAbove = num(chip.above_percent)          // 当前价上方筹码%（抛压）
const chipBelow = num(chip.below_percent)          // 当前价下方筹码%（支撑）
const chipTotalHold = num(chip.total_holding_percent) // Top500 累计持仓%
const chipInnerSell = num(chip.inner_sell_ratio)   // 内盘卖出率
const chipInnerHold = num(chip.inner_address_holding) // 内盘地址剩余持仓占比%
const chipSummary = '筹码[上' + chipAbove.toFixed(1) + '/下' + chipBelow.toFixed(1) +
  '/总持' + chipTotalHold.toFixed(1) + '/内盘卖' + chipInnerSell.toFixed(1) +
  '/内盘持' + chipInnerHold.toFixed(1) + ']'

// ---------- 年龄 ----------
const nowTs = Math.floor(Date.now() / 1000)
const launchTime = num(logearn.swap_begin_time)
const ageSec = launchTime > 0 ? nowTs - launchTime : -1
const ageMin = launchTime > 0 ? ageSec / 60 : Infinity

// ---------- 市值（三字段取最大，卡上限更严）----------
const mcapCur = num(logearn.current_mcap)
const mcapMc = num(logearn.mcap)
const mcapFdv = num(logearn.fdv)
const effMcap = Math.max(mcapCur, mcapMc, mcapFdv)

// ---------- 偏离 / 热度 ----------
const deviationPct = num(ki.avg_price_deviation_pct)
const buyTxD1 = num(logearn.buy_tx_count_d1)

// ---------- AO 动量：最新一根为正且高于上一根 ----------
const resStr = String(ki.resolution || '').toUpperCase().trim()
const needN = resStr === '1S' || resStr === '5S' ? 5 : 3
const aoVals = []
for (let i = 0; i < needN; i++) aoVals.push(num(aoBars[i] ? aoBars[i].value : 0))
const ao0 = aoVals[0]
const ao1 = aoVals[1]
const aoOk = aoBars.length >= needN && ao0 > 0 && ao0 > ao1

// ---------- AC 加速度：AO 相对自身近 5 根均值的偏离，为正且放大 ----------
const calcAC = (idx) => {
  if (idx + 5 > aoBars.length) return null
  const win = aoBars.slice(idx, idx + 5).map((b) => num(b.value))
  return num(aoBars[idx].value) - sma(win)
}
const ac0 = calcAC(0)
const ac1 = calcAC(1)
const acOk = ac0 !== null && ac1 !== null && ac0 > 0 && ac0 > ac1

// ========== 统一检查项清单 ==========
// [name, value, weight, lo0, lo1, hi1, hi0, actualDisplay(可选), expectLabel(可选)]
// 最前面 34 项是打分因子（不在 VETO_NAMES 里，weight 是真实权重；已去掉 2 条重复，从 36 减到 34）；
// 最后 12 项（平台～AC）是硬性条件（都在 VETO_NAMES 里，weight 不参与打分，但照样给真实数值，不用 0 占位）。
const ALL_CHECKS = [
  ['avg_buy_amount', f('avg_buy_amount'), 1, 0.5, 0.5, 1.5, 1.5, null, '0.5~1.5'],

  ['buy_max_retracement', f('buy_max_retracement'), 1, 0.2, 0.2, 0.65, 0.65, null, '0.2~0.65'],

  ['buy_sell_count_ratio', f('buy_sell_count_ratio'), 6, -Infinity, -Infinity, 2, 2, null, '-Infinity~2'],

  ['open_to_buy_duration', f('open_to_buy_duration'), 3, -Infinity, -Infinity, 150, 150, null, '-Infinity~150'],

  ['v_breakout_volume_re', f('v_breakout_volume_recent_below_cost_line_elapsed_min'), 1, -Infinity, -Infinity, 10, 10, null, '-Infinity~10'],

  ['v_breakout_volume_re', f('v_breakout_volume_recent_break_cost_line_min'), 10, -Infinity, -Infinity, 5, 5, null, '-Infinity~5'],

  ['v_breakout_volume_re', f('v_breakout_volume_recent_drawdown_speed_pct_per_min'), 10, -Infinity, -Infinity, 40, 40, null, '-Infinity~40'],

  ['v_breakout_volume_re', f('v_breakout_volume_recent_low_cost_line_distance_pct'), 10, -40, -40, 50, 50, null, '-40~50'],

  ['v_breakout_volume_re', f('v_breakout_volume_recent_prior_count'), 10, -Infinity, -Infinity, 4, 4, null, '-Infinity~4'],

  ['v_breakout_volume_si', f('v_breakout_volume_signal_count'), 1, -Infinity, -Infinity, 4, 4, null, '-Infinity~4'],

  ['v_breakout_volume_re', f('v_breakout_volume_recent_signal_from_top_min'), 10, -Infinity, -Infinity, 100, 100, null, '-Infinity~100'],

  ['v_breakout_volume_re', f('v_breakout_volume_recent_retracement_pct'), 10, -Infinity, -Infinity, 65, 65, null, '-Infinity~65'],

  ['v_breakout_volume_re', f('v_breakout_volume_recent_rebound_from_low_pct'), 10, -Infinity, -Infinity, 100, 100, null, '-Infinity~100'],

  ['frequent_volume', f('frequent_volume'), 12, 10, 10, 54.2027, 54.2027, null, '10~54.2027'],

  ['new_volume', f('new_volume'), 10, 15, 15, 50, 50, null, '15~50'],

  ['old_volume', f('old_volume'), 10, 20, 20, 50, 50, null, '20~50'],

  ['shit_volume', f('shit_volume'), 8, 5, 5, 100, 100, null, '5~100'],

  ['smart_volume', f('smart_volume'), 8, 2, 2, Infinity, Infinity, null, '2~Infinity'],

  ['chip_analysis.above_', f('chip_analysis.above_below_ratio'), 7, -Infinity, -Infinity, 1.2, 1.2, null, '-Infinity~1.2'],

  ['chip_analysis.top5_h', f('chip_analysis.top5_hold_percent'), 3, 9, 9, 30, 30, null, '9~30'],

  ['chip_analysis.top5_t', f('chip_analysis.top5_transfer_in_ratio'), 1, -Infinity, -Infinity, 40, 40, null, '-Infinity~40'],

  ['chip_analysis.total_', f('chip_analysis.total_holding_percent'), 1, 60, 60, Infinity, Infinity, null, '60~Infinity'],

  ['gmgn.dev.creator_ope', f('gmgn.dev.creator_open_count'), 3, -Infinity, -Infinity, 250, 250, null, '-Infinity~250'],

  ['gmgn.dev.top_10_hold', f('gmgn.dev.top_10_holder_rate'), 6, 15, 15, 30, 30, null, '15~30'],

  ['gmgn.dev.twitter_cre', f('gmgn.dev.twitter_create_token_count'), 3, -Infinity, -Infinity, 1000, 1000, null, '-Infinity~1000'],

  ['gmgn.dev.twitter_del', f('gmgn.dev.twitter_del_post_token_count'), 1, 500, 500, Infinity, Infinity, null, '500~Infinity'],

  ['gmgn.dev.twitter_nam', f('gmgn.dev.twitter_name_change_count'), 5, 50, 50, Infinity, Infinity, null, '50~Infinity'],

  ['gmgn.stat.bot_degen_', f('gmgn.stat.bot_degen_rate'), 6, 30, 30, 70, 70, null, '30~70'],

  ['gmgn.stat.creator_ho', f('gmgn.stat.creator_hold_rate'), 1, -Infinity, -Infinity, 0.2, 0.2, null, '-Infinity~0.2'],

  ['gmgn.stat.dev_team_h', f('gmgn.stat.dev_team_hold_rate'), 2, -Infinity, -Infinity, 20, 20, null, '-Infinity~20'],

  ['gmgn.stat.fresh_wall', f('gmgn.stat.fresh_wallet_rate'), 1, -Infinity, -Infinity, 20, 20, null, '-Infinity~20'],

  ['gmgn.stat.top70_snip', f('gmgn.stat.top70_sniper_hold_rate'), 1, -Infinity, -Infinity, 40, 40, null, '-Infinity~40'],

  // 去重：gmgn.stat.top_10_holder_rate 与上面 gmgn.dev.top_10_holder_rate 同值同区间（都 15~30），
  //       gmgn.stat.top_bot_degen_percentage 与上面 gmgn.stat.bot_degen_rate 同值同区间（都 30~70）——
  //       同一信号别投两票，各保留上面 dev/rate 那一条，这两条删掉。
  ['gmgn.stat.top_bundle', f('gmgn.stat.top_bundler_trader_percentage'), 6, 15, 15, 55, 55, null, '15~55'],

  ['gmgn.stat.top_entrap', f('gmgn.stat.top_entrapment_trader_percentage'), 3, -Infinity, -Infinity, 11, 11, null, '-Infinity~11'],

  ['平台', ALLOW_PLATFORMS.indexOf(logearn.platform) !== -1 ? 1 : 0, 1, 1, 1, 1, 1,
    String(logearn.platform), '白名单(含four.meme)'],
  ['年龄(秒)', ageSec, 1, AGE_MIN_SEC, AGE_MIN_SEC, Infinity, Infinity, null, '>= ' + AGE_MIN_SEC],
  ['年龄(分)', ageMin, 1, -Infinity, -Infinity, AGE_MAX_MIN, AGE_MAX_MIN, null, '<= ' + AGE_MAX_MIN],
  ['市值', effMcap > 0 ? effMcap : null, 1, 0, 0, MCAP_MAX, MCAP_MAX, null, '>0 且 < ' + MCAP_MAX],
  ['Top10持仓%', top10Pct, 1, -Infinity, -Infinity, TOP10_MAX, TOP10_MAX, null, '< ' + TOP10_MAX],
  ['创建者持仓%', creatorPct, 1, -Infinity, -Infinity, CREATOR_MAX, CREATOR_MAX, null, '< ' + CREATOR_MAX],
  ['内鬼%', ratPct, 1, -Infinity, -Infinity, RAT_MAX, RAT_MAX, null, '< ' + RAT_MAX],
  ['垃圾钱包%', num(logearn.shit_volume), 1, -Infinity, -Infinity, SHIT_MAX, SHIT_MAX, null, '< ' + SHIT_MAX],
  ['买入次数', buyTxD1, 1, BUYTX_MIN, BUYTX_MIN, Infinity, Infinity, null, '> ' + BUYTX_MIN],
  ['偏离%', deviationPct, 1, DEV_MIN, DEV_MIN, DEV_MAX, DEV_MAX, null, DEV_MIN + '~' + DEV_MAX],
  ['AO', aoOk ? 1 : 0, 1, 1, 1, 1, 1, ao0.toFixed(0) + '/' + ao1.toFixed(0), 'ao0>0 且 ao0>ao1'],
  ['AC', acOk ? 1 : 0, 1, 1, 1, 1, 1,
    (ac0 === null ? 'NA' : ac0.toFixed(1)) + '/' + (ac1 === null ? 'NA' : ac1.toFixed(1)), 'ac0>0 且 ac0>ac1'],
]

// ========== 分组：谁是硬否决，只看这个集合 ==========
// 这里 12 项是硬否决（平台～AC）；ALL_CHECKS 里其余 34 项都是打分因子（不在本集合里）。
// 想把某一项挪进打分组：从这里删掉对应名字，同时把 ALL_CHECKS 里那一行的 weight 改成真实权重
// （用回测数据校准，不要拍脑袋）；退回硬条件就把名字加回来。
const VETO_NAMES = new Set([
  '平台', '年龄(秒)', '年龄(分)', '市值', 'Top10持仓%', '创建者持仓%',
  '内鬼%', '垃圾钱包%', '买入次数', '偏离%', 'AO', 'AC',
])

// ========== 汇总 ==========
let total = 0, wsum = 0, vetoPassed = true
const checks = []
for (const c of ALL_CHECKS) {
  const [name, value, weight, lo0, lo1, hi1, hi0, actualOverride, expectOverride] = c
  const s = trap(value, lo0, lo1, hi1, hi0)
  const actualStr = actualOverride != null
    ? actualOverride
    : (value === null ? '缺失' : String(Number(Number(value).toFixed(4))))
  if (VETO_NAMES.has(name)) {
    const ok = s === 1
    if (!ok) vetoPassed = false
    checks.push([name, ok, actualStr, expectOverride != null ? expectOverride : (lo1 + '~' + hi1)])
  } else {
    // wsum 只累加正权重（勇者阵营的满分上限）——邪恶阵营权重是负的，它的"最好情况"是
    // s=0（没踩中危险区，贡献 0 分），不是 weight（那是它的最坏情况）。真实事故：
    // wsum 要是把负权重也加进来，分母会比"实际能拿到的最高分"更小，邪恶阵营没触发时
    // （最常见的情况）score 反而会被推过 100（实测跑出过 120 分）——分子封顶在 Σ正权重，
    // 分母却被邪恶权重拉低，比例自然超过 1。
    total += s * weight; wsum += Math.max(0, weight)
    checks.push([name + '(分)', s > 0, actualStr + ' → ' + (s * weight).toFixed(1) + '分',
      '满分 ' + lo1 + '~' + hi1 + ' 权重 ' + weight])
  }
}
// score 归一化到 0~100（Σ(s·w)/Σ正权重 × 100）——不用原始累加分：打分池现在有 20+ 个因子，
// 权重总和早就远超 100，原始累加分没有上限、CUTOFF 的含义会随着"加了多少项"一直漂移。
// 归一化之后 score 天然锁在 0~100，因子池再扩也不会失控；没有任何打分项时 wsum=0，给 0 分。
const score = wsum > 0 ? total / wsum * 100 : 0
checks.push(['总分', score >= CUTOFF, score.toFixed(1), '>= ' + CUTOFF])

// 机器可解析的分数标记：/SCORE=([\d.]+) VER=(\S+) GRADE=(\S)/
// GRADE：S=总分>=85，A=60~85，-=未过线或被硬否决。硬否决未过时强制 '-'。
const grade = !vetoPassed ? '-' : (score >= 85 ? 'S' : (score >= CUTOFF ? 'A' : '-'))
const mark = 'SCORE=' + score.toFixed(1) + ' VER=' + VERSION + ' GRADE=' + grade
const head = mark + ' 访问' + visitingCount + ' [' + symbol + '] K' + ki.resolution + '  ' + chipSummary
const detail = checks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
if (!vetoPassed) {
  const fails = ALL_CHECKS.filter((c) => VETO_NAMES.has(c[0]))
    .filter((c) => trap(c[1], c[3], c[4], c[5], c[6]) !== 1)
    .map((c) => `${c[0]}=${c[7] != null ? c[7] : c[1]}`).join(' ')
  ctx.log.error('未命中(否决) ' + head + ' | 否决:' + fails + '  ||  ' + detail)
  return false
}
if (score < CUTOFF) {
  ctx.log.error('未命中(分低) ' + head + '  ||  ' + detail)
  return false
}
ctx.log.success('命中<强势盘·打分> ' + head + '  ||  ' + detail)
return true
