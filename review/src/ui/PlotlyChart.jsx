import React, { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';

// Plotly 的 React 封装。这里有一个必须踩过才知道的坑：
//
// Plotly 2.27 的 newPlot 会把 gd 上已注册的事件监听器【全部清空】
// （实测：绑定后 gd._ev._events.plotly_click 长度 1 → 再次 newPlot 后变成 0）。
// 旧版曾用一个 __clickBound 标记做"只绑一次"，前提就是"newPlot 不会清监听器"——这是错的。
// 后果是：图首次渲染能点开，之后任何一次重绘（切对数轴/剔除离群点/交换 XY）都会清掉监听器，
// 而标记还是 true 不再重绑，这张图就永久点不开了。
//
// 所以这里每次 newPlot 之后都重新绑定，并且先 removeAllListeners 防止累积。
function PlotlyChart({ traces, layout, onPointClick, height = 520 }, ref) {
  const divRef = useRef(null);
  const clickRef = useRef(onPointClick);
  clickRef.current = onPointClick;   // 用 ref 持有回调，避免回调变化触发整图重绘

  useEffect(() => {
    const gd = divRef.current;
    if (!gd || !window.Plotly) return;
    let cancelled = false;
    window.Plotly.newPlot(gd, traces, layout, { responsive: true })
      .catch(err => {
        // 某些数据分布（X 全同值、对数轴遇到 <=0 等）会让 newPlot 内部抛错并 reject。
        // 旧版这里没有 catch，一旦命中就再也不会走到下面的绑定，图看起来画出来了但永远点不开，
        // 而且控制台之外没有任何线索。
        console.error('Plotly 渲染异常，仍尝试绑定点击事件：', err);
      })
      .then(() => {
        if (cancelled || !gd.on) return;
        gd.removeAllListeners && gd.removeAllListeners('plotly_click');
        gd.on('plotly_click', ev => {
          const pt = ev && ev.points && ev.points[0];
          const ca = pt && pt.customdata;
          if (ca && clickRef.current) clickRef.current(ca, pt);
        });
      });
    return () => { cancelled = true; };
  }, [traces, layout]);

  useEffect(() => {
    const gd = divRef.current;
    return () => { if (gd && window.Plotly) window.Plotly.purge(gd); };
  }, []);

  // 导出 PNG。useLightBg 时临时把背景/字体切成浅色再导出，导出后无论成败都切回去——
  // 深色图贴进白底文档会不协调，但页面上展示的图不该被改。
  useImperativeHandle(ref, () => ({
    async exportPng(filename, useLightBg) {
      const gd = divRef.current;
      if (!gd || !gd.querySelector('.main-svg')) throw new Error('该图表还没有渲染，无法导出');
      let prev = null;
      if (useLightBg) {
        const l = gd.layout || {};
        prev = { paper_bgcolor: l.paper_bgcolor, plot_bgcolor: l.plot_bgcolor,
                 'font.color': l.font ? l.font.color : undefined };
        try { await window.Plotly.relayout(gd, { paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff', 'font.color': '#1d1d1f' }); } catch { /* 忽略 */ }
      }
      try {
        const dataUrl = await window.Plotly.toImage(gd, {
          format: 'png',
          width: Math.max(600, gd.clientWidth || 900),
          height: Math.max(400, gd.clientHeight || 480),
          scale: 2,
        });
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `${(filename || 'chart').replace(/[\\/:*?"<>|]/g, '_')}.png`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
      } finally {
        if (useLightBg && prev) { try { await window.Plotly.relayout(gd, prev); } catch { /* 忽略 */ } }
      }
    },
  }), []);

  return <div ref={divRef} style={{ width: '100%', height }} />;
}

export default forwardRef(PlotlyChart);
