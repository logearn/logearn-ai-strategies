const chip = ctx.chip_analysis || {}
const above = chip.above_percent
const below = chip.below_percent
const top5 = Array.isArray(chip.top5_holders) ? chip.top5_holders : []
const L = ctx.logearn || {}

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

if (typeof above !== 'number' || typeof below !== 'number') {
  ctx.log.error('未命中  筹码分布数据缺失: above=' + above + ' below=' + below)
  return false
}

// ===== 最新回撤反弹信号是否处于「反弹20%阶段」 =====
// 反弹20%阶段 = fibon_break1 已触发(break1_time>0) 且尚未推进到反弹40%(break2_time 为空/0)
const vList = Array.isArray(L.v_breakout_volume_list) ? L.v_breakout_volume_list : []
const latestV = vList.slice().sort((a, b) => (b?.signalTime || 0) - (a?.signalTime || 0))[0]
const b1t = latestV?.fibon_break1_time
const b2t = latestV?.fibon_break2_time
const isRebound20 = !!latestV && b1t != null && b1t > 0 && !(b2t != null && b2t > 0)

// ===== 首次深度回撤周期：历史上已有完成的深回撤反弹，则本次不再命中 =====
// 回撤 >= 0.618 且 fibon_break4_time > 0，表示该深回撤周期已突破前高并结束。
// 仍在进行中的深回撤、已结束但不足 0.618 的浅回撤，不计入完成周期数。
const finishedDeepCycles = vList.filter(v => {
  const r = v?.n_pattern_retracement || 0
  const ended = v?.fibon_break4_time != null && v.fibon_break4_time > 0
  return r >= 0.618 && ended
}).length
const isFirstFibRebound = finishedDeepCycles === 0

// ===== 首次周期与筹码条件：全部满足才命中 =====
// 注：'上方<下方' 在 (above<38 且 below>40) 成立时会被自动蕴含(40<below)，属逻辑冗余，仅保留作日志展示
const checks = [
  ['最新V信号处于反弹20%阶段', isRebound20, `break1_time=${b1t || 0} break2_time=${b2t || 0}`, 'break1已触发且break2未触发'],
  ['首次深度反弹(无已结束0.618周期)', isFirstFibRebound, `已结束深度周期${finishedDeepCycles}`, '= 0'],
  ['上方筹码<下方筹码', above < below, above.toFixed(2) + '% vs ' + below.toFixed(2) + '%', 'above < below'],
  ['上方筹码占比', above < 38, above.toFixed(2) + '%', '< 38%'],
  ['下方筹码占比', below > 40, below.toFixed(2) + '%', '> 40%'],
]
const detail = checks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
const passed = checks.every(c => c[1])
if (!passed) { ctx.log.error('未命中  ' + detail); return false }
ctx.log.success('命中<触发位上方筹码轻抛压>  ' + detail)
return true