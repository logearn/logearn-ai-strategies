// 临时分析：解析实盘日志 logs_*.json，统计威科夫结构全过但被 AO 拦下的记录：node ao_log_check.js
const fs = require('fs'), path = require('path')
const DIR = path.join(__dirname, 'data')

const WYCKOFF = ['有效V转', 'SC定位', 'SC放量', 'AR反弹', 'ST不破位', 'ST缩量', 'SOS突破', 'SOS放量', 'SOS强势', 'SOS新鲜', '吸筹区间']
const AO = ['AO动能', 'AO峰值衰减']

const logs = []
for (const f of fs.readdirSync(DIR).filter((f) => f.startsWith('logs_') && f.endsWith('.json'))) {
  logs.push(...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
}

const parse = (msg) => {
  const items = (msg.split('||')[1] || '').split('|').map((x) => x.trim())
  const status = {}
  for (const it of items) {
    const m = it.match(/^(.+?)(✅|❌):/)
    if (m) status[m[1]] = { ok: m[2] === '✅', raw: it }
  }
  return status
}

let total = 0, hit = 0, wyckoffPass = 0, aoBlocked = 0, aoUnknown = 0
const blockedList = []
for (const l of logs) {
  const msg = l.message || ''
  if (!msg.includes('||')) continue
  total++
  if (l.log_type === 'success') { hit++; continue } // 命中的必然全过
  const st = parse(msg)
  const wOk = WYCKOFF.every((n) => st[n] && st[n].ok)
  if (!wOk) continue
  wyckoffPass++
  const aoSeen = AO.filter((n) => st[n])
  if (aoSeen.length === 0) { aoUnknown++; continue } // message 截断，看不到 AO 项
  const aoFails = AO.filter((n) => st[n] && !st[n].ok)
  if (aoFails.length) {
    aoBlocked++
    const others = Object.values(st).filter((x) => !x.ok && !AO.some((n) => x.raw.startsWith(n))).map((x) => x.raw)
    blockedList.push({ sym: l.symbol, t: new Date(l.timestamp).toISOString().slice(5, 16), ao: aoFails.map((n) => st[n].raw).join(' | '), others })
  }
}

for (const b of blockedList) {
  console.log(`[${b.t}] ${b.sym}`)
  console.log('    AO: ' + b.ao)
  console.log('    其他未过项: ' + (b.others.length ? b.others.join(' | ') : '无（仅AO拦截）'))
  console.log()
}
console.log('---')
console.log(`日志总数 ${total}（命中 ${hit}）`)
console.log(`未命中里威科夫结构全过 ${wyckoffPass}，其中被AO拦 ${aoBlocked}，message截断看不到AO项 ${aoUnknown}`)
console.log(`仅AO拦截（其他检查全过）: ${blockedList.filter((b) => !b.others.length).length}`)
