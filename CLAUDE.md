demo 数据

export const MERGED_SAMPLE_CTX: any = {
  // 完整的 LogEarn 字段解释可参考：
  // https://github.com/logearn/logearn-skills/blob/main/api.md
  
  // 完整的 GMGN 字段解释可参考
  // https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-token/SKILL.md

  // 信号类型说明
  // v_breakout_volume: 回撤反弹信号
  // continue_breakout_volume: 早期精选信号
  // breakout_volume_10x: 休眠苏醒信号
  // whale 头部蓝筹代币顶级赢家共振买入信号
  // followed: 我关注的钱包买入信号
  // smart_money: 聪明钱或者KOL 买入信号
  logearn: {
    "token_address": "dnFkkHvS3qSNpCGMkQ7kT4n6kaFjq6m7icJKhqyiWPm", 
    "symbol": "Martha", 
    "token_name": "", // 代币全名，很多代币没填，可能是空字符串
    "total_supply": 1000000000, // 总供应量（已经按 decimals 换算成人类可读单位，不是链上最小单位）
    "decimals": 6, // 代币精度位数

    // 发射平台的可选项
    // platform = [
    //   6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P: Pump（内盘）
    //   pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: Pump AMM（pump.fun 毕业后外盘）
    //   mayhem: Pump Mayhem modal
    //   675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8: Raydium
    //   CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: CPMM
    //   CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: CAMM
    //   9SkAtSxgNUMvT9bGb93v6rLU5MjW1XibykqoGtqT9dbg: WenDev
    //   LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: Launpad
    //   FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1: LetsBonk 1
    //   BuM6KDpWiTcxvrpXywWFiw45R2RNH8WURdvqoTDV1BW4: LetsBonk 2
    //   4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4: Labs
    //   Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: Pools
    //   LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: DLMM
    //   cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: DLMM V2
    //   dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: Meteora DBC
    //   FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM: Moonshit
    //   Bov7gMQ88BQbtFMTxQ5e8grtrwG4ryQGAV9Mih2j9SxK: Dynamic DBC
    //   BAGSB9TpGrZxQbEsrEznv5jXXdwyP6AXerN8aVRiAmcv: Bags
    //   GybkUNYVNk1FZMt9myAfvpSVgoKBgaueMTvszwBN4qYx: AnoncoinIt
    //   8rE9CtCjwhSmbwL5fbJBtRFsS3ohfMcDFeTTC7t4ciUA: Studio
    //   7UNpFBfTdWrcfS7aBQzEaPgZCfPJe8BDgHzwmWUZaMaF: TrendFun
    //   whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: Whirl
    //   MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG: Moonshot
    //   boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4: Boop
    //   HEAVENoP2qxoeuF8Dj2oT1GHEnu49U5mJYkdeC8BAX2o: Heaven
    //   pancake: Pancake
    //   pancake_v2: Pancake V2
    //   pancake_v3: Pancake V3
    //   four.meme: Four
    //   binance_four.meme: Binance Four
    //   flap: Flap
    // ]
    "platform": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // 代币的初始发射平台标识（地址或简称）如上面的备注, 代币一发射该值就固定了，不会随着后期是否毕业的改变而改变。
    "chain": 3, // 链 ID：3 = Solana，56 = BSC
    "swap_begin_time": 1781979783, // 代币开始交易的时间（Unix 秒）
    // 行情
    "price_now": 3.1253304325000003e-8, // 当前价格——注意单位是「1 个代币值多少个原生币（SOL/BNB）」，不是美元！要换算成美元单价，乘以 ctx.native_coin_price（已按当前信号所在链自动赋值）
    "price_change_1d": 8.176759809917522, // 24小时价格涨跌幅，单位已经是 %（比如 8.17 表示涨了 8.17%），不用再乘 100
    "price_change_6h": 8.176759809917522, // 6小时价格涨跌幅，单位 %
    "price_change_1h": 8.176759809917522, // 1小时价格涨跌幅，单位 %
    "price_change_5m": 8.176759809917522, // 5分钟价格涨跌幅，单位 %
    // 市值
    "fdv": 2242.7371183620007, // 全流通市值（USD），= price_now（换算成美元后）× total_supply，多数代币跟 mcap 数值相同
    "mcap": 2242.7371183620007, // 当前市值（USD）
    "current_mcap": 2242.7371183620007, // 当前市值（USD），跟 mcap 同源，备用字段

    // LP 流动性, 该自动表示所有流动性池子里面流动性最大的那个池子的流动性，单位为（USD)
    // 同时本字段只对 SOL 生效，BSC 的 token 无效，目前 logearn 暂时不提供 BSC token 的流动性数据，可以参考 gmgn 的流动性字段
    pool_liquidity: 3344.55, //  代币价值 + native coin 价值

    //最大涨幅
    "max_up_duration": 53581, // 开盘到目前为止「历史最高价」出现所经过的秒数
    "max_up_ratio": 4.354713652309421, // 开盘价到历史最高价的最大涨幅，单位 %
    "max_up_mcap": 2218.9846070981457, // 历史最高价对应的市值（USD）
    "max_up_mcap_time": 1782033364, // 历史最高价出现的时间（Unix 秒）
    // 热榜
    "is_new_m5_hot_ranking_token": true, // 新进入5分钟热度榜单 token
    "m5_featured_index": 5, // 5分钟的热度指数，取值[10-10], 大于 > 3 以后有资格进入5分钟热度榜单
    "is_new_h1_hot_ranking_token": true, // 新进入5分钟热度榜单 token
    "h1_featured_index": 6, // 1小时的热度指数，取值[10-10], 大于 > 3 以后有资格进入1小时热度榜单
    // 24小时聪明钱数
    "smart_money_address_buy_count_d1": 0, // 24小时内「聪明钱」标签地址买入的去重地址数（不是交易次数）
    "smart_money_address_sell_count_d1": 0, // 24小时内「聪明钱」标签地址卖出的去重地址数
     // 24小时钱包数
    "buyer_count_d1": 7, // 24小时内买入的去重地址数
    "seller_count_d1": 3, // 24小时内卖出的去重地址数
    // 24交易次数
    "buy_tx_count_d1": 7, // 24小时内买入交易笔数
    "sell_tx_count_d1": 4, // 24小时内卖出交易笔数
    // 24小时交易量
    "buy_wcoin_amount_d1": 3.329135788, // 24小时内买入花费的原生币（SOL/BNB）数量，已换算成人类可读单位
    "sell_wcoin_amount_d1": 1.118284813, // 24小时内卖出收到的原生币数量
    // 方便热度排序使用
    "buy_wcoin_amount_m5": 3.329135788, // 最近5分钟买入花费的原生币数量
    "sell_wcoin_amount_m5": 329135788,// 最近5分钟卖出的代币总价值(原生币)
    "buy_wcoin_amount_h1": 1.118284813, // 最近1小时相关的原生币数量
    "sell_wcoin_amount_h1": 1.118284813, // 最近1小时卖出的代币总价值(原生币)

    // 内盘毕业
    "launch_time": 1781979783, // 内盘毕业时间 没有必要为空
    "launch_time_duration": 0, // 开盘到「毕业」（launch_time 有值）经过的秒数，还没毕业则为 0
    // token 相关标签
    "is_diamond_token": null, // 是否「钻石狗」标签，null = 未判定/未知
    "is_error_market_token": null, // 是否被判定为异常行情代币（数据可能有问题），null = 未判定
    "is_honey": null, // 是否蜜罐代币（能买不能卖），null = 未判定
    "is_scam_token": null, // 是否被判定为诈骗代币，null = 未判定
    "is_top_token": null, // 是否「金狗」标签，null = 未判定
    "profit_usernum": null, // 历史持仓盈利总人数
    "off_meta": {}, // 链下补充元数据，结构不固定，按需读取具体子字段, 使用的时候可以转换成字符串做正则匹配，比如是否有: x.com
    "platform_icon": "/static/1781972132482//images/icons/dex/pump.svg", // 发射平台图标 URL
    "platform_name": "Pump", // 发射平台中文/展示名
    "is_fake_pump": false, // 地址里含 "pump" 关键词但实际平台又不是官方 Pump/Pump AMM 时为 true（仿冒识别）
    "is_fake_four": false, // 同理，针对 four.meme 平台的仿冒识别
    "is_fake_bonk": false, // 同理，针对 bonk 系平台的仿冒识别
    "is_fake": false, // 上面三个仿冒标记任意一个为 true，这里就是 true

    // *_volume 如下是 8 大重要 tag 人群的实时持仓比例 ** 重要 **
    // * 8大实时持仓指标的数据默认范围是24小时，相当于统计的是最近24小时这些钱包类型的持仓变化，超过24小时的代表，各个值有可能为负数，一半超过24小时以上的狗，不再适用8大持仓指标进行过滤筛选，因为意义不大了* ** 重要 **
    // 垃圾钱包持仓 > 5 或者新钱包持仓 > 60 或者高频钱包持仓 > 50 都是非常危险的信号
    "amm_volume": 0, // 24小时持仓人群结构：交易所/AMM 类钱包持仓占比，单位 %
    "exchange_volume": 0, // 24小时持仓人群结构：交易所钱包持仓占比，单位 %
    "frequent_volume": 2.239461629628, // 24小时持仓人群结构：高频交易者持仓占比，单位 %
    "new_volume": 5.4068159945991, // 24小时持仓人群结构：新钱包持仓占比，单位 %
    "old_volume": 1.9579167681048, // 24小时持仓人群结构：老钱包持仓占比，单位 %
    "scam_volume": 0, // 24小时持仓人群结构：诈骗/黑名单钱包持仓占比，单位 %
    "shit_volume": 0, // 24小时持仓人群结构：垃圾钱包持仓占比，单位 %
    "smart_volume": 0, // 24小时持仓人群结构：聪明钱持仓占比，单位 %
    "whale_volume": 0, // 24小时持仓人群结构：蓝筹头部赢家持仓占比，单位 %
    "last_traded": 1782033376, // 最近一次交易时间（Unix 秒）

    // 一个 token 有 六大信号，他们 24小时内所有信号明细都放在 [信号类型]_list 这个数组里面
    // followed_list => 我关注的地址的交易信号
    // smart_money_list => 聪明钱或者KOL的交易信号
    // breakout_volume_10x_list => 苏醒信号
    // continue_breakout_volume_list => 精选信号
    // v_breakout_volume_list => 回撤反弹信号
    // whale_list => 蓝筹头部赢家的鲸鱼钱包发出的共振买入信号
    //** 每个信号都有一个 signalTime 字段，可以合并所有 list 信号，然后按照 signalTime 排序，就能得到信号出现的时间顺序 */
    "signal_open_time": 1781474608, // 「四类信号」（v_breakout_volume/continue_breakout_volume/breakout_volume_10x/whale）里涨幅最大的那个信号，其开盘时间（Unix 秒）——跟 signal_best_type/all_signals_max_ratio 里那个最佳信号的 open_time 是同一个值
    "signal_open_mcap": 18356.742414, // 同上，开盘市值（USD）
    "signal_max_time": 1781485073, // 同上，达到最高涨幅的时间（Unix 秒）
    "signal_max_mcap": 314433.28109, // 同上，最高涨幅对应的市值（USD）
    "signal_max_ratio": 1612.9034879859375, // 同上，最大涨幅，单位 %
    "signal_best_type": "v_breakout_volume", // 同上，涨幅最大的那个信号类型名（v_breakout_volume / continue_breakout_volume / breakout_volume_10x / whale 之一）
    "all_signals_max_ratio": {
      "v_breakout_volume": {
          "open_time": 1781474608,
          "open_mcap": 18356.742414,
          "max_time": 1781485073,
          "max_mcap": 314433.28109,
          "max_ratio": 1612.9034879859375,
          "type": "v_breakout_volume"
      },
      "continue_breakout_volume": {
          "open_time": 1781474475,
          "open_mcap": 20608.064755999996,
          "max_time": 1781485073,
          "max_mcap": 314433.28109,
          "max_ratio": 1425.7778195715991,
          "type": "continue_breakout_volume"
      },
      "breakout_volume_10x": {
          "open_time": 1781611500,
          "open_mcap": 58168.30552,
          "max_time": 1781653582,
          "max_mcap": 75700.38185399999,
          "max_ratio": 30.140256239666364,
          "type": "breakout_volume_10x"
      },
      "whale": {
          "open_time": 1781474654,
          "open_mcap": 47857.022564000006,
          "max_time": 1781485073,
          "max_mcap": 314433.28109,
          "max_ratio": 557.0264179504755,
          "type": "whale"
      }
    }, // 上面四类信号各自独立的完整涨幅数据（不只是最佳的那个），key 是信号类型名，value 结构跟 signal_open_time 等字段一致（max_mcap/max_ratio/max_time/open_mcap/open_time/type）
    // 下面每类信号，只给出了一条数据样本，其他的都雷同
    "followed_list": [ 
      {
        "amount_coin": "987654320", // 花费/收到的原生币数量，链上最小单位（未按精度换算）
        "amount_token": "29166075037266", // 买卖的代币数量，链上最小单位（未按精度换算，要除以 10**decimals）
        "block_time": 1782033376, // 链上区块时间（Unix 秒）
        "caller": "F2SuErm4MviWJ2HzKXk2nuzBC6xe883CFWUDCPz6cyWm", // 交易发起钱包地址
        "receiver": "F2SuErm4MviWJ2HzKXk2nuzBC6xe883CFWUDCPz6cyWm", // 交易接收钱包地址（买入时通常跟 caller 相同）
        "trade_type": "swap-buy", // 交易类型：swap-buy=买入，swap-sell=卖出
        "type": "followed", // 信号大类，固定是 followed
        "decimals": 6,
        "symbol": "Martha",
        "token_address": "dnFkkHvS3qSNpCGMkQ7kT4n6kaFjq6m7icJKhqyiWPm",
        "total_supply": 1000000000,
        "chain": 3,
        "swap_begin_time": 1781979783,
        "amount": 29166075.037266, // 买卖的代币数量，已经换算成人类可读单位（跟 amount_token 是同一笔，单位不同）
        "value": 987654320, // 花费/收到的原生币数量，链上最小单位（跟 amount_coin 同源）
        "time": 1782033376, // 信号时间（Unix 秒）
        "signalTime": 1782033376, // 信号时间（Unix 秒），跟 time 同值
        "wallet": "F2SuErm4MviWJ2HzKXk2nuzBC6xe883CFWUDCPz6cyWm", // 我关注的这个钱包的地址
        "notice_mcap": 2404.2815713256596, // 触发这条通知时的市值（USD）
        "title": "👀 我的关注", // 通知标题
        "content": "earl买入29.17MMartha(2.92%) ，0.98SOL($70.12)，通知市值$2.4K", // 通知文字内容（纯文本）
        "who": "earl", // 我关注的这个钱包的昵称/备注名
        "html_content": "<span class=\"swap-buy\">买入</span> 29.17MMartha(2.92%) ，0.98SOL($70.12)，通知市值$2.4K", // 带 html 标签的通知内容（用于高亮展示，过滤代码一般用不到）
        "id": "1782033378063nk0wykl", // 这条信号的唯一 id
        "signal_type": "followed" // 跟 type 一样，固定是 followed
      }
    ],
    //  聪明钱或者 K OL 信号 跟 followed_list 结构完全一样
    "smart_money_list": [{
      "caller": "0x7e8fb0392542812476d9f2d0d71c01d1fa0776c5",
      "receiver": "0x7e8fb0392542812476d9f2d0d71c01d1fa0776c5",
      "block_time": 1782022209,
      "trade_type": "swap-sell",
      "amount_coin": "305767988499530715",
      "amount_token": "48885813334579123000000000",
      "type": "smart_money",
      "decimals": 18,
      "symbol": "别乱花钱",
      "token_address": "0x40cfe4bab8cc4e05df3113bf8fe7a78b0ee14444",
      "total_supply": 1000000000,
      "chain": 56,
      "swap_begin_time": 1782020831,
      "amount": 48885813.334579125,
      "value": 305767988499530700,
      "time": 1782022209,
      "signalTime": 1782022209,
      "wallet": "0x7e8fb0392542812476d9f2d0d71c01d1fa0776c5",
      "notice_mcap": 3665.276877657734,
      "title": "💰 x(推特)车头",
      "content": "Wick李卖出48.89M别乱花钱(4.89%) ，0.3BNB($179.18)，通知市值$3.67K",
      "who": "Wick李",
      "html_content": "<span class=\"swap-sell\">卖出</span> 48.89M别乱花钱(4.89%) ，0.3BNB($179.18)，通知市值$3.67K"
    }],
    "continue_breakout_volume_list": [{     
      "all_bullish": true, // 加强版本的精选信号，为 true 表示出现精选信号时，K线时连续上涨
      "max_amplitude": 300.6625894,// 出现精选信号时，前面所有K线的最高振幅，取值为：Math.max[每个K线的振幅]，单位%
      "max_amplitude_time": 1781973360, //最大振幅的时间
      "signalTime": 1781973433, // 精选信号时间
      "type": "continue_breakout_volume",     
      "notice_mcap": 16106.70713, // 信号时候的市值
      "title": "早期精选",
      "content": "精选(💎)，通知市值$16.11K，交易量$2.22K，当前最大振幅3x(2026.06.21 00:36:00)",
    }],
    // '一个 v_breakout_volume（回撤反弹）信号代表一个完整周期：先见顶（top_price）→回撤到最低点（low_price，回撤幅度记在 n_pattern_retracement）→再分 4 段反弹（fibon_break1/2/3/4 对应反弹 20%/40%/60%/新高），fibon_break4_time 有值说明价格已经反弹突破了本轮回撤前的最高点，本轮周期结束',
    // - top_price / top_price_mcap / top_price_time   本轮回撤前的最高点（价格【sol/bnb 本位】/市值（U本位）/时间）
    // - low_price / low_price_mcap / low_price_time    本轮回撤触底的最低点（价格【sol/bnb 本位】/市值（U本位）/时间）
    // - n_pattern_retracement                          回撤幅度（0-1，从最高点跌到最低点的比例）
    // - n_pattern_confirmed                            回撤幅度是否达到确认阈值（≥20%才算一次有效回撤）
    // - fibon_break1 / fibon_break1_time                反弹阶段1：反弹 20% 时的价格【sol/bnb 本位，且没有按 decimals 精度换算，是原始价格】/时间
    // - fibon_break2 / fibon_break2_time                反弹阶段2：反弹 40% 时的价格【同上】/时间
    // - fibon_break3 / fibon_break3_time                反弹阶段3：反弹 60% 时的价格【同上】/时间
    // - fibon_break4 / fibon_break4_time                反弹阶段4：反弹新高（突破本轮回撤前的最高点）——有值=本轮周期已结束，下次再回撤是新的一轮
    // fibon_break1/2/3/4 跟 top_price/low_price 不一样：top_price_mcap/low_price_mcap 这两个市值是平台直接算好给你的，
    // 但 fibon_break 没有现成的 _mcap 字段，要自己换算
    // 市值(USD) = fibon_breakN * (10 ** ctx.logearn.decimals) / ctx.native_coin_decimal * ctx.logearn.total_supply * ctx.native_coin_price（native_coin_* 自动匹配当前信号所在链，等价于按链取 sol_*/bnb_*）
    // 注意不能漏掉中间那个精度换算的除法，少了这一步算出来的市值会差好几个数量级
    "v_breakout_volume_list": [{
      "top_price_time": 1781977239, 
      "top_price": 0.001249275522467,
      "top_price_mcap": 88698.562095157,
      "low_price_time": 1781987239, 
      "low_price": 0.000412033017438,
      "low_price_mcap": 29254.344238098,      
      "n_pattern_retracement": 0.6702,
      "n_pattern_confirmed": true,
      "fibon_break1": 0.000611296733635,
      "fibon_break2": 0.000731859654359,
      "fibon_break3": 0.000929448885546,
      "fibon_break4": 0, // 反弹新高时的价格【sol/bnb 本位】；这条样本还没反弹突破前高，所以是 0
      "fibon_break1_time": 1781980089,
      "fibon_break2_time": 1781980415,
      "fibon_break3_time": 1781981207,
      "fibon_break4_time": null, // 还没反弹突破前高（本轮回撤反弹周期还没结束），所以是 null；一旦有值就表示这一轮反弹周期已经结束
      "signalTime": 1781981207, // 当前信号时间
      "type": "v_breakout_volume",
      "title": "回调后反弹",
      // fibon_break3 换算市值的公式说明见上面 v_breakout_volume_list 字段说明那段注释
      "content": "反弹60%($65.99K)，此前回调67.02%，市值从$88.7K至$29.25K，回调时长1小时",
    }],
    "whale_list": [{
      "whaleWalletCount": 7,  // 本次共振一个7个蓝筹地址
      "pastMinute": "1", //共振的时间周期，1 则表示本共振信号在过去1分钟内发生
      "volume": "43.72M", // 共振的时间周期内，这些头部蓝筹钱包总买入的代币量
      "whaleTxCount": 9, //共振的时间周期。这些蓝筹钱包一个买入的次数
      "signalTime": 1782055781, // 信号时间
      "type": "whale",
      "notice_mcap": 7751.879608953, //
      "title": "💎 蓝筹顶级赢家共振",
      "content": "过去1分钟，7个聪明地址9次总买入43.72M Uncraft(4.37%)，通知市值$7.75K",
    }],    
    // 24小时范围内的所有休眠苏醒信号，给了一条样本
    // 一个休眠苏醒信号由休眠阶段和苏醒阶段构成
    "breakout_volume_10x_list": [{
      "avg_history_volume": 6.001835, // 休眠阶段的平均交易量，单位 【sol/bnb】
      "history_start_time": 1781993400,  // 休眠阶段的开始和结束时间
      "history_end_time": 1782048900,
      "history_kline_count": 35, //本次休眠阶段一共涉及到了多少根K线
      "volume_ratio": 12.310779, // 当前苏醒交易量是平均休眠交易量的多少倍，直接当倍数用就行（比如 12.31 表示 12.31x，不用再乘 100）。本条样本自己就能验算：current_volume/avg_history_volume = 73.887262466/6.001835 = 12.3108
      // ⚠️ 别照 content 文案解析这个值：下面那条 content 里写的是"放量12.31%"（百分号），属平台侧措辞，跟字段的倍数口径对不上，以字段数值为准
      "current_volume": 73.887262466, // 当前苏醒时候的交易量，单位 【sol/bnb】
      "signalTime": 1782049463, //当前苏醒信号时间
      "type": "breakout_volume_10x",
      "notice_mcap": 46782.94362581306, // 当前信号市值
      "title": "苏醒信号",
      "cv": 26.54, //休眠时波动率26.54%
      "standardized_slope": 0.67, //休眠时斜率为：0.67%
      "content": "休眠代币突然放量12.31%至$5.25K，通知市值$46.78K，从最高点回调71.32%，休眠时波动率26.54%、斜率0.67%",
    }],

    "last_alert": { // 最近一次信号，可能是 token 现在有6大信号【「关注」，聪明钱，共振、精选、反弹、苏醒】的任意一种信号，和前面信号数据结构意义
      "amount_coin": "987654320",
      "amount_token": "29166075037266",
      "block_time": 1782033376,
      "caller": "F2SuErm4MviWJ2HzKXk2nuzBC6xe883CFWUDCPz6cyWm",
      "receiver": "F2SuErm4MviWJ2HzKXk2nuzBC6xe883CFWUDCPz6cyWm",
      "trade_type": "swap-buy",
      "type": "followed",
      "decimals": 6,
      "symbol": "Martha",
      "token_address": "dnFkkHvS3qSNpCGMkQ7kT4n6kaFjq6m7icJKhqyiWPm",
      "total_supply": 1000000000,
      "chain": 3,
      "swap_begin_time": 1781979783,
      "amount": 29166075.037266,
      "value": 987654320,
      "time": 1782033376,
      "signalTime": 1782033376,
      "wallet": "F2SuErm4MviWJ2HzKXk2nuzBC6xe883CFWUDCPz6cyWm",
      "notice_mcap": 2404.2815713256596,
      "title": "👀 我的关注",
      "content": "earl买入29.17MMartha(2.92%) ，0.98SOL($70.12)，通知市值$2.4K",
      "who": "earl",
      "html_content": "<span class=\"swap-buy\">买入</span> 29.17MMartha(2.92%) ，0.98SOL($70.12)，通知市值$2.4K",
      "id": "1782033378063nk0wykl",
      "signal_type": "followed"
    },
    "followed_last_traded": 1782033376, // 我关注的钱包最近一次在这个代币上交易的时间（Unix 秒）
    "followed_signal_state": { // 我关注的所有钱包在这个代币上的持仓状态汇总
      "walletPositionMap": { // 按钱包地址分组的持仓详情，key 是钱包地址
        "F2SuErm4MviWJ2HzKXk2nuzBC6xe883CFWUDCPz6cyWm": {
          "wallet": "F2SuErm4MviWJ2HzKXk2nuzBC6xe883CFWUDCPz6cyWm",
          "who": "earl", // 昵称/备注名
          "symbol": "Martha",
          "token_balance": 29166075.037266, // 当前持仓数量（人类可读单位）
          "total_flow_in": 29166075.037266, // 累计净流入数量（人类可读单位）
          "tx_count": 1, // 这个钱包在这个代币上的交易次数
          "total_buy_value": 987654320, // 累计买入花费的原生币数量，链上最小单位
          "total_sell_value": 0, // 累计卖出收到的原生币数量，链上最小单位
          "position_status": "create_p", // 持仓状态：create_p = 新建仓位
          "profit_rate": 0, // 盈利比例（小数，不是百分比）
          "profit_pnl": 0, // 盈亏金额（USD）
          "last_trade": 1782033376 // 最近交易时间（Unix 秒）
        }
      },
      "tokenAggregatedMap": { // 整体汇总（不分钱包）
        "holder_count": 1, // 有几个我关注的钱包在持有这个代币
        "last_status": { // 最近一次状态变化的快照
          "last_trade": 1782033376,
          "position_status": "create_p",
          "who": "earl",
          "wallet": "F2SuErm4MviWJ2HzKXk2nuzBC6xe883CFWUDCPz6cyWm"
        },
        "net_in": 2.9166075037266004 // 所有关注钱包合计的净流量占总发行量的百分比（%）
      }
    },
    // smart_money_signal_state 结构跟上面 followed_signal_state 完全一样，只是统计对象换成了「聪明钱」标签钱包；
    // 这个样本里是空对象 {}，表示当前没有聪明钱在这个代币上活动——访问子字段前记得用 ?. 兜底
    "smart_money_signal_state": {},
    "type": "followed" // 这条 ctx.logearn 数据本身是由哪种信号触发产生的；取值见 ALL_SIGNAL_TYPES：whale / v_breakout_volume / continue_breakout_volume / breakout_volume_10x / followed / smart_money
  },

  // 所有数组都是 newest first（第 0 项是最新一根），跟 kline_bars 按下标对齐
  kline_and_indicators: {
    "resolution": "5", // K线粒度，系统token 年龄自动选择
    "current_price": 0.0000030926919, // 当前价格 = 最新一根K线的收盘价（已经是美元单价，跟 logearn.price_now 的"原生币计价"不同，这个不用再换算）
    "current_avg_price": 0.0000028103412, // 当前的成交量加权平均成本价（avg_price），等价于 avg_price_bars[0].value，常用来当「市场平均成本线」
    "avg_price_deviation_pct": 10.05, // 当前价格相对 current_avg_price 的偏离百分比，正数=价格在成本线上方（比如 10.05 表示高出成本线 10.05%）
    "current_ao": 0.0000001823, // 当前 AO（Awesome Oscillator 动量震荡指标）值，等价于 ao_bars[0].value，正值=多头动量，负值=空头动量
    "kline_bars": [ // 原始K线数组，newest first
      { "time": 1780085700, "open": 0.0000030500000, "close": 0.0000030926919, "high": 0.0000031200000, "low": 0.0000030100000, "volume": 1823.45, "token_volume": 612345678 }, // time=K线开始时间(Unix秒)；open/close/high/low=美元单价；volume=美元计价的成交额；token_volume=代币计价的成交量（原始数量，未必按精度换算）
      { "time": 1780085400, "open": 0.0000029800000, "close": 0.0000030500000, "high": 0.0000030700000, "low": 0.0000029600000, "volume": 1450.12, "token_volume": 498765432 },
    ],
    "avg_price_bars": [ // avg_price 历史序列，跟 kline_bars 按下标对齐
      { "time": 1780085700, "value": 0.0000028103412 }, // value = 截止这根K线的累计加权平均成本价（美元）
      { "time": 1780085400, "value": 0.0000027980211 },
    ],
    "ao_bars": [ // AO 动量震荡指标柱子列表，跟 kline_bars 按下标对齐；AO = SMA(中间价,5) - SMA(中间价,34)，跟成交量无关，数据不够34根时尾部会被截掉（所以这个数组可能比 kline_bars 短）
      { "time": 1780085700, "value": 0.0000001823, "rising": true }, // value=AO值；rising=是否比前一根（更早的一根）高，对应图表上的绿柱(true)/红柱(false)
      { "time": 1780085400, "value": 0.0000001512, "rising": true },
      { "time": 1780084500, "value": 0.0000000932, "rising": true }
    ],
    "timestamp": 1780085760000 // 这份指标数据的计算时间，单位毫秒（注意跟上面其它 time 字段的"秒"不一样）
  },

  // gmgn 各字段含义以官方 GMGN Skill 文档为准：skills/gmgn/SKILL.md（市值不直接返回，要自己拿 price.price × circulating_supply 算）
  gmgn: {
    "address": "VAMkgHZtmYUo7BCtWXrk7wyfP2ZCNKHFQrUkHvxpump", // 代币合约地址
    "symbol": "CTO", // ticker
    "name": "Community Take Over", // 全名
    "decimals": 6,
    "logo": "https://gmgn.ai/external-res/2260490ee0a4e96041833959081a1df9_v2.webp", // 代币 logo 图片 URL
    "banner": "https://gmgn.ai/external-res/a993c570222c417a25db70d98beec642.webp", // 代币 banner 图片 URL
    "biggest_pool_address": "6QWzhxVAJMdik7YRaEAwvpnPb1ajnjoMSopFvoy5AmVA", // 主交易池地址
    "open_timestamp": 1780085349, // 开始交易时间（Unix 秒）
    "migrated_timestamp": 1780085349, // 迁移/毕业时间（Unix 秒）
    "holder_count": 247, // 当前持有人数
    "circulating_supply": "999973922", // 流通供应量（人类可读单位，字符串类型）——算市值用这个：price.price × circulating_supply
    "total_supply": "999973922", // 总供应量
    "max_supply": "999973922", // 最大供应量上限
    "liquidity": "4459.5788227086", // 主交易池流动性，单位 USD（字符串类型）
    "creation_timestamp": 1780085025, // 代币创建时间（Unix 秒）
    "standard": "2022", // 代币标准/程序版本号（SOL上是 Token Program 版本之类，不同链含义不同）
    "trade_fee": "9.848321880173955", // 累计交易手续费（USD）
    "total_fee": "20.96034456484062", // 累计总手续费（USD，含交易+其它）
    "og": false, // 是否被标记为 OG（早期/原创）代币
    "image_dup_count": 0, // logo 图片重复使用次数（重复率高=可能是仿盘）
    "visiting_count": 2, // 页面访问次数
    "launchpad": "pump", // 发射平台标识：pump / moonshot 等
    "launchpad_status": 1, // 发射平台状态：0=未开盘，1=正在交易（内盘），2=已迁移（毕业到外盘）
    "launchpad_progress": 1, // 内盘曲线进度，0-1（1=已经100%毕业）
    "launchpad_platform": "Pump.fun", // 发射平台展示名
    "migrated_pool": "6QWzhxVAJMdik7YRaEAwvpnPb1ajnjoMSopFvoy5AmVA", // 毕业后外盘的交易池地址
    "migration_market_cap": 410.84, // 毕业时的市值（USD）
    "migration_market_cap_quote": "SOL", // migration_market_cap 的计价币种
    "ath_price": 0.00010254797, // 历史最高价（USD）
    "locked_ratio": 0, // 流动性锁仓比例，0-1
    "price": { // 价格 + 各时间窗口交易统计，访问当前价格用 price.price
      "address": "VAMkgHZtmYUo7BCtWXrk7wyfP2ZCNKHFQrUkHvxpump",
      "price": "0.0000030926919", // 当前价格，单位 USD（字符串类型，用时记得 parseFloat）
      "price_1m": "0.0000030926919", // 1分钟前价格
      "price_5m": "0.0000030994291", // 5分钟前价格
      "price_1h": "0.0000031091089", // 1小时前价格
      "price_6h": "0.0000046952209", // 6小时前价格
      "price_24h": "0.000002319209", // 24小时前价格
      "buys_1m": 0, // 1分钟内买入交易笔数
      "buys_5m": 0,
      "buys_1h": 4,
      "buys_6h": 24,
      "buys_24h": 7421,
      "sells_1m": 0, // 1分钟内卖出交易笔数
      "sells_5m": 1,
      "sells_1h": 11,
      "sells_6h": 74,
      "sells_24h": 5763,
      "volume_1m": "0", // 1分钟内总成交额，单位 USD（字符串）
      "volume_5m": "0.924792",
      "volume_1h": "146.49095681",
      "volume_6h": "1379.68579618",
      "volume_24h": "542018.33958866",
      "buy_volume_1m": "0", // 1分钟内买入成交额，单位 USD
      "buy_volume_5m": "0",
      "buy_volume_1h": "69.41939606",
      "buy_volume_6h": "433.1445296",
      "buy_volume_24h": "273409.84000027",
      "sell_volume_1m": "0", // 1分钟内卖出成交额，单位 USD
      "sell_volume_5m": "0.924792",
      "sell_volume_1h": "77.071560747",
      "sell_volume_6h": "946.54126658",
      "sell_volume_24h": "268608.49958838",
      "swaps_1m": 0, // 1分钟内总成交笔数（买+卖）
      "swaps_5m": 1,
      "swaps_1h": 15,
      "swaps_6h": 98,
      "swaps_24h": 13184,
      "hot_level": 0 // 热度等级（整数）
    },
    "pool": { // 主交易池详情
      "address": "VAMkgHZtmYUo7BCtWXrk7wyfP2ZCNKHFQrUkHvxpump",
      "pool_address": "6QWzhxVAJMdik7YRaEAwvpnPb1ajnjoMSopFvoy5AmVA", // 池子地址
      "quote_address": "So11111111111111111111111111111111111111112", // 计价币种合约地址（这里是 SOL）
      "quote_symbol": "SOL", // 计价币种 ticker
      "liquidity": "4459.5788227086", // 池子流动性，单位 USD
      "base_reserve": "712273046.363314", // 池子里代币（base）的储备量
      "quote_reserve": "26.978698262", // 池子里计价币（quote）的储备量
      "initial_liquidity": "13967.31579313158", // 池子创建时的初始流动性，单位 USD
      "initial_base_reserve": "206900000", // 初始代币储备量
      "initial_quote_reserve": "84.990360187", // 初始计价币储备量（Native coin 本位)
      "creation_timestamp": 1780085349, // 池子创建时间（Unix 秒）
      "base_reserve_value": "2202.8410810761456649566", // 代币储备的 USD 价值
      "quote_reserve_value": "2229.24983738906", // 计价币储备的 USD 价值
      "quote_vault_address": "CvWmKqWNYCuLha8vkKTvFcKuNtFvxngxvcZqCMvQfPBZ", // 计价币金库地址
      "base_vault_address": "3MD7Z8t6mFgg59yWs5W4J7EHMYXJZbLcGzzCE1xQhvda", // 代币金库地址
      "creator": "", // 池子创建者地址
      "exchange": "pump_amm", // DEX 名称，如 raydium / pump_amm / meteora_dlmm / uniswap_v3
      "token0_address": "",
      "token1_address": "",
      "base_address": "", // base 代币地址（一般跟外层 address 相同）
      "fee_ratio": "0" // 交易手续费比例，比如 0.1 表示 0.1%
    },
    "dev": { // 开发者/创建者信息
      "address": "VAMkgHZtmYUo7BCtWXrk7wyfP2ZCNKHFQrUkHvxpump",
      "creator_address": "BmkbjqYEzWpe8nTXM81zzNeK2n8MkpXNGYjeYCNGEYZY", // 创建者钱包地址
      "creator_token_balance": "0", // 创建者当前持仓数量
      "creator_token_status": "creator_close", // 创建者持仓状态：creator_hold=还在持有（风险更高），creator_close=已卖出/退出
      "twitter_name_change_history": [], // 创建者推特改名历史，每条含 twitter_username/rename_timestamp
      "top_10_holder_rate": "0.154", // 前10大持有人占比（0-1）
      "dexscr_ad": 0, // 是否买了 DexScreener 广告：1=是，0=否
      "dexscr_update_link": 1, // 是否更新过 DexScreener 社交链接：1=是，0=否
      "cto_flag": 1, // 是否被「社区接管」(Community Take Over，原开发者放弃后社区接力运营)：1=是，0=否
      "dexscr_boost_fee": 99, // 是否买了 DexScreener Boost：1=是，0=否（这里数值是手续费，非0即视为已购买）
      "dexscr_trending_bar": 0, // 是否上过 DexScreener 趋势榜：1=是，0=否
      "dexscr_ad_ts": 0, // 购买 DexScreener 广告的时间（Unix 秒）
      "dexscr_update_link_ts": 1780085167, // 更新社交链接的时间（Unix 秒）
      "dexscr_boost_ts": 1780085511, // 购买 Boost 的时间（Unix 秒）
      "dexscr_trending_bar_ts": 0, // 上趋势榜的时间（Unix 秒）
      "twitter_del_post_token_count": 0, // 创建者删除过的推特发币帖子数
      "twitter_create_token_count": 0, // 创建者在推特上宣传过的代币数量
      "fund_from": "", // 给创建者钱包打过钱的地址（资金来源追溯）
      "fund_from_ts": 1778008173, // 那笔资金到账时间（Unix 秒）
      "creator_open_count": 9, // 这个创建者历史发过的代币数量（发币越多越要警惕惯犯）
      "offchain": false, // 是否是链下代币
      "ath_token_info": { // 这个创建者历史上表现最好的代币信息（可选字段）
        "ath_token": "9ty2Ex15foGNyBUV94eTuQL7JU8Li6xQiejzJeyBpump", // 那个代币的合约地址
        "ath_mc": "121259.66", // 那个代币的历史最高市值（USD）
        "avatar": "https://gmgn.ai/external-res/be1955516b6fb4915292297346a05535_v2.webp",
        "symbol": "rage comics",
        "name": "rage comics",
        "creation_timestamp": 1778520466
      }
    },
    "link": { // 社交媒体/外链信息
      "address": "VAMkgHZtmYUo7BCtWXrk7wyfP2ZCNKHFQrUkHvxpump",
      "gmgn": "https://gmgn.ai/sol/token/VAMkgHZtmYUo7BCtWXrk7wyfP2ZCNKHFQrUkHvxpump", // GMGN 页面链接
      "geckoterminal": "https://www.geckoterminal.com/solana/tokens/VAMkgHZtmYUo7BCtWXrk7wyfP2ZCNKHFQrUkHvxpump", // GeckoTerminal 页面链接
      "twitter_username": "koop0x/status/2060451819227156517", // 推特用户名（注意这里是用户名不是完整URL，有时会带状态路径，按需自己清理）
      "website": "https://pump.fun/communities/VAMkgHZtmYUo7BCtWXrk7wyfP2ZCNKHFQrUkHvxpump", // 官网链接
      "telegram": "https://t.me/ctocoinonsol", // Telegram 链接
      "bitbucket": "",
      "discord": "", // Discord 链接
      "description": "", // 项目描述文字
      "facebook": "",
      "github": "",
      "instagram": "",
      "linkedin": "",
      "medium": "",
      "reddit": "",
      "tiktok": "",
      "youtube": "",
      "verify_status": 0, // 社交验证状态（整数，具体取值未公开）
      "fracaster": null
    },
    "stat": { // 链上统计指标，多数是比例（0-1）
      "holder_count": 247, // 持有人数，跟外层 holder_count 一致
      "signal_count": 0, // GMGN 自己统计的信号触发次数
      "degen_call_count": 0, // Degen Call 提醒次数
      "top_rat_trader_percentage": "0", // 插队/内鬼交易者的成交占比
      "top_bundler_trader_percentage": "0.0422", // 机器人捆绑买入的成交占比
      "top_entrapment_trader_percentage": "0.0331", // 诱多/陷阱交易者的成交占比
      "top_bot_degen_percentage": "0.0748", // 机器人 degen 钱包的成交占比
      "creator_created_count": 33, // 创建者历史发币数（同 dev.creator_open_count）
      "bot_degen_count": 79, // 机器人 degen 钱包数量
      "bot_degen_rate": "0.0748", // 机器人 degen 钱包占比
      "fresh_wallet_rate": "0.0817", // 新钱包持仓占比
      "top_10_holder_rate": "0.154", // 前10大持有人占比（0-1），数值越高越集中，>0.5 高风险
      "dev_team_hold_rate": "0", // 开发团队持仓占比
      "creator_hold_rate": "0", // 创建者持仓占比
      "creator_token_balance": "0", // 创建者当前持仓数量（字符串）
      "private_vault_hold_rate": "0", // 私有金库（vanish）地址持仓占比
      "top70_sniper_hold_rate": "0" // 前70名狙击手钱包持仓占比
    },
    "wallet_tags_stat": { // 各类标签钱包的持有人数统计（人数，不是占比）
      "smart_wallets": 18, // 聪明钱钱包数——评估强弱信号常用这个：>=3 算不错，0 偏空
      "fresh_wallets": 643, // 新钱包数
      "renowned_wallets": 2, // KOL/名人钱包数
      "creator_wallets": 2, // 创建者相关钱包数
      "sniper_wallets": 27, // 狙击手钱包数（开盘即买入），数量越多越像内部刷量
      "rat_trader_wallets": 0, // 插队/内鬼交易者钱包数
      "whale_wallets": 0, // 巨鲸钱包数
      "top_wallets": 100, // 总的"顶级"钱包数（一般固定100，对应Top100持有人榜单大小）
      "bundler_wallets": 446 // 机器人捆绑买入钱包数
    },
    "fee_distribution": { // 发射平台手续费分成配置（pump/bankr 类平台才有），可用来确认创建者是否已经领过手续费分成
      "launchpad": "pump", // 平台标识：pump / bankr / 空字符串(未知)
      "platform_data": { // pump 平台时的结构（bankr 平台结构略有不同，多一个 deployer/fee_recipient 字段）
        "fee_authority": "BmkbjqYEzWpe8nTXM81zzNeK2n8MkpXNGYjeYCNGEYZY", // 手续费管理权地址
        "is_locked": true, // 分成配置是否已锁定
        "show": false, // 是否在 GMGN 页面展示分成信息
        "is_charity": false, // 是否标记为慈善捐赠
        "list": [ // 分成持有人列表
          {
            "username": "",
            "pfp": "",
            "twitter_username": "",
            "royalty_bps": 10000, // 分成比例，单位基点，10000=100%
            "is_creator": true, // 是否是原始创建者
            "wallet": "BmkbjqYEzWpe8nTXM81zzNeK2n8MkpXNGYjeYCNGEYZY",
            "has_claimed_fee": false, // 是否已经领取过手续费分成
            "is_charity": false
          }
        ],
        "bonus_category": [ // 额外奖励类别标签
          "creator_reward",
          "cashback"
        ]
      }
    }
  },

  // holders 样本，真实数据为 GMGN Top 100 持有人列表（这里只放 1 条做字段示例，字段含义以 skills/gmgn/SKILL.md「token holders」一节为准）
  holders: [
    {
      "address": "AV8BePV3LjhLXsCsge4pLspEpWjCyb8a6qqe5n65Tyhk", // 钱包地址
      "account_address": "GpJfxHXZJw5woEu9N1h9JbMo6uoshbe9PmMEjZyAmHrB", // 持有这个代币的链上账户地址（跟钱包地址是两个概念，SOL上每个token都有独立的token account）
      "addr_type": 0, // 地址类型：0=普通钱包，2=交易所/流动性池
      "exchange": "", // addr_type=2 时对应的交易所/池子名称
      "native_balance": "3480000", // 原生币（SOL）余额，链上最小单位（lamports）
      "balance": 3463402.57456, // 当前持有代币数量，人类可读单位
      "amount_cur": 3463402.57456, // 跟 balance 相同，当前持有数量
      "usd_value": 6.528685984153556, // 当前持仓的美元价值
      "amount_percentage": 0.003463481950639345, // 占总供应量比例（0-1，不是百分数），比如 0.05 表示持有 5%
      "accu_amount": 3463402.57456, // 累计获得的代币数量
      "accu_cost": 9.674504240153613, // 累计成本（USD）
      "cost": 9.674504240153613, // 当前持仓的成本（USD）
      "cost_cur": 9.674504240153613, // 跟 cost 相同
      "sell_amount_cur": 0, // 已卖出的代币数量
      "sell_amount_percentage": 0, // 已卖出比例（0-1），1.0 表示已经全部清仓
      "sell_volume_cur": 0, // 卖出总额，USD
      "buy_volume_cur": 0, // 买入总额，USD——常用来判断"是否真实买入"（这条样本是 0，说明持仓是靠转账转入的，不是买的，见下面 transfer_in）
      "buy_amount_cur": 0, // 买入的代币数量
      "netflow_usd": 0, // 净流入金额(USD) = 卖出收入 - 买入花费，负数表示净花钱买入
      "netflow_amount": 0, // 净流入代币数量 = 买入 - 卖出，正数表示还有净持仓
      "buy_tx_count_cur": 0, // 买入交易笔数
      "sell_tx_count_cur": 0, // 卖出交易笔数
      "current_buy_amount": 0, // 当前持仓中来自买入的数量
      "current_sell_amount": 0, // 当前已卖出数量
      "current_transfer_in_amount": 3463402.57456, // 当前持仓中来自转账转入的数量（不是买来的）
      "current_transfer_out_amount": 0, // 当前已转出的数量
      "history_bought_cost": 0, // 历史买入花费总额（USD）
      "history_bought_fee": 0, // 历史买入手续费总额（USD）
      "history_sold_income": 0, // 历史卖出收入总额（USD）
      "history_sold_fee": 0, // 历史卖出手续费总额（USD）
      "history_transfer_in_amount": 3463402.57456, // 历史转入代币总数量
      "history_transfer_in_cost": 9.674504240153613, // 转入代币的估算成本（USD）
      "history_transfer_out_amount": 0, // 历史转出代币总数量
      "history_transfer_out_income": 0, // 转出代币的估算收益（USD）
      "history_transfer_out_fee": 0, // 转出手续费（USD）
      "transfer_in_count": 1, // 转入次数
      "transfer_out_count": 0, // 转出次数
      "wallet_tag_v2": "TOP8", // 在这次查询结果里的排名标签（TOP1/TOP2...），不是全局固定排名
      "profit": -3.145818256000057, // 总盈亏（USD，已实现+未实现）
      "total_cost": 9.674504240153613, // 总成本基础（含手续费）
      "profit_change": -0.32516583567594853, // 总盈亏比例 = profit / total_cost（小数，不是百分比）
      "realized_profit": 0, // 已实现盈利（USD，来自已完成的卖出）
      "realized_pnl": null, // 已实现盈利比例 = realized_profit / 买入成本，没有已实现交易则为 null
      "unrealized_profit": -3.145818256000057, // 未实现盈亏（USD，按当前价格计算的浮亏/浮盈）
      "unrealized_pnl": -0.32516583567594853, // 未实现盈亏比例（小数），没有当前持仓则为 null
      "avg_cost": null, // 平均买入成本单价（USD/币），没有买入记录（比如纯转入）则为 null
      "avg_sold": null, // 平均卖出价格（USD/币），没有卖出记录则为 null
      "transfer_in": true, // 当前持仓是否（部分）来自转账转入，而不是市场买入——结合上面 buy_volume_cur=0 可以判断这个钱包完全是"接盘转入"，不是自己买的
      "is_new": false, // 是否新钱包（无历史交易记录）
      "is_suspicious": false, // 是否被标记为可疑钱包
      "is_on_curve": false, // 是否仍在内盘曲线上（pump.fun 毕业前）：false=已经在外盘
      "start_holding_at": 1781561837, // 首次获得这个代币的时间（Unix 秒）
      "end_holding_at": null, // 完全清仓的时间（Unix 秒），还持有则为 null
      "last_block": 426723247, // 最近一次链上活动的区块高度
      "last_active_timestamp": 1781561837, // 最近一次链上活动时间（Unix 秒）
      "native_transfer": null, // 这个钱包收到的第一笔原生币（SOL）转账记录——常用来追溯资金来源、判断是否多个钱包同一来源（协同操作）；这里是 null 表示没有这类记录
      "token_transfer": { // 最近一次代币转账记录（买/卖/转入/转出都算）
        "name": "",
        "address": "9FWYkBrv7EccyqkRsxC6y6nm3GEL6ZwUJX9x1urgZ1N7",
        "timestamp": 1781561837,
        "tx_hash": "ncjpgVFkaxxKs75846Z1MGAuQ4vv4QzPfunMCEyoB5rVJjWAJnZzKe7YerYStcZ2mmdNG4UU4FZqhFDAUbkW1L3",
        "type": "transfer_in" // 类型：buy/sell/transfer_in/transfer_out/holding(无最近动作)
      },
      "token_transfer_in": { // 最近一次"转入"记录，结构跟 token_transfer 一样
        "name": "",
        "address": "9FWYkBrv7EccyqkRsxC6y6nm3GEL6ZwUJX9x1urgZ1N7",
        "timestamp": 1781561837,
        "tx_hash": "ncjpgVFkaxxKs75846Z1MGAuQ4vv4QzPfunMCEyoB5rVJjWAJnZzKe7YerYStcZ2mmdNG4UU4FZqhFDAUbkW1L3",
        "type": "transfer_in"
      },
      "token_transfer_out": { // 最近一次"转出"记录；这里没有转出过，type 是 holding 占位
        "name": null,
        "address": "",
        "timestamp": 0,
        "tx_hash": "",
        "type": "holding"
      },
      "tags": [ // 平台级钱包标签（这个钱包本身的属性，跟具体哪个代币无关）
        "gmgn", // 用 GMGN 自家工具交易
      	"axiom", // 用过 Axiom 交易机器人
        "sandwich_bot", // 疑似三明治攻击机器人
        "bluechip_owner", // 持有过其它蓝筹/established代币,
        "kol", // 当前钱包时 kol
        "smart_degen",
      ],
      "maker_token_tags": [ // 针对"这一个代币"的行为标签（跟具体代币相关）
        "top_holder", // 是该代币的大户
        "transfer_in", // 持仓主要靠转入而非买入
      	 "bundler", // 参与了机器人捆绑买入
      	"paper_hands" // 历史上有"拿不住、稍微浮盈/浮亏就跑"的卖出习惯
      ],
      "name": "zeroprince", // 钱包显示名（已知身份才有）
      "avatar": "https://gmgn.ai/defi/images/twitter/38e093c0db39429314a19d2594dfb142.jpg", // 头像 URL
      "twitter_username": "Prince73549949", // 关联推特用户名
      "twitter_name": "zeroprince", // 关联推特显示名
      "created_at": 1732183927 // 钱包创建时间（Unix 秒），0 表示未知
    },
  ],

  // 筹码峰分析的背景：主要是对当前所有持有者持有的筹码进行如下几点分析
  // 1、分析这些筹码按照他们建仓的成本价格，在价格上面的分布
  // 2、分析这些筹码按照他们建仓的时间，在时间上面的分布
  // 3、分析这些筹码，在日后的时间里卖出情况
  // 4、基于这些分布明细去统计一些关键时间点的情况，或者上层按照各种需求去统计分析
  chip_analysis: {
    // 当前 代币 USD 市值（来自 ctx.logearn.mcap）
    current_mcap: 85000,

    // 当前价格以上仍持有的筹码占比（%）
    // 计算逻辑 = 持有总量/发行总量 * 100
    // 值越高 = 越多人处于亏损状态，价格上涨时会遇到较多抛压
    above_percent: 42.3,

    // 当前价格以下仍持有的筹码占比（%）
    // 计算逻辑 = 持有总量/发行总量 * 100
    // 值越高 = 越多人处于盈利状态，底部支撑越强
    below_percent: 31.7,

    // Top 500 持有者累积持仓总量 / total_supply（%）
    // 计算逻辑 = Top 500 持有者累积持仓总量/发行总量 * 100
    total_holding_percent: 74.0,

    // 内盘卖出率是指：内盘毕业时所有持有者持有的筹码到现在为止卖出的比例
    // 内盘卖出比率 [0, 100]：(内盘毕业时持有的总量 - 内盘地址目前实际剩余持仓) / 内盘毕业时持有的总量
    // 内盘毕业时所有持有者的持仓总量加起来是 80%（持有总量/总发行量 * 100），这个 80% 是机制决定，常数
    // 0 = 内盘几乎没卖出；100 = 内盘全部离场
    // 未毕业（launch_time === 0）时固定为 0
    inner_sell_ratio: 68,

    // 内盘地址剩余持仓 / 全部持仓（%）
    // 衡量"当前还在持仓的筹码里，有多少是内盘地址持有的"
    // 内盘地址 = 在 launch_time 之前买入的地址
    // 未毕业时固定为 0
    inner_address_holding: 15.2,

    // 内盘地址里「当前仍有持仓」的去重地址数（内盘地址 = launch_time 之前买入的钱包，这里只数还留着仓位的）
    // 未毕业（launch_time=0）时固定为 0
    inner_holding_address_count: 8,

    // 按 USD 市值区间分 70 桶的筹码分布
    // mcap_range: [桶起点美元市值, 桶终点美元市值]
    // percent: 该价格区间买入、仍持有的量 / total_supply（%）
    // 按市值从小到大排列，index=0 对应最低价格区间
    price_bars: [
      { mcap_range: [0, 5000],       percent: 0.8 },
      { mcap_range: [15000, 20000],  percent: 8.1 },
      { mcap_range: [20000, 25000],  percent: 12.4 }, // 筹码峰：在此价位买入最多
      { mcap_range: [35000, 40000],  percent: 4.1 },
      // ... 共 70 个桶，这里只展示前 8 个作为示例
    ],

    // 按 K 线粒度（auto resolution，由 token 年龄自动决定粒度）分组的时间筹码分布
    // time: K 线起始时间（Unix 秒，对齐到 K 线粒度），percent: 该时间段买入仍持有量 / total_supply（%）
    // 按时间正序排列（从最早到最近）
    time_bars: [
      { time: 1748000000, percent: 2.1 },
      { time: 1748000600, percent: 11.3 }, // 买入集中时间段（筹码峰）
      // ... 共若干根，时间粒度由 token 年龄决定（几秒/几分/几小时不等）
    ],

    // 仍持有的前 5 大地址（按持仓从多到少），用来判断头部筹码的来源：
    // total_hold_percent = 该地址仍持有 / total_supply（%）= buy_percent + transfer_in_percent
    // buy_percent = 其中"买入得来"的部分（%），transfer_in_percent = 其中"转账进来"的部分（%，高=老鼠仓/分发）
    // buy_cost = 买入部分总成本（USD，转账不计），time = 建仓时间（最早一笔买入/转入的 Unix 秒）
    top5_holders: [
      { wallet: "0xA1b2...c3D4", total_hold_percent: 6.2, buy_percent: 6.0, transfer_in_percent: 0.2, buy_cost: 1250.5, time: 1748000600 }, // 几乎全是买来的
      { wallet: "0xE5f6...a7B8", total_hold_percent: 4.8, buy_percent: 0.3, transfer_in_percent: 4.5, buy_cost: 80.0,   time: 1748000000 }, // 主要靠转账进来，警惕
      { wallet: "0x9c0d...E1f2", total_hold_percent: 3.5, buy_percent: 3.5, transfer_in_percent: 0.0, buy_cost: 640.0,  time: 1748000900 },
    ],
  },

  // narrative 是单个字符串，中英文叙事拼在一起（中文在前，\n 分隔，英文在后），没有结构化字段；
  // 过滤代码一般用关键词/正则匹配这段文字，比如判断有没有提到"AI"/"meme"/某个KOL名字等
  narrative: "这是一个社区接管（CTO）类型的代币，原开发者放弃后由社区重新接力运营，主打 meme 文化 + AI 叙事结合，近期因为知名 KOL 转发带量。\nThis is a Community-Take-Over (CTO) token: the original developer abandoned it and the community took over operations. Positioned around meme culture combined with an AI narrative, recently gained volume after being shared by a well-known KOL.",  
}