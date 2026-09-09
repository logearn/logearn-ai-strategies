// 苏醒接力策略 v2.1（信号锚定版，草稿：与 code.js v1.2 并行对比，确认后替换）
// 【依赖 kline_and_indicators.kline_bars（市值口径）与 logearn.breakout_volume_10x_list，单币深度分析场景】
//
// 目标形态：活跃 → 死亡 → 复活。复活 = 苏醒信号本身（买入时机就是信号确认那一刻），
// 策略只负责回答：信号发生时，价格是否【突破了前面死亡区的上边缘】，以及死亡区之前是否【真的活跃过】。
//
//   活跃期（死亡区之前的 K 线）      死亡区（从信号往前逐根回溯自适应找边界）     T = 苏醒信号
//   |<── 高点 >= 上沿 × K ──>|<── 量小、价格在带内；时长 >= 6h，>= 8 根 ──>|  信号市值 > 上沿 × (1+buf)
//
// v2.1 相对 v2.0（状态机版）的取舍：
// 1. 不再用状态机在 K 线上"找"复活 bar——复活就是信号，信号来了才跑策略，找出来的也只能是它。
// 2. 死亡区边界从信号往前回溯得到，时长是算出来的结果不是输入；只保留时长/根数下限。
//    K 线无成交时段没有 bar（实测 11% 的 bar 间隔有缺口），所以一切按时间算，缺口视为死亡。
// 3. 死亡区回溯前允许跳过 <= PUMP_SKIP_MAX_SEC 的"复活拉升"（信号在 10x 放量之后才发，拉升可能已走了几根）。
// 4. 活跃期只用 K 线上死亡区之前的 bar 判定（logearn.max_up_mcap 只记录发射瞬间，不是历史高点，不可用）；
//    K 线窗口里看不到活跃期 → 判"活跃期不可见"，不放行。
// v1.2 的 30分钟内多苏醒 / 价格>前一个 / 成本线上 / 单地址持仓 / 转账持仓 / 精选信号 均已删除。
const VERSION = 'wake-v2.1'

const ALLOW_PLATFORMS = [
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump（SOL）
  'four.meme',                                    // four.meme（BSC）
  'binance_four.meme',                            // Binance four.meme（BSC）
  'flap',                                         // Flap
]

// ---------- 参数 ----------
const SIGNAL_FRESH_SEC = 600      // 苏醒信号新鲜度：now - signalTime <= 600s（买入时机就是信号，来晚了不追）
const CLUSTER_GAP_SEC = 3600      // 苏醒信号聚簇：相邻信号间隔 <= 1h 视为同一次复活
const PUMP_SKIP_MAX_SEC = 12 * 3600 // 簇首信号之前允许跳过的复活拉升时长上限（连续放量 bar 算拉升；超过 12h 就不是"刚复活"）
const DEAD_RANGE_PCT = 0.60       // 死亡区收盘价振幅 (maxC-minC)/minC <= 60%，超出即到达边界
const DEAD_VOL_SPIKE = 4          // 放量 bar：单根量 > 全窗口中位量 × 4
const DEAD_LOUD_RUN = 2           // 连续 N 根放量 bar 视为到达死亡区边界（单根毛刺容忍）
const DEAD_MIN_SEC = 6 * 3600     // 死亡区时长下限
const DEAD_MIN_BARS = 2           // 死亡区组成 bar 数下限（时长按缺口计，bar 数只要求能定出上沿；1 根太单薄）
const DEAD_VOL_RATIO = 0.5        // 死亡区每小时成交量 <= 活跃期每小时成交量 × 0.5
const MIN_ACTIVE_BARS = 1         // 活跃期至少可见 bar 数：发射拉盘也算活跃，有一根就行
const ACTIVE_ABOVE_DEAD = 1.5     // 活跃期最高 high >= 死亡区上沿 × 1.5
const BREAK_BUFFER = 0.03         // 突破：信号市值 > 上沿 × 1.03
const MAX_CHASE = 2.0             // 不追高（软条件）：信号市值 <= 上沿 × 3

// ---------- 工具 ----------
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }
const toSec = (t) => { const n = Number(t) || 0; return n > 1e12 ? Math.floor(n / 1000) : n }
const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const sumV = (arr) => arr.reduce((s, b) => s + b.v, 0)
const fmt = (x, d) => (d != null ? num(x).toFixed(d) : num(x).toPrecision(4))
const hrs = (s) => (s / 3600).toFixed(1) + 'h'
const parseResolution = (r) => {
  const s = String(r ?? '').trim().toUpperCase()
  if (/^\d+$/.test(s)) return Number(s) * 60
  const m = s.match(/^(\d+)([SDWH])$/)
  if (!m) return 0
  return Number(m[1]) * ({ S: 1, H: 3600, D: 86400, W: 604800 })[m[2]]
}

try {
  const logearn = ctx.logearn || {}
  const ki = ctx.kline_and_indicators || {}
  const symbol = logearn.symbol || ki.symbol || 'UNKNOWN'
  const nowSec = Math.floor(Date.now() / 1000)

  // ---------- 1. 基础门槛 ----------
  const launchTime = num(logearn.launch_time)
  const launched = launchTime > 0
  const afterLaunchSec = launched ? nowSec - launchTime : -1

  // ---------- 2. 苏醒信号（复活） ----------
  // 一次复活通常连发多个苏醒信号（实测 100 单全部 3h 内 >=2 个，间隔 5~30 分钟）。把间隔 <= CLUSTER_GAP_SEC 的
  // 连续信号聚成一个"苏醒簇"：死亡区从簇内【第一个】信号往前回溯（否则会把前一个苏醒的拉升当成死亡区边界），
  // 突破/买入判定用【最新】信号的市值（那才是买入价）。
  const wakeSorted = (Array.isArray(logearn.breakout_volume_10x_list) ? logearn.breakout_volume_10x_list : [])
    .filter((w) => toSec(w?.signalTime) > 0).sort((a, b) => toSec(b.signalTime) - toSec(a.signalTime)) // 新→旧
  const wake = wakeSorted[0] || null
  let clusterFirst = wake, clusterSize = wake ? 1 : 0
  for (let i = 1; i < wakeSorted.length; i++) {
    if (toSec(clusterFirst.signalTime) - toSec(wakeSorted[i].signalTime) > CLUSTER_GAP_SEC) break
    clusterFirst = wakeSorted[i]; clusterSize++
  }
  const sigTime = wake ? toSec(wake.signalTime) : 0            // 最新信号：买入时机
  const anchorTime = clusterFirst ? toSec(clusterFirst.signalTime) : 0 // 簇首信号：复活起点，死亡区回溯锚
  const sigAgeSec = sigTime > 0 ? nowSec - sigTime : -1
  // 信号市值：notice_mcap；缺失时退回当前市值
  const sigMcap = wake && num(wake.notice_mcap) > 0 ? num(wake.notice_mcap) : num(logearn.mcap)

  // ---------- 3. K 线整理（市值口径；原始新→旧，转时间正序） ----------
  const klineIsMcap = ki.kline_is_mcap !== false
  const mcapPerPrice = num(logearn.mcap) > 0 && num(ki.current_price) > 0 ? num(logearn.mcap) / num(ki.current_price) : 0
  const toMcap = (p) => (klineIsMcap ? p : p * mcapPerPrice) // 非市值口径 K 线换算到市值，与 notice_mcap 同口径
  // VWAP 换算到市值口径：current_avg_price 即 avg_price_bars 最新值；信号市值 ≈ 当前市值（触发即信号那一刻）
  const vwapPrice = num(ki.current_avg_price)
  const vwapMcap = klineIsMcap ? vwapPrice : vwapPrice * mcapPerPrice
  const vwapOk = vwapMcap > 0 && sigMcap > vwapMcap
  const bars = (Array.isArray(ki.kline_bars) ? ki.kline_bars : [])
    .map((b) => {
      const o = num(b?.open), c = num(b?.close)
      const h = Number.isFinite(Number(b?.high)) ? Number(b.high) : Math.max(o, c)
      const l = Number.isFinite(Number(b?.low)) ? Number(b.low) : Math.min(o, c)
      return { t: toSec(b?.time), o: toMcap(o), h: toMcap(h), l: toMcap(l), c: toMcap(c), v: num(b?.volume) }
    })
    .filter((b) => b.t > 0 && b.c > 0)
    .sort((a, b) => a.t - b.t)
  let resolutionSec = parseResolution(ki.resolution)
  if (resolutionSec <= 0 && bars.length >= 2) {
    const diffs = []
    for (let i = 1; i < bars.length; i++) { const d = bars[i].t - bars[i - 1].t; if (d > 0) diffs.push(d) }
    resolutionSec = median(diffs)
  }
  if (resolutionSec <= 0) resolutionSec = 60

  // 簇首信号所在 bar：起始时间 <= 簇首信号时间 的最后一根；死亡区回溯从它前一根开始
  let sigIdx = -1
  for (let i = 0; i < bars.length; i++) { if (bars[i].t <= anchorTime) sigIdx = i }

  // ---------- 4. 死亡区：从信号往前逐根回溯 ----------
  // 从 end 往前吸收 bar：价格带 <= DEAD_RANGE_PCT；量的边界 = 连续 DEAD_LOUD_RUN 根 > 全窗口中位量 × DEAD_VOL_SPIKE
  // （基线用全窗口中位量而不是区内中位量：死水区中位量只有几十，任何一根区内砸盘都会被误判成边界；
  //   连续多根才算边界，单根毛刺容忍）。碰到边界停止，边界 bar 不计入。
  const windowMedVol = median(bars.map((b) => b.v))
  const loudBar = (b) => b.v > DEAD_VOL_SPIKE * windowMedVol
  const walkDead = (end) => {
    const zone = []
    let hi = -Infinity, lo = Infinity, loudRun = 0
    for (let i = end; i >= 0; i--) {
      const b = bars[i]
      // 价格带只用收盘价：不用影线（死水区一根插针就顶破阈值），也不用开盘价（长缺口后第一根 bar 的 open
      // 是十几天前的最后成交价，会把带宽撑爆——SIRIUS 案例）
      const nh = Math.max(hi, b.c), nl = Math.min(lo, b.c)
      if (nl <= 0 || (nh - nl) / nl > DEAD_RANGE_PCT) break
      loudRun = loudBar(b) ? loudRun + 1 : 0
      if (loudRun >= DEAD_LOUD_RUN) { zone.splice(0, loudRun - 1); break } // 回吐已吸收的前几根放量 bar
      zone.unshift(b); hi = nh; lo = nl
    }
    return zone
  }
  // 跳过簇首信号之前的复活拉升 bar（信号在放量后才发，SIRIUS 案例拉了 3 根/12h 才发信号），
  // 按时间封顶 PUMP_SKIP_MAX_SEC——拉升超过这个时长就不是"刚复活"了。
  // 0~N 根跳过方案里取第一个能构成合法死亡区的；都不合法则记录时长最长的一个供日志。
  let dead = null, skipped = 0
  for (let skip = 0; sigIdx - 1 - skip >= 0; skip++) {
    const pumpStartIdx = sigIdx - skip
    if (bars[sigIdx].t - bars[pumpStartIdx].t > PUMP_SKIP_MAX_SEC) break
    const zone = walkDead(sigIdx - 1 - skip)
    if (!zone.length) continue
    const startIdx = sigIdx - 1 - skip - zone.length + 1
    // 死亡时长 = 上一根活跃 bar 收线 → 拉升开始。bar 间缺口 = 没成交 = 死亡，计入时长
    // （SIRIUS：死亡区只有 2 根 bar，但前面是 13 天没有一笔成交的空白，那才是真正的死亡）
    const deadFrom = startIdx > 0 ? bars[startIdx - 1].t + resolutionSec : zone[0].t
    const durSec = bars[pumpStartIdx].t - deadFrom
    const cand = { zone, startIdx, pumpStartIdx, durSec, upper: Math.max(...zone.map((b) => b.h)), lower: Math.min(...zone.map((b) => b.l)) }
    if (zone.length >= DEAD_MIN_BARS && durSec >= DEAD_MIN_SEC) { dead = cand; skipped = skip; break }
    if (!dead || durSec > dead.durSec) { dead = cand; skipped = skip }
  }
  const hasDead = !!dead
  const deadOk = hasDead && dead.zone.length >= DEAD_MIN_BARS && dead.durSec >= DEAD_MIN_SEC
  const deadVolPerHour = hasDead && dead.durSec > 0 ? sumV(dead.zone) / (dead.durSec / 3600) : 0
  const deadRangePct = hasDead && dead.lower > 0 ? (dead.upper - dead.lower) / dead.lower : 0

  // ---------- 5. 活跃期：死亡区之前的 K 线（发射拉盘也算活跃，哪怕只有一根 bar） ----------
  const active = hasDead ? bars.slice(0, dead.startIdx) : []
  const activeVisible = active.length >= MIN_ACTIVE_BARS
  const activeHigh = active.reduce((m, b) => Math.max(m, b.h), 0)
  const activeDurSec = activeVisible ? Math.max(resolutionSec, bars[dead.startIdx].t - active[0].t) : 0
  const activeVolPerHour = activeDurSec > 0 ? sumV(active) / (activeDurSec / 3600) : 0
  const activeAboveOk = activeVisible && hasDead && activeHigh >= dead.upper * ACTIVE_ABOVE_DEAD
  const deadQuietOk = activeVisible && activeVolPerHour > 0 && deadVolPerHour <= DEAD_VOL_RATIO * activeVolPerHour

  // ---------- 6. 复活：信号市值突破死亡区上沿 ----------
  const breakoutOk = hasDead && sigMcap > dead.upper * (1 + BREAK_BUFFER)
  const chaseRatio = hasDead && dead.upper > 0 ? sigMcap / dead.upper : 0
  const chaseOk = hasDead && chaseRatio <= 1 + MAX_CHASE

  // ---------- 7. 检查清单 ----------
  const checks = [
    ['平台', ALLOW_PLATFORMS.includes(logearn.platform), String(logearn.platform), 'pump/four/flap'],
    ['已毕业外盘', launched, launched ? '已毕业' : '内盘', 'launch_time>0'],
    ['毕业满1h', launched && afterLaunchSec >= 3600, launched ? (afterLaunchSec / 60).toFixed(0) + '分' : 'NA', '>=3600s'],
    ['苏醒信号新鲜', sigTime > 0 && sigAgeSec <= SIGNAL_FRESH_SEC, sigTime > 0 ? '距今' + sigAgeSec + 's' : '无信号', '<=' + SIGNAL_FRESH_SEC + 's'],
    ['信号bar定位', sigIdx >= 1, sigIdx >= 0 ? '簇首第' + sigIdx + '根/共' + bars.length + '/簇' + clusterSize + '个信号/跨' + ((sigTime - anchorTime) / 60).toFixed(0) + '分' : '无K线覆盖', '簇首信号落在K线内且前面有bar'],
    ['死亡区成立', deadOk, hasDead ? dead.zone.length + '根/' + hrs(dead.durSec) + '/振幅' + (deadRangePct * 100).toFixed(0) + '%/跳过拉升' + skipped + '根' : 'NA', '>=' + DEAD_MIN_BARS + '根 且 >=' + hrs(DEAD_MIN_SEC)],
    ['活跃期可见', activeVisible, hasDead ? active.length + '根/' + hrs(activeDurSec) : 'NA', '死亡区前>=' + MIN_ACTIVE_BARS + '根'],
    ['活跃高点在上沿上方', activeAboveOk, hasDead && activeVisible ? fmt(activeHigh, 0) + '/上沿' + fmt(dead.upper, 0) + '(' + (activeHigh / dead.upper).toFixed(2) + 'x)' : 'NA', '>= 上沿x' + ACTIVE_ABOVE_DEAD],
    ['死亡区缩量', deadQuietOk, hasDead && activeVisible ? fmt(deadVolPerHour, 0) + '/h vs 活跃' + fmt(activeVolPerHour, 0) + '/h(' + (activeVolPerHour > 0 ? (deadVolPerHour / activeVolPerHour).toFixed(2) : 'NA') + ')' : 'NA', '<= 活跃x' + DEAD_VOL_RATIO],
    ['突破死亡区上沿', breakoutOk, hasDead ? '信号市值' + fmt(sigMcap, 0) + '/上沿' + fmt(dead.upper, 0) + '(' + chaseRatio.toFixed(2) + 'x)' : 'NA', '> 上沿x' + (1 + BREAK_BUFFER)],
    ['信号市值站上VWAP', vwapOk, vwapMcap > 0 ? '信号市值' + fmt(sigMcap, 0) + '/VWAP' + fmt(vwapMcap, 0) + '(' + (sigMcap / vwapMcap).toFixed(2) + 'x)' : 'NA', '> VWAP'],
    ['未过度拉升', chaseOk, hasDead ? chaseRatio.toFixed(2) + 'x上沿' : 'NA', '<= 上沿x' + (1 + MAX_CHASE), true],
  ]

  const phase = !wake ? '无苏醒信号'
    : sigIdx < 1 ? 'K线未覆盖信号'
    : !hasDead ? '信号前无死水(直接撞边界)'
    : !deadOk ? '死亡区不足(' + dead.zone.length + '根/' + hrs(dead.durSec) + ')'
    : !activeVisible ? '死亡区成立/活跃期不在窗口内'
    : '活跃→死亡(' + hrs(dead.durSec) + ')→信号'
  const head = 'VER=' + VERSION + ' [' + symbol + '] K' + ki.resolution + '(' + resolutionSec + 's/' + bars.length + '根) 阶段=' + phase
  const fmtItem = ([n, ok, a, e, soft]) => `${n}${ok ? '✅' : soft ? '⚠️' : '❌'}: ${a} [期望 ${e}]`

  // 未命中把❌项排前面输出（日志会被截断，❌项在前保证截断只吃掉✅项）；软条件（soft=true）不拦截仅 ⚠️ 标注
  const fails = checks.filter((c) => !c[1] && !c[4])
  if (fails.length) {
    const rest = checks.filter((c) => c[1] || c[4])
    ctx.log.error('未命中 ' + head + ' 通过' + checks.filter((c) => c[1]).length + '/' + checks.length + '  ||  ' + fails.concat(rest).map(fmtItem).join('  |  '))
    return false
  }
  ctx.log.success('命中<苏醒复活买点> ' + head + '  ||  ' + checks.map(fmtItem).join('  |  '))
  return true
} catch (e) {
  ctx.log.error('策略异常: ' + (e && e.message ? e.message : String(e)))
  return false
}
