const chip = ctx.chip_analysis || {}
const above = chip.above_percent
const below = chip.below_percent
const top5 = Array.isArray(chip.top5_holders) ? chip.top5_holders : []
const L = ctx.logearn || {}
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

// ===== 跌破斐波0.72 拉黑：只看当前市值（已删除外盘历史/K线判断）=====
// 【斐波锚点】最低点固定为 0，最高点为历史最高市值 max_up_mcap；
//   0.72 回撤位市值 = 最高 × (1 - 0.72) = max_up_mcap × 0.28（从高点跌超 72%、只剩 28% 才算跌破）。
// 【判断】只看当前市值 mcap 是否 < 0.72位，跌破即 add_blacklist 永久拉黑。不再遍历K线、不看历史最低。
// ⚠️ add_blacklist 只对"信号触发/策略触发"两类策略生效；纯【代币实时流】模式下是空操作。
const maxMcap = L.max_up_mcap || 0
const mcap = L.mcap || 0
if (maxMcap > 0 && mcap > 0) {
  const fib072 = maxMcap * (1 - 0.72)   // 低点固定为0，0.72位 = 最高 × 0.28
  const blacklistChecks = [
    ['当前市值跌破斐波0.72', mcap < fib072, mcap.toFixed(0), '>= 0.72位' + fib072.toFixed(0) + '(最高' + maxMcap.toFixed(0) + ')'],
  ]
  const blackHit = blacklistChecks.filter(c => c[1])
  if (blackHit.length) {
    const reason = blackHit.map(([name, ok, actual, expect]) => `${name}: ${actual} [期望 ${expect}]`).join('  |  ')
    ctx.add_blacklist(ca, reason)
    return false
  }
}

if (typeof above !== 'number' || typeof below !== 'number') {
  ctx.log.error('未命中  筹码分布数据缺失: above=' + above + ' below=' + below)
  return false
}

// ===== 筹码条件：满足即买入，不满足直接过滤 =====
// 注：'上方<下方' 在 (above<38 且 below>40) 成立时会被自动蕴含(40<below)，属逻辑冗余，仅保留作日志展示
const checks = [
  ['上方筹码<下方筹码', above < below, above.toFixed(2) + '% vs ' + below.toFixed(2) + '%', 'above < below'],
  ['上方筹码占比', above < 38, above.toFixed(2) + '%', '< 38%'],
  ['下方筹码占比', below > 40, below.toFixed(2) + '%', '> 40%'],
]
const detail = checks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
const passed = checks.every(c => c[1])
if (!passed) { ctx.log.error('未命中  ' + detail); return false }
ctx.log.success('命中<触发位上方筹码轻抛压>  ' + detail)
return true