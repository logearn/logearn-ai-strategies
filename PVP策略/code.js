// pvp 策略 V2
// 【依赖 kline_and_indicators 与 chip_analysis 与 gmgn，单币深度分析场景，非实时流批量场景】
//
// 本版改动（相对 V1）：
// 新增「买入市值上限」检查项：当前市值 mcap < 120k。
// 基础逻辑：2次早期精选(continue_breakout_volume) + v转信号（v转判断逻辑复用）。

const nowSec = Math.floor(Date.now() / 1000)
const RETRACE_TOLERANCE = 0.10 // 低点允许高于当时成本线的容差（10%）
const HOLD_LIMIT = 10          // 单地址持仓上限（%）
const TRANSFER_LIMIT = 10      // 单地址转账持仓上限（%）
const CONTINUE_MIN = 2         // 早期精选最少出现次数
const VISIT_MIN = 10           // GMGN 浏览人数下限（严格大于）
const RETRACE_DURATION_MIN = 5 * 60 // v转回调时长下限（秒）
const MCAP_MAX = 120000        // 买入市值上限（USD）

// ---------- 前置条件 ----------
const PUMP_PLATFORMS = ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA']
const FOUR_PLATFORMS = ['four.meme', 'binance_four.meme']
const platform = ctx.logearn?.platform
const isPumpPlatform = PUMP_PLATFORMS.includes(platform) && !ctx.logearn?.is_fake_pump
const isFourPlatform = FOUR_PLATFORMS.includes(platform) && !ctx.logearn?.is_fake_four
const platformOk = isPumpPlatform || isFourPlatform

// 当前市值
const mcap = ctx.logearn?.mcap || 0
const mcapOk = mcap > 0 && mcap < MCAP_MAX

// 现价在成本线之上
const avgPriceDeviationPct = ctx.kline_and_indicators?.avg_price_deviation_pct ?? -999
const deviationOk = avgPriceDeviationPct > 0

// 人群结构限制（保留垃圾钱包）
const shitVolume = ctx.logearn?.shit_volume ?? 999
const shitOk = shitVolume < 7

// GMGN 浏览人数
const visitingCount = ctx.gmgn?.visiting_count ?? 0
const visitOk = visitingCount > VISIT_MIN

// ---------- 早期精选（continue_breakout_volume）出现次数 >= 2 ----------
const continueList = ctx.logearn?.continue_breakout_volume_list || []
const continueCount = continueList.length
const continueOk = continueCount >= CONTINUE_MIN

// ---------- 我关注地址集合（用于头部持仓检查时扣除） ----------
const followedSet = new Set()
const wpm = ctx.logearn?.followed_signal_state?.walletPositionMap || {}
for (const k of Object.keys(wpm)) { if (k) followedSet.add(k.toLowerCase()) }
for (const f of (ctx.logearn?.followed_list || [])) { if (f?.wallet) followedSet.add(f.wallet.toLowerCase()) }

// ---------- 头部持仓限制（top5_holders，逐个地址取 max=单地址口径，扣除我关注地址） ----------
const top5 = ctx.chip_analysis?.top5_holders || []
let maxHold = 0            // 非关注地址中「单地址」最大持仓
let maxTransferIn = 0      // 非关注地址中「单地址」最大转账持仓
let skippedFollowed = 0    // 被扣除的关注地址数
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

// v转回调时长：见顶(top_price_time)到触底(low_price_time)的时间跨度 > 5 分钟
let retraceDurOk = false
let retraceDurInfo = 'NA'
if (hasEffectiveV && recentV.top_price_time && recentV.low_price_time) {
  const durSec = toSec(recentV.low_price_time) - toSec(recentV.top_price_time)
  retraceDurOk = durSec > RETRACE_DURATION_MIN
  retraceDurInfo = (durSec / 60).toFixed(1) + 'm'
}

// v转【信号自身最低点】是否跌破 或 贴近（<=10%）当时成本线
let retraceBreakOk = false
let retraceInfo = 'none'
if (hasEffectiveV && recentV.low_price_mcap && recentV.low_price_time && mcapPerUsdPrice > 0) {
  const avgAtLow = findAvgPriceAtTime(recentV.low_price_time)   // 低点那一刻的成本线（USD单价）
  if (avgAtLow != null && avgAtLow > 0) {
    const avgMcapAtLow = avgAtLow * mcapPerUsdPrice              // 换算成平台市值口径
    const threshold = avgMcapAtLow * (1 + RETRACE_TOLERANCE)    // 允许低点高于成本线 10% 以内
    const gapPct = ((recentV.low_price_mcap - avgMcapAtLow) / avgMcapAtLow * 100)
    retraceBreakOk = recentV.low_price_mcap < threshold
    retraceInfo = `${gapPct.toFixed(1)}%`
  } else {
    retraceInfo = 'avgNA'
  }
}

// ---------- 精简日志 ----------
const checks = [
  ['平台', platformOk, platform],
  ['市值', mcapOk, (mcap / 1000).toFixed(1) + 'k'],
  ['浏览', visitOk, visitingCount],
  ['成本线上', deviationOk, avgPriceDeviationPct.toFixed(1)],
  ['垃圾钱包', shitOk, shitVolume.toFixed(1)],
  ['头部持仓', holdOk, maxHold.toFixed(1)],
  ['头部转账', transferOk, maxTransferIn.toFixed(1)],
  ['精选次数', continueOk, continueCount],
  ['v转新鲜', vFresh, hasEffectiveV ? ((nowSec - (recentV.signalTime || 0)) / 60).toFixed(0) + 'm' : 'NA'],
  ['v转回调时长', retraceDurOk, retraceDurInfo],
  ['v转回踩', retraceBreakOk, retraceInfo],
]
const passed = checks.every(c => c[1])
if (!passed) {
  const fails = checks.filter(c => !c[1]).map(([n, ok, v]) => `${n}=${v}`).join(' ')
  ctx.log.error('未命中  ' + fails)
  return false
}
ctx.log.success('命中<pvp>  ' + checks.map(([n, ok, v]) => `${n}=${v}`).join(' '))
return true