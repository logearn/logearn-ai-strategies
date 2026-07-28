// 因子池进度持久化：因子发现是个耗时的手工过程（扫描+勾选+调权重），跟阵营库/已删因子/字段排除
// 一样值得跨会话保留——之前只存在纯内存 state 里，刷新页面或不小心关掉标签页就得从头再来。
// 只存"最终产物"（因子池本身 + 几个标量参数），不存 scanHero/scanEvil/selectedHero/selectedEvil
// 这类跟当次扫描强绑定的中间结果——它们体积大且离开原数据集就可能失真，重新点一次「扫描」比
// 恢复一份可能过期的候选表更可靠；因子池 factors 是手工编辑/勾选后的结果，语义上更稳定值得保留。

const STORAGE_KEY = 'chart_factor_pool_v1';

export function loadFactorPoolState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

export function saveFactorPoolState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* 隐私模式 */ }
}

export function clearFactorPoolState() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* 隐私模式 */ }
}
