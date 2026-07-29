// 待办清单：手动记的自由待办 + 自动生成的"这天有数据但还没存回测报告"提醒。
// 自动提醒不落库——每次都是拿"已上传的数据批次日期"跟"已存档的报告日期"现算差集，
// 数据/报告一旦补上，提醒自然消失，不需要额外维护一份"已完成"状态。
// 忽略清单单独落库：某天确实不打算补（比如那批数据本来就是坏的），忽略一次以后
// 不用每次打开都看到同一条提醒；忽略是按日期记的，不是"删除"，随时能撤销。

import { readJsonLS, writeJsonLS } from './localStorageStore.js';

const TODO_KEY = 'chart_todo_list_v1';
const IGNORED_DATES_KEY = 'chart_todo_ignored_dates_v1';

export function loadTodos() {
  const arr = readJsonLS(TODO_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

export function saveTodos(list) {
  writeJsonLS(TODO_KEY, list);
}

export function addTodo(list, text) {
  const trimmed = String(text).trim();
  if (!trimmed) return list;
  const item = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    text: trimmed,
    done: false,
    createdAt: Date.now(),
  };
  return [item, ...list];
}

export function toggleTodo(list, id) {
  return list.map(t => (t.id === id ? { ...t, done: !t.done } : t));
}

export function removeTodo(list, id) {
  return list.filter(t => t.id !== id);
}

export function loadIgnoredDates() {
  const arr = readJsonLS(IGNORED_DATES_KEY, []);
  return Array.isArray(arr) ? arr : [];
}

export function saveIgnoredDates(list) {
  writeJsonLS(IGNORED_DATES_KEY, list);
}

export function ignoreDate(list, date) {
  return list.includes(date) ? list : [...list, date];
}

export function unignoreDate(list, date) {
  return list.filter(d => d !== date);
}

// 差集：数据批次的日期（从 batchMetas[].addedAt 派生的本地日历日）里，
// 哪些还没有一份同日期的回测报告存档，且没被手动忽略。按日期升序返回。
export function findMissingReportDates(batchMetas, reportDates, ignoredDates = []) {
  const reportSet = new Set(reportDates);
  const ignoredSet = new Set(ignoredDates);
  const batchDateSet = new Set(
    batchMetas
      .filter(m => Number.isFinite(m.addedAt))
      .map(m => {
        const d = new Date(m.addedAt);
        const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
        return `${y}-${mo}-${day}`;
      })
  );
  return [...batchDateSet].filter(d => !reportSet.has(d) && !ignoredSet.has(d)).sort();
}
