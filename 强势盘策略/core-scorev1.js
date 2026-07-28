// 单代币强势盘策略【打分版】score-v2.1.0

const VERSION = 'score-v2.1.0'
const CUTOFF = 80

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }
const sma = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)
// 梯形打分：[lo1,hi1] 满分 1，[lo0,lo1]/[hi1,hi0] 线性过渡，界外 0，缺失 0；±Infinity=该侧不设界。
const trap = (x, lo0, lo1, hi1, hi0) => {
  if (x === null || !Number.isFinite(Number(x))) return 0
  const v = Number(x)
  if (v >= lo1 && v <= hi1) return 1
  if (v <= lo0 || v >= hi0) return 0
  if (v < lo1) { const w = lo1 - lo0; return Number.isFinite(w) && w > 0 ? (v - lo0) / w : 0 }
  const w = hi0 - hi1
  return Number.isFinite(w) && w > 0 ? (hi0 - v) / w : 0
}

// ---------- 阈值常量（沿用 v1.0.1 命名与数值）----------
const MCAP_MAX = 120000     // 有效市值上限（USD）
const DEV_MIN = 2           // 成本线偏离下限（%）
const DEV_MAX = 120         // 成本线偏离上限（%）
const AGE_MIN_SEC = 60      // 生命周期下限：< 1 分钟直接淘汰
const AGE_MAX_MIN = 500     // 生命周期上限（分钟）
const TOP10_MAX = 30        // Top10 持仓% 上限
const CREATOR_MAX = 1       // 创建者持仓% 上限
const RAT_MAX = 10          // 内鬼/插队交易者% 上限
const SHIT_MAX = 5          // 垃圾钱包占比上限（%）
const BUYTX_MIN = 50        // 24h 买入次数下限

// 发射平台白名单
const ALLOW_PLATFORMS = [
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump 内盘
  'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1', // LetsBonk 1
  'BuM6KDpWiTcxvrpXywWFiw45R2RNH8WURdvqoTDV1BW4', // LetsBonk 2
  'four.meme',                                    // Four.meme
  'binance_four.meme'                             // Binance Four.meme
]

// ---------- 取数据 ----------
const ki = ctx.kline_and_indicators || {}
const aoBars = Array.isArray(ki.ao_bars) ? ki.ao_bars : []
const logearn = ctx.logearn || {}
const gmgn = ctx.gmgn || {}
const dev = gmgn.dev || {}
const stat = gmgn.stat || {}
const chip = ctx.chip_analysis || {}
const symbol = logearn.symbol || ki.symbol || 'UNKNOWN'
const Holders = ctx.holders || [] // 当前未参与判定/日志，预留（沿用 v1.0.1 原样）
const visitingCount = gmgn.visiting_count != null ? gmgn.visiting_count : 0

// gmgn 占比字段（0-1 小数 → 百分比）
const top10Pct = num(dev.top_10_holder_rate) * 100
const creatorPct = num(stat.creator_hold_rate) * 100
const ratPct = num(stat.top_rat_trader_percentage) * 100

// ---------- 打分因子取值（原来用 f() 占位，现改成正式字段口径）----------
// 单位对齐阈值：gmgn.stat 的三个比率是 0-1 小数 → ×100 成百分比；shit_volume 本身已是%；
// image_dup_count 是整数计数；max_up_duration 是秒，均按原始数值。
const fMaxUpDuration = num(logearn.max_up_duration)                       // 秒
const fEntrapment = num(stat.top_entrapment_trader_percentage) * 100      // 0-1 → %
const fBotDegen = num(stat.bot_degen_rate) * 100                          // 0-1 → %
const fFreshWallet = num(stat.fresh_wallet_rate) * 100                    // 0-1 → %
const fShitVolume = num(logearn.shit_volume)                             // 已是 %
const fImageDup = num(gmgn.image_dup_count)                              // 计数

// ---------- 筹码分析（仅展示，不参与判定）----------
const chipAbove = num(chip.above_percent)          // 当前价上方筹码%（抛压）
const chipBelow = num(chip.below_percent)          // 当前价下方筹码%（支撑）
const chipTotalHold = num(chip.total_holding_percent) // Top500 累计持仓%
const chipInnerSell = num(chip.inner_sell_ratio)   // 内盘卖出率
const chipInnerHold = num(chip.inner_address_holding) // 内盘地址剩余持仓占比%
const chipSummary = '筹码[上' + chipAbove.toFixed(1) + '/下' + chipBelow.toFixed(1) +
  '/总持' + chipTotalHold.toFixed(1) + '/内盘卖' + chipInnerSell.toFixed(1) +
  '/内盘持' + chipInnerHold.toFixed(1) + ']'

// ---------- 年龄 ----------
const nowTs = Math.floor(Date.now() / 1000)
const launchTime = num(logearn.swap_begin_time)
const ageSec = launchTime > 0 ? nowTs - launchTime : -1
const ageMin = launchTime > 0 ? ageSec / 60 : Infinity

// ---------- 市值（三字段取最大，卡上限更严）----------
const mcapCur = num(logearn.current_mcap)
const mcapMc = num(logearn.mcap)
const mcapFdv = num(logearn.fdv)
const effMcap = Math.max(mcapCur, mcapMc, mcapFdv)

// ---------- 偏离 / 热度 ----------
const deviationPct = num(ki.avg_price_deviation_pct)
const buyTxD1 = num(logearn.buy_tx_count_d1)

// ---------- AO 动量：最新一根为正且高于上一根 ----------
const resStr = String(ki.resolution || '').toUpperCase().trim()
const needN = resStr === '1S' || resStr === '5S' ? 5 : 3
const aoVals = []
for (let i = 0; i < needN; i++) aoVals.push(num(aoBars[i] ? aoBars[i].value : 0))
const ao0 = aoVals[0]
const ao1 = aoVals[1]
const aoOk = aoBars.length >= needN && ao0 > 0 && ao0 > ao1

// ---------- AC 加速度：AO 相对自身近 5 根均值的偏离，为正且放大 ----------
const calcAC = (idx) => {
  if (idx + 5 > aoBars.length) return null
  const win = aoBars.slice(idx, idx + 5).map((b) => num(b.value))
  return num(aoBars[idx].value) - sma(win)
}
const ac0 = calcAC(0)
const ac1 = calcAC(1)
const acOk = ac0 !== null && ac1 !== null && ac0 > 0 && ac0 > ac1

// ========== 统一检查项清单 ==========
// [name, value, weight, lo0, lo1, hi1, hi0, actualDisplay(可选), expectLabel(可选)]
const ALL_CHECKS = [
  ['max_up_duration', fMaxUpDuration, 23.8, -737.2700000000001, 137, 790, 3469.320000000001, null, '137~790'],
  ['gmgn.stat.top_entrapment_trader_percentage', fEntrapment, 19.7, -0.5124000000000001, 2.295, Infinity, Infinity, null, '2.295~Infinity'],
  ['gmgn.stat.bot_degen_rate', fBotDegen, 23.6, 33.8492, 45.6425, 55.4675, 62.8673, null, '45.6425~55.4675'],
  ['gmgn.stat.fresh_wallet_rate', fFreshWallet, 17.7, -0.5153999999999996, 6.25, Infinity, Infinity, null, '6.25~Infinity'],
  ['shit_volume', fShitVolume, 12, -Infinity, -Infinity, 0, 1.4873038979818314, null, '-Infinity~0'],
  ['gmgn.image_dup_count', fImageDup, 3.2, -Infinity, -Infinity, 1.5, 29.589999999999975, null, '-Infinity~1.5'],
  ['平台', ALLOW_PLATFORMS.indexOf(logearn.platform) !== -1 ? 1 : 0, 1, 1, 1, 1, 1,
    String(logearn.platform), '白名单(含four.meme)'],
  ['年龄(秒)', ageSec, 1, AGE_MIN_SEC, AGE_MIN_SEC, Infinity, Infinity, null, '>= ' + AGE_MIN_SEC],
  ['年龄(分)', ageMin, 1, -Infinity, -Infinity, AGE_MAX_MIN, AGE_MAX_MIN, null, '<= ' + AGE_MAX_MIN],
  ['市值', effMcap > 0 ? effMcap : null, 1, 0, 0, MCAP_MAX, MCAP_MAX, null, '>0 且 < ' + MCAP_MAX],
  ['Top10持仓%', top10Pct, 1, -Infinity, -Infinity, TOP10_MAX, TOP10_MAX, null, '< ' + TOP10_MAX],
  ['创建者持仓%', creatorPct, 1, -Infinity, -Infinity, CREATOR_MAX, CREATOR_MAX, null, '< ' + CREATOR_MAX],
  ['内鬼%', ratPct, 1, -Infinity, -Infinity, RAT_MAX, RAT_MAX, null, '< ' + RAT_MAX],
  ['垃圾钱包%', num(logearn.shit_volume), 1, -Infinity, -Infinity, SHIT_MAX, SHIT_MAX, null, '< ' + SHIT_MAX],
  ['买入次数', buyTxD1, 1, BUYTX_MIN, BUYTX_MIN, Infinity, Infinity, null, '> ' + BUYTX_MIN],
  ['偏离%', deviationPct, 1, DEV_MIN, DEV_MIN, DEV_MAX, DEV_MAX, null, DEV_MIN + '~' + DEV_MAX],
  ['AO', aoOk ? 1 : 0, 1, 1, 1, 1, 1, ao0.toFixed(0) + '/' + ao1.toFixed(0), 'ao0>0 且 ao0>ao1'],
  ['AC', acOk ? 1 : 0, 1, 1, 1, 1, 1,
    (ac0 === null ? 'NA' : ac0.toFixed(1)) + '/' + (ac1 === null ? 'NA' : ac1.toFixed(1)), 'ac0>0 且 ac0>ac1'],
]

// ========== 分组：谁是硬否决，只看这个集合 ==========
const VETO_NAMES = new Set([
  '平台', '年龄(秒)', '年龄(分)', '市值', 'Top10持仓%', '创建者持仓%',
  '内鬼%', '垃圾钱包%', '买入次数', '偏离%', 'AO', 'AC',
])

// ========== 汇总 ==========
let total = 0, wsum = 0, vetoPassed = true
const checks = []
for (const c of ALL_CHECKS) {
  const [name, value, weight, lo0, lo1, hi1, hi0, actualOverride, expectOverride] = c
  const s = trap(value, lo0, lo1, hi1, hi0)
  const actualStr = actualOverride != null
    ? actualOverride
    : (value === null ? '缺失' : String(Number(Number(value).toFixed(4))))
  if (VETO_NAMES.has(name)) {
    const ok = s === 1
    if (!ok) vetoPassed = false
    checks.push([name, ok, actualStr, expectOverride != null ? expectOverride : (lo1 + '~' + hi1)])
  } else {
    total += s * weight; wsum += Math.max(0, weight)
    checks.push([name + '(分)', s > 0, actualStr + ' → ' + (s * weight).toFixed(1) + '分',
      '满分 ' + lo1 + '~' + hi1 + ' 权重 ' + weight])
  }
}
const score = wsum > 0 ? total / wsum * 100 : 0
checks.push(['总分', score >= CUTOFF, score.toFixed(1), '>= ' + CUTOFF])

const grade = !vetoPassed ? '-' : (score >= 85 ? 'S' : (score >= CUTOFF ? 'A' : '-'))
const mark = 'SCORE=' + score.toFixed(1) + ' VER=' + VERSION + ' GRADE=' + grade
const head = mark + ' 访问' + visitingCount + ' [' + symbol + '] K' + ki.resolution + '  ' + chipSummary
const detail = checks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
if (!vetoPassed) {
  const fails = ALL_CHECKS.filter((c) => VETO_NAMES.has(c[0]))
    .filter((c) => trap(c[1], c[3], c[4], c[5], c[6]) !== 1)
    .map((c) => `${c[0]}=${c[7] != null ? c[7] : c[1]}`).join(' ')
  ctx.log.error('未命中(否决) ' + head + ' | 否决:' + fails + '  ||  ' + detail)
  return false
}
if (score < CUTOFF) {
  ctx.log.error('未命中(分低) ' + head + '  ||  ' + detail)
  return false
}
ctx.log.success('命中<强势盘·打分> ' + head + '  ||  ' + detail)
return true