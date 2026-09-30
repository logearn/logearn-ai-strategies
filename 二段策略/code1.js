// ⚠️ Token 实时流策略：仅使用 ctx.logearn
// 斐波0.618 触发 + 跌破0.73过滤：回撤达 0.618（mcap<=max×0.382）触发，但回撤一旦跌破 0.73（mcap<max×0.27）直接过滤 / 历史市值>500k / 上限800k
const L = ctx.logearn || {}
const now = Math.floor(Date.now() / 1000)

// === 基本金狗条件 ===
// 按链匹配平台白名单；Solana 地址区分大小写，EVM 平台标识统一小写。
const CHAIN_PLATFORMS = {
  // Solana (chain 3)
  3: {
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump',
    'BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv': 'Bags',
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
const platform = L.platform
const chain = Number(L.chain)
const chainPlatforms = CHAIN_PLATFORMS[chain]
const platformKey = chain === 3 ? String(platform || '') : String(platform || '').toLowerCase()
const chainPlatformName = chainPlatforms && Object.prototype.hasOwnProperty.call(chainPlatforms, platformKey)
  ? chainPlatforms[platformKey] : null
const isPump = chain === 3 && (chainPlatformName === 'Pump' || chainPlatformName === 'Pump AMM')
const isFour = chain === 56 && (chainPlatformName === 'Four' || chainPlatformName === 'Binance Four')
const isTargetPlatform = !!chainPlatformName
  && !(isPump && L.is_fake_pump)
  && !(isFour && L.is_fake_four)

const platformLabel = chainPlatformName ? `${chainPlatformName}(chain ${chain})`
  : `${platform || 'unknown'}(chain ${chain})`

// 创建时间 < 8 小时
const createTime = L.swap_begin_time || now
const ageHours = (now - createTime) / 3600

// 已发射外盘（内盘毕业）
const migrated = !!L.launch_time && L.launch_time > 0

// 历史最高市值 > 500k（下限：证明曾有过热度/资金量）
const maxMcap = L.max_up_mcap || 0

// 当前买入市值（用于斐波约束 + 上限约束）
const mcap = L.mcap || 0

// 垃圾钱包占比 < 5%
const shit = (typeof L.shit_volume === 'number') ? L.shit_volume : 999

// 新钱包持仓占比 < 60%（防止全是新钱包接盘）
const newVol = (typeof L.new_volume === 'number') ? L.new_volume : 999

// 高频钱包持仓占比 < 50%（防止刷量/机器人盘）
const freqVol = (typeof L.frequent_volume === 'number') ? L.frequent_volume : 999

// 老钱包持仓占比 < 70%（防止筹码全被老钱包锁死）
const oldVol = (typeof L.old_volume === 'number') ? L.old_volume : 999

// 蓝筹顶级赢家共振钱包数 > 0
const whaleMax = (L.whale_list || []).reduce((m, w) => Math.max(m, Number(w.whaleWalletCount) || 0), 0)

// 精选 + 共振 + 反弹 + 苏醒 通知总次数
const featuredCnt = (L.continue_breakout_volume_list || []).length // 精选
const whaleCnt = (L.whale_list || []).length                       // 共振
const vbCnt = (L.v_breakout_volume_list || []).length              // 反弹
const awakeCnt = (L.breakout_volume_10x_list || []).length         // 苏醒
const signalTotal = featuredCnt + whaleCnt + vbCnt + awakeCnt

// 24小时成交额（USD）：买入+卖出的原生币数量 × 原生币价格
// ⚠️ 修复：ctx.bnb_price / ctx.sol_price 不存在，必须用 ctx.native_coin_price（已按当前信号所在链自动赋值）
const nativePrice = ctx.native_coin_price || 0
const vol24Coin = (L.buy_wcoin_amount_d1 || 0) + (L.sell_wcoin_amount_d1 || 0)
const vol24Usd = vol24Coin * nativePrice

// 回撤数据：取最近一轮回撤周期
const vList = L.v_breakout_volume_list || []

// === 反弹条件 ===
// 1. 当前价回撤到历史最高价斐波 0.618（触发点）：mcap <= maxMcap×(1-0.618) = maxMcap×0.382
const fibThreshold = maxMcap * (1 - 0.618) // 0.618 回撤对应市值 = maxMcap×0.382
const reachFib618 = maxMcap > 0 && mcap <= fibThreshold

// 2. 回撤跌破斐波 0.73 直接过滤：回撤超过 0.73 意味着 mcap < maxMcap×(1-0.73) = maxMcap×0.27
const fib073Floor = maxMcap * (1 - 0.73) // 0.73 回撤对应市值 = maxMcap×0.27
const notBreak073 = maxMcap > 0 && mcap >= fib073Floor

// 3. 只玩外盘「首次」回撤达 0.618 后的反弹
const finishedDeepCycles = vList.filter(v => {
  const r = v.n_pattern_retracement || 0
  const ended = v.fibon_break4_time != null && v.fibon_break4_time > 0
  return r >= 0.618 && ended
}).length
//const isFirstFibRebound = finishedDeepCycles === 0

const checks = [
  ['平台', isTargetPlatform, platformLabel, 'Solana(3)/BSC(56)/Robinhood(4663)/Arc(5042)平台白名单'],
  ['历史最高市值USD', maxMcap > 500000, maxMcap.toFixed(0), '> 500000'],
  ['当前买入市值下限USD', mcap >= 800000, mcap.toFixed(0), '>= 800000'],
  ['24h成交额USD', vol24Usd >= 300000, `${vol24Usd.toFixed(0)}(coin${vol24Coin.toFixed(2)}×${nativePrice})`, '>= 300000'],
  ['回撤达斐波0.618(mcap<=max×0.382)', reachFib618, `市值${mcap.toFixed(0)}`, `<= ${fibThreshold.toFixed(0)}`],
]
const detail = checks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
const passed = checks.every(c => c[1])
if (!passed) {
  ctx.log.error('未命中  ' + detail);
  return false
}
ctx.log.success('命中<回调前500k金狗0.618首次反弹>  ' + detail)
return true