// ==============================================================
// 单代币强势盘策略 v1
// 执行顺序：拉黑检查 → 前置静默过滤 → 命中条件与日志。
//
// 【拉黑】币龄 >60秒，且以下任一垃圾钱包占比 >=10%：
//   logearn.shit_volume / holders.distribution.risk.shit.pct。
//   命中后加入本策略黑名单、输出日志并返回 false；拉黑先于平台过滤。
//
// 【前置过滤】以下全部满足才继续，否则静默返回 false：
//   1. 平台在 Solana(3)/BSC(56)/Robinhood(4663)/Arc(5042)已配置白名单中，排除假Pump/Four。
//   2. 0 < 市值 < $120,000（取 current_mcap、mcap、fdv 三者最大值）。
//   3. 最新AO >0，且 >上一根AO。
//   4. 最新AC >0，且 >上一根AC；AC=当前AO减包含自身的近5根AO均值，至少需6根AO数据。
//
// 【命中条件】以下全部满足才返回 true，否则输出未命中日志：
//   1. 优质持仓 >5%（holders.stats.quality.good_pct）。
//   2. 大底座持仓 >10%（holders.distribution.push.low_base.pct）。
//   3. 惯犯持仓 <30%（holders.distribution.risk.habitual.pct）。
//   4. 同批次新号持仓 <10%（holders.distribution.risk.cluster_batch.pct）；缺失或无效拒绝。
//   5. DEV及关联持仓 <5%（holders.distribution.risk.dev.pct）；不达标仅拒绝，不拉黑。
//   6. 近5分钟秒均成交额 >$40（volume_change_5m / 300，即5分钟成交额 >$12,000）。
//   7. 24小时买入次数 >50（buy_tx_count_d1）。
//   8. 2% < 成本线偏离 <120%（avg_price_deviation_pct）。
//
// 【未启用】币龄1～500分钟命中限制、狙击及关联 >30%拉黑均已注释。
// 【仅展示】上下方筹码、总持仓、内盘卖出率、内盘剩余持仓不参与判定。
// Holders持仓占比按总发行量计，单位%；除同批次新号外，数值缺失/非有限值由num转为0。
// ==============================================================

// ---------- 版本号 ----------
const VERSION = 'v1'

// ---------- 工具函数 ----------
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }
const sma = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0)

// ---------- 阈值常量 ----------
const MCAP_MAX = 120000     // 有效市值上限（USD）
const DEV_MIN = 2           // 成本线偏离下限（%）
const DEV_MAX = 120         // 成本线偏离上限（%）
const AGE_MIN_SEC = 60      // 拉黑年龄门：严格 >60秒；命中年龄下限检查已注释
const AGE_MAX_MIN = 500     // 预留生命周期上限（分钟），命中检查已注释
const SHIT_MAX = 10          // 垃圾钱包占比上限（%）—— 黑名单组：>= 此值即拉黑（两个数据源共用）
const SNIPER_MAX = 30       // 预留狙击及关联钱包占比上限（%），拉黑检查已注释
const BUYTX_MIN = 50        // 24h 买入次数下限
const GOOD_PCT_MIN = 5      // Holders 优质持仓占比下限（%）
const LOW_BASE_MIN = 10     // 大底座（低价底仓）占比下限（%）—— > 此值才算底部有控盘筹码
const HABITUAL_MAX = 30     // 惯犯钱包占比上限（%）—— < 此值才过（惯犯太多=砸盘惯性强）
const CLUSTER_BATCH_MAX = 10 // 同批次新号钱包持仓占总发行量须 <10%
const DEV_HOLD_MAX = 5      // DEV及关联占比上限（%）—— < 此值才过（DEV 控盘太多=砸盘风险）
const VOL5M_PER_SEC_MIN = 40 // 近 5 分钟平均每秒交易量下限（USD）—— 盘面热度门槛

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

// ---------- 取数据（已移除 ctx.gmgn 全部依赖）----------
const ki = ctx.kline_and_indicators || {}
const aoBars = Array.isArray(ki.ao_bars) ? ki.ao_bars : []
const logearn = ctx.logearn || {}
const chip = ctx.chip_analysis || {}
const symbol = logearn.symbol || ki.symbol || 'UNKNOWN'
const ca = logearn.token_address

// ---------- Holders（LogEarn 自有快照，不需 GMGN key）----------
const holdersStats = ctx.holders?.stats || {}
const goodPct = num(holdersStats.quality?.good_pct)   // 优质持仓占比%（已是百分比口径）
// 🔫 狙击仓及关联（distribution.risk.sniper：开盘前入场/sniper_group 及关联，pct = 持仓/总发行量%）
const sniperPct = num(ctx.holders?.distribution?.risk?.sniper?.pct)
// 🗑 垃圾钱包标签桶（distribution.risk.shit：pct = 该桶持仓/总发行量%）
const shitHoldersPct = num(ctx.holders?.distribution?.risk?.shit?.pct)
// 🏗 大底座（distribution.push.low_base：底部低价控盘筹码持仓/总发行量%）
const lowBasePct = num(ctx.holders?.distribution?.push?.low_base?.pct)
// ❌ 惯犯（distribution.risk.habitual：惯犯标签桶持仓/总发行量%）
const habitualPct = num(ctx.holders?.distribution?.risk?.habitual?.pct)
const clusterBatchPct = ctx.holders?.distribution?.risk?.cluster_batch?.pct
const clusterBatchValid = typeof clusterBatchPct === 'number' && Number.isFinite(clusterBatchPct) && clusterBatchPct >= 0 && clusterBatchPct <= 100
// 🐕 DEV及关联（distribution.risk.dev：DEV本人/关联群及同源簇持仓/总发行量%）
const devPct = num(ctx.holders?.distribution?.risk?.dev?.pct)

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
// 近 5 分钟平均每秒交易量（USD）：volume_change_5m 是过去 5 分钟总交易量（USD）→ ÷ 300 秒
const vol5mPerSec = num(logearn.volume_change_5m) / (5 * 60)

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

// ---------- 黑名单条件组（命中即永久拉黑并淘汰；本策略黑名单）----------
const shitVolPct = num(logearn.shit_volume)
const blacklistChecks = [
  ['垃圾钱包(持仓量)占比过高', shitVolPct >= SHIT_MAX, shitVolPct.toFixed(1), '>= ' + SHIT_MAX],
  ['垃圾钱包(Holders桶)占比过高', shitHoldersPct >= SHIT_MAX, shitHoldersPct.toFixed(1), '>= ' + SHIT_MAX],
 // ['狙击及关联占比过高', sniperPct > SNIPER_MAX, sniperPct.toFixed(1), '> ' + SNIPER_MAX],
]
const blackHit = blacklistChecks.filter((c) => c[1])
// 年龄门：仅当年龄 > 1 分钟（AGE_MIN_SEC）才启动拉黑——太早(开盘头 1 分钟)数据不稳、狙击/垃圾占比易虚高，
// 过早拉黑会误杀后续正常起爆的盘（拉黑是永久的，宁可晚拉也别错拉）。
if (blackHit.length && ageSec > AGE_MIN_SEC) {
  const reason = blackHit.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
  ctx.add_blacklist(ca, reason)
  // 按用户要求：拉黑的同时本策略也自行输出一条日志
  ctx.log.error('本策略拉黑 ' + VERSION + ' [' + symbol + '] ' + reason)
  return false
}

// ---------- 前置静默条件 beforeChecks（不过则静默返回，不打日志）----------
const beforeChecks = [
  ['平台', isTargetPlatform, platformLabel, 'Solana(3)/BSC(56)/Robinhood(4663)/Arc(5042)平台白名单'],
  ['市值', effMcap > 0 && effMcap < MCAP_MAX, effMcap.toFixed(0), '>0 且 < ' + MCAP_MAX],
  ['AO', aoOk, ao0.toFixed(0) + '/' + ao1.toFixed(0), 'ao0>0 且 ao0>ao1'],
  ['AC', acOk, (ac0 === null ? 'NA' : ac0.toFixed(1)) + '/' + (ac1 === null ? 'NA' : ac1.toFixed(1)), 'ac0>0 且 ac0>ac1']
]
const beforePassed = beforeChecks.every(c => c[1])
if (!beforePassed) {
  return false
}

// ---------- 逐条判定（顺序=优先级）----------
const checks = [
  // ['年龄(秒)', launchTime > 0 && ageSec >= AGE_MIN_SEC, ageSec, '>= ' + AGE_MIN_SEC],
  // ['年龄(分)', launchTime > 0 && ageMin <= AGE_MAX_MIN, Number.isFinite(ageMin) ? ageMin.toFixed(1) : 'NA', '<= ' + AGE_MAX_MIN],
  ['优质持仓%', goodPct > GOOD_PCT_MIN, goodPct.toFixed(2), '> ' + GOOD_PCT_MIN],
  ['大底座%', lowBasePct > LOW_BASE_MIN, lowBasePct.toFixed(1), '> ' + LOW_BASE_MIN],
  ['惯犯%', habitualPct < HABITUAL_MAX, habitualPct.toFixed(1), '< ' + HABITUAL_MAX],
  ['同批次新号钱包持仓%', clusterBatchValid && clusterBatchPct < CLUSTER_BATCH_MAX, clusterBatchValid ? clusterBatchPct.toFixed(2) : '缺失或无效', '< ' + CLUSTER_BATCH_MAX],
  ['DEV及关联%', devPct < DEV_HOLD_MAX, devPct.toFixed(1), '< ' + DEV_HOLD_MAX],
  ['秒均交易量$', vol5mPerSec > VOL5M_PER_SEC_MIN, vol5mPerSec.toFixed(1), '> ' + VOL5M_PER_SEC_MIN],
  ['买入次数', buyTxD1 > BUYTX_MIN, buyTxD1, '> ' + BUYTX_MIN],
  ['偏离%', deviationPct > DEV_MIN && deviationPct < DEV_MAX, deviationPct.toFixed(1), DEV_MIN + '~' + DEV_MAX],
]

// ---------- 输出（全程仅一条日志，筹码摘要仅拼接展示、不参与 passed）----------
const head = VERSION + ' [' + symbol + '] K' + ki.resolution + '  ' + chipSummary
const detail = checks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
const passed = checks.every((c) => c[1])
if (!passed) {
  const fails = checks.filter((c) => !c[1]).map((c) => `${c[0]}=${c[2]}`).join(' ')
  ctx.log.error('未命中 ' + head + ' ❌ 失败:' + fails + '  ❌  ' + detail)
  return false
}
ctx.log.success('命中<强势盘> ' + head + '  ' + detail)
return true
