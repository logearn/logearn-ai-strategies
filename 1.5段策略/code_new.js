// 1.5段策略 v41（在 v40 基础上按我的风格微调）
// 【依赖 kline_and_indicators 与 chip_analysis 与 holders 与 inner_chip_analysis，单币深度分析场景，非实时流批量场景】
//
// v41 改动（相对 v40）：
// 1. 把 inner_chip_analysis 整体上提到最顶部声明区：与 chip/kline/holders 一起做数据源就绪判断（hasInnerChip），
//    并把捆绑簇净买入占比 bundleBuyPct/bundleOverLimit 提到顶部一次性取好，下方只做与 V转回撤的联动判断。
// 2. 逻辑口径与 v40 完全一致（RETRACE_TOLERANCE=0.20，捆绑>70% 时 V转回撤需>60%）。

try {
  const nowSec = Math.floor(Date.now() / 1000)
  const RETRACE_TOLERANCE = 0.20
  const HOLD_LIMIT = 10
  const TRANSFER_LIMIT = 10
  const MIN_V_DURATION = 120 // V转回撤持续时间下限（秒）= 2分钟
  const MCAP_LIMIT = 120000  // 买入市值上限（USD）
  const NEW_LIMIT = 70       // 新钱包持仓上限（%，已扣关注地址）
  const GOOD_PCT_LIMIT = 10    // holders.stats.quality.good_pct 下限（%）
  const RETAIL_PCT_LIMIT = 20  // holders.distribution.push.retail.pct 上限（%）
  const DEV_HOLD_PCT_LIMIT = 10 // holders.distribution.risk.dev.pct 上限（%）
  const BUNDLE_BUY_PCT_LIMIT = 70   // 内盘捆绑簇净买入占比门槛（%），超过则加严 V转回撤要求
  const BUNDLE_RETRACE_MIN = 0.6    // 捆绑超门槛时，V转回撤幅度(n_pattern_retracement, 0-1)下限

  // ===== 数据源就绪判断（统一放最顶部）=====
  const hasChip = !!ctx.chip_analysis
  const hasKline = !!ctx.kline_and_indicators && Array.isArray(ctx.kline_and_indicators.avg_price_bars)
  const hasHolders = !!ctx.holders
  const hasInnerChip = !!ctx.inner_chip_analysis // 未毕业(launch_time=0)时整体为 null

  if (!hasChip || !hasKline || !hasHolders) {
    ctx.log.error(`数据源未就绪 chip(${hasChip}) kline(${hasKline}) holders(${hasHolders}) innerChip(${hasInnerChip})`)
    return false
  }

  // ===== 内盘筹码分析：顶部一次性取好捆绑簇净买入占比 =====
  const innerChip = hasInnerChip ? ctx.inner_chip_analysis : null
  const bundleBuyPct = innerChip?.stats?.clusters?.bundle?.buy_pct ?? 0
  const bundleOverLimit = bundleBuyPct > BUNDLE_BUY_PCT_LIMIT

  const launchTime = ctx.logearn?.launch_time || 0
  const graduated = launchTime > 0

  const PUMP_PLATFORMS = ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA']
  const FOUR_PLATFORMS = ['four.meme', 'binance_four.meme']
  const FLAP_PLATFORMS = ['flap']
  const platform = ctx.logearn?.platform
  const isPump = PUMP_PLATFORMS.includes(platform) && !ctx.logearn?.is_fake_pump
  const isFour = FOUR_PLATFORMS.includes(platform) && !ctx.logearn?.is_fake_four
  const isFlap = FLAP_PLATFORMS.includes(platform)
  const isTargetPlatform = isPump || isFour || isFlap

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
  const shitOk = shitVolume < 7

  const holdersStats = ctx.holders?.stats || {}
  const holdersDist = ctx.holders?.distribution || {}
  const goodPct = holdersStats.quality?.good_pct ?? 0
  const goodPctOk = goodPct > GOOD_PCT_LIMIT
  const retailPct = holdersDist.risk?.retail?.pct ?? 999 // retail 属于推涨组 push
  const retailPctOk = retailPct < RETAIL_PCT_LIMIT
  const devHoldPct = holdersDist.risk?.dev?.pct ?? 999
  const devHoldPctOk = devHoldPct < DEV_HOLD_PCT_LIMIT

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
  const newVolumeRaw = ctx.logearn?.new_volume ?? 999
  const newVolumeAdj = newVolumeRaw - followedHoldPercent
  const newOk = newVolumeAdj < NEW_LIMIT

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

  // 内盘捆绑簇净买入占比超门槛时，V转回撤幅度必须更深，否则不通过（bundleBuyPct 已在顶部取好）
  const vRetracement = hasEffectiveV ? (recentV?.n_pattern_retracement ?? 0) : 0
  const bundleRetraceOk = !bundleOverLimit || (hasEffectiveV && vRetracement > BUNDLE_RETRACE_MIN)

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

  const platformLabel = isPump ? 'Pump' : (isFour ? 'four' : (isFlap ? 'flap' : (platform || 'unknown')))
  const checks = [
    ['毕业', graduated, launchTime, '>0'],
    ['平台', isTargetPlatform, platformLabel, 'Pump/four/flap'],
    ['时长h', withinWindow, ageHour === Infinity ? 'NA' : ageHour.toFixed(1), '<=15'],
    ['市值', mcapOk, mcap.toFixed(0), '<120k'],
    ['内盘卖出', innerSellOk, innerSellRatio, '>=60'],
    ['筹码下大于上', chipBelowAboveOk, `below=${belowPercent.toFixed(1)}/above=${abovePercent.toFixed(1)}`, '下>上'],
    ['成本线上', deviationOk, avgPriceDeviationPct, '>0'],
    ['垃圾盘', shitOk, shitVolume, '<7'],
    ['优质占比', goodPctOk, goodPct.toFixed(1), '>10'],
    ['散户占比', retailPctOk, retailPct.toFixed(1), '<20'],
    ['DEV及关联占比', devHoldPctOk, devHoldPct.toFixed(1), '<10'],
    ['新钱包', newOk, `${newVolumeAdj.toFixed(1)}(原${newVolumeRaw}-关注${followedHoldPercent.toFixed(1)})`, '<70'],
    ['单地址持仓', holdOk, maxHold.toFixed(1), '<10'],
    ['单地址转账', transferOk, maxTransferIn.toFixed(1), '<10'],
    ['有效V转', hasEffectiveV, hasEffectiveV ? 'y' : 'n', 'confirmed&未收尾'],
    ['V转持续min', vDurationOk, hasEffectiveV ? (vDurationSec / 60).toFixed(1) : 'NA', '>2'],
    ['V转路径', retraceBreakOk, retraceInfo, '低点<成本*1.2'],
    ['捆绑回撤门槛', bundleRetraceOk, `捆绑${bundleBuyPct.toFixed(1)}%${hasEffectiveV ? '/回撤' + (vRetracement * 100).toFixed(1) + '%' : ''}`, bundleOverLimit ? '捆绑>70%时回撤需>60%' : '捆绑<=70%不限'],
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
  ctx.log.success(`命中<1.5段> [下单快照] 时间=${orderTimeStr}(${orderTimeSec}) 市值=$${orderMcap.toFixed(0)} 价格=$${orderPriceUsd} | V转阶段=${vStageLabel} [${vStageDetail}] | ${retraceInfo} 持续${(vDurationSec / 60).toFixed(1)}min 持仓${maxHold.toFixed(1)} 卖出${innerSellRatio} 偏离${avgPriceDeviationPct} 捆绑${bundleBuyPct.toFixed(1)}`)
  return true
} catch (e) {
  ctx.log.error('策略异常: ' + (e && e.message ? e.message : String(e)))
  return false
}