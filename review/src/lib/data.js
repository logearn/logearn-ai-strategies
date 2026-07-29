// ⚠️ 由 js/data.js 机械移植而来：逻辑一行未改，只在文件首尾加了 import / export。
// 122 个既有测试全部改为从这里 import，测试通过即证明移植是忠实的。
import { customFields, pct } from './custom-fields.js';
import { pearson, pearsonPValue, spearman } from './utils.js';

// ========== 数据匹配、展开（flatten）、组装字段计算、相关性计算 ==========
// 依赖 utils.js（num 内部逻辑自洽，pearson 用于 computeCorrelations）；
// isAssembledField 依赖 custom-fields.js 里的 customFields（仅在函数体内读取，加载顺序无要求）。

// K线量能形态字段清单：单独列出（而不是散在 DERIVED_KEYS 里），供字段浏览器把它们从"组装字段"
// 拆成独立分组——它们全部来自同一处计算（buildRows 里的 kline_bars 序列统计），归类上更接近
// "同一主题的一组指标"而不是零散的比率/差值组装字段，混在一起不利于筛选/浏览。
const KLINE_VOLUME_KEYS = [
  'kline_volume_concentration_pct',
  'kline_minutes_since_max_volume',
  'kline_volume_cv',
  'kline_volume_recent_ratio',
  'kline_volume_trend_ratio',
  'kline_turnover_pct',
  'kline_max_rise_speed_pct_per_min',
  'kline_max_rise_pct',
  'kline_bar_minutes',
  'kline_max_rise_window_min',
  // Top100 持有人快照聚合
  'holder_exchange_ratio',
  'holder_transfer_in_ratio',
  'holder_never_bought_ratio',
  'holder_transfer_amount_ratio',
  'holder_bot_ratio',
  'holder_bundler_ratio',
  'holder_paper_hands_ratio',
  'holder_smart_ratio',
  'holder_suspicious_ratio',
  'holder_new_ratio',
  'holder_gini',
  'holder_hhi',
  'holder_in_profit_ratio',
  'holder_sold_ratio',
  'holder_entry_concentration',
  'holder_native_sol_median',
  'holder_native_sol_cv',
  // gmgn 顶层字段组装
  'gmgn_net_buy_vol_ratio_5m',
  'gmgn_net_buy_vol_ratio_1h',
  'gmgn_buy_sell_count_ratio_1h',
  'gmgn_vol_accel_5m_1h',
  'gmgn_liquidity_change_ratio',
  'gmgn_supply_circulating_ratio',
  'gmgn_price_to_ath_ratio',
  'gmgn_fee_to_liq_ratio',
  // logearn 最大涨幅组装
  'mcap_to_max_up_ratio',
  'max_up_speed_pct_per_min',
];

const DERIVED_KEYS = [
  'buy_sell_amount_ratio',
  'buy_sell_count_ratio',
  'buy_sell_tx_ratio',
  'smart_buy_sell_ratio',
  'mcap_liquidity_ratio',
  'avg_buy_amount',
  'avg_sell_amount',
  'chip_analysis.above_below_ratio',
  'chip_analysis.price_to_peak_ratio',
  'chip_analysis.price_concentration_hhi',
  'chip_analysis.top5_hold_percent',
  'chip_analysis.top5_transfer_in_ratio',
  // 设计文档 §20 新增组装字段
  'buy_tx_per_buyer',
  'sell_tx_per_seller',
  // K线量能形态（清单见 KLINE_VOLUME_KEYS，字段浏览器单独成组）
  ...KLINE_VOLUME_KEYS,
  'smart_money_net_buy_count',
  'open_to_buy_duration',
  'launch_to_buy_duration',
  'buy_max_retracement',
  'post_buy_max_drawdown_pct',
  'last_alert_low_lower_than_pre_low',
  'above_cost_line',
  'cost_line_distance_pct',
];

// 信号字段：从六类信号的 *_list 数组里【提取】出来的（notice_mcap / cv / volume_ratio 这类直接取值，
// 以及在此基础上算的时长、比值、换算市值）。与 DERIVED_KEYS 分开列，是因为两者性质不同：
// DERIVED_KEYS 是对同一行已有标量做比率/差值运算得来的"组装"字段；这些则是把嵌套数组里的一条
// 信号摊平成行级特征，来源和缺失模式都不一样（没有对应类型的信号 → 整组缺失）。
// 分开之后字段浏览器能单独成组——信号字段占了七成多，混在"组装字段"里会把那一组彻底淹没。
// 注意：两者都算 isAssembledField（都不是数据源直接给的原始字段），所以"常用字段"口径不受影响。
const SIGNAL_KEYS = [
  'v_breakout_volume_recent_stage_pct',
  'v_breakout_volume_recent_retracement_pct',
  'v_breakout_volume_recent_drawdown_min',
  'v_breakout_volume_recent_drawdown_speed_pct_per_min',
  'v_breakout_volume_recent_signal_from_top_min',
  'v_breakout_volume_recent_rebound_from_low_pct',
  'v_breakout_volume_recent_breakout_ratio',
  'v_breakout_volume_recent_signal_from_open_min',
  'v_breakout_volume_recent_low_to_buy_min',
  'v_breakout_volume_recent_prior_count',
  'v_breakout_volume_signal_count',
  'v_breakout_volume_record_count',
  'continue_breakout_volume_signal_count',
  'continue_breakout_volume_recent_notice_mcap',
  'continue_breakout_volume_recent_max_amplitude',
  'continue_breakout_volume_recent_amplitude_before_signal_min',
  'continue_breakout_volume_recent_all_bullish',
  'continue_breakout_volume_recent_signal_volume',
  'continue_breakout_volume_recent_volume_total',
  'continue_breakout_volume_recent_volume_trend_ratio',
  'continue_breakout_volume_recent_bullish_kline_count',
  'continue_breakout_volume_recent_signal_from_open_min',
  'continue_breakout_volume_recent_signal_to_buy_min',
  'breakout_volume_10x_signal_count',
  'breakout_volume_10x_recent_notice_mcap',
  'breakout_volume_10x_recent_volume_ratio',
  'breakout_volume_10x_recent_dormant_duration_min',
  'breakout_volume_10x_recent_dormant_kline_count',
  'breakout_volume_10x_recent_dormant_cv',
  'breakout_volume_10x_recent_dormant_slope',
  'breakout_volume_10x_recent_dormant_end_to_signal_min',
  'breakout_volume_10x_recent_signal_from_open_min',
  'breakout_volume_10x_recent_signal_to_buy_min',
  'breakout_volume_10x_recent_kline_bullish',
  'breakout_volume_10x_recent_kline_change_pct',
  'breakout_volume_10x_recent_drawdown_from_high_pct',
  // 蓝筹共振信号 whale
  'whale_signal_count',
  'whale_recent_wallet_count',
  'whale_recent_tx_count',
  'whale_recent_tx_per_wallet',
  'whale_recent_past_minute',
  'whale_recent_notice_mcap',
  'whale_recent_signal_from_open_min',
  'whale_recent_signal_to_buy_min',
  'signal_total_count',
  'signal_type_count',
  'signal_span_min',
  'signal_first_to_buy_min',
  'v_breakout_volume_recent_break_cost_line_min',
  'v_breakout_volume_recent_below_cost_line_elapsed_min',
  'v_breakout_volume_recent_low_cost_line_distance_pct',
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
    // 键名本身就是钱包地址的子树整棵跳过（典型：followed_signal_state.walletPositionMap.<地址>.xxx）。
    // 这类路径每个钱包生成一整套字段，只在恰好含该钱包的少数行有值（实测 n=7），既极度稀疏
    // 又完全不可泛化——"某个具体地址的持仓"不是特征。不挡住会污染字段列表、相关性池和 AUC 候选。
    if (looksLikeAddressString(k)) continue;
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

// 从 JSON 内容本身判断这是 calls 导出还是 snapshots 导出——DataLoader 只留一个上传入口，
// 不再让用户自己把文件分拣进两个按钮，靠数据形状自动识别。
// snapshots 每条都有 signal/ctx 这两个字段（buildRows 就是读这两个）；calls 每条都有
// initial_mcap/current_mcap/max_mcap 之一（buildRows 算 returnMax 就靠这几个）——
// 两组标记字段互斥，任何一份真实导出数据都不会同时命中两边，命中不了任何一边就老实报"认不出"，
// 不瞎猜（猜错了会把 calls 当 snapshots 存，后面匹配全部为 0，比"上传失败"更难排查）。
function detectFileKind(data) {
  if (!Array.isArray(data) || !data.length) return null;
  const sample = data.find(x => x && typeof x === 'object');
  if (!sample) return null;
  const isSnap = 'signal' in sample || 'ctx' in sample;
  const isCall = 'initial_mcap' in sample || 'current_mcap' in sample || 'max_mcap' in sample || 'min_mcap' in sample;
  if (isSnap && !isCall) return 'snaps';
  if (isCall && !isSnap) return 'calls';
  return null;
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
// 注意：s.timestamp / c.timestamp 实际数据里是毫秒，比较前必须经 toMilliseconds 归一并把
// 阈值换算成毫秒——之前是裸减后直接与 3600 比，等于把阈值缩成了 3.6 秒，时间差在
// 3.6 秒 ~ 1 小时之间的 call 全被静默跳过。
const MAX_SNAPSHOT_MATCH_DIFF_SECONDS = 3600;
// 时间戳缺失时按 0 处理（与匹配逻辑原有的 || 0 口径一致：缺失 → 时间差巨大 → 被阈值挡掉）
function tsOrZeroMs(ts) {
  const m = toMilliseconds(ts);
  return Number.isFinite(m) ? m : 0;
}

// 大数据量处理进度反馈（design doc §14.3）：calls 数量较大时（比如上万条），逐条匹配+展开的同步循环
// 会长时间占住主线程，页面表现为“点了分析按钮后卡死没反应”。这里改成 async 函数，每处理完一批（CHUNK_SIZE）
// 就通过 onProgress 回调汇报进度，并 await 一次 setTimeout(0) 把主线程让给浏览器刷新 UI，避免整页冻结。
const BUILD_ROWS_CHUNK_SIZE = 500;

// 兼容秒/毫秒：>=1e12 视为毫秒，否则视为秒，统一转成毫秒
function toMilliseconds(ts) {
  const n = Number(ts);
  return Number.isFinite(n) ? (n >= 1e12 ? n : n * 1000) : NaN;
}

// K线粒度（分钟）：用【相邻bar实际时间差的中位数】实测，而不是信任 kline_and_indicators.resolution。
// 原因有三：(1) resolution 的单位没有文档保证——按秒解释和按 TradingView 习惯("1"=1分钟)解释差 60 倍；
// (2) 它可能是字符串("1S")，Number.isFinite 直接判假，字段会静默缺失；(3) 实测值同时兼容两种情况。
// 返回 NaN 表示样本不足以实测，调用方需自行决定是否回退到 resolution。
function measureBarMinutes(bars) {
  if (!Array.isArray(bars) || bars.length < 4) return NaN;
  const times = bars.map(b => toMilliseconds(b && b.time)).filter(Number.isFinite).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const d = (times[i] - times[i - 1]) / 60000;
    if (d > 0) gaps.push(d);
  }
  if (gaps.length < 3) return NaN;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

// SOL/BNB 精度解析：优先用外部注入的 native_coin_decimal（和 native_coin_price 是同一个已知
// 缺口——"并非所有快照都带"），缺失时按 chain 兜底（SOL/BNB 的精度是协议常量，不依赖注入数据）。
// 导出给 UI 层复用：持仓下钻图表按单个持有人展示 SOL 余额时，必须跟组装字段用同一套换算逻辑，
// 不能各写一份——否则字段浏览器里的 holder_native_sol_median 和下钻图上的余额对不上。
const CHAIN_NATIVE_DECIMALS = { 3: 1e9, 56: 1e18 }; // 3=Solana(SOL,9位小数) 56=BSC(BNB,18位小数)
function resolveNativeDecimals(features) {
  const injected = Number(features && features['native_coin_decimal']);
  if (Number.isFinite(injected) && injected > 0) return injected;
  return CHAIN_NATIVE_DECIMALS[Number(features && features['chain'])];
}

// ========== buildRows() 组装字段提取函数（2026-07-29 从 buildRows 内联代码拆出）==========
// buildRows() 原本是一个约1180行的巨型函数，下面这批函数是从中逐块机械搬出来的——每个函数
// 对应源码里原来的一段注释分隔的"块"（---- xxx ----），只做"读 features/arrays/s，写 features/
// categorical"，逻辑一行未改，只是从内联代码换成了具名函数调用，方便单独读、单独测。
// mcap/buyMs/swapBeginMs/currentAvgPrice 这几个值被多个块共用，仍作为 buildRows 循环体内的
// 局部变量声明一次，按需传参进来，不在每个函数内部重复计算。
// V转信号（v_breakout_volume）那一簇因为 recentV/breakouts 被三处不连续的代码共用，暂未拆分，
// 留在 buildRows 内联（见 readme"拆 buildRows()"一节的说明）。

// 简单比率类组装字段：买卖量/笔数/聪明钱地址比、市值-流动性比、人均买卖笔数等。
// 优先使用 signal 里的 d1 买卖字段。mcap 由调用方传入（同一个值在筹码分布/max_up 组装块里
// 也要用，避免同一份 features 上重复计算三遍）。
function applySimpleRatioFeatures(features, mcap) {
  const buy = features['buy_wcoin_amount_d1'];
  const sell = features['sell_wcoin_amount_d1'];
  const buyers = features['buyer_count_d1'];
  const sellers = features['seller_count_d1'];
  const buyTx = features['buy_tx_count_d1'];
  const sellTx = features['sell_tx_count_d1'];
  const smartBuy = features['smart_money_address_buy_count_d1'];
  const smartSell = features['smart_money_address_sell_count_d1'];
  const liq = features['pool_liquidity'];
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
  // 人均卖出笔数（与 buy_tx_per_buyer 对称）：与买入版对比能看出卖方是一次性清仓还是分批出货，
  // 分批出货（人均笔数高）往往是有经验的钱包在慢慢派发，与散户恐慌性一次卖光是不同的行为模式
  if (fin(sellTx) && fin(sellers) && sellers !== 0) features['sell_tx_per_seller'] = sellTx / sellers;
  // 聪明钱净买入地址数（design doc §20.1）
  if (fin(smartBuy) && fin(smartSell)) features['smart_money_net_buy_count'] = smartBuy - smartSell;
  // 【已移除 chip_analysis.pressure_net】= above_percent − below_percent。
  // 它和 above_below_ratio（= above / below）都是同两个数的函数，四个字段合起来只有
  // 2 个自由度，VIF 全是 ∞。留着不增加任何信息，只会抬高 BH 校正的 m ——
  // m 按参与检验的字段总数算，冗余字段越多，真信号的校正后 p 越难通过。
  // 差值与比值二选一时保留比值：比值无量纲，不受总持仓规模影响
  //（above=40/below=20 与 above=4/below=2 的净压力差 10 倍，但压力比例相同）。
}

// 筹码分布组装字段（从 chip_analysis 的数组算，标量字段由 flattenObject 自动展开，不用管）。
function applyChipShapeFeatures(features, arrays, mcap) {
  const fin = Number.isFinite;
  // price_bars: 按市值分 70 桶的筹码分布，percent = 该价位买入仍持有的量占总供应量的比例。
  const priceBars = arrays['chip_analysis.price_bars'];
  if (Array.isArray(priceBars) && priceBars.length) {
    let peakPct = -1, peakMcap = NaN, totalPct = 0;
    for (const bar of priceBars) {
      const p = Number(bar && bar.percent);
      if (!Number.isFinite(p) || p < 0) continue;
      totalPct += p;
      // 桶的中值市值作为该筹码堆的代表价位。mcap_range 畸形（mid 为 NaN）的 bar 不参与选峰——
      // 否则 percent 最大但 range 坏掉的一根会把 peakMcap 永久置成 NaN，后面有效的 bar 再也接不上
      const rng = bar && bar.mcap_range;
      const mid = Array.isArray(rng) && rng.length === 2 ? (Number(rng[0]) + Number(rng[1])) / 2 : NaN;
      if (Number.isFinite(mid) && p > peakPct) { peakPct = p; peakMcap = mid; }
    }
    // 当前市值相对筹码峰的位置：>1 = 当前价在筹码峰上方（多数持仓者已浮盈，下方支撑；但也意味着
    // 上涨空间里没有密集套牢盘）；<1 = 当前价在筹码峰下方（头上压着一堆套牢盘，反弹遇阻）。
    if (Number.isFinite(peakMcap) && peakMcap > 0 && fin(mcap)) {
      features['chip_analysis.price_to_peak_ratio'] = mcap / peakMcap;
    }
    // 筹码集中度（HHI，取各桶占比归一化后的平方和）：接近 1 = 筹码高度集中在少数价位（庄控/单一
    // 建仓区），接近 0 = 分散在很多价位（换手充分）。用占总量的份额，避免受 total 大小影响。
    if (totalPct > 0) {
      let hhi = 0;
      for (const bar of priceBars) {
        const p = Number(bar && bar.percent);
        if (Number.isFinite(p) && p > 0) { const share = p / totalPct; hhi += share * share; }
      }
      features['chip_analysis.price_concentration_hhi'] = hhi;
    }
  }

  // top5_holders: 头部 5 大持仓来源。转账进来的比例高 = 老鼠仓/分发，是危险信号。
  const top5 = arrays['chip_analysis.top5_holders'];
  if (Array.isArray(top5) && top5.length) {
    let sumHold = 0, sumTransfer = 0;
    for (const h of top5) {
      const hold = Number(h && h.total_hold_percent);
      const tin = Number(h && h.transfer_in_percent);
      if (Number.isFinite(hold)) sumHold += hold;
      if (Number.isFinite(tin)) sumTransfer += tin;
    }
    // 头部 5 大合计持仓占比（%）：集中度，越高越容易被头部砸盘控制
    if (sumHold > 0) features['chip_analysis.top5_hold_percent'] = sumHold;
    // 头部持仓里"转账进来"的占比（%）：高 = 头部筹码不是自己买的，是被分发/老鼠仓，重大风险信号
    if (sumHold > 0) features['chip_analysis.top5_transfer_in_ratio'] = sumTransfer / sumHold * 100;
  }
}

// 早期精选信号 continue_breakout_volume 明细：取 signalTime 最新的一条为"生效"信号。
// buyMs/swapBeginMs 由调用方传入（同一行的多个信号块共用同一份时间基准）。
function applyContinueBreakoutFeatures(features, s, buyMs, swapBeginMs) {
  // ---- 早期精选信号 continue_breakout_volume 明细（用户需求新增字段）----
  // 对应平台 content 文案：「精选，通知市值$31.15K，交易量$4.18K，当前最大振幅94.15%(2026.07.20 03:52:30)」
  //
  // 与 V 转信号的关键差别：精选信号【没有】n_pattern_confirmed / fibon_break4 那套"确认 + 是否收尾"
  // 机制，它就是一个时间点事件，不存在"这轮还没走完"的状态。所以"命中生效的那条"只能按时间取——
  // 取 signalTime 最新的一条，即策略命中当时最近发生的那次精选。
  const picks = (s.signal && s.signal.continue_breakout_volume_list)
              || (s.ctx && s.ctx.logearn && s.ctx.logearn.continue_breakout_volume_list)
              || (s.ctx && s.ctx.continue_breakout_volume_list);
  // 次数：数组存在就写长度（哪怕是 0）。真实样本 SVM 里 v_breakout_volume_list 与
  // continue_breakout_volume_list 都是空数组 []——这是"确实一次都没有"的明确信息，不是未知，
  // 记成 0 才对；只有整个字段不存在（老版本数据）时才算缺失。三类信号统一这个口径。
  // 而且"没有信号"对分析很重要：若只在有信号时才写，相关性分析会整段丢掉这部分样本。
  if (Array.isArray(picks)) features['continue_breakout_volume_signal_count'] = picks.length;
  if (Array.isArray(picks) && picks.length) {
    let recentPick = null;
    for (const ev of picks) {
      if (!ev) continue;
      if (!recentPick || (ev.signalTime || 0) > (recentPick.signalTime || 0)) recentPick = ev;
    }
    if (recentPick) {
      const noticeMcap = Number(recentPick.notice_mcap);
      if (Number.isFinite(noticeMcap)) features['continue_breakout_volume_recent_notice_mcap'] = noticeMcap;

      // 「当前最大振幅」：信号发生时，之前所有K线里最大的那根振幅，单位 %。
      // 注意平台文案对这个值有两种显示方式——小于 100% 时显示成「94.15%」，超过 100% 时显示成
      // 「3x」（demo 里 max_amplitude=300.66 显示为 3x）。字段本身恒为百分比数值，不用换算。
      const amp = Number(recentPick.max_amplitude);
      if (Number.isFinite(amp)) features['continue_breakout_volume_recent_max_amplitude'] = amp;

      // 最大振幅发生在信号前多久（分钟）：振幅高点紧挨着信号 vs 很久之前，含义完全不同——
      // 前者是"刚刚剧烈波动完就被选中"，后者是"早就波动过、现在才被选中"
      const ampSec = Number(recentPick.max_amplitude_time);
      const pickSec = Number(recentPick.signalTime);
      if (Number.isFinite(ampSec) && Number.isFinite(pickSec) && pickSec >= ampSec) {
        features['continue_breakout_volume_recent_amplitude_before_signal_min'] = (pickSec - ampSec) / 60;
      }

      // all_bullish：加强版精选（信号出现时 K 线连续上涨）。布尔转 0/1，缺失不写入。
      if (typeof recentPick.all_bullish === 'boolean') {
        features['continue_breakout_volume_recent_all_bullish'] = recentPick.all_bullish ? 1 : 0;
      }

      // ---- 三根K线的形态明细（结构文档里完全没有，从真实样本 nice 反推）----
      // 精选信号的本质是"连续3根K线"的形态：kline1/2/3 各自的时间、是否阳线、成交量、买卖笔数。
      // all_bullish 只是"三根是否都是阳线"的汇总，下面这些字段能刻画得细得多。
      const v1 = Number(recentPick.volume1);
      const v2 = Number(recentPick.volume2);
      const v3 = Number(recentPick.volume3);

      // 交易量：content 文案里的「交易量$1.64K」= volume3 × 原生币价格。
      // 两个坑（都是拿真实样本 nice 核对出来的，结构文档里没写）：
      //   1) 是 volume3（信号那根K线，kline3_time === signal_time），不是 volume1、也不是三根之和；
      //      实测 21.6248 × 76 = 1643.5 ≈ $1.64K，而 volume1×76=2903.6、三根之和×76=6559 都对不上。
      //   2) volume1/2/3 的单位是【原生币 SOL/BNB】不是 USD，必须乘 native_coin_price 才是文案里的金额。
      // native_coin_price 挂在 ctx 顶层，flattenCtx 会把它展开成同名 feature；但并非所有快照都带
      // （实测有的快照 ctx 里根本没有这几个 native_coin_* 字段），取不到时这两个 USD 口径的字段
      // 直接缺失，绝不退化成写入 SOL 数值——同一个字段混着两种单位比缺失危险得多。
      const coinPrice = Number(features['native_coin_price']);
      if (Number.isFinite(coinPrice) && coinPrice > 0) {
        if (Number.isFinite(v3)) features['continue_breakout_volume_recent_signal_volume'] = v3 * coinPrice;
        if (Number.isFinite(v1) && Number.isFinite(v2) && Number.isFinite(v3)) {
          features['continue_breakout_volume_recent_volume_total'] = (v1 + v2 + v3) * coinPrice;
        }
      }
      // 三根K线的放缩量趋势 = volume3 / volume1。比值无量纲，不依赖 native_coin_price，恒可计算。
      // <1 = 缩量上涨（真实样本 nice 是 38→27→21，比值 0.57），>1 = 持续放量，两者含义完全不同，
      // all_bullish 那个布尔值完全体现不出这个差别。
      if (Number.isFinite(v1) && v1 > 0 && Number.isFinite(v3)) {
        features['continue_breakout_volume_recent_volume_trend_ratio'] = v3 / v1;
      }

      // 三根里有几根是阳线（0~3）。all_bullish 等价于该值 === 3，但 2 根阳线和 0 根阳线
      // 显然不是一回事，离散计数比布尔值信息量大。
      let bullishCount = 0, bullishKnown = false;
      for (const k of ['kline1_bullish', 'kline2_bullish', 'kline3_bullish']) {
        if (typeof recentPick[k] === 'boolean') { bullishKnown = true; if (recentPick[k]) bullishCount++; }
      }
      if (bullishKnown) features['continue_breakout_volume_recent_bullish_kline_count'] = bullishCount;

      // 注：早期精选的 kline1/2/3_buy_tx_count / sell_tx_count 在真实样本里恒为 0（平台没填），
      // 对应的买/卖笔数合计字段已移除，不再产生恒 0 的无效特征。

      // 时间位置：与 V 转那组同口径，单位分钟
      const pickMs = toMilliseconds(pickSec);
      if (Number.isFinite(pickMs) && Number.isFinite(swapBeginMs)) {
        features['continue_breakout_volume_recent_signal_from_open_min'] = (pickMs - swapBeginMs) / 60000;
      }
      if (Number.isFinite(buyMs) && Number.isFinite(pickMs)) {
        features['continue_breakout_volume_recent_signal_to_buy_min'] = (buyMs - pickMs) / 60000;
      }
    }
  }
}

// 休眠苏醒信号 breakout_volume_10x 明细：同样取 signalTime 最新的一条为"生效"信号。
function applyBreakout10xFeatures(features, s, buyMs, swapBeginMs) {
  // ---- 休眠苏醒信号 breakout_volume_10x 明细（用户需求新增字段）----
  // 信号结构 = 休眠阶段 + 苏醒阶段：一段低量横盘（history_start_time ~ history_end_time，
  // 平均量 avg_history_volume、波动率 cv、斜率 standardized_slope）之后突然放量
  // （current_volume 是平均休眠量的 volume_ratio 倍）。
  //
  // 与前两类信号一样，没有"确认/收尾"状态机，命中生效的那条按 signalTime 最新取。
  const wakes = (s.signal && s.signal.breakout_volume_10x_list)
             || (s.ctx && s.ctx.logearn && s.ctx.logearn.breakout_volume_10x_list)
             || (s.ctx && s.ctx.breakout_volume_10x_list);
  if (Array.isArray(wakes)) features['breakout_volume_10x_signal_count'] = wakes.length;
  if (Array.isArray(wakes) && wakes.length) {
    let recentWake = null;
    for (const ev of wakes) {
      if (!ev) continue;
      if (!recentWake || (ev.signalTime || 0) > (recentWake.signalTime || 0)) recentWake = ev;
    }
    if (recentWake) {
      const noticeMcap = Number(recentWake.notice_mcap);
      if (Number.isFinite(noticeMcap)) features['breakout_volume_10x_recent_notice_mcap'] = noticeMcap;

      // 放量倍数：文档明确「直接当倍数用，12.31 表示 12.31x，不用再乘 100」。
      // 注意平台 content 文案把它写成「突然放量12.31%」——带了个 % 号但实际是倍数，别被文案误导。
      const volRatio = Number(recentWake.volume_ratio);
      if (Number.isFinite(volRatio)) features['breakout_volume_10x_recent_volume_ratio'] = volRatio;

      // 休眠期的形态：持续多久、涉及多少根K线、波动率、斜率。
      // 横盘越久越平静（cv/slope 越小）之后的放量，与"本来就在震荡"的放量含义不同。
      const hStart = Number(recentWake.history_start_time);
      const hEnd = Number(recentWake.history_end_time);
      if (Number.isFinite(hStart) && Number.isFinite(hEnd) && hEnd >= hStart) {
        features['breakout_volume_10x_recent_dormant_duration_min'] = (hEnd - hStart) / 60;
      }
      const klineCount = Number(recentWake.history_kline_count);
      if (Number.isFinite(klineCount)) features['breakout_volume_10x_recent_dormant_kline_count'] = klineCount;
      const cv = Number(recentWake.cv);
      if (Number.isFinite(cv)) features['breakout_volume_10x_recent_dormant_cv'] = cv;
      const slope = Number(recentWake.standardized_slope);
      if (Number.isFinite(slope)) features['breakout_volume_10x_recent_dormant_slope'] = slope;

      // 休眠结束到信号发出隔了多久：紧接着放量 vs 沉寂一段后才放量，是两种节奏
      const wakeSec = Number(recentWake.signalTime);
      if (Number.isFinite(hEnd) && Number.isFinite(wakeSec) && wakeSec >= hEnd) {
        features['breakout_volume_10x_recent_dormant_end_to_signal_min'] = (wakeSec - hEnd) / 60;
      }

      // 交易量：current_volume / avg_history_volume 的单位都是【原生币 SOL/BNB】，
      // 与早期精选的 volume1/2/3 同理，必须乘 native_coin_price 才是 USD 口径。
      // 取不到币价时这两个字段缺失，绝不退化成写入原生币数值。

      // ---- 以下字段结构文档均未列出，从真实样本 SVM 反推 ----
      // 苏醒那根K线本身的形态：是否阳线 + 涨幅。放量但收阴线（砸盘放量）与放量拉阳线
      // 完全是两回事，只看 volume_ratio 区分不出来。
      if (typeof recentWake.current_bullish === 'boolean') {
        features['breakout_volume_10x_recent_kline_bullish'] = recentWake.current_bullish ? 1 : 0;
      }
      const openP = Number(recentWake.current_open_price);
      const closeP = Number(recentWake.current_close_price);
      if (Number.isFinite(openP) && openP > 0 && Number.isFinite(closeP)) {
        // 价格是原生币本位，但涨幅是比值、不受计价单位影响，无需换算
        features['breakout_volume_10x_recent_kline_change_pct'] = (closeP - openP) / openP * 100;
      }

      // 信号市值相对历史最高市值的回调深度（%）。平台 content 里的「从最高点回调17.85%」就是它：
      // 实测第一条信号 (138367.48 − 113664.75) / 138367.48 = 17.85% ✓
      // 注意平台把负值截断成 0% 显示（第二条 notice_mcap 169499 > max_up_mcap 139250，文案写"回调0%"），
      // 这里【不截断】——负值表示信号时市值已经超过历史最高点，是比"回调0%"更强的形态，
      // 截断掉会把"刚好持平"和"大幅创新高"压成同一个值。
      const maxUpMcap = Number(recentWake.max_up_mcap);
      if (Number.isFinite(maxUpMcap) && maxUpMcap > 0 && Number.isFinite(noticeMcap)) {
        features['breakout_volume_10x_recent_drawdown_from_high_pct'] = (maxUpMcap - noticeMcap) / maxUpMcap * 100;
      }

      const wakeMs = toMilliseconds(wakeSec);
      if (Number.isFinite(wakeMs) && Number.isFinite(swapBeginMs)) {
        features['breakout_volume_10x_recent_signal_from_open_min'] = (wakeMs - swapBeginMs) / 60000;
      }
      if (Number.isFinite(buyMs) && Number.isFinite(wakeMs)) {
        features['breakout_volume_10x_recent_signal_to_buy_min'] = (buyMs - wakeMs) / 60000;
      }
    }
  }
}

// 蓝筹顶级赢家共振信号 whale 明细：同样取 signalTime 最新的一条为"生效"信号。
function applyWhaleFeatures(features, s, buyMs, swapBeginMs) {
  const fin = Number.isFinite;
  // ---- 蓝筹顶级赢家共振信号 whale ----
  // 一组头部蓝筹钱包在短时间内集体买入=共振。whaleWalletCount 越多、pastMinute 越短，说明共振
  // 越密集越强。volume 字段是带 M/K 后缀的字符串（"43.72M"，代币量非 USD），不可靠、不可比，跳过。
  // 与前几类一样，多条时取 signalTime 最新的一条。
  const whales = (s.signal && s.signal.whale_list)
              || (s.ctx && s.ctx.logearn && s.ctx.logearn.whale_list)
              || (s.ctx && s.ctx.whale_list);
  if (Array.isArray(whales)) features['whale_signal_count'] = whales.length;
  if (Array.isArray(whales) && whales.length) {
    let recentWhale = null;
    for (const ev of whales) {
      if (!ev) continue;
      if (!recentWhale || (ev.signalTime || 0) > (recentWhale.signalTime || 0)) recentWhale = ev;
    }
    if (recentWhale) {
      const wc = Number(recentWhale.whaleWalletCount);
      if (fin(wc)) features['whale_recent_wallet_count'] = wc;
      const tc = Number(recentWhale.whaleTxCount);
      if (fin(tc)) features['whale_recent_tx_count'] = tc;
      // 人均买入次数：同样几个蓝筹地址，反复买 vs 各买一次，是不同的共振强度
      if (fin(wc) && wc > 0 && fin(tc)) features['whale_recent_tx_per_wallet'] = tc / wc;
      // pastMinute 是字符串"1"，转数值：共振时间窗口（分钟），越小越密集
      const pm = Number(recentWhale.pastMinute);
      if (fin(pm)) features['whale_recent_past_minute'] = pm;
      const nm = Number(recentWhale.notice_mcap);
      if (fin(nm)) features['whale_recent_notice_mcap'] = nm;
      const wSec = Number(recentWhale.signalTime);
      const wMs = toMilliseconds(wSec);
      if (fin(wMs) && fin(swapBeginMs)) features['whale_recent_signal_from_open_min'] = (wMs - swapBeginMs) / 60000;
      if (fin(buyMs) && fin(wMs)) features['whale_recent_signal_to_buy_min'] = (buyMs - wMs) / 60000;
    }
  }
}


// K线量能形态（从 kline_bars 序列计算）：量能集中度/变异系数/放量倍数/急拉程度/换手率。
function applyKlineVolumeShapeFeatures(features, arrays) {
  const fin = Number.isFinite;
  // ---- K线量能形态（从 kline_bars 序列计算）----
  // 这是目前唯一"干净"的成交量来源：volume 字段是 USD 成交额（已用两条真实样本交叉验证：
  // token_volume × 该K线均价 ≈ volume），不依赖 native_coin_price（有的快照没有）、
  // 不依赖 gmgn（约四成缺失）、也不涉及 pool_liquidity 那三套互相矛盾的口径。
  //
  // 另外 logearn 的 buy/sell_wcoin_amount 的 _m5/_h1/_d1 三个窗口在真实样本里取值完全相同
  // （含一个已上线 178 天的币），窗口口径存疑，所以绝对量类指标一律不从那边取。
  const klineBarsForVol = arrays['kline_and_indicators.kline_bars'] || [];
  // 序列统计量在样本太少时毫无意义（真实样本里有的币只给了 2 根K线，有的给了 150 根），
  // 少于该根数整组不写入，而不是算出一个看似有值、实则由 1~2 根决定的数字。
  const MIN_KLINE_BARS_FOR_VOLUME = 10;
  // kline_is_usd 为 false 时 volume 的计价单位不是 USD，跨样本不可比，直接跳过（token_volume
  // 是代币数量、不受该标记影响，所以换手率仍然可算）
  const klineIsUsd = features['kline_and_indicators.kline_is_usd'];
  if (klineBarsForVol.length >= MIN_KLINE_BARS_FOR_VOLUME) {
    // volsRaw 保留原数组的位置（含非法值），供按索引换算时间/取最新一根用；vols 只用于求和/均值等
    // 与位置无关的统计——直接在 filter 后的数组上 indexOf/取 [0]，一旦有 bar 的 volume 非法被滤掉，
    // 索引就与真实 K 线位置错位了
    const volsRaw = klineBarsForVol.map(b => Number(b && b.volume));
    const vols = volsRaw.filter(Number.isFinite);
    if (vols.length >= MIN_KLINE_BARS_FOR_VOLUME && klineIsUsd !== 0) {
      const total = vols.reduce((a, b) => a + b, 0);
      const mean = total / vols.length;
      if (total > 0 && mean > 0) {
        // 量能集中度：最大一根占总量的比例（%）。持续放量 → 值低；单根异常巨量 → 值高，
        // 后者常是一笔拉盘/砸盘造成的，与真实换手是两回事，只看总量完全区分不出来。
        const maxVol = Math.max(...vols);
        features['kline_volume_concentration_pct'] = maxVol / total * 100;
        // 距最大量那根过了多少分钟：直接用"根数"没有意义——各样本K线粒度差异极大（1秒~1天），
        // 同样"距今3根"在秒级K线上是几秒钟、在天级K线上是3天，跨样本没法比较；换算成分钟才是
        // 统一单位，与 v_breakout_volume_recent_break_cost_line_min 等其它时长类字段口径一致。
        // resolution 缺失时无法换算，不写入，不用"根数"退回去凑一个语义不同的数字。
        const mvBarMin = measureBarMinutes(klineBarsForVol);
        const resSec = Number(features['kline_and_indicators.resolution']);
        const barMinMv = Number.isFinite(mvBarMin) && mvBarMin > 0
          ? mvBarMin
          : (Number.isFinite(resSec) && resSec > 0 ? resSec / 60 : NaN);
        if (Number.isFinite(barMinMv) && barMinMv > 0) {
          features['kline_minutes_since_max_volume'] = volsRaw.indexOf(maxVol) * barMinMv;
        }
        // 变异系数：量能稳不稳定，和均值无关的相对离散度
        const variance = vols.reduce((acc, v) => acc + (v - mean) ** 2, 0) / vols.length;
        features['kline_volume_cv'] = Math.sqrt(variance) / mean;
        // 通用版"放量倍数"：最新一根相对之前所有根的均量。苏醒信号自带的 volume_ratio 只有
        // 苏醒信号才有，这个对所有样本都能算。
        // 最新一根必须取 volsRaw[0]（真实的最新 bar）；它非法时跳过，而不是错拿 vols[0]（可能是次新一根）
        const newestVol = volsRaw[0];
        if (Number.isFinite(newestVol)) {
          const restMean = (total - newestVol) / (vols.length - 1);
          if (restMean > 0) features['kline_volume_recent_ratio'] = newestVol / restMean;
        }
        // 放量/缩量趋势：较近的一半 vs 较早的一半（newest first，所以前半段是较近的）
        const half = Math.floor(vols.length / 2);
        const recentHalf = vols.slice(0, half).reduce((a, b) => a + b, 0) / half;
        const olderHalf = vols.slice(half).reduce((a, b) => a + b, 0) / (vols.length - half);
        if (olderHalf > 0) features['kline_volume_trend_ratio'] = recentHalf / olderHalf;
      }
    }
    // ---- 急拉程度：从 kline_bars 多尺度扫描最陡的一段拉升 ----
    // 动机：垂直拉升（几根K线从 7.6K 冲到 40K）和温和爬升是完全不同的形态，但只看总涨幅
    // （max_up_ratio）区分不出来——后者可能是几小时慢慢涨的。这里找"最陡的那一段"。
    //
    // 为什么必须多尺度：如果只用单一固定窗口（比如恒定 5 分钟），speed = rise / 5 就成了
    // rise 的线性变换，两个字段相关系数恒为 1，等于只有一个字段。扫多个时间尺度后，
    // speed 偏向短窗口（1分钟暴涨60%），rise 偏向长窗口（15分钟累计涨400%），两者才解耦。
    //
    // 稳健性：K线粒度从【相邻bar的实际时间差中位数】推断，不解析 resolution 字符串——真实
    // 数据粒度从 1S 到 1D 都有，且 bar 之间可能有缺口（无成交时段被跳过），中位数最抗缺口。
    const chrono = klineBarsForVol.slice().reverse(); // 原数组 newest-first，反转成时间正序
    const gaps = [];
    for (let i = 1; i < chrono.length; i++) {
      const d = (toMilliseconds(chrono[i].time) - toMilliseconds(chrono[i - 1].time)) / 60000;
      if (Number.isFinite(d) && d > 0) gaps.push(d);
    }
    if (gaps.length >= 3) {
      const sortedGaps = gaps.slice().sort((a, b) => a - b);
      const barMin = sortedGaps[sortedGaps.length >> 1]; // 中位间隔（分钟）
      if (barMin > 0) {
        features['kline_bar_minutes'] = barMin;
        const highs = chrono.map(b => Number(b.high));
        const opens = chrono.map(b => Number(b.open));
        // 目标时间尺度（分钟）→ 折算成根数后去重，粒度粗时会塌缩成同一个 W，无所谓
        const widths = [];
        for (const targetMin of [1, 3, 5, 15]) {
          const w = Math.max(1, Math.min(chrono.length, Math.round(targetMin / barMin)));
          if (!widths.includes(w)) widths.push(w);
        }
        let bestSpeed = NaN, bestSpeedWinMin = NaN, bestRise = NaN;
        for (const W of widths) {
          const winMin = W * barMin;
          for (let i = 0; i + W <= chrono.length; i++) {
            const base = opens[i];
            if (!Number.isFinite(base) || base <= 0) continue;
            let peak = -Infinity;
            for (let k = i; k < i + W; k++) {
              if (Number.isFinite(highs[k]) && highs[k] > peak) peak = highs[k];
            }
            if (!Number.isFinite(peak) || peak <= base) continue;
            const rise = (peak - base) / base * 100;
            const speed = rise / winMin;
            if (!Number.isFinite(bestSpeed) || speed > bestSpeed) { bestSpeed = speed; bestSpeedWinMin = winMin; }
            if (!Number.isFinite(bestRise) || rise > bestRise) bestRise = rise;
          }
        }
        if (Number.isFinite(bestSpeed)) {
          features['kline_max_rise_speed_pct_per_min'] = bestSpeed;
          features['kline_max_rise_window_min'] = bestSpeedWinMin; // 最陡那一段发生在多长的尺度上
        }
        if (Number.isFinite(bestRise)) features['kline_max_rise_pct'] = bestRise;
      }
    }

    // 真正的换手率：token_volume 是【已按精度换算】的代币数量（真实样本验证过），
    // 除以总供应量就是期间换手比例。这是代币口径，不依赖币价、也不涉及"流动性该用哪个口径"
    // 的争议——之前提的 成交额/池子 严格来说不叫换手率。
    // 注意窗口长度 = kline_bars 覆盖的时间，各样本的粒度和根数不同，横向比较时要留意这一点。
    const tokenVols = klineBarsForVol.map(b => Number(b && b.token_volume)).filter(Number.isFinite);
    const supply = features['total_supply'];
    if (tokenVols.length >= MIN_KLINE_BARS_FOR_VOLUME && fin(supply) && supply > 0) {
      features['kline_turnover_pct'] = tokenVols.reduce((a, b) => a + b, 0) / supply * 100;
    }
  }
}

// Top100 持有人快照聚合（holders 数组）：交易所占比/转账接盘/钱包画像/集中度/盈亏/协同检测等。
function applyHolderStatsFeatures(features, arrays) {
  // ---- Top100 持有人快照聚合（holders 数组）----
  // ctx.holders 是 GMGN 返回的头部持有人列表（通常约 100 条），每条是一个钱包。数组本身进不了
  // 数值体系，这里聚合成一批行级占比特征。全部用【占比】而非绝对量/计数：绝对 USD 随市值变化、
  // 跨 token 不可比；计数受列表长度影响。缺失（无 gmgn 数据）时整组不写入，不强行给 0。
  //
  // 关键口径：先剔除 addr_type===2（交易所/流动性池地址，不是真实持有人），A~E 各比例都在
  // "真实持有人"子集上算；holder_exchange_ratio 例外，它要在全体上算才能反映池子地址占了多少。
  const holdersAll = arrays['holders'];
  if (Array.isArray(holdersAll) && holdersAll.length) {
    const nAll = holdersAll.length;
    const nExch = holdersAll.filter(h => Number(h && h.addr_type) === 2).length;
    features['holder_exchange_ratio'] = nExch / nAll * 100;

    const H = holdersAll.filter(h => h && Number(h.addr_type) !== 2);
    const n = H.length;
    if (n > 0) {
      const ratioOf = pred => H.filter(pred).length / n * 100;
      // 标签匹配辅助：tags/maker_token_tags 是字符串数组，做精确成员判断
      const hasTag = (h, key, set) => Array.isArray(h[key]) && h[key].some(t => set.has(String(t)));
      // 标签关键词默认集合——用户可按需增删。bot 类=机器人/三明治/捆绑；smart 类=聪明钱背书。
      const BOT_TAGS = new Set(['sandwich_bot', 'bundler', 'smart_degen']);
      const SMART_TAGS = new Set(['kol', 'smart_degen', 'bluechip_owner']);

      // A. 真实买入 vs 转账接盘
      features['holder_transfer_in_ratio'] = ratioOf(h => h.transfer_in === true);
      features['holder_never_bought_ratio'] = ratioOf(h => Number(h.buy_volume_cur) === 0);
      const sumBal = H.reduce((a, h) => a + (Number(h.balance) || 0), 0);
      const sumTin = H.reduce((a, h) => a + (Number(h.current_transfer_in_amount) || 0), 0);
      if (sumBal > 0) features['holder_transfer_amount_ratio'] = sumTin / sumBal * 100;

      // B. 钱包画像
      features['holder_bot_ratio'] = ratioOf(h => hasTag(h, 'tags', BOT_TAGS));
      features['holder_bundler_ratio'] = ratioOf(h => hasTag(h, 'maker_token_tags', new Set(['bundler'])));
      features['holder_paper_hands_ratio'] = ratioOf(h => hasTag(h, 'maker_token_tags', new Set(['paper_hands'])));
      features['holder_smart_ratio'] = ratioOf(h => hasTag(h, 'tags', SMART_TAGS));
      features['holder_suspicious_ratio'] = ratioOf(h => h.is_suspicious === true);
      features['holder_new_ratio'] = ratioOf(h => h.is_new === true);

      // C. 集中度（amount_percentage 是 0-1 的占比）。gini 内联，因为 giniCoefficient 定义在
      // custom-fields.js、加载顺序在 data.js 之后，这里取不到。
      const shares = H.map(h => Number(h.amount_percentage)).filter(Number.isFinite).sort((a, b) => a - b);
      if (shares.length >= 2) {
        const sSum = shares.reduce((a, b) => a + b, 0);
        if (sSum > 0) {
          let cw = 0;
          for (let i = 0; i < shares.length; i++) cw += (2 * (i + 1) - shares.length - 1) * shares[i];
          features['holder_gini'] = cw / (shares.length * sSum);
          // HHI：份额平方和，先把 amount_percentage 归一化成占列表内总量的比例再平方求和
          features['holder_hhi'] = shares.reduce((a, s) => a + (s / sSum) ** 2, 0);
        }
      }

      // D. 盈亏/抛压
      features['holder_in_profit_ratio'] = ratioOf(h => Number(h.profit) > 0);
      features['holder_sold_ratio'] = ratioOf(h => Number(h.sell_amount_percentage) > 0);

      // E. 入场时间协同：start_holding_at 落在最密集 5 分钟窗口内的占比。用滑动区间找最大命中——
      // 头部大量钱包在同一 5 分钟涌入 = 协同建仓（狙击/捆绑），是很强的内部控盘信号。
      const times = H.map(h => Number(h.start_holding_at)).filter(t => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
      if (times.length >= 3) {
        let best = 1;
        for (let i = 0, j = 0; i < times.length; i++) {
          while (times[i] - times[j] > 300) j++;
          if (i - j + 1 > best) best = i - j + 1;
        }
        features['holder_entry_concentration'] = best / times.length * 100;
      }

      // ---- F. 协同钱包检测 ----
      // 动机：单看集中度会被"拆仓"绕过——把一个大仓拆成 4 个钱包，top10_holder_rate 就正常了，
      // 实际控盘方一点没变。下面几个字段找的是【同一控制人的多个钱包】留下的痕迹。

      // 交易所热钱包必须单独成组：Binance/OKX 的出金地址是公共的，大量互不相干的人都从那出金，
      // 混进来会把正常币也算成高协同（真实样本里 OKX 一个地址就关联了 12 个头部持有人）。
      // 注意不能用「native_transfer.name 是否为空」来判交易所——真实样本里有个持有人的 name 是
      // "YZBY🌎"（个人昵称带 emoji），非空但不是交易所。只能按交易所名单匹配。
      const CEX_NAME_RE = /binance|okx|bybit|coinbase|gate|htx|huobi|mexc|kucoin|bitget|crypto\.com|kraken|bitfinex|upbit/i;
      const funderOf = h => {
        const nt = h && h.native_transfer;
        const addr = nt && typeof nt.from_address === 'string' ? nt.from_address.trim() : '';
        if (!addr) return null;
        return { addr, isCex: CEX_NAME_RE.test(String((nt && nt.name) || '')) };
      };
      // 按出金地址分簇，只统计规模 >= 2 的簇（单例不算协同）
      const clusterStats = pickCex => {
        const byAddr = new Map();
        for (const h of H) {
          const f = funderOf(h);
          if (!f || f.isCex !== pickCex) continue;
          byAddr.set(f.addr, (byAddr.get(f.addr) || 0) + 1);
        }
        let inCluster = 0, maxCluster = 0;
        for (const c of byAddr.values()) {
          if (c >= 2) { inCluster += c; if (c > maxCluster) maxCluster = c; }
        }
        return { inCluster: inCluster / n * 100, maxCluster: maxCluster / n * 100 };
      };
      const privClus = clusterStats(false);
      const cexClus = clusterStats(true);
      // 整体占比和最大簇占比要分开：16 个钱包散成 6 个小簇（散兵游勇）和全归一个地址（单一庄家），
      // 整体占比一模一样，风险天差地别——只有最大簇占比区分得开。
      features['holder_same_private_funder_ratio'] = privClus.inCluster;
      features['holder_max_private_funder_ratio'] = privClus.maxCluster;
      features['holder_same_cex_funder_ratio'] = cexClus.inCluster;

      // 持有人之间直接互转：比"同源出金"证据更硬，因为是直接的资金/筹码链路。
      // 现有的 holder_transfer_in_ratio 只数"有没有转入"，不看转自谁——转自陌生人和转自
      // 另一个头部持有人，含义天差地别。
      const holderAddrs = new Set(H.map(h => h && h.address).filter(Boolean));
      const counterpartyHitsHolder = h => {
        for (const k of ['token_transfer_in', 'token_transfer_out', 'token_transfer']) {
          const t = h && h[k];
          const addr = t && typeof t.address === 'string' ? t.address.trim() : '';
          // 排除自己：平台在无转账时会把 address 留空，命中自己没有意义
          if (addr && addr !== h.address && holderAddrs.has(addr)) return true;
        }
        return false;
      };
      features['holder_internal_transfer_ratio'] = ratioOf(counterpartyHitsHolder);

      // 同一秒建仓：比 entry_concentration 的 5 分钟窗口严格得多。秒级完全撞上基本排除巧合，
      // 是同一个脚本批量下单的直接证据。
      const groupRatio = (vals) => {
        const cnt = new Map();
        for (const v of vals) cnt.set(v, (cnt.get(v) || 0) + 1);
        let dup = 0;
        for (const c of cnt.values()) if (c >= 2) dup += c;
        return dup / n * 100;
      };
      const entrySecs = H.map(h => Number(h.start_holding_at)).filter(t => Number.isFinite(t) && t > 0);
      if (entrySecs.length) features['holder_same_second_entry_ratio'] = groupRatio(entrySecs);

      // 买入数量完全相同：真实样本里有三个钱包 buy_amount_cur 都恰好是 3698776，
      // 买到同样的整数数量不可能是巧合。用字符串做键，避免浮点相等判断的坑。
      const buyAmts = H.map(h => Number(h.buy_amount_cur))
        .filter(v => Number.isFinite(v) && v > 0)
        .map(v => String(v));
      if (buyAmts.length) features['holder_identical_buy_amount_ratio'] = groupRatio(buyAmts);

      // ---- G. 浮盈压力与抛压 ----
      // 现有 in_profit_ratio 只数了个数、丢了幅度。浮盈 6 倍的人和浮盈 5% 的人，砸盘意愿完全不同。
      const pnls = H.map(h => Number(h.unrealized_pnl)).filter(Number.isFinite).sort((a, b) => a - b);
      if (pnls.length) {
        const mid = pnls.length >> 1;
        features['holder_pnl_median'] = pnls.length % 2 ? pnls[mid] : (pnls[mid - 1] + pnls[mid]) / 2;
        features['holder_big_winner_ratio'] = pnls.filter(v => v > 3).length / pnls.length * 100;
      }
      features['holder_active_seller_ratio'] = ratioOf(h => Number(h.sell_tx_count_cur) > 0);
      features['holder_realized_loss_ratio'] = ratioOf(h => Number(h.realized_profit) < 0);

      // ---- H. 成本结构 ----
      // 成本高度一致 = 同一批人同一时刻进的，没有真实换手；离散 = 有早期埋伏 + 后来接力。
      // 用变异系数而不是标准差：avg_cost 的绝对值跨 token 差几个数量级，不除以均值没法比。
      const costs = H.map(h => Number(h.avg_cost)).filter(v => Number.isFinite(v) && v > 0);
      if (costs.length >= 3) {
        const cm = costs.reduce((a, b) => a + b, 0) / costs.length;
        if (cm > 0) {
          const cv = costs.reduce((a, b) => a + (b - cm) ** 2, 0) / costs.length;
          features['holder_avg_cost_cv'] = Math.sqrt(cv) / cm;
        }
      }

      // ---- I. 补充画像 ----
      features['holder_sniper_ratio'] = ratioOf(h => hasTag(h, 'maker_token_tags', new Set(['sniper'])));
      features['holder_dev_team_ratio'] = ratioOf(h => hasTag(h, 'maker_token_tags', new Set(['dev_team'])));
      features['holder_kol_ratio'] = ratioOf(h => hasTag(h, 'tags', new Set(['kol'])));
      features['holder_fomo_ratio'] = ratioOf(h => hasTag(h, 'tags', new Set(['fomo'])));
      // 空壳钱包：native_balance 是字符串形式的 lamports，"0" 表示钱包里一点 SOL 都没有
      features['holder_zero_native_ratio'] = ratioOf(h => {
        const v = Number(h.native_balance);
        return Number.isFinite(v) && v === 0;
      });
      // 创建者在头部持有人里的名次（1 起）。名次比占比多一层信息：创建者排 TOP2 和排 TOP80，
      // 持仓占比可能接近，但前者说明他就是主要控盘方。不在列表里则不写入（不是 0，是"没有"）。
      const creatorIdx = H.findIndex(h => hasTag(h, 'maker_token_tags', new Set(['creator'])));
      if (creatorIdx >= 0) features['holder_creator_rank'] = creatorIdx + 1;

      // ---- J. 前 N 大户的买入/卖出均价（换算成市值口径）----
      // 为什么用市值而不是价格：avg_cost 这类单价跨 token 差好几个数量级（1e-6 到 1e-3 都有），
      // 横向没法比；乘上总供应量变成"当时的市值"，才是一个所有 token 可比的尺度，
      // 也和你在平台上看盘时的心理刻度一致（"他们在 2K 市值进的，现在 35K"）。
      //
      // 总供应量取自 holders 自身：balance / amount_percentage。不用顶层 total_supply，因为
      // 那是另一个来源，精度口径不一定和 holders 的 balance 一致，一旦不同源算出的市值会系统性偏移。
      // 用中位数而非均值，避开个别 amount_percentage 极小导致的除法放大。
      const supplyGuesses = H.map(h => {
        const b = Number(h.balance), p = Number(h.amount_percentage);
        return (Number.isFinite(b) && Number.isFinite(p) && p > 0 && b > 0) ? b / p : NaN;
      }).filter(Number.isFinite).sort((x, y) => x - y);
      let supply = supplyGuesses.length ? supplyGuesses[supplyGuesses.length >> 1] : NaN;
      if (!(supply > 0)) {
        const ts = Number(features['total_supply']);
        if (Number.isFinite(ts) && ts > 0) supply = ts;
      }
      if (supply > 0) {
        // 按持仓降序排，不依赖平台给的数组顺序
        const ranked = H.slice().sort((x, y) => (Number(y.balance) || 0) - (Number(x.balance) || 0));
        // 金额加权而不是对 avg_cost 求简单平均：简单平均会让买 100 刀和买 10000 刀的钱包
        // 权重一样，算出来的"均价"不代表这批筹码的真实成本。
        // 分子分母必须配对：history_bought_cost ÷ buy_amount_cur（真实样本验证过，二者相除
        // 恰好等于平台给的 avg_cost；注意不能用 current_buy_amount，它扣掉了转出部分）。
        const weightedMcap = (list, costKey, amtKey) => {
          let cost = 0, amt = 0;
          for (const h of list) {
            const c = Number(h[costKey]), a = Number(h[amtKey]);
            if (Number.isFinite(c) && Number.isFinite(a) && a > 0 && c > 0) { cost += c; amt += a; }
          }
          return amt > 0 ? cost / amt * supply : NaN;
        };
        // 净成本 =（真金白银投入 − 已经拿回的钱）÷ 手上还剩的筹码。
        // 与买入均价的本质区别：卖出过半的钱包，净成本可能是【负数】——他拿回的钱已经超过投入，
        // 剩下的筹码是白嫖的。这种人对价格没有任何防守动机，砸到零他都不亏。
        // 而买入均价/持仓成本会给他一个正的"成本线"，看起来还有支撑位，那是假的。
        //
        // 两个口径决定：
        // 1) 算手续费。这个字段的语义就是"真金白银净投入"，而在净成本接近 0 的临界区，
        //    手续费足以让正负号翻转（真实样本 TOP49：不算费 −$15.9K，算费后差一万多）。
        // 2) 不扣 transfer_out：转出不产生现金，只是筹码换了个钱包，而且真实样本里转出
        //    对手方往往就在同一批大户内（TOP8→TOP14）。在【组级】上求和时，转出方的成本
        //    和接收方的余额都在同一个分子分母里，内部转账自动抵消，不需要单独处理。
        const netCostMcap = (list) => {
          let net = 0, bal = 0;
          for (const h of list) {
            const bc = Number(h.history_bought_cost) || 0;
            const bf = Number(h.history_bought_fee) || 0;
            const si = Number(h.history_sold_income) || 0;
            const sf = Number(h.history_sold_fee) || 0;
            const b = Number(h.balance);
            if (!Number.isFinite(b) || b <= 0) continue;
            net += (bc + bf) - (si - sf);
            bal += b;
          }
          return bal > 0 ? net / bal * supply : NaN;
        };
        for (const N of [30, 50]) {
          // 不足 N 个真实持有人就不写入：拿 20 个人算出来的值叫"前50大户均价"会误导横向比较
          if (ranked.length < N) continue;
          const topN = ranked.slice(0, N);
          // 前 N 大户持仓占比合计：ranked 已按持仓降序、且剔除了 addr_type===2（交易所/流动性池）。
          // amount_percentage 是各钱包占【总供应量】的比例（0-1），求和 ×100 = 前 N 大户合计控盘比例。
          // 这是最直接的集中度指标——比 gini/hhi 直观，"前30占了 60%" 一眼就懂危险。
          const topNShare = topN.reduce((sum, h) => {
            const p = Number(h.amount_percentage);
            return sum + (Number.isFinite(p) ? p : 0);
          }, 0) * 100;
          features[`holder_top${N}_share_pct`] = topNShare;
          const buyMcap = weightedMcap(topN, 'history_bought_cost', 'buy_amount_cur');
          const sellMcap = weightedMcap(topN, 'history_sold_income', 'sell_amount_cur');
          const netMcap = netCostMcap(topN);
          if (Number.isFinite(buyMcap)) features[`holder_top${N}_avg_buy_mcap`] = buyMcap;
          // 前 N 里一个人都没卖过时不写入——那是"没有卖出均价"，不是 0
          if (Number.isFinite(sellMcap)) features[`holder_top${N}_avg_sell_mcap`] = sellMcap;
          // 净成本可以是负数（已回本），负值有意义，不能当成无效值过滤掉
          if (Number.isFinite(netMcap)) features[`holder_top${N}_net_cost_mcap`] = netMcap;
        }
      }

      // ---- K. 大户 SOL 余额统计 ----
      // native_balance 是链上最小单位（lamports/wei），换算成人类可读数量要除以精度位数
      // （resolveNativeDecimals 统一处理 native_coin_decimal 缺失时按 chain 兜底，见函数定义处）。
      // 用中位数而非均值：极少数正常钱包 + 大量空壳/批量小号会把均值拉向异常值。中位数刻意不排除
      // 0 值——如果头部持有人 SOL 余额中位数本身就是 0，说明"大多数大户是用完即弃的批量钱包"，
      // 这本身就是有意义的信号，不该被过滤掉（holder_zero_native_ratio 只给占比，这里给整体量级）。
      const nativeDecimals = resolveNativeDecimals(features);
      if (Number.isFinite(nativeDecimals) && nativeDecimals > 0) {
        const solBalances = H.map(h => Number(h.native_balance) / nativeDecimals)
          .filter(v => Number.isFinite(v) && v >= 0)
          .sort((a, b) => a - b);
        if (solBalances.length >= 3) {
          const mid = solBalances.length >> 1;
          features['holder_native_sol_median'] = solBalances.length % 2
            ? solBalances[mid] : (solBalances[mid - 1] + solBalances[mid]) / 2;
          const sm = solBalances.reduce((a, b) => a + b, 0) / solBalances.length;
          if (sm > 0) {
            const svar = solBalances.reduce((a, b) => a + (b - sm) ** 2, 0) / solBalances.length;
            features['holder_native_sol_cv'] = Math.sqrt(svar) / sm;
          }
        }
      }
    }
  }
}

// gmgn 顶层字段组装（gmgn_ 前缀）：短期动量/流动性/价格位置/换手强度。
function applyGmgnTopFeatures(features) {
  const fin = Number.isFinite;
  // ---- gmgn 顶层字段组装（gmgn_ 前缀）----
  // gmgn.price.* 的多窗口是【真实拆分】的（buys_1m/5m/1h/6h/24h 各不相同），是唯一可靠的短期
  // 动量来源——logearn 的 _m5/_h1/_d1 经核实三窗口恒等（坏的），不能用。绝对 USD 一律只做分子分母，
  // 不单独进特征。gmgn 数据约四成缺失，缺失时对应字段自动不写入（fin 判断挡住）。
  const gp = k => features['gmgn.price.' + k];
  // A. 短期动量：净买入额占比 + 买卖笔数比 + 成交加速度。只做 5m/1h 两窗口（1m 太抖、24h 太钝）。
  const netBuyVolRatio = win => {
    const b = gp('buy_volume_' + win), sv = gp('sell_volume_' + win);
    return (fin(b) && fin(sv) && b + sv > 0) ? b / (b + sv) * 100 : undefined;
  };
  let v = netBuyVolRatio('5m'); if (v !== undefined) features['gmgn_net_buy_vol_ratio_5m'] = v;
  v = netBuyVolRatio('1h'); if (v !== undefined) features['gmgn_net_buy_vol_ratio_1h'] = v;
  const buys1h = gp('buys_1h'), sells1h = gp('sells_1h');
  if (fin(buys1h) && fin(sells1h) && sells1h > 0) features['gmgn_buy_sell_count_ratio_1h'] = buys1h / sells1h;
  // 成交加速度：最近 5 分钟的每分钟均速 ÷ 最近 1 小时的每分钟均速，>1 = 正在放量
  const vol5m = gp('volume_5m'), vol1h = gp('volume_1h');
  if (fin(vol5m) && fin(vol1h) && vol1h > 0) features['gmgn_vol_accel_5m_1h'] = (vol5m / 5) / (vol1h / 60);

  // B. 流动性/储备
  const poolLiq = features['gmgn.pool.liquidity'], initLiq = features['gmgn.pool.initial_liquidity'];
  if (fin(poolLiq) && fin(initLiq) && initLiq > 0) features['gmgn_liquidity_change_ratio'] = poolLiq / initLiq;
  const circ = features['gmgn.circulating_supply'], tot = features['gmgn.total_supply'];
  if (fin(circ) && fin(tot) && tot > 0) features['gmgn_supply_circulating_ratio'] = circ / tot;

  // C. 价格位置：当前价相对历史最高（离顶多远，越接近 1 越贵）
  const priceNow = features['gmgn.price.price'], ath = features['gmgn.ath_price'];
  if (fin(priceNow) && fin(ath) && ath > 0) features['gmgn_price_to_ath_ratio'] = priceNow / ath;

  // D. 换手强度：累计手续费 / 流动性
  const totFee = features['gmgn.total_fee'], gmgnLiq = features['gmgn.liquidity'];
  if (fin(totFee) && fin(gmgnLiq) && gmgnLiq > 0) features['gmgn_fee_to_liq_ratio'] = totFee / gmgnLiq;
}

// logearn 最大涨幅(max_up)组装：当前市值相对历史最高、冲高速度。mcap 由调用方传入。
function applyMaxUpFeatures(features, mcap) {
  const fin = Number.isFinite;
  // ---- logearn 最大涨幅(max_up)组装 ----
  // max_up_* 都是"开盘到快照时刻为止"的历史最高，不含快照之后的未来数据，可安全用。
  const maxUpMcap = features['max_up_mcap'], maxUpRatio = features['max_up_ratio'], maxUpDur = features['max_up_duration'];
  // 当前市值相对历史最高市值：<1=已从高点回落，回撤程度。买在回落多深的位置。
  if (fin(mcap) && fin(maxUpMcap) && maxUpMcap > 0) features['mcap_to_max_up_ratio'] = mcap / maxUpMcap;
  // 冲到历史高点的速度（%/分钟）= 最大涨幅 ÷ 用时。速度快=急拉，慢=温和。max_up_duration 为 0
  // （历史高点就在开盘那一刻）时除数为 0，不写入。
  if (fin(maxUpRatio) && fin(maxUpDur) && maxUpDur > 0) features['max_up_speed_pct_per_min'] = maxUpRatio / (maxUpDur / 60);
}

// 六类信号 list 的键名。纯字面量常量、与行数据无关，提到模块顶层，不必每行重新声明一遍。
const SIGNAL_LISTS = {
  v: 'v_breakout_volume_list',
  continue: 'continue_breakout_volume_list',
  '10x': 'breakout_volume_10x_list',
  whale: 'whale_list',
  followed: 'followed_list',
  smart: 'smart_money_list',
};

// 信号时序：合并六类信号 list 按 signalTime 排序，得到跨类型的先后关系/共振情况。
// 数值字段写 features，形态类分类字段写 categorical。
function applySignalTimingFeatures(features, categorical, s, buyMs) {
  // ---- 信号时序：一个 token 常常先后触发多类信号（比如先"早期精选"再"回撤反弹"）----
  // 前面那三组字段都只取各自类型里最新的一条，完全丢掉了【跨类型的先后关系】。
  // 而"先精选后V转"和"先V转后精选"很可能是两种完全不同的行情结构，多类信号叠加（共振）
  // 与只有单一信号也是两回事——这些信息只能靠把所有 list 合并、按 signalTime 排序才能得到。
  //
  // 这里【包含全部六类信号】（含 whale/followed/smart_money 这三类没做明细字段的），
  // 因为时序分析只要漏掉一类，算出来的顺序就是错的；但只读 type + signalTime 两个字段，
  // 不展开它们的明细，与"其他信号不做"的口径不冲突。
  const signalEvents = [];
  let anySignalListPresent = false;
  for (const [shortName, listKey] of Object.entries(SIGNAL_LISTS)) {
    const list = (s.signal && s.signal[listKey])
              || (s.ctx && s.ctx.logearn && s.ctx.logearn[listKey])
              || (s.ctx && s.ctx[listKey]);
    if (!Array.isArray(list)) continue;
    anySignalListPresent = true; // 数组存在（哪怕为空）才说明这份数据确实带了信号列表
    for (const ev of list) {
      const t = Number(ev && ev.signalTime);
      if (!Number.isFinite(t)) continue;
      // 统一归一成毫秒再入列表：六类 list 的 signalTime 若单位不一致（秒/毫秒混用），
      // 裸值排序会把顺序算错，span 也会差 1000 倍
      const tMs = toMilliseconds(t);
      // 防御性过滤：快照是买入时刻抓的，正常不会出现晚于买入的信号；万一有（时钟偏差/数据
      // 异常），那就是未来函数，必须排除——否则算出来的"信号顺序"包含了当时根本看不到的信息。
      if (Number.isFinite(buyMs) && tMs > buyMs) continue;
      signalEvents.push({ type: shortName, t: tMs });
    }
  }
  if (anySignalListPresent) {
    signalEvents.sort((a, b) => a.t - b.t);
    features['signal_total_count'] = signalEvents.length;
    const distinctTypes = [...new Set(signalEvents.map(e => e.type))];
    // 出现过几种不同类型的信号：1 = 单一信号，>=2 = 多类共振，是"信号强度"的一个直接度量
    features['signal_type_count'] = distinctTypes.length;

    if (signalEvents.length) {
      // signalEvents 里的 t 已是毫秒，两个字段统一按毫秒换算分钟——之前 span 按裸秒 /60、
      // first_to_buy 却走 toMilliseconds，同一组字段两套单位处理，正是上面 V 转那组注释警告过的坑
      const firstT = signalEvents[0].t, lastT = signalEvents[signalEvents.length - 1].t;
      features['signal_span_min'] = (lastT - firstT) / 60000;
      if (Number.isFinite(buyMs)) features['signal_first_to_buy_min'] = (buyMs - firstT) / 60000;

      // 分类字段（进 categorical，不进数值特征体系）：供"分类字段分析""分组对比"按信号形态分组，
      // 直接回答"哪种信号组合/顺序的收益更好"。用 > 而不是箭头符号，避免 CSV 导出时的编码问题。
      //
      // 两个粒度并存，回答的问题不同：
      //   signal_sequence — 完整时序（含同类重复），如 continue>continue>v，最细但取值发散、每组样本少
      //   signal_combo    — 只看出现过哪几类（去重后按字母序），如 continue+v，基数小、每组样本多、统计更稳
      // 分析时通常先用 combo 看大方向，样本够了再用 sequence 看细节。
      categorical['signal_sequence'] = signalEvents.map(e => e.type).join('>');
      categorical['signal_combo'] = distinctTypes.slice().sort().join('+');
      categorical['signal_first_type'] = signalEvents[0].type;
      // 最后一个信号 = 触发这次买入的那个，与 signal.type 应当一致
      categorical['signal_last_type'] = signalEvents[signalEvents.length - 1].type;
    }
  }
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
    const callMs = tsOrZeroMs(c.timestamp);
    let s = list[0];
    let bestDiff = Math.abs(tsOrZeroMs(s.timestamp) - callMs);
    for (let i = 1; i < list.length; i++) {
      const diff = Math.abs(tsOrZeroMs(list[i].timestamp) - callMs);
      if (diff < bestDiff) { bestDiff = diff; s = list[i]; }
    }
    if (!s) continue;
    if (bestDiff > MAX_SNAPSHOT_MATCH_DIFF_SECONDS * 1000) { skippedByTimeDiff++; continue; }
    const init = num(c.initial_mcap), cur = num(c.current_mcap), mx = num(c.max_mcap);
    if (init === null || init === 0 || cur === null || mx === null) continue;
    // 收益以“倍数”表示（1 = 不涨不跌，2 = 涨一倍），与平台展示口径保持一致
    const returnMax = mx / init;
    // 买入之后最大回撤（%）：min_mcap 是 call 里记录的买入之后市值最低点，与 initial_mcap（买入
    // 时市值）算跌幅。min_mcap 缺失时不参与；min_mcap >= initial_mcap（没跌破过买入价，比较罕见但
    // 理论可能）时回撤按 0 计，不产生负数，语义与 buy_max_retracement（回撤幅度只朝一个方向累加）保持一致。
    // 额外要求 min_mcap_time 在 max_mcap_time 之前——这个字段的语义是"买入后先探底、再冲高"
    // 那种走势下的回撤（吓退你、但后面反而涨了）。如果 min 反而出现在 max 之后，说明走势是
    // "先冲高、后砸盘"，最惨的跌幅该从 max_mcap 那个高点算起，不是从 initial_mcap 算——
    // 两种走势含义完全不同，混在一起会把"先苦后甜"和"高位站岗"算成同一个指标，宁可不算。
    const minMcap = num(c.min_mcap);
    const minMcapTime = num(c.min_mcap_time), maxMcapTime = num(c.max_mcap_time);
    const postBuyMaxDrawdownPct = (minMcap !== null && minMcap > 0
      && minMcapTime !== null && maxMcapTime !== null && minMcapTime < maxMcapTime)
      ? Math.max(0, (init - minMcap) / init * 100)
      : undefined;

    // 同时展开 snapshot.signal 和 snapshot.ctx；
    // ctx.logearn 与 signal 完全同源重复，flattenCtx 内部已跳过；ctx 下的 gmgn/kline_and_indicators 等仍保留 gmgn. / kline_and_indicators. 前缀
    const categorical = {};
    // 原始数组字段（holders/kline_bars/各类事件 _list 等）按点号路径收集，供自定义字段聚合函数使用（design doc §20.0）
    const arrays = {};
    const signalFeatures = flattenObject(s.signal || {}, '', categorical, arrays);
    const ctxFeatures = flattenCtx(s.ctx || {}, categorical, arrays);
    const features = Object.assign({}, ctxFeatures, signalFeatures);
    if (postBuyMaxDrawdownPct !== undefined) features['post_buy_max_drawdown_pct'] = postBuyMaxDrawdownPct;

    // 优先使用 signal 里的 d1 买卖字段计算组装字段；mcap/currentAvgPrice/fin 后面几个块
    // （筹码分布/V转信号/成本线距离/max_up）还要用，留在这里当共享 loop 局部变量。
    const mcap = features['mcap'] || features['current_mcap'] || features['fdv'];
    const currentAvgPrice = features['kline_and_indicators.current_avg_price'];
    // 分子为 0 是合法值，只要求分母非 0 且两者都是有限数字，不能用真值判断
    const fin = Number.isFinite;
    applySimpleRatioFeatures(features, mcap);
    applyChipShapeFeatures(features, arrays, mcap);

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
    // 24 小时内 V 转信号出现的次数（与 continue_breakout_volume_signal_count 对称）：反复回调反弹说明这币在来回震荡，
    // 与"只出现过一次干净回调"是不同的形态，取最新那条信号的明细字段无法体现这一点
    // 一个 V 转【周期】= 顶 → 底 → 分档反弹(20%/40%/60%/新高)。平台可能在每个反弹档位都往
    // list 里追加一条，同一个周期就会出现多条记录——直接数 list 长度会把 1 个周期数成 3~4 次。
    // 同一周期的顶/底时间是固定的，用 (top_price_time, low_price_time) 当周期标识去重才是正确口径。
    // 若数据本身就是一周期一条，去重后数量不变，不会有副作用。
    // 顶/底时间缺失时无法判断周期归属，退回用 signalTime 当标识（等价于不去重），
    // 避免把几条互不相关、只是都缺字段的记录错误合并成同一个周期。
    const vCycleKey = ev => {
      const top = Number(ev && ev.top_price_time), low = Number(ev && ev.low_price_time);
      if (Number.isFinite(top) && Number.isFinite(low) && (top || low)) return `c_${top}_${low}`;
      return `s_${Number(ev && ev.signalTime) || Math.random()}`;
    };
    if (Array.isArray(breakouts)) {
      features['v_breakout_volume_signal_count'] = new Set(breakouts.map(vCycleKey)).size;
      // 原始条数单独留一个字段：两者差得多就说明平台确实按反弹档位重复发信号，
      // 这个差值本身也是信息（反弹推进了几档）
      features['v_breakout_volume_record_count'] = breakouts.length;
    }

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
        features['v_breakout_volume_recent_stage_pct'] = stage;

        // 生效这条 V 转信号【之前】还有几个 V 转信号：区分"第一次干净回调"和"反复回调反弹的震荡盘"。
        // 与 v_breakout_volume_signal_count（列表总条数）不同——那个不管先后，这个只数发生在
        // 生效信号之前的。0 = 这是 24h 内的第一次回调反弹。
        // 口径上数【全部】早于它的信号（不限于 n_pattern_confirmed），因为"之前震荡过几次"这件事
        // 本身就包含那些没达到确认阈值的小回调。
        const recentVSec = Number(recentV.signalTime);
        if (Number.isFinite(recentVSec)) {
          // 同样按周期去重：只数【早于生效周期】的不同周期数，而不是记录条数
          const recentKey = vCycleKey(recentV);
          const priorKeys = new Set();
          for (const ev of breakouts) {
            const t = Number(ev && ev.signalTime);
            if (!Number.isFinite(t) || t >= recentVSec) continue;
            const k = vCycleKey(ev);
            if (k !== recentKey) priorKeys.add(k); // 同一周期的早期档位记录不算"之前的信号"
          }
          features['v_breakout_volume_recent_prior_count'] = priorKeys.size;
        }

        // ---- 命中信号的回调/反弹明细（用户需求新增字段）----
        // 全部基于同一个 recentV（= 策略命中当时那条生效信号），保证这一组字段描述的是同一次
        // 回调反弹，交叉分析时不会一个字段取了 A 信号、另一个取了 B 信号。
        // 对应平台 content 文案：「反弹20%($20.99K)，此前回调70.59%，市值从$45.41K至$13.36K，回调时长21秒」
        //
        const retr = Number(recentV.n_pattern_retracement);
        if (Number.isFinite(retr)) features['v_breakout_volume_recent_retracement_pct'] = retr * 100;

        // 坑二：平台文案里的「回调时长」= signalTime − top_price_time（21秒），【不是】从见顶到
        // 触底（18秒）——它把触底后反弹到 fibon_break1 的那段也算进去了。两个口径含义不同，
        // 分别给字段，不合并：drawdown_duration 是真正的下跌时长，signal_from_top 对齐平台文案。
        // 一律走 toMilliseconds 归一：这几个时间戳字段原本是裸减 /60（写死按"秒"），而同组后面的
        // signal_from_open / signal_to_buy 用的是 toMilliseconds。同一批字段两套单位处理，
        // 只要有一批数据的时间戳是毫秒，这两个就会算出 1000 倍的值而其它字段照常——
        // 表现出来正是"部分字段数值异常、部分正常"这种最难查的数据质量问题。
        const topMs = toMilliseconds(recentV.top_price_time);
        const lowMs = toMilliseconds(recentV.low_price_time);
        const sigSec = Number(recentV.signalTime);
        const sigMs0 = toMilliseconds(sigSec);
        if (Number.isFinite(topMs) && Number.isFinite(lowMs) && lowMs >= topMs) {
          // 回调终点 = 本轮最低点（low_price_time）。已用真实样本逐条核对过：11 条记录里
          // top→low 的时长与平台 content 的「回调时长」一致（个别差异来自平台按分钟向下取整）。
          const drawdownMin = (lowMs - topMs) / 60000;
          features['v_breakout_volume_recent_drawdown_min'] = drawdownMin;
          // 回调速度：同样的跌幅，几秒砸下来和慢慢阴跌是两回事。时长为 0（同一根K线内完成）
          // 时除数为 0，直接不写入而不是给 Infinity。
          if (drawdownMin > 0 && Number.isFinite(retr)) {
            features['v_breakout_volume_recent_drawdown_speed_pct_per_min'] = retr * 100 / drawdownMin;
          }
        }
        if (Number.isFinite(topMs) && Number.isFinite(sigMs0) && sigMs0 >= topMs) {
          features['v_breakout_volume_recent_signal_from_top_min'] = (sigMs0 - topMs) / 60000;
        }

        // 这两个平台已经算好了，直接取，不自己算——自己算要依赖"当前市值"，而 logearn.mcap 与
        // kline 最新 bar 存在时间基准差（高波动币上能差几倍），平台内部同源计算的更可信。
        // price_rise_ratio      = 从回调低点到当前的反弹幅度（实测 0.8361 ↔ 手算 0.836 ✓）
        // current_breakout_ratio = 当前价在整个回调区间里的位置（实测 0.3484 ↔ 手算 0.348 ✓），
        //                          是 v_breakout_volume_recent_stage_pct 那四档离散值的连续版本，信息量更大
        const riseRatio = Number(recentV.price_rise_ratio);
        if (Number.isFinite(riseRatio)) features['v_breakout_volume_recent_rebound_from_low_pct'] = riseRatio * 100;
        const breakoutRatio = Number(recentV.current_breakout_ratio);
        if (Number.isFinite(breakoutRatio)) features['v_breakout_volume_recent_breakout_ratio'] = breakoutRatio * 100;

        // 时间位置：距开盘 / 信号新鲜度 / 抄底后多久进场。单位统一分钟（meme 场景下常见零点几分钟，
        // 但与 open_to_buy_duration 等既有时长字段保持同一单位，避免同类字段单位不一致）。
        // sigMs0 / lowMs 上面已归一，直接复用，不再重复声明
        if (Number.isFinite(sigMs0) && Number.isFinite(swapBeginMs)) {
          features['v_breakout_volume_recent_signal_from_open_min'] = (sigMs0 - swapBeginMs) / 60000;
        }
        if (Number.isFinite(buyMs) && Number.isFinite(lowMs)) {
          features['v_breakout_volume_recent_low_to_buy_min'] = (buyMs - lowMs) / 60000;
        }
      }
    }

    // 最近一个生效 V 转信号"跌破成本线"到"涨破回该成本价"的持续时间，单位分钟（用户需求新增字段）：
    // 1) 取生效 V 转信号（recentV，与上面 v_breakout_volume_recent_stage_pct 用同一套"生效"判定）的回撤高点 top_price_time；
    // 2) 用 avg_price_bars 按该时间点回溯取"对应的成本价"（同 v_breakout_volume_low_cost_line_distance_pct 的回溯逻辑，
    //    找不到历史数据时退回当前成本线 current_avg_price）；
    // 3) 从该高点开始按时间顺序扫描 kline_bars，找到收盘价首次跌破该成本价的那根K线，开始计数；
    // 4) 往后数K线根数，直到收盘价重新涨破该成本价为止（不含涨破那一根）；
    // 5) K线粒度不固定（1s/5s/...），用 resolution（每根K线跨越的秒数）把"跌破期间经历的K线根数"换算
    //    成分钟数，而不是直接拿首尾时间戳相减（bar 数组可能有缺口，"根数 × 粒度"更贴近实际K线跨度）。
    // 若没有生效V转信号、没跌破过、或跌破后到快照时刻仍未涨破（尚未走完），都不参与统计。
    const klineBars = arrays['kline_and_indicators.kline_bars'] || [];
    // 粒度优先用实测值；实测不出来（bar 太少）才回退到 resolution 并按秒解释
    const measuredBarMin = measureBarMinutes(klineBars);
    const resolutionSec = Number(features['kline_and_indicators.resolution']);
    const barMinForGap = fin(measuredBarMin) && measuredBarMin > 0
      ? measuredBarMin
      : (fin(resolutionSec) && resolutionSec > 0 ? resolutionSec / 60 : NaN);
    if (recentV && fin(recentV.top_price_time) && klineBars.length && fin(barMinForGap) && barMinForGap > 0) {
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
          // 右删失处理：跌破后到快照时刻仍未涨破的样本，如果只是"不写入字段"，它们会被
          // 静默剔除出所有统计——而这些恰恰是最差的一批（一直没能站回成本线）。结果就是
          // break_cost_line_min 的分布被条件在"最终收复了成本线"上，系统性偏乐观。
          // 用 elapsed_min 给出"至少已经跌破了多久"的下界（不管是否已收复都写）；是否属于删失
          // 样本，看 break_cost_line_min 有没有值即可——有值=已收复，缺失=仍未站回（删失）。
          const belowBars = (breakoutIdx >= 0 ? breakoutIdx : chrono.length) - breakdownIdx;
          features['v_breakout_volume_recent_below_cost_line_elapsed_min'] = belowBars * barMinForGap;
          if (breakoutIdx >= 0) {
            features['v_breakout_volume_recent_break_cost_line_min'] = belowBars * barMinForGap;
          }
        }
      }
    }

    // 创建者推特改名次数：gmgn.dev.twitter_name_change_history 是数组，改名越频繁越可疑（换皮/规避追踪）。
    // 数组本身不进数值特征体系（flattenObject 把它收进 arrays），这里取长度作为标量字段。
    // 数组不存在时不写入（该 token 没有 gmgn.dev 数据），不强行给 0。
    const twChangeHist = arrays['gmgn.dev.twitter_name_change_history'];
    if (Array.isArray(twChangeHist)) features['gmgn.dev.twitter_name_change_count'] = twChangeHist.length;

    // 最近一个 V 转信号（last_alert）的最低点是否比上一个 V 转信号的最低点更低（用户需求新增字段）：
    // 1 = 更低（连续创新低，形态可能更弱），0 = 未创新低。last_alert.low_price/pre_low_price
    // 由 flattenObject 对 signal.last_alert 递归展开自动产生，不需要单独处理嵌套结构；
    // 任一侧缺失（比如历史上只出现过一次 V 转信号，没有 pre_low_price）不参与，不强行给默认值。
    const lastAlertLow = features['last_alert.low_price'];
    const lastAlertPreLow = features['last_alert.pre_low_price'];
    if (fin(lastAlertLow) && fin(lastAlertPreLow)) {
      features['last_alert_low_lower_than_pre_low'] = lastAlertLow < lastAlertPreLow ? 1 : 0;
    }

    // 是否在成本线之上 / 与成本线的距离：直接取平台算好的 avg_price_deviation_pct，不再自己拿
    // logearn.mcap 去比 kline 的 current_avg_price。
    //
    // 为什么改：这两个值【不同源】——current_avg_price 来自 kline_and_indicators（最新一根K线的
    // 累计加权成本），logearn.mcap 是快照抓取时刻的市值，两者时间基准不一致。在秒级K线的高波动
    // 币上差距极大，实测两条真实样本：
    //   LMAO!: 自己算 (12539−9892)/9892 = 26.8%，平台 avg_price_deviation_pct = 150.6%（差 5 倍多）
    //   nice : 自己算 (12309−8097)/8097 = 52.0%，平台 avg_price_deviation_pct = 93.3%
    // 平台那个值是 kline 内部同源计算的（current_price 与 current_avg_price 都取自同一根K线），
    // 才是策略侧「偏离%」判定真正用的口径。
    //
    // 改用平台值后，cost_line_distance_pct 与 kline_and_indicators.avg_price_deviation_pct 完全
    // 相同，属于冗余字段——按 mcap/fdv/current_mcap 的既有处理方式合并掉一个，避免同一个信息在
    // 相关性表里占两行、还让多重比较校正的 m 无谓多算一次。
    const deviationPct = features['kline_and_indicators.avg_price_deviation_pct'];
    if (fin(deviationPct)) {
      features['cost_line_distance_pct'] = deviationPct;
      features['above_cost_line'] = deviationPct > 0 ? 1 : 0;
      delete features['kline_and_indicators.avg_price_deviation_pct'];
    }

    // V 转信号最低点与"当时"成本线之间的距离（用户需求新增字段）：成本线随时间变化，不能直接用
    // current_avg_price（那是快照抓取时刻的成本线），要用 avg_price_bars 历史数组按最低点发生时间
    // 回溯找最近的一根（同 强势盘策略/v1/code.js 的 costMcapAt 逻辑）；找不到历史数据时退回当前成本线。
    // low_price_mcap 与 current_avg_price 同为市值(USD)口径（用 low_price/low_price_mcp 会是价格/另一种
    // 口径，与成本线单位不一致，不能直接相减）。
    // 数据源必须是 recentV（最近生效的那条V转信号），不能用 last_alert——last_alert 是"最近一次
    // 【任意类型】信号"，可能是精选/苏醒/关注钱包，那些信号根本没有 low_price_mcap 字段。用它的
    // 后果是：这个字段的样本集与同组其他 v_breakout_volume_recent_* 字段对不上（只有恰好
    // last_alert 是V转信号的行才有值），交叉分析时两个字段的 n 不同源、结论没法互相印证。
    // 同时 _mcap 优先、_mcp 兜底（真实样本里两者同时存在且数值不同，见 low_price_mcap / _mcp 的取值口径）。
    const lowMcap = recentV ? (fin(recentV.low_price_mcap) ? recentV.low_price_mcap
                             : (fin(recentV.low_price_mcp) ? recentV.low_price_mcp : undefined))
                            : undefined;
    const lowTimeRaw = recentV ? recentV.low_price_time : undefined;
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
        features['v_breakout_volume_recent_low_cost_line_distance_pct'] = (lowMcap - costAtLow) / costAtLow * 100;
      }
    }

    applyContinueBreakoutFeatures(features, s, buyMs, swapBeginMs);
    applyBreakout10xFeatures(features, s, buyMs, swapBeginMs);
    applyWhaleFeatures(features, s, buyMs, swapBeginMs);

    applyKlineVolumeShapeFeatures(features, arrays);
    applyHolderStatsFeatures(features, arrays);
    applyGmgnTopFeatures(features);
    applyMaxUpFeatures(features, mcap);
    applySignalTimingFeatures(features, categorical, s, buyMs);

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
      // 走 toMilliseconds 归一，而不是裸 /1000：同一个函数里匹配逻辑用的是 tsOrZeroMs
      // （秒/毫秒都兼容），这两行却写死了"输入一定是毫秒"。一旦某批数据的 timestamp 是秒，
      // 观察窗口会小 1000 倍，"观察时长不足 6 小时"的警告就对所有样本无差别触发。
      // 输入本来就是毫秒时，toMilliseconds 原样返回，结果不变。
      buyTimestamp: Number.isFinite(toMilliseconds(s.timestamp)) ? toMilliseconds(s.timestamp) / 1000 : null,
      exportTimestamp: Number.isFinite(toMilliseconds(c.timestamp)) ? toMilliseconds(c.timestamp) / 1000 : null,
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
      // 快照所属策略名（snapshot.strategy_name）：同一个工作集可能通过"追加数据"混入多个策略的
      // 样本，逐行记下来源才能在界面上如实展示"当前数据来自哪个/哪些策略"。
      strategyName: s.strategy_name || '',
      // 快照原始 ctx 的【引用】（不是拷贝，不额外占内存）：策略回放（"8. CA 定位"里的策略诊断）需要
      // 把策略源码原样跑一遍，而策略读的是 ctx.logearn / ctx.gmgn / ctx.kline_and_indicators 这套
      // 原始嵌套结构，扁平化后的 features 无法还原。只有这一个功能会用到，其它分析一律走 getFeature。
      rawCtx: s.ctx || null,
      // 原始 signal 也留一份【引用】（不是拷贝，不占额外内存），供快照查看器展示。
      // features 里的信号字段是 flatten 之后的扁平结果，看不出原始嵌套结构。
      rawSignal: s.signal || null,
      // 原始 call 记录（同样只留引用）：min_mcap/min_mcap_time/max_mcap_time 这些字段值看着
      // 不对时，得回这份原始 JSON 核对是算错了还是数据本来就这样——features 里没有这些
      // call 独有字段的原始嵌套（大多数已经被拆开算成 returnMax/post_buy_max_drawdown_pct
      // 这类衍生字段），只有这里能看到 call 本身长什么样。
      rawCall: c || null
    });
  }
  buildRows.lastSkippedByTimeDiff = skippedByTimeDiff;
  return rows;
}

function isAssembledField(key) {
  // composite_score 是进阶分析“组合评分”写入工作集的衍生字段，归入组装字段口径
  return DERIVED_KEYS.includes(key) || SIGNAL_KEYS.includes(key) || key === 'composite_score' || customFields.some(c => c.name === key);
}

// K线量能字段单独判定：字段浏览器分组时优先于 isAssembledField 判断，把这组从"组装字段"里摘出来
function isKlineVolumeField(key) {
  return KLINE_VOLUME_KEYS.includes(key);
}

// 信号字段单独判定：字段浏览器要把它们从"组装字段"里分出来单独成组
function isSignalField(key) {
  return SIGNAL_KEYS.includes(key);
}

// dev 组：创建者/开发者维度。用【显式清单】而不是 gmgn.dev.* 前缀——前缀会把用户没圈定的字段
// （dexscr_ad / cto_flag / offchain / 各种资金来源 _ts 等噪声）也一并抓进来。只保留用户指定的这些。
const DEV_FIELDS = new Set([
  'gmgn.dev.creator_open_count',        // 创建者历史发币数（发币越多越像惯犯）
  'gmgn.dev.top_10_holder_rate',        // 前10大持有人占比
  // gmgn.dev.creator_token_balance 已删除：与 gmgn.stat.creator_token_balance 同名同义，
  // 未核实出与 top_10_holder_rate 那样的口径差异，保留 stat 那份即可，避免同一信号在
  // 因子有效性分析/相关性扫描里被当成两个独立字段各算一次。
  'gmgn.dev.twitter_create_token_count',// 推特宣传过的发币数
  'gmgn.dev.twitter_del_post_token_count', // 删除过的发币帖子数
  'gmgn.dev.twitter_name_change_count', // 推特改名次数（本工具从数组算出的派生字段）
  'gmgn.dev.dexscr_boost_fee',          // 是否买 DexScreener Boost
]);
function isDevField(key) { return DEV_FIELDS.has(key); }

// stat 组：链上持仓结构/交易者画像维度。同样用显式清单，只保留用户指定字段。
const STAT_FIELDS = new Set([
  'gmgn.stat.top_rat_trader_percentage',        // 插队/内鬼交易者成交占比
  'gmgn.stat.top_bundler_trader_percentage',    // 机器人捆绑买入成交占比
  'gmgn.stat.top_entrapment_trader_percentage', // 诱多/陷阱交易者成交占比
  'gmgn.stat.top_bot_degen_percentage',         // 机器人 degen 钱包成交占比
  'gmgn.stat.creator_created_count',            // 创建者历史发币数
  'gmgn.stat.bot_degen_count',                  // 机器人 degen 钱包数量
  'gmgn.stat.bot_degen_rate',                   // 机器人 degen 钱包占比
  'gmgn.stat.fresh_wallet_rate',                // 新钱包持仓占比
  'gmgn.stat.top_10_holder_rate',               // 前10大持有人占比（>0.5 高风险）
  'gmgn.stat.dev_team_hold_rate',               // 开发团队持仓占比
  'gmgn.stat.creator_hold_rate',                // 创建者持仓占比
  'gmgn.stat.creator_token_balance',            // 创建者当前持仓数量
  'gmgn.stat.top70_sniper_hold_rate',           // 前70名狙击手钱包持仓占比
]);
function isStatField(key) { return STAT_FIELDS.has(key); }

// 筹码组判定：chip_analysis.* 是筹码峰分析维度——套牢/获利占比、内盘卖出、筹码峰位置、头部来源等，
// 既有平台直接给的标量，也有从 price_bars/top5_holders 数组组装出来的。用"前缀 + 排除清单"：
// 前缀能自动纳入以后新增的派生字段，排除清单挡掉冗余/无意义的。
// current_mcap 只是 ctx.logearn.mcap 的副本（平台在 chip_analysis 里顺带塞的当前市值），与 mcap
// 完全重复，不该单独占一个筹码字段——否则相关性表里同一个信息出现两次、多重比较校正的 m 也虚增。
const CHIP_FIELD_EXCLUDE = new Set([
  'chip_analysis.current_mcap',
]);
// 持仓指标：logearn 的 *_volume 系列——各类钱包人群的实时持仓占比（%）。这是最核心的一组
// 筛选字段（垃圾钱包>5 / 新钱包>60 / 高频>50 都是危险信号），单独成组放最前。
const HOLDING_INDICATOR_FIELDS = new Set([
  'smart_volume',     // 聪明钱持仓占比
  'whale_volume',     // 蓝筹头部赢家持仓占比
  'frequent_volume',  // 高频交易者持仓占比
  'new_volume',       // 新钱包持仓占比
  'old_volume',       // 老钱包持仓占比
  'shit_volume',      // 垃圾钱包持仓占比
  // 已移除 scam_volume / amm_volume / exchange_volume：实测这三个在真实数据里恒为 0
  // （零方差 → AUC 恰好 0.5、置信区间宽度为 0），不含任何信息量，留在候选池里只会
  // 占位并被误读成"测过了不显著"。若将来数据源开始提供非零值，再加回来即可。
]);
function isHoldingField(key) { return HOLDING_INDICATOR_FIELDS.has(key); }

// holders 组：Top100 持有人快照聚合出的行级占比字段，全部 holder_ 前缀单独成组。
function isHolderField(key) {
  return typeof key === 'string' && key.indexOf('holder_') === 0;
}

function isChipField(key) {
  return typeof key === 'string' && key.indexOf('chip_analysis.') === 0 && !CHIP_FIELD_EXCLUDE.has(key);
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

// 元数据/常量字段：技术参数、链上标识、UI 状态、以及实测恒为 0 的量。它们有数值、能通过
// isNumericColumn，所以不主动剔就会一直待在候选池里，被当成"测过了不显著"。
// 分三类，删的理由不同：
//   1) 技术元数据（decimals/bnb_decimal/chain）——代币精度、链 ID，同一数据集内基本是常量；
//   2) 与标的无关的外部行情（bnb_price）——Solana meme 币的收益和 BNB 价格没有因果关系，
//      而它随快照时间单调漂移，极易和"样本采集顺序"耦合出伪相关；
//   3) UI 状态位与恒零量（dexscreen_loading / amm_volume / exchange_volume / scam_volume）。
const NON_ANALYTIC_FIELDS = new Set([
  'amm_volume', 'exchange_volume', 'scam_volume',
  'bnb_decimal', 'bnb_price', 'decimals', 'chain', 'dexscreen_loading',
  // 加载态标志位
  'goplus_loading',
  // 平台榜单位次：随平台流量和榜单算法变化，不是标的自身属性
  'h1_featured_index', 'hot_index',
  // 平台侧的分类布尔标记。这类 0/1 标志在真实样本里绝大多数恒为 0（方差≈0），
  // 留在候选池只会拉高多重比较的 m，把真字段的校正后 p 拖下去
  'is_diamond_token', 'is_error_market_token', 'is_honey', 'is_scam_token',
  'is_top_token', 'is_trench_token',
  'is_fake', 'is_fake_bonk', 'is_fake_four', 'is_fake_pump',
  // 原生币行情与精度：和 bnb_price/bnb_decimal 同类。sol_price 是全市场共同的外部行情，
  // 对同一时刻的所有样本都一样，只随快照时间漂移——极易和"样本采集顺序"耦合出伪相关。
  'sol_decimal', 'sol_price',
  // 筹码上下方占比是一对：above_below_ratio 已经承载了它们的关系，
  // 再把 below 单独放进候选池就是重复计数。注意这里只是不参与分析，
  // 字段本身仍会算出来——above_below_ratio 要拿它当分母。
  'chip_analysis.below_percent',
  // 记录数与总供应量：total_record 是接口分页元数据；total_supply 是绝对代币数量
  // （meme 币动辄 10 亿枚，和收益无关），它有用的形态是换手率 kline_turnover_pct，已经算好了。
  // 注意这里是精确匹配，gmgn.total_supply 是另一个字段（用于算流通占比），不受影响。
  'total_record', 'total_supply',
  // 创建者历史上表现最好的【另一个】代币的历史最高市值：绝对美元数值，且说的是别的代币，
  // 不是当前正在评估的这一个，跨样本不可比（同 kline_and_indicators 原始价格那类问题）。
  'gmgn.dev.ath_token_info.ath_mc',
]);

// 整棵子树都不参与分析的前缀：
// 1) highlight.* —— 平台给前端用的高亮开关（is_usdt/is_live/is_cake…）。注意它和
//    CORR_INTERNAL_FIELD_RE 里的 _highlight_ 不是一回事：那个匹配下划线命名的
//    _highlight_mcap_update，这里是点号路径的 highlight.is_xxx，两种写法平台都在用。
// 2) kline_and_indicators.* —— 这个子树是【计算输入】而不是特征：current_price/
//    current_avg_price/current_ao 是绝对值，跨样本不可比（$0.00001 的币和 $8K 市值的币
//    放一起没有意义）；kline_is_usd/kline_is_mcap 是单位标志位；timestamp/resolution 是
//    元数据。真正可用的信息已经被加工成 cost_line_distance_pct、kline_volume_cv、
//    kline_max_rise_* 等占比/速率字段了，原始量留在候选池只会重复计数并稀释多重比较校正。
//    （kline_bars / avg_price_bars 是数组，本来就进 arrays 不进 features，不受影响。）
// 3) last_alert.* —— 上一次告警的原始快照：绝对价格（top_price/low_price/min_price）、
//    绝对市值、各档 fibon 位、以及一堆时间戳。同样是原始量而非特征，跨样本不可比。
const NON_ANALYTIC_PREFIX_RE = /^highlight\.|^kline_and_indicators\.|^last_alert\./;

// 字段候选池的统一剔除判定。散点图/AUC/字段浏览器/字段导出都走这一个函数——
// 之前 _highlight_*/ai_max_* 只在相关性池挡了一道、候选池没挡，就是两处口径漂移的后果。
function isNonAnalyticField(key) {
  if (typeof key !== 'string') return false;
  return NON_ANALYTIC_FIELDS.has(key)
    || NON_ANALYTIC_PREFIX_RE.test(key)
    || CORR_INTERNAL_FIELD_RE.test(key)
    // 绝对时间戳同样挡在候选池外。这条规则本来只用在相关性池，候选池没接，
    // 结果 ai_max_price_time / kline_and_indicators.timestamp / last_alert.*_time
    // 只能一批批手工点名。时间信息的正确形态是【时长】（_min/_duration），
    // 那些不带 _time/_ts 后缀，不受这条规则影响。
    || CORR_TIMESTAMP_FIELD_RE.test(key);
}

function correlationPoolExclusionReason(key) {
  if (CORR_TIMESTAMP_FIELD_RE.test(key)) return 'timestamp';
  if (CORR_INTERNAL_FIELD_RE.test(key)) return 'internal';
  if (NON_ANALYTIC_FIELDS.has(key) || NON_ANALYTIC_PREFIX_RE.test(key)) return 'metadata';
  return null;
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
  // 桶名必须与 correlationPoolExclusionReason 的返回值一一对应。这里用 || [] 兜底：
  // 之前新增 'metadata' 这个 reason 时忘了加桶，excluded['metadata'].push 直接抛异常，
  // 而它在 computeCorrelations 主链路上 —— 整个"分析"流程崩掉，一条数据都加载不出来。
  const excluded = { timestamp: [], internal: [], metadata: [], constant: [] };
  for (const fkey of featureKeys) {
    const preReason = correlationPoolExclusionReason(fkey);
    if (preReason) { (excluded[preReason] = excluded[preReason] || []).push(fkey); continue; }
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
          // p 对应主指标 Spearman ρ（Fisher z 变换近似，同一个函数对 r/ρ 都适用），不是线性 r 的 p——
          // 表格里 ρ 是加★的主排序列，p 若还按 r 算，会出现"ρ 很大但 p 却是 r 的显著性"这种对不上的
          // 情况（之前的 bug：r 弱但 ρ 强的字段，p 会显示成不显著，跟星标的主指标脱节）。
          p: pearsonPValue(rho, pairs.length),
          pr: pearsonPValue(r, pairs.length),
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

export {
  ADDRESS_LIKE_KEYS,
  BUILD_ROWS_CHUNK_SIZE,
  CHIP_FIELD_EXCLUDE,
  CORR_INTERNAL_FIELD_RE,
  CORR_TIMESTAMP_FIELD_RE,
  DERIVED_KEYS,
  DEV_FIELDS,
  HOLDING_INDICATOR_FIELDS,
  KLINE_VOLUME_KEYS,
  MAX_SNAPSHOT_MATCH_DIFF_SECONDS,
  NON_ANALYTIC_FIELDS,
  NON_ANALYTIC_PREFIX_RE,
  PERCENT_FRACTION_FIELDS,
  ROW_LEVEL_FIELDS,
  SIGNAL_KEYS,
  STAT_FIELDS,
  applyBreakout10xFeatures,
  applyChipShapeFeatures,
  applyContinueBreakoutFeatures,
  applyGmgnTopFeatures,
  applyHolderStatsFeatures,
  applyKlineVolumeShapeFeatures,
  applyMaxUpFeatures,
  applySignalTimingFeatures,
  applySimpleRatioFeatures,
  applyWhaleFeatures,
  buildRows,
  callKey,
  computeCorrelations,
  correlationPoolExclusionReason,
  detectFileKind,
  flattenCtx,
  flattenObject,
  getFeature,
  isAddressLikeKey,
  isAssembledField,
  isChipField,
  isDevField,
  isFiniteNumber,
  isHolderField,
  isHoldingField,
  isKlineVolumeField,
  isNonAnalyticField,
  isNumericColumn,
  isSignalField,
  isStatField,
  looksLikeAddressString,
  measureBarMinutes,
  num,
  readJson,
  resolveNativeDecimals,
  snapKey,
  toMilliseconds,
  tsOrZeroMs,
};
