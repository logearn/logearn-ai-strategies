// buildRows() 组装字段提取函数的直接单元测试（2026-07-29 新增）
//
// 背景：这批 applyXxxFeatures 函数是 2026-07-29 从 buildRows() 那个上千行的巨型函数里按块拆出来的
// （见 readme「拆 data.js 的 buildRows()」一节）。拆之前这些字段公式只被 parity.test.js /
// analytics-parity.test.js 这类端到端测试【间接】覆盖——端到端测试只能告诉你"整体对不对"，
// 单个字段的分母为 0、数组为空、必需字段缺失这些分支从来没被直接测过。
//
// 每个函数至少覆盖三类场景：
//   ① 正常输入 → 字段值符合手算结果
//   ② 关键缺失分支 → 该缺失时字段【确实不写入】（而不是悄悄写个 0/NaN 进去）
//   ③ 已知边界 → 比如 addr_type===2 的交易所地址要先剔除、分子为 0 是合法值不能当缺失

import assert from 'node:assert';
import {
  applySimpleRatioFeatures,
  applyChipShapeFeatures,
  applyContinueBreakoutFeatures,
  applyBreakout10xFeatures,
  applyWhaleFeatures,
  applyKlineVolumeShapeFeatures,
  applyHolderStatsFeatures,
  applyGmgnTopFeatures,
  applyMaxUpFeatures,
  applySignalTimingFeatures,
} from '../src/lib/data.js';

// 浮点比较：这些字段大多是除法结果，不能用 strictEqual
const near = (actual, expected, msg, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < eps, `${msg}：期望 ≈${expected}，实际 ${actual}`);

export function run(test) {
  // ==================== applySimpleRatioFeatures ====================

  test('applySimpleRatioFeatures: 各比率按 d1 买卖字段计算', () => {
    const f = {
      buy_wcoin_amount_d1: 30, sell_wcoin_amount_d1: 10,
      buyer_count_d1: 8, seller_count_d1: 4,
      buy_tx_count_d1: 24, sell_tx_count_d1: 12,
      smart_money_address_buy_count_d1: 5, smart_money_address_sell_count_d1: 2,
      pool_liquidity: 2000,
      'chip_analysis.above_percent': 40, 'chip_analysis.below_percent': 20,
    };
    applySimpleRatioFeatures(f, 10000);
    near(f['buy_sell_amount_ratio'], 3, 'buy_sell_amount_ratio');
    near(f['buy_sell_count_ratio'], 2, 'buy_sell_count_ratio');
    near(f['buy_sell_tx_ratio'], 2, 'buy_sell_tx_ratio');
    near(f['smart_buy_sell_ratio'], 2.5, 'smart_buy_sell_ratio');
    near(f['mcap_liquidity_ratio'], 5, 'mcap_liquidity_ratio');
    near(f['avg_buy_amount'], 30 / 8, 'avg_buy_amount');
    near(f['avg_sell_amount'], 10 / 4, 'avg_sell_amount');
    near(f['chip_analysis.above_below_ratio'], 2, 'above_below_ratio');
    near(f['buy_tx_per_buyer'], 3, 'buy_tx_per_buyer');
    near(f['sell_tx_per_seller'], 3, 'sell_tx_per_seller');
    near(f['smart_money_net_buy_count'], 3, 'smart_money_net_buy_count');
  });

  test('applySimpleRatioFeatures: 分子为 0 是合法值，必须写入 0 而不是当成缺失', () => {
    // 这是这块代码专门用 Number.isFinite 而不是真值判断的原因——写成 if (buy && sell) 会把
    // "24小时一笔买入都没有"这种真实且重要的情况整行丢掉
    const f = { buy_wcoin_amount_d1: 0, sell_wcoin_amount_d1: 10, smart_money_address_buy_count_d1: 0, smart_money_address_sell_count_d1: 3 };
    applySimpleRatioFeatures(f, undefined);
    assert.strictEqual(f['buy_sell_amount_ratio'], 0, '买入量为 0 时比值应为 0，不能缺失');
    assert.strictEqual(f['smart_money_net_buy_count'], -3, '聪明钱净买入为负是合法结果');
  });

  test('applySimpleRatioFeatures: 分母为 0 或缺失时对应字段不写入', () => {
    const f = { buy_wcoin_amount_d1: 30, sell_wcoin_amount_d1: 0, buyer_count_d1: 8, pool_liquidity: 0 };
    applySimpleRatioFeatures(f, 10000);
    assert.strictEqual(f['buy_sell_amount_ratio'], undefined, '卖出量为 0 时不能写入 Infinity');
    assert.strictEqual(f['mcap_liquidity_ratio'], undefined, '流动性为 0 时不能写入 Infinity');
    assert.strictEqual(f['buy_sell_count_ratio'], undefined, 'seller_count_d1 缺失时不写入');
  });

  // ==================== applyChipShapeFeatures ====================

  test('applyChipShapeFeatures: 筹码峰/集中度/头部持仓来源', () => {
    const f = {};
    const arrays = {
      'chip_analysis.price_bars': [
        { mcap_range: [0, 5000], percent: 1 },
        { mcap_range: [15000, 20000], percent: 3 },   // 峰：mid = 17500
        { mcap_range: [20000, 25000], percent: 9 },   // percent 更大，见下一条测试
      ],
      'chip_analysis.top5_holders': [
        { total_hold_percent: 6, transfer_in_percent: 0.2 },
        { total_hold_percent: 4, transfer_in_percent: 4 },
      ],
    };
    applyChipShapeFeatures(f, arrays, 45000);
    near(f['chip_analysis.price_to_peak_ratio'], 45000 / 22500, 'price_to_peak_ratio 应按 percent 最大那桶的中值算');
    near(f['chip_analysis.price_concentration_hhi'], (1 + 9 + 81) / 169, 'hhi = 各桶归一化份额平方和');
    near(f['chip_analysis.top5_hold_percent'], 10, 'top5 合计持仓');
    near(f['chip_analysis.top5_transfer_in_ratio'], 42, 'top5 里转账进来的占比（4.2/10）');
  });

  test('applyChipShapeFeatures: mcap_range 畸形的桶不参与选峰（但仍计入 hhi 的总量）', () => {
    // 边界来源：畸形 bar 的 mid 是 NaN，如果不跳过就会把 peakMcap 永久置成 NaN，
    // 后面有效的 bar 再也接不上，price_to_peak_ratio 会整个消失
    const f = {};
    const arrays = { 'chip_analysis.price_bars': [
      { mcap_range: 'oops', percent: 9 },            // percent 最大但 range 坏了
      { mcap_range: [15000, 20000], percent: 3 },
    ] };
    applyChipShapeFeatures(f, arrays, 35000);
    near(f['chip_analysis.price_to_peak_ratio'], 2, '应退而选 range 合法的那桶（mid=17500）');
    near(f['chip_analysis.price_concentration_hhi'], (81 + 9) / 144, '畸形桶的 percent 仍计入总量');
  });

  test('applyChipShapeFeatures: 数组缺失/为空时整组不写入', () => {
    const f = {};
    applyChipShapeFeatures(f, {}, 10000);
    assert.deepStrictEqual(Object.keys(f), [], '没有 price_bars/top5_holders 时不应写任何字段');
    applyChipShapeFeatures(f, { 'chip_analysis.price_bars': [], 'chip_analysis.top5_holders': [] }, 10000);
    assert.deepStrictEqual(Object.keys(f), [], '空数组同样不写入');
  });

  // ==================== applyContinueBreakoutFeatures（早期精选）====================

  const pickSnapshot = (list) => ({ signal: { continue_breakout_volume_list: list } });

  test('applyContinueBreakoutFeatures: 取 signalTime 最新的一条算明细', () => {
    const f = { native_coin_price: 76 };
    const s = pickSnapshot([
      { signalTime: 500, notice_mcap: 999 },  // 更早的一条，不该被选中
      { signalTime: 1000, notice_mcap: 16106, max_amplitude: 300.66, max_amplitude_time: 940,
        all_bullish: true, volume1: 38, volume2: 27, volume3: 21,
        kline1_bullish: true, kline2_bullish: true, kline3_bullish: false },
    ]);
    applyContinueBreakoutFeatures(f, s, 1600 * 1000, 400 * 1000);
    assert.strictEqual(f['continue_breakout_volume_signal_count'], 2, '次数按数组长度');
    near(f['continue_breakout_volume_recent_notice_mcap'], 16106, '应取最新那条的 notice_mcap');
    near(f['continue_breakout_volume_recent_max_amplitude'], 300.66, 'max_amplitude 恒为百分比数值');
    near(f['continue_breakout_volume_recent_amplitude_before_signal_min'], 1, '振幅高点在信号前 1 分钟');
    assert.strictEqual(f['continue_breakout_volume_recent_all_bullish'], 1, 'all_bullish 布尔转 0/1');
    near(f['continue_breakout_volume_recent_signal_volume'], 21 * 76, '交易量取 volume3 × 币价');
    near(f['continue_breakout_volume_recent_volume_total'], (38 + 27 + 21) * 76, '三根合计 × 币价');
    near(f['continue_breakout_volume_recent_volume_trend_ratio'], 21 / 38, '缩量上涨：volume3/volume1 < 1');
    assert.strictEqual(f['continue_breakout_volume_recent_bullish_kline_count'], 2, '三根里 2 根阳线');
    near(f['continue_breakout_volume_recent_signal_from_open_min'], 10, '开盘到信号 10 分钟');
    near(f['continue_breakout_volume_recent_signal_to_buy_min'], 10, '信号到买入 10 分钟');
  });

  test('applyContinueBreakoutFeatures: 缺 native_coin_price 时 USD 口径字段缺失，不退化成写原生币数值', () => {
    // 同一个字段混着 SOL 和 USD 两种单位，比缺失危险得多——跨样本比较会得出完全错误的结论
    const f = {};
    applyContinueBreakoutFeatures(f, pickSnapshot([{ signalTime: 1000, volume1: 38, volume2: 27, volume3: 21 }]), NaN, NaN);
    assert.strictEqual(f['continue_breakout_volume_recent_signal_volume'], undefined, '没有币价就不该写交易量');
    assert.strictEqual(f['continue_breakout_volume_recent_volume_total'], undefined, '没有币价就不该写合计交易量');
    near(f['continue_breakout_volume_recent_volume_trend_ratio'], 21 / 38, '比值无量纲，不依赖币价，仍应算出');
  });

  test('applyContinueBreakoutFeatures: 空数组写 0（"确实一次都没有"），字段不存在才算缺失', () => {
    const f1 = {};
    applyContinueBreakoutFeatures(f1, pickSnapshot([]), 1000, 1000);
    assert.strictEqual(f1['continue_breakout_volume_signal_count'], 0, '空数组是明确信息，应记 0');
    assert.strictEqual(f1['continue_breakout_volume_recent_notice_mcap'], undefined, '没有信号就没有明细');
    const f2 = {};
    applyContinueBreakoutFeatures(f2, { signal: {} }, 1000, 1000);
    assert.strictEqual(f2['continue_breakout_volume_signal_count'], undefined, '整个字段不存在（老数据）才算缺失');
  });

  // ==================== applyBreakout10xFeatures（休眠苏醒）====================

  test('applyBreakout10xFeatures: 休眠期形态 + 苏醒K线明细', () => {
    const f = {};
    const s = { signal: { breakout_volume_10x_list: [{
      signalTime: 2000, notice_mcap: 113664.75, max_up_mcap: 138367.48, volume_ratio: 12.310779,
      history_start_time: 1000, history_end_time: 1600, history_kline_count: 35,
      cv: 26.54, standardized_slope: 0.67,
      current_bullish: true, current_open_price: 100, current_close_price: 110,
    }] } };
    applyBreakout10xFeatures(f, s, 2600 * 1000, 400 * 1000);
    assert.strictEqual(f['breakout_volume_10x_signal_count'], 1);
    near(f['breakout_volume_10x_recent_volume_ratio'], 12.310779, 'volume_ratio 直接当倍数用，不乘 100');
    near(f['breakout_volume_10x_recent_dormant_duration_min'], 10, '休眠 600 秒 = 10 分钟');
    assert.strictEqual(f['breakout_volume_10x_recent_dormant_kline_count'], 35);
    near(f['breakout_volume_10x_recent_dormant_cv'], 26.54, '休眠波动率');
    near(f['breakout_volume_10x_recent_dormant_slope'], 0.67, '休眠斜率');
    near(f['breakout_volume_10x_recent_dormant_end_to_signal_min'], 400 / 60, '休眠结束到信号');
    assert.strictEqual(f['breakout_volume_10x_recent_kline_bullish'], 1);
    near(f['breakout_volume_10x_recent_kline_change_pct'], 10, '苏醒那根涨 10%');
    near(f['breakout_volume_10x_recent_drawdown_from_high_pct'], (138367.48 - 113664.75) / 138367.48 * 100,
      '回调深度应与平台文案的 17.85% 对上');
    near(f['breakout_volume_10x_recent_signal_from_open_min'], (2000 - 400) / 60, '开盘到信号');
    near(f['breakout_volume_10x_recent_signal_to_buy_min'], 10, '信号到买入');
  });

  test('applyBreakout10xFeatures: 信号市值已超历史高点时回调深度应为负数，不截断成 0', () => {
    // 平台文案会把负值显示成"回调0%"，这里刻意不跟——截断会把"刚好持平"和"大幅创新高"压成同一个值
    const f = {};
    const s = { signal: { breakout_volume_10x_list: [{ signalTime: 2000, notice_mcap: 169499, max_up_mcap: 139250 }] } };
    applyBreakout10xFeatures(f, s, NaN, NaN);
    assert.ok(f['breakout_volume_10x_recent_drawdown_from_high_pct'] < 0, '创新高应算出负的回调深度');
  });

  test('applyBreakout10xFeatures: 开盘价非正时不算涨幅（避免除以 0）', () => {
    const f = {};
    const s = { signal: { breakout_volume_10x_list: [{ signalTime: 2000, current_open_price: 0, current_close_price: 110 }] } };
    applyBreakout10xFeatures(f, s, NaN, NaN);
    assert.strictEqual(f['breakout_volume_10x_recent_kline_change_pct'], undefined);
  });

  // ==================== applyWhaleFeatures（蓝筹共振）====================

  test('applyWhaleFeatures: 共振钱包数/次数/人均次数', () => {
    const f = {};
    const s = { signal: { whale_list: [
      { signalTime: 800, whaleWalletCount: 2, whaleTxCount: 2 },
      { signalTime: 1000, whaleWalletCount: 7, whaleTxCount: 9, pastMinute: '1', notice_mcap: 7751.879608953 },
    ] } };
    applyWhaleFeatures(f, s, 1600 * 1000, 400 * 1000);
    assert.strictEqual(f['whale_signal_count'], 2);
    assert.strictEqual(f['whale_recent_wallet_count'], 7, '应取 signalTime 最新那条');
    assert.strictEqual(f['whale_recent_tx_count'], 9);
    near(f['whale_recent_tx_per_wallet'], 9 / 7, '人均买入次数');
    assert.strictEqual(f['whale_recent_past_minute'], 1, 'pastMinute 是字符串"1"，要转成数值');
    near(f['whale_recent_notice_mcap'], 7751.879608953);
    near(f['whale_recent_signal_from_open_min'], 10);
    near(f['whale_recent_signal_to_buy_min'], 10);
  });

  test('applyWhaleFeatures: whaleWalletCount 缺失时人均次数不写入', () => {
    const f = {};
    applyWhaleFeatures(f, { signal: { whale_list: [{ signalTime: 1000, whaleTxCount: 9 }] } }, NaN, NaN);
    assert.strictEqual(f['whale_recent_wallet_count'], undefined);
    assert.strictEqual(f['whale_recent_tx_per_wallet'], undefined, '分母缺失不能写 Infinity');
    assert.strictEqual(f['whale_recent_tx_count'], 9, '有值的字段仍应写入');
  });

  // ==================== applyKlineVolumeShapeFeatures ====================

  // 10 根 5 分钟 K 线，newest first（跟真实数据同序）
  const makeBars = (over = {}) => {
    const bars = [];
    for (let i = 0; i < 10; i++) {
      bars.push({ time: 1780000000 - i * 300, open: 100, high: 100, low: 100, close: 100, volume: 10, token_volume: 1e6 });
    }
    if (over.spikeAt !== undefined) bars[over.spikeAt].high = 150;
    return bars;
  };

  test('applyKlineVolumeShapeFeatures: 量能集中度/变异系数/放量倍数/换手率', () => {
    const f = { total_supply: 1e9 };
    applyKlineVolumeShapeFeatures(f, { 'kline_and_indicators.kline_bars': makeBars() });
    near(f['kline_volume_concentration_pct'], 10, '10 根等量 → 最大一根占 10%');
    near(f['kline_volume_cv'], 0, '等量序列的变异系数为 0');
    near(f['kline_volume_recent_ratio'], 1, '最新一根与之前均量相同 → 1');
    near(f['kline_volume_trend_ratio'], 1, '前后半段等量 → 1');
    near(f['kline_bar_minutes'], 5, 'K线粒度从相邻 bar 时间差中位数推断');
    near(f['kline_minutes_since_max_volume'], 0, '最大量那根就是最新一根');
    near(f['kline_turnover_pct'], 1, '1e7 / 1e9 = 1%');
  });

  test('applyKlineVolumeShapeFeatures: 急拉程度取最陡的一段（多尺度扫描）', () => {
    const f = { total_supply: 1e9 };
    applyKlineVolumeShapeFeatures(f, { 'kline_and_indicators.kline_bars': makeBars({ spikeAt: 4 }) });
    near(f['kline_max_rise_pct'], 50, '开 100 冲 150 → 50%');
    near(f['kline_max_rise_speed_pct_per_min'], 10, '最陡的是 1 根(5分钟)的窗口：50% / 5min');
    near(f['kline_max_rise_window_min'], 5, '最陡那段发生在 5 分钟尺度上');
  });

  test('applyKlineVolumeShapeFeatures: K线不足 10 根时整组不写入', () => {
    // 序列统计量在 1~2 根 K 线上算出来的数字看着有值、其实毫无意义，宁可缺失
    const f = { total_supply: 1e9 };
    applyKlineVolumeShapeFeatures(f, { 'kline_and_indicators.kline_bars': makeBars().slice(0, 9) });
    assert.deepStrictEqual(Object.keys(f), ['total_supply'], '不足 10 根不应写任何量能字段');
  });

  test('applyKlineVolumeShapeFeatures: kline_is_usd 为 0 时跳过成交额类字段，但换手率仍可算', () => {
    // volume 不是 USD 计价时跨样本不可比；token_volume 是代币数量，不受该标记影响
    const f = { total_supply: 1e9, 'kline_and_indicators.kline_is_usd': 0 };
    applyKlineVolumeShapeFeatures(f, { 'kline_and_indicators.kline_bars': makeBars() });
    assert.strictEqual(f['kline_volume_concentration_pct'], undefined, '非 USD 计价的成交额不可比');
    assert.strictEqual(f['kline_volume_cv'], undefined);
    near(f['kline_turnover_pct'], 1, '换手率是代币口径，不受影响');
  });

  // ==================== applyHolderStatsFeatures ====================

  const holder = (over = {}) => Object.assign({
    addr_type: 0, balance: 1e6, amount_percentage: 0.01, buy_volume_cur: 100,
    current_transfer_in_amount: 0, transfer_in: false, is_suspicious: false, is_new: false,
    tags: [], maker_token_tags: [], profit: 0, sell_amount_percentage: 0, start_holding_at: 0,
    native_balance: '0',
  }, over);

  test('applyHolderStatsFeatures: 交易所地址占比在全体上算，其余比例在剔除后的真实持有人上算', () => {
    // 这是这块代码最容易搞错的口径：把 addr_type===2 的池子地址混进"真实持有人"里，
    // 所有画像类比例都会被系统性稀释
    const f = {};
    const holders = [
      holder({ addr_type: 2 }),                 // 交易所/流动性池，不是真实持有人
      holder({ transfer_in: true }),
      holder(),
      holder(),
    ];
    applyHolderStatsFeatures(f, { holders });
    near(f['holder_exchange_ratio'], 25, '4 个里 1 个是池子地址');
    near(f['holder_transfer_in_ratio'], 100 / 3, '转账接盘比例的分母应是 3 个真实持有人，不是 4');
  });

  test('applyHolderStatsFeatures: 标签画像/盈亏/集中度', () => {
    const f = {};
    const holders = [
      holder({ tags: ['sandwich_bot'], maker_token_tags: ['bundler'], profit: 5, amount_percentage: 0.30 }),
      holder({ tags: ['kol'], maker_token_tags: ['paper_hands'], profit: -1, sell_amount_percentage: 0.5, amount_percentage: 0.10 }),
      holder({ is_suspicious: true, is_new: true, amount_percentage: 0.10 }),
      holder({ buy_volume_cur: 0, amount_percentage: 0.10 }),
    ];
    applyHolderStatsFeatures(f, { holders });
    near(f['holder_bot_ratio'], 25, '4 个里 1 个带 bot 类标签');
    near(f['holder_bundler_ratio'], 25);
    near(f['holder_paper_hands_ratio'], 25);
    near(f['holder_smart_ratio'], 25, 'kol 属于 smart 类标签');
    near(f['holder_suspicious_ratio'], 25);
    near(f['holder_new_ratio'], 25);
    near(f['holder_in_profit_ratio'], 25, '只有 1 个 profit > 0');
    near(f['holder_sold_ratio'], 25, '只有 1 个卖出过');
    near(f['holder_never_bought_ratio'], 25, '只有 1 个 buy_volume_cur === 0');
    // 份额 0.3/0.1/0.1/0.1，归一化后 0.5/1/6 各一份 → hhi = (0.5² + 3×(1/6)²)
    near(f['holder_hhi'], 0.25 + 3 * (1 / 6) ** 2, 'hhi 应按归一化份额平方和算');
    assert.ok(f['holder_gini'] > 0, '份额不均时 gini 应为正');
  });

  test('applyHolderStatsFeatures: holders 缺失/为空时整组不写入，不强行给 0', () => {
    const f = {};
    applyHolderStatsFeatures(f, {});
    assert.deepStrictEqual(Object.keys(f), [], '没有 gmgn 数据时整组缺失');
    applyHolderStatsFeatures(f, { holders: [] });
    assert.deepStrictEqual(Object.keys(f), [], '空数组同样不写入');
  });

  test('applyHolderStatsFeatures: 全是交易所地址时真实持有人为 0，只写 exchange_ratio', () => {
    const f = {};
    applyHolderStatsFeatures(f, { holders: [holder({ addr_type: 2 }), holder({ addr_type: 2 })] });
    near(f['holder_exchange_ratio'], 100);
    assert.strictEqual(f['holder_transfer_in_ratio'], undefined, '分母为 0 时不能写 NaN');
  });

  // ==================== applyGmgnTopFeatures ====================

  test('applyGmgnTopFeatures: 短期动量/流动性/价格位置/换手强度', () => {
    const f = {
      'gmgn.price.buy_volume_5m': 30, 'gmgn.price.sell_volume_5m': 70,
      'gmgn.price.buy_volume_1h': 300, 'gmgn.price.sell_volume_1h': 100,
      'gmgn.price.buys_1h': 4, 'gmgn.price.sells_1h': 8,
      'gmgn.price.volume_5m': 50, 'gmgn.price.volume_1h': 120,
      'gmgn.pool.liquidity': 4459, 'gmgn.pool.initial_liquidity': 13967,
      'gmgn.circulating_supply': 8e8, 'gmgn.total_supply': 1e9,
      'gmgn.price.price': 0.000003, 'gmgn.ath_price': 0.00001,
      'gmgn.total_fee': 20, 'gmgn.liquidity': 4000,
    };
    applyGmgnTopFeatures(f);
    near(f['gmgn_net_buy_vol_ratio_5m'], 30, '30/(30+70) = 30%');
    near(f['gmgn_net_buy_vol_ratio_1h'], 75, '300/400 = 75%');
    near(f['gmgn_buy_sell_count_ratio_1h'], 0.5);
    near(f['gmgn_vol_accel_5m_1h'], (50 / 5) / (120 / 60), '5分钟均速 ÷ 1小时均速');
    near(f['gmgn_liquidity_change_ratio'], 4459 / 13967);
    near(f['gmgn_supply_circulating_ratio'], 0.8);
    near(f['gmgn_price_to_ath_ratio'], 0.3);
    near(f['gmgn_fee_to_liq_ratio'], 0.005);
  });

  test('applyGmgnTopFeatures: gmgn 数据缺失（约四成样本）时整组自动不写入', () => {
    const f = {};
    applyGmgnTopFeatures(f);
    assert.deepStrictEqual(Object.keys(f), [], 'gmgn 缺失时不应写任何 gmgn_ 字段');
  });

  test('applyGmgnTopFeatures: buy+sell 都为 0 时净买入占比不写入（不是写 0）', () => {
    // 完全没有成交 ≠ 净买入占比 0%，后者会被当成"卖压 100%"的强信号，是错的
    const f = { 'gmgn.price.buy_volume_5m': 0, 'gmgn.price.sell_volume_5m': 0, 'gmgn.price.sells_1h': 0, 'gmgn.price.buys_1h': 4 };
    applyGmgnTopFeatures(f);
    assert.strictEqual(f['gmgn_net_buy_vol_ratio_5m'], undefined);
    assert.strictEqual(f['gmgn_buy_sell_count_ratio_1h'], undefined, 'sells_1h 为 0 时不写 Infinity');
  });

  // ==================== applyMaxUpFeatures ====================

  test('applyMaxUpFeatures: 当前市值相对历史高点 + 冲高速度', () => {
    const f = { max_up_mcap: 1000, max_up_ratio: 120, max_up_duration: 3600 };
    applyMaxUpFeatures(f, 500);
    near(f['mcap_to_max_up_ratio'], 0.5, '已从高点回落一半');
    near(f['max_up_speed_pct_per_min'], 2, '120% ÷ 60 分钟');
  });

  test('applyMaxUpFeatures: max_up_duration 为 0（高点就在开盘那刻）时速度不写入', () => {
    const f = { max_up_mcap: 1000, max_up_ratio: 120, max_up_duration: 0 };
    applyMaxUpFeatures(f, 500);
    assert.strictEqual(f['max_up_speed_pct_per_min'], undefined, '除数为 0 不能写 Infinity');
    near(f['mcap_to_max_up_ratio'], 0.5, '同一块里另一个字段仍应算出');
  });

  // ==================== applySignalTimingFeatures ====================

  test('applySignalTimingFeatures: 合并六类信号按 signalTime 排序，产出序列/组合/首末类型', () => {
    const f = {}, cat = {};
    const s = { signal: {
      v_breakout_volume_list: [{ signalTime: 1000 }],
      continue_breakout_volume_list: [{ signalTime: 900 }, { signalTime: 950 }],
      whale_list: [],
    } };
    applySignalTimingFeatures(f, cat, s, 2000 * 1000);
    assert.strictEqual(f['signal_total_count'], 3);
    assert.strictEqual(f['signal_type_count'], 2, '出现过 2 类信号 = 多类共振');
    near(f['signal_span_min'], 100 / 60, '首末信号相隔 100 秒');
    near(f['signal_first_to_buy_min'], 1100 / 60, '首个信号到买入 1100 秒');
    assert.strictEqual(cat['signal_sequence'], 'continue>continue>v', '完整时序含同类重复');
    assert.strictEqual(cat['signal_combo'], 'continue+v', '组合去重后按字母序');
    assert.strictEqual(cat['signal_first_type'], 'continue');
    assert.strictEqual(cat['signal_last_type'], 'v', '最后一个信号 = 触发这次买入的那个');
  });

  test('applySignalTimingFeatures: 晚于买入时刻的信号必须排除（未来函数）', () => {
    // 快照是买入时刻抓的，正常不会出现晚于买入的信号；一旦有（时钟偏差/数据异常）就是
    // 当时根本看不到的信息，算进"信号顺序"会直接污染整条因子链路
    const f = {}, cat = {};
    const s = { signal: {
      v_breakout_volume_list: [{ signalTime: 900 }, { signalTime: 3000 }],
    } };
    applySignalTimingFeatures(f, cat, s, 2000 * 1000);
    assert.strictEqual(f['signal_total_count'], 1, '晚于买入的那条应被剔除');
    assert.strictEqual(cat['signal_sequence'], 'v');
  });

  test('applySignalTimingFeatures: 一个 list 都没有（老数据）时整组不写入；空 list 则记 0', () => {
    const f1 = {}, cat1 = {};
    applySignalTimingFeatures(f1, cat1, { signal: {} }, 1000);
    assert.deepStrictEqual(Object.keys(f1), [], '没有任何信号 list 时不写入');
    const f2 = {}, cat2 = {};
    applySignalTimingFeatures(f2, cat2, { signal: { whale_list: [] } }, 1000);
    assert.strictEqual(f2['signal_total_count'], 0, '数组存在但为空 = 确实没有信号，记 0');
    assert.strictEqual(cat2['signal_sequence'], undefined, '没有事件就没有序列');
  });

  test('applySignalTimingFeatures: 数据挂在 ctx.logearn 下（signal 没有）时同样能读到', () => {
    // 三条取值链（s.signal / s.ctx.logearn / s.ctx）是真实数据里都出现过的形态
    const f = {}, cat = {};
    applySignalTimingFeatures(f, cat, { ctx: { logearn: { whale_list: [{ signalTime: 900 }] } } }, 2000 * 1000);
    assert.strictEqual(f['signal_total_count'], 1);
    assert.strictEqual(cat['signal_first_type'], 'whale');
  });
}
