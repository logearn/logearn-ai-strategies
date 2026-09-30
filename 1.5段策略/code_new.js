// 1.5段策略 v45（在 v44 基础上：时长限制改为「毕业后时长 <= 15h」）
// 【依赖 kline_and_indicators 与 chip_analysis 与 holders 与 inner_chip_analysis，单币深度分析场景，非实时流批量场景】
//
// v45 改动（相对 v44）：
// 1. 时长门槛从「开盘(swap_begin_time)至今 <= 15h」改为「毕业(launch_time)至今 <= 15h」。
// 平台筛选更新：与 code.js 同步四链平台白名单，保留 Pump/Four 假盘过滤。

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
  const UNDERWATER_PCT_LIMIT = 35 // holders.distribution.risk.underwater.pct 上限（%）
  const SMART_T1_PCT_LIMIT = 30 // holders.distribution.push.smart_t1.pct 上限（%），S1=P元帅/KOL/大户
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

  // 按链匹配平台白名单；Solana 地址区分大小写，EVM 平台标识统一小写。
  const CHAIN_PLATFORMS = {
    // Solana (chain 3)
    3: {
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump',
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'Pump AMM',
      '9SkAtSxgNUMvT9bGb93v6rLU5MjW1XibykqoGtqT9dbg': 'WenDev',
      'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj': 'Launpad',
      'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1': 'LetsBonk 1',
      'BuM6KDpWiTcxvrpXywWFiw45R2RNH8WURdvqoTDV1BW4': 'LetsBonk 2',
      '4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4': 'Labs',
      'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'Pools',
      'FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM': 'Moonshit',
      'Bov7gMQ88BQbtFMTxQ5e8grtrwG4ryQGAV9Mih2j9SxK': 'Dynamic DBC',
      'BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv': 'Bags',
      'GybkUNYVNk1FZMt9myAfvpSVgoKBgaueMTvszwBN4qYx': 'AnoncoinIt',
      '8rE9CtCjwhSmbwL5fbJBtRFsS3ohfMcDFeTTC7t4ciUA': 'Studio',
      '7UNpFBfTdWrcfS7aBQzEaPgZCfPJe8BDgHzwmWUZaMaF': 'TrendFun',
      'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Whirl',
      'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG': 'Moonshot',
      'boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4': 'Boop',
      'HEAVENoP2qxoeuF8Dj2oT1GHEnu49U5mJYkdeC8BAX2o': 'Heaven',
      '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt': 'StonkFun 1',
      '4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7': 'StonkFun 2',
    },
    // BSC (chain 56)
    56: {
      'four.meme': 'Four',
      'binance_four.meme': 'Binance Four',
      'flap': 'Flap',
      '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0': 'Flap',
      '0xec4549cadce5da21df6e6422d448034b5233bfbc': 'Four',
      '0x5c952063c7fc8610ffdb798152d69f0b9550762b': 'Four',
      '0x3508dca95a64c9378cb07ef6f40553a50905372a': 'Four',
    },
    // Robinhood Chain (chain 4663)
    4663: {
      'uniswap': 'Uniswap',
      '0xc783221ab1db0244203458417981b4631e80b988': 'Launch.fun v1',
      '0x6fda94aceedc5a97171469a8873d00fb9983bb8c': 'Launch.fun v2',
      '0x77dc6f6361b7b99456fc3761ce5b7dda80d83f9d': 'Trench.today',
      '0x0000ffffbe8efe702c8703ae3477ff5de3d319c0': 'Pools.instant',
      '0x22e99278308b393ea1260859b181ad7e78f5eeed': 'Long.xyz',
      '0x8660a7f019c7943b0b0a91b8e39aff3b6db6ae62': 'Pair.fund',
      '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e': 'Pons V2',
      '0xce9c48cfa068947f77738c81be406b53338e5b0d': 'O1',
      '0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862': 'Doppler Airlock',
      '0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09': 'Flap.sh',
      '0x4f7609b3e944eaeae758341369055c1c24f3229a': 'Imortal',
      '0xbedd8e29ebbd8c6b233cdae3b25a4ae5227e65d9': 'Imortal',
      '0x44c8d2b22da696d90cd1b8cb3eaccb943ab005ca': 'Imortal',
      '0xc4edbe1df58ac18d2e1591b34ac6e929c1df0ce7': 'Imortal',
      '0xe64ac4113848bbc1a6dde1a6d1da96720a36f297': 'O1',
    },
    // Arc / Circle Arc (chain 5042)
    5042: {
      '0xd68fdd69dbdb92ff0770e54c8a0840a7ba8af1b5': 'Arclab',
      '0x24196cd6e534cfce8f480b53e70809b68ea86f29': 'Arcpad',
      '0xb021be536808f551b31789422fd28a6c9c6e97da': 'Argus',
      '0x3d0b83e115205edf37e48a8eb6d92e2c7492a00c': 'ARK Launch',
      '0x9b9a136d04e8e19a934de062f0fbb929b3c7aedb': 'ARK Launch',
      '0x16d4c13ad2a23288aa9b9384f24084edc8cbef41': 'Bullcheese',
      '0xdfef2f90f7e52609cc89b80b68ff6a1c86c4ddc4': 'Dyor.fun',
      '0x6a62919ccbf0c19e0c4e084f986b582b4492dda4': 'Faze',
      '0x3f29dd25d1f6ad3d09d1d4a880f8a869e3039153': 'Lift',
      '0x1ca37b3c40e89aad48b5ad3352269c2293cfd3da': 'Lift',
      '0xe740cc40b4b173b62af54d79d50db34610600c54': 'LiquidLaunch',
      '0x3324d45dbda511e3333f5177c90f7c5dd30d24b5': 'Long.supply',
      '0xb6c6f77ee74af874a183bfd77dd0176d1ac91de6': 'Minara',
      '0x20eead6db6b3d0a4491e9073119dd0ebff166acc': 'O1',
      '0x815542e8b392389a1389e22e588e4b62a67ade72': 'OpenLaunch',
      '0x7b9720bc177e8b6f96962e9b15891f27108cad40': 'Peach',
      '0x4b638c1502a07a8e1a26112ee98f51a3f34bc93a': 'RadarDEX',
      '0x18d33de5eefb2f91b09385f35f6a1317659cc1f9': 'Synthra',
      '0xcad7ee36ac193bf2eddb7b3e2736c5bdb8269c8b': 'TollyPad',
      '0x0dcad158e98bc24455f9e94f46709d8a5f6d1255': 'Warp',
      '0x27117b11c5c6f886eb1ffb32d814557aad4f6c43': 'Zyora',
    },
  }
  const platform = ctx.logearn?.platform
  const chain = Number(ctx.logearn?.chain)
  const chainPlatforms = CHAIN_PLATFORMS[chain]
  const platformKey = chain === 3 ? String(platform || '') : String(platform || '').toLowerCase()
  const chainPlatformName = chainPlatforms && Object.prototype.hasOwnProperty.call(chainPlatforms, platformKey)
    ? chainPlatforms[platformKey] : null
  const isPump = chain === 3 && (chainPlatformName === 'Pump' || chainPlatformName === 'Pump AMM')
  const isFour = chain === 56 && (chainPlatformName === 'Four' || chainPlatformName === 'Binance Four')
  const isTargetPlatform = !!chainPlatformName
    && !(isPump && ctx.logearn?.is_fake_pump)
    && !(isFour && ctx.logearn?.is_fake_four)

  const platformLabel = chainPlatformName ? `${chainPlatformName}(chain ${chain})`
    : `${platform || 'unknown'}(chain ${chain})`

  // ===== 时长：改为「毕业(launch_time)至今 <= 15h」 =====
  const sinceLaunchSec = graduated ? (nowSec - launchTime) : Infinity
  const sinceLaunchHour = sinceLaunchSec / 3600
  const withinWindow = graduated && sinceLaunchSec <= 15 * 3600

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
  const underwaterPct = holdersDist.risk?.underwater?.pct ?? 999
  const underwaterOk = underwaterPct < UNDERWATER_PCT_LIMIT
  const smartT1Pct = holdersDist.push?.smart_t1?.pct ?? 999 // S1=P元帅/KOL/大户
  const smartT1Ok = smartT1Pct < SMART_T1_PCT_LIMIT

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

  const checks = [
    ['毕业', graduated, launchTime, '>0'],
    ['平台', isTargetPlatform, platformLabel, 'Solana(3)/BSC(56)/Robinhood(4663)/Arc(5042)平台白名单'],
    ['毕业后时长h', withinWindow, sinceLaunchHour === Infinity ? 'NA' : sinceLaunchHour.toFixed(1), '<=15'],
    ['市值', mcapOk, mcap.toFixed(0), '<120k'],
    ['内盘卖出', innerSellOk, innerSellRatio, '>=60'],
    ['筹码下大于上', chipBelowAboveOk, `below=${belowPercent.toFixed(1)}/above=${abovePercent.toFixed(1)}`, '下>上'],
    ['成本线上', deviationOk, avgPriceDeviationPct, '>0'],
    ['垃圾盘', shitOk, shitVolume, '<7'],
    ['优质占比', goodPctOk, goodPct.toFixed(1), '>10'],
    ['散户占比', retailPctOk, retailPct.toFixed(1), '<20'],
    ['DEV及关联占比', devHoldPctOk, devHoldPct.toFixed(1), '<10'],
    ['套牢盘占比', underwaterOk, underwaterPct.toFixed(1), '<35'],
    ['S1占比', smartT1Ok, smartT1Pct.toFixed(1), '<30'],
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
  ctx.log.success(`命中<1.5段> [下单快照] 时间=${orderTimeStr}(${orderTimeSec}) 市值=$${orderMcap.toFixed(0)} 价格=$${orderPriceUsd} | 毕业后${sinceLaunchHour.toFixed(1)}h | V转阶段=${vStageLabel} [${vStageDetail}] | ${retraceInfo} 持续${(vDurationSec / 60).toFixed(1)}min 持仓${maxHold.toFixed(1)} 卖出${innerSellRatio} 偏离${avgPriceDeviationPct} 套牢${underwaterPct.toFixed(1)} S1=${smartT1Pct.toFixed(1)} 捆绑${bundleBuyPct.toFixed(1)}`)
  return true
} catch (e) {
  ctx.log.error('策略异常: ' + (e && e.message ? e.message : String(e)))
  return false
}