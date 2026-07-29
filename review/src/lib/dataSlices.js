// 数据切片：把分析出的样本（rows，每条带 buyTimestamp=信号买入时刻，秒）按【本地日历日】切片，
// 再把每一天归类到【基准库 baseline】或【训练集 train】（每策略各一套、互斥）。
// 切片是派生的——不物理拆文件，分析时按天现分；只持久化一张"策略|天 → 类别"的归类表（很轻）。
// 用途：训练集调参、基准库做样本外验证（呼应北极星与样本外闸门——默认口径是 ρ，筛垃圾类策略例外看分层增益）。纯函数，不依赖 React/DOM。
// 归类以【策略名】为第一层维度（跟数据源管理的归档树一个口径）——同一批分析可能混了多个策略的
// 样本，每条样本自带 strategyName，切片/归类/分析范围一律按样本自己的策略走，不看分析时的批次
// 选择范围（那只决定了"这次分析纳入哪些数据"，不代表数据本身只属于一个策略）。
import { UNNAMED } from './dataArchive.js';
import { readJsonLS, writeJsonLS, readRawLS, writeRawLS } from './localStorageStore.js';

const STORAGE_KEY = 'review_slice_categories_v1';
const SEL_KEY = 'review_slice_sel_v1';
const SCOPE_KEY = 'review_slice_scope_v1';
const DELETED_KEY = 'review_slice_deleted_v1';

// 上次分析的作用域（策略/文件夹名，混合时 '__all__'）——持久化，启动时据此自动载入"已规划好的
// 训练集/基准库"，不用用户再选批次点分析。
export function loadSliceScope() {
  return readRawLS(SCOPE_KEY, null);
}
export function saveSliceScope(key) {
  if (key) writeRawLS(SCOPE_KEY, key);
}

export const CATEGORIES = { baseline: '基准库', train: '训练集' };

// 分析范围（切片）选择也持久化——刷新+重新分析后仍停在训练集/基准库，不用每次重选。
// 默认 mode:'none'（未选择）——这个管道以切片的基准库/训练集为主体，没显式选过分析范围时
// 不该悄悄把"全部"（含未分配、未决定训练/基准的原始数据）喂给下游，逼用户先做一次选择。
export function loadSliceSel() {
  const o = readJsonLS(SEL_KEY, null);
  return o && typeof o === 'object' && o.mode ? o : { mode: 'none' };
}
export function saveSliceSel(sel) {
  writeJsonLS(SEL_KEY, sel || { mode: 'none' });
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

// 样本所属策略名——跟 dataArchive.groupKeyOf 一个兜底口径（没有就是"未命名策略"），
// 保证时间切片的分组名和数据源管理树的分组名对得上。
export function strategyOf(row) {
  const s = row && row.strategyName;
  return (s != null && String(s).trim() !== '') ? String(s) : UNNAMED;
}

// 按【策略名 → 天】两级分组，供时间切片表渲染成跟数据源管理一样的归档树。
// 返回 [{ strategyName, count, days: [{day, count}] }]，策略按样本数降序，天按日期升序。
export function groupRowsByStrategyAndDay(rows) {
  const byStrategy = new Map();
  for (const r of rows || []) {
    const sName = strategyOf(r);
    const day = dayOf(r && r.buyTimestamp) || UNKNOWN_DAY;
    if (!byStrategy.has(sName)) byStrategy.set(sName, new Map());
    const dayMap = byStrategy.get(sName);
    dayMap.set(day, (dayMap.get(day) || 0) + 1);
  }
  const groups = [...byStrategy.entries()].map(([strategyName, dayMap]) => {
    const days = [...dayMap.entries()].map(([day, count]) => ({ day, count }))
      .sort((a, b) => {
        if (a.day === UNKNOWN_DAY) return 1;
        if (b.day === UNKNOWN_DAY) return -1;
        return a.day < b.day ? -1 : a.day > b.day ? 1 : 0;
      });
    return { strategyName, count: days.reduce((s, d) => s + d.count, 0), days };
  });
  return groups.sort((a, b) => b.count - a.count);
}

// 归类表 key：策略名|天。基准库/训练集每策略各一套，就靠 strategyKey 隔离。
export function sliceKeyOf(strategyKey, day) {
  return `${strategyKey == null ? '' : strategyKey}|${day}`;
}

export function loadSliceCategories() {
  const o = readJsonLS(STORAGE_KEY, {});
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
}
export function saveSliceCategories(map) {
  writeJsonLS(STORAGE_KEY, map || {});
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

// 已删除的【策略×天】名单（持久化，key 格式同 sliceKeyOf）——"删除"默认只是从当次分析结果里
// 拿掉，不动底层已存批次；不持久化的话，刷新页面/重新点「分析」会重新从存储读全量数据，
// 删掉的天又会回来。这份名单让重新分析/自动载入也能一直把它们过滤掉，直到手动恢复。
export function loadDeletedDays() {
  const arr = readJsonLS(DELETED_KEY, []);
  return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
}
export function saveDeletedDays(list) {
  writeJsonLS(DELETED_KEY, list || []);
}

// 按已删除名单过滤样本——每条样本按自己的 strategyOf/dayOf 算 key，命中就剔除。
export function filterDeletedRows(rows, deletedList) {
  if (!deletedList || !deletedList.length) return rows || [];
  const set = new Set(deletedList);
  return (rows || []).filter(r => !set.has(sliceKeyOf(strategyOf(r), dayOf(r && r.buyTimestamp) || UNKNOWN_DAY)));
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

// 按切片选行。策略维度按样本自带的 strategyOf(r) 判定，不需要调用方传全局策略作用域。sel:
//   {mode:'none'}                             未选择——不出数据（逼用户先选一个分析范围）
//   {mode:'all'}                              全部
//   {mode:'baseline'|'train'}                 该类别下所有【策略×天】组合的样本
//   {mode:'day', day, strategyName?}          某一天（给了 strategyName 就只要该策略这天的）
//   {mode:'range', start, end}                自定义区间（跨策略，纯按日历日筛）
export function selectRowsBySlice(rows, map, sel) {
  const rs = rows || [];
  if (!sel || sel.mode === 'none') return [];
  if (sel.mode === 'all') return rs;
  const dOf = (r) => dayOf(r && r.buyTimestamp) || UNKNOWN_DAY;
  if (sel.mode === 'day') return rs.filter(r => dOf(r) === sel.day && (!sel.strategyName || strategyOf(r) === sel.strategyName));
  if (sel.mode === 'range') return rs.filter(r => dayInRange(dOf(r), sel.start, sel.end));
  if (sel.mode === 'baseline' || sel.mode === 'train') return rs.filter(r => categoryOfDay(map, strategyOf(r), dOf(r)) === sel.mode);
  return rs;
}

// 切片表 + 汇总：先按策略分组（跟数据源管理归档树一个口径），每组下每天带类别；
// 每组自己的 tally + 全局汇总 tally 都给，界面既能看整体也能看单策略进度。
export function summarizeSlices(rows, map) {
  const groups = groupRowsByStrategyAndDay(rows);
  const tally = { baseline: { days: 0, count: 0 }, train: { days: 0, count: 0 }, unassigned: { days: 0, count: 0 } };
  const strategies = groups.map(g => {
    const sTally = { baseline: { days: 0, count: 0 }, train: { days: 0, count: 0 }, unassigned: { days: 0, count: 0 } };
    const days = g.days.map(d => {
      const category = categoryOfDay(map, g.strategyName, d.day);
      const bucket = category || 'unassigned';
      sTally[bucket].days++; sTally[bucket].count += d.count;
      tally[bucket].days++; tally[bucket].count += d.count;
      return { ...d, category };
    });
    return { strategyName: g.strategyName, count: g.count, days, tally: sTally };
  });
  return { strategies, tally };
}
