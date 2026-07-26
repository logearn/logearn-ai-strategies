// 数据切片：把分析出的样本（rows，每条带 buyTimestamp=信号买入时刻，秒）按【本地日历日】切片，
// 再把每一天归类到【基准库 baseline】或【训练集 train】（每策略各一套、互斥）。
// 切片是派生的——不物理拆文件，分析时按天现分；只持久化一张"策略|天 → 类别"的归类表（很轻）。
// 用途：训练集调参、基准库做样本外验证（呼应北极星 ρ 与样本外闸门）。纯函数，不依赖 React/DOM。

const STORAGE_KEY = 'review_slice_categories_v1';
const SEL_KEY = 'review_slice_sel_v1';
const SCOPE_KEY = 'review_slice_scope_v1';

// 上次分析的作用域（策略/文件夹名，混合时 '__all__'）——持久化，启动时据此自动载入"已规划好的
// 训练集/基准库"，不用用户再选批次点分析。
export function loadSliceScope() {
  try { return localStorage.getItem(SCOPE_KEY) || null; } catch { return null; }
}
export function saveSliceScope(key) {
  try { if (key) localStorage.setItem(SCOPE_KEY, key); } catch { /* 隐私模式 */ }
}

export const CATEGORIES = { baseline: '基准库', train: '训练集' };

// 分析范围（切片）选择也持久化——刷新+重新分析后仍停在训练集/基准库，不用每次重选。
export function loadSliceSel() {
  try { const o = JSON.parse(localStorage.getItem(SEL_KEY) || 'null'); return o && typeof o === 'object' && o.mode ? o : { mode: 'all' }; }
  catch { return { mode: 'all' }; }
}
export function saveSliceSel(sel) {
  try { localStorage.setItem(SEL_KEY, JSON.stringify(sel || { mode: 'all' })); } catch { /* 隐私模式 */ }
}
export const UNKNOWN_DAY = '未知';

// 本地日历日 YYYY-MM-DD（跟 backtestReports.localDateStr 同口径，避免 UTC 跨天错位）。
// buyTimestamp 是秒；非有限值返回 null（调用方归到 UNKNOWN_DAY 桶）。
export function dayOf(buyTs) {
  if (buyTs == null || buyTs === '') return null;   // 注意 Number(null)===0（有限），必须先挡掉
  const sec = Number(buyTs);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const d = new Date(sec * 1000);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 按天分组，返回 [{ day, count }]，日期升序（YYYY-MM-DD 字典序=时间序）；'未知' 桶排最后。
export function groupRowsByDay(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const day = dayOf(r && r.buyTimestamp) || UNKNOWN_DAY;
    m.set(day, (m.get(day) || 0) + 1);
  }
  return [...m.entries()].map(([day, count]) => ({ day, count }))
    .sort((a, b) => {
      if (a.day === UNKNOWN_DAY) return 1;
      if (b.day === UNKNOWN_DAY) return -1;
      return a.day < b.day ? -1 : a.day > b.day ? 1 : 0;
    });
}

// 归类表 key：策略名|天。基准库/训练集每策略各一套，就靠 strategyKey 隔离。
export function sliceKeyOf(strategyKey, day) {
  return `${strategyKey == null ? '' : strategyKey}|${day}`;
}

export function loadSliceCategories() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch { return {}; }
}
export function saveSliceCategories(map) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map || {})); } catch { /* 隐私模式 */ }
}

// 某策略某天的类别：'baseline' | 'train' | null（未分配）。
export function categoryOfDay(map, strategyKey, day) {
  const c = map && map[sliceKeyOf(strategyKey, day)];
  return c === 'baseline' || c === 'train' ? c : null;
}

// 归类：把某策略的一批天设为 cat（'baseline'|'train'），cat=null 移出。互斥——一天只一类。返回新 map。
export function assignDays(map, strategyKey, days, cat) {
  const next = { ...(map || {}) };
  for (const day of days || []) {
    if (!day || day === UNKNOWN_DAY) continue;   // 未知日不参与归类
    const k = sliceKeyOf(strategyKey, day);
    if (cat === 'baseline' || cat === 'train') next[k] = cat;
    else delete next[k];
  }
  return next;
}

// 天在闭区间 [start,end] 内（留空=该侧不限）。YYYY-MM-DD 字典序即时间序。未知日永不入区间。
export function dayInRange(day, start, end) {
  if (!day || day === UNKNOWN_DAY) return false;
  if (start && day < start) return false;
  if (end && day > end) return false;
  return true;
}

// 区间覆盖到的天（只从 rows 现有的天里筛，不凭空造）。
export function daysInRange(rows, start, end) {
  return groupRowsByDay(rows).map(g => g.day).filter(day => dayInRange(day, start, end));
}

// 按切片选行。sel:
//   {mode:'all'}                       全部
//   {mode:'baseline'|'train'}          该类别下所有天的样本
//   {mode:'day', day}                  某一天
//   {mode:'range', start, end}         自定义区间
export function selectRowsBySlice(rows, strategyKey, map, sel) {
  const rs = rows || [];
  if (!sel || sel.mode === 'all') return rs;
  const dOf = (r) => dayOf(r && r.buyTimestamp) || UNKNOWN_DAY;
  if (sel.mode === 'day') return rs.filter(r => dOf(r) === sel.day);
  if (sel.mode === 'range') return rs.filter(r => dayInRange(dOf(r), sel.start, sel.end));
  if (sel.mode === 'baseline' || sel.mode === 'train') return rs.filter(r => categoryOfDay(map, strategyKey, dOf(r)) === sel.mode);
  return rs;
}

// 切片表 + 汇总：每天带类别；tally 汇总各类别的天数/样本数。
export function summarizeSlices(rows, strategyKey, map) {
  const days = groupRowsByDay(rows).map(g => ({ ...g, category: categoryOfDay(map, strategyKey, g.day) }));
  const tally = { baseline: { days: 0, count: 0 }, train: { days: 0, count: 0 }, unassigned: { days: 0, count: 0 } };
  for (const d of days) {
    const bucket = d.category || 'unassigned';
    tally[bucket].days++; tally[bucket].count += d.count;
  }
  return { days, tally };
}
