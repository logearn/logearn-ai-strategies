// 苏醒接力策略 v1.0
// Pump / four.meme 发射 + 30分钟内苏醒信号价格逐个抬高 + 最新苏醒在成本线上
// + 排除关注地址后 单地址持仓<=10% 转账持仓<=10% + 生命周期<=1个月需至少2次早期精选信号
// + 已毕业到外盘（过滤内盘）+ 毕业满1小时（过滤刚毕业1h内）
const STRATEGY_VERSION = 'v1.0'

const ALLOW_PLATFORMS = [
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump（SOL）
  'four.meme',                                    // four.meme（BSC）
  'binance_four.meme',                            // Binance four.meme（BSC）
]

const num = (x) => {
  const n = Number(x)
  return Number.isFinite(n) ? n : 0
}

const logearn = ctx.logearn || {}
const ki = ctx.kline_and_indicators || {}
const chip = ctx.chip_analysis || {}
const symbol = logearn.symbol || 'UNKNOWN'

const deviationPct = num(ki.avg_price_deviation_pct)
const nowTs = Math.floor(Date.now() / 1000)

// 生命周期（天）
const swapBegin = num(logearn.swap_begin_time)
const ageDays = swapBegin > 0 ? (nowTs - swapBegin) / 86400 : Infinity

// 毕业（内盘->外盘）：launch_time 有值即已毕业
const launchTime = num(logearn.launch_time)
const launched = launchTime > 0
const afterLaunchSec = launched ? nowTs - launchTime : -1

// 苏醒信号列表：新→旧
const wakeSorted = (Array.isArray(logearn.breakout_volume_10x_list) ? logearn.breakout_volume_10x_list : []).slice().sort((a, b) => num(b.signalTime) - num(a.signalTime))
const latestWake = wakeSorted[0] || null
const prevWake = wakeSorted[1] || null
const latestTime = latestWake ? num(latestWake.signalTime) : 0
const prevTime = prevWake ? num(prevWake.signalTime) : 0
const gap = prevWake ? latestTime - prevTime : -1

const WINDOW = 1800 // 30分钟
const inWindow = latestWake ? wakeSorted.filter(w => latestTime - num(w.signalTime) <= WINDOW).length : 0

// 苏醒信号价格（总量固定，用信号市值 notice_mcap 代表价格高低）
const latestMcap = latestWake ? num(latestWake.notice_mcap) : 0
const prevMcap = prevWake ? num(prevWake.notice_mcap) : 0

// 早期精选信号次数
const featuredCount = (Array.isArray(logearn.continue_breakout_volume_list) ? logearn.continue_breakout_volume_list : []).length
// 生命周期<=1个月需至少2次精选；>1个月不做此要求
const youngNeedFeatured = ageDays <= 30
const featuredPass = youngNeedFeatured ? featuredCount >= 2 : true

// 关注地址集合
const followedSet = new Set()
;(Array.isArray(logearn.followed_list) ? logearn.followed_list : []).forEach(f => { if (f && f.wallet) followedSet.add(String(f.wallet).toLowerCase()) })
const wpm = logearn.followed_signal_state && logearn.followed_signal_state.walletPositionMap
if (wpm) Object.keys(wpm).forEach(w => followedSet.add(String(w).toLowerCase()))

// 排除关注地址后的头部持仓
const nonFollowed = (Array.isArray(chip.top5_holders) ? chip.top5_holders : []).filter(h => h && !followedSet.has(String(h.wallet).toLowerCase()))
const maxHold = nonFollowed.reduce((m, h) => Math.max(m, num(h.total_hold_percent)), 0)
const maxTransferIn = nonFollowed.reduce((m, h) => Math.max(m, num(h.transfer_in_percent)), 0)

const checks = [
  ['平台', ALLOW_PLATFORMS.includes(logearn.platform), logearn.platform, 'pump/four'],
  ['已毕业外盘', launched, launched ? '已毕业' : '内盘', 'launch_time>0'],
  ['毕业满1h', launched && afterLaunchSec >= 3600, launched ? (afterLaunchSec / 60).toFixed(0) + '分' : 'NA', '>=3600s'],
  ['30分钟内多苏醒', !!prevWake && inWindow > 1 && gap <= WINDOW, `${inWindow}个/间隔${gap}s`, '>1且<=1800s'],
  ['价格>前一个', !!prevWake && latestMcap > prevMcap, `${latestMcap.toFixed(0)}>${prevMcap.toFixed(0)}`, '当前市值>前一个'],
  ['成本线上', deviationPct > 0, deviationPct.toFixed(1) + '%', '>0'],
  ['单地址持仓<=10', maxHold <= 10, maxHold.toFixed(1) + '%', '<=10'],
  ['转账持仓<=10', maxTransferIn <= 10, maxTransferIn.toFixed(1) + '%', '<=10'],
  ['精选信号(<=1月需>=2)', featuredPass, `年龄${ageDays === Infinity ? 'NA' : ageDays.toFixed(1)}天/精选${featuredCount}次`, youngNeedFeatured ? '>=2' : '不限(>1月)'],
]

const detail = `[${STRATEGY_VERSION}][${symbol}] ` + checks.map(([n, ok, a]) => `${n}(${ok ? 'Y' : 'N'}):${a}`).join(' | ')
if (!checks.every(c => c[1])) { ctx.log.error('未命中 ' + detail); return false }
ctx.log.success('命中 ' + detail)
return true