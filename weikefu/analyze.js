// 复盘特征分析：node analyze.js
// 读取 data/ 下快照，输出每单买点时刻的候选区分特征，人工对照正反例找有区分度的过滤。
// 当前验证假设：SOS 突破时收盘距历史高点/V转顶部的位置（上方套牢盘多寡）。
const fs = require('fs'), path = require('path')
const DIR = path.join(__dirname, 'data')

// 实盘结果标注（入场后最高涨幅，新增案例请补充）
const OUTCOME = {
  TikTok: 'WIN  +10528%',
  JLY: 'WIN  +478%',
  PolarBear: '弱   +59%',
  Sovicat: 'LOSS +27%',
  SISYPUSS: 'LOSS +15%',
  GERMANUS: 'LOSS +37%',
  Neeps: 'LOSS +26%',
  QUOKKA: '已拦 -83%',
  42: '已拦 +108%不可成交',
}

const toSec = (t) => { const n = Number(t) || 0; return n > 1e12 ? Math.floor(n / 1000) : n }

const seen = {}
for (const f of fs.readdirSync(DIR).filter((f) => f.startsWith('snapshots_') && f.endsWith('.json'))) {
  for (const s of JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
    const sym = s.ctx?.logearn?.symbol
    if (sym) seen[sym] = s
  }
}

for (const [sym, s] of Object.entries(seen)) {
  const ki = s.ctx.kline_and_indicators || {}
  const le = s.ctx.logearn || {}
  const bars = (ki.kline_bars || [])
    .map((b) => ({ t: toSec(b.time), h: Number(b.high) || Math.max(Number(b.open), Number(b.close)), c: Number(b.close) }))
    .filter((b) => b.t > 0)
    .sort((a, b) => a.t - b.t)
  if (!bars.length) continue
  const last = bars[bars.length - 1]
  // 历史最高 high（不含最新一根，即突破前的上方压力位）
  const histHigh = Math.max(...bars.slice(0, -1).map((b) => b.h))
  // 最新有效 V 转的顶部价
  let v = null
  for (const x of (le.v_breakout_volume_list || [])) {
    if (x.n_pattern_confirmed !== true) continue
    if (Number(x.fibon_break4) > 0) continue
    if (!v || Number(x.signalTime) > Number(v.signalTime)) v = x
  }
  const vTop = v ? Number(v.top_price) : 0
  console.log(
    sym.padEnd(10),
    (OUTCOME[sym] || '未标注').padEnd(16),
    '收盘/历史最高=' + (last.c / histHigh * 100).toFixed(0) + '%',
    ' 收盘/V顶=' + (vTop > 0 ? (last.c / vTop * 100).toFixed(0) + '%' : 'NA'),
  )
}
