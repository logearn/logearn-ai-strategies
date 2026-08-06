// 临时分析：统计威科夫结构全过、但被 AO 检查拦下的快照：node ao_check.js
const fs = require('fs'), path = require('path')
const DIR = path.join(__dirname, 'data')
const code = fs.readFileSync(path.join(__dirname, 'code.js'), 'utf8')

// 威科夫结构本体的检查项（不含 AO/成本线/持仓/池子等外挂滤网）
const WYCKOFF = ['有效V转', 'SC定位', 'SC放量', 'AR反弹', 'ST不破位', 'ST缩量', 'SOS突破', 'SOS放量', 'SOS强势', 'SOS新鲜', '吸筹区间']
const AO = ['AO动能', 'AO峰值衰减']

const seen = {}
for (const f of fs.readdirSync(DIR).filter((f) => f.startsWith('snapshots_') && f.endsWith('.json'))) {
  for (const s of JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
    const sym = s.ctx?.logearn?.symbol
    if (sym) seen[sym + '@' + s.timestamp] = s
  }
}

let total = 0, wyckoffPass = 0, aoBlocked = 0
for (const [key, s] of Object.entries(seen)) {
  total++
  const realNow = Date.now
  Date.now = () => s.timestamp
  let detail = ''
  const log = { success: (m) => { detail = m }, error: (m) => { detail = m } }
  try { new Function('ctx', code)({ ...s.ctx, log }) } finally { Date.now = realNow }

  // 解析 checks 明细：'名称✅: 实际 [期望 ...]' 按 | 分隔
  const items = (detail.split('||')[1] || '').split('|').map((x) => x.trim())
  const status = {}
  for (const it of items) {
    const m = it.match(/^(.+?)(✅|❌):/)
    if (m) status[m[1]] = m[2] === '✅'
  }

  const wOk = WYCKOFF.every((n) => status[n] === true)
  const aoFails = AO.filter((n) => status[n] === false)
  if (wOk) wyckoffPass++
  if (wOk && aoFails.length) {
    aoBlocked++
    console.log(`${key}  威科夫结构全过，AO拦截: ${aoFails.join(',')}`)
    const aoDetail = items.filter((x) => AO.some((n) => x.startsWith(n)))
    console.log('    ' + aoDetail.join('  |  '))
    const others = items.filter((x) => x.includes('❌') && !AO.some((n) => x.startsWith(n)))
    if (others.length) console.log('    其他未过项: ' + others.join(' | '))
    console.log()
  }
}
console.log('---')
console.log(`快照总数 ${total}，威科夫结构全过 ${wyckoffPass}，其中被AO拦的 ${aoBlocked}`)
