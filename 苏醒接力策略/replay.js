// 苏醒接力策略回放工具：node replay.js [code文件=code-v2.js] [--only=符号,符号] [--verbose]
// 读取 data/ 下所有 snapshots_*.json（v1.2 实盘命中快照），把 Date.now 固定到各快照时刻后重放指定策略代码，
// 输出每单命中结果、阶段、拦截原因，并汇总：阶段分布 + 各检查项拦截漏斗 + 粒度分布。
// 若 data/ 下有 calls_*.json（买后走势：initial/max/min/current mcap），按 token_address+时间戳(±5s) 关联，
// 输出命中组 vs 拦下组的买后表现对比——这是判断新版有没有区分度的唯一依据。
// 注：calls 的 max_mcap 存在 1e13 级脏值，>1000x 的按缺失处理。
const fs = require('fs'), path = require('path')
const args = process.argv.slice(2)
const codeFile = args.find((a) => !a.startsWith('--')) || 'code-v2.js'
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean)
const verbose = args.includes('--verbose')
const DIR = path.join(__dirname, 'data')
const code = fs.readFileSync(path.join(__dirname, codeFile), 'utf8')
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))

const snaps = []
for (const f of files.filter((f) => f.startsWith('snapshots_'))) {
  for (const s of JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
    const sym = s.ctx?.logearn?.symbol || s.signal?.symbol
    if (sym && (!only.length || only.includes(sym))) snaps.push({ key: sym + '@' + s.timestamp, sym, s })
  }
}
snaps.sort((a, b) => a.s.timestamp - b.s.timestamp)

const calls = []
for (const f of files.filter((f) => f.startsWith('calls_'))) calls.push(...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
const findCall = (s) => {
  const ca = s.signal?.token_address || s.ctx?.logearn?.token_address, ts = Math.floor(s.timestamp / 1000)
  const c = calls.find((x) => x.token_address === ca && Math.abs(Math.floor(x.timestamp / 1000) - ts) <= 5)
  if (!c || !(c.initial_mcap > 0)) return null
  const r = (x) => (x > 0 ? x / c.initial_mcap : null)
  const maxUp = r(c.max_mcap)
  return { maxUp: maxUp != null && maxUp <= 1000 ? maxUp : null, cur: r(c.current_mcap), minDn: r(c.min_mcap) }
}

const count = (m, k) => { m[k] = (m[k] || 0) + 1 }
const phases = {}, firstFail = {}, allFail = {}, softFail = {}, resDist = {}
const rows = []
for (const { key, s } of snaps) {
  const realNow = Date.now
  Date.now = () => s.timestamp
  let result = '', detail = ''
  const log = {
    success: (m) => { result = 'HIT '; detail = m },
    error: (m) => { result = 'MISS'; detail = m },
  }
  try { new Function('ctx', code)({ ...s.ctx, log }) } finally { Date.now = realNow }

  const ki = s.ctx.kline_and_indicators || {}
  const phase = (detail.match(/阶段=(.*?)(?:\s+通过|\s+\|\|)/) || [])[1] || '?'
  const items = (detail.split('||')[1] || '').split('|').map((x) => x.trim())
  const fails = items.filter((x) => x.includes('❌'))
  const failNames = fails.map((x) => x.split('❌')[0])
  items.filter((x) => x.includes('⚠️')).forEach((x) => count(softFail, x.split('⚠️')[0]))
  count(phases, phase.replace(/\(.*$/, ''))
  count(resDist, 'K' + ki.resolution + '/' + ((ki.kline_bars || []).length >= 100 ? '100+' : (ki.kline_bars || []).length >= 30 ? '30-99' : '<30') + '根')
  if (failNames.length) count(firstFail, failNames[0])
  failNames.forEach((n) => count(allFail, n))

  const call = findCall(s)
  rows.push({ key, sym: s.ctx.logearn?.symbol, hit: result === 'HIT ', call })
  const le = s.ctx.logearn || {}
  const t = new Date(s.timestamp).toISOString().replace('T', ' ').slice(5, 16)
  const outcome = call ? `  买后最高${call.maxUp != null ? call.maxUp.toFixed(2) + 'x' : '脏值'}/当前${call.cur != null ? call.cur.toFixed(2) + 'x' : 'NA'}` : ''
  console.log(`[${result}] ${key.padEnd(28)} ${t}  K${String(ki.resolution).padEnd(3)} ${String((ki.kline_bars || []).length).padStart(3)}根  mcap=$${Math.round(le.mcap || 0)}${outcome}  阶段=${phase}`)
  console.log('       CA: ' + (s.signal?.token_address || le.token_address || 'NA'))
  if (fails.length) console.log('       拦截: ' + fails.join(' | '))
  if (verbose) console.log('       ' + detail)
  console.log()
}

const table = (title, m) => {
  console.log('\n' + title)
  Object.entries(m).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + String(v).padStart(4) + '  ' + k))
}
const hit = rows.filter((r) => r.hit).length, miss = rows.length - hit
console.log(`\n========== ${codeFile} 回放：共 ${rows.length} 单，命中 ${hit}，拦下 ${miss} ==========`)
table('阶段分布', phases)
table('首个❌项（漏斗：卡在哪一步）', firstFail)
table('所有❌项计数', allFail)
table('⚠️ 软条件未达标计数（不拦截）', softFail)
table('K线粒度/根数分布', resDist)

if (calls.length) {
  const med = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
  const pct = (n, d) => (d ? (n / d * 100).toFixed(0) + '%' : 'NA')
  // 评价口径：买后最高涨幅分布——<100% 占比（没翻倍的）、>100% / >300% / >500% 占比，命中组 vs 拦下组
  const BUCKETS = [[(x) => x < 2, '<100%'], [(x) => x >= 2, '>100%'], [(x) => x >= 4, '>300%'], [(x) => x >= 6, '>500%']]
  const stat = (name, rs) => {
    const c = rs.map((r) => r.call).filter(Boolean)
    const ups = c.map((x) => x.maxUp).filter((x) => x != null), curs = c.map((x) => x.cur).filter((x) => x != null)
    console.log('  ' + name.padEnd(10) + 'n=' + String(ups.length).padEnd(4)
      + BUCKETS.map(([f, l]) => ' ' + l + ' ' + (pct(ups.filter(f).length, ups.length) + '(' + ups.filter(f).length + ')').padEnd(9)).join('')
      + ' 最高中位 ' + (med(ups) || 0).toFixed(2) + 'x  当前中位 ' + (med(curs) || 0).toFixed(2) + 'x')
  }
  console.log('\n买后最高涨幅分布（calls 关联，脏值已排除）')
  stat('命中组', rows.filter((r) => r.hit))
  stat('拦下组', rows.filter((r) => !r.hit))
  stat('全部', rows)
  const missedWinners = rows.filter((r) => !r.hit && r.call?.maxUp >= 3).sort((a, b) => b.call.maxUp - a.call.maxUp)
  if (missedWinners.length) console.log('\n拦下但买后最高>=3x（误杀候选）: ' + missedWinners.map((r) => `${r.sym}(${r.call.maxUp.toFixed(1)}x)`).join(' '))
  const hitLosers = rows.filter((r) => r.hit && r.call?.maxUp != null && r.call.maxUp < 1.3)
  if (hitLosers.length) console.log('命中但买后最高<1.3x（漏杀候选）: ' + hitLosers.map((r) => `${r.sym}(${r.call.maxUp.toFixed(2)}x)`).join(' '))
}
