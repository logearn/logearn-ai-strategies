// 字段分组。旧版 computeFieldGroups 读全局 scatterOptions，这里改成入参。
import { isHoldingField, isDevField, isStatField, isChipField, isHolderField, isKlineVolumeField, isSignalField, isAssembledField, isNonAnalyticField } from './data.js';

// gmgn 子树的前缀判定。注意与 data.js 里 isDevField/isStatField 的关系：
// 那两个是【用户圈定的显式白名单】（当初特意从前缀匹配改过来的，为的是不让被过滤掉的字段
// 重新混进分组）。白名单只有 8 和 13 个字段，而真实数据里 gmgn.dev.* / gmgn.stat.*
// 有几十个——清单外的以前全部掉进"未归入主题分组"，几十个字段挤在一个无名组里没法用。
// 现在的做法：白名单字段仍在 dev/stat 组（排在前面），清单外的按前缀落到"其他 gmgn"组，
// 既保住用户的筛选偏好，又让它们可被浏览。
const RE_GMGN_PRICE = /^gmgn\.price\./;
const RE_GMGN_ANY = /^gmgn\./;

export const GROUP_LABELS = {
  holding: '持仓指标（各类钱包持仓占比）',
  assembled: '比率/差值衍生 + 自定义字段',
  signal: '信号字段（从六类信号列表提取）',
  volume: 'K线量能字段（来自 kline_bars 序列统计）',
  dev: 'dev 字段（创建者维度，gmgn.dev.*）',
  stat: 'stat 字段（持仓结构/交易者画像，gmgn.stat.*）',
  chip: '筹码字段（chip_analysis.*）',
  holder: '持有人字段（Top100 持有人快照聚合，holder_*）',
  price: '行情/动量字段（gmgn.price.*）',
  gmgnOther: '其他 gmgn 字段（未列入 dev/stat 白名单）',
  ungrouped: '未归入主题分组的字段',
};
export const GROUP_ORDER = ['holding', 'assembled', 'signal', 'volume', 'dev', 'stat',
  'chip', 'holder', 'price', 'gmgnOther', 'ungrouped'];

export function computeFieldGroups(fields) {
  const g = Object.fromEntries(GROUP_ORDER.map(k => [k, []]));
  for (const f of fields) {
    if (isNonAnalyticField(f)) continue;
    // 判定顺序有意义：持仓指标最先（用户最常用的核心筛选字段），
    // 未命中任何主题谓词的原始白名单字段落到 ungrouped，不能静默丢弃。
    if (isHoldingField(f)) g.holding.push(f);
    else if (isDevField(f)) g.dev.push(f);
    else if (isStatField(f)) g.stat.push(f);
    else if (isChipField(f)) g.chip.push(f);
    else if (isHolderField(f)) g.holder.push(f);
    else if (isKlineVolumeField(f)) g.volume.push(f);
    else if (isSignalField(f)) g.signal.push(f);
    else if (isAssembledField(f)) g.assembled.push(f);
    // gmgn.price.* 是唯一可靠的短期动量来源（buys_1m/5m/1h/6h/24h 真实拆分），
    // 单独成组而不是混进"其他"——它是一整类分析维度
    else if (RE_GMGN_PRICE.test(f)) g.price.push(f);
    else if (RE_GMGN_ANY.test(f)) g.gmgnOther.push(f);
    else g.ungrouped.push(f);
  }
  for (const k of GROUP_ORDER) g[k].sort();
  return g;
}
