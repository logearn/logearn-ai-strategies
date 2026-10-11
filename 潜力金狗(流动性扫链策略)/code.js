// ==============================================================
// 下一个 Alpha 策略  v1.0.0（信号策略 / hook_signals）
// 目标：这些发射平台出来的新 token，刚从 $1 万流动性长上来、持仓结构健康时命中一次。
// 逻辑：四链平台白名单 + 判定——
//   1. 年龄 > 30 秒 且 < 30 分钟（刚发射的新盘，滤掉开盘瞬间脏数据）；
//   2. 流动性落在 [$1 万, $2 万] 窄带；
//   3. 历史最高市值 ≤ $30 万（挡掉早已冲很高的盘）；
//   4. 近 5 分钟秒均交易量 > $40（盘面有热度）；
//   5. 24h 买入次数 > 50；
//   6. 惯犯钱包占比 < 30%；
//   7. DEV 及关联占比 < 5%。
//
// 「首次/刚长上来」怎么保证（两重）：
//   · 窄带 [1万,2万]：只在刚突破 $1 万那阵成立；早已几十万的老 CA 流动性超 $2 万，天然被挡；
//   · 命中即终结：本策略须配 allow_multiple_hits=false，命中一次后不再复评该 token（见 pipeline.isTerminalHit）。
// 本策略是【信号策略】（hook_signals），故可用 ctx.holders（惯犯/DEV 分布）——这是和 token 流版的区别：
//   token 流能「随行情持续评估」但拿不到 holders；信号策略能用 holders 但只在信号触发那刻判断。此处选后者。
// 字段：ctx.logearn（platform/swap_begin_time/liquidity/max_up_mcap/volume_change_5m/buy_tx_count_d1）
//      + ctx.holders.distribution（habitual/dev）。
// ==============================================================

// ---------- 版本号 ----------
const VERSION = 'v1.0.0'

// ---------- 工具函数 ----------
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }

// ---------- 阈值常量 ----------
const AGE_MIN_SEC = 30      // 生命周期下限（秒）：> 30 秒（滤掉开盘瞬间脏数据）
// const AGE_MAX_MIN = 30      // 生命周期上限（分钟）：< 30 分钟
const LIQ_MIN = 10000       // 流动性下限（USD）：到 $1 万才算
const LIQ_MAX = 20000       // 流动性上限（USD）：挡掉早已几十万的老 CA——刚从 1 万长上来时还在窄窗内
const MAX_MCAP = 300000     // 历史最高市值上限（USD）：挡掉早已冲很高的盘
const VOL5M_PER_SEC_MIN = 100 // 近 5 分钟平均每秒交易量下限（USD）—— 盘面热度门槛
const BUYTX_MIN = 50        // 24h 买入次数下限
const HABITUAL_MAX = 30     // 惯犯钱包占比上限（%）—— < 此值才过
const DEV_HOLD_MAX = 5      // DEV及关联占比上限（%）—— < 此值才过

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
const logearn = ctx.logearn || {}
const symbol = logearn.symbol || 'UNKNOWN'
const ca = logearn.token_address

// ---------- 年龄 ----------
const nowTs = Math.floor(Date.now() / 1000)
const launchTime = num(logearn.swap_begin_time)
const ageSec = launchTime > 0 ? nowTs - launchTime : -1
const ageMin = launchTime > 0 ? ageSec / 60 : Infinity

// ---------- 流动性 / 最高市值 / 热度（全部取自 ctx.logearn，满足 token 流约束）----------
const liquidity = num(logearn.liquidity || logearn.pool_liquidity)
const maxMcap = num(logearn.max_up_mcap)                       // 历史最高市值（ATH，USD）
const vol5mPerSec = num(logearn.volume_change_5m) / (5 * 60)   // 近 5 分钟平均每秒交易量（USD）
const buyTxD1 = num(logearn.buy_tx_count_d1)                   // 24h 买入次数（<1 天的新盘即其生命周期内）

// ---------- 持仓结构（信号策略可用 ctx.holders；LogEarn 自有 holders 快照）----------
// ❌ 惯犯（distribution.risk.habitual：惯犯标签桶持仓/总发行量%）
const habitualPct = num(ctx.holders?.distribution?.risk?.habitual?.pct)
// 🐕 DEV及关联（distribution.risk.dev：DEV本人/关联群及同源簇持仓/总发行量%）
const devPct = num(ctx.holders?.distribution?.risk?.dev?.pct)

// ---------- 逐条判定 ----------
const checks = [
  ['平台', isTargetPlatform, platformLabel, 'Solana(3)/BSC(56)/Robinhood(4663)/Arc(5042)平台白名单'],
  // 年龄超过 30秒
  ['年龄(分)', launchTime > 0 && ageSec > AGE_MIN_SEC, Number.isFinite(ageMin) ? ageMin.toFixed(1) : 'NA', '>' + AGE_MIN_SEC + '秒'],
  // 首次到 $1 万
  ['流动性$', liquidity >= LIQ_MIN, liquidity.toFixed(0), LIQ_MIN],
    // 最高市值上限：挡掉早已冲很高的盘（max_up_mcap 缺失记 0，视为没冲高，放行）
  ['最高市值$', maxMcap <= MAX_MCAP, maxMcap.toFixed(0), '<= ' + MAX_MCAP],
  // 必须当前活跃，美妙交易 100 刀
  ['秒均交易量$', vol5mPerSec > VOL5M_PER_SEC_MIN, vol5mPerSec.toFixed(1), '> ' + VOL5M_PER_SEC_MIN],
  // 至少有 50次交易
  ['买入次数', buyTxD1 > BUYTX_MIN, buyTxD1, '> ' + BUYTX_MIN],
  //  垃圾，砸盘钱包不能超过 30%
  ['惯犯%', habitualPct < HABITUAL_MAX, habitualPct.toFixed(1), '< ' + HABITUAL_MAX],
  // dev 以及关联不能超过 5%
  ['DEV及关联%', devPct < DEV_HOLD_MAX, devPct.toFixed(1), '< ' + DEV_HOLD_MAX],
]

// ---------- 输出 ----------
const head = VERSION + ' [' + symbol + ']'
const detail = checks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
const passed = checks.every((c) => c[1])
if (!passed) {
  const fails = checks.filter((c) => !c[1]).map((c) => `${c[0]}=${c[2]}`).join(' ')
  ctx.log.error('未命中 ' + head + ' ❌ 失败:' + fails + '  ❌  ' + detail)
  return false
}
ctx.log.success('命中<下一个Alpha> ' + head + '  ' + detail)
return true
