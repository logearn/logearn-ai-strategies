// ⚠️ Token 实时流策略：仅使用 ctx.logearn
// 斐波0.618 触发 + 跌破0.73过滤：回撤达 0.618（mcap<=max×0.382）触发，但回撤一旦跌破 0.73（mcap<max×0.27）直接过滤 / 历史市值>500k / 上限800k
const L = ctx.logearn || {}
const now = Math.floor(Date.now() / 1000)

// === 基本金狗条件 ===
// pump 发射
const isPump = String(L.platform_name || '').toLowerCase().includes('pump')

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
const nativePrice = L.chain === 56 ? (ctx.bnb_price || 0) : (ctx.sol_price || 0)
const vol24Coin = (L.buy_wcoin_amount_d1 || 0) + (L.sell_wcoin_amount_d1 || 0)
const vol24Usd = vol24Coin * nativePrice

// 回撤数据：取最近一轮回撤周期
const vList = L.v_breakout_volume_list || []

// === 反弹条件 ===
// 1. 当前价回撤到历史最高价斐波 0.618（触发点）：mcap <= maxMcap×(1-0.618) = maxMcap×0.382
const fibThreshold = maxMcap * (1 - 0.618) // 0.618 回撤对应市值 = maxMcap×0.382
const reachFib618 = maxMcap > 0 && mcap <= fibThreshold

// 2. 回撤跌破斐波 0.73 直接过滤：回撤超过 0.73 意味着 mcap < maxMcap×(1-0.73) = maxMcap×0.27
//    要求 mcap >= maxMcap×0.27，即回撤没跌破 0.73（跌太深的弱势盘不要）
const fib073Floor = maxMcap * (1 - 0.73) // 0.73 回撤对应市值 = maxMcap×0.27
const notBreak073 = maxMcap > 0 && mcap >= fib073Floor

// 3. 只玩外盘「首次」回撤达 0.618 后的反弹：
//    统计历史上回撤深度达到过 0.618 及以上、并且反弹已结束（fibon_break4_time 有值=突破前高）的周期数
//    只要有一个这样的已结束周期，说明此前已玩过一次深度反弹，本次属于「非首次」，直接 pass
const finishedDeepCycles = vList.filter(v => {
  const r = v.n_pattern_retracement || 0
  const ended = v.fibon_break4_time != null && v.fibon_break4_time > 0
  return r >= 0.618 && ended
}).length
const isFirstFibRebound = finishedDeepCycles === 0

const checks = [
  ['Pump发射', isPump, `${L.platform_name}`, '含 Pump'],
  ['创建时长(小时)', ageHours < 8, ageHours.toFixed(2), '< 8'],
  ['已发射外盘', !!migrated, !!migrated, '= true'],
  ['历史最高市值USD', maxMcap > 500000, maxMcap.toFixed(0), '> 500000'],
  ['当前买入市值上限USD', mcap <= 800000, mcap.toFixed(0), '<= 800000'],
  ['精选+共振+反弹+苏醒总次数', signalTotal >= 3, `精${featuredCnt}+共${whaleCnt}+反${vbCnt}+苏${awakeCnt}=${signalTotal}`, '>= 3'],
  ['24h成交额USD', vol24Usd >= 300000, vol24Usd.toFixed(0), '>= 300000'],
  ['垃圾钱包占比%', shit < 5, shit, '< 5'],
  ['新钱包占比%', newVol < 60, newVol, '< 60'],
  ['高频钱包占比%', freqVol < 50, freqVol, '< 50'],
  ['老钱包占比%', oldVol < 70, oldVol, '< 70'],
  ['蓝筹顶级赢家共振钱包数', whaleMax > 0, whaleMax, '> 0'],
  ['回撤达斐波0.618(mcap<=max×0.382)', reachFib618, `市值${mcap.toFixed(0)}`, `<= ${fibThreshold.toFixed(0)}`],
  ['未跌破斐波0.73(mcap>=max×0.27)', notBreak073, `市值${mcap.toFixed(0)}`, `>= ${fib073Floor.toFixed(0)}`],
  ['首次深度反弹(无已结束0.618周期)', isFirstFibRebound, `已结束深度周期${finishedDeepCycles}`, '= 0'],
]
const detail = checks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
const passed = checks.every(c => c[1])
if (!passed) {
  //ctx.log.error('未命中  ' + detail);
  return false
}
ctx.log.success('命中<回调前500k金狗0.618首次反弹>  ' + detail)
return true