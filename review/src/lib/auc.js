// AUC 批量检测：对一批字段算 rank AUC + bootstrap 置信区间，并做多重比较校正。
//
// 两个必须守住的口径（都在这个会话里踩过）：
// 1) 点估计和置信区间必须用【同一个算法】。旧版点估计走 computeROC（内部把阈值下采样到 100 个，
//    n>100 时是近似），CI 走精确的 rankAuc —— 结果出现过"点估计落在自己的置信区间之外"。
// 2) direction 必须在 bootstrap 之外先定好。若在每次重采样里各自取 max(auc, 1-auc)，
//    会把噪声一律翻到 0.5 以上，置信区间被系统性抬高。
import { rankAuc, bootstrapAucCI, benjaminiHochbergAdjust, WIN_THRESHOLD } from './utils.js';
import { getFeature } from './data.js';

export function collectAucSamples(rows, field, winThreshold = WIN_THRESHOLD) {
  const values = [], labels = [];
  for (const r of rows) {
    const raw = getFeature(r, field);
    // 同分箱一样：null / 空串不能靠 Number() 转成 0 混进来
    if (raw === undefined || raw === null || raw === '') continue;
    const v = Number(raw);
    const ret = Number(r.returnMax);
    if (!Number.isFinite(v) || !Number.isFinite(ret)) continue;
    values.push(v);
    labels.push(ret > winThreshold ? 1 : 0);
  }
  return { values, labels };
}

export function aucForField(rows, field, { winThreshold = WIN_THRESHOLD, bootstrapB = 300 } = {}) {
  const { values, labels } = collectAucSamples(rows, field, winThreshold);
  const n = values.length;
  const pos = labels.reduce((a, b) => a + b, 0);
  // 单一类别（全赢或全输）时 AUC 没有定义，不能返回 0.5 冒充"无区分度"
  if (n < 10 || pos === 0 || pos === n) {
    return { field, n, pos, auc: NaN, ci: null, direction: null,
      reason: n < 10 ? `有效样本仅 ${n} 条` : '样本全部同类，AUC 无定义' };
  }
  const aucHigh = rankAuc(values, labels, 'high');
  // 方向先定死再做 bootstrap，不能在每次重采样里各自取较大的那个
  const direction = aucHigh >= 0.5 ? 'high' : 'low';
  const auc = direction === 'high' ? aucHigh : 1 - aucHigh;
  const ciRaw = bootstrapAucCI(values, labels, direction, bootstrapB);
  return { field, n, pos, auc, direction, ci: ciRaw, reason: null };
}

// 目标变量及其变换必须排除：拿 returnMax 去预测"returnMax>2"必然得到 AUC=1，
// 是自己预测自己，混在批量结果里既没意义又会顶掉真字段的排名。
// 放在逻辑层而不是调用方过滤——算 AUC 的模块本来就知道目标是谁，靠调用方记得排除迟早会漏。
export const AUC_TARGET_FIELDS = new Set(['returnMax', 'logReturnMax', 'currentMcap', 'maxMcap', 'initialMcap']);

export function scanFieldsAuc(rows, fields, opts = {}) {
  const scanned = fields.filter(f => !AUC_TARGET_FIELDS.has(f));
  const results = scanned.map(f => aucForField(rows, f, opts));
  const usable = results.filter(r => Number.isFinite(r.auc) && r.ci);
  // 用 CI 反推一个近似 p 值做 BH 校正：CI 离 0.5 越远越显著。
  // 这里不假装它是精确 p——命名成 pApprox，避免被当成正式检验结果。
  const pApprox = usable.map(r => {
    const half = (r.ci.hi - r.ci.lo) / 2;
    if (!(half > 0)) return 0;
    const z = Math.abs(r.auc - 0.5) / (half / 1.96);
    return 2 * (1 - normCdf(z));
  });
  const adj = benjaminiHochbergAdjust(pApprox);
  usable.forEach((r, i) => { r.pApprox = pApprox[i]; r.pAdj = adj[i]; r.significant = r.ci.lo > 0.5 || r.ci.hi < 0.5; });
  // 单字段 AUC 显著性的门槛随字段数抬升：批量扫 m 个字段时，
  // 光看"CI 不跨 0.5"会有大量假阳性，所以额外给出 BH 校正后的判定。
  usable.forEach(r => { r.significantAdj = r.significant && r.pAdj < 0.05; });
  return { results, usable: usable.sort((a, b) => Math.abs(b.auc - 0.5) - Math.abs(a.auc - 0.5)) };
}

function normCdf(z) {
  // Abramowitz-Stegun 近似，足够做排序和粗略校正
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
