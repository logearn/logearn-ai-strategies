// ==============================================================
// 二段策略第二层 v1
// 作用：消费 code1 的初筛结果，做持仓风险、市值和筹码复核。
// code1 负责平台、币龄、首次周期与回撤区间；本层不再区分 0.786/0.618。
//
// 【持仓风险】以下条件必须通过，否则拒绝本次：
//   Top30 黑名单钱包不存在；Top5 单钱包持仓 <=10%；Top5 转入筹码 <=5%；
//   惯犯持仓 <25%；优质持仓 >15%；风险持仓 <50%；
//   垃圾钱包持仓 <=5%；DEV及关联钱包持仓 <=5%。
//
// 【拉黑条件】命中任一条件加入本策略黑名单：
//   1. 垃圾钱包持仓 >5%。
//   2. DEV及关联钱包持仓 >5%。
//   数据缺失或无效只拒绝本次，不作为拉黑依据。
//   （下方筹码占比不达标只拒绝本次，不再拉黑）
//
// 【命中条件】当前市值 >=$50,000；下方筹码 >25%；且下方筹码 >上方筹码。
//   下方/上方筹码均按百分比口径检查；本层不使用 code1 以外的行情结构信号。
// ==============================================================

// ---------- 参数 ----------
const MIN_MCAP = 50000           // 当前交易市值下限（USD），允许等于50k
const MIN_BELOW_PERCENT = 25     // 下方筹码占比须 >25%
const TOP_HOLD_MAX = 10          // Top5任一钱包持仓占比上限（%）
const TOP_TRANSFER_MAX = 5       // Top5任一钱包转入筹码占总发行量上限（%）
const HABITUAL_MAX = 25          // 惯犯钱包持仓占总发行量须 <25%
const GOOD_MIN = 10              // 优质钱包持仓占总发行量须 >15%
const RISK_MAX = 50              // 风险钱包持仓占总发行量须 <50%
const SHIT_MAX = 5               // 垃圾钱包持仓占总发行量 >5%拉黑，等于5%允许
const DEV_MAX = 5                // DEV及关联钱包持仓占总发行量 >5%拉黑，等于5%允许
const BLACKLIST = ['BAr5csYtpWoNpwhUjixX7ZPHXkUciFZzjBp9uNxZXJPh']

// ---------- 数据 ----------
const L = ctx.logearn || {}
const chip = ctx.chip_analysis || {}
const ca = L.token_address
const mcap = Number(L.mcap)
const below = chip.below_percent
const above = chip.above_percent
const top5 = Array.isArray(chip.top5_holders) ? chip.top5_holders : []
const holders = Array.isArray(ctx.holders?.list) ? ctx.holders.list : (Array.isArray(ctx.holders) ? ctx.holders : [])
const top30 = holders.slice(0, 30)
const risk = ctx.holders?.distribution?.risk || {}
const habitual = risk.habitual?.pct
const shitPct = risk.shit?.pct
const shitValid = typeof shitPct === 'number' && Number.isFinite(shitPct) && shitPct >= 0 && shitPct <= 100
const devPct = risk.dev?.pct
const devValid = typeof devPct === 'number' && Number.isFinite(devPct) && devPct >= 0 && devPct <= 100
const habitualValid = typeof habitual === 'number' && Number.isFinite(habitual) && habitual >= 0 && habitual <= 100
const quality = ctx.holders?.stats?.quality || {}
const goodPct = quality.good_pct
const riskPct = quality.risk_pct
const goodValid = typeof goodPct === 'number' && Number.isFinite(goodPct) && goodPct >= 0 && goodPct <= 100
const riskValid = typeof riskPct === 'number' && Number.isFinite(riskPct) && riskPct >= 0 && riskPct <= 100

const hitBlacklist = top30.find(h => BLACKLIST.includes(h && (h.wallet || h.address)))
const whale = top5.find(h => h && typeof h.total_hold_percent === 'number' && h.total_hold_percent > TOP_HOLD_MAX)
const ratHolder = top5.find(h => h && typeof h.transfer_in_percent === 'number' && h.transfer_in_percent > TOP_TRANSFER_MAX)
const mcapValid = Number.isFinite(mcap)
const belowValid = typeof below === 'number' && Number.isFinite(below) && below >= 0 && below <= 100
const aboveValid = typeof above === 'number' && Number.isFinite(above) && above >= 0 && above <= 100
const chipBelowAboveOk = belowValid && aboveValid && below > above
const mcapOk = mcapValid && mcap >= MIN_MCAP

// ---------- 持仓风险：先汇总，优先执行下方拉黑条件 ----------
const riskChecks = [
  ['Top30黑名单钱包', !hitBlacklist, hitBlacklist ? (hitBlacklist.wallet || hitBlacklist.address) : '未命中', '无黑名单钱包'],
  ['Top5单钱包持仓%', !whale, whale ? `${whale.wallet}: ${whale.total_hold_percent.toFixed(2)}%` : '未超限', '<= ' + TOP_HOLD_MAX + '%'],
  ['Top5单钱包转入%', !ratHolder, ratHolder ? `${ratHolder.wallet}: ${ratHolder.transfer_in_percent.toFixed(2)}%` : '未超限', '<= ' + TOP_TRANSFER_MAX + '%'],
  ['惯犯持仓%', habitualValid && habitual < HABITUAL_MAX, habitualValid ? habitual.toFixed(2) + '%' : '缺失或无效', '< ' + HABITUAL_MAX + '%'],
  ['优质持仓%', goodValid && goodPct > GOOD_MIN, goodValid ? goodPct.toFixed(2) + '%' : '缺失或无效', '> ' + GOOD_MIN + '%'],
  ['风险持仓%', riskValid && riskPct < RISK_MAX, riskValid ? riskPct.toFixed(2) + '%' : '缺失或无效', '< ' + RISK_MAX + '%'],
  ['垃圾钱包持仓%', shitValid && shitPct <= SHIT_MAX, shitValid ? shitPct.toFixed(2) + '%' : '缺失或无效', '<= ' + SHIT_MAX + '%'],
  ['DEV及关联钱包持仓%', devValid && devPct <= DEV_MAX, devValid ? devPct.toFixed(2) + '%' : '缺失或无效', '<= ' + DEV_MAX + '%'],
]
const riskFailed = riskChecks.filter(c => !c[1])

// ---------- 代币拉黑条件 ----------
// 垃圾钱包、DEV及关联钱包超限各自独立拉黑。下方筹码占比不达标不再拉黑，只在命中判断阶段拒绝本次。
const blacklistChecks = [
  ['垃圾钱包持仓超限', shitValid && shitPct > SHIT_MAX, shitValid ? shitPct.toFixed(2) + '%' : '缺失或无效', '<= ' + SHIT_MAX + '%'],
  ['DEV及关联钱包持仓超限', devValid && devPct > DEV_MAX, devValid ? devPct.toFixed(2) + '%' : '缺失或无效', '<= ' + DEV_MAX + '%'],
]
const blackHit = blacklistChecks.filter(c => c[1])
if (blackHit.length) {
  const reason = blackHit.map(([name, , actual, expect]) => `${name}: ${actual} [期望 ${expect}]`).join('  |  ')
  ctx.log.error('未命中并拉黑  ' + reason)
  ctx.add_blacklist(ca, reason)
  return false
}
if (riskFailed.length) {
  const detail = riskFailed.map(([name, , actual, expect]) => `${name}(❌): ${actual} [期望 ${expect}]`).join('  |  ')
  ctx.log.error('直接排除  ' + detail)
  return false
}

// ---------- 命中条件与统一输出 ----------
const checks = [
  ...riskChecks,
  ['当前市值USD', mcapOk, mcapValid ? mcap.toFixed(0) : '缺失或无效', '>= ' + MIN_MCAP],
  ['下方筹码占比', belowValid && below > MIN_BELOW_PERCENT, belowValid ? below.toFixed(2) + '%' : '缺失或无效', '> ' + MIN_BELOW_PERCENT + '%，有效范围0~100%'],
  ['下方筹码大于上方', chipBelowAboveOk, '下方' + (belowValid ? below.toFixed(2) + '%' : '缺失或无效') + ' / 上方' + (aboveValid ? above.toFixed(2) + '%' : '缺失或无效'), 'below > above'],
]
const passed = checks.every(c => c[1])
const sortedChecks = [...checks.filter(c => !c[1]), ...checks.filter(c => c[1])]
const detail = sortedChecks.map(([name, ok, actual, expect]) => `${name}(${ok ? '✅' : '❌'}): ${actual} [期望 ${expect}]`).join('  |  ')
if (!passed) {
  ctx.log.error('未命中  ' + detail)
  return false
}
ctx.log.success('命中<二段筹码达标>  ' + detail)
return true