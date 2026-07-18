// ========== 字段中文含义词典（FIELD_DESC / SOURCE_DESC / TERM_MAP / TIME_MAP）与翻译函数 ==========
// 纯数据 + 纯函数模块，不依赖其他模块（getFieldDesc 内部只读全局字典，不依赖 DOM/state）。

// 字段中文含义备注（ctx / snapshot.signal 通用）
const FIELD_DESC = {
  // 收益
  'returnCurrent': '当前倍数 = current_mcap / initial_mcap（1=不涨不跌，2=涨一倍）',
  'returnMax': '期间最大倍数 = max_mcap / initial_mcap（1=不涨不跌，2=涨一倍）',

  // GMGN 风险/持仓比例类字段：原始值是 0-1 小数，这里已 ×100 转成百分比数值（如 3.31 表示 3.31%）
  'gmgn.stat.top_rat_trader_percentage': '插队/内鬼交易者成交占比（%，已从 0-1 小数转换，取值范围 0-100）',
  'gmgn.stat.top_bundler_trader_percentage': '机器人捆绑买入成交占比（%，已从 0-1 小数转换，取值范围 0-100）',
  'gmgn.stat.top_entrapment_trader_percentage': '诱多/陷阱交易者成交占比（%，已从 0-1 小数转换，取值范围 0-100）',
  'gmgn.stat.top_bot_degen_percentage': '机器人 degen 钱包成交占比（%，已从 0-1 小数转换，取值范围 0-100）',
  'gmgn.stat.bot_degen_rate': '机器人 degen 钱包占比（%，已从 0-1 小数转换，取值范围 0-100）',
  'gmgn.stat.fresh_wallet_rate': '新钱包持仓占比（%，已从 0-1 小数转换，取值范围 0-100）',
  'gmgn.stat.top_10_holder_rate': '前10大持有人占比（%，已从 0-1 小数转换，取值范围 0-100）',
  'gmgn.stat.dev_team_hold_rate': '开发团队持仓占比（%，已从 0-1 小数转换，取值范围 0-100）',
  'gmgn.stat.creator_hold_rate': '创建者持仓占比（%，已从 0-1 小数转换，取值范围 0-100）',
  'gmgn.stat.private_vault_hold_rate': '私有金库地址持仓占比（%，已从 0-1 小数转换，取值范围 0-100）',
  'gmgn.stat.top70_sniper_hold_rate': '前70狙击手钱包持仓占比（%，已从 0-1 小数转换，取值范围 0-100）',
  'gmgn.dev.top_10_holder_rate': '前10大持有人占比（%，已从 0-1 小数转换，取值范围 0-100）',
  'gmgn.locked_ratio': '流动性锁仓比例（%，已从 0-1 小数转换，取值范围 0-100）',

  // 基础信息
  'id': '记录 ID',
  'token_address': 'token 合约地址',
  'symbol': 'token 名称/代码',
  'token_name': 'token 名称',
  'total_supply': '总供应量',
  'decimals': '精度',
  'chain': '链 ID',
  'platform': '平台/发射平台',
  'creator_address': '创建者地址',
  'creator_tag': '创建者标签',
  'main_pool_address': '主池地址',
  'swap_begin_time': '交易开始时间',
  'launch_time_duration': '上线时间长度',

  // 价格
  'price_now': '当前价格',
  'current_price': '当前 Token 价格',
  'price_change_1d': '1天价格涨幅（%）',
  'price_change_6h': '6小时价格涨幅（%）',
  'price_change_1h': '1小时价格涨幅（%）',
  'price_change_5m': '5分钟价格涨幅（%）',

  // 市值 / 流动性
  'fdv': '完全稀释估值',
  'mcap': '市值',
  'current_mcap': '当前 USD 市值',
  'initialMcap': '进场时市值',
  'pool_liquidity': '池子流动性',

  // 趋势 / 信号
  'whale_count': '鲸鱼数量',
  'score': '综合评分',
  'max_up_duration': '最大上涨持续时间',
  'max_up_ratio': '最大上涨幅度（%）',
  'max_up_mcap': '最大上涨时市值',
  'max_up_mcap_time': '最大上涨时时间',
  'signal_count_d1': '信号数量（1天）',

  // 聪明钱 / 交易者数量
  'smart_money_address_buy_count_d1': '聪明钱买入地址数（1天）',
  'smart_money_address_sell_count_d1': '聪明钱卖出地址数（1天）',
  'buyer_count_d1': '买方地址数（1天）',
  'seller_count_d1': '卖方地址数（1天）',
  'buy_tx_count_d1': '买入交易数（1天）',
  'sell_tx_count_d1': '卖出交易数（1天）',

  // 买入/卖出金额
  'buy_wcoin_amount_d1': '买入金额（1天）',
  'sell_wcoin_amount_d1': '卖出金额（1天）',
  'buy_wcoin_amount_m5': '买入金额（5分钟）',
  'sell_wcoin_amount_m5': '卖出金额（5分钟）',
  'buy_wcoin_amount_h1': '买入金额（1小时）',
  'sell_wcoin_amount_h1': '卖出金额（1小时）',

  // 分析信号
  'analysis_open_price': '分析开盘价',
  'analysis_whale_signal_mcap': '鲸鱼信号市值',
  'analysis_whale_signal_time_duration': '鲸鱼信号持续时间',

  // AI 预测
  'ai_max_up_ratio': 'AI 预测最大上涨幅度',
  'ai_max_up_duration': 'AI 预测最大上涨持续时间',
  'ai_max_up_ratio_mcap': 'AI 预测最大上涨市值',

  // 信号时间/市值
  'signal_open_time': '信号开仓时间',
  'signal_open_mcap': '信号开仓市值',
  'signal_max_time': '信号最大时间',
  'signal_max_mcap': '信号最大市值',
  'signal_max_ratio': '信号最大涨幅（%）',
  'signal_best_type': '信号最佳类型',

  // 各信号历史最大涨幅
  'all_signals_max_ratio': '各信号历史最大涨幅',
  'open_time': '开仓时间',
  'open_mcap': '开仓市值',
  'max_time': '达到最大值时间',
  'max_mcap': '最大值市值',
  'max_ratio': '最大涨幅（%）',
  'type': '信号类型',

  // K线/指标（ctx.kline_and_indicators）
  'kline_and_indicators': '历史 K 线 + avg_price/AO 等指标数据',
  'resolution': 'K线粒度（系统自动推算）',
  'current_avg_price': '当前整体持仓用户的平均价',
  'avg_price_deviation_pct': '当前价格相当于平均价的涨幅',
  'kline_is_usd': 'K线计价单位（true=美元本位，false=原生币本位）',
  'kline_is_mcap': 'K线数值口径（true=市值，false=价格）',
  'current_ao': '当前 AO 值',
  'ao_bars': 'AO 指标历史数据',
  'kline_bars': 'K 线历史数据',
  'avg_price_bars': '平均价指标历史数据',

  // 筹码分析（ctx.chip_analysis）
  'chip_analysis': '筹码分析',
  'above_percent': '当前价格以上仍持有的筹码占比（%）；越高=抛压越大',
  'below_percent': '当前价格以下仍持有的筹码占比（%）；越高=底部支撑越强',
  'total_holding_percent': 'Top 500 持有者累积持仓 / total_supply（%）',
  'inner_sell_ratio': '内盘卖出率（%）',
  'inner_address_holding': '内盘地址剩余持仓 / 全部持仓（%）',
  'inner_holding_address_count': '内盘地址里当前仍有持仓的去重地址数',
  'price_bars': '按市值区间分 70 桶的筹码分布',
  'time_bars': '按 K 线粒度对齐的时间筹码分布',
  'top5_holders': '仍持有的前 5 大地址',
  'wallet': '钱包地址',
  'total_hold_percent': '该地址仍持有 / total_supply（%）',
  'buy_percent': '持仓里"买入得来"的部分 / total_supply（%）',
  'transfer_in_percent': '持仓里"转账进来"的部分 / total_supply（%）；高=老鼠仓/分发',
  'buy_cost': '买入部分的总成本（USD）',
  'time': '建仓时间（Unix 秒）',

  // 其它 ctx
  'logearn': 'LogEarn token 全部维度数据、信号数据、八大实时持仓指标',
  'gmgn': 'GMGN Token 详情数据',
  'holders': 'GMGN 持仓人 Top 100',
  'narrative': 'Token 叙事文本',
  'native_coin_price': '当前链原生币价格（SOL/BNB）',
  'native_coin_decimal': '当前链原生币精度',
  'log': '日志输出',
  'add_blacklist': '拉黑 token 合约地址函数',

  // 数据加载标记
  'dexscreen_loading': 'DexScreen 加载中',
  'dexscreen_data': 'DexScreen 数据',
  'goplus_loading': 'GoPlus 加载中',
  'goplus_data': 'GoPlus 数据',
  'total_record': '总记录数',

  // 排行榜 / 跟随地址
  'last_alert': '上次告警数据',
  'followed_tx_analysis': '跟随地址交易分析',
  'm5_featured_index': 'M5 榜单排名',
  'h1_featured_index': 'H1 榜单排名',

  // 跟随地址子字段
  'buy_amount': '跟随地址买入金额',
  'sell_amount': '跟随地址卖出金额',
  'buy_value': '跟随地址买入价值',
  'sell_value': '跟随地址卖出价值',
  'buy_count': '跟随地址买入次数',
  'sell_count': '跟随地址卖出次数',
  'net_in': '跟随地址净流入（买入-卖出）',
  'net_in_e': '跟随地址净流入（另一种口径）',

  // 组装字段
  'buy_sell_amount_ratio': '买入金额 / 卖出金额（1天）',
  'buy_sell_count_ratio': '买方地址数 / 卖方地址数（1天）',
  'buy_sell_tx_ratio': '买入交易数 / 卖出交易数（1天）',
  'smart_buy_sell_ratio': '聪明钱买入数 / 聪明钱卖出数（1天）',
  'mcap_liquidity_ratio': '市值 / 池子流动性',
  'avg_buy_amount': '平均每笔买入金额',
  'avg_sell_amount': '平均每笔卖出金额',
  'chip_analysis.above_below_ratio': '筹码上下比例 = chip_analysis.above_percent / chip_analysis.below_percent（越高=当前价上方套牢盘相对下方支撑盘越多，抛压风险越大）',
  'buy_tx_per_buyer': '人均买入笔数 = buy_tx_count_d1 / buyer_count_d1（越高=可能是少数人/机器人在刷单，而不是很多真实用户参与）',
  'smart_money_net_buy_count': '聪明钱净买入地址数 = smart_money_address_buy_count_d1 - smart_money_address_sell_count_d1',
  'chip_analysis.pressure_net': '筹码净压力指标 = chip_analysis.above_percent - chip_analysis.below_percent（正数=上方套牢盘更多抛压大，负数=下方支撑更强）',
};

// 数据源/前缀说明
const SOURCE_DESC = {
  'signal': '快照 signal',
  'logearn': 'LogEarn token 全部维度数据、信号数据、八大实时持仓指标',
  'gmgn': 'GMGN Token 详情数据',
  'kline_and_indicators': '历史 K 线 + avg_price/AO 等指标数据',
  'chip_analysis': '筹码分析',
};

// 常见字段段中文词库
const TERM_MAP = {
  'buy': '买入', 'sell': '卖出', 'amount': '金额', 'value': '价值', 'volume': '交易量',
  'count': '数量/次数', 'tx': '交易', 'address': '地址', 'price': '价格', 'mcap': '市值',
  'liquidity': '流动性', 'holder': '持有者', 'holders': '持有者', 'smart': '聪明钱', 'whale': '鲸鱼',
  'ratio': '比例/比率', 'percent': '百分比', 'duration': '持续时间', 'time': '时间', 'current': '当前',
  'max': '最大', 'min': '最小', 'avg': '平均', 'total': '总计', 'supply': '供应量',
  'dev': '开发者', 'creator': '创建者', 'top': '头部', 'wallet': '钱包', 'fee': '费用',
  'pool': '池子', 'token': '代币', 'symbol': '代码', 'name': '名称', 'open': '开盘',
  'close': '收盘', 'high': '最高', 'low': '最低', 'signal': '信号', 'alert': '告警',
  'featured': '精选', 'breakout': '突破', 'continue': '持续', 'followed': '跟随', 'last': '最近',
  'traded': '交易', 'index': '排名/指数', 'change': '变化/涨幅', 'rise': '上涨',
  'type': '类型', 'resolution': 'K线粒度', 'kline': 'K线', 'indicators': '指标',
  'analysis': '分析', 'native': '原生', 'coin': '币', 'decimal': '精度', 'bnb': 'BNB',
  'sol': 'SOL', 'usd': '美元', 'loading': '加载中', 'data': '数据', 'highlight': '高亮',
  'off_meta': '附加元数据', 'progress': '进度', 'hot': '热度', 'platform': '平台',
  'fake': '虚假', 'pump': 'pump', 'amm': 'AMM', 'exchange': '交易所', 'frequent': '频繁',
  'new': '新增', 'old': '老用户', 'scam': '诈骗', 'shit': '垃圾', 'smart_volume': '聪明钱交易量',
  'whale_volume': '鲸鱼交易量', 'stat': '统计', 'link': '链接', 'distribution': '分配',
  'launchpad': '发射台', 'status': '状态', 'locked': '锁定', 'charity': '慈善', 'ath': '历史最高',
  'twitter': '推特', 'website': '官网', 'telegram': '电报', 'github': 'GitHub', 'discord': 'Discord',
  'reddit': 'Reddit', 'youtube': 'YouTube', 'description': '描述', 'verify_status': '认证状态',
  'image_dup': '图片重复', 'visiting': '访问', 'og': 'OG', 'standard': '标准',
  'trade_fee': '交易费', 'total_fee': '总费用', 'top_10_holder_rate': '前10持有者比例',
  'top_70': '前70', 'sniper': '狙击手', 'bundler': '打包者', 'rat_trader': '老鼠仓交易员',
  'bot_degen': 'bot/degens', 'fresh_wallet': '新钱包', 'renowned': '知名',
  'private_vault': '私人金库', 'dev_team_hold': '开发团队持仓', 'creator_hold': '创建者持仓',
  'circulating': '流通', 'max_supply': '最大供应量', 'quote': '计价币', 'base': '基础币',
  'reserve': '储备', 'vault': '金库', 'creation': '创建', 'migration': '迁移',
  'creator_open': '创建次数', 'offchain': '链下', 'fund_from': '资金来源', 'cto_flag': 'CTO标记',
  'dexscr': 'DexScreen', 'ad': '广告', 'boost': '助推', 'trending': ' trending',
  'update_link': '更新链接', 'del_post': '删帖', 'create_token': '创建代币',
  'bonus_category': '奖励类别', 'fee_authority': '费用权限', 'show': '展示', 'private': '私有',
  'list': '列表', 'ath_token_info': 'ATH 代币信息', 'avatar': '头像',
  'above_percent': '当前价格以上仍持有的筹码占比（越高=抛压越大）',
  'below_percent': '当前价格以下仍持有的筹码占比（越高=底部支撑越强）',
  'total_holding_percent': 'Top500 持仓占比', 'inner_sell_ratio': '内盘卖出率',
  'inner_address_holding': '内盘地址剩余持仓占比', 'inner_holding_address_count': '内盘仍有持仓地址数',
  'price_bars': '按市值区间的筹码分布', 'time_bars': '按时间的筹码分布',
  'top5_holders': '前5大持有者', 'wallet': '钱包地址', 'total_hold_percent': '该地址持仓占比',
  'buy_percent': '持仓里买入得来占比', 'transfer_in_percent': '持仓里转账进来占比（高=老鼠仓/分发）',
  'buy_cost': '买入部分总成本（USD）', 'time': '建仓时间（Unix秒）',
  'm5_featured_index': 'M5 榜单排名', 'h1_featured_index': 'H1 榜单排名',
  'total_record': '总记录数', 'last_traded': '最后交易时间',
  'buy_sell_amount_ratio': '买入金额/卖出金额（1天）',
  'buy_sell_count_ratio': '买方地址数/卖方地址数（1天）',
  'buy_sell_tx_ratio': '买入交易数/卖出交易数（1天）',
  'smart_buy_sell_ratio': '聪明钱买入数/聪明钱卖出数（1天）',
  'mcap_liquidity_ratio': '市值/池子流动性',
  'avg_buy_amount': '平均每笔买入金额', 'avg_sell_amount': '平均每笔卖出金额',
  'returnCurrent': '当前倍数(current_mcap/initial_mcap)', 'returnMax': '期间最大倍数(max_mcap/initial_mcap)', 'id': '记录ID',
  'token_address': 'token 合约地址', 'symbol': 'token 代码', 'token_name': 'token 名称',
  'total_supply': '总供应量', 'decimals': '精度', 'chain': '链ID',
  'creator_address': '创建者地址', 'creator_tag': '创建者标签', 'main_pool_address': '主池地址',
  'swap_begin_time': '交易开始时间', 'launch_time_duration': '上线时间长度',
  'price_now': '当前价格', 'current_price': '当前 Token 价格',
  'price_change_1d': '1天价格涨幅', 'price_change_6h': '6小时价格涨幅',
  'price_change_1h': '1小时价格涨幅', 'price_change_5m': '5分钟价格涨幅',
  'fdv': '完全稀释估值', 'mcap': '市值', 'current_mcap': '当前市值',
  'initialMcap': '进场时市值', 'pool_liquidity': '池子流动性',
  'whale_count': '鲸鱼数量', 'score': '综合评分',
  'max_up_duration': '最大上涨持续时间', 'max_up_ratio': '最大上涨幅度',
  'max_up_mcap': '最大上涨时市值', 'max_up_mcap_time': '最大上涨时时间',
  'smart_money_address_buy_count_d1': '聪明钱买入地址数（1天）',
  'smart_money_address_sell_count_d1': '聪明钱卖出地址数（1天）',
  'buyer_count_d1': '买方地址数（1天）', 'seller_count_d1': '卖方地址数（1天）',
  'buy_tx_count_d1': '买入交易数（1天）', 'sell_tx_count_d1': '卖出交易数（1天）',
  'buy_wcoin_amount_d1': '买入金额（1天）', 'sell_wcoin_amount_d1': '卖出金额（1天）',
  'buy_wcoin_amount_m5': '买入金额（5分钟）', 'sell_wcoin_amount_m5': '卖出金额（5分钟）',
  'buy_wcoin_amount_h1': '买入金额（1小时）', 'sell_wcoin_amount_h1': '卖出金额（1小时）',
  'signal_count_d1': '信号数量（1天）', 'analysis_open_price': '分析开盘价',
  'analysis_whale_signal_mcap': '鲸鱼信号市值', 'analysis_whale_signal_time_duration': '鲸鱼信号持续时间',
  'ai_max_up_ratio': 'AI 预测最大上涨幅度', 'ai_max_up_duration': 'AI 预测最大上涨持续时间',
  'ai_max_up_ratio_mcap': 'AI 预测最大上涨市值', 'signal_open_time': '信号开仓时间',
  'signal_open_mcap': '信号开仓市值', 'signal_max_time': '信号最大时间',
  'signal_max_mcap': '信号最大市值', 'signal_max_ratio': '信号最大涨幅',
  'signal_best_type': '信号最佳类型', 'all_signals_max_ratio': '各信号历史最大涨幅',
  'open_time': '开仓时间', 'open_mcap': '开仓市值', 'max_time': '达到最大值时间',
  'max_mcap': '最大值市值', 'max_ratio': '最大涨幅',
  'dexscreen_loading': 'DexScreen 加载中', 'goplus_loading': 'GoPlus 加载中',
  'native_coin_price': '当前链原生币价格（SOL/BNB）', 'native_coin_decimal': '当前链原生币精度',
  'bnb_price': 'BNB 价格', 'sol_price': 'SOL 价格',
  'current_ao': '当前 AO 值', 'avg_price_deviation_pct': '当前价格相对平均价涨幅',
  'current_avg_price': '当前整体持仓平均价', 'kline_is_usd': 'K线是否美元本位',
  'kline_is_mcap': 'K线是否市值口径',
  'buys': '买入', 'sells': '卖出', 'swaps': '交易次数', 'buy_volume': '买入量',
  'sell_volume': '卖出量', 'hot_level': '热度等级', 'holder_count': '持有者数',
  'locked_ratio': '锁定比例', 'migration_market_cap': '迁移时市值', 'og': 'OG 标记',
  'circulating_supply': '流通供应量', 'max_supply': '最大供应量', 'total_supply_gmgn': '总供应量',
  'liquidity': '流动性', 'creation_timestamp': '创建时间戳', 'open_timestamp': '开盘时间戳',
  'migrated_timestamp': '迁移时间戳', 'migrated_pool': '迁移后池子', 'standard': '标准',
};

const TIME_MAP = {
  '1s': '1秒', '5s': '5秒', '15s': '15秒', '1m': '1分钟', '5m': '5分钟', '15m': '15分钟',
  '1h': '1小时', '6h': '6小时', '24h': '24小时', '1d': '1天', 'd1': '1天', 'h1': '1小时',
  'm5': '5分钟'
};

function translateToken(tok) {
  if (!tok) return '';
  const lower = tok.toLowerCase();
  if (TIME_MAP[lower]) return TIME_MAP[lower];
  // 处理 buys_1m / sell_1h 这种复合 token
  const m = lower.match(/^([a-z]+)(\d+[smhd])$/);
  if (m) {
    const word = TERM_MAP[m[1]] || m[1];
    return word + (TIME_MAP[m[2]] || m[2]);
  }
  return TERM_MAP[lower] || tok;
}

function translateTokens(path) {
  if (!path) return '';
  // 同时按 . 和 _ 切分
  const toks = path.split(/[._]/);
  return toks.map(translateToken).filter(Boolean).join(' / ');
}

// 依赖 utils.js 里的 allNumericKeys 状态变量（在 ui.js 声明），仅在函数体内读取，加载顺序无要求
function getFieldDesc(field) {
  if (!field) return '';
  if (FIELD_DESC[field]) return FIELD_DESC[field];
  const parts = field.split('.');
  // 优先最长前缀匹配 FIELD_DESC
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join('.');
    if (FIELD_DESC[prefix]) {
      const sub = parts.slice(i).join('.');
      const subDesc = translateTokens(sub);
      return subDesc ? FIELD_DESC[prefix] + ' / ' + subDesc : FIELD_DESC[prefix];
    }
  }
  // 数据源前缀 + 剩余段翻译
  if (parts.length > 1 && SOURCE_DESC[parts[0]]) {
    const sub = parts.slice(1).join('.');
    const subDesc = translateTokens(sub);
    return subDesc ? SOURCE_DESC[parts[0]] + ' / ' + subDesc : SOURCE_DESC[parts[0]];
  }
  // 单字段：直接翻译
  return translateTokens(field) || '';
}

// 以下两个函数引用的 #currentFieldDesc / #allDescBody 元素在当前 HTML 中不存在（历史遗留 UI），
// 内部已有空守卫，调用不会报错，属于死代码，保留以兼容未来可能恢复该 UI。
function updateCurrentFieldDesc() {
  const el = document.getElementById('currentFieldDesc');
  if (!el) return;
  const x = batchXSelected[0] || '';
  const y = document.getElementById('yField').value;
  const xDesc = getFieldDesc(x);
  const yDesc = getFieldDesc(y);
  if (!xDesc && !yDesc) {
    el.className = 'field-desc empty';
    el.innerHTML = '请选择 X / Y 字段以查看中文含义';
  } else {
    el.className = 'field-desc';
    el.innerHTML = `<b>${escapeHtml(x)}</b>：${escapeHtml(xDesc) || '暂无备注'}<br><b>${escapeHtml(y)}</b>：${escapeHtml(yDesc) || '暂无备注'}`;
  }
}

function renderAllDescTable() {
  const tbody = document.getElementById('allDescBody');
  if (!tbody) return;
  const fields = ['returnCurrent', 'returnMax', ...allNumericKeys].sort();
  tbody.innerHTML = fields.map(f => {
    const desc = getFieldDesc(f);
    return `<tr><td>${escapeHtml(f)}</td><td>${escapeHtml(desc) || '暂无备注'}</td></tr>`;
  }).join('');
}
