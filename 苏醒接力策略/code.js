// 苏醒接力策略：Pump / four.meme 发射 + 30分钟内苏醒信号价格逐个抬高 + 最新苏醒在成本线上
// + 当前苏醒暴量>=8k(USD) + 排除关注地址后 单地址持仓<=10% 转账持仓<=10%
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

const nativePrice = num(ctx.native_coin_price)
const deviationPct = num(ki.avg_price_deviation_pct)

// 苏醒信号列表：新→旧
const wakeSorted = (Array.isArray(logearn.breakout_volume_10x_list) ? logearn.breakout_volume_10x_list : []).slice().sort((a, b) => num(b.signalTime) - num(a.signalTime))
const latestWake = wakeSorted[0] || null
const prevWake = wakeSorted[1] || null
const latestTime = latestWake ? num(latestWake.signalTime) : 0
const prevTime = prevWake ? num(prevWake.signalTime) : 0
const gap = prevWake ? latestTime - prevTime : -1

const WINDOW = 1800 // 30分钟
const inWindow = latestWake ? wakeSorted.filter(w => latestTime - num(w.signalTime) <= WINDOW).length : 0

// 苏醒暴量（换算 USD 用于 8k 门槛）
const latestVol = latestWake ? num(latestWake.current_volume) : 0
const latestVolUsd = latestVol * nativePrice
// 苏醒信号价格（总量固定，用信号市值 notice_mcap 代表价格高低）
const latestMcap = latestWake ? num(latestWake.notice_mcap) : 0
const prevMcap = prevWake ? num(prevWake.notice_mcap) : 0

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
  ['30分钟内多苏醒', !!prevWake && inWindow > 1 && gap <= WINDOW, `${inWindow}个/间隔${gap}s`, '>1且<=1800s'],
  ['价格>前一个', !!prevWake && latestMcap > prevMcap, `${latestMcap.toFixed(0)}>${prevMcap.toFixed(0)}`, '当前市值>前一个'],
  ['暴量>=8k', latestVolUsd >= 8000, `$${latestVolUsd.toFixed(0)}`, '>=8000'],
  ['成本线上', deviationPct > 0, deviationPct.toFixed(1) + '%', '>0'],
  ['单地址持仓<=10', maxHold <= 10, maxHold.toFixed(1) + '%', '<=10'],
  ['转账持仓<=10', maxTransferIn <= 10, maxTransferIn.toFixed(1) + '%', '<=10'],
]

const detail = `[${symbol}] ` + checks.map(([n, ok, a]) => `${n}(${ok ? 'Y' : 'N'}):${a}`).join(' | ')
if (!checks.every(c => c[1])) { ctx.log.error('未命中 ' + detail); return false }
ctx.log.success('命中 ' + detail)
return true