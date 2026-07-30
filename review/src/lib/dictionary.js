// ⚠️ 由 js/dictionary.js 机械移植而来：逻辑一行未改，只在文件首尾加了 import / export。
// 122 个既有测试全部改为从这里 import，测试通过即证明移植是忠实的。

// ========== 字段中文含义词典（FIELD_DESC / SOURCE_DESC / TERM_MAP / TIME_MAP）与翻译函数 ==========
// 纯数据 + 纯函数模块，不依赖其他模块（getFieldDesc 内部只读全局字典，不依赖 DOM/state）。

// 字段中文含义备注（ctx / snapshot.signal 通用）
const FIELD_DESC = {
  // 收益
  'returnMax': '期间最大倍数 = max_mcap / initial_mcap（1=不涨不跌，2=涨一倍）',
  'logReturnMax': 'log(returnMax)：对期间最大倍数取自然对数，收窄重尾分布，使 Pearson r/p 值/置信区间更稳健',

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
  'gmgn.dev.twitter_name_change_count': '创建者推特改名次数 = twitter_name_change_history 数组长度；改名越频繁越可疑（换皮/规避追踪）',
  'gmgn.locked_ratio': '流动性锁仓比例（%，已从 0-1 小数转换，取值范围 0-100）',

  // 基础信息
  'id': '记录 ID',
  'token_address': 'token 合约地址',
  'symbol': 'token 名称/代码',
  'signalType': '【分类字段】命中策略时触发买入的信号类型（来自 call 记录的 signal_type，与 signal_last_type 应一致），可用于按信号类型分组对比/上色',
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

  // 组装字段（design doc §20 新增）
  'buy_max_retracement': 'buy 之前最大回撤（v_breakout_volume_list 中 n_pattern_retracement 的最大值，无数据为 0）',
  'post_buy_max_drawdown_pct': '买入之后最大回撤（%） = (initial_mcap - min_mcap) / initial_mcap × 100，min_mcap 是 call 记录的买入之后市值最低点；未跌破买入价时按 0 计，不产生负数；要求 min_mcap_time 早于 max_mcap_time（先探底再冲高），否则（先冲高后砸盘）视为不适用，字段缺失',
  'v_breakout_volume_recent_stage_pct': '当前生效 V 转信号所处的反弹阶段：0=仅回撤确认还未反弹，20/40/60=已依次突破 fibon_break1/2/3（对应反弹 20%/40%/60%）；反弹突破前高（fibon_break4）视为已收尾，不算"生效"，不参与；若没有生效的 V 转信号（n_pattern_confirmed=true 且未收尾）则缺失',
  'v_breakout_volume_recent_below_cost_line_elapsed_min': '【最近生效V转】跌破成本线后已经持续了多少分钟（截至收复或快照时刻）。与 break_cost_line_min 的区别：本字段对未收复的样本也给值（此时是时长下界），所以全样本都有值、不存在删失偏差，做统计时优先用它',
  'v_breakout_volume_recent_break_cost_line_min': '最近一个生效 V 转信号从"收盘价跌破回撤高点(top_price_time)对应的成本价"到"收盘价重新涨破该成本价"经历的时长，单位分钟（按K线根数×resolution换算，兼容不同K线粒度 1s/5s/...）；没有生效V转信号、没跌破过、或跌破后到快照时刻仍未涨破（尚未走完）则缺失',
  'last_alert_low_lower_than_pre_low': '最近一个 V 转信号的最低点是否比上一个 V 转信号的最低点更低（1=更低/连续创新低，0=未创新低；任一侧数据缺失不参与）',

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
  'chip_analysis.below_percent': '下方获利盘占比。【不参与分析】——它与 above_percent 的关系已由 above_below_ratio 承载，单独放进候选池是重复计数；字段本身仍会算出来，因为 above_below_ratio 要拿它做分母',
  'chip_analysis.above_below_ratio': '筹码上下比例 = chip_analysis.above_percent / chip_analysis.below_percent（越高=当前价上方套牢盘相对下方支撑盘越多，抛压风险越大）',
  'chip_analysis.price_to_peak_ratio': '当前市值 / 筹码峰市值。大于1=当前价在筹码峰上方（多数持仓浮盈、上方无密集套牢），小于1=当前价在筹码峰下方（头上压着套牢盘，反弹遇阻）',
  'chip_analysis.price_concentration_hhi': '筹码价位集中度(HHI)：各价位桶占比的平方和，接近1=高度集中在少数价位（庄控/单一建仓区），接近0=分散',
  'chip_analysis.top5_hold_percent': '前5大地址合计持仓占比(%)，越高越易被头部砸盘控制',
  'chip_analysis.top5_transfer_in_ratio': '前5大持仓里转账进来的占比(%)：高=头部筹码非自己买入、是分发或老鼠仓，重大风险信号',
  'buy_tx_per_buyer': '人均买入笔数 = buy_tx_count_d1 / buyer_count_d1（越高=可能是少数人/机器人在刷单，而不是很多真实用户参与）',  'sell_tx_per_seller': '人均卖出笔数 = sell_tx_count_d1 / seller_count_d1；与 buy_tx_per_buyer 对比可看出卖方是一次性清仓（接近1）还是分批出货（明显>1，常见于有经验的钱包在慢慢派发）',
  'kline_volume_concentration_pct': '量能集中度（%）= 最大一根K线的成交额 / 期间总成交额。值高=单根异常巨量（常是一笔拉盘或砸盘），值低=持续放量。只看总成交额完全区分不出这两种情况',
  'kline_minutes_since_max_volume': '距成交额最大的那根K线过了多少分钟（0=最新一根就是最大量）。用分钟而不是根数，是因为各样本K线粒度差异极大（1秒~1天），根数没法跨样本比较；resolution缺失时不参与',
  'kline_volume_cv': '成交额的变异系数 = 标准差/均值。衡量量能是否稳定，与量的绝对大小无关',
  'kline_volume_recent_ratio': '通用版放量倍数 = 最新一根K线成交额 / 之前所有根的均量。苏醒信号自带的 volume_ratio 只在苏醒信号存在时才有，这个字段对所有样本都能算',
  'kline_volume_trend_ratio': '放缩量趋势 = 较近一半K线的均量 / 较早一半的均量。>1=正在放量，<1=正在缩量',
  'kline_max_rise_speed_pct_per_min': '急拉【速度】：在 1/3/5/15 分钟多个时间尺度上扫描，取最陡一段的速度（%/分钟）。偏向捕捉短时间的暴力拉升。窗口按分钟折算根数，不同K线粒度之间可比',
  'kline_max_rise_pct': '急拉【幅度】：多尺度扫描里最大一段拉升的涨幅（%），通常来自最长的15分钟窗口。与 speed 是两个维度——速度高=拉得急，幅度高=拉得多',
  'kline_max_rise_window_min': '产生最高急拉速度的那个时间尺度（分钟，取值 1/3/5/15 附近）。值小=瞬间脉冲，值大=持续拉升',
  'kline_bar_minutes': 'K线粒度（分钟），由相邻bar的实际时间差中位数推断。用于判断 kline_* 系列字段跨样本的可比性',
  'kline_turnover_pct': '期间换手率（%）= 所有K线的 token_volume 之和 / total_supply × 100。代币口径的真实换手率，不依赖币价、也不涉及流动性口径分歧',

  'smart_money_net_buy_count': '聪明钱净买入地址数 = smart_money_address_buy_count_d1 - smart_money_address_sell_count_d1',
  'open_to_buy_duration': '开盘到买入时长 = 快照时间（买入点）- swap_begin_time（第一笔交易时间），单位分钟',
  'launch_to_buy_duration': '上线到买入时长 = 快照时间（买入点）- launch_time（代币上线时间），单位分钟',
  'above_cost_line': '是否在成本线之上（1=是，0=否）= cost_line_distance_pct > 0；取自平台 kline_and_indicators.avg_price_deviation_pct',
  'v_breakout_volume_recent_retracement_pct': '【最近生效的那条V转信号】的回调幅度（%）。生效判定：n_pattern_confirmed=true 且未突破前高（fibon_break4 无值）的信号里取 signalTime 最新的一条。= n_pattern_retracement×100，即从回调高点跌到低点的幅度；与 buy_max_retracement（全部信号里最深的一次）口径不同',
  'v_breakout_volume_recent_drawdown_min': '真正的下跌时长（分钟）= 回调低点时间 − 回调高点时间；注意平台文案里的"回调时长"用的是另一个口径，见 v_breakout_volume_recent_signal_from_top_min',
  'v_breakout_volume_recent_drawdown_speed_pct_per_min': '回调速度（%/分钟）= 回调幅度 ÷ 下跌时长；区分"几秒砸下来的闪崩"和"慢慢阴跌"',
  'v_breakout_volume_recent_signal_from_top_min': '从回调见顶到信号发出的时长（分钟）= signalTime − top_price_time；等于下跌时长加上触底后反弹到第一档所用的时间，衡量从见顶到系统认为可以进场的总耗时。与 v_breakout_volume_recent_drawdown_min（纯下跌时长）是两个口径',
  'v_breakout_volume_recent_rebound_from_low_pct': '从回调低点到当前的反弹幅度（%）= 平台 price_rise_ratio×100',
  'v_breakout_volume_recent_breakout_ratio': '当前价在整个回调区间里的位置（%）= 平台 current_breakout_ratio×100；0=还在低点，100=已回到回调前高点。是 v_breakout_volume_recent_stage_pct 那四档离散值的连续版本，做相关性/ROC 更有力',
  'v_breakout_volume_recent_signal_from_open_min': '信号距开盘的时长（分钟）= signalTime − swap_begin_time',
  'v_breakout_volume_recent_low_to_buy_min': '回调低点到买入的时长（分钟）= 买入时刻 − low_price_time，即抄底后多久进的场',
  'v_breakout_volume_recent_prior_count': '生效的那条V转信号【之前】还发生过几个V转信号；0=这是24h内第一次回调反弹，越大说明这币在反复回调震荡。与 v_breakout_volume_signal_count（列表总条数、不分先后）不同',
  'v_breakout_volume_record_count': 'v_breakout_volume_list 的原始记录条数（未按周期去重）。与 v_breakout_volume_signal_count 的差值反映平台是否按反弹档位(20%/40%/60%)重复发信号',
  'v_breakout_volume_signal_count': '24小时内回撤反弹的【周期】数，按 (top_price_time, low_price_time) 去重——一个周期(顶→底→分档反弹)可能在 list 里有多条记录，直接数条数会重复计数',
  'continue_breakout_volume_signal_count': '24小时内早期精选(continue_breakout_volume)信号出现的次数；对应 PVP 策略里的「精选次数」判定，反复被选中说明持续有热度（统计全部信号，不是 recent_ 那一条）',
  'continue_breakout_volume_recent_notice_mcap': '【最近一条早期精选信号】触发时的市值（USD）。精选信号没有"确认/收尾"状态机，按 signalTime 最新取；一个 token 常有多条精选信号，所有 recent_ 开头的字段都只描述最新那一条',
  'continue_breakout_volume_recent_max_amplitude': '早期精选信号触发时，此前所有K线里最大的那根振幅（%），恒为百分比数值',
  'continue_breakout_volume_recent_amplitude_before_signal_min': '最大振幅发生在精选信号前多久（分钟）= signalTime − max_amplitude_time；紧挨着信号=刚剧烈波动完就被选中，很久之前=早就波动过现在才被选中',
  'continue_breakout_volume_recent_all_bullish': '加强版精选标记（1=是，0=否）：精选信号出现时 K 线是否连续上涨',
  'continue_breakout_volume_recent_signal_volume': '早期精选信号那根K线的交易量（USD）= volume3（原生币计价）× native_coin_price；快照缺 native_coin_price 时该字段缺失',
  'continue_breakout_volume_recent_volume_total': '早期精选信号三根K线的成交量合计（USD）= (volume1+volume2+volume3) × native_coin_price',
  'continue_breakout_volume_recent_volume_trend_ratio': '早期精选三根K线的放缩量趋势 = volume3 / volume1；<1=缩量上涨，>1=持续放量。比值无量纲，不依赖 native_coin_price',
  'continue_breakout_volume_recent_bullish_kline_count': '早期精选三根K线里阳线的根数（0~3）；all_bullish 等价于该值=3，但这个离散计数比布尔值信息量更大',
  'continue_breakout_volume_recent_signal_from_open_min': '早期精选信号距开盘的时长（分钟）= signalTime − swap_begin_time',
  'continue_breakout_volume_recent_signal_to_buy_min': '早期精选信号新鲜度（分钟）= 买入时刻 − signalTime，衡量执行延迟',
  'breakout_volume_10x_signal_count': '24小时内休眠苏醒(breakout_volume_10x)信号出现的次数（统计全部信号，不是 recent_ 那一条）',
  'breakout_volume_10x_recent_notice_mcap': '休眠苏醒信号触发时的市值（USD）',
  'breakout_volume_10x_recent_volume_ratio': '【最近一条苏醒信号】的放量倍数 = 当前交易量 / 休眠期平均交易量。是倍数不是百分比（13.74 即 13.74 倍）',
  'breakout_volume_10x_recent_dormant_duration_min': '休眠期持续时长（分钟）= history_end_time − history_start_time',
  'breakout_volume_10x_recent_dormant_kline_count': '休眠期涉及的K线根数',
  'breakout_volume_10x_recent_dormant_cv': '休眠期的波动率（%），越小说明横盘越平静',
  'breakout_volume_10x_recent_dormant_slope': '休眠期的标准化斜率（%），衡量横盘期间的整体趋势方向',
  'breakout_volume_10x_recent_dormant_end_to_signal_min': '休眠结束到苏醒信号发出的间隔（分钟）；紧接着放量与沉寂一段后才放量是两种节奏',
  'breakout_volume_10x_recent_signal_from_open_min': '苏醒信号距开盘的时长（分钟）',
  'breakout_volume_10x_recent_signal_to_buy_min': '苏醒信号新鲜度（分钟）= 买入时刻 − signalTime',
  'breakout_volume_10x_recent_kline_bullish': '苏醒那根K线是否阳线（1=是，0=否）。放量收阴（砸盘放量）与放量拉阳完全是两回事，只看 volume_ratio 区分不出来',
  'breakout_volume_10x_recent_kline_change_pct': '苏醒那根K线的涨幅（%）=（收盘−开盘）/开盘×100',
  'breakout_volume_10x_recent_drawdown_from_high_pct': '苏醒信号市值相对历史最高市值的回调深度（%）=（max_up_mcap − notice_mcap）/ max_up_mcap ×100。负值表示信号触发时市值已超过历史最高点（比持平更强的形态），保留真实负值不做截断',
  'signal_total_count': '买入前该 token 触发过的信号总条数（六类信号合计，含同类多次）',
  'signal_type_count': '买入前触发过几种【不同类型】的信号（1=单一信号，≥2=多类共振）；共振通常比单一信号更强',
  'signal_span_min': '首个信号到最后一个信号的时间跨度（分钟）；跨度大说明信号断断续续，跨度小说明短时间内密集触发',
  'signal_first_to_buy_min': '首个信号到买入的时长（分钟）；与各类型自己的 signal_to_buy_min 不同，这个是从"最早被系统注意到"算起',
  'signal_sequence': '【分类字段】按时间排序的完整信号序列，如 continue>continue>v。类型缩写：v=回撤反弹, continue=早期精选, 10x=休眠苏醒, whale=蓝筹共振, followed=关注钱包, smart=聪明钱。取值发散、每组样本少，适合样本量够时看细节',
  'signal_combo': '【分类字段】买入前出现过的信号类型集合（去重后按字母序），如 continue+v。基数比 signal_sequence 小、每组样本多，统计更稳，适合先看大方向',
  'signal_first_type': '【分类字段】最早触发的那个信号类型',
  'signal_last_type': '【分类字段】最后触发的信号类型，即直接促成这次买入的那个信号',
  'holder_top30_net_cost_mcap': '前30大户的【净成本】，市值口径（美元）=（总买入花费+手续费 − 总卖出收入）÷ 总持仓 × 总供应量。可以是负数：负数表示这批大户卖出拿回的钱已超过投入，手上剩的筹码是白嫖的——这种人对价格没有任何防守动机。与买入均价的关键区别就在这里：后者会给已回本的人算出一个正的"成本线"，看起来还有支撑位，那是假的',
  'holder_top50_net_cost_mcap': '前50大户的净成本（市值口径，美元），口径同 holder_top30_net_cost_mcap。与 top30 版对比：top50 更负说明靠后的大户跑得更彻底',
  'holder_top30_share_pct': '前30大户持仓占比合计（%）。已剔除交易所/流动性池地址（addr_type=2），按持仓降序取前30，合计各自占总供应量的比例。最直观的控盘集中度：越高说明筹码越集中在少数钱包，砸盘风险越大。比 gini/hhi 直观',
  'holder_top50_share_pct': '前50大户持仓占比合计（%），口径同 holder_top30_share_pct。与 top30 对比可看集中度曲线——top50 相比 top30 增加得少，说明 30 名之后的持仓已经很分散',
  'holder_top30_avg_buy_mcap': '前30大户的买入均价，换算成【市值】口径（美元）。按金额加权：Σ买入成本 ÷ Σ买入数量 × 总供应量，不是对各钱包 avg_cost 求简单平均（那样买100刀和买1万刀权重一样）。用市值而非单价是为了跨 token 可比——单价在不同币之间差好几个数量级',
  'holder_top30_avg_sell_mcap': '前30大户的卖出均价（市值口径，美元）。与 buy 版配套：卖出均价明显高于买入均价 = 大户在派发获利；前30里无人卖出时该字段缺失（不是 0）',
  'holder_top50_avg_buy_mcap': '前50大户的买入均价（市值口径，美元）。与 top30 版对比可看筹码结构：top50 明显高于 top30 = 靠后的大户是在更高位接的盘',
  'holder_top50_avg_sell_mcap': '前50大户的卖出均价（市值口径，美元）',
  'holder_same_private_funder_ratio': '协同度：与其他头部持有人共享同一个【私人】SOL 出金地址的钱包占比（%）。只统计规模≥2 的簇。这是同一控制人操纵多个钱包的痕迹',
  'holder_max_private_funder_ratio': '协同度：最大单个私人出金簇占头部持有人的比例（%）。与 same_private_funder_ratio 配套——前者看整体协同程度，本字段看单一控盘方的火力：16个钱包散成6个小簇 vs 全归一个地址，整体占比一样但风险天差地别',
  'holder_same_cex_funder_ratio': '共享同一交易所热钱包出金的钱包占比（%）。信息量低——Binance/OKX 出金地址是公共的，正常币也会很高（真实样本 39%）。放在这里主要是给 private 版本做对照',
  'holder_internal_transfer_ratio': '头部持有人之间【直接互转】筹码的钱包占比（%）。比同源出金证据更硬。注意它是 top10 集中度指标的补丁：把大仓拆成多个钱包后集中度看起来正常，但互转链路会暴露',
  'holder_same_second_entry_ratio': '建仓时间戳（start_holding_at）与其他钱包【精确到秒完全相同】的钱包占比（%）。比 entry_concentration 的5分钟窗口严格得多，秒级撞上基本排除巧合',
  'holder_identical_buy_amount_ratio': '买入数量（buy_amount_cur）与其他钱包【完全相同】的钱包占比（%）。真实样本里出现过三个钱包都恰好买 3698776 个，是同一脚本批量下单的直接证据',
  'holder_pnl_median': '头部持有人未实现盈亏（unrealized_pnl）中位数，单位是倍。现有 in_profit_ratio 只数了个数丢了幅度——浮盈6倍和浮盈5%的人砸盘意愿完全不同',
  'holder_big_winner_ratio': '未实现盈亏超过 3 倍的头部持有人占比（%）。这批人随时可能砸盘，买在他们的浮盈高位就是接货',
  'holder_active_seller_ratio': '已经有卖出交易（sell_tx_count_cur>0）的头部持有人占比（%）',
  'holder_realized_loss_ratio': '已实现亏损（realized_profit<0）的头部持有人占比（%），即已经割过肉的',
  'holder_avg_cost_cv': '头部持有人平均成本的变异系数（标准差/均值）。低=筹码同质，同一批人同一时刻进的，没有真实换手；高=有早期埋伏+后来接力。用变异系数而非标准差，因为 avg_cost 绝对值跨 token 差几个数量级',
  'holder_sniper_ratio': 'maker_token_tags 含 sniper 的头部持有人占比（%）',
  'holder_dev_team_ratio': 'maker_token_tags 含 dev_team 的头部持有人占比（%）',
  'holder_kol_ratio': 'tags 含 kol 的头部持有人占比（%）',
  'holder_fomo_ratio': 'tags 含 fomo 的头部持有人占比（%），即追高的散户',
  'holder_zero_native_ratio': 'SOL 余额为 0 的头部持有人占比（%）。空壳/一次性钱包',
  'holder_native_sol_median': '头部持有人 SOL（原生币）余额中位数，已换算成人类可读数量（优先用 native_coin_decimal，缺失时按 chain 兜底 SOL=1e9/BNB=1e18）。偏低=大户普遍是用完即弃的批量小号（连 gas 都不多留）',
  'holder_native_sol_cv': '头部持有人 SOL 余额的变异系数（标准差/均值）。高=少数正常钱包与大量空壳/小号混杂；低=余额规模相近',
  'holder_creator_rank': '创建者在头部持有人里的名次（1 起）。名次比占比多一层信息：排 TOP2 和排 TOP80 持仓占比可能接近，但前者说明创建者就是主要控盘方。创建者不在列表里则缺失（不是 0）',
  'holder_exchange_ratio': 'Top100 里交易所/流动性池地址（addr_type=2）的占比（%）；下面其它 holder_ 比例都已把这些地址剔除，只在真实持有人上算',
  'holder_transfer_in_ratio': '头部持有人里"靠转账接盘"（transfer_in=true）的占比（%）——高=庄家把筹码分发给马甲钱包充当持有人，貔貅/分发的强信号',
  'holder_never_bought_ratio': '头部里从没真金白银买过（buy_volume_cur=0）的占比（%），与 transfer_in_ratio 互相印证',
  'holder_transfer_amount_ratio': '金额口径：头部总持仓里来自转账（非买入）的占比（%）= Σcurrent_transfer_in_amount / Σbalance',
  'holder_bot_ratio': '带机器人标签（sandwich_bot/bundler/smart_degen）的头部钱包占比（%）；标签关键词可按需调整',
  'holder_bundler_ratio': 'maker_token_tags 含 bundler（对本币参与了捆绑买入）的头部占比（%）=内部刷量',
  'holder_paper_hands_ratio': 'maker_token_tags 含 paper_hands（拿不住、稍有浮盈就跑）的头部占比（%）=潜在抛压',
  'holder_smart_ratio': '带聪明钱标签（kol/smart_degen/bluechip_owner）的头部占比（%）=聪明钱背书（正信号）',
  'holder_suspicious_ratio': 'is_suspicious=true 的头部占比（%）',
  'holder_new_ratio': 'is_new=true（新钱包）的头部占比（%）；可与 gmgn.stat.fresh_wallet_rate 交叉验证',
  'holder_gini': '头部持仓 amount_percentage 的基尼系数：0=平均分布，1=极度集中',
  'holder_hhi': '头部持仓的赫芬达尔指数（份额归一化后平方和）：越大越集中，对少数超大户更敏感',
  'holder_in_profit_ratio': '头部处于浮盈（profit>0）的占比（%）——越高，获利了结的潜在抛压越大',
  'holder_sold_ratio': '已经开始卖（sell_amount_percentage>0）的头部占比（%）',
  'holder_entry_concentration': '头部入场时间协同度：start_holding_at 落在最密集 5 分钟窗口内的占比（%）——高=同一时刻涌入，协同建仓（狙击/捆绑）',
  'gmgn.launchpad_progress': '内盘曲线毕业进度（0-1，1=已100%毕业到外盘）；越小越早期',
  'gmgn.locked_ratio': '流动性锁仓比例（0-1）；越高跑路越难，安全性代理',
  'gmgn.visiting_count': 'GMGN 页面访问次数，热度代理',
  'gmgn.launchpad_status': '发射平台状态：0=未开盘，1=内盘交易中，2=已毕业到外盘',
  'gmgn.price.hot_level': 'GMGN 热度等级（整数）',
  'gmgn.pool.fee_ratio': '主交易池手续费比例（如 0.1 表示 0.1%）',
  'gmgn.og': '是否被 GMGN 标记为 OG（早期/原创）代币（0/1）',
  'gmgn.migration_market_cap': '毕业时的市值（USD）；越低说明毕业越早、越早期',
  'gmgn.image_dup_count': 'logo 图片被重复使用的次数；>0 可疑（仿盘常复用图片）',
  'gmgn_net_buy_vol_ratio_5m': '最近5分钟净买入额占比（%）= buy_volume_5m /（buy_volume_5m + sell_volume_5m）；>50 买盘占优。来自 gmgn 真实多窗口（logearn 的多窗口是坏的）',
  'gmgn_net_buy_vol_ratio_1h': '最近1小时净买入额占比（%），同上口径',
  'gmgn_buy_sell_count_ratio_1h': '最近1小时买卖笔数比 = buys_1h / sells_1h；>1 买单笔数更多',
  'gmgn_vol_accel_5m_1h': '成交加速度 =（volume_5m/5）/（volume_1h/60）：最近5分钟每分钟均速 ÷ 最近1小时每分钟均速，>1=正在放量提速',
  'gmgn_liquidity_change_ratio': '流动性相对初始的变化 = pool.liquidity / pool.initial_liquidity；<1=池子被抽水（危险），>1=有流入',
  'gmgn_supply_circulating_ratio': '流通比例 = circulating_supply / total_supply',
  'gmgn_price_to_ath_ratio': '当前价相对历史最高价 = price.price / ath_price；越接近1越贵（在高位），越小离顶越远',
  'gmgn_fee_to_liq_ratio': '累计手续费 / 流动性 = total_fee / liquidity；换手活跃度代理',
  'whale_signal_count': '24小时内蓝筹顶级赢家共振(whale)信号出现的次数',
  'whale_recent_wallet_count': '最近一次共振中参与的蓝筹地址数(whaleWalletCount)；越多共振越强',
  'whale_recent_tx_count': '最近一次共振中蓝筹钱包的买入次数合计(whaleTxCount)',
  'whale_recent_tx_per_wallet': '共振人均买入次数 = whaleTxCount / whaleWalletCount；反复买比各买一次共振更强',
  'whale_recent_past_minute': '共振时间窗口(分钟，pastMinute)；越小说明这些买入越密集地挤在一起',
  'whale_recent_notice_mcap': '最近一次共振信号触发时的市值(USD)',
  'whale_recent_signal_from_open_min': '共振信号距开盘的时长(分钟)',
  'whale_recent_signal_to_buy_min': '共振信号新鲜度(分钟) = 买入时刻 − signalTime',
  'mcap_to_max_up_ratio': '当前市值 / 历史最高市值 = mcap / max_up_mcap；<1=已从高点回落，越小买在越深的回撤位',
  'max_up_speed_pct_per_min': '冲到历史高点的速度(%/分钟) = max_up_ratio / (max_up_duration/60)；快=急拉，慢=温和爬升',
  'launch_time_duration': '开盘到内盘毕业经过的秒数；越短毕业越快（热度高）。⚠️ 平台原始口径是"未毕业则为 0"，那是哨兵值不是测量值——review 已把未毕业的盘改记【缺失】（见 data.js applyGraduationFeatures），所以这个字段只在毕业的盘上有定义，缺失率≈未毕业占比。想用"是否毕业"请用 is_graduated',
  // 这三个跟 launch_time_duration 同批：平台口径都是"未毕业时固定为 0"，review 已改记缺失。
  // 之前没有词条，字段浏览器只能靠名字自动拼出"筹码分析 / inner / 卖出 / 比例"这种读不出重点的描述。
  'chip_analysis.inner_sell_ratio': '内盘卖出率(%)：内盘毕业时持有的筹码到现在为止卖出的比例。0=内盘几乎没卖，100=内盘全部离场。⚠️ 只在【已毕业】的盘上有定义（未毕业时平台给哨兵 0，review 已改记缺失）',
  'chip_analysis.inner_address_holding': '内盘地址剩余持仓 / 全部持仓(%)：当前还在持仓的筹码里有多少是内盘地址（launch_time 之前买入的钱包）持有的。⚠️ 只在【已毕业】的盘上有定义',
  'chip_analysis.inner_holding_address_count': '内盘地址里当前仍有持仓的去重地址数。⚠️ 只在【已毕业】的盘上有定义',
  'is_graduated': '是否已内盘毕业(0/1)。从 launch_time>0（或 launch_time_duration>0 作旁证）判定。存在的理由：平台在 launch_time_duration / chip_analysis.inner_* 四个字段上都用 0 表示"未毕业"，把哨兵值留在数值轴上会让区间挖掘去拟合"毕业/未毕业"这个二分类却伪装成连续量——拆出来之后，"未毕业"这条信息由本字段单独承载，让它自己去因子池里竞争',
  'is_fake': '仿冒识别(0/1)：地址含 pump/four/bonk 关键词但实际平台不符时为 1，可疑仿盘',
  'is_new_m5_hot_ranking_token': '是否新进入5分钟热度榜单(0/1)',
  'is_new_h1_hot_ranking_token': '是否新进入1小时热度榜单(0/1)',
  'cost_line_distance_pct': '当前价相对持仓平均成本线的偏离（%），直接取平台 kline_and_indicators.avg_price_deviation_pct（该字段已被合并进来、不再单独出现）。正数=价格在成本线上方。注意：不再用 logearn.mcap 自行计算——两者不同源、时间基准不一致，秒级K线高波动币上能差 5 倍',
  'v_breakout_volume_recent_low_cost_line_distance_pct': '【最近生效的那条V转信号】的回调最低点与该时刻成本线的距离（%）。成本线随时间变化，按最低点发生时间从 avg_price_bars 回溯取当时的值，而不是用快照时刻的成本线；找不到历史 bar 时退回当前成本线。负值=最低点跌破了当时的成本线',
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
  'returnMax': '期间最大倍数(max_mcap/initial_mcap)', 'id': '记录ID',
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

// 打分因子表用的"富提示"：因子名在 code-score.js 里可能被截断到 20 字符
// （老的 buildAllChecksRow 逻辑、或手写代码），比如 'chip_analysis.above_' 其实是
// 'chip_analysis.above_below_ratio'、'v_breakout_volume_si' 其实是 'v_breakout_volume_signal_count'。
// 截断后 getFieldDesc 查不到精确 key，只会退化成 translateTokens 的逐词硬翻
// （"v / 突破 / 交易量 / si" 这种没信息量的东西）。这里反向补救：
//   1) 完整字段能直接查到 → 字段名 + 完整描述；
//   2) 名字是某个完整字段的前缀（被截断）→ 找出候选完整字段，唯一就直接用，多个就都列出来让人认；
//   3) 都不是 → 退回 getFieldDesc。
// 返回多行字符串（原生 title 提示支持 \n 换行），供 <span title=...> 直接用。
function describeFactorLabel(name) {
  if (!name) return '';
  if (FIELD_DESC[name]) return `${name}\n${FIELD_DESC[name]}`;
  const matches = Object.keys(FIELD_DESC).filter(k => k.startsWith(name) && k !== name);
  if (matches.length === 1) return `${matches[0]}\n${FIELD_DESC[matches[0]]}`;
  if (matches.length > 1) {
    return `名字在代码里被截断了，可能是以下字段之一：\n${matches.map(k => `· ${k}：${FIELD_DESC[k]}`).join('\n')}`;
  }
  return getFieldDesc(name) || name;
}

export {
  FIELD_DESC,
  SOURCE_DESC,
  TERM_MAP,
  TIME_MAP,
  getFieldDesc,
  describeFactorLabel,
  translateToken,
  translateTokens,
};
