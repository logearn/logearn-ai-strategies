// ==============================================================
// 单代币强势盘策略  v1.0.0
// 条件：平台白名单(含 four.meme) + 年龄 1分钟~500分钟 + 市值<12w
//       + Top10持仓<30% + 创建者持仓<1% + 内鬼<10% + 垃圾钱包<5%
//       + 买入次数>50 + 成本线偏离 2~120% + AO 上升 + AC 上升
// 说明：checks 顺序 = 判定优先级，先排最便宜、最易 false 的结构性硬条件，
//       AO/AC 动量类计算放最后；全程仅一条日志输出。
// 注：gmgn 里的占比字段均为 0-1 小数，×100 转成百分比。
// ==============================================================

// ---------- 版本号 ----------
const VERSION = 'v1.0.0'

// ---------- 工具函数 ----------
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }
const sma = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)

// ---------- 阈值常量 ----------
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
const symbol = logearn.symbol || ki.symbol || 'UNKNOWN'

const visitingCount = gmgn.visiting_count != null ? gmgn.visiting_count : 0

// gmgn 占比字段（0-1 小数 → 百分比）
const top10Pct = num(dev.top_10_holder_rate) * 100
const creatorPct = num(stat.creator_hold_rate) * 100
const ratPct = num(stat.top_rat_trader_percentage) * 100

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

// ---------- 逐条判定（顺序=优先级）----------
const checks = [
  ['平台', ALLOW_PLATFORMS.indexOf(logearn.platform) !== -1, String(logearn.platform), '白名单(含four.meme)'],
  ['年龄(秒)', launchTime > 0 && ageSec >= AGE_MIN_SEC, ageSec, '>= ' + AGE_MIN_SEC],
  ['年龄(分)', launchTime > 0 && ageMin <= AGE_MAX_MIN, Number.isFinite(ageMin) ? ageMin.toFixed(1) : 'NA', '<= ' + AGE_MAX_MIN],
  ['市值', effMcap > 0 && effMcap < MCAP_MAX, effMcap.toFixed(0), '>0 且 < ' + MCAP_MAX],
  ['Top10持仓%', top10Pct < TOP10_MAX, top10Pct.toFixed(1), '< ' + TOP10_MAX],
  ['创建者持仓%', creatorPct < CREATOR_MAX, creatorPct.toFixed(2), '< ' + CREATOR_MAX],
  ['内鬼%', ratPct < RAT_MAX, ratPct.toFixed(1), '< ' + RAT_MAX],
  ['垃圾钱包%', num(logearn.shit_volume) < SHIT_MAX, num(logearn.shit_volume).toFixed(1), '< ' + SHIT_MAX],
  ['买入次数', buyTxD1 > BUYTX_MIN, buyTxD1, '> ' + BUYTX_MIN],
  ['偏离%', deviationPct > DEV_MIN && deviationPct < DEV_MAX, deviationPct.toFixed(1), DEV_MIN + '~' + DEV_MAX],
  ['AO', aoOk, ao0.toFixed(0) + '/' + ao1.toFixed(0), 'ao0>0 且 ao0>ao1'],
  ['AC', acOk, (ac0 === null ? 'NA' : ac0.toFixed(1)) + '/' + (ac1 === null ? 'NA' : ac1.toFixed(1)), 'ac0>0 且 ac0>ac1']
]

// ---------- 输出（全程仅一条日志）----------
const head = VERSION + ' 访问' + visitingCount + ' [' + symbol + '] K' + ki.resolution
const detail = checks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
const passed = checks.every((c) => c[1])
if (!passed) {
  const fails = checks.filter((c) => !c[1]).map((c) => `${c[0]}=${c[2]}`).join(' ')
  ctx.log.error('未命中 ' + head + ' | 失败:' + fails + '  ||  ' + detail)
  return false
}
ctx.log.success('命中<强势盘> ' + head + '  ' + detail)
return true