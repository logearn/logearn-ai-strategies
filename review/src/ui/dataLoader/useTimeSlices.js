import { useEffect, useMemo, useRef, useState, startTransition } from 'react';
import { message } from 'antd';
import { buildRows } from '../../lib/data.js';
import { mergeDaily } from '../../lib/mergeDaily.js';
import { groupKeyOf } from '../../lib/dataArchive.js';
import { loadSliceCategories, saveSliceCategories, assignDays, dayInRange,
         selectRowsBySlice, summarizeSlices, CATEGORIES, loadSliceSel, saveSliceSel,
         loadSliceScope, saveSliceScope, dayOf, strategyOf, sliceKeyOf,
         loadDeletedDays, saveDeletedDays, filterDeletedRows } from '../../lib/dataSlices.js';

// 时间切片：从 DataLoader.jsx 抽出的第二块状态（2026-07-29，拆"上帝组件"第四步收尾）——
// 归类以策略名为第一层维度（跟数据源管理归档树一个口径）。sliceCats/summarizeSlices/
// selectRowsBySlice 都按样本自带的 strategyName 走，不需要靠 sliceKey 去区分——sliceKey
// 只用来记"上次分析选了哪个作用域"，供批次就绪后自动重新载入用。
//
// 跟 useArchiveManager 不同的一点：这个 hook 不是零依赖的——`autoLoad` 要用归档管理那边的
// `batches`/`store` 自动载入已存数据，`emitRows`（分析完成后的收尾）也是唯一一个真正被外部
// （DataLoader.jsx 的 analyze()，上传解析概念）调用的函数，所以对外暴露；autoLoad 本身只在
// 这个 hook 内部的"批次就绪后自动载入一次"的 effect 里被调用，不对外暴露。onBusyChange 是
// autoLoad 唯一需要的第三个跨概念回调——「分析」按钮的 loading 态（busy/setBusy）是上传解析
// 概念的状态，留在 DataLoader.jsx，autoLoad 通过这个回调借用它，不重复造一套 loading 状态。
export function useTimeSlices({ batches, store, onRows, onArchiveChange, onStatus, onBusyChange }) {
  const [allRows, setAllRows] = useState([]);              // 上次分析出的全量样本（切片从它现分）
  const [sliceKey, setSliceKey] = useState('__all__');     // 切片作用域（策略名；混合时 __all__）
  const [sliceCats, setSliceCats] = useState(loadSliceCategories); // 天→类别 归类表（持久化）
  const [sliceSel, setSliceSel] = useState(loadSliceSel); // 当前分析范围（切片，持久化）
  const [sliceSelectedDays, setSliceSelectedDays] = useState([]); // 切片表勾选的天
  const [deletedDays, setDeletedDays] = useState(loadDeletedDays); // 已持久删除的【策略×天】名单
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');

  // allRows/sliceCats（全量样本 + 天→类别归类表）本来只在 DataLoader 内部用——FactorLab 想做
  // "基线库整体 vs 训练集按天" 对比，需要不受当前 sliceSel（分析范围）影响、独立拿到这两样东西。
  // 用一个 effect 统一往上抛，比在每个 setAllRows/setSliceCats 调用点都手动通知一遍更不容易漏。
  useEffect(() => {
    if (typeof onArchiveChange === 'function') onArchiveChange({ allRows, sliceCats });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows, sliceCats]);

  // 分析/自动载入的共同收尾：留住全量样本、记作用域、恢复上次的分析范围（切片）、把切好片的样本发下游。
  // 先过滤掉持久删除名单里的【策略×天】——不然刷新页面/重新点「分析」会从存储读回全量数据，
  // 删过的天又出现了。
  function emitRows(rawRows, key) {
    const rows = filterDeletedRows(rawRows, deletedDays);
    setAllRows(rows);
    setSliceKey(key); saveSliceScope(key);
    let sel = loadSliceSel();
    if (sel.mode === 'day') {
      const stillValid = rows.some(r => strategyOf(r) === sel.strategyName && (dayOf(r.buyTimestamp) || '未知') === sel.day);
      if (!stillValid) sel = { mode: 'all' };
    }
    setSliceSel(sel); saveSliceSel(sel); setSliceSelectedDays([]);
    onRows(selectRowsBySlice(rows, sliceCats, sel));
  }
  // 启动自动载入"上次规划好的训练集/基准库"——不用再选批次点分析。只读已存批次，不碰上传/入库。
  const autoLoadedRef = useRef(false);
  async function autoLoad(scope) {
    const ids = scope === '__all__'
      ? new Set(batches.map(b => b.id))
      : new Set(batches.filter(b => groupKeyOf(b) === scope).map(b => b.id));
    if (!ids.size) return;
    onBusyChange?.(true);
    try {
      const saved = await store.loadAllData({ ids });
      const merged = mergeDaily(saved.callsArrays, saved.snapsArrays);
      const rows = await buildRows(merged.calls, merged.snapshots);
      emitRows(rows, scope);
      onStatus?.({ type: 'success', text: `已自动载入「${scope === '__all__' ? '全部' : scope}」的训练集/基准库：${rows.length} 条样本（如需纳入新数据源，选文件后点「分析」）` });
    } catch (e) {
      onStatus?.({ type: 'warning', text: '自动载入失败，请手动点「分析」：' + (e?.message || e) });
    } finally { onBusyChange?.(false); }
  }
  // 批次就绪后自动载入一次上次的作用域（仅一次；用户手动分析过就不再自动覆盖）
  useEffect(() => {
    if (autoLoadedRef.current || allRows.length || !batches.length) return;
    const scope = loadSliceScope();
    if (!scope) return;
    autoLoadedRef.current = true;
    autoLoad(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches]);

  const sliceSummary = useMemo(() => summarizeSlices(allRows, sliceCats), [allRows, sliceCats]);
  // 归类树：策略 → 天，供 Table 的 children 展开（跟数据源管理归档树同一个交互套路）。
  const sliceTreeData = useMemo(() => sliceSummary.strategies.map(s => ({
    key: 'st::' + s.strategyName, rowType: 'strategy', strategyName: s.strategyName, count: s.count, tally: s.tally,
    daysAll: s.days.filter(d => d.day !== '未知').map(d => d.day),
    children: s.days.length ? s.days.map(d => ({
      key: `dy::${s.strategyName}::${d.day}`, rowType: 'day', strategyName: s.strategyName, day: d.day, count: d.count, category: d.category,
    })) : undefined,
  })), [sliceSummary]);
  // key → {strategyName, day} 查表：勾选框返回的是 key 数组，批量操作要靠它还原成实际的"策略+天"。
  const dayKeyMap = useMemo(() => {
    const m = new Map();
    for (const s of sliceTreeData) for (const c of (s.children || [])) m.set(c.key, { strategyName: c.strategyName, day: c.day });
    return m;
  }, [sliceTreeData]);
  // 把 selectedRowKeys（可能混着策略行/天行的 key）归并成 Map<策略名, 天[]>，只取天行——
  // 策略行的 key 本身不代表任何实际数据，checkStrictly=false 时它会跟着子节点一起出现在数组里。
  function daysFromKeys(keys) {
    const out = new Map();
    for (const k of keys || []) {
      const info = dayKeyMap.get(k);
      if (!info) continue;
      if (!out.has(info.strategyName)) out.set(info.strategyName, []);
      out.get(info.strategyName).push(info.day);
    }
    return out;
  }
  const rowsOfKeys = (keys) => {
    const grouped = daysFromKeys(keys);
    if (!grouped.size) return [];
    return allRows.filter(r => (grouped.get(strategyOf(r)) || []).includes(dayOf(r.buyTimestamp) || '未知'));
  };
  // 归类某策略的一批天到某类别（cat=null 移出）；改完立刻按当前分析范围重过滤重发。
  function assignSliceDays(strategyName, days, cat) {
    if (!days.length) return;
    const next = assignDays(sliceCats, strategyName, days, cat);
    setSliceCats(next); saveSliceCategories(next); setSliceSelectedDays([]);
    startTransition(() => onRows(selectRowsBySlice(allRows, next, sliceSel)));
    const label = cat ? CATEGORIES[cat] : '未分配';
    message.success(`已把「${strategyName}」${days.length} 天转入「${label}」`);
  }
  // 勾选框里的天可能跨多个策略——按策略分组后逐个调用 assignDays，一次性提交一份新归类表。
  function assignSelectedDays(cat) {
    const grouped = daysFromKeys(sliceSelectedDays);
    if (!grouped.size) return;
    let next = sliceCats, totalDays = 0;
    for (const [strategyName, days] of grouped) { next = assignDays(next, strategyName, days, cat); totalDays += days.length; }
    setSliceCats(next); saveSliceCategories(next); setSliceSelectedDays([]);
    startTransition(() => onRows(selectRowsBySlice(allRows, next, sliceSel)));
    message.success(`已把 ${totalDays} 天转入「${cat ? CATEGORIES[cat] : '未分配'}」`);
  }
  // 彻底删除某策略某几天的样本（跟"移出"不同——移出只是取消基准库/训练集归类，样本还在；这个是从
  // allRows 里拿掉，n 会变小）。常见场景：某天数据明显异常（比如批次重复导入、抓取出错）。
  // 不动底层已存批次/数据库本身（那份文件原样留着），但会把这几天记进持久化的删除名单——
  // 刷新页面/重新点「分析」/自动载入都会用这份名单继续过滤，不会再自己冒出来，除非手动「恢复」。
  function deleteDays(strategyName, days) {
    if (!days.length) return;
    const match = r => strategyOf(r) === strategyName && days.includes(dayOf(r.buyTimestamp) || '未知');
    const dropped = allRows.filter(match).length;
    const kept = allRows.filter(r => !match(r));
    setAllRows(kept);
    const next = assignDays(sliceCats, strategyName, days, null);
    setSliceCats(next); saveSliceCategories(next); setSliceSelectedDays([]);
    const nextDeleted = [...new Set([...deletedDays, ...days.map(d => sliceKeyOf(strategyName, d))])];
    setDeletedDays(nextDeleted); saveDeletedDays(nextDeleted);
    startTransition(() => onRows(selectRowsBySlice(kept, next, sliceSel)));
    message.success(`已删除「${strategyName}」${days.length} 天共 ${dropped} 条样本`);
  }
  // 勾选框里跨策略的批量删除，同 assignSelectedDays 按策略分组逐个处理。
  function deleteSelectedDays() {
    const grouped = daysFromKeys(sliceSelectedDays);
    if (!grouped.size) return;
    let kept = allRows, next = sliceCats, totalDropped = 0, totalDays = 0;
    const newDeletedKeys = [];
    for (const [strategyName, days] of grouped) {
      const match = r => strategyOf(r) === strategyName && days.includes(dayOf(r.buyTimestamp) || '未知');
      totalDropped += kept.filter(match).length;
      kept = kept.filter(r => !match(r));
      next = assignDays(next, strategyName, days, null);
      totalDays += days.length;
      newDeletedKeys.push(...days.map(d => sliceKeyOf(strategyName, d)));
    }
    setAllRows(kept); setSliceCats(next); saveSliceCategories(next); setSliceSelectedDays([]);
    const nextDeleted = [...new Set([...deletedDays, ...newDeletedKeys])];
    setDeletedDays(nextDeleted); saveDeletedDays(nextDeleted);
    startTransition(() => onRows(selectRowsBySlice(kept, next, sliceSel)));
    message.success(`已删除 ${totalDays} 天共 ${totalDropped} 条样本`);
  }
  // 恢复一条已删除的【策略×天】：从删除名单移出即可——底层数据一直都在，下次自动载入/重新
  // 分析该策略批次时就会自然把它带回来（不用在这里手动拼回 allRows，避免拼出跟真实存储不一致的数据）。
  function restoreDeletedDay(key) {
    const next = deletedDays.filter(k => k !== key);
    setDeletedDays(next); saveDeletedDays(next);
    message.info('已从删除名单移出，重新点「分析」或重新载入对应数据源即可恢复这天的样本');
  }
  // 区间归类：跨策略——按每个策略自己的天集合分别截取落在区间内的部分再归类。
  function assignRange(cat) {
    const start = rangeStart.trim(), end = rangeEnd.trim();
    let next = sliceCats, totalDays = 0;
    for (const s of sliceSummary.strategies) {
      const days = s.days.map(d => d.day).filter(d => dayInRange(d, start, end));
      if (!days.length) continue;
      next = assignDays(next, s.strategyName, days, cat);
      totalDays += days.length;
    }
    if (!totalDays) { message.warning('该区间内没有样本天'); return; }
    setSliceCats(next); saveSliceCategories(next); setSliceSelectedDays([]);
    startTransition(() => onRows(selectRowsBySlice(allRows, next, sliceSel)));
    message.success(`已把区间内共 ${totalDays} 天转入「${CATEGORIES[cat]}」`);
  }
  // 一键把【当前工作集里所有策略的所有天】归到某类（跨分页，不用逐天勾）。数据少的阶段：全部先进训练集。
  function assignAllDays(cat) {
    let next = sliceCats, totalDays = 0;
    for (const s of sliceSummary.strategies) {
      if (!s.daysAll?.length) continue;
      next = assignDays(next, s.strategyName, s.daysAll, cat);
      totalDays += s.daysAll.length;
    }
    if (!totalDays) return;
    setSliceCats(next); saveSliceCategories(next); setSliceSelectedDays([]);
    startTransition(() => onRows(selectRowsBySlice(allRows, next, sliceSel)));
    message.success(`已把全部 ${totalDays} 天转入「${CATEGORIES[cat]}」`);
  }
  // 切换分析范围（切片）→ 清掉逐天勾选（下拉优先）、持久化、重新过滤重发
  function changeSliceSel(sel) {
    setSliceSel(sel); saveSliceSel(sel); setSliceSelectedDays([]);
    startTransition(() => onRows(selectRowsBySlice(allRows, sliceCats, sel)));
  }
  // 勾选表里的天 = 分析就用这些天（总览/下游立即跟着变）；取消全部勾选则回到「分析范围」下拉的口径。
  // 勾选同时也是"批量归类"的选择对象（下方转入基准库/训练集按钮用的就是它）。
  function selectDays(keys) {
    // 勾选框本身要秒响应；下游联动（App 里 setRows/setActiveRows 会牵出 FactorLab 等一大串重算）
    // 用 startTransition 标成低优先级，浏览器先把这次勾选的视觉反馈画出来，重算不阻塞连续点击。
    setSliceSelectedDays(keys);
    startTransition(() => onRows(keys.length ? rowsOfKeys(keys) : selectRowsBySlice(allRows, sliceCats, sliceSel)));
  }
  // 当前实际分析的样本数：勾了天就按勾选，否则按分析范围下拉
  const effectiveCount = sliceSelectedDays.length
    ? rowsOfKeys(sliceSelectedDays).length
    : selectRowsBySlice(allRows, sliceCats, sliceSel).length;

  return {
    allRows, sliceSel, sliceSelectedDays, setSliceSelectedDays, deletedDays,
    rangeStart, setRangeStart, rangeEnd, setRangeEnd,
    sliceSummary, sliceTreeData, effectiveCount,
    emitRows,
    assignSliceDays, assignSelectedDays, deleteDays, deleteSelectedDays,
    restoreDeletedDay, assignRange, assignAllDays, changeSliceSel, selectDays,
  };
}
