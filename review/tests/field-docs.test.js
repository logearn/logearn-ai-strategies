import assert from 'node:assert';
import { computeFieldGroups, GROUP_ORDER } from '../src/lib/fieldGroups.js';

export function run(test) {
  test('computeFieldGroups: 应剔除非分析字段，且未命中主题的落到 ungrouped 不能丢', () => {
    const g = computeFieldGroups(['smart_volume', 'holder_bot_ratio', 'kline_volume_cv',
      'sol_price', '_highlight_x', 'some_unknown_field']);
    assert.ok(g.holding.includes('smart_volume'));
    assert.ok(g.holder.includes('holder_bot_ratio'));
    assert.ok(g.volume.includes('kline_volume_cv'));
    assert.ok(g.ungrouped.includes('some_unknown_field'), '未归类字段必须出现，不能静默丢弃');
    const all = GROUP_ORDER.flatMap(k => g[k]);
    assert.ok(!all.includes('sol_price') && !all.includes('_highlight_x'), '剔除规则应生效');
  });

  test('computeFieldGroups: 白名单外的 gmgn 字段应进"其他 gmgn"组，不能掉进"未归入分组"', () => {
    // dev/stat 是用户圈定的显式白名单（只有 8 和 13 个），真实数据里 gmgn.dev.* / gmgn.stat.*
    // 有几十个。清单外的以前全部掉进"未归入主题分组"，几十个字段挤在一个无名组里没法浏览。
    const g = computeFieldGroups([
      'gmgn.dev.creator_open_count',          // 白名单内 → dev 组
      'gmgn.dev.creator_token_balance_rate',  // 白名单外 → 其他 gmgn
      'gmgn.stat.top_rat_trader_percentage',  // 白名单内 → stat 组
      'gmgn.stat.holder_count',               // 白名单外 → 其他 gmgn
      'gmgn.liquidity',                       // 非 dev/stat → 其他 gmgn
      'plain_field',                          // 非 gmgn → 未归入
    ]);
    assert.deepStrictEqual(g.dev, ['gmgn.dev.creator_open_count']);
    assert.deepStrictEqual(g.stat, ['gmgn.stat.top_rat_trader_percentage']);
    assert.deepStrictEqual(g.gmgnOther.sort(),
      ['gmgn.dev.creator_token_balance_rate', 'gmgn.liquidity', 'gmgn.stat.holder_count']);
    assert.deepStrictEqual(g.ungrouped, ['plain_field']);
  });

  test('computeFieldGroups: gmgn.price.* 应单独成"行情/动量"组', () => {
    // 这是唯一可靠的短期动量来源（buys_1m/5m/1h/6h/24h 真实拆分），是一整类分析维度，
    // 不该和 gmgn.liquidity 之类混在"其他"里
    const g = computeFieldGroups(['gmgn.price.buys_1h', 'gmgn.price.price_24h', 'gmgn.liquidity']);
    assert.deepStrictEqual(g.price.sort(), ['gmgn.price.buys_1h', 'gmgn.price.price_24h']);
    assert.deepStrictEqual(g.gmgnOther, ['gmgn.liquidity']);
  });

  test('computeFieldGroups: 人工标记的"无用分组"字段优先级压过 dev/stat/chip 判定', () => {
    const g = computeFieldGroups([
      'gmgn.stat.bot_degen_count', 'gmgn.stat.creator_token_balance',
      'chip_analysis.price_to_peak_ratio', 'chip_analysis.price_concentration_hhi',
      'chip_analysis.above_below_ratio',
      'gmgn.stat.top_rat_trader_percentage', // 对照组：白名单内 stat 字段不受影响
    ]);
    assert.deepStrictEqual(g.useless.sort(), [
      'chip_analysis.above_below_ratio', 'chip_analysis.price_concentration_hhi',
      'chip_analysis.price_to_peak_ratio', 'gmgn.stat.bot_degen_count', 'gmgn.stat.creator_token_balance',
    ]);
    assert.deepStrictEqual(g.stat, ['gmgn.stat.top_rat_trader_percentage']);
    assert.strictEqual(g.chip.length, 0);
  });

  test('computeFieldGroups: 每个字段只能落进一个组', () => {
    const g = computeFieldGroups(['holder_bot_ratio', 'smart_volume', 'kline_max_rise_pct']);
    const all = GROUP_ORDER.flatMap(k => g[k]);
    assert.strictEqual(new Set(all).size, all.length, '不应有字段被重复归组');
  });
}
