// 单代币强势盘策略 v1.8.0
// 修改：去掉冗余的"创建者持仓%<1"，只保留"创建者持仓数量==0"
const VERSION = 'v1.8.0'
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }
const sma = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)

const ALLOW_PLATFORMS = [
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1',
  'BuM6KDpWiTcxvrpXywWFiw45R2RNH8WURdvqoTDV1BW4',
  'four.meme', 'binance_four.meme'
]

const ki = ctx.kline_and_indicators || {}
const aoBars = Array.isArray(ki.ao_bars) ? ki.ao_bars : []
const logearn = ctx.logearn || {}
const gmgn = ctx.gmgn || {}
const dev = gmgn.dev || {}
const stat = gmgn.stat || {}
const symbol = logearn.symbol || ki.symbol || 'UNKNOWN'
const visitingCount = gmgn.visiting_count != null ? gmgn.visiting_count : 0

// gmgn 占比 0-1 → %
const top10Pct = num(dev.top_10_holder_rate) * 100
const ratPct = num(stat.top_rat_trader_percentage) * 100
const botDegenPct = num(stat.bot_degen_rate) * 100
const devTeamPct = num(stat.dev_team_hold_rate) * 100
const bundlerPct = num(stat.top_bundler_trader_percentage) * 100
const entrapPct = num(stat.top_entrapment_trader_percentage) * 100
const freshPct = num(stat.fresh_wallet_rate) * 100

// 创建者/推特相关
const creatorOpenCount = num(dev.creator_open_count)
const creatorTokenBal = num(dev.creator_token_balance)
const twitterCreateCount = num(dev.twitter_create_token_count)
const twitterNameChangeCount = Array.isArray(dev.twitter_name_change_history) ? dev.twitter_name_change_history.length : 0

// logearn 8大持仓指标(本身就是 %)
const freqVol = num(logearn.frequent_volume)
const newVol = num(logearn.new_volume)
const oldVol = num(logearn.old_volume)

const nowTs = Math.floor(Date.now() / 1000)
const launchTime = num(logearn.swap_begin_time)
const ageSec = launchTime > 0 ? nowTs - launchTime : -1
const ageMin = launchTime > 0 ? ageSec / 60 : Infinity
const effMcap = Math.max(num(logearn.current_mcap), num(logearn.mcap), num(logearn.fdv))
const deviationPct = num(ki.avg_price_deviation_pct)
const buyTxD1 = num(logearn.buy_tx_count_d1)

// 人均买入次数 = 买入交易笔数 / 买入去重地址数（分母为 0 时判为 0，条件不成立）
const buyerCntD1 = num(logearn.buyer_count_d1)
const buyTxPerBuyer = buyerCntD1 > 0 ? buyTxD1 / buyerCntD1 : 0
const buyTxPerBuyerOk = buyerCntD1 > 0 && buyTxPerBuyer < 2.6

// AO 动量
const resStr = String(ki.resolution || '').toUpperCase().trim()
const needN = resStr === '1S' || resStr === '5S' ? 5 : 3
const ao0 = num(aoBars[0] ? aoBars[0].value : 0)
const ao1 = num(aoBars[1] ? aoBars[1].value : 0)
const aoOk = aoBars.length >= needN && ao0 > 0 && ao0 > ao1

// AC 加速度
const calcAC = (idx) => {
  if (idx + 5 > aoBars.length) return null
  return num(aoBars[idx].value) - sma(aoBars.slice(idx, idx + 5).map((b) => num(b.value)))
}
const ac0 = calcAC(0)
const ac1 = calcAC(1)
const acOk = ac0 !== null && ac1 !== null && ac0 > 0 && ac0 > ac1

const checks = [
  ['平台', ALLOW_PLATFORMS.indexOf(logearn.platform) !== -1, String(logearn.platform), '白名单'],
  ['年龄(秒)', launchTime > 0 && ageSec >= 60, ageSec, '>= 60'],
  ['年龄(分)', launchTime > 0 && ageMin <= 500, Number.isFinite(ageMin) ? ageMin.toFixed(1) : 'NA', '<= 500'],
  ['市值', effMcap > 0 && effMcap < 120000, effMcap.toFixed(0), '>0 且 < 120000'],
  ['Top10持仓%', top10Pct > 15 && top10Pct < 30, top10Pct.toFixed(1), '20~30'],
  
  ['创建者发币数', creatorOpenCount < 80, creatorOpenCount, '< 80'],
  ['推特改名次数', twitterNameChangeCount < 20, twitterNameChangeCount, '< 20'],
  ['开发团队持仓%', devTeamPct < 25, devTeamPct.toFixed(2), '< 25'],
  ['内鬼%', ratPct < 10, ratPct.toFixed(1), '< 10'],
  ['新钱包率%', freshPct > 4, freshPct.toFixed(2), '> 4'],
  ['垃圾钱包%', num(logearn.shit_volume) < 5, num(logearn.shit_volume).toFixed(1), '< 5'],
  ['捆绑买入率%', bundlerPct < 60, bundlerPct.toFixed(1), '> 60'],
  ['机器人degen率%', botDegenPct > 30, botDegenPct.toFixed(1), '> 30'],
  ['高频钱包%', freqVol > 5, freqVol.toFixed(1), '> 5'],
  ['新钱包%', newVol > 20 && newVol < 65, newVol.toFixed(1), '20~65'],
  ['老钱包%', oldVol > 20 && oldVol < 60, oldVol.toFixed(1), '20~60'],
  ['买入次数', buyTxD1 > 50, buyTxD1, '> 50'],
  
  ['偏离%', deviationPct > 2 && deviationPct < 120, deviationPct.toFixed(1), '2~120'],
  ['AO', aoOk, ao0.toExponential(2) + '/' + ao1.toExponential(2), 'ao0>0 且 ao0>ao1'],
  ['AC', acOk, (ac0 === null ? 'NA' : ac0.toExponential(2)) + '/' + (ac1 === null ? 'NA' : ac1.toExponential(2)), 'ac0>0 且 ac0>ac1']
]

const head = VERSION + ' 访问' + visitingCount + ' [' + symbol + '] K' + ki.resolution
const detail = checks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
if (!checks.every((c) => c[1])) {
  const fails = checks.filter((c) => !c[1]).map((c) => `${c[0]}=${c[2]}`).join(' ')
  ctx.log.error('未命中 ' + head + ' | 失败:' + fails + '  ||  ' + detail)
  return false
}
ctx.log.success('命中<强势盘> ' + head + '  ' + detail)
return true