// ========== 数据匹配、展开（flatten）、组装字段计算、相关性计算 ==========
// 依赖 utils.js（num 内部逻辑自洽，pearson 用于 computeCorrelations）；
// isAssembledField 依赖 custom-fields.js 里的 customFields（仅在函数体内读取，加载顺序无要求）。

const DERIVED_KEYS = [
  'buy_sell_amount_ratio',
  'buy_sell_count_ratio',
  'buy_sell_tx_ratio',
  'smart_buy_sell_ratio',
  'mcap_liquidity_ratio',
  'avg_buy_amount',
  'avg_sell_amount',
  'chip_analysis.above_below_ratio',
  // 设计文档 §20 新增组装字段
  'buy_tx_per_buyer',
  'smart_money_net_buy_count',
  'chip_analysis.pressure_net',
  'open_to_buy_duration',
  'launch_to_buy_duration',
  'buy_max_retracement',
  'v_turn_current_stage_pct',
  'v_turn_break_cost_line_duration_min',
  'last_alert_low_lower_than_pre_low',
  'above_cost_line',
  'cost_line_distance_pct',
  'v_turn_low_cost_line_distance_pct',
];

// 以下字段原始值是 0-1 的小数比例（比如 "0.0331" 实际代表 3.31%），
// 统一 ×100 转成百分比数值，跟其它已经是百分比口径的字段（8大持仓指标、price_change_* 等）保持同一量级，
// 便于筛选阈值设置、分箱统计和跨字段比较
const PERCENT_FRACTION_FIELDS = new Set([
  'gmgn.stat.top_rat_trader_percentage',
  'gmgn.stat.top_bundler_trader_percentage',
  'gmgn.stat.top_entrapment_trader_percentage',
  'gmgn.stat.top_bot_degen_percentage',
  'gmgn.stat.bot_degen_rate',
  'gmgn.stat.fresh_wallet_rate',
  'gmgn.stat.top_10_holder_rate',
  'gmgn.stat.dev_team_hold_rate',
  'gmgn.stat.creator_hold_rate',
  'gmgn.stat.private_vault_hold_rate',
  'gmgn.stat.top70_sniper_hold_rate',
  'gmgn.dev.top_10_holder_rate',
  'gmgn.locked_ratio'
]);

// 已知的地址/哈希类字符串字段：即便字符串内容形如 0x... 或纯数字字符串，也绝不当数值特征处理，
// 避免 Number('0x...') 被解析成十六进制数字、或长数字字符串精度丢失后混入相关性/散点图分析
const ADDRESS_LIKE_KEYS = new Set([
  'token_address', 'creator_address', 'main_pool_address', 'wallet',
  'address', 'pool_address', 'dev_address', 'contract_address',
  'migrated_pool', 'quote_address', 'base_address', 'owner_address',
  'from_address', 'to_address'
]);

function isAddressLikeKey(key) {
  if (!key) return false;
  if (ADDRESS_LIKE_KEYS.has(key)) return true;
  const last = key.split('.').pop();
  return ADDRESS_LIKE_KEYS.has(last) || /address$/i.test(last) || last === 'wallet';
}

// 判断一个字符串是否"看起来像"合约地址/哈希/十六进制值：0x 开头的十六进制串，
// 或者纯 base58 风格的长字符串（Solana 地址），这类字符串即使 Number() 能解析也不该当数字
function looksLikeAddressString(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (/^0x[0-9a-fA-F]+$/.test(t)) return true; // 0x 十六进制
  if (t.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(t)) return true; // 类 base58 长串（Solana 地址等）
  return false;
}

function num(x) {
  if (typeof x === 'string') {
    // 空字符串/纯空白：Number('') === 0，会被误判为合法数值 0，这里显式排除，返回 null（缺失）
    if (x.trim() === '') return null;
    // 0x 十六进制地址 或 base58 风格长地址字符串：不当作数值，避免被 Number() 解析成巨大的十进制数
    if (looksLikeAddressString(x)) return null;
  }
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// catOut（可选）：非数值、非空的字符串字段（比如 platform: "pump.fun"）原本会被直接丢弃——
// 数值特征体系（out）只保留能解析成数字的值，纯分类字符串对相关性/回归毫无意义，不应该混进去。
// 但这些分类字符串对"分组对比""分类字段分析"这类 Pro 功能是有价值的，所以单独收集到 catOut，
// 与数值特征完全分开存放，不会污染 allNumericKeys/scatterOptions 等数值字段体系。
// arrOut（可选）：数组字段（holders/kline_bars/各类事件 _list 等）原本会被静默丢弃——单条数组元素对
// "这个 token 好不好"没有直接意义，必须先聚合成标量才能进相关性/回归框架（design doc §20.0）。
// 这里把原始数组按点号路径收集到 arrOut，供自定义字段公式里的 countWhere/avgField/sumField 等聚合函数使用，
// 数组本身不参与 out（数值特征）体系。
function flattenObject(obj, prefix = '', catOut = null, arrOut = null) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? `${prefix}.${k}` : k;
    const pct = PERCENT_FRACTION_FIELDS.has(key);
    if (isAddressLikeKey(key)) continue; // 地址类字段永远不参与数值特征展开，也不当分类字段（值太发散，没有分组意义）
    if (v !== null && typeof v === 'number' && Number.isFinite(v)) {
      out[key] = pct ? v * 100 : v;
    } else if (typeof v === 'boolean') {
      out[key] = v ? 1 : 0;
    } else if (typeof v === 'string') {
      const n = num(v);
      if (n !== null) out[key] = pct ? n * 100 : n;
      else if (catOut && v.trim() !== '' && !looksLikeAddressString(v)) catOut[key] = v.trim();
    } else if (Array.isArray(v)) {
      if (arrOut && v.length) arrOut[key] = v;
    } else if (typeof v === 'object' && v !== null) {
      Object.assign(out, flattenObject(v, key, catOut, arrOut));
    }
  }
  return out;
}

function flattenCtx(ctx, catOut = null, arrOut = null) {
  const out = {};
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return out;
  for (const k of Object.keys(ctx)) {
    // ctx.logearn 与 signal 是同一份数据的两份拷贝：用真实快照数据核实过 65/65 条记录、121 个字段全部逐一相同。
    // signal 已经在 buildRows 里用空前缀展开过一遍，这里如果再展开 ctx.logearn 会让每个字段都以
    // "logearn.xxx" 的名字重复出现一次，相关性表/矩阵里会把同一个信号误判成两个独立字段，直接跳过。
    if (k === 'logearn') continue;
    const v = ctx[k];
    if (isAddressLikeKey(k)) continue; // 地址类字段永远不参与数值特征展开
    // 对 ctx 下一级对象按原 key 作为前缀展开；标量直接保留原 key
    if (Array.isArray(v)) {
      if (arrOut && v.length) arrOut[k] = v; // 顶层数组字段（如 ctx.holders）
    } else if (v !== null && typeof v === 'object') {
      Object.assign(out, flattenObject(v, k, catOut, arrOut));
    } else if (typeof v === 'string') {
      const n = num(v);
      if (n !== null) out[k] = n;
      else if (catOut && v.trim() !== '' && !looksLikeAddressString(v)) catOut[k] = v.trim();
    } else {
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : num(v);
      if (n !== null) out[k] = n;
    }
  }
  return out;
}

function readJson(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = e => { try { resolve(JSON.parse(e.target.result)); } catch(err) { reject(err); } };
    r.onerror = reject;
    r.readAsText(file);
  });
}

function snapKey(s) {
  const sig = s.signal || {};
  return `${sig.token_address || ''}_${sig.swap_begin_time || ''}`;
}
function callKey(c) {
  return `${c.token_address || ''}_${c.swap_begin_time || ''}`;
}

// calls 与 snapshots 匹配时，同一个 key 下按时间戳选最接近的 snapshot，
// 但如果最接近的那个实际时间差仍然大于此阈值，说明该 call 其实没有真正对应的快照，
// 应该跳过而不是强行拿一个时间差很远的快照去计算特征（否则特征与收益的对应关系是错的）。
// 单位：秒。默认 1 小时，可按数据实际采集频率调整。
const MAX_SNAPSHOT_MATCH_DIFF_SECONDS = 3600;

// 大数据量处理进度反馈（design doc §14.3）：calls 数量较大时（比如上万条），逐条匹配+展开的同步循环
// 会长时间占住主线程，页面表现为“点了分析按钮后卡死没反应”。这里改成 async 函数，每处理完一批（CHUNK_SIZE）
// 就通过 onProgress 回调汇报进度，并 await 一次 setTimeout(0) 把主线程让给浏览器刷新 UI，避免整页冻结。
const BUILD_ROWS_CHUNK_SIZE = 500;

// 兼容秒/毫秒：>=1e12 视为毫秒，否则视为秒，统一转成毫秒
function toMilliseconds(ts) {
  const n = Number(ts);
  return Number.isFinite(n) ? (n >= 1e12 ? n : n * 1000) : NaN;
}

async function buildRows(calls, snapshots, onProgress) {
  const snapsByKey = new Map();
  for (const s of snapshots) {
    const k = snapKey(s);
    if (!snapsByKey.has(k)) snapsByKey.set(k, []);
    snapsByKey.get(k).push(s);
  }
  const rows = [];
  let skippedByTimeDiff = 0;
  for (let ci = 0; ci < calls.length; ci++) {
    const c = calls[ci];
    if (ci > 0 && ci % BUILD_ROWS_CHUNK_SIZE === 0) {
      if (onProgress) onProgress(ci, calls.length);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const list = snapsByKey.get(callKey(c));
    if (!list || !list.length) continue;
    let s = list[0];
    let bestDiff = Math.abs((s.timestamp || 0) - (c.timestamp || 0));
    for (let i = 1; i < list.length; i++) {
      const diff = Math.abs((list[i].timestamp || 0) - (c.timestamp || 0));
      if (diff < bestDiff) { bestDiff = diff; s = list[i]; }
    }
    if (!s) continue;
    if (bestDiff > MAX_SNAPSHOT_MATCH_DIFF_SECONDS) { skippedByTimeDiff++; continue; }
    const init = num(c.initial_mcap), cur = num(c.current_mcap), mx = num(c.max_mcap);
    if (init === null || init === 0 || cur === null || mx === null) continue;
    // 收益以“倍数”表示（1 = 不涨不跌，2 = 涨一倍），与平台展示口径保持一致
    const returnMax = mx / init;

    // 同时展开 snapshot.signal 和 snapshot.ctx；
    // ctx.logearn 与 signal 完全同源重复，flattenCtx 内部已跳过；ctx 下的 gmgn/kline_and_indicators 等仍保留 gmgn. / kline_and_indicators. 前缀
    const categorical = {};
    // 原始数组字段（holders/kline_bars/各类事件 _list 等）按点号路径收集，供自定义字段聚合函数使用（design doc §20.0）
    const arrays = {};
    const signalFeatures = flattenObject(s.signal || {}, '', categorical, arrays);
    const ctxFeatures = flattenCtx(s.ctx || {}, categorical, arrays);
    const features = Object.assign({}, ctxFeatures, signalFeatures);

    // 优先使用 signal 里的 d1 买卖字段计算组装字段
    const buy = features['buy_wcoin_amount_d1'];
    const sell = features['sell_wcoin_amount_d1'];
    const buyers = features['buyer_count_d1'];
    const sellers = features['seller_count_d1'];
    const buyTx = features['buy_tx_count_d1'];
    const sellTx = features['sell_tx_count_d1'];
    const smartBuy = features['smart_money_address_buy_count_d1'];
    const smartSell = features['smart_money_address_sell_count_d1'];
    const liq = features['pool_liquidity'];
    const mcap = features['mcap'] || features['current_mcap'] || features['fdv'];
    const currentAvgPrice = features['kline_and_indicators.current_avg_price'];
    const chipAbove = features['chip_analysis.above_percent'];
    const chipBelow = features['chip_analysis.below_percent'];

    // 分子为 0 是合法值（比如买入量为 0 → 比值为 0），只要求分母非 0 且两者都是有限数字，
    // 不能用真值判断（会把 0 误判为缺失，丢掉这些样本）
    const fin = Number.isFinite;
    if (fin(buy) && fin(sell) && sell !== 0) features['buy_sell_amount_ratio'] = buy / sell;
    if (fin(buyers) && fin(sellers) && sellers !== 0) features['buy_sell_count_ratio'] = buyers / sellers;
    if (fin(buyTx) && fin(sellTx) && sellTx !== 0) features['buy_sell_tx_ratio'] = buyTx / sellTx;
    if (fin(smartBuy) && fin(smartSell) && smartSell !== 0) features['smart_buy_sell_ratio'] = smartBuy / smartSell;
    if (fin(mcap) && fin(liq) && liq !== 0) features['mcap_liquidity_ratio'] = mcap / liq;
    if (fin(buy) && fin(buyers) && buyers !== 0) features['avg_buy_amount'] = buy / buyers;
    if (fin(sell) && fin(sellers) && sellers !== 0) features['avg_sell_amount'] = sell / sellers;
    if (fin(chipAbove) && fin(chipBelow) && chipBelow !== 0) features['chip_analysis.above_below_ratio'] = chipAbove / chipBelow;
    // 人均买入笔数：衡量是不是少数人/机器人在刷单，而不是很多真实用户参与（design doc §20.1）
    if (fin(buyTx) && fin(buyers) && buyers !== 0) features['buy_tx_per_buyer'] = buyTx / buyers;
    // 聪明钱净买入地址数（design doc §20.1）
    if (fin(smartBuy) && fin(smartSell)) features['smart_money_net_buy_count'] = smartBuy - smartSell;
    // 筹码净压力指标：正数=上方套牢盘更多抛压大，负数=下方支撑更强（design doc §20.5）
    if (fin(chipAbove) && fin(chipBelow)) features['chip_analysis.pressure_net'] = chipAbove - chipBelow;

    // 开盘/上线到买入经过的时长，单位分钟：买入点时间用快照的 timestamp（s.timestamp，快照数据
    // 本身的抓取时刻，对应真实买入点）——call.timestamp 是导出数据的时间，没有业务含义，不能用。
    // swap_begin_time 是第一笔交易时间、launch_time 是代币上线时间。用户需求新增字段。
    // 兼容秒/毫秒，统一转成毫秒后再算分钟级差值，避免单位不一致
    const buyMs = toMilliseconds(s.timestamp);
    const swapBeginMs = toMilliseconds(features['swap_begin_time']);
    const launchMs = toMilliseconds(features['launch_time']);
    if (Number.isFinite(buyMs) && Number.isFinite(swapBeginMs)) features['open_to_buy_duration'] = (buyMs - swapBeginMs) / 60000;
    if (Number.isFinite(buyMs) && Number.isFinite(launchMs)) features['launch_to_buy_duration'] = (buyMs - launchMs) / 60000;

    // buy 之前最大回撤：v_breakout_volume_list 里最大的 n_pattern_retracement，没有则为 0
    // 该数组实际挂在 ctx.logearn 下（logearn 与 signal 同源重复，flatten 时已跳过标量去重，但数组需要单独取）
    const breakouts = (s.signal && s.signal.v_breakout_volume_list)
                   || (s.ctx && s.ctx.logearn && s.ctx.logearn.v_breakout_volume_list)
                   || (s.ctx && s.ctx.v_breakout_volume_list);
    let maxRetracement = 0;
    if (Array.isArray(breakouts) && breakouts.length) {
      for (const ev of breakouts) {
        const v = Number(ev && ev.n_pattern_retracement);
        if (Number.isFinite(v) && v > maxRetracement) maxRetracement = v;
      }
    }
    features['buy_max_retracement'] = maxRetracement;

    // 当前生效 V 转信号所处的反弹阶段（用户需求新增字段）：0=仅回撤确认、还未开始反弹，
    // 20/40/60=已依次突破 fibon_break1/2/3（对应反弹 20%/40%/60%）。反弹突破前高（fibon_break4）
    // 视为该轮 V 转已收尾、不再是"生效"信号，不参与统计（与 1.5段策略/code.js、PVP策略/code.js
    // 里 vFinished/vStageLabel 的判定逻辑保持一致：n_pattern_confirmed=true 且未收尾里取 signalTime 最新的一个）。
    const vReached = (val, t) => (Number(val) > 0) || (t !== undefined && t !== null && Number(t) > 0);
    let recentV = null;
    if (Array.isArray(breakouts) && breakouts.length) {
      for (const ev of breakouts) {
        if (!ev || ev.n_pattern_confirmed !== true) continue;
        if (vReached(ev.fibon_break4, ev.fibon_break4_time)) continue; // 已收尾，排除
        if (!recentV || (ev.signalTime || 0) > (recentV.signalTime || 0)) recentV = ev;
      }
      if (recentV) {
        let stage = 0;
        if (vReached(recentV.fibon_break3, recentV.fibon_break3_time)) stage = 60;
        else if (vReached(recentV.fibon_break2, recentV.fibon_break2_time)) stage = 40;
        else if (vReached(recentV.fibon_break1, recentV.fibon_break1_time)) stage = 20;
        features['v_turn_current_stage_pct'] = stage;
      }
    }

    // 最近一个生效 V 转信号"跌破成本线"到"涨破回该成本价"的持续时间，单位分钟（用户需求新增字段）：
    // 1) 取生效 V 转信号（recentV，与上面 v_turn_current_stage_pct 用同一套"生效"判定）的回撤高点 top_price_time；
    // 2) 用 avg_price_bars 按该时间点回溯取"对应的成本价"（同 v_turn_low_cost_line_distance_pct 的回溯逻辑，
    //    找不到历史数据时退回当前成本线 current_avg_price）；
    // 3) 从该高点开始按时间顺序扫描 kline_bars，找到收盘价首次跌破该成本价的那根K线，开始计数；
    // 4) 往后数K线根数，直到收盘价重新涨破该成本价为止（不含涨破那一根）；
    // 5) K线粒度不固定（1s/5s/...），用 resolution（每根K线跨越的秒数）把"跌破期间经历的K线根数"换算
    //    成分钟数，而不是直接拿首尾时间戳相减（bar 数组可能有缺口，"根数 × 粒度"更贴近实际K线跨度）。
    // 若没有生效V转信号、没跌破过、或跌破后到快照时刻仍未涨破（尚未走完），都不参与统计。
    const klineBars = arrays['kline_and_indicators.kline_bars'] || [];
    const resolutionSec = features['kline_and_indicators.resolution'];
    if (recentV && fin(recentV.top_price_time) && klineBars.length && fin(resolutionSec) && resolutionSec > 0) {
      const topTimeSec = recentV.top_price_time >= 1e12 ? Math.floor(recentV.top_price_time / 1000) : recentV.top_price_time;
      const avgBars = arrays['kline_and_indicators.avg_price_bars'] || [];
      let costAtTop = currentAvgPrice;
      for (let i = 0; i < avgBars.length; i++) {
        const bar = avgBars[i];
        const barTimeSec = bar && Number(bar.time) >= 1e12 ? Math.floor(Number(bar.time) / 1000) : Number(bar && bar.time);
        if (Number.isFinite(barTimeSec) && barTimeSec <= topTimeSec && typeof bar.value === 'number') { costAtTop = bar.value; break; }
      }
      if (fin(costAtTop) && costAtTop > 0) {
        // kline_bars 原始是新→旧排列，按时间正序排好、只保留高点之后的部分，再顺序扫描跌破/涨破
        const chrono = klineBars
          .map(b => ({
            time: b && (Number(b.time) >= 1e12 ? Math.floor(Number(b.time) / 1000) : Number(b.time)),
            close: b && Number(b.close),
          }))
          .filter(b => Number.isFinite(b.time) && Number.isFinite(b.close) && b.time >= topTimeSec)
          .sort((a, b) => a.time - b.time);
        let breakdownIdx = -1;
        for (let i = 0; i < chrono.length; i++) {
          if (chrono[i].close < costAtTop) { breakdownIdx = i; break; }
        }
        if (breakdownIdx >= 0) {
          let breakoutIdx = -1;
          for (let i = breakdownIdx + 1; i < chrono.length; i++) {
            if (chrono[i].close > costAtTop) { breakoutIdx = i; break; }
          }
          if (breakoutIdx >= 0) {
            features['v_turn_break_cost_line_duration_min'] = (breakoutIdx - breakdownIdx) * resolutionSec / 60;
          }
        }
      }
    }

    // 最近一个 V 转信号（last_alert）的最低点是否比上一个 V 转信号的最低点更低（用户需求新增字段）：
    // 1 = 更低（连续创新低，形态可能更弱），0 = 未创新低。last_alert.low_price/pre_low_price
    // 由 flattenObject 对 signal.last_alert 递归展开自动产生，不需要单独处理嵌套结构；
    // 任一侧缺失（比如历史上只出现过一次 V 转信号，没有 pre_low_price）不参与，不强行给默认值。
    const lastAlertLow = features['last_alert.low_price'];
    const lastAlertPreLow = features['last_alert.pre_low_price'];
    if (fin(lastAlertLow) && fin(lastAlertPreLow)) {
      features['last_alert_low_lower_than_pre_low'] = lastAlertLow < lastAlertPreLow ? 1 : 0;
    }

    // 是否在成本线之上 / 与成本线的距离（用户需求新增字段）：current_avg_price 是"当前整体持仓
    // 用户的平均价"，与 mcap 同为市值(USD)口径可直接比较（strategy 侧 强势盘策略/v1/code.js 里
    // 已验证过这个用法：curCostMcap = kline_and_indicators.current_avg_price）。
    if (fin(mcap) && fin(currentAvgPrice) && currentAvgPrice !== 0) {
      features['above_cost_line'] = mcap > currentAvgPrice ? 1 : 0;
      features['cost_line_distance_pct'] = (mcap - currentAvgPrice) / currentAvgPrice * 100;
    }

    // V 转信号最低点与"当时"成本线之间的距离（用户需求新增字段）：成本线随时间变化，不能直接用
    // current_avg_price（那是快照抓取时刻的成本线），要用 avg_price_bars 历史数组按最低点发生时间
    // 回溯找最近的一根（同 强势盘策略/v1/code.js 的 costMcapAt 逻辑）；找不到历史数据时退回当前成本线。
    // low_price_mcap 与 current_avg_price 同为市值(USD)口径（用 low_price/low_price_mcp 会是价格/另一种
    // 口径，与成本线单位不一致，不能直接相减）。
    const lowMcap = features['last_alert.low_price_mcap'];
    const lowTimeRaw = features['last_alert.low_price_time'];
    if (fin(lowMcap) && fin(lowTimeRaw)) {
      const avgBars = arrays['kline_and_indicators.avg_price_bars'] || [];
      const lowTimeSec = lowTimeRaw >= 1e12 ? Math.floor(lowTimeRaw / 1000) : lowTimeRaw;
      let costAtLow = currentAvgPrice; // 找不到历史 bar 时退回当前成本线
      for (let i = 0; i < avgBars.length; i++) {
        const bar = avgBars[i];
        const barTimeSec = bar && Number(bar.time) >= 1e12 ? Math.floor(Number(bar.time) / 1000) : Number(bar && bar.time);
        if (Number.isFinite(barTimeSec) && barTimeSec <= lowTimeSec && typeof bar.value === 'number') {
          costAtLow = bar.value;
          break;
        }
      }
      if (fin(costAtLow) && costAtLow !== 0) {
        features['v_turn_low_cost_line_distance_pct'] = (lowMcap - costAtLow) / costAtLow * 100;
      }
    }

    // 冗余字段合并（design doc §20.1，已用真实快照数据核实：65 条样本里 mcap/fdv/current_mcap 100% 完全相同）。
    // 注意：gmgn.dev.top_10_holder_rate 与 gmgn.stat.top_10_holder_rate 经核实【不是】冗余字段
    // （65 条样本里 12 条数值不同，应为不同口径的独立统计），不做合并。
    if (features['mcap'] === undefined) {
      if (features['current_mcap'] !== undefined) features['mcap'] = features['current_mcap'];
      else if (features['fdv'] !== undefined) features['mcap'] = features['fdv'];
    }
    delete features['current_mcap'];
    delete features['fdv'];

    rows.push({
      id: c.id,
      symbol: c.symbol || (s.signal && s.signal.symbol) || '',
      tokenAddress: c.token_address || (s.signal && s.signal.token_address) || '',
      signalType: c.signal_type || '',
      // 用于 Pro 版"时间维度分析"按开仓时间分桶；不参与 getFeature/isNumericColumn 常规字段体系
      swapBeginTime: num(c.swap_begin_time),
      // 观察窗口两端（用于"观察时长不足、returnMax 尚未定型"的偏差检测）：
      // buyTimestamp = 快照抓取时刻（真实买入点，秒）；exportTimestamp = call 导出时刻（秒），
      // returnMax 里的 max_mcap 只统计到导出为止，导出越早的样本越没机会创出真实最高点
      buyTimestamp: Number.isFinite(s.timestamp) ? s.timestamp / 1000 : null,
      exportTimestamp: Number.isFinite(c.timestamp) ? c.timestamp / 1000 : null,
      initialMcap: init,
      currentMcap: cur,
      maxMcap: mx,
      returnMax,
      features,
      // 非数值分类字段（如 platform），供"分组对比""分类字段分析"等 Pro 功能使用；
      // 不参与 getFeature 数值体系（allNumericKeys/scatterOptions 不会包含这些 key）
      categorical,
      // 原始数组字段（如 holders/kline_bars/v_breakout_volume_list），供自定义字段公式里的
      // countWhere/avgField/sumField/giniCoefficient 等聚合函数读取；不参与 getFeature 数值体系
      arrays,
      // 快照原始 ctx 的【引用】（不是拷贝，不额外占内存）：策略回放（"8. CA 定位"里的策略诊断）需要
      // 把策略源码原样跑一遍，而策略读的是 ctx.logearn / ctx.gmgn / ctx.kline_and_indicators 这套
      // 原始嵌套结构，扁平化后的 features 无法还原。只有这一个功能会用到，其它分析一律走 getFeature。
      rawCtx: s.ctx || null
    });
  }
  buildRows.lastSkippedByTimeDiff = skippedByTimeDiff;
  return rows;
}

function isAssembledField(key) {
  // composite_score 是进阶分析“组合评分”写入工作集的衍生字段，归入组装字段口径
  return DERIVED_KEYS.includes(key) || key === 'composite_score' || customFields.some(c => c.name === key);
}

// 相关性候选池治理：三类字段在进入相关性检验前直接剔除——
// 1) 绝对时间戳（epoch 秒/毫秒）：它们与收益的"相关性"多半是数据采集顺序造成的伪相关（晚导入的
//    样本时间戳更大之类），本身不构成可交易信号；时间信息的正确形态是时长（duration，如
//    open_to_buy_duration），那些不受影响；
// 2) 内部标记/噪声字段（_highlight_*/ai_max_*）：与字段浏览器白名单的既有口径保持一致；
// 3) 取值恒定的字段：零信息量，r 恒为 0。
// 剔除的意义不只是少几行垃圾结果：多重比较校正的 m 是按参与检验的字段总数算的，池子里垃圾字段
// 越多，真字段的校正后 p 被拖累得越厉害。
// 注意：max_up_* / signal_max_* 这类"截至快照时刻的最大值"统计量【不在】剔除范围——快照是买入
// 时刻抓取的，这些是买入前已发生的历史，不是未来函数（已用真实样本的时间戳核实过先后关系）。
const CORR_TIMESTAMP_FIELD_RE = /(^|\.)(time|signalTime|last_traded|created_time)$|_time$|_timestamp$|_ts$/;
const CORR_INTERNAL_FIELD_RE = /(^|\.)_highlight_|(^|\.)ai_max_/;

function correlationPoolExclusionReason(key) {
  if (CORR_TIMESTAMP_FIELD_RE.test(key)) return 'timestamp';
  if (CORR_INTERNAL_FIELD_RE.test(key)) return 'internal';
  return null;
}

// 目标筛选口径：收益目标只剩 returnMax 一个（原来的 returnCurrent 已下线），下拉里也就没有"全部"
// 选项了；这里仍保留 'all' 分支，是为了兼容早期版本存在 localStorage 里的 target='all'——它的语义
// 是"不含 log 目标"，即只匹配 returnMax。log(returnMax) 与 returnMax 是同一结果的单调变换而非独立
// 假设，同时计入会把多重比较校正的 m 无理由翻倍，拖累真字段的校正后 p，所以要看 log 目标得单独选。
// 相关性表/Bootstrap CI 两处筛选逻辑共用这一条判断。
function matchCorrTarget(c, target) {
  return target === 'all' ? c.target === 'returnMax' : c.target === target;
}

function computeCorrelations(rows) {
  const targets = [
    { key: 'returnMax', get: r => r.returnMax },
    // log 目标：收益倍数是重尾分布，原始尺度上的 Pearson r 容易被少数极端倍数主导；对数变换后
    // 分布更接近对称，Pearson/p 值/CI 都更稳健（Spearman 是秩相关，对单调变换不敏感，
    // log 前后 ρ 不变，所以 log 目标的意义主要在修正线性相关那一列）。收益倍数理论上 > 0，
    // 非正值（脏数据）直接记 NaN 不参与。
    { key: 'logReturnMax', get: r => (Number.isFinite(r.returnMax) && r.returnMax > 0) ? Math.log(r.returnMax) : NaN }
  ];
  const featureKeys = new Set();
  rows.forEach(r => Object.keys(r.features).forEach(k => featureKeys.add(k)));
  const list = [];
  const excluded = { timestamp: [], internal: [], constant: [] };
  for (const fkey of featureKeys) {
    const preReason = correlationPoolExclusionReason(fkey);
    if (preReason) { excluded[preReason].push(fkey); continue; }
    // 取值恒定检测：在全部有效数值上看去重值个数，恒定字段两个 target 都没有信息量，整个字段跳过
    const distinctValues = new Set();
    for (const r of rows) {
      const v = r.features[fkey];
      if (v !== undefined && v !== null && Number.isFinite(v)) distinctValues.add(v);
      if (distinctValues.size > 1) break;
    }
    if (distinctValues.size <= 1) { excluded.constant.push(fkey); continue; }
    // 2 个目标（returnMax + log 版本）共用同一份 v 有效性判断，之前是每个目标各自完整扫一遍
    // rows，改成扫一遍 rows、同时往 2 个 pairs 数组里分流，减少一半的行扫描次数——
    // 字段数多、样本量大时（每次过滤/分析都会触发一次 computeCorrelations）这个常数因子有实际意义。
    const pairsByTarget = targets.map(() => []);
    for (const r of rows) {
      const v = r.features[fkey];
      if (v === undefined || v === null || !Number.isFinite(v)) continue;
      const timeVal = Number.isFinite(r.swapBeginTime) ? r.swapBeginTime : 0;
      for (let ti = 0; ti < targets.length; ti++) {
        const tv = targets[ti].get(r);
        // 第三个元素带上时间，供下面按时间前后切半算稳定性用；pearson() 只读前两个元素，不受影响
        if (Number.isFinite(tv)) pairsByTarget[ti].push([v, tv, timeVal]);
      }
    }
    for (let ti = 0; ti < targets.length; ti++) {
      const t = targets[ti];
      const pairs = pairsByTarget[ti];
      if (pairs.length >= 5) {
        const r = pearson(pairs);
        // 布尔/二值字段（去重值 <= 2）的排名信息量很低，Spearman 在这类字段上意义不大，直接跳过（NaN）
        const distinctCount = new Set(pairs.map(p => p[0])).size;
        const rho = distinctCount > 2 ? spearman(pairs) : NaN;
        // 离群值敏感性：把 x、y 两侧各最极端的 ~1%（至少 1 个点）剔掉后重算 r。收益是重尾分布，
        // 一个 r=0.45 的字段可能剔掉两三个极端样本后跌到 0.1——这种"相关性"本质是被少数极端点
        // 撑起来的，换一批数据大概率不复现。rTrim 与 r 差异大时表格里会给出标记。
        let rTrim = NaN;
        if (pairs.length >= 10) {
          const k = Math.max(1, Math.floor(pairs.length * 0.01));
          const xSorted = pairs.map(p => p[0]).sort((a, b) => a - b);
          const ySorted = pairs.map(p => p[1]).sort((a, b) => a - b);
          const xLo = xSorted[k], xHi = xSorted[xSorted.length - 1 - k];
          const yLo = ySorted[k], yHi = ySorted[ySorted.length - 1 - k];
          const trimmed = pairs.filter(([x, y]) => x >= xLo && x <= xHi && y >= yLo && y <= yHi);
          if (trimmed.length >= 5 && trimmed.length < pairs.length) rTrim = pearson(trimmed);
        }
        // 只对本来看起来"有点东西"的字段（|r|>=0.2）做该判定，弱相关字段剔不剔离群点都无所谓
        const outlierDriven = Number.isFinite(rTrim) && Math.abs(r) >= 0.2
          && (Math.abs(rTrim) < Math.abs(r) * 0.5 || (Math.sign(rTrim) !== Math.sign(r) && rTrim !== 0));
        // 时间稳定性：按 swap_begin_time 排序切前后两半，各算一次 r。真信号在两个时间段里方向应当
        // 一致；前半段 r=0.4、后半段 r=-0.1 的字段，多半是某个特定时间窗（比如某轮行情）里的巧合
        let rFirstHalf = NaN, rSecondHalf = NaN;
        if (pairs.length >= 20) {
          const byTime = pairs.slice().sort((a, b) => a[2] - b[2]);
          const mid = Math.floor(byTime.length / 2);
          rFirstHalf = pearson(byTime.slice(0, mid));
          rSecondHalf = pearson(byTime.slice(mid));
        }
        const unstable = Number.isFinite(rFirstHalf) && Number.isFinite(rSecondHalf) && Math.abs(r) >= 0.2
          && (Math.sign(rFirstHalf) !== Math.sign(rSecondHalf)
            || Math.min(Math.abs(rFirstHalf), Math.abs(rSecondHalf)) < Math.max(Math.abs(rFirstHalf), Math.abs(rSecondHalf)) * 0.3);

        // 综合质量评分（0-100）：把分散在覆盖率/样本量/离群敏感性/非线性一致性/时间稳定性里的
        // 质量信号收敛成一个数字 + 扣分原因清单，省得每个字段都要跨几个面板对照着看
        let score = 100;
        const reasons = [];
        const coverage = rows.length ? pairs.length / rows.length : 0;
        if (coverage < 0.5) { score -= 25; reasons.push(`覆盖率仅 ${(coverage * 100).toFixed(0)}%（结论只适用于有该字段的子集，且该子集本身可能有偏）`); }
        else if (coverage < 0.9) { score -= 10; reasons.push(`覆盖率 ${(coverage * 100).toFixed(0)}%，部分样本缺失该字段`); }
        if (pairs.length < 20) { score -= 30; reasons.push(`有效样本仅 ${pairs.length} 条（<20），任何统计结论都很脆弱`); }
        else if (pairs.length < 50) { score -= 15; reasons.push(`有效样本 ${pairs.length} 条（<50），结论稳定性有限`); }
        if (outlierDriven) { score -= 25; reasons.push(`相关性由少数极端样本驱动（剔除极端 1% 后 r 从 ${r.toFixed(2)} 变为 ${Number.isFinite(rTrim) ? rTrim.toFixed(2) : '-'}）`); }
        if (Number.isFinite(rho) && Math.abs(r - rho) > 0.15) { score -= 10; reasons.push('Pearson 与 Spearman 明显不一致，线性假设可能不成立'); }
        if (unstable) { score -= 25; reasons.push(`时间上不稳定（前半段 r=${rFirstHalf.toFixed(2)}，后半段 r=${rSecondHalf.toFixed(2)}）`); }
        else if (!Number.isFinite(rFirstHalf)) { score -= 5; reasons.push('样本太少，无法检验时间稳定性'); }
        score = Math.max(0, score);

        list.push({
          target: t.key,
          feature: fkey,
          source: isAssembledField(fkey) ? 'assembled' : 'original',
          r,
          rTrim,
          outlierDriven,
          rFirstHalf,
          rSecondHalf,
          unstable,
          quality: score,
          qualityReasons: reasons,
          n: pairs.length,
          p: pearsonPValue(r, pairs.length),
          rho,
          delta: Number.isFinite(rho) ? Math.abs(r - rho) : NaN
        });
      }
    }
  }
  list.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  // 挂在返回的数组上（而不是 computeCorrelations.lastXxx 静态属性）：OOS 会用 train/test 子集
  // 再各跑一遍本函数，静态属性会被后跑的覆盖掉；挂在数组上，allCorrelations._excluded 始终对应
  // 完整数据集那一次的剔除结果，不会被 OOS 的中间计算污染
  list._excluded = excluded;
  return list;
}

// 行级字段统一用 snake_case，与 FIELD_DESC / TERM_MAP / 过滤联想框中的 key 保持一致，
// 避免出现 tokenAddress（驼峰）在数据里却查不到中文说明、也匹配不上联想列表的问题
const ROW_LEVEL_FIELDS = ['symbol', 'signalType', 'id', 'token_address'];

function getFeature(row, field) {
  if (field === 'returnMax') return row.returnMax;
  if (field === 'logReturnMax') return (Number.isFinite(row.returnMax) && row.returnMax > 0) ? Math.log(row.returnMax) : undefined;
  if (field === 'token_address') return row.tokenAddress;
  if (ROW_LEVEL_FIELDS.includes(field)) return row[field];
  if (row.features[field] !== undefined) return row.features[field];
  return row.categorical ? row.categorical[field] : undefined;
}

function isNumericColumn(col) {
  if (col === 'returnMax' || col === 'logReturnMax') return true;
  if (ROW_LEVEL_FIELDS.includes(col)) return false;
  for (const r of matchedRows) {
    const v = getFeature(r, col);
    if (v !== undefined && v !== null && !Number.isFinite(Number(v))) return false;
  }
  return true;
}

function isFiniteNumber(v) { return v !== undefined && v !== null && Number.isFinite(Number(v)); }
