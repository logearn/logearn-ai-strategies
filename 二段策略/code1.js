// ==============================================================
// 二段策略第一层 v1
// 作用：消费 Token 实时流中的 ctx.logearn，筛出进入二段策略第二层(code2.js)
//       的候选代币；本文件只做初筛，不负责持仓筹码二次判断。
//
// 【前置条件】任一不满足即静默返回 false：
//   1. 发射平台必须在 Solana(3)/BSC(56)/Robinhood(4663)/Arc(5042) 白名单中；
//      Solana 平台区分大小写，EVM 平台标识统一转小写，并排除假 Pump/Four。
//   2. 创建时长 <8 小时。
//   3. 历史最高市值 >= $200,000。
//
// 【公共条件】进入斐波触发段后还必须全部满足：
//   1. 24小时成交额 >= $300,000。
//   2. 垃圾钱包占比 <5%。
//   3. 新钱包占比 <60%。
//   4. 高频钱包占比 <50%。
//   5. 老钱包占比 <70%。
//
// 【斐波触发】优先检测更深的 0.786，未命中再检测 0.618：
//   0.786：历史最高市值 >$220,000，当前市值位于 max×[0.15, 0.214]，
//          且历史没有已结束的 >=0.786 深度周期（首次深度反弹）。
//   0.618：历史最高市值 >$500,000，当前市值位于 max×[0.27, 0.382]，
//          且历史没有已结束的 >=0.618 深度周期（首次深度反弹）。
//   已结束周期定义：v.fibon_break4_time 存在且大于0。
//
// 【已停用条件】当前买入市值上限、信号总次数、蓝筹赢家数量等条件保留在代码注释中，
//              不参与当前 v1 判定。
// ==============================================================
const L = ctx.logearn || {}
const now = Math.floor(Date.now() / 1000)

// === 基本金狗条件 ===
// 按链匹配平台白名单；Solana 地址区分大小写，EVM 平台标识统一小写。
const CHAIN_PLATFORMS = {
  // Solana (chain 3)
  3: {
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump',
    'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'Pump AMM',
    '9SkAtSxgNUMvT9bGb93v6rLU5MjW1XibykqoGtqT9dbg': 'WenDev',
    'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj': 'Launpad',
    'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1': 'LetsBonk 1',
    'BuM6KDpWiTcxvrpXywWFiw45R2RNH8WURdvqoTDV1BW4': 'LetsBonk 2',
    '4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4': 'Labs',
    'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'Pools',
    'FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM': 'Moonshit',
    'Bov7gMQ88BQbtFMTxQ5e8grtrwG4ryQGAV9Mih2j9SxK': 'Dynamic DBC',
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
    '0x100765a16f42636bd84ee1e86bc5107b84bcdba3': 'Bankr'
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
const chain = Number(L.chain)
const chainPlatforms = CHAIN_PLATFORMS[chain]
const platformKey = chain === 3 ? String(L.platform || '') : String(L.platform || '').toLowerCase()
const chainPlatformName = chainPlatforms && Object.prototype.hasOwnProperty.call(chainPlatforms, platformKey)
  ? chainPlatforms[platformKey] : null
const isPump = chain === 3 && (chainPlatformName === 'Pump' || chainPlatformName === 'Pump AMM')
const isFour = chain === 56 && (chainPlatformName === 'Four' || chainPlatformName === 'Binance Four')
const isTargetPlatform = !!chainPlatformName
  && !(isPump && L.is_fake_pump)
  && !(isFour && L.is_fake_four)
const createTime = L.swap_begin_time || now
const ageHours = (now - createTime) / 3600
const migrated = !!L.launch_time && L.launch_time > 0
const maxMcap = L.max_up_mcap || 0
const mcap = L.mcap || 0
const shit = (typeof L.shit_volume === 'number') ? L.shit_volume : 999
const newVol = (typeof L.new_volume === 'number') ? L.new_volume : 999
const freqVol = (typeof L.frequent_volume === 'number') ? L.frequent_volume : 999
const oldVol = (typeof L.old_volume === 'number') ? L.old_volume : 999
const whaleMax = (L.whale_list || []).reduce((m, w) => Math.max(m, Number(w.whaleWalletCount) || 0), 0)
const featuredCnt = (L.continue_breakout_volume_list || []).length
const whaleCnt = (L.whale_list || []).length
const vbCnt = (L.v_breakout_volume_list || []).length
const awakeCnt = (L.breakout_volume_10x_list || []).length
const signalTotal = featuredCnt + whaleCnt + vbCnt + awakeCnt
const vol24Usd = L.volume_change_1d || 0
const vList = L.v_breakout_volume_list || []

// === 斐波触发判断 ===
// 0.786 触发：max×0.15 <= mcap <= max×0.214，历史市值 > 220k，且无已结束的 0.786 深度周期
const fib786Threshold = maxMcap * (1 - 0.786)
const fib786Floor     = maxMcap * (1 - 0.85)
const finished786Cycles = vList.filter(v => {
  const r = v.n_pattern_retracement || 0
  const ended = v.fibon_break4_time != null && v.fibon_break4_time > 0
  return r >= 0.786 && ended
}).length
const is786 = maxMcap > 220000 && mcap <= fib786Threshold && mcap >= fib786Floor && finished786Cycles === 0

// 0.618 触发：max×0.27 <= mcap <= max×0.382，历史市值 > 500k，且无已结束的 0.618 深度周期
const fib618Threshold = maxMcap * (1 - 0.618)
const fib618Floor     = maxMcap * (1 - 0.73)
const finished618Cycles = vList.filter(v => {
  const r = v.n_pattern_retracement || 0
  const ended = v.fibon_break4_time != null && v.fibon_break4_time > 0
  return r >= 0.618 && ended
}).length
const is618 = maxMcap > 500000 && mcap <= fib618Threshold && mcap >= fib618Floor && finished618Cycles === 0

// === 前置硬性条件 beforeChecks（不过则静默返回，不打日志）===
const beforeChecks = [
  ['目标平台', isTargetPlatform, chainPlatformName || String(L.platform || ''), '白名单平台'],
  ['创建时长(小时)', ageHours < 8, ageHours.toFixed(2), '< 8'],
  ['历史最高市值USD', maxMcap >= 200000, maxMcap.toFixed(0), '>= 200000'],
]
const beforeDetail = beforeChecks.map(([name, ok, actual, expect]) => `${name}(${ok ? '✅' : '❌'}): ${actual} [期望 ${expect}]`).join('  |  ') + `  |  platform=${L.platform || 'unknown'}`
const beforePassed = beforeChecks.every(c => c[1])
if (!beforePassed) {
  //ctx.log.error('beforeChecks未通过  ' + beforeDetail);
  return false
}

// === 公共条件 checks ===
const commonChecks = [
 // ['当前买入市值上限USD', mcap <= 800000, mcap.toFixed(0), '<= 800000'],
  //['精选+共振+反弹+苏醒总次数', signalTotal >= 2, `精${featuredCnt}+共${whaleCnt}+反${vbCnt}+苏${awakeCnt}=${signalTotal}`, '>= 2'],
  ['24h成交额USD', vol24Usd >= 300000, vol24Usd.toFixed(0), '>= 300000'],
  ['垃圾钱包占比%', shit < 5, shit, '< 5'],
  ['新钱包占比%', newVol < 60, newVol, '< 60'],
  ['高频钱包占比%', freqVol < 50, freqVol, '< 50'],
  ['老钱包占比%', oldVol < 70, oldVol, '< 70'],
 // ['蓝筹顶级赢家共振钱包数', whaleMax > 0, whaleMax, '> 0'],
]

// 斐波触发段：优先匹配 0.786（更深回撤），其次 0.618
let fibLabel, fibChecks
if (is786) {
  fibLabel = '0.786首次反弹(历史市值>220k)'
  fibChecks = [
    ['历史最高市值USD', maxMcap > 220000, maxMcap.toFixed(0), '> 220000'],
    ['回撤达斐波0.786(mcap<=max×0.214)', true, `市值${mcap.toFixed(0)}`, `<= ${fib786Threshold.toFixed(0)}`],
    ['未跌破斐波0.85(mcap>=max×0.15)', true, `市值${mcap.toFixed(0)}`, `>= ${fib786Floor.toFixed(0)}`],
    ['首次深度反弹(无已结束0.786周期)', true, `已结束深度周期${finished786Cycles}`, '= 0'],
  ]
} else if (is618) {
  fibLabel = '0.618首次反弹(历史市值>500k)'
  fibChecks = [
    ['历史最高市值USD', maxMcap > 500000, maxMcap.toFixed(0), '> 500000'],
    ['回撤达斐波0.618(mcap<=max×0.382)', true, `市值${mcap.toFixed(0)}`, `<= ${fib618Threshold.toFixed(0)}`],
    ['未跌破斐波0.73(mcap>=max×0.27)', true, `市值${mcap.toFixed(0)}`, `>= ${fib618Floor.toFixed(0)}`],
    ['首次深度反弹(无已结束0.618周期)', true, `已结束深度周期${finished618Cycles}`, '= 0'],
  ]
} else {
  //ctx.log.error(`未达斐波触发位  maxMcap=${maxMcap.toFixed(0)}  mcap=${mcap.toFixed(0)}  fib786Threshold=${fib786Threshold.toFixed(0)}  fib618Threshold=${fib618Threshold.toFixed(0)}`);
  return false
}

const checks = [...commonChecks, ...fibChecks]
const failedChecks = checks.filter(c => !c[1])
const passedChecks = checks.filter(c => c[1])
const sortedChecks = [...failedChecks, ...passedChecks]
const detail = sortedChecks.map(([name, ok, actual, expect]) => `${name}(${ok ? '✅' : '❌'}): ${actual} [期望 ${expect}]`).join('  |  ')
const passed = checks.every(c => c[1])
if (!passed) {
  ctx.log.error('未命中  ' + detail);
  return false
}
ctx.log.success(`命中<回调金狗${fibLabel}>  ` + detail)
return true
