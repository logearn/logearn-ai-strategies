// 单代币强势盘策略【打分版】score-v2.4.0（结构重构，逻辑/阈值与 v2.3.0 一致）
const VERSION = 'score-v2.4.0'
const CUTOFF = 80

// ---------- 工具 ----------
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }
const val = (x) => { if (x === null || x === undefined || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null }
const sma = (a) => (a.length ? a.reduce((s, b) => s + b, 0) / a.length : 0)
// 梯形打分：[lo1,hi1] 满分1，两侧线性过渡，界外/缺失=0；±Infinity=该侧不设界
const trap = (x, lo0, lo1, hi1, hi0) => {
  const v = val(x)
  if (v === null) return 0
  if (v >= lo1 && v <= hi1) return 1
  if (v <= lo0 || v >= hi0) return 0
  if (v < lo1) { const w = lo1 - lo0; return Number.isFinite(w) && w > 0 ? (v - lo0) / w : 0 }
  const w = hi0 - hi1
  return Number.isFinite(w) && w > 0 ? (hi0 - v) / w : 0
}

// ---------- 取数 ----------
const logearn = ctx.logearn || {}
const gmgn = ctx.gmgn || {}
const dev = gmgn.dev || {}
const stat = gmgn.stat || {}
const chip = ctx.chip_analysis || {}
const ki = ctx.kline_and_indicators || {}
const aoBars = Array.isArray(ki.ao_bars) ? ki.ao_bars : []
const symbol = logearn.symbol || ki.symbol || 'UNKNOWN'
const visitingCount = num(gmgn.visiting_count)

// ---------- 阈值 ----------
const MCAP_MAX = 120000, AGE_MIN_SEC = 60, AGE_MAX_MIN = 500
const TOP10_MAX = 30, CREATOR_MAX = 1, RAT_MAX = 10, SHIT_MAX = 5
const BUYTX_MIN = 50, DEV_MIN = 2, DEV_MAX = 120
const ALLOW_PLATFORMS = [
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump 内盘
  'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1', // LetsBonk 1
  'BuM6KDpWiTcxvrpXywWFiw45R2RNH8WURdvqoTDV1BW4', // LetsBonk 2
  'four.meme',
  'binance_four.meme'
]

// ---------- 打分因子取值 ----------
const gPrice = gmgn.price || {}
const priceNow = val(gPrice.price), ath = val(gmgn.ath_price)
const priceToAth = (priceNow !== null && ath !== null && ath > 0) ? priceNow / ath : null
const freshWallets = val((gmgn.wallet_tags_stat || {}).fresh_wallets)
const cAbove = val(chip.above_percent), cBelow = val(chip.below_percent)
const aboveBelowRatio = (cAbove !== null && cBelow !== null && cBelow !== 0) ? cAbove / cBelow : null

// ---------- 年龄 / 市值 / 占比 / 热度 ----------
const nowTs = Math.floor(Date.now() / 1000)
const launchTime = num(logearn.swap_begin_time)
const ageSec = launchTime > 0 ? nowTs - launchTime : -1
const ageMin = launchTime > 0 ? ageSec / 60 : Infinity
const effMcap = Math.max(num(logearn.current_mcap), num(logearn.mcap), num(logearn.fdv))
const top10Pct = num(dev.top_10_holder_rate) * 100
const creatorPct = num(stat.creator_hold_rate) * 100
const ratPct = num(stat.top_rat_trader_percentage) * 100
const shitPct = num(logearn.shit_volume)
const deviationPct = num(ki.avg_price_deviation_pct)
const buyTxD1 = num(logearn.buy_tx_count_d1)

// ---------- AO 动量 ----------
const resStr = String(ki.resolution || '').toUpperCase().trim()
const needN = (resStr === '1S' || resStr === '5S') ? 5 : 3
const aoVals = []
for (let i = 0; i < needN; i++) aoVals.push(num(aoBars[i] && aoBars[i].value))
const ao0 = aoVals[0], ao1 = aoVals[1]
const aoOk = aoBars.length >= needN && ao0 > 0 && ao0 > ao1

// ---------- AC 加速度 ----------
const calcAC = (idx) => {
  if (idx + 5 > aoBars.length) return null
  const win = aoBars.slice(idx, idx + 5).map((b) => num(b.value))
  return num(aoBars[idx].value) - sma(win)
}
const ac0 = calcAC(0), ac1 = calcAC(1)
const acOk = ac0 !== null && ac1 !== null && ac0 > 0 && ac0 > ac1

// ---------- 筹码展示（不参与判定）----------
const chipSummary = '筹码[上' + num(chip.above_percent).toFixed(1) + '/下' + num(chip.below_percent).toFixed(1) +
  '/总持' + num(chip.total_holding_percent).toFixed(1) + '/内盘卖' + num(chip.inner_sell_ratio).toFixed(1) +
  '/内盘持' + num(chip.inner_address_holding).toFixed(1) + ']'

// ---------- 硬否决 [名称, 是否通过, 实际值, 期望] ----------
const VETO_CHECKS = [
  ['平台', ALLOW_PLATFORMS.indexOf(logearn.platform) !== -1, String(logearn.platform), '白名单(含four.meme)'],
  ['年龄(秒)', ageSec >= AGE_MIN_SEC, ageSec, '>= ' + AGE_MIN_SEC],
  ['年龄(分)', ageMin <= AGE_MAX_MIN, Number.isFinite(ageMin) ? ageMin.toFixed(1) : '∞', '<= ' + AGE_MAX_MIN],
  ['市值', effMcap > 0 && effMcap < MCAP_MAX, effMcap.toFixed(0), '>0 且 < ' + MCAP_MAX],
  ['Top10持仓%', top10Pct < TOP10_MAX, top10Pct.toFixed(2), '< ' + TOP10_MAX],
  ['创建者持仓%', creatorPct < CREATOR_MAX, creatorPct.toFixed(2), '< ' + CREATOR_MAX],
  ['内鬼%', ratPct < RAT_MAX, ratPct.toFixed(2), '< ' + RAT_MAX],
  ['垃圾钱包%', shitPct < SHIT_MAX, shitPct.toFixed(2), '< ' + SHIT_MAX],
  ['买入次数', buyTxD1 > BUYTX_MIN, buyTxD1, '> ' + BUYTX_MIN],
  ['偏离%', deviationPct >= DEV_MIN && deviationPct <= DEV_MAX, deviationPct.toFixed(2), DEV_MIN + '~' + DEV_MAX],
  ['AO', aoOk, ao0.toFixed(0) + '/' + ao1.toFixed(0), 'ao0>0 且 ao0>ao1'],
  ['AC', acOk, (ac0 === null ? 'NA' : ac0.toFixed(1)) + '/' + (ac1 === null ? 'NA' : ac1.toFixed(1)), 'ac0>0 且 ac0>ac1'],
]

// ---------- 打分因子 [名称, 值, 权重, lo0, lo1, hi1, hi0] ----------
const SCORE_FACTORS = [
  ['ATH价格比', priceToAth, 18.1, 0.5734342049655948, 0.7380902993711995, Infinity, Infinity],
  ['新钱包数', freshWallets, 26.8, -2.6499999999999773, 61, Infinity, Infinity],
  ['上下筹码比', aboveBelowRatio, 36.8, -0.06477809943255583, 0.10818364248875569, Infinity, Infinity],
]

// ---------- 汇总 ----------
const checks = []
let vetoPassed = true
for (const [name, ok, actual, expect] of VETO_CHECKS) {
  if (!ok) vetoPassed = false
  checks.push([name, ok, actual, expect])
}
let total = 0, wsum = 0
for (const [name, value, weight, lo0, lo1, hi1, hi0] of SCORE_FACTORS) {
  const s = trap(value, lo0, lo1, hi1, hi0)
  total += s * weight
  wsum += Math.max(0, weight)
  const actual = value === null ? '缺失' : Number(Number(value).toFixed(4))
  checks.push([name + '(分)', s > 0, actual + ' → ' + (s * weight).toFixed(1) + '分', '满分 ' + lo1 + '~' + hi1 + ' 权重 ' + weight])
}
const score = wsum > 0 ? total / wsum * 100 : 0
checks.push(['总分', score >= CUTOFF, score.toFixed(1), '>= ' + CUTOFF])

const grade = !vetoPassed ? '-' : (score >= 85 ? 'S' : (score >= CUTOFF ? 'A' : '-'))
const head = 'SCORE=' + score.toFixed(1) + ' VER=' + VERSION + ' GRADE=' + grade + ' 访问' + visitingCount + ' [' + symbol + '] K' + ki.resolution + '  ' + chipSummary
const detail = head + '  ||  ' + checks.map(([name, ok, actual, expect]) => `${name}${ok ? '✅' : '❌'}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')

if (!vetoPassed) { ctx.log.error('未命中(否决)  ' + detail); return false }
if (score < CUTOFF) { ctx.log.error('未命中(分低)  ' + detail); return false }
ctx.log.success('命中<强势盘·打分>  ' + detail)
return true