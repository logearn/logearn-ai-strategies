// 1.5段策略 v20
// 【依赖 kline_and_indicators 与 chip_analysis，单币深度分析场景，非实时流批量场景】
//
// 本版改动（相对 v19）：
// 新钱包过滤（new_volume 扣关注后 < 65）先注释掉、暂不生效；相关计算与 checks 项一并注释保留，方便以后恢复。

const nowSec = Math.floor(Date.now() / 1000)
const RETRACE_TOLERANCE = 0.10 // 低点允许高于当时成本线的容差（10%）
const HOLD_LIMIT = 10          // 单地址持仓上限（%）
const TRANSFER_LIMIT = 10      // 单地址转账持仓上限（%）
// const NEW_LIMIT = 65        // 新钱包持仓上限（%，已扣关注地址）——已注释停用

// ---------- 前置条件 ----------
const launchTime = ctx.logearn?.launch_time || 0
const graduated = launchTime > 0

// Pump（Solana）+ four.meme（BSC）
const PUMP_PLATFORMS = ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA']
const FOUR_PLATFORMS = ['four.meme', 'binance_four.meme']
const platform = ctx.logearn?.platform
const isPump = PUMP_PLATFORMS.includes(platform) && !ctx.logearn?.is_fake_pump
const isFour = FOUR_PLATFORMS.includes(platform) && !ctx.logearn?.is_fake_four
const isTargetPlatform = isPump || isFour

// 发射后 15 小时之内（以 swap_begin_time 计）
const swapBeginTime = ctx.logearn?.swap_begin_time || 0
const ageSec = swapBeginTime > 0 ? (nowSec - swapBeginTime) : Infinity
const ageHour = ageSec / 3600
const withinWindow = swapBeginTime > 0 && ageSec <= 15 * 3600

const innerSellRatio = ctx.chip_analysis?.inner_sell_ratio || 0
const innerSellOk = innerSellRatio >= 60

// 现价在成本线之上
const avgPriceDeviationPct = ctx.kline_and_indicators?.avg_price_deviation_pct ?? -999
const deviationOk = avgPriceDeviationPct > 0

// 人群结构限制
const shitVolume = ctx.logearn?.shit_volume ?? 999
const shitOk = shitVolume < 7

// ---------- 我关注地址集合（头部持仓检查扣除用） ----------
const followedSet = new Set()
const wpm = ctx.logearn?.followed_signal_state?.walletPositionMap || {}
for (const k of Object.keys(wpm)) { if (k) followedSet.add(k.toLowerCase()) }
for (const f of (ctx.logearn?.followed_list || [])) { if (f?.wallet) followedSet.add(f.wallet.toLowerCase()) }

// ---------- 新钱包过滤（已注释停用） ----------
// let followedBalanceSum = 0 // 我关注地址持仓量合计（人类可读单位）
// for (const k of Object.keys(wpm)) { followedBalanceSum += wpm[k]?.token_balance || 0 }
// const totalSupply = ctx.logearn?.total_supply || 0
// const followedHoldPercent = totalSupply > 0 ? (followedBalanceSum / totalSupply * 100) : 0
// const newVolumeRaw = ctx.logearn?.new_volume ?? 999
// const newVolumeAdj = newVolumeRaw - followedHoldPercent
// const newOk = newVolumeAdj < NEW_LIMIT

// ---------- 头部持仓限制（top5_holders，逐个地址取 max=单地址口径，扣除我关注地址） ----------
const top5 = ctx.chip_analysis?.top5_holders || []
let maxHold = 0            // 非关注地址中「单地址」最大持仓
let maxTransferIn = 0      // 非关注地址中「单地址」最大转账持仓
let skippedFollowed = 0    // 被扣除的关注地址数（仅用于日志）
for (const h of top5) {
  const w = (h?.wallet || '').toLowerCase()
  if (w && followedSet.has(w)) { skippedFollowed++; continue } // 我关注的地址不参与限制
  maxHold = Math.max(maxHold, h?.total_hold_percent || 0)
  maxTransferIn = Math.max(maxTransferIn, h?.transfer_in_percent || 0)
}
const holdOk = maxHold < HOLD_LIMIT             // 无（非关注）数据时=0，视为通过
const transferOk = maxTransferIn < TRANSFER_LIMIT

// ---------- 数据准备 ----------
function toSec(t) {
  const n = Number(t) || 0
  return n > 1e12 ? Math.floor(n / 1000) : n
}
const avgPriceBars = (ctx.kline_and_indicators?.avg_price_bars || []).map(b => ({ ...b, time: toSec(b.time) }))
const vList = ctx.logearn?.v_breakout_volume_list || []
const mcap = ctx.logearn?.mcap || 0
const currentPriceUsd = ctx.kline_and_indicators?.current_price || 0
const mcapPerUsdPrice = currentPriceUsd > 0 ? (mcap / currentPriceUsd) : 0

function findAvgPriceAtTime(targetTimeSec) {
  for (let i = 0; i < avgPriceBars.length; i++) {
    if (avgPriceBars[i].time <= targetTimeSec) return avgPriceBars[i].value
  }
  return avgPriceBars.length ? avgPriceBars[avgPriceBars.length - 1].value : null
}

// v转是否已收尾（反弹已突破前高，本轮周期结束）
function vFinished(v) {
  return (v?.fibon_break4 > 0) || (v?.fibon_break4_time != null && v.fibon_break4_time !== 0)
}

// ---------- 最近一个生效、且未收尾的 v转 ----------
let recentV = null
for (const v of vList) {
  if (v?.n_pattern_confirmed !== true) continue
  if (vFinished(v)) continue // 已收尾直接排除，避免追新高
  if (!recentV || (v.signalTime || 0) > (recentV.signalTime || 0)) recentV = v
}
const hasEffectiveV = !!recentV

// 新鲜度：最近生效 v转 距今 <= 60 分钟
const vFresh = hasEffectiveV && (nowSec - (recentV.signalTime || 0)) <= 60 * 60

// v转【信号自身最低点】是否跌破 或 贴近（<=10%）当时成本线
let retraceBreakOk = false
let retraceInfo = 'none'
if (hasEffectiveV && recentV.low_price_mcap && recentV.low_price_time && mcapPerUsdPrice > 0) {
  const avgAtLow = findAvgPriceAtTime(recentV.low_price_time)   // 低点那一刻的成本线（USD单价）
  if (avgAtLow != null && avgAtLow > 0) {
    const avgMcapAtLow = avgAtLow * mcapPerUsdPrice              // 换算成平台市值口径
    const threshold = avgMcapAtLow * (1 + RETRACE_TOLERANCE)    // 允许低点高于成本线 10% 以内
    const gapPct = ((recentV.low_price_mcap - avgMcapAtLow) / avgMcapAtLow * 100)
    if (recentV.low_price_mcap < threshold) {
      retraceBreakOk = true
      retraceInfo = `lowMcap=${recentV.low_price_mcap.toFixed(0)} vs avgMcap=${avgMcapAtLow.toFixed(0)}(距成本线${gapPct.toFixed(1)}%,<=10%达标)`
    } else {
      retraceInfo = `lowMcap=${recentV.low_price_mcap.toFixed(0)} vs avgMcap=${avgMcapAtLow.toFixed(0)}(距成本线${gapPct.toFixed(1)}%,>10%未达标)`
    }
  } else {
    retraceInfo = 'avgAtLow无效(<=0或缺失)'
  }
}

// ---------- 统一日志输出 ----------
const platformLabel = isPump ? 'Pump' : (isFour ? 'four.meme' : (platform || 'unknown'))
const checks = [
  ['已毕业', graduated, launchTime, '> 0'],
  ['平台(Pump/four.meme)', isTargetPlatform, platformLabel, 'Pump 或 four.meme 且非仿冒'],
  ['发射后时长(小时)', withinWindow, ageHour === Infinity ? 'NA' : ageHour.toFixed(2), '<= 15'],
  ['内盘卖出率', innerSellOk, innerSellRatio, '>= 60'],
  ['现价在成本线之上', deviationOk, avgPriceDeviationPct, '> 0'],
  ['垃圾钱包持仓', shitOk, shitVolume, '< 7'],
  // ['新钱包持仓(扣关注)', newOk, `${newVolumeAdj.toFixed(2)}(原${newVolumeRaw}-关注${followedHoldPercent.toFixed(2)})`, '< 65'], // 已注释停用
  ['头部单地址持仓(max,扣关注)', holdOk, `${maxHold.toFixed(2)}(扣除关注${skippedFollowed}个)`, '< 10'],
  ['头部单地址转账持仓(max,扣关注)', transferOk, maxTransferIn.toFixed(2), '< 10'],
  ['存在生效且未收尾v转', hasEffectiveV, hasEffectiveV ? (recentV.signalTime || 0) : 'none', 'n_pattern_confirmed=true 且 fibon_break4 未触发'],
  ['v转新鲜度(分钟)', vFresh, hasEffectiveV ? ((nowSec - (recentV.signalTime || 0)) / 60).toFixed(1) : 'NA', '<= 60'],
  ['V转路径(信号最低点跌破/贴近成本线10%内)', retraceBreakOk, retraceInfo, '低点 < 当时成本线*1.10'],
]
const orderedChecks = [...checks].sort((a, b) => {
  if (a[1] !== b[1]) return a[1] ? 1 : -1
  if (!a[1]) return 0
  const aIsV = a[0].includes('V转路径')
  const bIsV = b[0].includes('V转路径')
  if (aIsV !== bIsV) return aIsV ? -1 : 1
  return 0
})
const detail = orderedChecks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
const passed = checks.every(c => c[1])
if (!passed) { ctx.log.error('未命中  ' + detail); return false }
ctx.log.success('命中<1.5段策略>  ' + detail)
return true