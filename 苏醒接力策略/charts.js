// 命中单形态可视化：node charts.js [code文件=code-v2.js] [--all]  → 生成 data/charts.html，浏览器打开人工核对形态
// 每张图：K 线（市值口径）+ 成交量；蓝色带 = 策略识别出的死亡区（上沿画横线），红竖线 = 苏醒信号时刻，
// 标题带买后最高倍数。默认只画命中单，--all 画全部。
const fs = require('fs'), path = require('path')
const args = process.argv.slice(2)
const codeFile = args.find((a) => !a.startsWith('--')) || 'code-v2.js'
const all = args.includes('--all')
const DIR = path.join(__dirname, 'data')
let code = fs.readFileSync(path.join(__dirname, codeFile), 'utf8')
// 注入：把识别出的结构挂到 ctx 上供画图
code = code.replace(/const phase = /, 'ctx.__struct = { bars, dead, sigIdx, sigTime, sigMcap, skipped, activeHigh }\n  const phase = ')

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))
const snaps = []
for (const f of files.filter((f) => f.startsWith('snapshots_'))) snaps.push(...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
snaps.sort((a, b) => a.timestamp - b.timestamp)
const calls = []
for (const f of files.filter((f) => f.startsWith('calls_'))) calls.push(...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))

const panels = []
for (const s of snaps) {
  const realNow = Date.now
  Date.now = () => s.timestamp
  let hit = false, detail = ''
  const ctx = { ...s.ctx, log: { success: (m) => { hit = true; detail = m }, error: (m) => { detail = m } } }
  try { new Function('ctx', code)(ctx) } finally { Date.now = realNow }
  if (!hit && !all) continue
  const st = ctx.__struct
  if (!st || !st.bars.length) continue
  const ts = Math.floor(s.timestamp / 1000)
  const c = calls.find((x) => x.token_address === s.signal.token_address && Math.abs(Math.floor(x.timestamp / 1000) - ts) <= 5)
  const maxUp = c && c.initial_mcap > 0 && c.max_mcap / c.initial_mcap <= 1000 ? (c.max_mcap / c.initial_mcap).toFixed(2) + 'x' : '脏值/NA'
  const cur = c && c.initial_mcap > 0 ? (c.current_mcap / c.initial_mcap).toFixed(2) + 'x' : 'NA'
  const phase = (detail.match(/阶段=(.*?)(?:\s+通过|\s+\|\|)/) || [])[1] || ''
  panels.push({
    title: `${hit ? 'HIT' : 'MISS'} ${s.ctx.logearn.symbol}  K${s.ctx.kline_and_indicators.resolution}  ${new Date(s.timestamp).toISOString().slice(5, 16)}  买后最高 ${maxUp} / 当前 ${cur}  ${phase}`,
    ca: s.signal.token_address,
    bars: st.bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]),
    dead: st.dead ? { start: st.bars[st.dead.startIdx].t, end: st.bars[st.dead.endIdx].t, upper: st.dead.upper, lower: st.dead.lower } : null,
    sigTime: st.sigTime, sigMcap: st.sigMcap, activeHigh: st.activeHigh,
  })
}

const html = `<!doctype html><meta charset="utf-8"><title>苏醒接力 形态核对</title>
<style>body{font:12px monospace;background:#111;color:#ddd;margin:0;padding:10px}.p{margin:0 0 18px}.t{margin:0 0 4px;color:#fff}.t b{color:#7f7}.t b.m{color:#f77}canvas{background:#1a1a1a;display:block}</style>
<h3>${codeFile} 命中形态核对（${panels.length} 张）— 蓝带=死亡区，蓝横线=上沿，红竖线=苏醒信号，绿虚线=活跃高点</h3>
<div id="root"></div>
<script>
const P=${JSON.stringify(panels)};
const W=1100,H=260,VH=60;
for(const p of P){
  const d=document.createElement('div');d.className='p';
  d.innerHTML='<div class="t"><b class="'+(p.title.startsWith('HIT')?'':'m')+'">'+p.title.slice(0,4)+'</b>'+p.title.slice(4)+'<br><span style="color:#888">'+p.ca+'</span></div>';
  const c=document.createElement('canvas');c.width=W;c.height=H+VH;d.appendChild(c);document.getElementById('root').appendChild(d);
  const g=c.getContext('2d');const bars=p.bars;const n=bars.length;
  const t0=bars[0][0],t1=Math.max(bars[n-1][0],p.sigTime||0);const res=n>1?Math.max(1,(bars[n-1][0]-bars[0][0])/(n-1)):60;
  const X=t=>40+(t-t0)/(t1-t0+res)*(W-50);
  const hi=Math.max(...bars.map(b=>b[2]),p.sigMcap||0),lo=Math.min(...bars.map(b=>b[3]));
  const useLog=hi/lo>8;const Y=v=>{const f=useLog?(Math.log(v)-Math.log(lo))/(Math.log(hi)-Math.log(lo)):(v-lo)/(hi-lo);return 10+(1-f)*(H-20)};
  const vmax=Math.max(...bars.map(b=>b[5]))||1;const bw=Math.max(1,(W-50)/((t1-t0)/res+1)*0.7);
  if(p.dead){g.fillStyle='rgba(80,140,255,0.15)';g.fillRect(X(p.dead.start),Y(p.dead.upper),X(p.dead.end+res)-X(p.dead.start),Y(p.dead.lower)-Y(p.dead.upper));
    g.strokeStyle='#5af';g.lineWidth=1;g.beginPath();g.moveTo(40,Y(p.dead.upper));g.lineTo(W-10,Y(p.dead.upper));g.stroke();
    g.fillStyle='#5af';g.fillText('上沿 '+Math.round(p.dead.upper).toLocaleString(),44,Y(p.dead.upper)-3);}
  if(p.activeHigh){g.strokeStyle='#7f7';g.setLineDash([4,4]);g.beginPath();g.moveTo(40,Y(p.activeHigh));g.lineTo(W-10,Y(p.activeHigh));g.stroke();g.setLineDash([]);g.fillStyle='#7f7';g.fillText('活跃高点 '+Math.round(p.activeHigh).toLocaleString(),44,Y(p.activeHigh)-3);}
  for(const b of bars){const x=X(b[0]);const up=b[4]>=b[1];g.strokeStyle=g.fillStyle=up?'#2c2':'#c33';
    g.beginPath();g.moveTo(x+bw/2,Y(b[2]));g.lineTo(x+bw/2,Y(b[3]));g.stroke();
    const y1=Y(Math.max(b[1],b[4])),y2=Y(Math.min(b[1],b[4]));g.fillRect(x,y1,bw,Math.max(1,y2-y1));
    g.fillStyle=up?'rgba(40,200,40,0.6)':'rgba(200,50,50,0.6)';const vh=b[5]/vmax*(VH-4);g.fillRect(x,H+VH-vh,bw,vh);}
  if(p.sigTime){g.strokeStyle='#f55';g.lineWidth=1.5;g.beginPath();g.moveTo(X(p.sigTime),0);g.lineTo(X(p.sigTime),H+VH);g.stroke();
    if(p.sigMcap){g.fillStyle='#f55';g.beginPath();g.arc(X(p.sigTime),Y(p.sigMcap),4,0,7);g.fill();g.fillText('信号 '+Math.round(p.sigMcap).toLocaleString(),X(p.sigTime)+6,Y(p.sigMcap));}}
  g.fillStyle='#888';g.fillText((useLog?'log ':'')+Math.round(hi).toLocaleString(),0,14);g.fillText(Math.round(lo).toLocaleString(),0,H-6);
  g.fillText(new Date(t0*1000).toISOString().slice(5,16),40,H+VH-2);g.fillText(new Date(t1*1000).toISOString().slice(5,16),W-90,H+VH-2);
}
</script>`
fs.writeFileSync(path.join(DIR, 'charts.html'), html)
console.log('已生成 ' + path.join(DIR, 'charts.html') + '，共 ' + panels.length + ' 张')
