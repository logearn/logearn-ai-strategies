// 因子池进度持久化：因子发现是个耗时的手工过程（扫描+勾选+调权重），跟阵营库/已删因子/字段排除
// 一样值得跨会话保留——之前只存在纯内存 state 里，刷新页面或不小心关掉标签页就得从头再来。
// 只存"最终产物"（因子池本身 + 几个标量参数），不存 scanHero/scanEvil/selectedHero/selectedEvil
// 这类跟当次扫描强绑定的中间结果——它们体积大且离开原数据集就可能失真，重新点一次「扫描」比
// 恢复一份可能过期的候选表更可靠；因子池 factors 是手工编辑/勾选后的结果，语义上更稳定值得保留。

import { readJsonLS, writeJsonLS, removeLS } from './localStorageStore.js';

const STORAGE_KEY = 'chart_factor_pool_v1';

// 分数尺度版本。2026-07-29：scoreRow 的归一分母从「Σ全部权重」改成「Σ勇者权重」，跟实盘策略
// 模板对齐（见 readme 第 32/33 节）。同一个因子池的分数因此整体乘了一个正的常数倍——
// **秩序不变，但 cutoff 的绝对数值全变了**（用户真实池子实测 3.37×：旧的 -42 在新尺度下是 -141.7）。
//
// 存在本地的 cutoff 是【旧尺度】的数字，直接恢复会静默选错阈值：页面照常显示 -42，触发数却
// 跟上次完全不同，而且没有任何地方会提示。所以跨版本恢复时**只把 cutoff 摘掉**并回报
// cutoffScaleStale，让 UI 提醒用户重新点「推荐阈值」。
//
// 只丢 cutoff、不整体丢弃：因子池本身（字段/阵营/梯形四点/权重）跟归一分母无关，一个都没变，
// 而它才是那个"耗时手工活"——为了一个标量把整池子清掉是本末倒置。
export const SCORE_SCALE_VERSION = 2;

export function loadFactorPoolState() {
  const parsed = readJsonLS(STORAGE_KEY, null);
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.scoreScaleVersion === SCORE_SCALE_VERSION) return parsed;
  // 旧版本（或根本没记版本号的更早存档）：cutoff 不可信，摘掉并打标记
  const { cutoff, ...rest } = parsed;
  return { ...rest, scoreScaleVersion: SCORE_SCALE_VERSION, cutoffScaleStale: Number.isFinite(cutoff) };
}

export function saveFactorPoolState(state) {
  writeJsonLS(STORAGE_KEY, { ...state, scoreScaleVersion: SCORE_SCALE_VERSION });
}

export function clearFactorPoolState() {
  removeLS(STORAGE_KEY);
}
