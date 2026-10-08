// 威科夫策略 v3.6 精简版
// SC → AR → SOS 结构（ST仅展示）；V转高点至所选信号时间必须 > 2小时（B口径：signalTime - top_price_time）。
// v3.5：同步1.5段策略的平台白名单及假Pump/Four过滤。
// v3.1：已完成突破的 V转也参与检测，按 signalTime 选最新已确认信号。
// 历史最高市值 max_up_mcap 必须 > 500k。
// v3.0 新增：当前市值 > 100k（logearn.mcap）。
// 不限制 SC 至 SOS 区间时长、SOS 成交量；SOS 仅要求最新 close > AR 上沿。
// 依赖 logearn.v_breakout_volume_list、kline_and_indicators.kline_bars；chip_analysis.price_bars 仅用于日志。
// SC低点至AR高点的区间筹码占比仅输出，不参与判断；边界桶按市值重叠宽度估算。
// V转用于定位 SC；当前最新K线为SOS候选，之前各次已确认反弹的最高点为AR。
// ST 从最终AR之后至SOS候选之前寻找，仅展示支撑测试，不参与命中判断。
// 移除 SC 放量、前置均量样本数、SOS 阳线/收位、成本线、持仓占比和池子过滤。
// SOS：最新 close > AR 上沿；不检查前一根位置，允许最新 K线尚未收线。
// 历史突破不直接命中；当前仍在上沿上方时可持续满足 SOS。
const VERSION = 'wyckoff-v3.6'

// ---------- 参数 ----------
const MIN_HISTORICAL_MCAP = 500000 // 历史最高市值（USD），严格大于500k
const MIN_MCAP = 100000 // 当前市值下限（USD），严格大于 100k
const V_MIN_DURATION_SEC = 2 * 3600 // B口径：V转signalTime减高点时间，严格大于2小时
const V_MIN_RETRACEMENT = 0.60 // 所选V转回撤深度，严格大于60%
const SC_TIME_TOLERANCE = 3  // SC 定位容差（按 K线根数 × 实际bar间距）
const AR_MIN_RALLY = 0.05    // AR 有效反弹幅度下限（v2.1 放宽 10%→5%，横盘窄区间币反弹幅度小）
const AR_PULLBACK = 0.33     // 从反弹高点回落超过涨幅的 1/3 视为 AR 确立、进入 ST
const ST_UNDERCUT = 0.05     // ST/Spring 允许跌破 SC 低点的幅度上限（5%）

// ---------- 工具 ----------
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }
const toSec = (t) => { const n = Number(t) || 0; return n > 1e12 ? Math.floor(n / 1000) : n }

try {
  const logearn = ctx.logearn || {}
  const ki = ctx.kline_and_indicators || {}
  const symbol = logearn.symbol || ki.symbol || 'UNKNOWN'

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

  // ---------- 0. 当前市值 ----------
  const mcap = num(logearn.mcap)
  const mcapOk = mcap > MIN_MCAP
  const historicalMcap = num(logearn.max_up_mcap)
  const historicalMcapOk = historicalMcap > MIN_HISTORICAL_MCAP

  // ---------- 1. 消费 V转信号（取最新 confirmed，包含已完成突破的信号） ----------
  const vList = Array.isArray(logearn.v_breakout_volume_list) ? logearn.v_breakout_volume_list : []
  let recentV = null
  for (const v of vList) {
    if (v?.n_pattern_confirmed !== true) continue
    if (!recentV || num(v.signalTime) > num(recentV.signalTime)) recentV = v
  }
  const hasEffectiveV = !!recentV
  const vTopTime = hasEffectiveV ? toSec(recentV.top_price_time) : 0
  const vLowTime = hasEffectiveV ? toSec(recentV.low_price_time) : 0
  const vSignalTime = hasEffectiveV ? toSec(recentV.signalTime) : 0
  const vRetracement = hasEffectiveV ? Number(recentV.n_pattern_retracement) : NaN
  const vRetracementValid = hasEffectiveV && recentV.n_pattern_retracement != null && Number.isFinite(vRetracement) && vRetracement >= 0 && vRetracement <= 1
  const vRetracementOk = vRetracementValid && vRetracement > V_MIN_RETRACEMENT
  const vDurationSec = vSignalTime - vTopTime
  const vDurationOk = hasEffectiveV && vTopTime > 0 && vSignalTime > 0 && vDurationSec > V_MIN_DURATION_SEC

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

  // ---------- 3. SC：定位 V转低点附近的已收线 bar ----------
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
  const scOk = scIdx >= 0
  const scBar = scOk ? bars[scIdx] : null
  const scLow = scOk ? (Number.isFinite(scWindowLow) ? scWindowLow : scBar.l) : 0

  // ---------- 4. AR：当前 SOS 候选之前，多次已确认反弹中的最高点 ----------
  // 最新 K线只用于判定 SOS，不参与 AR 高点及回落确认，避免把突破本身抬成阻力。
  const latestIdx = bars.length - 1
  let arIdx = -1, arHigh = 0, arConfirmed = false, arCandidateCount = 0
  if (scOk) {
    let runHigh = -Infinity, runIdx = -1
    for (let i = scIdx + 1; i < latestIdx; i++) {
      if (bars[i].h > runHigh) { runHigh = bars[i].h; runIdx = i }
      const rally = runHigh - scLow
      if (rally > 0 && bars[i].c < runHigh - rally * AR_PULLBACK) {
        // 每次回落确认完成一轮反弹，随后继续寻找下一轮；只记录幅度合格的候选。
        if (scLow > 0 && rally / scLow >= AR_MIN_RALLY) {
          arCandidateCount++
          // 同高时取较晚的一次，ST 随之使用最近一次同高反弹后的回测。
          if (!arConfirmed || runHigh >= arHigh) {
            arIdx = runIdx
            arHigh = runHigh
            arConfirmed = true
          }
        }
        runHigh = -Infinity
        runIdx = -1
      }
    }
  }
  const arRallyPct = scLow > 0 ? (arHigh - scLow) / scLow : 0
  const arOk = arConfirmed && arIdx > scIdx && arRallyPct >= AR_MIN_RALLY

  // ---------- 5. ST/Spring：最终 AR 后、当前 SOS 候选前的最低回测点 ----------
  let stIdx = -1, stLow = Infinity
  if (arOk) {
    for (let i = arIdx + 1; i < latestIdx; i++) {
      if (bars[i].l < stLow) { stLow = bars[i].l; stIdx = i }
    }
  }
  const hasSt = stIdx > arIdx
  const stHoldOk = hasSt && stLow >= scLow * (1 - ST_UNDERCUT)

  // ---------- 6. SOS：最新 K线 close 高于 AR 上沿 ----------
  const latestBar = latestIdx >= 0 ? bars[latestIdx] : null
  const hasSos = arOk && latestIdx > arIdx && !!latestBar && latestBar.c > arHigh

  // ---------- 7. SC～AR 区间筹码 ----------
  // 平台 K线 OHLC 与 mcap_range 均为 USD 市值，直接使用 scLow / arHigh。
  // percent 已是“仍持有量 / 总发行量 × 100”，直接累加，不除以样本总持仓。
  // 桶内明细未知：边界桶假定均匀分布，按重叠宽度折算；结果是估算占比。
  const chipBars = ctx.chip_analysis?.price_bars
  let chipDataOk = Array.isArray(chipBars) && chipBars.length > 0
  let rangeChipPercent = 0
  const chipRangeOk = scOk && arOk && scLow > 0 && arHigh > scLow
  if (chipDataOk) {
    for (const bucket of chipBars) {
      const range = bucket?.mcap_range
      const validNumber = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v))
      if (!Array.isArray(range) || range.length !== 2
        || !validNumber(range[0]) || !validNumber(range[1]) || !validNumber(bucket?.percent)) {
        chipDataOk = false
        break
      }
      const low = Number(range[0]), high = Number(range[1]), percent = Number(bucket.percent)
      if (low < 0 || high <= low || percent < 0 || percent > 100) {
        chipDataOk = false
        break
      }
      if (chipRangeOk) {
        const overlap = Math.max(0, Math.min(high, arHigh) - Math.max(low, scLow))
        rangeChipPercent += percent * overlap / (high - low)
      }
    }
  }

  // ---------- 汇总 ----------
  const fmt = (x, d = 6) => Number.isFinite(x) ? Number(Number(x).toFixed(d)) : 'NA'
  const chipInfo = '区间筹码占比（仅展示）: ' + (!chipDataOk ? '筹码数据缺失或无效' : !chipRangeOk ? 'SC/AR区间未确定' : '估算' + fmt(rangeChipPercent, 2) + '% / 市值[' + fmt(scLow, 2) + ', ' + fmt(arHigh, 2) + ']（占总发行量，边界桶按重叠折算）')
  const stInfo = 'ST（仅展示）: ' + (!hasSt ? '无ST' : '低' + fmt(stLow) + '/SC低' + fmt(scLow) + (stHoldOk ? '（支撑未破）' : '（低于SC的95%）'))
  const checks = [
    ['平台', isTargetPlatform, platformLabel, 'Solana(3)/BSC(56)/Robinhood(4663)/Arc(5042)平台白名单，排除假Pump/Four'],
    ['历史最高市值', historicalMcapOk, '$' + Math.round(historicalMcap), '> ' + MIN_HISTORICAL_MCAP],
    ['当前市值', mcapOk, '$' + Math.round(mcap), '> 100000'],
    ['有效V转', hasEffectiveV, hasEffectiveV ? 'y@' + num(recentV.signalTime) : 'n', '最新confirmed（含已完成突破）'],
    // ['V转回撤深度', vRetracementOk, vRetracementValid ? fmt(vRetracement * 100, 2) + '%' : '回撤数据缺失或无效', '> ' + (V_MIN_RETRACEMENT * 100) + '%'],
    ['V转持续时间', vDurationOk, vTopTime > 0 && vSignalTime > 0 ? vDurationSec + '秒' : '时间缺失', '> ' + V_MIN_DURATION_SEC + '秒（signalTime - top_price_time）'],
    ['SC定位', scOk, scOk ? 'idx' + scIdx + '@' + scBar.t + '(粒度' + resolutionSec + 's)' : '未定位', 'V低点匹配到已收线bar'],
    ['AR反弹', arOk, arOk || arIdx > 0 ? '候选' + arCandidateCount + '个/最高' + fmt(arHigh) + '(+' + (arRallyPct * 100).toFixed(1) + '%)' + (arConfirmed ? '已确立' : '未回落') : 'NA', '>=+' + (AR_MIN_RALLY * 100) + '%且已回落确立，取SOS之前最高候选'],
    ['SOS突破', hasSos, latestBar ? '最新收' + fmt(latestBar.c) + '/上沿' + fmt(arHigh) : 'K线不足', '最新收 > 已确认AR上沿'],
  ]

  // 结构可见性：SC 后已收线的 bar 数。太少说明 SC 刚发生、AR/ST/SOS 还没来得及形成——
  // 这是"等待结构展开"，不是"形态不符"，日志上区分开
  const barsAfterSc = scOk ? scMaxIdx - scIdx : 0
  const phase = !isTargetPlatform ? '平台不符'
    : !mcapOk ? '市值不足'
    : !historicalMcapOk ? '历史最高市值不足'
    : !hasEffectiveV ? '无V转'
    : !scOk ? 'SC未定位'
    : !arOk ? (barsAfterSc < 2 ? 'A阶段(SC刚发生,结构未展开,SC后仅' + barsAfterSc + '根收线bar,等待)' : 'A阶段(SC后待AR确立)')
    : !hasSos ? 'C阶段(待SOS突破)' : 'D阶段(SOS)'
  const head = 'VER=' + VERSION + ' [' + symbol + '] K' + ki.resolution + ' 阶段=' + phase
  const fmtItem = ([n, ok, a, e]) => `${n}${ok ? '✅' : '❌'}: ${a} [期望 ${e}]`

  // 未命中把❌项排前面输出（v1.9：日志会被截断，❌项在前保证截断只吃掉✅项，漏斗分析不受影响）
  const fails = checks.filter((c) => !c[1])
  if (fails.length) {
    const rest = checks.filter((c) => c[1])
    ctx.log.error('未命中 ' + head + ' 通过' + checks.filter((c) => c[1]).length + '/' + checks.length + '  ||  ' + fails.concat(rest).map(fmtItem).join('  |  ') + '  |  ' + stInfo + '  |  ' + chipInfo)
    return false
  }
  ctx.log.success('命中<威科夫SOS买点> ' + head + '  ||  ' + checks.map(fmtItem).join('  |  ') + '  |  ' + stInfo + '  |  ' + chipInfo)
  return true
} catch (e) {
  ctx.log.error('策略异常: ' + (e && e.message ? e.message : String(e)))
  return false
}