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
import { stripComments } from './stripComments.js';

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
  var holders = Array.isArray(ctx.holders) ? ctx.holders : [];

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
    produces: [
      'buy_sell_count_ratio', 'avg_buy_amount', 'chip_analysis.above_below_ratio', 'open_to_buy_duration',
      'buy_sell_amount_ratio', 'buy_sell_tx_ratio', 'smart_buy_sell_ratio', 'mcap_liquidity_ratio',
      'avg_sell_amount', 'buy_tx_per_buyer', 'sell_tx_per_seller', 'smart_money_net_buy_count',
      'launch_to_buy_duration', 'above_cost_line', 'cost_line_distance_pct',
    ],
    code: `  // ---- 简单派生（data.js 407~502, 704~722）----
  var buy = Number(L.buy_wcoin_amount_d1), sell = Number(L.sell_wcoin_amount_d1);
  var buyers = Number(L.buyer_count_d1), sellers = Number(L.seller_count_d1);
  var buyTx = Number(L.buy_tx_count_d1), sellTx = Number(L.sell_tx_count_d1);
  var smartBuy = Number(L.smart_money_address_buy_count_d1), smartSell = Number(L.smart_money_address_sell_count_d1);
  var liq = Number(L.pool_liquidity);
  var effMcapSimple = fin(Number(L.mcap)) ? Number(L.mcap) : (fin(Number(L.current_mcap)) ? Number(L.current_mcap) : Number(L.fdv));
  if (fin(buy) && fin(sell) && sell !== 0) F['buy_sell_amount_ratio'] = buy / sell;
  if (fin(buyers) && fin(sellers) && sellers !== 0) F['buy_sell_count_ratio'] = buyers / sellers;
  if (fin(buyTx) && fin(sellTx) && sellTx !== 0) F['buy_sell_tx_ratio'] = buyTx / sellTx;
  if (fin(smartBuy) && fin(smartSell) && smartSell !== 0) F['smart_buy_sell_ratio'] = smartBuy / smartSell;
  if (fin(effMcapSimple) && fin(liq) && liq !== 0) F['mcap_liquidity_ratio'] = effMcapSimple / liq;
  if (fin(buy) && fin(buyers) && buyers !== 0) F['avg_buy_amount'] = buy / buyers;
  if (fin(sell) && fin(sellers) && sellers !== 0) F['avg_sell_amount'] = sell / sellers;
  var cAbove = Number(chip.above_percent), cBelow = Number(chip.below_percent);
  if (fin(cAbove) && fin(cBelow) && cBelow !== 0) F['chip_analysis.above_below_ratio'] = cAbove / cBelow;
  if (fin(buyTx) && fin(buyers) && buyers !== 0) F['buy_tx_per_buyer'] = buyTx / buyers;
  if (fin(sellTx) && fin(sellers) && sellers !== 0) F['sell_tx_per_seller'] = sellTx / sellers;
  if (fin(smartBuy) && fin(smartSell)) F['smart_money_net_buy_count'] = smartBuy - smartSell;
  if (fin(buyMs) && fin(swapBeginMs)) F['open_to_buy_duration'] = (buyMs - swapBeginMs) / 60000;
  var launchMs = toMs(L.launch_time);
  if (fin(buyMs) && fin(launchMs)) F['launch_to_buy_duration'] = (buyMs - launchMs) / 60000;
  var deviationPct = Number(ki.avg_price_deviation_pct);
  if (fin(deviationPct)) {
    F['cost_line_distance_pct'] = deviationPct;
    F['above_cost_line'] = deviationPct > 0 ? 1 : 0;
  }`,
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
    id: 'chipShape',
    // 筹码分布形态（data.js 446~475）：从 chip_analysis.price_bars（按市值分70桶的筹码分布）算
    // 筹码峰位置和集中度。跟 above_below_ratio 用的是 chip_analysis 下不同的数组字段，独立成块。
    produces: ['chip_analysis.price_to_peak_ratio', 'chip_analysis.price_concentration_hhi'],
    code: `  // ---- 筹码分布组装字段（data.js 446~475）----
  var priceBars = chip.price_bars;
  if (Array.isArray(priceBars) && priceBars.length) {
    var peakPct = -1, peakMcap = NaN, totalPct = 0;
    for (var pi = 0; pi < priceBars.length; pi++) {
      var bar = priceBars[pi];
      var p = Number(bar && bar.percent);
      if (!fin(p) || p < 0) continue;
      totalPct += p;
      var rng = bar && bar.mcap_range;
      var mid = Array.isArray(rng) && rng.length === 2 ? (Number(rng[0]) + Number(rng[1])) / 2 : NaN;
      if (fin(mid) && p > peakPct) { peakPct = p; peakMcap = mid; }
    }
    var effMcapChip = fin(Number(L.mcap)) ? Number(L.mcap) : (fin(Number(L.current_mcap)) ? Number(L.current_mcap) : Number(L.fdv));
    if (fin(peakMcap) && peakMcap > 0 && fin(effMcapChip)) F['chip_analysis.price_to_peak_ratio'] = effMcapChip / peakMcap;
    if (totalPct > 0) {
      var hhiChip = 0;
      for (var pj = 0; pj < priceBars.length; pj++) {
        var p2 = Number(priceBars[pj] && priceBars[pj].percent);
        if (fin(p2) && p2 > 0) { var share = p2 / totalPct; hhiChip += share * share; }
      }
      F['chip_analysis.price_concentration_hhi'] = hhiChip;
    }
  }`,
  },
  {
    id: 'gmgnTop',
    // gmgn 顶层字段组装（data.js 1370~1400），全部来自 ctx.gmgn 的真实拆分窗口/价格/流动性字段。
    produces: [
      'gmgn_net_buy_vol_ratio_5m', 'gmgn_net_buy_vol_ratio_1h', 'gmgn_buy_sell_count_ratio_1h',
      'gmgn_vol_accel_5m_1h', 'gmgn_liquidity_change_ratio', 'gmgn_supply_circulating_ratio',
      'gmgn_price_to_ath_ratio', 'gmgn_fee_to_liq_ratio',
    ],
    code: `  // ---- gmgn 顶层字段组装（data.js 1370~1400）----
  var gPrice = G.price || {};
  var netBuyVolRatio5m = fin(Number(gPrice.buy_volume_5m)) && fin(Number(gPrice.sell_volume_5m)) && (Number(gPrice.buy_volume_5m) + Number(gPrice.sell_volume_5m) > 0)
    ? Number(gPrice.buy_volume_5m) / (Number(gPrice.buy_volume_5m) + Number(gPrice.sell_volume_5m)) * 100 : undefined;
  if (netBuyVolRatio5m !== undefined) F['gmgn_net_buy_vol_ratio_5m'] = netBuyVolRatio5m;
  var netBuyVolRatio1h = fin(Number(gPrice.buy_volume_1h)) && fin(Number(gPrice.sell_volume_1h)) && (Number(gPrice.buy_volume_1h) + Number(gPrice.sell_volume_1h) > 0)
    ? Number(gPrice.buy_volume_1h) / (Number(gPrice.buy_volume_1h) + Number(gPrice.sell_volume_1h)) * 100 : undefined;
  if (netBuyVolRatio1h !== undefined) F['gmgn_net_buy_vol_ratio_1h'] = netBuyVolRatio1h;
  var buys1h = Number(gPrice.buys_1h), sells1h = Number(gPrice.sells_1h);
  if (fin(buys1h) && fin(sells1h) && sells1h > 0) F['gmgn_buy_sell_count_ratio_1h'] = buys1h / sells1h;
  var vol5m = Number(gPrice.volume_5m), vol1h = Number(gPrice.volume_1h);
  if (fin(vol5m) && fin(vol1h) && vol1h > 0) F['gmgn_vol_accel_5m_1h'] = (vol5m / 5) / (vol1h / 60);
  var gPool = G.pool || {};
  var poolLiq = Number(gPool.liquidity), initLiq = Number(gPool.initial_liquidity);
  if (fin(poolLiq) && fin(initLiq) && initLiq > 0) F['gmgn_liquidity_change_ratio'] = poolLiq / initLiq;
  var circ = Number(G.circulating_supply), totSupplyG = Number(G.total_supply);
  if (fin(circ) && fin(totSupplyG) && totSupplyG > 0) F['gmgn_supply_circulating_ratio'] = circ / totSupplyG;
  var priceNow = Number(gPrice.price), ath = Number(G.ath_price);
  if (fin(priceNow) && fin(ath) && ath > 0) F['gmgn_price_to_ath_ratio'] = priceNow / ath;
  var totFee = Number(G.total_fee), gmgnLiq = Number(G.liquidity);
  if (fin(totFee) && fin(gmgnLiq) && gmgnLiq > 0) F['gmgn_fee_to_liq_ratio'] = totFee / gmgnLiq;`,
  },
  {
    id: 'maxUp',
    // logearn 最大涨幅(max_up)组装（data.js 1402~1409），全部是"开盘到快照时刻为止"的历史值，
    // 不含未来数据。
    produces: ['mcap_to_max_up_ratio', 'max_up_speed_pct_per_min'],
    code: `  // ---- logearn 最大涨幅(max_up)组装（data.js 1402~1409）----
  var effMcapUp = fin(Number(L.mcap)) ? Number(L.mcap) : (fin(Number(L.current_mcap)) ? Number(L.current_mcap) : Number(L.fdv));
  var maxUpMcap = Number(L.max_up_mcap), maxUpRatio = Number(L.max_up_ratio), maxUpDur = Number(L.max_up_duration);
  if (fin(effMcapUp) && fin(maxUpMcap) && maxUpMcap > 0) F['mcap_to_max_up_ratio'] = effMcapUp / maxUpMcap;
  if (fin(maxUpRatio) && fin(maxUpDur) && maxUpDur > 0) F['max_up_speed_pct_per_min'] = maxUpRatio / (maxUpDur / 60);`,
  },
  {
    id: 'lastAlert',
    // 最近一次信号（六大信号类型的最后一条）的最低点是否比上一次更低（data.js 694~701）。
    produces: ['last_alert_low_lower_than_pre_low'],
    code: `  // ---- 最近信号是否创新低（data.js 694~701）----
  var lastAlertLow = L.last_alert && Number(L.last_alert.low_price);
  var lastAlertPreLow = L.last_alert && Number(L.last_alert.pre_low_price);
  if (fin(lastAlertLow) && fin(lastAlertPreLow)) F['last_alert_low_lower_than_pre_low'] = lastAlertLow < lastAlertPreLow ? 1 : 0;`,
  },
  {
    id: 'klineVolumeShape',
    // K线量能形态（data.js 965~1084），全部从 ctx.kline_and_indicators.kline_bars 序列算出，
    // 跟 vBreakout 块一样自成一族（都要先算 measureBarMin 这个共享的"K线粒度"再往下派生），
    // 但两族互不依赖，分开成块。
    produces: [
      'kline_volume_concentration_pct', 'kline_minutes_since_max_volume', 'kline_volume_cv',
      'kline_volume_recent_ratio', 'kline_volume_trend_ratio', 'kline_turnover_pct',
      'kline_max_rise_speed_pct_per_min', 'kline_max_rise_pct', 'kline_bar_minutes', 'kline_max_rise_window_min',
    ],
    code: `  // ---- K线量能形态（data.js 965~1084）----
  var klineBarsKV = Array.isArray(ki.kline_bars) ? ki.kline_bars : [];
  var MIN_KLINE_BARS_FOR_VOLUME = 10;
  var measureBarMinKV = function (bars) {
    if (!Array.isArray(bars) || bars.length < 4) return NaN;
    var times = bars.map(function (b) { return toMs(b && b.time); }).filter(fin).sort(function (a, b) { return a - b; });
    var gaps = [];
    for (var i = 1; i < times.length; i++) { var d = (times[i] - times[i - 1]) / 60000; if (d > 0) gaps.push(d); }
    if (gaps.length < 3) return NaN;
    gaps.sort(function (a, b) { return a - b; });
    return gaps[gaps.length >> 1];
  };
  if (klineBarsKV.length >= MIN_KLINE_BARS_FOR_VOLUME) {
    var volsRawKV = klineBarsKV.map(function (b) { return Number(b && b.volume); });
    var volsKV = volsRawKV.filter(fin);
    var klineIsUsdKV = ki.kline_is_usd;
    if (volsKV.length >= MIN_KLINE_BARS_FOR_VOLUME && klineIsUsdKV !== 0) {
      var totalKV = volsKV.reduce(function (a, b) { return a + b; }, 0);
      var meanKV = totalKV / volsKV.length;
      if (totalKV > 0 && meanKV > 0) {
        var maxVolKV = Math.max.apply(null, volsKV);
        F['kline_volume_concentration_pct'] = maxVolKV / totalKV * 100;
        var mvBarMinKV = measureBarMinKV(klineBarsKV);
        var resSecKV = Number(ki.resolution);
        var barMinMvKV = (fin(mvBarMinKV) && mvBarMinKV > 0) ? mvBarMinKV : ((fin(resSecKV) && resSecKV > 0) ? resSecKV / 60 : NaN);
        if (fin(barMinMvKV) && barMinMvKV > 0) F['kline_minutes_since_max_volume'] = volsRawKV.indexOf(maxVolKV) * barMinMvKV;
        var varianceKV = volsKV.reduce(function (acc, v) { return acc + (v - meanKV) * (v - meanKV); }, 0) / volsKV.length;
        F['kline_volume_cv'] = Math.sqrt(varianceKV) / meanKV;
        var newestVolKV = volsRawKV[0];
        if (fin(newestVolKV)) {
          var restMeanKV = (totalKV - newestVolKV) / (volsKV.length - 1);
          if (restMeanKV > 0) F['kline_volume_recent_ratio'] = newestVolKV / restMeanKV;
        }
        var halfKV = Math.floor(volsKV.length / 2);
        var recentHalfKV = volsKV.slice(0, halfKV).reduce(function (a, b) { return a + b; }, 0) / halfKV;
        var olderHalfKV = volsKV.slice(halfKV).reduce(function (a, b) { return a + b; }, 0) / (volsKV.length - halfKV);
        if (olderHalfKV > 0) F['kline_volume_trend_ratio'] = recentHalfKV / olderHalfKV;
      }
    }
    var chronoKV = klineBarsKV.slice().reverse();
    var gapsKV = [];
    for (var gi2 = 1; gi2 < chronoKV.length; gi2++) {
      var dKV = (toMs(chronoKV[gi2].time) - toMs(chronoKV[gi2 - 1].time)) / 60000;
      if (fin(dKV) && dKV > 0) gapsKV.push(dKV);
    }
    if (gapsKV.length >= 3) {
      var sortedGapsKV = gapsKV.slice().sort(function (a, b) { return a - b; });
      var barMinKV = sortedGapsKV[sortedGapsKV.length >> 1];
      if (barMinKV > 0) {
        F['kline_bar_minutes'] = barMinKV;
        var highsKV = chronoKV.map(function (b) { return Number(b.high); });
        var opensKV = chronoKV.map(function (b) { return Number(b.open); });
        var widthsKV = [];
        var targetMins = [1, 3, 5, 15];
        for (var tmi = 0; tmi < targetMins.length; tmi++) {
          var wKV = Math.max(1, Math.min(chronoKV.length, Math.round(targetMins[tmi] / barMinKV)));
          if (widthsKV.indexOf(wKV) < 0) widthsKV.push(wKV);
        }
        var bestSpeedKV = NaN, bestSpeedWinMinKV = NaN, bestRiseKV = NaN;
        for (var wi2 = 0; wi2 < widthsKV.length; wi2++) {
          var W = widthsKV[wi2];
          var winMinKV = W * barMinKV;
          for (var ii = 0; ii + W <= chronoKV.length; ii++) {
            var base = opensKV[ii];
            if (!fin(base) || base <= 0) continue;
            var peak = -Infinity;
            for (var kk = ii; kk < ii + W; kk++) { if (fin(highsKV[kk]) && highsKV[kk] > peak) peak = highsKV[kk]; }
            if (!fin(peak) || peak <= base) continue;
            var riseKV = (peak - base) / base * 100;
            var speedKV = riseKV / winMinKV;
            if (!fin(bestSpeedKV) || speedKV > bestSpeedKV) { bestSpeedKV = speedKV; bestSpeedWinMinKV = winMinKV; }
            if (!fin(bestRiseKV) || riseKV > bestRiseKV) bestRiseKV = riseKV;
          }
        }
        if (fin(bestSpeedKV)) { F['kline_max_rise_speed_pct_per_min'] = bestSpeedKV; F['kline_max_rise_window_min'] = bestSpeedWinMinKV; }
        if (fin(bestRiseKV)) F['kline_max_rise_pct'] = bestRiseKV;
      }
    }
    var tokenVolsKV = klineBarsKV.map(function (b) { return Number(b && b.token_volume); }).filter(fin);
    var supplyKV = Number(L.total_supply);
    if (tokenVolsKV.length >= MIN_KLINE_BARS_FOR_VOLUME && fin(supplyKV) && supplyKV > 0) {
      F['kline_turnover_pct'] = tokenVolsKV.reduce(function (a, b) { return a + b; }, 0) / supplyKV * 100;
    }
  }`,
  },
  {
    id: 'twitterRename',
    produces: ['gmgn.dev.twitter_name_change_count'],
    code: `  // ---- 创建者推特改名次数（data.js 691~692）----
  if (Array.isArray(dev.twitter_name_change_history)) F['gmgn.dev.twitter_name_change_count'] = dev.twitter_name_change_history.length;`,
  },
  {
    id: 'holderStats',
    // Top100 持有人快照聚合（data.js 1088~1367，A~K 共8个子部分）——全部只依赖 ctx.holders。
    // 各部分共用同一份 H（剔除交易所地址后的真实持有人子集）/ n / ratioOf / hasTag，拆成多个
    // 小块要么重复计算要么互相依赖，索性当一整块（跟 vBreakout 块同一个理由）。逻辑逐行照抄
    // data.js，只做 ES5 语法转换（var + function(){} 而不是箭头/const/let，跟其它块风格一致）。
    produces: [
      'holder_exchange_ratio', 'holder_transfer_in_ratio', 'holder_never_bought_ratio',
      'holder_transfer_amount_ratio', 'holder_bot_ratio', 'holder_bundler_ratio',
      'holder_paper_hands_ratio', 'holder_smart_ratio', 'holder_suspicious_ratio', 'holder_new_ratio',
      'holder_gini', 'holder_hhi', 'holder_in_profit_ratio', 'holder_sold_ratio',
      'holder_entry_concentration', 'holder_same_private_funder_ratio', 'holder_max_private_funder_ratio',
      'holder_same_cex_funder_ratio', 'holder_internal_transfer_ratio', 'holder_same_second_entry_ratio',
      'holder_identical_buy_amount_ratio', 'holder_pnl_median', 'holder_big_winner_ratio',
      'holder_active_seller_ratio', 'holder_realized_loss_ratio', 'holder_avg_cost_cv',
      'holder_sniper_ratio', 'holder_dev_team_ratio', 'holder_kol_ratio', 'holder_fomo_ratio',
      'holder_zero_native_ratio', 'holder_creator_rank',
      'holder_top30_share_pct', 'holder_top30_avg_buy_mcap', 'holder_top30_avg_sell_mcap', 'holder_top30_net_cost_mcap',
      'holder_top50_share_pct', 'holder_top50_avg_buy_mcap', 'holder_top50_avg_sell_mcap', 'holder_top50_net_cost_mcap',
      'holder_native_sol_median', 'holder_native_sol_cv',
    ],
    code: `  // ---- Top100 持有人快照聚合（data.js 1088~1367），全部依赖 ctx.holders ----
  if (holders.length) {
    var nAllH = holders.length;
    var nExchH = holders.filter(function (h) { return Number(h && h.addr_type) === 2; }).length;
    F['holder_exchange_ratio'] = nExchH / nAllH * 100;

    var H = holders.filter(function (h) { return h && Number(h.addr_type) !== 2; });
    var nH = H.length;
    if (nH > 0) {
      var ratioOf = function (pred) { return H.filter(pred).length / nH * 100; };
      var hasTag = function (h, key, set) { return Array.isArray(h[key]) && h[key].some(function (t) { return set.indexOf(String(t)) >= 0; }); };
      var BOT_TAGS = ['sandwich_bot', 'bundler', 'smart_degen'];
      var SMART_TAGS = ['kol', 'smart_degen', 'bluechip_owner'];

      // A. 真实买入 vs 转账接盘
      F['holder_transfer_in_ratio'] = ratioOf(function (h) { return h.transfer_in === true; });
      F['holder_never_bought_ratio'] = ratioOf(function (h) { return Number(h.buy_volume_cur) === 0; });
      var sumBalH = H.reduce(function (a, h) { return a + (Number(h.balance) || 0); }, 0);
      var sumTinH = H.reduce(function (a, h) { return a + (Number(h.current_transfer_in_amount) || 0); }, 0);
      if (sumBalH > 0) F['holder_transfer_amount_ratio'] = sumTinH / sumBalH * 100;

      // B. 钱包画像
      F['holder_bot_ratio'] = ratioOf(function (h) { return hasTag(h, 'tags', BOT_TAGS); });
      F['holder_bundler_ratio'] = ratioOf(function (h) { return hasTag(h, 'maker_token_tags', ['bundler']); });
      F['holder_paper_hands_ratio'] = ratioOf(function (h) { return hasTag(h, 'maker_token_tags', ['paper_hands']); });
      F['holder_smart_ratio'] = ratioOf(function (h) { return hasTag(h, 'tags', SMART_TAGS); });
      F['holder_suspicious_ratio'] = ratioOf(function (h) { return h.is_suspicious === true; });
      F['holder_new_ratio'] = ratioOf(function (h) { return h.is_new === true; });

      // C. 集中度（gini / hhi）
      var sharesH = H.map(function (h) { return Number(h.amount_percentage); }).filter(fin).sort(function (a, b) { return a - b; });
      if (sharesH.length >= 2) {
        var sSumH = sharesH.reduce(function (a, b) { return a + b; }, 0);
        if (sSumH > 0) {
          var cwH = 0;
          for (var gi = 0; gi < sharesH.length; gi++) cwH += (2 * (gi + 1) - sharesH.length - 1) * sharesH[gi];
          F['holder_gini'] = cwH / (sharesH.length * sSumH);
          F['holder_hhi'] = sharesH.reduce(function (a, s) { return a + (s / sSumH) * (s / sSumH); }, 0);
        }
      }

      // D. 盈亏/抛压
      F['holder_in_profit_ratio'] = ratioOf(function (h) { return Number(h.profit) > 0; });
      F['holder_sold_ratio'] = ratioOf(function (h) { return Number(h.sell_amount_percentage) > 0; });

      // E. 入场时间协同（5分钟滑窗）
      var timesH = H.map(function (h) { return Number(h.start_holding_at); }).filter(function (t) { return fin(t) && t > 0; }).sort(function (a, b) { return a - b; });
      if (timesH.length >= 3) {
        var bestH = 1;
        for (var ti = 0, tj = 0; ti < timesH.length; ti++) {
          while (timesH[ti] - timesH[tj] > 300) tj++;
          if (ti - tj + 1 > bestH) bestH = ti - tj + 1;
        }
        F['holder_entry_concentration'] = bestH / timesH.length * 100;
      }

      // F. 协同钱包检测（同源出金分簇 + 持有人间直接互转 + 同秒建仓 + 相同买入量）
      var CEX_NAME_RE = /binance|okx|bybit|coinbase|gate|htx|huobi|mexc|kucoin|bitget|crypto\\.com|kraken|bitfinex|upbit/i;
      var funderOf = function (h) {
        var nt = h && h.native_transfer;
        var addr = nt && typeof nt.from_address === 'string' ? nt.from_address.trim() : '';
        if (!addr) return null;
        return { addr: addr, isCex: CEX_NAME_RE.test(String((nt && nt.name) || '')) };
      };
      var clusterStats = function (pickCex) {
        var byAddr = {};
        for (var ci = 0; ci < H.length; ci++) {
          var fdr = funderOf(H[ci]);
          if (!fdr || fdr.isCex !== pickCex) continue;
          byAddr[fdr.addr] = (byAddr[fdr.addr] || 0) + 1;
        }
        var inCluster = 0, maxCluster = 0;
        for (var kA in byAddr) {
          var cnt2 = byAddr[kA];
          if (cnt2 >= 2) { inCluster += cnt2; if (cnt2 > maxCluster) maxCluster = cnt2; }
        }
        return { inCluster: inCluster / nH * 100, maxCluster: maxCluster / nH * 100 };
      };
      var privClusH = clusterStats(false), cexClusH = clusterStats(true);
      F['holder_same_private_funder_ratio'] = privClusH.inCluster;
      F['holder_max_private_funder_ratio'] = privClusH.maxCluster;
      F['holder_same_cex_funder_ratio'] = cexClusH.inCluster;

      var holderAddrsH = {};
      for (var hi = 0; hi < H.length; hi++) if (H[hi] && H[hi].address) holderAddrsH[H[hi].address] = true;
      var counterpartyHitsHolder = function (h) {
        var keys = ['token_transfer_in', 'token_transfer_out', 'token_transfer'];
        for (var kj = 0; kj < keys.length; kj++) {
          var t = h && h[keys[kj]];
          var addr = t && typeof t.address === 'string' ? t.address.trim() : '';
          if (addr && addr !== h.address && holderAddrsH[addr]) return true;
        }
        return false;
      };
      F['holder_internal_transfer_ratio'] = ratioOf(counterpartyHitsHolder);

      var groupRatio = function (vals) {
        var cnt = {};
        for (var vi = 0; vi < vals.length; vi++) cnt[vals[vi]] = (cnt[vals[vi]] || 0) + 1;
        var dup = 0;
        for (var kC in cnt) if (cnt[kC] >= 2) dup += cnt[kC];
        return dup / nH * 100;
      };
      var entrySecsH = H.map(function (h) { return Number(h.start_holding_at); }).filter(function (t) { return fin(t) && t > 0; });
      if (entrySecsH.length) F['holder_same_second_entry_ratio'] = groupRatio(entrySecsH);
      var buyAmtsH = H.map(function (h) { return Number(h.buy_amount_cur); })
        .filter(function (v) { return fin(v) && v > 0; }).map(function (v) { return String(v); });
      if (buyAmtsH.length) F['holder_identical_buy_amount_ratio'] = groupRatio(buyAmtsH);

      // G. 浮盈压力与抛压
      var pnlsH = H.map(function (h) { return Number(h.unrealized_pnl); }).filter(fin).sort(function (a, b) { return a - b; });
      if (pnlsH.length) {
        var midP = pnlsH.length >> 1;
        F['holder_pnl_median'] = pnlsH.length % 2 ? pnlsH[midP] : (pnlsH[midP - 1] + pnlsH[midP]) / 2;
        F['holder_big_winner_ratio'] = pnlsH.filter(function (v) { return v > 3; }).length / pnlsH.length * 100;
      }
      F['holder_active_seller_ratio'] = ratioOf(function (h) { return Number(h.sell_tx_count_cur) > 0; });
      F['holder_realized_loss_ratio'] = ratioOf(function (h) { return Number(h.realized_profit) < 0; });

      // H. 成本结构（变异系数）
      var costsH = H.map(function (h) { return Number(h.avg_cost); }).filter(function (v) { return fin(v) && v > 0; });
      if (costsH.length >= 3) {
        var cmH = costsH.reduce(function (a, b) { return a + b; }, 0) / costsH.length;
        if (cmH > 0) {
          var cvarH = costsH.reduce(function (a, b) { return a + (b - cmH) * (b - cmH); }, 0) / costsH.length;
          F['holder_avg_cost_cv'] = Math.sqrt(cvarH) / cmH;
        }
      }

      // I. 补充画像
      F['holder_sniper_ratio'] = ratioOf(function (h) { return hasTag(h, 'maker_token_tags', ['sniper']); });
      F['holder_dev_team_ratio'] = ratioOf(function (h) { return hasTag(h, 'maker_token_tags', ['dev_team']); });
      F['holder_kol_ratio'] = ratioOf(function (h) { return hasTag(h, 'tags', ['kol']); });
      F['holder_fomo_ratio'] = ratioOf(function (h) { return hasTag(h, 'tags', ['fomo']); });
      F['holder_zero_native_ratio'] = ratioOf(function (h) {
        var v = Number(h.native_balance);
        return fin(v) && v === 0;
      });
      var creatorIdxH = -1;
      for (var cidx = 0; cidx < H.length; cidx++) if (hasTag(H[cidx], 'maker_token_tags', ['creator'])) { creatorIdxH = cidx; break; }
      if (creatorIdxH >= 0) F['holder_creator_rank'] = creatorIdxH + 1;

      // J. 前 N 大户的买入/卖出/净成本均价（换算成市值口径）
      var supplyGuessesH = H.map(function (h) {
        var b = Number(h.balance), p = Number(h.amount_percentage);
        return (fin(b) && fin(p) && p > 0 && b > 0) ? b / p : NaN;
      }).filter(fin).sort(function (a, b) { return a - b; });
      var supplyH = supplyGuessesH.length ? supplyGuessesH[supplyGuessesH.length >> 1] : NaN;
      if (!(supplyH > 0)) {
        var tsH = Number(L.total_supply);
        if (fin(tsH) && tsH > 0) supplyH = tsH;
      }
      if (supplyH > 0) {
        var rankedH = H.slice().sort(function (x, y) { return (Number(y.balance) || 0) - (Number(x.balance) || 0); });
        var weightedMcapH = function (list, costKey, amtKey) {
          var cost = 0, amt = 0;
          for (var wi = 0; wi < list.length; wi++) {
            var c = Number(list[wi][costKey]), a = Number(list[wi][amtKey]);
            if (fin(c) && fin(a) && a > 0 && c > 0) { cost += c; amt += a; }
          }
          return amt > 0 ? cost / amt * supplyH : NaN;
        };
        var netCostMcapH = function (list) {
          var net = 0, bal = 0;
          for (var ni = 0; ni < list.length; ni++) {
            var h = list[ni];
            var bc = Number(h.history_bought_cost) || 0, bf = Number(h.history_bought_fee) || 0;
            var si = Number(h.history_sold_income) || 0, sf = Number(h.history_sold_fee) || 0;
            var b = Number(h.balance);
            if (!fin(b) || b <= 0) continue;
            net += (bc + bf) - (si - sf);
            bal += b;
          }
          return bal > 0 ? net / bal * supplyH : NaN;
        };
        var topNsH = [30, 50];
        for (var tn = 0; tn < topNsH.length; tn++) {
          var N = topNsH[tn];
          if (rankedH.length < N) continue;
          var topN = rankedH.slice(0, N);
          var topNShare = topN.reduce(function (sum, h) { var p = Number(h.amount_percentage); return sum + (fin(p) ? p : 0); }, 0) * 100;
          F['holder_top' + N + '_share_pct'] = topNShare;
          var buyMcapN = weightedMcapH(topN, 'history_bought_cost', 'buy_amount_cur');
          var sellMcapN = weightedMcapH(topN, 'history_sold_income', 'sell_amount_cur');
          var netMcapN = netCostMcapH(topN);
          if (fin(buyMcapN)) F['holder_top' + N + '_avg_buy_mcap'] = buyMcapN;
          if (fin(sellMcapN)) F['holder_top' + N + '_avg_sell_mcap'] = sellMcapN;
          if (fin(netMcapN)) F['holder_top' + N + '_net_cost_mcap'] = netMcapN;
        }
      }

      // K. 大户 SOL 余额统计
      var CHAIN_NATIVE_DECIMALS_H = { 3: 1e9, 56: 1e18 };
      var nativeDecOverrideH = Number(ctx.native_coin_decimal);
      var nativeDecimalsH = (fin(nativeDecOverrideH) && nativeDecOverrideH > 0) ? nativeDecOverrideH : CHAIN_NATIVE_DECIMALS_H[Number(L.chain)];
      if (fin(nativeDecimalsH) && nativeDecimalsH > 0) {
        var solBalancesH = H.map(function (h) { return Number(h.native_balance) / nativeDecimalsH; })
          .filter(function (v) { return fin(v) && v >= 0; }).sort(function (a, b) { return a - b; });
        if (solBalancesH.length >= 3) {
          var midS = solBalancesH.length >> 1;
          F['holder_native_sol_median'] = solBalancesH.length % 2 ? solBalancesH[midS] : (solBalancesH[midS - 1] + solBalancesH[midS]) / 2;
          var smH = solBalancesH.reduce(function (a, b) { return a + b; }, 0) / solBalancesH.length;
          if (smH > 0) {
            var svarH = solBalancesH.reduce(function (a, b) { return a + (b - smH) * (b - smH); }, 0) / solBalancesH.length;
            F['holder_native_sol_cv'] = Math.sqrt(svarH) / smH;
          }
        }
      }
    }
  }`,
  },
  {
    id: 'vBreakout',
    // V 转信号族（含成本线回溯）—— 深度互相依赖 recentV/measureBarMin，整族当一个块，不再细拆
    produces: [
      'buy_max_retracement',
      'v_breakout_volume_signal_count',
      'v_breakout_volume_record_count',
      'v_breakout_volume_recent_stage_pct',
      'v_breakout_volume_recent_prior_count',
      'v_breakout_volume_recent_retracement_pct',
      'v_breakout_volume_recent_drawdown_min',
      'v_breakout_volume_recent_drawdown_speed_pct_per_min',
      'v_breakout_volume_recent_signal_from_top_min',
      'v_breakout_volume_recent_rebound_from_low_pct',
      'v_breakout_volume_recent_breakout_ratio',
      'v_breakout_volume_recent_signal_from_open_min',
      'v_breakout_volume_recent_low_to_buy_min',
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
    F['v_breakout_volume_record_count'] = breakouts.length;
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
      F['v_breakout_volume_recent_drawdown_min'] = drawdownMin;
      if (drawdownMin > 0 && fin(retr)) F['v_breakout_volume_recent_drawdown_speed_pct_per_min'] = retr * 100 / drawdownMin;
    }
    if (fin(topMs) && fin(sigMs0) && sigMs0 >= topMs) F['v_breakout_volume_recent_signal_from_top_min'] = (sigMs0 - topMs) / 60000;
    var riseRatio = Number(recentV.price_rise_ratio);
    if (fin(riseRatio)) F['v_breakout_volume_recent_rebound_from_low_pct'] = riseRatio * 100;
    var breakoutRatioV = Number(recentV.current_breakout_ratio);
    if (fin(breakoutRatioV)) F['v_breakout_volume_recent_breakout_ratio'] = breakoutRatioV * 100;
    if (fin(sigMs0) && fin(swapBeginMs)) F['v_breakout_volume_recent_signal_from_open_min'] = (sigMs0 - swapBeginMs) / 60000;
    if (fin(buyMs) && fin(lowMs)) F['v_breakout_volume_recent_low_to_buy_min'] = (buyMs - lowMs) / 60000;
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
  {
    id: 'continueBreakout',
    // 早期精选信号族（data.js 756~848），取 signalTime 最新的一条为"生效"信号。
    produces: [
      'continue_breakout_volume_signal_count', 'continue_breakout_volume_recent_notice_mcap',
      'continue_breakout_volume_recent_max_amplitude', 'continue_breakout_volume_recent_amplitude_before_signal_min',
      'continue_breakout_volume_recent_all_bullish', 'continue_breakout_volume_recent_signal_volume',
      'continue_breakout_volume_recent_volume_total', 'continue_breakout_volume_recent_volume_trend_ratio',
      'continue_breakout_volume_recent_bullish_kline_count', 'continue_breakout_volume_recent_signal_from_open_min',
      'continue_breakout_volume_recent_signal_to_buy_min',
    ],
    code: `  // ---- 早期精选信号明细（data.js 756~848）----
  var picks = L.continue_breakout_volume_list || [];
  if (Array.isArray(picks)) F['continue_breakout_volume_signal_count'] = picks.length;
  if (Array.isArray(picks) && picks.length) {
    var recentPick = null;
    for (var pk = 0; pk < picks.length; pk++) {
      var evP = picks[pk];
      if (!evP) continue;
      if (!recentPick || (evP.signalTime || 0) > (recentPick.signalTime || 0)) recentPick = evP;
    }
    if (recentPick) {
      var noticeMcapP = Number(recentPick.notice_mcap);
      if (fin(noticeMcapP)) F['continue_breakout_volume_recent_notice_mcap'] = noticeMcapP;
      var ampP = Number(recentPick.max_amplitude);
      if (fin(ampP)) F['continue_breakout_volume_recent_max_amplitude'] = ampP;
      var ampSecP = Number(recentPick.max_amplitude_time), pickSecP = Number(recentPick.signalTime);
      if (fin(ampSecP) && fin(pickSecP) && pickSecP >= ampSecP) F['continue_breakout_volume_recent_amplitude_before_signal_min'] = (pickSecP - ampSecP) / 60;
      if (typeof recentPick.all_bullish === 'boolean') F['continue_breakout_volume_recent_all_bullish'] = recentPick.all_bullish ? 1 : 0;
      var v1P = Number(recentPick.volume1), v2P = Number(recentPick.volume2), v3P = Number(recentPick.volume3);
      var coinPriceP = Number(ctx.native_coin_price);
      if (fin(coinPriceP) && coinPriceP > 0) {
        if (fin(v3P)) F['continue_breakout_volume_recent_signal_volume'] = v3P * coinPriceP;
        if (fin(v1P) && fin(v2P) && fin(v3P)) F['continue_breakout_volume_recent_volume_total'] = (v1P + v2P + v3P) * coinPriceP;
      }
      if (fin(v1P) && v1P > 0 && fin(v3P)) F['continue_breakout_volume_recent_volume_trend_ratio'] = v3P / v1P;
      var bullishCountP = 0, bullishKnownP = false;
      var bkKeys = ['kline1_bullish', 'kline2_bullish', 'kline3_bullish'];
      for (var bk = 0; bk < bkKeys.length; bk++) { if (typeof recentPick[bkKeys[bk]] === 'boolean') { bullishKnownP = true; if (recentPick[bkKeys[bk]]) bullishCountP++; } }
      if (bullishKnownP) F['continue_breakout_volume_recent_bullish_kline_count'] = bullishCountP;
      var pickMsP = toMs(pickSecP);
      if (fin(pickMsP) && fin(swapBeginMs)) F['continue_breakout_volume_recent_signal_from_open_min'] = (pickMsP - swapBeginMs) / 60000;
      if (fin(buyMs) && fin(pickMsP)) F['continue_breakout_volume_recent_signal_to_buy_min'] = (buyMs - pickMsP) / 60000;
    }
  }`,
  },
  {
    id: 'breakout10x',
    // 休眠苏醒信号族（data.js 850~930），取 signalTime 最新的一条为"生效"信号。
    produces: [
      'breakout_volume_10x_signal_count', 'breakout_volume_10x_recent_notice_mcap',
      'breakout_volume_10x_recent_volume_ratio', 'breakout_volume_10x_recent_dormant_duration_min',
      'breakout_volume_10x_recent_dormant_kline_count', 'breakout_volume_10x_recent_dormant_cv',
      'breakout_volume_10x_recent_dormant_slope', 'breakout_volume_10x_recent_dormant_end_to_signal_min',
      'breakout_volume_10x_recent_kline_bullish', 'breakout_volume_10x_recent_kline_change_pct',
      'breakout_volume_10x_recent_drawdown_from_high_pct', 'breakout_volume_10x_recent_signal_from_open_min',
      'breakout_volume_10x_recent_signal_to_buy_min',
    ],
    code: `  // ---- 休眠苏醒信号明细（data.js 850~930）----
  var wakes = L.breakout_volume_10x_list || [];
  if (Array.isArray(wakes)) F['breakout_volume_10x_signal_count'] = wakes.length;
  if (Array.isArray(wakes) && wakes.length) {
    var recentWake = null;
    for (var wk = 0; wk < wakes.length; wk++) {
      var evW = wakes[wk];
      if (!evW) continue;
      if (!recentWake || (evW.signalTime || 0) > (recentWake.signalTime || 0)) recentWake = evW;
    }
    if (recentWake) {
      var noticeMcapW = Number(recentWake.notice_mcap);
      if (fin(noticeMcapW)) F['breakout_volume_10x_recent_notice_mcap'] = noticeMcapW;
      var volRatioW = Number(recentWake.volume_ratio);
      if (fin(volRatioW)) F['breakout_volume_10x_recent_volume_ratio'] = volRatioW;
      var hStartW = Number(recentWake.history_start_time), hEndW = Number(recentWake.history_end_time);
      if (fin(hStartW) && fin(hEndW) && hEndW >= hStartW) F['breakout_volume_10x_recent_dormant_duration_min'] = (hEndW - hStartW) / 60;
      var klineCountW = Number(recentWake.history_kline_count);
      if (fin(klineCountW)) F['breakout_volume_10x_recent_dormant_kline_count'] = klineCountW;
      var cvW = Number(recentWake.cv);
      if (fin(cvW)) F['breakout_volume_10x_recent_dormant_cv'] = cvW;
      var slopeW = Number(recentWake.standardized_slope);
      if (fin(slopeW)) F['breakout_volume_10x_recent_dormant_slope'] = slopeW;
      var wakeSecW = Number(recentWake.signalTime);
      if (fin(hEndW) && fin(wakeSecW) && wakeSecW >= hEndW) F['breakout_volume_10x_recent_dormant_end_to_signal_min'] = (wakeSecW - hEndW) / 60;
      if (typeof recentWake.current_bullish === 'boolean') F['breakout_volume_10x_recent_kline_bullish'] = recentWake.current_bullish ? 1 : 0;
      var openPW = Number(recentWake.current_open_price), closePW = Number(recentWake.current_close_price);
      if (fin(openPW) && openPW > 0 && fin(closePW)) F['breakout_volume_10x_recent_kline_change_pct'] = (closePW - openPW) / openPW * 100;
      var maxUpMcapW = Number(recentWake.max_up_mcap);
      if (fin(maxUpMcapW) && maxUpMcapW > 0 && fin(noticeMcapW)) F['breakout_volume_10x_recent_drawdown_from_high_pct'] = (maxUpMcapW - noticeMcapW) / maxUpMcapW * 100;
      var wakeMsW = toMs(wakeSecW);
      if (fin(wakeMsW) && fin(swapBeginMs)) F['breakout_volume_10x_recent_signal_from_open_min'] = (wakeMsW - swapBeginMs) / 60000;
      if (fin(buyMs) && fin(wakeMsW)) F['breakout_volume_10x_recent_signal_to_buy_min'] = (buyMs - wakeMsW) / 60000;
    }
  }`,
  },
  {
    id: 'whale',
    // 蓝筹顶级赢家共振信号（data.js 932~963），取 signalTime 最新的一条为"生效"信号。
    produces: [
      'whale_signal_count', 'whale_recent_wallet_count', 'whale_recent_tx_count', 'whale_recent_tx_per_wallet',
      'whale_recent_past_minute', 'whale_recent_notice_mcap', 'whale_recent_signal_from_open_min',
      'whale_recent_signal_to_buy_min',
    ],
    code: `  // ---- 蓝筹顶级赢家共振信号（data.js 932~963）----
  var whales = L.whale_list || [];
  if (Array.isArray(whales)) F['whale_signal_count'] = whales.length;
  if (Array.isArray(whales) && whales.length) {
    var recentWhale = null;
    for (var wl = 0; wl < whales.length; wl++) {
      var evWh = whales[wl];
      if (!evWh) continue;
      if (!recentWhale || (evWh.signalTime || 0) > (recentWhale.signalTime || 0)) recentWhale = evWh;
    }
    if (recentWhale) {
      var wc = Number(recentWhale.whaleWalletCount);
      if (fin(wc)) F['whale_recent_wallet_count'] = wc;
      var tc = Number(recentWhale.whaleTxCount);
      if (fin(tc)) F['whale_recent_tx_count'] = tc;
      if (fin(wc) && wc > 0 && fin(tc)) F['whale_recent_tx_per_wallet'] = tc / wc;
      var pm = Number(recentWhale.pastMinute);
      if (fin(pm)) F['whale_recent_past_minute'] = pm;
      var nm = Number(recentWhale.notice_mcap);
      if (fin(nm)) F['whale_recent_notice_mcap'] = nm;
      var wSec = Number(recentWhale.signalTime), wMs = toMs(wSec);
      if (fin(wMs) && fin(swapBeginMs)) F['whale_recent_signal_from_open_min'] = (wMs - swapBeginMs) / 60000;
      if (fin(buyMs) && fin(wMs)) F['whale_recent_signal_to_buy_min'] = (buyMs - wMs) / 60000;
    }
  }`,
  },
  {
    id: 'signalTiming',
    // 六大信号跨类型时序（data.js 1411~1474）：合并 v_breakout_volume/continue_breakout_volume/
    // breakout_volume_10x/whale/followed/smart_money 六个 list，只读 signalTime，按时间排序统计。
    produces: ['signal_total_count', 'signal_type_count', 'signal_span_min', 'signal_first_to_buy_min'],
    code: `  // ---- 信号时序（data.js 1411~1474）----
  var SIGNAL_LIST_KEYS = [
    'v_breakout_volume_list', 'continue_breakout_volume_list', 'breakout_volume_10x_list',
    'whale_list', 'followed_list', 'smart_money_list',
  ];
  var signalEvents = [];
  var anySignalListPresent = false;
  for (var sl = 0; sl < SIGNAL_LIST_KEYS.length; sl++) {
    var list = L[SIGNAL_LIST_KEYS[sl]];
    if (!Array.isArray(list)) continue;
    anySignalListPresent = true;
    for (var le = 0; le < list.length; le++) {
      var evS = list[le];
      var tS = Number(evS && evS.signalTime);
      if (!fin(tS)) continue;
      var tMsS = toMs(tS);
      if (fin(buyMs) && tMsS > buyMs) continue;
      signalEvents.push({ type: SIGNAL_LIST_KEYS[sl], t: tMsS });
    }
  }
  if (anySignalListPresent) {
    signalEvents.sort(function (a, b) { return a.t - b.t; });
    F['signal_total_count'] = signalEvents.length;
    var distinctTypes = {};
    for (var se = 0; se < signalEvents.length; se++) distinctTypes[signalEvents[se].type] = 1;
    var distinctCount = 0;
    for (var dtKey in distinctTypes) distinctCount++;
    F['signal_type_count'] = distinctCount;
    if (signalEvents.length) {
      var firstT = signalEvents[0].t, lastT = signalEvents[signalEvents.length - 1].t;
      F['signal_span_min'] = (lastT - firstT) / 60000;
      if (fin(buyMs)) F['signal_first_to_buy_min'] = (buyMs - firstT) / 60000;
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

// 剔除注释的扫描器已抽到 src/lib/stripComments.js 共用（策略规范 lint 也要用同一份，
// 而且它原来压根没剥注释导致误报；顺带修了"不认正则字面量"这个真实缺陷，见该文件头注释）。
// 只对提取用的临时副本做，不影响产出代码。

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
//         | 'missing_review' 线上有值但 review 缺失（见下）| 'nonnumeric' review 是非数值
//         （地址/平台名等，native 只给数值，无法复现，仅提示）
function compareValue(online, review) {
  const miss = x => x == null || (typeof x === 'number' && !Number.isFinite(x));
  const oMiss = miss(online), rMiss = miss(review);
  // 【2026-07-29】原来这里是 `if (rMiss) return { status: 'ok' }` —— 只要 review 侧算不出值，
  // 无论线上算出什么都判"一致"，这条方向的偏差 100% 漏检。而它是有实际代价的：
  // 线上派生块在某个 ctx 上算出了 review 的 buildRows 不会产生的值（比如两边的门槛没对齐，
  // review 因 MIN_KLINE_BARS_FOR_VOLUME 这类下限跳过了、线上的内联块没跳），
  // 那么因子的满分区间若覆盖到这个值，线上给分、回测记 0 分 —— 同一个 cutoff 在两边含义就不同了，
  // 而这套自检存在的全部理由就是防这个。
  // 单列一个状态而不是并进 mismatch：两边都缺才是真正的"一致"，只有线上多出值才值得看一眼，
  // 且它不该让整份自检报告变红（review 缺失的原因往往是这条样本本来就没这个字段）。
  if (rMiss) return { status: oMiss ? 'ok' : 'missing_review', rel: 0, online, review };
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
  // missingReview：线上算出值、review 侧缺失的样本数。单独计数，不并进 mismatches
  // （见 compareValue 里的说明：它是提示，不是"两边算错了"）。
  for (const field of usedFields) stat.set(field, { field, kind: kindOf(field), checked: 0, mismatches: 0, missingReview: 0, maxRel: 0, status: 'ok', sample: null });

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
      } else if (cmp.status === 'missing_review') {
        s.missingReview++;
        // 只在还是 'ok' 时抬成 missing_review：真问题（mismatch/missing_online/nonnumeric）优先级更高，不能被盖掉
        if (s.status === 'ok') {
          s.status = 'missing_review';
          if (!s.sample) s.sample = { tokenAddress: row.tokenAddress, online: cmp.online, review: cmp.review, rel: NaN };
        }
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
