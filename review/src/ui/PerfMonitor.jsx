import React, { useEffect, useRef, useState } from 'react';
import { downloadText, downloadJson } from '../lib/download.js';

// 固定在页面最下方的轻量性能监控条：FPS + JS堆内存 + 主线程长任务(>50ms)记录。
// 动机：因子推荐1去掉 candLimit=50 截断后贪心搜索变重，"删除因子后自动重算"这个隐藏逻辑在
// 主线程跑起来冻住了整个页面，用户反馈"点删除很卡"——当时只能靠读代码猜哪里卡。这个监控条
// 直接把"主线程被谁卡住了多久"摆出来，下次再出现类似的卡顿，点开长任务记录表就能看到具体
// 时间点和耗时，不用再靠猜。
// longtask 这个 PerformanceObserver entryType 目前只有 Chromium 系浏览器支持（Safari/Firefox
// 不支持），不支持时静默降级——只显示 FPS，不假装有长任务数据。
const MAX_LOG = 30;

const exportBtnStyle = {
  background: 'rgba(255,255,255,.08)', color: '#eee', border: '1px solid rgba(255,255,255,.18)',
  borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer',
  fontFamily: 'inherit',
};

export default function PerfMonitor() {
  const [fps, setFps] = useState(null); // null = 还没测出第一个数
  const [longTasks, setLongTasks] = useState([]); // [{ time, duration }]，time = Date.now()
  const [memory, setMemory] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [supported, setSupported] = useState(true);
  const [tabHidden, setTabHidden] = useState(document.hidden);
  const frameRef = useRef({ count: 0, last: performance.now() });

  // 标签页切到后台时 requestAnimationFrame 会被浏览器整个暂停（这是浏览器省电的正常行为，
  // 不是卡顿）——不加这个判断的话，切回来会看到一个长期没更新、看着像卡死的 FPS 数字。
  useEffect(() => {
    const onVis = () => setTabHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // FPS：每秒读一次 requestAnimationFrame 的实际触发次数。
  useEffect(() => {
    let raf;
    const loop = now => {
      const f = frameRef.current;
      f.count += 1;
      const elapsed = now - f.last;
      if (elapsed >= 1000) {
        setFps(Math.round((f.count * 1000) / elapsed));
        f.count = 0;
        f.last = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 主线程长任务：浏览器原生 longtask entry，阈值固定 50ms（浏览器内部定的，改不了）。
  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined'
      || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      setSupported(false);
      return;
    }
    let obs;
    try {
      obs = new PerformanceObserver(list => {
        const entries = list.getEntries();
        if (!entries.length) return;
        setLongTasks(prev => [...prev, ...entries.map(e => ({ time: Date.now(), duration: e.duration }))].slice(-MAX_LOG));
      });
      obs.observe({ entryTypes: ['longtask'] });
    } catch { setSupported(false); }
    return () => obs?.disconnect();
  }, []);

  // JS 堆内存：performance.memory 是非标准 API，只有 Chromium 系浏览器有，其它浏览器上这个
  // effect 直接不生效（memory 保持 null，UI 上对应字段就不显示）。
  useEffect(() => {
    if (!performance.memory) return;
    const timer = setInterval(() => {
      const m = performance.memory;
      setMemory({ used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit });
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  const fmtMB = b => (b / 1048576).toFixed(0) + 'MB';
  const fpsColor = !Number.isFinite(fps) ? '#8e8e93' : fps >= 50 ? '#30d158' : fps >= 30 ? '#ff9f0a' : '#ff453a';
  const now = Date.now();
  const recent = longTasks.filter(t => now - t.time < 10000);
  const worstRecent = recent.reduce((m, t) => Math.max(m, t.duration), 0);

  // 把当前长任务记录 + FPS/堆内存快照导出成文件。fmt='csv' 直接丢表格；fmt='json' 保留完整快照。
  // longtask 只保留最近 MAX_LOG 条（滚动窗口），所以导出的是"当前还留在记录里的"，不是开页至今的全量。
  const exportLog = fmt => {
    const stamp = new Date();
    const pad = n => String(n).padStart(2, '0');
    const fname = `perf-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.${fmt}`;
    if (fmt === 'csv') {
      const rows = [['time', 'duration_ms'],
        ...longTasks.map(t => [new Date(t.time).toISOString(), t.duration.toFixed(1)])];
      downloadText('﻿' + rows.map(r => r.join(',')).join('\n'), fname, 'text/csv;charset=utf-8');
    } else {
      const payload = {
        exportedAt: stamp.toISOString(),
        fps, memory,
        recentWindowMs: 10000, recentCount: recent.length, worstRecentMs: worstRecent,
        longTasks: longTasks.map(t => ({ time: new Date(t.time).toISOString(), durationMs: t.duration })),
      };
      downloadJson(payload, fname);
    }
  };

  return (
    <div style={{
      position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 999,
      background: 'rgba(20,20,24,.92)', color: '#eee', fontSize: 11,
      borderTop: '1px solid rgba(255,255,255,.12)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      backdropFilter: 'blur(4px)', userSelect: 'none',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '4px 12px', cursor: 'pointer' }}
        onClick={() => setExpanded(v => !v)}>
        <span style={{ opacity: .7 }}>性能监控 {expanded ? '▾' : '▸'}</span>
        <span style={{ color: fpsColor }}>FPS {tabHidden ? '(标签页在后台)' : (fps ?? '测量中…')}</span>
        {memory && <span style={{ opacity: .85 }}>堆内存 {fmtMB(memory.used)} / {fmtMB(memory.limit)}</span>}
        {supported ? (
          <span style={{ color: recent.length > 0 ? '#ff9f0a' : '#8e8e93' }}>
            最近10s主线程长任务 {recent.length} 次{worstRecent > 0 ? `（最长 ${worstRecent.toFixed(0)}ms）` : ''}
          </span>
        ) : (
          <span style={{ color: '#8e8e93' }}>（当前浏览器不支持长任务监测，仅 Chromium 系可用）</span>
        )}
      </div>
      {expanded && (
        <div style={{ maxHeight: 180, overflowY: 'auto', padding: '0 12px 8px', borderTop: '1px solid rgba(255,255,255,.08)' }}>
          {!supported ? (
            <div style={{ padding: '6px 0', color: '#8e8e93' }}>这个浏览器没有 longtask 监测能力，换 Chrome/Edge 能看到具体是哪次操作卡住了主线程。</div>
          ) : longTasks.length === 0 ? (
            <div style={{ padding: '6px 0', color: '#8e8e93' }}>暂无超过 50ms 的主线程长任务——目前不卡。</div>
          ) : (
            <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 6 }}>
              <button onClick={() => exportLog('csv')} style={exportBtnStyle}>导出 CSV</button>
              <button onClick={() => exportLog('json')} style={exportBtnStyle}>导出 JSON</button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4 }}>
              <thead>
                <tr style={{ color: '#8e8e93', textAlign: 'left' }}>
                  <th style={{ padding: '2px 8px 2px 0', fontWeight: 400 }}>时间</th>
                  <th style={{ fontWeight: 400 }}>阻塞主线程耗时</th>
                </tr>
              </thead>
              <tbody>
                {longTasks.slice().reverse().map((t, i) => (
                  <tr key={i}>
                    <td style={{ padding: '1px 8px 1px 0', color: '#8e8e93' }}>{new Date(t.time).toLocaleTimeString()}</td>
                    <td style={{ color: t.duration > 200 ? '#ff453a' : '#ff9f0a' }}>{t.duration.toFixed(0)}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
