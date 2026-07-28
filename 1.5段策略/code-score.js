// ==============================================================
// 1.5段策略【打分版】score-v30.0.0
//
// 【这一版是什么】把硬条件版 code.js（v30）原样搬进「打分版架构」的【起点】：
// code.js 里 18 条判定全部继承过来，且【全部作为硬性条件】——名字都进 VETO_NAMES，
// 没有任何打分因子。所以这一版的判定结果跟 code.js 逐条一致（都是一票否决，全过才命中），
// 行为没有任何变化，只是换了个能被 review 工具「打分版」识别、后续可逐项调权的骨架。
//
// 【为什么先全做成硬条件】跟强势盘打分版一个路子（见强势盘 code-score.js 注释）：
// 打分迁移的第一步就是"所有判定先全放进 VETO_NAMES、没有打分项"，跑起来跟硬条件版一模一样；
// 之后再拿真实回测数据、在 review 工具里逐项发现"哪些硬条件其实在误杀高倍盘"，把它从
// VETO_NAMES 挪出来、给真实权重和区间，变成软打分因子，让总分和倍率更单调（北极星 ρ）。
// 不要一上来就拍脑袋给权重——权重必须用回测校准。
//
// 【怎么把某一项从硬条件挪成打分因子】
//   1) 从 VETO_NAMES 里删掉它的名字；
//   2) 把它在 ALL_CHECKS 里那一行改成真实取值 + 真实区间 + 真实权重（勇者正权重加分/
//      邪恶负权重扣分），不要再用 "ok?1:0 + 区间1,1,1,1" 这种布尔占位写法；
//   3) 把 CUTOFF 从 0 调成真实的百分比阈值（现在全是硬条件、没有打分池，wsum=0、score 恒 0，
//      所以 CUTOFF 设 0 让 score 关卡恒过，判定完全交给硬否决——跟 code.js 等价）。
//
// 【score 公式】score = wsum>0 ? total/wsum*100 : 0，归一化到 0~100（跟强势盘打分版一致）。
// 现在没有打分项，wsum=0 → score 恒为 0；CUTOFF=0 → score 关卡恒过。等有了打分因子再收紧。
//
// 说明：所有判定值/区间/单位完全沿用 code.js v30，没有改动任何阈值。
// ==============================================================

// 注意：本策略全程读 ctx.* 直算、不调用 f('字段')，所以线上不需要 f 垫片，这里也不再内置。
// 日后若从 review「发送到策略」加进 f('字段') 打分因子，请用 review「策略」tab 的『生成上线代码』
// 按钮生成上线版（会自动装配所需垫片 + 逐字段数值自检），不要再手抄垫片。源在 review/src/lib/onlineExport.js。

const VERSION = 'score-v30.0.0'
const CUTOFF = 80  // 全硬条件起点：无打分池、score 恒 0，CUTOFF=0 让 score 关卡恒过，判定全交给硬否决

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }
// 梯形打分：[lo1,hi1] 满分 1，[lo0,lo1]/[hi1,hi0] 线性过渡，界外 0，缺失 0；±Infinity=该侧不设界。
// 本版所有行都是 "ok?1:0 + 区间1,1,1,1" 的布尔占位写法（硬条件只看 s===1），没用到真正的过渡带；
// 等某项挪成打分因子时再改成真实区间。
const trap = (x, lo0, lo1, hi1, hi0) => {
  if (x === null || !Number.isFinite(Number(x))) return 0
  const v = Number(x)
  if (v >= lo1 && v <= hi1) return 1
  if (v <= lo0 || v >= hi0) return 0
  if (v < lo1) { const w = lo1 - lo0; return Number.isFinite(w) && w > 0 ? (v - lo0) / w : 0 }
  const w = hi0 - hi1
  return Number.isFinite(w) && w > 0 ? (hi0 - v) / w : 0
}

try {
  const nowSec = Math.floor(Date.now() / 1000)
  const RETRACE_TOLERANCE = 0.10
  const HOLD_LIMIT = 10
  const TRANSFER_LIMIT = 10
  const MIN_V_DURATION = 120 // V转回撤持续时间下限（秒）= 2分钟
  const MCAP_LIMIT = 120000  // 买入市值上限（USD）
  const NEW_LIMIT = 70       // 新钱包持仓上限（%，已扣关注地址）
  const SHIT_LIMIT = 7       // 垃圾钱包持仓上限（%）
  const TOP10_HOLDER_RATE_LIMIT = 30 // gmgn.stat.top_10_holder_rate 上限（%）
  const CREATOR_HOLD_RATE_LIMIT = 0.5  // gmgn.stat.creator_hold_rate 上限（%）
  const TOP_RAT_TRADER_PERCENTAGE_LIMIT = 1  // gmgn.stat.top_rat_trader_percentage 上限（%）
  const DEV_TEAM_HOLD_RATE_LIMIT = 1  // gmgn.stat.dev_team_hold_rate 上限（%）

  const gmgnStat = ctx.gmgn?.stat || {}
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

  const CHIP_BUFFER = 2 // 筹码下大于上的容忍buff（%）
  const abovePercent = ctx.chip_analysis?.above_percent || 0
  const belowPercent = ctx.chip_analysis?.below_percent || 0
  const chipBelowAboveOk = belowPercent + CHIP_BUFFER > abovePercent

  const avgPriceDeviationPct = ctx.kline_and_indicators?.avg_price_deviation_pct ?? -999
  const deviationOk = avgPriceDeviationPct > 0

  const shitVolume = ctx.logearn?.shit_volume ?? 999
  const shitOk = shitVolume < SHIT_LIMIT


  const top10HolderRatePct = (gmgnStat.top_10_holder_rate ?? 0) * 100
  const top10HolderRateOk = top10HolderRatePct < TOP10_HOLDER_RATE_LIMIT
  const creatorHoldRatePct = (gmgnStat.creator_hold_rate ?? 0) * 100
  const creatorHoldRateOk = creatorHoldRatePct < CREATOR_HOLD_RATE_LIMIT
  const topRatTraderPercentagePct = (gmgnStat.top_rat_trader_percentage ?? 0) * 100
  const topRatTraderPercentageOk = topRatTraderPercentagePct < TOP_RAT_TRADER_PERCENTAGE_LIMIT
  const devTeamHoldRatePct = (gmgnStat.dev_team_hold_rate ?? 0) * 100
  const devTeamHoldRateOk = devTeamHoldRatePct < DEV_TEAM_HOLD_RATE_LIMIT

  // 关注地址集合 + 关注地址持仓占比
  const followedSet = new Set()
  const wpm = ctx.logearn?.followed_signal_state?.walletPositionMap || {}
  let followedBalanceSum = 0
  for (const k of Object.keys(wpm)) {
    if (k) followedSet.add(k.toLowerCase())
    followedBalanceSum += wpm[k]?.token_balance || 0
  }
  for (const f2 of (ctx.logearn?.followed_list || [])) { if (f2?.wallet) followedSet.add(f2.wallet.toLowerCase()) }
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

  // ========== 统一检查项清单 ==========
  // [name, value, weight, lo0, lo1, hi1, hi0, actualDisplay(可选), expectLabel(可选)]
  // 本版全部是硬性条件：value = 该项判定布尔(ok?1:0)，区间统一 1,1,1,1（trap 只有 value===1 才给 1），
  // weight 用占位的 1（VETO_NAMES 里的项不看 weight）。要挪成打分因子见文件头说明。
  const ALL_CHECKS = [
    ['毕业', graduated ? 1 : 0, 1, 1, 1, 1, 1, String(launchTime), '>0'],
    ['平台', isTargetPlatform ? 1 : 0, 1, 1, 1, 1, 1, platformLabel, 'Pump/four'],
    ['时长h', withinWindow ? 1 : 0, 1, 1, 1, 1, 1, ageHour === Infinity ? 'NA' : ageHour.toFixed(1), '<=15'],
    ['市值', mcapOk ? 1 : 0, 1, 1, 1, 1, 1, mcap.toFixed(0), '<120k'],
    ['内盘卖出', innerSellOk ? 1 : 0, 1, 1, 1, 1, 1, String(innerSellRatio), '>=60'],
    ['筹码下大于上', chipBelowAboveOk ? 1 : 0, 1, 1, 1, 1, 1, `below=${belowPercent.toFixed(1)}/above=${abovePercent.toFixed(1)}`, '下>上'],
    ['成本线上', deviationOk ? 1 : 0, 1, 1, 1, 1, 1, String(avgPriceDeviationPct), '>0'],
    ['垃圾盘', shitOk ? 1 : 0, 1, 1, 1, 1, 1, String(shitVolume), '<7'],
    ['前10持有占比', top10HolderRateOk ? 1 : 0, 1, 1, 1, 1, 1, top10HolderRatePct.toFixed(1), '<30'],
    ['创建者持仓', creatorHoldRateOk ? 1 : 0, 1, 1, 1, 1, 1, creatorHoldRatePct.toFixed(2), '<1'],
    ['top_rat_trader占比', topRatTraderPercentageOk ? 1 : 0, 1, 1, 1, 1, 1, topRatTraderPercentagePct.toFixed(2), '<1'],
    ['dev团队持仓', devTeamHoldRateOk ? 1 : 0, 1, 1, 1, 1, 1, devTeamHoldRatePct.toFixed(2), '<1'],
    ['新钱包', newOk ? 1 : 0, 1, 1, 1, 1, 1, `${newVolumeAdj.toFixed(1)}(原${newVolumeRaw}-关注${followedHoldPercent.toFixed(1)})`, '<70'],
    ['单地址持仓', holdOk ? 1 : 0, 1, 1, 1, 1, 1, maxHold.toFixed(1), '<10'],
    ['单地址转账', transferOk ? 1 : 0, 1, 1, 1, 1, 1, maxTransferIn.toFixed(1), '<10'],
    ['有效V转', hasEffectiveV ? 1 : 0, 1, 1, 1, 1, 1, hasEffectiveV ? 'y' : 'n', 'confirmed&未收尾'],
    ['V转持续min', vDurationOk ? 1 : 0, 1, 1, 1, 1, 1, hasEffectiveV ? (vDurationSec / 60).toFixed(1) : 'NA', '>2'],
    ['V转路径', retraceBreakOk ? 1 : 0, 1, 1, 1, 1, 1, retraceInfo, '低点<成本*1.1'],
  ]

  // ========== 分组：谁是硬否决，只看这个集合 ==========
  // 这里【显式列出】18 项原始硬否决——不能再用 new Set(ALL_CHECKS.map(c=>c[0]))！那样会把
  // ALL_CHECKS 里【每一项】都当硬否决，从阵营库「发送到策略」新插进来的打分因子也会被一并
  // 扫成硬条件（实际踩过：加的 gmgn.* 打分因子全变成一票否决）。用显式名单后，只有下面这 18 个
  // 是硬否决，其余（含后续追加的 f('字段') 打分因子）都走打分分支、计入 total。
  // 想把某项挪成打分因子：从这个名单里删掉它的名字（ALL_CHECKS 那行保留即可）+ 给真实权重/区间 + 调 CUTOFF。
  const VETO_NAMES = new Set([
    '毕业', '平台', '时长h', '市值', '内盘卖出', '筹码下大于上', '成本线上', '垃圾盘',
    '前10持有占比', '创建者持仓', 'top_rat_trader占比', 'dev团队持仓', '新钱包',
    '单地址持仓', '单地址转账', '有效V转', 'V转持续min', 'V转路径',
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
      // 打分因子分支（本版没有走到这里的项）：勇者正权重加分/邪恶负权重扣分；
      // wsum 只累加正权重，见强势盘打分版注释。
      total += s * weight; wsum += Math.max(0, weight)
      checks.push([name + '(分)', s > 0, actualStr + ' → ' + (s * weight).toFixed(1) + '分',
        '满分 ' + lo1 + '~' + hi1 + ' 权重 ' + weight])
    }
  }
  const score = wsum > 0 ? total / wsum * 100 : 0
  checks.push(['总分', score >= CUTOFF, score.toFixed(1), '>= ' + CUTOFF])

  // 机器可解析的分数标记：/SCORE=([\d.]+) VER=(\S+) GRADE=(\S)/
  // GRADE：S=总分>=85，A=60~85（本版无打分池、score 恒 0，只要硬否决全过就是 A），-=未过线或被硬否决。
  const grade = !vetoPassed ? '-' : (score >= 85 ? 'S' : (score >= 60 ? 'A' : 'A'))
  const mark = 'SCORE=' + score.toFixed(1) + ' VER=' + VERSION + ' GRADE=' + grade
  const detail = checks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')

  if (!vetoPassed) {
    const fails = ALL_CHECKS.filter((c) => VETO_NAMES.has(c[0]))
      .filter((c) => trap(c[1], c[3], c[4], c[5], c[6]) !== 1)
      .map((c) => `${c[0]}=${c[7] != null ? c[7] : c[1]}[${c[8] != null ? c[8] : ''}]`).join(' | ')
    ctx.log.error(`未命中(否决) ${mark}${hasEffectiveV ? ' | V转阶段=' + vStageLabel : ''} | 否决:${fails}  ||  ${detail}`)
    return false
  }
  if (score < CUTOFF) {
    ctx.log.error(`未命中(分低) ${mark}  ||  ${detail}`)
    return false
  }

  // ===== 下单时刻留痕（用于和实际成交价格对比）=====
  const orderTimeSec = nowSec
  const orderTimeStr = new Date(nowSec * 1000).toISOString()
  const orderMcap = mcap
  const orderPriceUsd = currentPriceUsd
  ctx.log.success(`命中<1.5段·打分> ${mark} [下单快照] 时间=${orderTimeStr}(${orderTimeSec}) 市值=$${orderMcap.toFixed(0)} 价格=$${orderPriceUsd} | V转阶段=${vStageLabel} [${vStageDetail}] | ${retraceInfo} 持续${(vDurationSec / 60).toFixed(1)}min 持仓${maxHold.toFixed(1)} 卖出${innerSellRatio} 偏离${avgPriceDeviationPct}  ||  ${detail}`)
  return true
} catch (e) {
  ctx.log.error('策略异常: ' + (e && e.message ? e.message : String(e)))
  return false
}
