// ==============================================================
// f 兼容垫片（standalone f-shim）—— 参考文件，请勿手改
//
// ⚠️ 单一事实源已迁移到 review/src/lib/onlineExport.js（分块装配 + 逐字段数值自检）。
//    上线代码请用 review「策略」tab 的『生成上线代码』按钮生成，别再手抄本文件。
//    本文件保留作参考/离线兜底；tests/online-export.test.js 断言"完整模式产出的 f 行为
//    与本文件逐字段一致"，两者已被锁死，改了一边不同步会红。
//
// 贴在策略最顶上（在 const VERSION 之前）
//
// 【解决什么】review 工具回放时会注入一个 f('字段名') 取"分析特征"的函数；线上 logearn 平台
// 只给 ctx、没有 f，所以打分版策略贴上去会报 f is not defined。这个垫片把 review 特征层
// （src/lib/data.js 里那套算法）原样搬过来，从 ctx 现算，让【同一份策略代码】review 和线上都能跑。
//
// 【为什么用 var f = typeof f==='function' ? f : ...】
// review 里 f 是 new Function('ctx','f','Date','__emit',...) 的参数，用 const 会"已声明"报错；
// var 可以和同名参数共存。review 里保留注入的 f（垫片不生效，保证跟回放口径一致）；
// 线上没有 f 参数 → typeof 得到 'undefined' → 用垫片。
//
// 【口径对齐】数值全部照 data.js：
//   - ×100 的比例字段（PCT 集合）跟 PERCENT_FRACTION_FIELDS 一致；
//   - 买入时刻 buyMs 线上 = Date.now()（策略就在买点当刻跑），等价于 data.js 里的 s.timestamp；
//   - 派生字段算法逐段照抄 data.js buildRows，注释标了对应位置。
//   - 缺失一律返回 null（trap() 收到 null 记 0 分），跟 review 的"缺失=0 分"一致。
// ==============================================================
var f = (typeof f === 'function') ? f : (function () {
  var L = ctx.logearn || {};
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

  var F = {}; // 派生字段缓存

  // ---- 简单派生（data.js 407~431）----
  var buy = Number(L.buy_wcoin_amount_d1), buyers = Number(L.buyer_count_d1), sellers = Number(L.seller_count_d1);
  if (fin(buyers) && fin(sellers) && sellers !== 0) F['buy_sell_count_ratio'] = buyers / sellers;
  if (fin(buy) && fin(buyers) && buyers !== 0) F['avg_buy_amount'] = buy / buyers;
  var cAbove = Number(chip.above_percent), cBelow = Number(chip.below_percent);
  if (fin(cAbove) && fin(cBelow) && cBelow !== 0) F['chip_analysis.above_below_ratio'] = cAbove / cBelow;

  // ---- 上线到买入时长，分钟（data.js 498~501）----
  if (fin(buyMs) && fin(swapBeginMs)) F['open_to_buy_duration'] = (buyMs - swapBeginMs) / 60000;

  // ---- top5 头部持仓（data.js 479~492）----
  var top5 = chip.top5_holders;
  if (Array.isArray(top5) && top5.length) {
    var sumHold = 0, sumTransfer = 0;
    for (var i = 0; i < top5.length; i++) {
      var h = top5[i]; var hold = Number(h && h.total_hold_percent), tin = Number(h && h.transfer_in_percent);
      if (fin(hold)) sumHold += hold;
      if (fin(tin)) sumTransfer += tin;
    }
    if (sumHold > 0) { F['chip_analysis.top5_hold_percent'] = sumHold; F['chip_analysis.top5_transfer_in_ratio'] = sumTransfer / sumHold * 100; }
  }

  // ---- 创建者推特改名次数（data.js 691~692）----
  if (Array.isArray(dev.twitter_name_change_history)) F['gmgn.dev.twitter_name_change_count'] = dev.twitter_name_change_history.length;

  // ---- V 转信号族（data.js 504~686、735~753）----
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
  }

  // ---- 直接取值：按点号路径从 ctx 找；裸字段名（frequent_volume 等）落到 logearn；PCT 集合 ×100 ----
  var walk = function (root, path) {
    var parts = path.split('.'), o = root;
    for (var i = 0; i < parts.length; i++) { if (o == null) return undefined; o = o[parts[i]]; }
    return o;
  };
  var direct = function (name) {
    var v;
    if (name.indexOf('.') >= 0) v = walk(ctx, name);          // gmgn.dev.x / chip_analysis.x / kline_and_indicators.x
    else { v = L[name]; if (v === undefined) v = ctx[name]; } // 裸字段 → logearn 优先，再顶层
    if (v === undefined || v === null || v === '') return null;
    var n = Number(v); if (!fin(n)) return null;
    return PCT[name] ? n * 100 : n;
  };

  return function (name) {
    if (Object.prototype.hasOwnProperty.call(F, name)) { var d = F[name]; return fin(Number(d)) ? Number(d) : null; }
    return direct(name);
  };
})();
