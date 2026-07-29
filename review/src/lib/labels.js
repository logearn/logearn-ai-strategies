// 人工标注：给单个代币打"优良/垃圾"标记。
//
// 动机：returnMax 只看 max_mcap，一个 10x 可能只是一根扎针（wick），根本卖不进去。
// 人工判定它是垃圾后，就把它的收益【降级】成一笔亏损，让所有分析（胜率/中位数/策略回放/
// 每条 check 的效果）都按真实情况算，而不是被这根假针撑高。
//
// 标记按 CA（小写）存 localStorage，跨会话保留。降级是"改 returnMax"不是"删样本"——
// 样本量 n 不变，只是它不再算作赢家；这样统计口径最干净。

import { readJsonLS, writeJsonLS } from './localStorageStore.js';

const STORAGE_KEY = 'chart_token_labels_v1';

// junk 降级到的 returnMax：1.0 = 保本/白忙一场，明确不是赢家（> WIN_THRESHOLD=2 才算赢），
// 又不至于当成 -90% 那种极端亏损去拉低中位数。就是"这次没赚到"。
export const JUNK_RETURN = 1.0;

export function loadLabels() {
  const obj = readJsonLS(STORAGE_KEY, {});
  return obj && typeof obj === 'object' ? obj : {};
}

export function saveLabels(labels) {
  writeJsonLS(STORAGE_KEY, labels);
}

const norm = ca => String(ca || '').toLowerCase();

export function getLabel(labels, ca) {
  return labels[norm(ca)] || null;   // 'good' | 'junk' | null
}

export function setLabel(labels, ca, label) {
  const next = { ...labels };
  const k = norm(ca);
  if (!label) delete next[k];        // 传空 = 清除标记
  else next[k] = label;
  return next;
}

// 把标记应用到行上：junk 的 returnMax 降级成 JUNK_RETURN，原值留在 returnMaxRaw。
// 返回新数组（不改原 rows），每行带 label 字段供界面展示。
export function applyLabels(rows, labels) {
  if (!rows.length) return rows;
  return rows.map(r => {
    const label = getLabel(labels, r.tokenAddress);
    if (!label) return r.label ? { ...r, label: null } : r;
    if (label === 'junk') {
      return { ...r, label, returnMaxRaw: r.returnMaxRaw ?? r.returnMax, returnMax: JUNK_RETURN };
    }
    // good 只是标注，不改 returnMax（人工确认"这是真赢家"，用于记录/保护）
    return { ...r, label };
  });
}

// 黑名单 = 所有标为 junk 的 CA。导出成纯文本（每行一个）或结构化。
export function junkList(labels) {
  return Object.entries(labels).filter(([, v]) => v === 'junk').map(([ca]) => ca);
}
export function goodList(labels) {
  return Object.entries(labels).filter(([, v]) => v === 'good').map(([ca]) => ca);
}
