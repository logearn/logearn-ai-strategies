// 威科夫策略 v1.9
// 【依赖 kline_and_indicators.kline_bars/avg_price_bars 与 logearn.v_breakout_volume_list，单币深度分析场景】
//
// v1.9 修复（899 条实盘日志漏斗分析，51% 卡在 SC放量）：
// 1. 【SC 锚定改为窗口内量最大根】原来用 V转 low_price_time 精确时间匹配，但“最低价那一秒”常落在
//    砸完之后的缩量假摔小 K 上（实盘大量 SC量 26/均234 这种倒挂案例），真正的天量恐慌根在它前后。
//    改为：vLowTime ±SC_TIME_TOLERANCE 窗口内取成交量最大的已收线 bar 作为 SC（符合威科夫 climax 定义）；
//    scLow 取窗口内最低 low（不用放量根自己的 low，否则 ST不破位/Spring 的锚会上移）。
// 2. 【未命中日志❌项排前面】原来按 checks 顺序全量输出，899 条实盘日志 100% 被截断，末端检查
//    （SOS三连门/成本线/AO/池子）的判定从没被看到过。改为❌项在前+通过计数，截断只会吃掉✅项。
//
// v1.8 新增：
// 【反弹慢于砸盘】反弹时长（SC底 → SOS突破，即吸筹区间实际时长）> 恐慌抛售时长（V转顶点 → 低点，
// 用信号自带时间戳 vLowTime - vTopTime）。恐慌砸盘是快速的，健康的吸筹反弹应慢于砸盘——
// 反弹比砸盘还快的多是资金对倒直拉，不是真吸筹。相当于把吸筹区间的固定时长下限换成动态下限。
// 威科夫因果法则：吸筹构建"因"需要时间，"因"的规模决定"果"。
// 【回测取舍】9 快照回放：拦下 Sovicat/SISYPUSS/Neeps 三个亏损单，但误杀 JLY(+478%) 和 PolarBear(+59%)
// ——盈利单的反弹/砸盘比值(26%/54%)落在亏损单区间(23%~75%)内部，该特征在现有样本上无区分度。
// 有意识地接受误杀：赌"拦小亏"出现频率远高于大赢家（方案c）。若后续实盘大赢家被杀率过高，回滚此检查。
//
// v1.7 新增（QUOKKA 实盘亏损单复盘，4 快照回放校准）：
// 1. 【AO峰值衰减】ao0 >= AO_PEAK_RATIO × 近6根AO峰值。QUOKKA 命中时 ao0=1609 仅为峰值3328的48%
//    ——动能衰减中的突破接力概率低（买后最高仅+23%）；其余三单 ao0 本身就是近期峰值，不受影响。
//    注意简单的 ao0>ao1 挡不住它（衰减途中有小反弹上勾），必须比峰值。
// 2. 【池子流动性】pool_liquidity >= MIN_POOL_LIQ。QUOKKA 池子仅$7.6K、42 仅$3K——这种深度下
//    几千美金就能画出"放量突破"，且实际成交滑点巨大，纸面涨幅兑现不了。正例池子均 $13K+。
//    代价：会挡掉 42（纸面+108%），换取过滤 QUOKKA 类必亏单，按可执行性优先取舍。
//
// v1.6 修复（OnlyMarms 实盘日志复盘）：
// 1. SC 定位排除最新一根未收线 bar（bar起始+粒度>当前时间视为未收线）。V低点落在刚开的小时线上时，
//    半成品 volume 会让"SC放量"必然误判；排除后 SC 锚到前一根完整的砸盘 bar，后续重触发评估可正常推进。
// 2. 阶段日志区分"结构未展开(SC刚发生,等待)"与"形态不符"，复盘时不再混淆。
// 注意：SOS 仍允许发生在未收线 bar 上（入场时效优先，等收线太慢），其放量/收位判定基于已累计部分。
//
// v1.5 修复（代码 review 采纳两条）：
// 1. 区间均量基线不再包含 SC 那根恐慌巨量（slice 起点 scIdx+1）——原来把 climax 塞进分母，
//    SOS 放量门槛被系统性抬高，真突破容易被误杀。
// 2. new_volume/shit_volume（24h 口径）为负=数据失效时，原来 -1<65 恒真、门槛静默失效；
//    改为显式判定：值有效（>=0）才启用检查，失效跳过并在日志标注。不按年龄关闭（本策略要吃老币）。
//
// v1.4 适配：平台K线粒度按 token 年龄自适应（calcAutoKlineResolution，1S~1D 保证 90~300 根）。
// 秒级粒度下"按根数"的阈值时间含义会坍缩（10根1S=10秒的"吸筹区间"、3根内突破=3秒就过期），
// 因此给根数阈值加时间双约束——不做升维聚合（极新币聚合后根数不够，该被过滤而不是被重采样）：
// 1. 吸筹区间：根数 >= RANGE_MIN_BARS 且实际时长 >= RANGE_MIN_SEC（2分钟，同 1.5段 V转持续下限口径）。
// 2. SOS新鲜度：距今 < SOS_FRESH_BARS 根【或】距今 <= SOS_FRESH_MAX_SEC 秒（秒级粒度下按根数几乎必然过期）。
//
// v1.3 新增：持仓结构门槛（合并自另一分支的修改）—— 新钱包持仓占比 < 65%，垃圾钱包持仓占比 < 2%。
//
// v1.2 改动（按 6 个实盘案例校准，3 正例 FDK/MEMIPEDE/cet、3 反例 BabyCate/CALLOUT/MEOW）：
// 1. 新增【SOS 站上成本线】硬性检查：SOS 收盘必须 > 突破时刻的成本线（avg_price_bars 回溯）。
//    三个反例的共同点是"反弹发生在成本线下方"（BabyCate 反弹到 24.9K 但成本线 14K 在头顶、
//    CALLOUT 价格 6.5K vs 成本线 33.9K）——成本线下方的突破上方全是套牢盘，不是 SOS 是 UT（上冲回落）。
// 2. 新增【当前在成本线上】检查：avg_price_deviation_pct > 0（口径同 1.5段/苏醒接力）。
// 3. 新增【吸筹区间时长】下限：SC 到 SOS 至少 RANGE_MIN_BARS 根。三个正例买点前都有充分横盘吸筹；
//    反例 MEOW 是 V 转后没有吸筹区间直接拉起再砸——回调完直接反弹的不叫吸筹，过滤掉。
// 4. 新增【AO 动能】检查：最新 AO > 0（正例 MEMIPEDE/cet 买点时 AO 均在零轴上方，反例均为负）。
//
// v1.1 修复：resolution 单位（"5"=5分钟，不是5秒）导致 SC 时间容差远小于一根K线、按时间几乎必然匹配失败的 bug。
// 现直接用实际 bar 间距作为粒度，与 vLowTime 的秒级时间戳对齐。
//
// 思路：消费 V转信号（v_breakout_volume_list），把 V转低点映射为威科夫吸筹模型的 SC（卖出高潮），
// 然后在 K线上依次校验吸筹四阶段，买点定在 SOS：
//   SC  (Selling Climax)   = V转回调低点，要求放量（恐慌抛售）
//   AR  (Automatic Rally)  = SC 后的自动反弹高点，定义交易区间上沿（阻力）
//   ST  (Secondary Test)   = 回落二次测试 SC 低点：不破位（允许小幅 Spring 假跌破）且量能萎缩
//   SOS (Sign of Strength) = 放量突破 AR 上沿【且站上成本线】的强势宽幅阳线 —— 唯一买点，且必须是"刚发生"
const VERSION = 'wyckoff-v1.9'

// ---------- 参数 ----------
const SC_VOL_MULT = 1.3      // SC 放量倍数：SC 量 > 前段均量 × 1.3
const SC_TIME_TOLERANCE = 3  // SC 定位容差（按 K线根数 × 实际bar间距）
const AR_MIN_RALLY = 0.10    // AR 有效反弹幅度下限（相对 SC 低点，10%）
const AR_PULLBACK = 0.33     // 从反弹高点回落超过涨幅的 1/3 视为 AR 确立、进入 ST
const ST_UNDERCUT = 0.05     // ST/Spring 允许跌破 SC 低点的幅度上限（5%）
const ST_VOL_SHRINK = 0.7    // ST 量能萎缩：ST 低点量 < SC 量 × 0.7
const SOS_VOL_MULT = 1.5     // SOS 放量倍数：突破量 > 区间均量 × 1.5
const SOS_CLOSE_POS = 0.6    // SOS 收盘位置：收在 bar 振幅上部 40% 内
const SOS_FRESH_BARS = 3     // SOS 新鲜度：突破必须发生在最近 N 根内（不追高）
const SOS_FRESH_MAX_SEC = 90 // SOS 新鲜度时间兜底：秒级粒度下按根数太苛刻，距今 <= N 秒也算新鲜
const MIN_BARS_BEFORE_SC = 5 // SC 前至少要有的 bar 数（算基准均量）
const RANGE_MIN_BARS = 10    // 吸筹区间时长下限：SC 到 SOS 至少 N 根（过滤 V 转直拉的假吸筹，反例 MEOW）
const RANGE_MIN_SEC = 120    // 吸筹区间实际时长下限（秒）：秒级粒度下 10 根只有几秒，不构成吸筹
const MAX_NEW_VOLUME = 65    // 新钱包持仓占比上限（%）
const MAX_SHIT_VOLUME = 5    // 垃圾钱包持仓占比上限（%）
const AO_PEAK_RATIO = 0.6    // AO 峰值衰减下限：ao0 >= 近6根峰值 × 0.6（挡动能衰减中的突破）
const AO_PEAK_LOOKBACK = 6   // AO 峰值回看根数
const MIN_POOL_LIQ = 10000   // 池子流动性下限（USD）：太浅的池子放量突破可被小资金伪造且无法成交

// ---------- 工具 ----------
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }
const toSec = (t) => { const n = Number(t) || 0; return n > 1e12 ? Math.floor(n / 1000) : n }
const avg = (a) => (a.length ? a.reduce((s, b) => s + b, 0) / a.length : 0)

try {
  const logearn = ctx.logearn || {}
  const ki = ctx.kline_and_indicators || {}
  const symbol = logearn.symbol || ki.symbol || 'UNKNOWN'

  // ---------- 1. 消费 V转信号（confirmed 且未收尾，取最新） ----------
  const vList = Array.isArray(logearn.v_breakout_volume_list) ? logearn.v_breakout_volume_list : []
  const vFinished = (v) => (num(v?.fibon_break4) > 0) || (v?.fibon_break4_time != null && num(v.fibon_break4_time) !== 0)
  let recentV = null
  for (const v of vList) {
    if (v?.n_pattern_confirmed !== true) continue
    if (vFinished(v)) continue
    if (!recentV || num(v.signalTime) > num(recentV.signalTime)) recentV = v
  }
  const hasEffectiveV = !!recentV
  const vTopTime = hasEffectiveV ? toSec(recentV.top_price_time) : 0
  const vLowTime = hasEffectiveV ? toSec(recentV.low_price_time) : 0

  // ---------- 2. K线整理（原始新→旧，转为时间正序） ----------
  const rawBars = Array.isArray(ki.kline_bars) ? ki.kline_bars : []
  const bars = rawBars
    .map((b) => {
      const o = num(b?.open), c = num(b?.close)
      const h = Number.isFinite(Number(b?.high)) ? Number(b.high) : Math.max(o, c)
      const l = Number.isFinite(Number(b?.low)) ? Number(b.low) : Math.min(o, c)
      return { t: toSec(b?.time), o, h, l, c, v: num(b?.volume) }
    })
    .filter((b) => b.t > 0 && b.c > 0)
    .sort((a, b) => a.t - b.t)

  // 【v1.1 关键修复】粒度按秒对齐：优先用实际相邻 bar 间距；兜底把 ki.resolution(分钟) 换算成秒
  let resolutionSec = 0
  if (bars.length >= 2) {
    const diffs = []
    for (let i = 1; i < bars.length; i++) { const d = bars[i].t - bars[i - 1].t; if (d > 0) diffs.push(d) }
    diffs.sort((a, b) => a - b)
    resolutionSec = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0 // 取中位数抗缺口
  }
  if (resolutionSec <= 0) resolutionSec = num(ki.resolution) > 0 ? num(ki.resolution) * 60 : 60

  // 成本线（VWAP）：按时间回溯取当时的值（avg_price_bars 新→旧），找不到历史 bar 退回当前成本线
  // （回溯逻辑同 1.5段策略 findAvgPriceAtTime；与 kline close 同口径，可直接比较）
  const avgPriceBars = (Array.isArray(ki.avg_price_bars) ? ki.avg_price_bars : []).map((b) => ({ t: toSec(b?.time), v: Number(b?.value) }))
  const currentAvgPrice = num(ki.current_avg_price)
  const costAt = (t) => {
    for (const b of avgPriceBars) { if (b.t <= t && Number.isFinite(b.v) && b.v > 0) return b.v }
    return currentAvgPrice > 0 ? currentAvgPrice : 0
  }

  // ---------- 3. SC：定位 V转低点对应的 bar，校验放量 ----------
  // 【v1.6】最新一根若还在走（bar 起始时间 + 粒度 > 当前时间）视为未收线：SC 不允许锚在它上面。
  // 半成品 bar 的 volume 只累计了一部分，拿去比"前段均量×2"必然失真（实测：V低点落在刚开1分钟的
  // 小时线上，量 6464 vs 均量 164748 被误判为"SC没放量"）。
  const nowSec2 = Math.floor(Date.now() / 1000)
  const lastBarInProgress = bars.length > 0 && bars[bars.length - 1].t + resolutionSec > nowSec2
  const scMaxIdx = bars.length - (lastBarInProgress ? 2 : 1) // SC 可落的最大索引（只允许已收线 bar）
  // 【v1.9】SC = 窗口内量最大根（climax），而非时间最近根：最低价那一秒常落在砸完后的缩量假摔小 K 上，
  // 真正的天量恐慌根在它前后 1~3 根。scLow 取窗口内最低 low，保持 ST/Spring 锚在真实底部。
  let scIdx = -1, scWindowLow = Infinity
  if (hasEffectiveV && vLowTime > 0 && scMaxIdx >= 0) {
    const tol = SC_TIME_TOLERANCE * resolutionSec
    let bestVol = -1
    for (let i = 0; i <= scMaxIdx; i++) {
      if (Math.abs(bars[i].t - vLowTime) > tol) continue
      if (bars[i].l < scWindowLow) scWindowLow = bars[i].l
      if (bars[i].v > bestVol) { bestVol = bars[i].v; scIdx = i }
    }
    // 容差内没匹配上：退回"高点之后最低 low 的那根"
    if (scIdx === -1 && vTopTime > 0) {
      let minLow = Infinity
      for (let i = 0; i <= scMaxIdx; i++) {
        if (bars[i].t < vTopTime) continue
        if (bars[i].l < minLow) { minLow = bars[i].l; scIdx = i }
      }
      scWindowLow = minLow
    }
  }
  const scOk = scIdx >= MIN_BARS_BEFORE_SC
  const scBar = scOk ? bars[scIdx] : null
  const preVols = scOk ? bars.slice(Math.max(0, scIdx - 10), scIdx).map((b) => b.v) : []
  const preAvgVol = avg(preVols)
  const scVolOk = scOk && preAvgVol > 0 && scBar.v > preAvgVol * SC_VOL_MULT
  const scLow = scOk ? (Number.isFinite(scWindowLow) ? scWindowLow : scBar.l) : 0

  // ---------- 4. AR：SC 后的自动反弹高点（区间上沿） ----------
  let arIdx = -1, arHigh = 0, arConfirmed = false
  if (scOk) {
    let runHigh = -Infinity, runIdx = -1
    for (let i = scIdx + 1; i < bars.length; i++) {
      if (bars[i].h > runHigh) { runHigh = bars[i].h; runIdx = i }
      const rally = runHigh - scLow
      if (rally > 0 && bars[i].c < runHigh - rally * AR_PULLBACK) { arConfirmed = true; break }
    }
    if (runIdx > 0) { arIdx = runIdx; arHigh = runHigh }
  }
  const arRallyPct = scLow > 0 ? (arHigh - scLow) / scLow : 0
  const arOk = arConfirmed && arIdx > scIdx && arRallyPct >= AR_MIN_RALLY

  // ---------- 5. ST/Spring：二次测试不破位 + 量能萎缩 ----------
  let stIdx = -1, stLow = Infinity, stVol = 0
  if (arOk) {
    for (let i = arIdx + 1; i < bars.length; i++) {
      if (bars[i].c > arHigh) break // 已突破上沿，ST 阶段结束
      if (bars[i].l < stLow) { stLow = bars[i].l; stIdx = i; stVol = bars[i].v }
    }
  }
  const hasSt = stIdx > arIdx
  const stHoldOk = hasSt && stLow >= scLow * (1 - ST_UNDERCUT)
  const stVolOk = hasSt && scBar && stVol < scBar.v * ST_VOL_SHRINK
  const stOk = hasSt && stHoldOk && stVolOk

  // ---------- 6. SOS：放量突破 AR 上沿的强势阳线，且刚发生 ----------
  let sosIdx = -1
  if (stOk) {
    for (let i = stIdx + 1; i < bars.length; i++) {
      if (bars[i].c > arHigh) { sosIdx = i; break }
    }
  }
  const hasSos = sosIdx > stIdx
  const sosBar = hasSos ? bars[sosIdx] : null
  // 区间均量基线从 SC 的下一根起算：SC 本身是恐慌巨量根，塞进分母会抬高 SOS 放量门槛（v1.5 修复）
  const rangeVols = hasSos ? bars.slice(scIdx + 1, sosIdx).map((b) => b.v) : []
  const rangeAvgVol = avg(rangeVols)
  const sosVolOk = hasSos && rangeAvgVol > 0 && sosBar.v > rangeAvgVol * SOS_VOL_MULT
  const sosSpread = hasSos ? sosBar.h - sosBar.l : 0
  const sosClosePos = sosSpread > 0 ? (sosBar.c - sosBar.l) / sosSpread : 1
  const sosStrongOk = hasSos && sosBar.c > sosBar.o && sosClosePos >= SOS_CLOSE_POS
  // 新鲜度双口径：根数（常规粒度）或 距今秒数（秒级粒度兜底），满足其一即可
  const sosBarsAgo = hasSos ? bars.length - 1 - sosIdx : -1
  const sosSecAgo = hasSos ? bars[bars.length - 1].t - sosBar.t : -1
  const sosFreshOk = hasSos && (sosBarsAgo < SOS_FRESH_BARS || sosSecAgo <= SOS_FRESH_MAX_SEC)

  // ---------- 7. 持仓结构门槛（v1.3，v1.5 加有效性判断）----------
  // new_volume/shit_volume 是最近 24h 口径的实时持仓指标，超过 24h 的老币可能为负（数据失效）。
  // 负值若直接比较会恒真（-1 < 65），静默变成"永远通过"——改为显式判定：值有效（>=0）才启用检查，
  // 失效则跳过并在日志标注，不按年龄关闭（正例 MEMIPEDE 是 17 天老币，本策略要吃老币）。
  const newVolRaw = Number(logearn.new_volume)
  const shitVolRaw = Number(logearn.shit_volume)
  const newVolValid = Number.isFinite(newVolRaw) && newVolRaw >= 0
  const shitVolValid = Number.isFinite(shitVolRaw) && shitVolRaw >= 0
  const newVolOk = !newVolValid || newVolRaw < MAX_NEW_VOLUME
  const shitVolOk = !shitVolValid || shitVolRaw < MAX_SHIT_VOLUME

  // ---------- 8. 实盘校准检查（v1.2）----------
  // 吸筹区间时长：SC → SOS 根数与实际时长双约束（秒级粒度下 10 根只有几秒，必须叠加时间下限）
  const rangeBars = hasSos ? sosIdx - scIdx : 0
  const rangeSec = hasSos ? sosBar.t - scBar.t : 0
  const rangeLenOk = hasSos && rangeBars >= RANGE_MIN_BARS && rangeSec >= RANGE_MIN_SEC
  // 反弹慢于砸盘（v1.8）：吸筹反弹时长必须 > 恐慌抛售时长（V顶→V低，信号时间戳口径）
  const dropSec = hasEffectiveV && vTopTime > 0 && vLowTime > vTopTime ? vLowTime - vTopTime : 0
  const reboundSlowOk = hasSos && dropSec > 0 && rangeSec > dropSec
  // SOS 必须站上突破时刻的成本线：成本线下方的"突破"是 UT（上冲回落），不是 SOS
  const costAtSos = hasSos ? costAt(sosBar.t) : 0
  const sosAboveCostOk = hasSos && costAtSos > 0 && sosBar.c > costAtSos
  // 当前仍在成本线上（快照时刻整体确认，口径同其他策略）
  const deviationPct = Number(ki.avg_price_deviation_pct)
  const nowAboveCostOk = Number.isFinite(deviationPct) && deviationPct > 0
  // AO 动能在零轴上方（最新一根）
  const aoBars = Array.isArray(ki.ao_bars) ? ki.ao_bars : []
  const ao0 = aoBars.length ? num(aoBars[0] && aoBars[0].value) : NaN
  const aoOk = Number.isFinite(ao0) && ao0 > 0
  // AO 峰值衰减（v1.7）：ao0 距近期峰值衰减过多 = 动能正在退潮，突破接力概率低。
  // 峰值 <= 0（AO 刚翻多，ao0 即峰值）时该检查自然通过
  const aoPeak = Math.max(...aoBars.slice(0, AO_PEAK_LOOKBACK).map((b) => num(b && b.value)), 0)
  const aoPeakOk = Number.isFinite(ao0) && (aoPeak <= 0 || ao0 >= aoPeak * AO_PEAK_RATIO)
  // 池子流动性（v1.7）
  const poolLiq = num(logearn.pool_liquidity)
  const poolOk = poolLiq >= MIN_POOL_LIQ

  // ---------- 汇总 ----------
  const fmt = (x, d = 6) => Number.isFinite(x) ? Number(Number(x).toFixed(d)) : 'NA'
  const checks = [
    ['K线就绪', bars.length >= MIN_BARS_BEFORE_SC + 5, bars.length + '根', '>= ' + (MIN_BARS_BEFORE_SC + 5)],
    ['新钱包持仓', newVolOk, newVolValid ? fmt(newVolRaw, 2) + '%' : '失效(' + fmt(newVolRaw, 2) + ',24h口径)跳过', '< ' + MAX_NEW_VOLUME + '%（值有效时）'],
    ['垃圾钱包持仓', shitVolOk, shitVolValid ? fmt(shitVolRaw, 2) + '%' : '失效(' + fmt(shitVolRaw, 2) + ',24h口径)跳过', '< ' + MAX_SHIT_VOLUME + '%（值有效时）'],
    ['有效V转', hasEffectiveV, hasEffectiveV ? 'y@' + num(recentV.signalTime) : 'n', 'confirmed且未收尾'],
    ['SC定位', scOk, scOk ? 'idx' + scIdx + '@' + scBar.t + '(粒度' + resolutionSec + 's)' : '未定位', 'V低点匹配到bar且前置>=' + MIN_BARS_BEFORE_SC + '根'],
    ['SC放量', scVolOk, scOk ? fmt(scBar.v, 0) + '/均' + fmt(preAvgVol, 0) : 'NA', '> 均量x' + SC_VOL_MULT],
    ['AR反弹', arOk, arOk || arIdx > 0 ? '高' + fmt(arHigh) + '(+' + (arRallyPct * 100).toFixed(1) + '%)' + (arConfirmed ? '已确立' : '未回落') : 'NA', '>=+' + (AR_MIN_RALLY * 100) + '%且已回落确立'],
    ['ST不破位', stHoldOk, hasSt ? '低' + fmt(stLow) + '/SC低' + fmt(scLow) : '无ST', '>= SC低x' + (1 - ST_UNDERCUT)],
    ['ST缩量', stVolOk, hasSt ? fmt(stVol, 0) + '/SC量' + fmt(scOk ? scBar.v : 0, 0) : '无ST', '< SC量x' + ST_VOL_SHRINK],
    ['SOS突破', hasSos, hasSos ? '收' + fmt(sosBar.c) + '>上沿' + fmt(arHigh) : '未突破', '收盘 > AR上沿'],
    ['SOS放量', sosVolOk, hasSos ? fmt(sosBar.v, 0) + '/区间均' + fmt(rangeAvgVol, 0) : 'NA', '> 区间均量x' + SOS_VOL_MULT],
    ['SOS强势', sosStrongOk, hasSos ? '阳线' + (sosBar.c > sosBar.o ? 'y' : 'n') + '/收位' + (sosClosePos * 100).toFixed(0) + '%' : 'NA', '阳线且收位>=' + (SOS_CLOSE_POS * 100) + '%'],
    ['SOS新鲜', sosFreshOk, hasSos ? '距今' + sosBarsAgo + '根/' + sosSecAgo + 's' : 'NA', '< ' + SOS_FRESH_BARS + '根 或 <= ' + SOS_FRESH_MAX_SEC + 's'],
    ['吸筹区间', rangeLenOk, hasSos ? rangeBars + '根/' + rangeSec + 's' : 'NA', '>= ' + RANGE_MIN_BARS + '根 且 >= ' + RANGE_MIN_SEC + 's'],
    ['反弹慢于砸盘', reboundSlowOk, hasSos ? '反弹' + rangeSec + 's/砸盘' + dropSec + 's' : 'NA', '反弹时长 > 砸盘时长(V顶→V低)'],
    ['SOS站上成本线', sosAboveCostOk, hasSos ? '收' + fmt(sosBar.c) + '/成本' + fmt(costAtSos) : 'NA', '收盘 > 突破时成本线'],
    ['当前成本线上', nowAboveCostOk, Number.isFinite(deviationPct) ? deviationPct.toFixed(1) + '%' : '缺失', '偏离% > 0'],
    ['AO动能', aoOk, Number.isFinite(ao0) ? fmt(ao0, 2) : '缺失', 'AO > 0'],
    ['AO峰值衰减', aoPeakOk, Number.isFinite(ao0) ? fmt(ao0, 0) + '/峰' + fmt(aoPeak, 0) + '(' + (aoPeak > 0 ? (ao0 / aoPeak * 100).toFixed(0) : 'NA') + '%)' : '缺失', '>= 峰值x' + AO_PEAK_RATIO],
    ['池子流动性', poolOk, '$' + fmt(poolLiq, 0), '>= $' + MIN_POOL_LIQ],
  ]

  // 结构可见性：SC 后已收线的 bar 数。太少说明 SC 刚发生、AR/ST/SOS 还没来得及形成——
  // 这是"等待结构展开"，不是"形态不符"，日志上区分开
  const barsAfterSc = scOk ? scMaxIdx - scIdx : 0
  const phase = !hasEffectiveV ? '无V转'
    : !scOk ? 'SC未定位'
    : !arOk ? (barsAfterSc < MIN_BARS_BEFORE_SC ? 'A阶段(SC刚发生,结构未展开,SC后仅' + barsAfterSc + '根收线bar,等待)' : 'A阶段(SC后待AR确立)')
    : !stOk ? 'B阶段(ST测试中)' : !hasSos ? 'C阶段(待SOS突破)' : 'D阶段(SOS)'
  const head = 'VER=' + VERSION + ' [' + symbol + '] K' + ki.resolution + ' 阶段=' + phase
  const fmtItem = ([n, ok, a, e]) => `${n}${ok ? '✅' : '❌'}: ${a} [期望 ${e}]`

  // 未命中把❌项排前面输出（v1.9：日志会被截断，❌项在前保证截断只吃掉✅项，漏斗分析不受影响）
  const fails = checks.filter((c) => !c[1])
  if (fails.length) {
    const passes = checks.filter((c) => c[1])
    ctx.log.error('未命中 ' + head + ' 通过' + passes.length + '/' + checks.length + '  ||  ' + fails.concat(passes).map(fmtItem).join('  |  '))
    return false
  }
  ctx.log.success('命中<威科夫SOS买点> ' + head + '  ||  ' + checks.map(fmtItem).join('  |  '))
  return true
} catch (e) {
  ctx.log.error('策略异常: ' + (e && e.message ? e.message : String(e)))
  return false
}