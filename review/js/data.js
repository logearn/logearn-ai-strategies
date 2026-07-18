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

function buildRows(calls, snapshots) {
  const snapsByKey = new Map();
  for (const s of snapshots) {
    const k = snapKey(s);
    if (!snapsByKey.has(k)) snapsByKey.set(k, []);
    snapsByKey.get(k).push(s);
  }
  const rows = [];
  let skippedByTimeDiff = 0;
  for (const c of calls) {
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
    const returnCurrent = cur / init;
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
      initialMcap: init,
      currentMcap: cur,
      maxMcap: mx,
      returnCurrent,
      returnMax,
      features,
      // 非数值分类字段（如 platform），供"分组对比""分类字段分析"等 Pro 功能使用；
      // 不参与 getFeature 数值体系（allNumericKeys/scatterOptions 不会包含这些 key）
      categorical,
      // 原始数组字段（如 holders/kline_bars/v_breakout_volume_list），供自定义字段公式里的
      // countWhere/avgField/sumField/giniCoefficient 等聚合函数读取；不参与 getFeature 数值体系
      arrays
    });
  }
  buildRows.lastSkippedByTimeDiff = skippedByTimeDiff;
  return rows;
}

function isAssembledField(key) {
  return DERIVED_KEYS.includes(key) || customFields.some(c => c.name === key);
}

function computeCorrelations(rows) {
  const targets = [
    { key: 'returnCurrent', get: r => r.returnCurrent },
    { key: 'returnMax', get: r => r.returnMax }
  ];
  const featureKeys = new Set();
  rows.forEach(r => Object.keys(r.features).forEach(k => featureKeys.add(k)));
  const list = [];
  for (const fkey of featureKeys) {
    for (const t of targets) {
      const pairs = [];
      for (const r of rows) {
        const v = r.features[fkey];
        const tv = t.get(r);
        if (v !== undefined && v !== null && Number.isFinite(v) && Number.isFinite(tv)) {
          pairs.push([v, tv]);
        }
      }
      if (pairs.length >= 5) {
        const r = pearson(pairs);
        // 布尔/二值字段（去重值 <= 2）的排名信息量很低，Spearman 在这类字段上意义不大，直接跳过（NaN）
        const distinctCount = new Set(pairs.map(p => p[0])).size;
        const rho = distinctCount > 2 ? spearman(pairs) : NaN;
        list.push({
          target: t.key,
          feature: fkey,
          source: isAssembledField(fkey) ? 'assembled' : 'original',
          r,
          n: pairs.length,
          p: pearsonPValue(r, pairs.length),
          rho,
          delta: Number.isFinite(rho) ? Math.abs(r - rho) : NaN
        });
      }
    }
  }
  list.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  return list;
}

// 行级字段统一用 snake_case，与 FIELD_DESC / TERM_MAP / 过滤联想框中的 key 保持一致，
// 避免出现 tokenAddress（驼峰）在数据里却查不到中文说明、也匹配不上联想列表的问题
const ROW_LEVEL_FIELDS = ['symbol', 'signalType', 'id', 'token_address'];

function getFeature(row, field) {
  if (field === 'returnCurrent') return row.returnCurrent;
  if (field === 'returnMax') return row.returnMax;
  if (field === 'token_address') return row.tokenAddress;
  if (ROW_LEVEL_FIELDS.includes(field)) return row[field];
  if (row.features[field] !== undefined) return row.features[field];
  return row.categorical ? row.categorical[field] : undefined;
}

function isNumericColumn(col) {
  if (col === 'returnCurrent' || col === 'returnMax') return true;
  if (ROW_LEVEL_FIELDS.includes(col)) return false;
  for (const r of matchedRows) {
    const v = getFeature(r, col);
    if (v !== undefined && v !== null && !Number.isFinite(Number(v))) return false;
  }
  return true;
}

function isFiniteNumber(v) { return v !== undefined && v !== null && Number.isFinite(Number(v)); }
