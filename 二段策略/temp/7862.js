const chip = ctx.chip_analysis || {}
const above = chip.above_percent
const below = chip.below_percent
const top5 = Array.isArray(chip.top5_holders) ? chip.top5_holders : []
const L = ctx.logearn || {}
const KI = ctx.kline_and_indicators || {}
const ca = L.token_address

const BLACKLIST = ['BAr5csYtpWoNpwhUjixX7ZPHXkUciFZzjBp9uNxZXJPh']
const holders = Array.isArray(ctx.holders) ? ctx.holders : []
const top30 = holders.slice(0, 30)
const hitBlacklist = top30.find(h => BLACKLIST.includes(h && h.address))

// 一票否决：Top30 出现黑名单地址，直接排除该代币
if (hitBlacklist) {
  ctx.log.error('直接排除  Top30命中黑名单地址: ' + hitBlacklist.address)
  return false
}

// 一票否决：筹码Top5持有者中存在单个钱包持仓占比 > 10%，直接过滤
const whale = top5.find(h => h && typeof h.total_hold_percent === 'number' && h.total_hold_percent > 10)
if (whale) {
  ctx.log.error('直接排除  Top5单钱包持仓过高: ' + whale.wallet + ' 持仓' + whale.total_hold_percent.toFixed(2) + '% [期望 <= 10%]')
  return false
}

// 一票否决：头部筹码来源过滤——要求头部地址主要靠买入建仓，任一Top5地址转入占比 > 5% 直接过滤
const ratHolder = top5.find(h => h && typeof h.transfer_in_percent === 'number' && h.transfer_in_percent > 5)
if (ratHolder) {
  ctx.log.error('直接排除  Top5头部筹码转入占比过高(疑似分发/老鼠仓): ' + ratHolder.wallet + ' 转入占比' + ratHolder.transfer_in_percent.toFixed(2) + '% [期望 <= 5%]')
  return false
}

// ===== 跌破斐波0.9 拉黑（只看当前市值）=====
// 【斐波锚点】最低点固定为 0（不追踪前低/动态最低点），最高点为历史最高市值 max_up_mcap；
//   0.9 回撤位市值 = 最高 × (1 - 0.9) = max_up_mcap × 0.1（即从高点跌超 90%、只剩 10% 才算跌破）。
// 【跌破判断】只看当前市值 mcap 是否 < 0.9位，不再遍历K线历史、不判断"历史曾跌破"。
//   当前市值跌破即 add_blacklist 永久拉黑。
// ⚠️ add_blacklist 在纯【代币实时流】模式是空操作——上线看日志确认。
const maxMcap = L.max_up_mcap || 0
const mcap = L.mcap || 0
// 斐波0.9位市值（随历史最高市值 max_up_mcap 变动）：最低点固定0，= 最高 × 0.1
const fib09 = maxMcap * (1 - 0.9)

if (maxMcap > 0 && mcap > 0) {
  const curBroke = mcap < fib09 // 当前市值跌破
  const blacklistChecks = [
    ['当前市值跌破斐波0.9', curBroke, mcap.toFixed(0), '>= 0.9位' + fib09.toFixed(0) + '(最高' + maxMcap.toFixed(0) + '/最低0)'],
  ]
  const blackHit = blacklistChecks.filter(c => c[1])
  if (blackHit.length) {
    const reason = blackHit.map(([name, ok, actual, expect]) => `${name}: ${actual} [期望 ${expect}]`).join('  |  ')
    ctx.add_blacklist(ca, reason)
    return false
  }
}

// ===== 最近一次最低点相关拉黑 =====
// 【算法】高点 = 历史最大市值 max_up_mcap（其出现时间 = max_up_mcap_time，快照里K线time为毫秒，故×1000对齐）；
//   第一步：取最高点之后(k.time > maxMcapTime)的所有K线；
//   第二步：这些K线 low 最小值即最低点 lowMcap，并记录其时间 minLowTime；
// 【拉黑条件A】最近最低点距今 > 15分钟（见底已久，下跌确立，不是刚砸的坑）→ 拉黑；
// 【拉黑条件B】最近最低点 lowMcap < 斐波0.9位(fib09=最高×0.1，随涨幅变动)（最低点已深跌破90%）→ 拉黑。
// ⚠️ 局限：低点用现有K线low现算，受K线覆盖长度限制；
//   K线在纯【代币实时流】模式可能拿不到、add_blacklist 也是空操作——上线看日志确认。
const maxMcapTime = L.max_up_mcap_time * 1000 || 0
const klineBars = Array.isArray(KI.kline_bars) ? KI.kline_bars : []
const nowMs = KI.timestamp || 0

if (maxMcap > 0 && maxMcapTime > 0 && nowMs > 0 && klineBars.length > 0) {
  // 第一步：取最高点之后的所有K线
  const afterBars = klineBars.filter(k => k && typeof k.time === 'number' && k.time > maxMcapTime && typeof k.low === 'number')

  if (afterBars.length > 0) {
    // 第二步：取这些K线 low 的最小值作为最低点（K线low直接就是市值），并记录其时间戳
    let minLow = Infinity
    let minLowTime = 0
    for (const k of afterBars) {
      if (k.low < minLow) { minLow = k.low; minLowTime = k.time }
    }
    const lowMcap = minLow
    const retracement = (maxMcap - lowMcap) / maxMcap // 回撤幅度 0-1（仅展示用）
    const diffMin = (nowMs - minLowTime) / 60000 // 当前时间距最低点的分钟数
    const info = '高点' + maxMcap.toFixed(0) + '(t=' + maxMcapTime + ')/高点后最低' + lowMcap.toFixed(0) + '(t=' + minLowTime + ')/回撤' + (retracement * 100).toFixed(1) + '%/距最低点' + diffMin.toFixed(1) + '分钟(高点后K线' + afterBars.length + '根)'
    ctx.log.info('最近最低点检查  ' + info)

    const drawdownBlacklistChecks = [
      ['最低点距今超过15分钟', diffMin > 15, diffMin.toFixed(1) + '分钟', '<= 15分钟'],
      ['最低点跌破斐波0.9', lowMcap < fib09, lowMcap.toFixed(0), '>= 0.9位' + fib09.toFixed(0) + '(最高' + maxMcap.toFixed(0) + '/最低0)'],
    ]
    const ddBlackHit = drawdownBlacklistChecks.filter(c => c[1])
    if (ddBlackHit.length) {
      const reason = ddBlackHit.map(([name, ok, actual, expect]) => `${name}: ${actual} [期望 ${expect}]`).join('  |  ') + '  |  ' + info
      ctx.add_blacklist(ca, reason)
      return false
    }
  }
}

if (typeof below !== 'number') {
  ctx.log.error('未命中  筹码分布数据缺失: below=' + below)
  return false
}

// ===== 下方筹码占比不满25% → 直接拉黑（不再重复查询消耗API）=====
// 拉黑线与买入门槛统一为 >25%，中间无灰色地带
const chipBlacklistChecks = [
  ['下方筹码占比不满25%', !(below > 25), below.toFixed(2) + '%', '> 25%'],
]
const chipBlackHit = chipBlacklistChecks.filter(c => c[1])
if (chipBlackHit.length) {
  const reason = chipBlackHit.map(([name, ok, actual, expect]) => `${name}: ${actual} [期望 ${expect}]`).join('  |  ')
  ctx.add_blacklist(ca, reason)
  return false
}

// ===== 筹码条件：满足即买入，不满足直接过滤 =====
// 买入门槛：下方筹码占比 > 25%
const checks = [
  ['下方筹码占比', below > 25, below.toFixed(2) + '%', '> 25%'],
]
const detail = checks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
const passed = checks.every(c => c[1])
if (!passed) { ctx.log.error('未命中  ' + detail); return false }
ctx.log.success('命中<触发位上方筹码轻抛压>  ' + detail)
return true