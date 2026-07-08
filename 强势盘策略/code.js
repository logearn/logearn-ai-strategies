// 单代币策略：年龄(>=1分钟 且 <=3天) + 市值(取max卡上限) + 垃圾钱包 + 平台白名单(含 four.meme) + 成本线偏离 + AO上升 + AC上升
// 调整：日志精简——未命中只列失败项，命中只出关键摘要；去掉冗长的[期望..]描述
var num = function (x) { var n = Number(x); return Number.isFinite(n) ? n : 0 }
var sma = function (arr) { return arr.length ? arr.reduce(function (a, b) { return a + b }, 0) / arr.length : 0 }

var MCAP_MAX = 120000
var DEV_MIN = 2
var DEV_MAX = 120
var AGE_MAX_DAYS = 3
var AGE_MIN_SEC = 60

var allow = [
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump 内盘
  'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1', // LetsBonk 1
  'BuM6KDpWiTcxvrpXywWFiw45R2RNH8WURdvqoTDV1BW4', // LetsBonk 2
  'four.meme',                                    // Four.meme
  'binance_four.meme'                             // Binance Four.meme
]

var ki = ctx.kline_and_indicators || {}
var aoBars = Array.isArray(ki.ao_bars) ? ki.ao_bars : []
var logearn = ctx.logearn || {}
var symbol = logearn.symbol || ki.symbol || 'UNKNOWN'

var visitingCount = (ctx.gmgn && ctx.gmgn.visiting_count != null) ? ctx.gmgn.visiting_count : 0

var nowTs = Math.floor(Date.now() / 1000)

var launchTime = num(logearn.swap_begin_time)
var ageSec = launchTime > 0 ? (nowTs - launchTime) : -1
var ageDays = launchTime > 0 ? ageSec / 86400 : Infinity

var mcapCandidates = [num(logearn.current_mcap), num(logearn.mcap), num(logearn.fdv)]
var effMcap = Math.max(mcapCandidates[0], mcapCandidates[1], mcapCandidates[2])

var deviationPct = num(ki.avg_price_deviation_pct)
var buyTxD1 = num(logearn.buy_tx_count_d1)

var resStr = String(ki.resolution || '').toUpperCase().trim()
var needN = (resStr === '1S' || resStr === '5S') ? 5 : 3

var aoVals = []
for (var i = 0; i < needN; i++) aoVals.push(num(aoBars[i] ? aoBars[i].value : 0))
var ao0 = aoVals[0], ao1 = aoVals[1]
var aoOk = aoBars.length >= needN && ao0 > 0 && ao0 > ao1

var calcAC = function (idx) {
  if (idx + 5 > aoBars.length) return null
  var win = aoBars.slice(idx, idx + 5).map(function (b) { return num(b.value) })
  return num(aoBars[idx].value) - sma(win)
}
var acVals = []
for (var k = 0; k < needN; k++) acVals.push(calcAC(k))
var ac0 = acVals[0], ac1 = acVals[1]
var acOk = ac0 !== null && ac1 !== null && ac0 > 0 && ac0 > ac1

// 顺序=判定优先级：先排最便宜、最容易 false 的结构性硬条件，最后才是 AO/AC 动量条件
var checks = [
  ['平台', allow.indexOf(logearn.platform) !== -1, String(logearn.platform)],
  ['年龄秒', launchTime > 0 && ageSec >= AGE_MIN_SEC, ageSec],
  ['年龄天', launchTime > 0 && ageDays <= AGE_MAX_DAYS, Number.isFinite(ageDays) ? ageDays.toFixed(2) : 'NA'],
  ['市值', effMcap > 0 && effMcap < MCAP_MAX, effMcap.toFixed(0)],
  ['垃圾钱包%', num(logearn.shit_volume) < 5, num(logearn.shit_volume).toFixed(1)],
  ['买入次数', buyTxD1 > 50, buyTxD1],
  ['偏离%', deviationPct > DEV_MIN && deviationPct < DEV_MAX, deviationPct.toFixed(1)],
  ['AO', aoOk, ao0.toFixed(0) + '/' + ao1.toFixed(0)],
  ['AC', acOk, (ac0 === null ? 'NA' : ac0.toFixed(1)) + '/' + (ac1 === null ? 'NA' : ac1.toFixed(1))]
]

var head = '访问' + visitingCount + ' [' + symbol + '] K' + ki.resolution
var passed = checks.every(function (c) { return c[1] })
if (!passed) {
  var fails = checks.filter(function (c) { return !c[1] }).map(function (c) { return c[0] + '=' + c[2] }).join(' ')
  ctx.log.error('未命中 ' + head + ' | 失败:' + fails)
  return false
}
var hit = checks.map(function (c) { return c[0] + '=' + c[2] }).join(' ')
ctx.log.success('命中<强势盘> ' + head + ' | ' + hit)
return true