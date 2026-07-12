// 1.5段策略 v27
// 【依赖 kline_and_indicators 与 chip_analysis，单币深度分析场景，非实时流批量场景】
//
// 本版改动（相对 v26）：修复 avg 成本线取错的 bug。
// 问题：findAvgPriceAtTime 在 low_price_time 早于本地 avg_price_bars 覆盖范围时，
//        会 fallback 到"最老那根 bar"（累计成本刚起步、值最低），导致 avg 被严重低估
//        （例：low=28851/avg被算成19158，实际应≈25k）。
// 修法B（宽松）：一旦查找超出 K 线覆盖范围（找不到 time<=t 的 bar），
//        改用当前成本线 ctx.kline_and_indicators.current_avg_price 换算的市值做近似，
//        而不是拿最老那根；并在 retraceInfo 标注 (近似:当前成本线)。
//        avg_price_bars 为 newest first，最后一根是最老一根——只有当 t 比最老一根还早才算超范围。

try {
  const nowSec = Math.floor(Date.now() / 1000)
  const RETRACE_TOLERANCE = 0.10
  const HOLD_LIMIT = 10
  const TRANSFER_LIMIT = 10
  const MIN_V_DURATION = 120 // V转回撤持续时间下限（秒）= 2分钟
  const MCAP_LIMIT = 120000  // 买入市值上限（USD）

  const hasChip = !!ctx.chip_analysis
  const hasKline = !!ctx.kline_and_indicators && Array.isArray(ctx.kline_and_indicators.avg_price_bars)
  if (!hasChip || !hasKline) {
    ctx.log.error(`数据源未就绪 chip(${hasChip}) kline(${hasKline})`)
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

  const avgPriceDeviationPct = ctx.kline_and_indicators?.avg_price_deviation_pct ?? -999
  const deviationOk = avgPriceDeviationPct > 0

  const shitVolume = ctx.logearn?.shit_volume ?? 999
  const shitOk = shitVolume < 7

  const followedSet = new Set()
  const wpm = ctx.logearn?.followed_signal_state?.walletPositionMap || {}
  for (const k of Object.keys(wpm)) { if (k) followedSet.add(k.toLowerCase()) }
  for (const f of (ctx.logearn?.followed_list || [])) { if (f?.wallet) followedSet.add(f.wallet.toLowerCase()) }

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
  const oldestBarTime = avgPriceBars.length ? avgPriceBars[avgPriceBars.length - 1].time : Infinity // newest first→最后一根最老
  const currentAvgPrice = ctx.kline_and_indicators?.current_avg_price || 0 // 当前成本线(USD单价)
  const vList = ctx.logearn?.v_breakout_volume_list || []
  const currentPriceUsd = ctx.kline_and_indicators?.current_price || 0
  const mcapPerUsdPrice = currentPriceUsd > 0 ? (mcap / currentPriceUsd) : 0

  // 返回 { value, approx }：命中范围内→精确取该时刻 avg；超出K线最早覆盖范围→用当前成本线近似
  function findAvgPriceAtTime(t) {
    for (let i = 0; i < avgPriceBars.length; i++) {
      if (avgPriceBars[i].time <= t) return { value: avgPriceBars[i].value, approx: false }
    }
    // 找不到 time<=t 的 bar：说明 t 早于本地K线覆盖范围（旧的fallback会取到最老一根导致低估）
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
  const vFresh = hasEffectiveV && (nowSec - (recentV.signalTime || 0)) <= 60 * 60

  // V转持续时间（回撤时长）= 触底时间 - 见顶时间，需 > 2分钟
  let vDurationSec = 0
  let vDurationOk = false
  if (hasEffectiveV) {
    const topT = toSec(recentV.top_price_time)
    const lowT = toSec(recentV.low_price_time)
    vDurationSec = (topT > 0 && lowT > 0) ? (lowT - topT) : 0
    vDurationOk = vDurationSec > MIN_V_DURATION
  }

  // ===== 当前 V转反弹阶段（反弹20%/40%/60%/新高 = fibon_break1/2/3/4）=====
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
    ['时长h', withinWindow, ageHour === Infinity ? 'NA' : ageHour.toFixed(1), '<=15'],
    ['市值', mcapOk, mcap.toFixed(0), '<120k'],
    ['内盘卖出', innerSellOk, innerSellRatio, '>=60'],
    ['成本线上', deviationOk, avgPriceDeviationPct, '>0'],
    ['垃圾盘', shitOk, shitVolume, '<7'],
    ['单地址持仓', holdOk, maxHold.toFixed(1), '<10'],
    ['单地址转账', transferOk, maxTransferIn.toFixed(1), '<10'],
    ['有效V转', hasEffectiveV, hasEffectiveV ? 'y' : 'n', 'confirmed&未收尾'],
    ['V转持续min', vDurationOk, hasEffectiveV ? (vDurationSec / 60).toFixed(1) : 'NA', '>2'],
    ['V转新鲜min', vFresh, hasEffectiveV ? ((nowSec - (recentV.signalTime || 0)) / 60).toFixed(0) : 'NA', '<=60'],
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