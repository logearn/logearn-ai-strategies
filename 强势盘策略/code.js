// ==============================================================
// 单代币强势盘策略  v1.0.2
// 条件：四链平台白名单(Solana/BSC/Robinhood/Arc) + 年龄 1分钟~500分钟 + 市值<12w
//       + Top10持仓<30% + 创建者持仓<1% + 内鬼<10% + 垃圾钱包<5%
//       + 买入次数>50 + 成本线偏离 2~120% + AO 上升 + AC 上升
// 说明：checks 顺序 = 判定优先级，先排最便宜、最易 false 的结构性硬条件，
//       AO/AC 动量类计算放最后；全程仅一条日志输出。
// 注：gmgn 里的占比字段均为 0-1 小数，×100 转成百分比。
//     筹码分析(ctx.chip_analysis)仅做日志展示、不参与判定。
// ==============================================================

// ---------- 版本号 ----------
const VERSION = 'v1.0.2'

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

// 发射平台白名单：以下为四链全量列表，删除或注释某一行即可禁用该平台。
// 按链匹配平台白名单；Solana 地址区分大小写，EVM 平台标识统一小写。
const CHAIN_PLATFORMS = {
  // Solana (chain 3)
  3: {
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump',
    '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt': 'StonkFun 1',
    '4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7': 'StonkFun 2',
  },
  // BSC (chain 56)
  56: {
    'four.meme': 'Four',
    'binance_four.meme': 'Binance Four',
    'flap': 'Flap',
    '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0': 'Flap',
    '0xec4549cadce5da21df6e6422d448034b5233bfbc': 'Four',
    '0x5c952063c7fc8610ffdb798152d69f0b9550762b': 'Four',
    '0x3508dca95a64c9378cb07ef6f40553a50905372a': 'Four',
  },
  // Robinhood Chain (chain 4663)
  4663: {
    '0x0000ffffbe8efe702c8703ae3477ff5de3d319c0': 'Pools.instant',
    '0x22e99278308b393ea1260859b181ad7e78f5eeed': 'Long.xyz',
    '0x8660a7f019c7943b0b0a91b8e39aff3b6db6ae62': 'Pair.fund',
    '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e': 'Pons V2'
  },
  // Arc / Circle Arc (chain 5042)
  5042: {
    '0xd68fdd69dbdb92ff0770e54c8a0840a7ba8af1b5': 'Arclab',
    '0x24196cd6e534cfce8f480b53e70809b68ea86f29': 'Arcpad',
    '0xb021be536808f551b31789422fd28a6c9c6e97da': 'Argus',
    '0x3d0b83e115205edf37e48a8eb6d92e2c7492a00c': 'ARK Launch',
    '0x9b9a136d04e8e19a934de062f0fbb929b3c7aedb': 'ARK Launch',
    '0x16d4c13ad2a23288aa9b9384f24084edc8cbef41': 'Bullcheese',
    '0xdfef2f90f7e52609cc89b80b68ff6a1c86c4ddc4': 'Dyor.fun',
    '0x6a62919ccbf0c19e0c4e084f986b582b4492dda4': 'Faze',
    '0x3f29dd25d1f6ad3d09d1d4a880f8a869e3039153': 'Lift',
    '0x1ca37b3c40e89aad48b5ad3352269c2293cfd3da': 'Lift',
    '0xe740cc40b4b173b62af54d79d50db34610600c54': 'LiquidLaunch',
    '0x3324d45dbda511e3333f5177c90f7c5dd30d24b5': 'Long.supply',
    '0xb6c6f77ee74af874a183bfd77dd0176d1ac91de6': 'Minara',
    '0x20eead6db6b3d0a4491e9073119dd0ebff166acc': 'O1',
    '0x815542e8b392389a1389e22e588e4b62a67ade72': 'OpenLaunch',
    '0x7b9720bc177e8b6f96962e9b15891f27108cad40': 'Peach',
    '0x4b638c1502a07a8e1a26112ee98f51a3f34bc93a': 'RadarDEX',
    '0x18d33de5eefb2f91b09385f35f6a1317659cc1f9': 'Synthra',
    '0xcad7ee36ac193bf2eddb7b3e2736c5bdb8269c8b': 'TollyPad',
    '0x0dcad158e98bc24455f9e94f46709d8a5f6d1255': 'Warp',
    '0x27117b11c5c6f886eb1ffb32d814557aad4f6c43': 'Zyora',
  },
}
const platform = ctx.logearn?.platform
const chain = Number(ctx.logearn?.chain)
const chainPlatforms = CHAIN_PLATFORMS[chain]
const platformKey = chain === 3 ? String(platform || '') : String(platform || '').toLowerCase()
const chainPlatformName = chainPlatforms && Object.prototype.hasOwnProperty.call(chainPlatforms, platformKey)
  ? chainPlatforms[platformKey] : null
const isPump = chain === 3 && (chainPlatformName === 'Pump' || chainPlatformName === 'Pump AMM')
const isFour = chain === 56 && (chainPlatformName === 'Four' || chainPlatformName === 'Binance Four')
const isTargetPlatform = !!chainPlatformName
  && !(isPump && ctx.logearn?.is_fake_pump)
  && !(isFour && ctx.logearn?.is_fake_four)

const platformLabel = chainPlatformName ? `${chainPlatformName}(chain ${chain})`
  : `${platform || 'unknown'}(chain ${chain})`

// ---------- 取数据 ----------
const ki = ctx.kline_and_indicators || {}
const aoBars = Array.isArray(ki.ao_bars) ? ki.ao_bars : []
const logearn = ctx.logearn || {}
const gmgn = ctx.gmgn || {}
const dev = gmgn.dev || {}
const stat = gmgn.stat || {}
const chip = ctx.chip_analysis || {}
const symbol = logearn.symbol || ki.symbol || 'UNKNOWN'

const visitingCount = gmgn.visiting_count != null ? gmgn.visiting_count : 0

// gmgn 占比字段（0-1 小数 → 百分比）
const top10Pct = num(dev.top_10_holder_rate) * 100
const creatorPct = num(stat.creator_hold_rate) * 100
const ratPct = num(stat.top_rat_trader_percentage) * 100

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

// ---------- 逐条判定（顺序=优先级）----------
const checks = [
  ['平台', isTargetPlatform, platformLabel, 'Solana(3)/BSC(56)/Robinhood(4663)/Arc(5042)平台白名单'],
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

// ---------- 输出（全程仅一条日志，筹码摘要仅拼接展示、不参与 passed）----------
const head = VERSION + ' 访问' + visitingCount + ' [' + symbol + '] K' + ki.resolution + '  ' + chipSummary
const detail = checks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
const passed = checks.every((c) => c[1])
if (!passed) {
  const fails = checks.filter((c) => !c[1]).map((c) => `${c[0]}=${c[2]}`).join(' ')
  ctx.log.error('未命中 ' + head + ' | 失败:' + fails + '  ||  ' + detail)
  return false
}
ctx.log.success('命中<强势盘> ' + head + '  ' + detail)
return true