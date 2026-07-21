// 1.5段策略 v31
// 【依赖 kline_and_indicators 与 chip_analysis 与 gmgn，单币深度分析场景，非实时流批量场景】
//
// 本版改动（相对 v30）：
// 新钱包持仓（已扣关注地址）改为区间限制：>10 且 <60（原<70）。
// 新增"老钱包持仓"限制：ctx.logearn.old_volume，>20 且 <70。
// 新增"垃圾盘"阈值收紧：ctx.logearn.shit_volume < 5（原<7）。
// 新增"高频交易者持仓"限制：ctx.logearn.frequent_volume > 10。
// 新增"总持仓占比"限制：ctx.chip_analysis.total_holding_percent > 60。
// 新增"top5持仓合计"限制：sum(chip_analysis.top5_holders[*].total_hold_percent) > 5（不排除关注地址，口径同组装字段 chip_analysis.top5_hold_percent）。
// 新增"top5转入占比"限制：sum(transfer_in_percent)/sum(total_hold_percent)*100，>5 且 <50（口径同组装字段 chip_analysis.top5_transfer_in_ratio）。
// 新增"bot_degen_rate"限制：gmgn.stat.bot_degen_rate（原始0-1小数×100转%），>30 且 <65。
// 新增"上线到买入时长"限制：(当前时间-launch_time)/60（分钟）< 500。
//
// v30改动（相对 v29）：
// 新增"前10持有占比"限制：gmgn.stat.top_10_holder_rate（原始0-1小数×100转%）< 30。
// 新增"创建者持仓"限制：gmgn.stat.creator_hold_rate（原始0-1小数×100转%）< 0.5。
// 新增"top_rat_trader占比"限制：gmgn.stat.top_rat_trader_percentage（原始0-1小数×100转%）< 1。
// 新增"dev团队持仓"限制：gmgn.stat.dev_team_hold_rate（原始0-1小数×100转%）< 1。
//
// v29改动（相对 v28）：
// 新增"筹码限制"：chip_analysis.below_percent（当前价下方筹码占比）> above_percent（上方筹码占比）。
//
// v28改动（相对 v27）：
// 恢复并新增"新钱包持仓（扣除我关注地址持仓占比后）< 70"限制。
// 关注地址持仓占比 = sum(walletPositionMap[*].token_balance)/total_supply*100（占总发行量%），
// 用 new_volume 减去它再判 < 70。

try {
  const nowSec = Math.floor(Date.now() / 1000)
  const RETRACE_TOLERANCE = 0.10
  const HOLD_LIMIT = 10
  const TRANSFER_LIMIT = 10
  const MIN_V_DURATION = 120 // V转回撤持续时间下限（秒）= 2分钟
  const MCAP_LIMIT = 120000  // 买入市值上限（USD）
  const NEW_MIN = 10         // 新钱包持仓下限（%，已扣关注地址）
  const NEW_MAX = 60         // 新钱包持仓上限（%，已扣关注地址）
  const OLD_MIN = 20         // 老钱包持仓下限（%）
  const OLD_MAX = 70         // 老钱包持仓上限（%）
  const SHIT_LIMIT = 5       // 垃圾钱包持仓上限（%）
  const FREQUENT_MIN = 10    // 高频交易者持仓下限（%）
  const TOTAL_HOLDING_LIMIT = 60 // chip_analysis.total_holding_percent 下限（%）
  const TOP5_HOLD_LIMIT = 5  // chip_analysis top5持仓合计 下限（%）
  const TOP5_TRANSFER_MIN = 5   // top5转入占比 下限（%）
  const TOP5_TRANSFER_MAX = 50  // top5转入占比 上限（%）
  const BOT_DEGEN_MIN = 30   // gmgn.stat.bot_degen_rate 下限（%）
  const BOT_DEGEN_MAX = 65   // gmgn.stat.bot_degen_rate 上限（%）
  const LAUNCH_TO_BUY_LIMIT = 500 // launch_to_buy_duration 上限（分钟）
  const TOP10_HOLDER_RATE_LIMIT = 30 // gmgn.stat.top_10_holder_rate 上限（%）
  const CREATOR_HOLD_RATE_LIMIT = 0.5  // gmgn.stat.creator_hold_rate 上限（%）
  const TOP_RAT_TRADER_PERCENTAGE_LIMIT = 1  // gmgn.stat.top_rat_trader_percentage 上限（%）
  const DEV_TEAM_HOLD_RATE_LIMIT = 1  // gmgn.stat.dev_team_hold_rate 上限（%）

  const hasChip = !!ctx.chip_analysis
  const hasKline = !!ctx.kline_and_indicators && Array.isArray(ctx.kline_and_indicators.avg_price_bars)
  const hasGmgn = !!ctx.gmgn && !!ctx.gmgn.stat
  if (!hasChip || !hasKline || !hasGmgn) {
    ctx.log.error(`数据源未就绪 chip(${hasChip}) kline(${hasKline}) gmgn(${hasGmgn})`)
    return false
  }

  const launchTime = ctx.logearn?.launch_time || 0
  const graduated = launchTime > 0

  const PUMP_PLATFORMS = ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA']
  const FOUR_PLATFORMS = ['four.meme', 'binance_four.meme']
  const platform = ctx.logearn?.platform
  const isPump = PUMP_PLATFORMS.includes(platform) && !ctx.logearn?.is_fake_pump
  const isFour = FOUR_PLATFORMS.includes(platform) && !ctx.logearn?.is_fake_four
  const isTargetPlatform = isPump || isFour

  const swapBeginTime = ctx.logearn?.swap_begin_time || 0
  const ageSec = swapBeginTime > 0 ? (nowSec - swapBeginTime) : Infinity
  const ageHour = ageSec / 3600
  const withinWindow = swapBeginTime > 0 && ageSec <= 15 * 3600

  const mcap = ctx.logearn?.mcap || 0
  const mcapOk = mcap > 0 && mcap < MCAP_LIMIT

  const innerSellRatio = ctx.chip_analysis?.inner_sell_ratio || 0
  const innerSellOk = innerSellRatio >= 60

  const CHIP_BUFFER = 2 // 筹码下大于上的容忍buff（%）
  const abovePercent = ctx.chip_analysis?.above_percent || 0
  const belowPercent = ctx.chip_analysis?.below_percent || 0
  const chipBelowAboveOk = belowPercent + CHIP_BUFFER > abovePercent

  const avgPriceDeviationPct = ctx.kline_and_indicators?.avg_price_deviation_pct ?? -999
  const deviationOk = avgPriceDeviationPct > 0

  const shitVolume = ctx.logearn?.shit_volume ?? 999
  const shitOk = shitVolume < SHIT_LIMIT

  const oldVolume = ctx.logearn?.old_volume ?? -1
  const oldOk = oldVolume > OLD_MIN && oldVolume < OLD_MAX

  const frequentVolume = ctx.logearn?.frequent_volume ?? -1
  const frequentOk = frequentVolume > FREQUENT_MIN

  const totalHoldingPercent = ctx.chip_analysis?.total_holding_percent ?? -1
  const totalHoldingOk = totalHoldingPercent > TOTAL_HOLDING_LIMIT

  const launchToBuyDurationMin = launchTime > 0 ? (nowSec - launchTime) / 60 : Infinity
  const launchToBuyOk = launchToBuyDurationMin < LAUNCH_TO_BUY_LIMIT

  const gmgnStat = ctx.gmgn?.stat || {}
  const top10HolderRatePct = (gmgnStat.top_10_holder_rate ?? 0) * 100
  const top10HolderRateOk = top10HolderRatePct < TOP10_HOLDER_RATE_LIMIT
  const creatorHoldRatePct = (gmgnStat.creator_hold_rate ?? 0) * 100
  const creatorHoldRateOk = creatorHoldRatePct < CREATOR_HOLD_RATE_LIMIT
  const topRatTraderPercentagePct = (gmgnStat.top_rat_trader_percentage ?? 0) * 100
  const topRatTraderPercentageOk = topRatTraderPercentagePct < TOP_RAT_TRADER_PERCENTAGE_LIMIT
  const devTeamHoldRatePct = (gmgnStat.dev_team_hold_rate ?? 0) * 100
  const devTeamHoldRateOk = devTeamHoldRatePct < DEV_TEAM_HOLD_RATE_LIMIT
  const botDegenRatePct = (gmgnStat.bot_degen_rate ?? 0) * 100
  const botDegenRateOk = botDegenRatePct > BOT_DEGEN_MIN && botDegenRatePct < BOT_DEGEN_MAX

  // 关注地址集合 + 关注地址持仓占比
  const followedSet = new Set()
  const wpm = ctx.logearn?.followed_signal_state?.walletPositionMap || {}
  let followedBalanceSum = 0
  for (const k of Object.keys(wpm)) {
    if (k) followedSet.add(k.toLowerCase())
    followedBalanceSum += wpm[k]?.token_balance || 0
  }
  for (const f of (ctx.logearn?.followed_list || [])) { if (f?.wallet) followedSet.add(f.wallet.toLowerCase()) }
  const totalSupply = ctx.logearn?.total_supply || 0
  const followedHoldPercent = totalSupply > 0 ? (followedBalanceSum / totalSupply * 100) : 0

  // 新钱包持仓（扣关注）
  const newVolumeRaw = ctx.logearn?.new_volume ?? -999
  const newVolumeAdj = newVolumeRaw - followedHoldPercent
  const newOk = newVolumeAdj > NEW_MIN && newVolumeAdj < NEW_MAX

  const top5 = ctx.chip_analysis?.top5_holders || []
  let maxHold = 0, maxTransferIn = 0
  for (const h of top5) {
    const w = (h?.wallet || '').toLowerCase()
    if (w && followedSet.has(w)) continue
    maxHold = Math.max(maxHold, h?.total_hold_percent || 0)
    maxTransferIn = Math.max(maxTransferIn, h?.transfer_in_percent || 0)
  }
  const holdOk = maxHold < HOLD_LIMIT
  const transferOk = maxTransferIn < TRANSFER_LIMIT

  // chip_analysis.top5_hold_percent / top5_transfer_in_ratio（组装字段口径，不排除关注地址）
  let top5HoldSum = 0, top5TransferSum = 0
  for (const h of top5) {
    top5HoldSum += h?.total_hold_percent || 0
    top5TransferSum += h?.transfer_in_percent || 0
  }
  const top5HoldPercent = top5HoldSum
  const top5HoldPercentOk = top5HoldPercent > TOP5_HOLD_LIMIT
  const top5TransferInRatio = top5HoldSum > 0 ? (top5TransferSum / top5HoldSum * 100) : 0
  const top5TransferInRatioOk = top5TransferInRatio > TOP5_TRANSFER_MIN && top5TransferInRatio < TOP5_TRANSFER_MAX

  function toSec(t) { const n = Number(t) || 0; return n > 1e12 ? Math.floor(n / 1000) : n }
  const avgPriceBars = (ctx.kline_and_indicators?.avg_price_bars || []).map(b => ({ ...b, time: toSec(b.time) }))
  const oldestBarTime = avgPriceBars.length ? avgPriceBars[avgPriceBars.length - 1].time : Infinity
  const currentAvgPrice = ctx.kline_and_indicators?.current_avg_price || 0
  const vList = ctx.logearn?.v_breakout_volume_list || []
  const currentPriceUsd = ctx.kline_and_indicators?.current_price || 0
  const mcapPerUsdPrice = currentPriceUsd > 0 ? (mcap / currentPriceUsd) : 0

  function findAvgPriceAtTime(t) {
    for (let i = 0; i < avgPriceBars.length; i++) {
      if (avgPriceBars[i].time <= t) return { value: avgPriceBars[i].value, approx: false }
    }
    if (t < oldestBarTime && currentAvgPrice > 0) return { value: currentAvgPrice, approx: true }
    return { value: null, approx: false }
  }
  function vFinished(v) { return (v?.fibon_break4 > 0) || (v?.fibon_break4_time != null && v.fibon_break4_time !== 0) }

  let recentV = null
  for (const v of vList) {
    if (v?.n_pattern_confirmed !== true) continue
    if (vFinished(v)) continue
    if (!recentV || (v.signalTime || 0) > (recentV.signalTime || 0)) recentV = v
  }
  const hasEffectiveV = !!recentV

  let vDurationSec = 0
  let vDurationOk = false
  if (hasEffectiveV) {
    const topT = toSec(recentV.top_price_time)
    const lowT = toSec(recentV.low_price_time)
    vDurationSec = (topT > 0 && lowT > 0) ? (lowT - topT) : 0
    vDurationOk = vDurationSec > MIN_V_DURATION
  }

  let vStageLabel = 'none'
  let vStageDetail = 'none'
  if (hasEffectiveV) {
    const reached = (val, t) => (Number(val) > 0) || (t != null && Number(t) > 0)
    const stages = [
      ['反弹20%', reached(recentV.fibon_break1, recentV.fibon_break1_time), recentV.fibon_break1_time],
      ['反弹40%', reached(recentV.fibon_break2, recentV.fibon_break2_time), recentV.fibon_break2_time],
      ['反弹60%', reached(recentV.fibon_break3, recentV.fibon_break3_time), recentV.fibon_break3_time],
      ['反弹新高', reached(recentV.fibon_break4, recentV.fibon_break4_time), recentV.fibon_break4_time],
    ]
    for (const [name, ok] of stages) { if (ok) vStageLabel = name }
    if (vStageLabel === 'none') vStageLabel = '未反弹(仅回撤确认)'
    vStageDetail = stages.map(([name, ok, t]) => `${name}:${ok ? '✓' : '✗'}${ok && t ? '@' + toSec(t) : ''}`).join(' ')
  }

  let retraceBreakOk = false
  let retraceInfo = 'none'
  if (hasEffectiveV && recentV.low_price_mcap && recentV.low_price_time && mcapPerUsdPrice > 0) {
    const r = findAvgPriceAtTime(toSec(recentV.low_price_time))
    const avgAtLow = r.value
    if (avgAtLow != null && avgAtLow > 0) {
      const avgMcapAtLow = avgAtLow * mcapPerUsdPrice
      const threshold = avgMcapAtLow * (1 + RETRACE_TOLERANCE)
      const gapPct = ((recentV.low_price_mcap - avgMcapAtLow) / avgMcapAtLow * 100)
      retraceBreakOk = recentV.low_price_mcap < threshold
      retraceInfo = `low=${recentV.low_price_mcap.toFixed(0)}/avg=${avgMcapAtLow.toFixed(0)}(${gapPct.toFixed(1)}%)${r.approx ? '(近似:当前成本线)' : ''}`
    } else {
      retraceInfo = 'avgAtLow无效'
    }
  }

  const platformLabel = isPump ? 'Pump' : (isFour ? 'four' : (platform || 'unknown'))
  const checks = [
    ['毕业', graduated, launchTime, '>0'],
    ['平台', isTargetPlatform, platformLabel, 'Pump/four'],
    //['时长h', withinWindow, ageHour === Infinity ? 'NA' : ageHour.toFixed(1), '<=15'],
    ['市值', mcapOk, mcap.toFixed(0), '<120k'],
    ['内盘卖出', innerSellOk, innerSellRatio, '>=60'],
    ['筹码下大于上', chipBelowAboveOk, `below=${belowPercent.toFixed(1)}/above=${abovePercent.toFixed(1)}`, '下>上'],
    ['成本线上', deviationOk, avgPriceDeviationPct, '>0'],
    ['垃圾盘', shitOk, shitVolume, '<5'],
    ['老钱包', oldOk, oldVolume, '>20且<70'],
    ['高频交易者', frequentOk, frequentVolume, '>10'],
    ['总持仓占比', totalHoldingOk, totalHoldingPercent.toFixed(1), '>60'],
    ['上线到买入时长min', launchToBuyOk, launchToBuyDurationMin === Infinity ? 'NA' : launchToBuyDurationMin.toFixed(1), '<500'],
    ['前10持有占比', top10HolderRateOk, top10HolderRatePct.toFixed(1), '<30'],
    ['创建者持仓', creatorHoldRateOk, creatorHoldRatePct.toFixed(2), '<1'],
    ['top_rat_trader占比', topRatTraderPercentageOk, topRatTraderPercentagePct.toFixed(2), '<1'],
    ['dev团队持仓', devTeamHoldRateOk, devTeamHoldRatePct.toFixed(2), '<1'],
    ['bot_degen_rate', botDegenRateOk, botDegenRatePct.toFixed(1), '>30且<65'],
    ['新钱包', newOk, `${newVolumeAdj.toFixed(1)}(原${newVolumeRaw}-关注${followedHoldPercent.toFixed(1)})`, '>10且<60'],
    ['单地址持仓', holdOk, maxHold.toFixed(1), '<10'],
    ['单地址转账', transferOk, maxTransferIn.toFixed(1), '<10'],
    ['top5持仓合计', top5HoldPercentOk, top5HoldPercent.toFixed(1), '>5'],
    ['top5转入占比', top5TransferInRatioOk, top5TransferInRatio.toFixed(1), '>5且<50'],
    ['有效V转', hasEffectiveV, hasEffectiveV ? 'y' : 'n', 'confirmed&未收尾'],
    ['V转持续min', vDurationOk, hasEffectiveV ? (vDurationSec / 60).toFixed(1) : 'NA', '>2'],
    ['V转路径', retraceBreakOk, retraceInfo, '低点<成本*1.1'],
  ]
  const passed = checks.every(c => c[1])
  if (!passed) {
    const fails = checks.filter(c => !c[1]).map(([n, , a, e]) => `${n}=${a}[${e}]`).join(' | ')
    ctx.log.error(`未命中 ${fails}${hasEffectiveV ? ' | V转阶段=' + vStageLabel : ''}`)
    return false
  }

  // ===== 下单时刻留痕（用于和实际成交价格对比）=====
  const orderTimeSec = nowSec
  const orderTimeStr = new Date(nowSec * 1000).toISOString()
  const orderMcap = mcap
  const orderPriceUsd = currentPriceUsd
  ctx.log.success(`命中<1.5段> [下单快照] 时间=${orderTimeStr}(${orderTimeSec}) 市值=$${orderMcap.toFixed(0)} 价格=$${orderPriceUsd} | V转阶段=${vStageLabel} [${vStageDetail}] | ${retraceInfo} 持续${(vDurationSec / 60).toFixed(1)}min 持仓${maxHold.toFixed(1)} 卖出${innerSellRatio} 偏离${avgPriceDeviationPct}`)
  return true
} catch (e) {
  ctx.log.error('策略异常: ' + (e && e.message ? e.message : String(e)))
  return false
}