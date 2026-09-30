// 苏醒接力策略 v1.3
// 四链平台白名单（Solana/BSC/Robinhood/Arc） + 30分钟内苏醒信号价格逐个抬高 + 最新苏醒在成本线上
// 阶段过滤：已毕业外盘且毕业满1h 通过；或 内盘但生命周期>24h 也通过（其余内盘/刚毕业1h内 过滤）
// 注：单地址持仓 / 转账持仓 / 精选信号 三条已停用（保留代码备查，chip 数据在部分平台不稳）
const STRATEGY_VERSION = 'v1.3'

// 四链全量平台列表：删除或注释某一行即可禁用该平台。
// 按链匹配平台白名单；Solana 地址区分大小写，EVM 平台标识统一小写。
const CHAIN_PLATFORMS = {
  // Solana (chain 3)
  3: {
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump',
    '9SkAtSxgNUMvT9bGb93v6rLU5MjW1XibykqoGtqT9dbg': 'WenDev',
    'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj': 'Launpad',
    'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1': 'LetsBonk 1',
    'BuM6KDpWiTcxvrpXywWFiw45R2RNH8WURdvqoTDV1BW4': 'LetsBonk 2',
    '4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4': 'Labs',
    'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'Pools',
    'FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM': 'Moonshit',
    'BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv': 'Bags',
    'GybkUNYVNk1FZMt9myAfvpSVgoKBgaueMTvszwBN4qYx': 'AnoncoinIt',
    '8rE9CtCjwhSmbwL5fbJBtRFsS3ohfMcDFeTTC7t4ciUA': 'Studio',
    '7UNpFBfTdWrcfS7aBQzEaPgZCfPJe8BDgHzwmWUZaMaF': 'TrendFun',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Whirl',
    'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG': 'Moonshot',
    'boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4': 'Boop',
    'HEAVENoP2qxoeuF8Dj2oT1GHEnu49U5mJYkdeC8BAX2o': 'Heaven',
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
    'uniswap': 'Uniswap',
    '0xc783221ab1db0244203458417981b4631e80b988': 'Launch.fun v1',
    '0x6fda94aceedc5a97171469a8873d00fb9983bb8c': 'Launch.fun v2',
    '0x77dc6f6361b7b99456fc3761ce5b7dda80d83f9d': 'Trench.today',
    '0x0000ffffbe8efe702c8703ae3477ff5de3d319c0': 'Pools.instant',
    '0x22e99278308b393ea1260859b181ad7e78f5eeed': 'Long.xyz',
    '0x8660a7f019c7943b0b0a91b8e39aff3b6db6ae62': 'Pair.fund',
    '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e': 'Pons V2',
    '0xce9c48cfa068947f77738c81be406b53338e5b0d': 'O1',
    '0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862': 'Doppler Airlock',
    '0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09': 'Flap.sh',
    '0x4f7609b3e944eaeae758341369055c1c24f3229a': 'Imortal',
    '0xbedd8e29ebbd8c6b233cdae3b25a4ae5227e65d9': 'Imortal',
    '0x44c8d2b22da696d90cd1b8cb3eaccb943ab005ca': 'Imortal',
    '0xc4edbe1df58ac18d2e1591b34ac6e929c1df0ce7': 'Imortal',
    '0xe64ac4113848bbc1a6dde1a6d1da96720a36f297': 'O1',
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

const num = (x) => {
  const n = Number(x)
  return Number.isFinite(n) ? n : 0
}

const logearn = ctx.logearn || {}
const ki = ctx.kline_and_indicators || {}
const chip = ctx.chip_analysis || {}
const symbol = logearn.symbol || 'UNKNOWN'

const deviationPct = num(ki.avg_price_deviation_pct)
const nowTs = Math.floor(Date.now() / 1000)

// 生命周期
const swapBegin = num(logearn.swap_begin_time)
const ageSec = swapBegin > 0 ? nowTs - swapBegin : Infinity
const ageDays = ageSec === Infinity ? Infinity : ageSec / 86400
const ageHours = ageSec === Infinity ? Infinity : ageSec / 3600

// 毕业（内盘->外盘）：launch_time 有值即已毕业
const launchTime = num(logearn.launch_time)
const launched = launchTime > 0
const afterLaunchSec = launched ? nowTs - launchTime : -1

// 阶段过滤：已毕业外盘且毕业满1h 通过；或 内盘但生命周期>24h 通过
const stagePass = (launched && afterLaunchSec >= 3600) || (!launched && ageHours > 24)
const stageActual = launched ? `外盘毕业${(afterLaunchSec / 60).toFixed(0)}分` : `内盘${ageHours === Infinity ? 'NA' : ageHours.toFixed(1)}h`

// 苏醒信号列表：新→旧
const wakeSorted = (Array.isArray(logearn.breakout_volume_10x_list) ? logearn.breakout_volume_10x_list : []).slice().sort((a, b) => num(b.signalTime) - num(a.signalTime))
const latestWake = wakeSorted[0] || null
const prevWake = wakeSorted[1] || null
const latestTime = latestWake ? num(latestWake.signalTime) : 0
const prevTime = prevWake ? num(prevWake.signalTime) : 0
const gap = prevWake ? latestTime - prevTime : -1

const WINDOW = 1800 // 30分钟
const inWindow = latestWake ? wakeSorted.filter(w => latestTime - num(w.signalTime) <= WINDOW).length : 0

// 苏醒信号价格（总量固定，用信号市值 notice_mcap 代表价格高低）
const latestMcap = latestWake ? num(latestWake.notice_mcap) : 0
const prevMcap = prevWake ? num(prevWake.notice_mcap) : 0

// 早期精选信号次数（当前停用，保留备查）
const featuredCount = (Array.isArray(logearn.continue_breakout_volume_list) ? logearn.continue_breakout_volume_list : []).length
const youngNeedFeatured = ageDays <= 30
const featuredPass = youngNeedFeatured ? featuredCount >= 2 : true

// 关注地址集合（当前停用，保留备查）
const followedSet = new Set()
;(Array.isArray(logearn.followed_list) ? logearn.followed_list : []).forEach(f => { if (f && f.wallet) followedSet.add(String(f.wallet).toLowerCase()) })
const wpm = logearn.followed_signal_state && logearn.followed_signal_state.walletPositionMap
if (wpm) Object.keys(wpm).forEach(w => followedSet.add(String(w).toLowerCase()))

// 排除关注地址后的头部持仓（当前停用，保留备查）
const nonFollowed = (Array.isArray(chip.top5_holders) ? chip.top5_holders : []).filter(h => h && !followedSet.has(String(h.wallet).toLowerCase()))
const maxHold = nonFollowed.reduce((m, h) => Math.max(m, num(h.total_hold_percent)), 0)
const maxTransferIn = nonFollowed.reduce((m, h) => Math.max(m, num(h.transfer_in_percent)), 0)

const checks = [
  ['平台', isTargetPlatform, platformLabel, 'Solana(3)/BSC(56)/Robinhood(4663)/Arc(5042)平台白名单'],
  ['阶段(外盘满1h或内盘>24h)', stagePass, stageActual, '外盘>=1h 或 内盘>24h'],
  ['30分钟内多苏醒', !!prevWake && inWindow > 1 && gap <= WINDOW, `${inWindow}个/间隔${gap}s`, '>1且<=1800s'],
  ['价格>前一个', !!prevWake && latestMcap > prevMcap, `${latestMcap.toFixed(0)}>${prevMcap.toFixed(0)}`, '当前市值>前一个'],
  ['成本线上', deviationPct > 0, deviationPct.toFixed(1) + '%', '>0'],
  // 以下三条已停用（保留备查）
  //['单地址持仓<=10', maxHold <= 10, maxHold.toFixed(1) + '%', '<=10'],
  //['转账持仓<=10', maxTransferIn <= 10, maxTransferIn.toFixed(1) + '%', '<=10'],
  //['精选信号(<=1月需>=2)', featuredPass, `年龄${ageDays === Infinity ? 'NA' : ageDays.toFixed(1)}天/精选${featuredCount}次`, youngNeedFeatured ? '>=2' : '不限(>1月)'],
]

const detail = `[${STRATEGY_VERSION}][${symbol}] ` + checks.map(([n, ok, a]) => `${n}(${ok ? 'Y' : 'N'}):${a}`).join(' | ')
if (!checks.every(c => c[1])) { ctx.log.error('未命中 ' + detail); return false }
ctx.log.success('命中 ' + detail)
return true