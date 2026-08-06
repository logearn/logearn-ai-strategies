// 临时分析：实盘日志漏斗——每条记录卡在第一个❌的检查项：node funnel.js
const fs = require('fs'), path = require('path')
const DIR = path.join(__dirname, 'data')

const logs = []
for (const f of fs.readdirSync(DIR).filter((f) => f.startsWith('logs_') && f.endsWith('.json'))) {
  logs.push(...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')))
}

const firstFail = {}, allFail = {}, scVolFails = []
let total = 0, truncated = 0
for (const l of logs) {
  const msg = l.message || ''
  if (!msg.includes('||')) continue
  total++
  if (!msg.includes('池子流动性')) truncated++ // 最后一项看不到 = message 被截断
  const items = (msg.split('||')[1] || '').split('|').map((x) => x.trim())
  let first = null
  for (const it of items) {
    const m = it.match(/^(.+?)❌:/)
    if (m) {
      allFail[m[1]] = (allFail[m[1]] || 0) + 1
      if (!first) first = m[1]
      if (m[1] === 'SC放量') scVolFails.push(l.symbol + ' ' + it)
    }
  }
  const key = first || (l.log_type === 'success' ? '命中' : '未知(截断处全✅)')
  firstFail[key] = (firstFail[key] || 0) + 1
}

console.log(`日志总数 ${total}，message截断(看不到末尾检查项) ${truncated}`)
console.log('\n== 第一个❌（漏斗卡点）==')
for (const [k, v] of Object.entries(firstFail).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)
console.log('\n== 所有❌出现次数 ==')
for (const [k, v] of Object.entries(allFail).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)
console.log('\n== SC放量❌ 明细（验证“SC钉在缩量bar”假设）==')
for (const s of scVolFails.slice(0, 20)) console.log('  ' + s)
