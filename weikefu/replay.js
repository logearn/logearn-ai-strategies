// 威科夫策略回放/回归工具：node replay.js
// 读取 data/ 下所有 snapshots_*.json，把 Date.now 固定到各快照时刻后重放 code.js，
// 输出每单的命中结果与关键指标。改参数/加过滤后跑一遍，对照"期望结果"看有没有误杀/漏杀。
//
// 期望结果（人工标注，新增案例请补充）：
//   TikTok    应命中（40K→4.1M 大赢家）
//   QUOKKA    应拦下（AO峰值衰减48%+池子$7.6K，买后最高仅+23%）
//   42        应拦下（池子仅$3K，纸面+108%但无法成交，可执行性优先）
//   Sovicat/SISYPUSS/Neeps 应拦下（亏损单，v1.8"反弹慢于砸盘"拦截）
//   JLY(+478%)/PolarBear(+59%) 被 v1.8 误杀——有意识的取舍（方案c），不算回归失败
//   GERMANUS  漏杀（LOSS +37%，现有检查拦不住，待找新特征）
const fs = require('fs'), path = require('path')
const DIR = path.join(__dirname, 'data')
const code = fs.readFileSync(path.join(__dirname, 'code.js'), 'utf8')

const seen = {}
for (const f of fs.readdirSync(DIR).filter((f) => f.startsWith('snapshots_') && f.endsWith('.json'))) {
  for (const s of JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))) {
    const sym = s.ctx?.logearn?.symbol
    if (sym) seen[sym + '@' + s.timestamp] = s // 同币多快照按时间区分
  }
}

let hit = 0, miss = 0
for (const [key, s] of Object.entries(seen)) {
  const realNow = Date.now
  Date.now = () => s.timestamp
  let result = '', detail = ''
  const log = {
    success: (m) => { result = 'HIT '; detail = m },
    error: (m) => { result = 'MISS'; detail = m },
  }
  try { new Function('ctx', code)({ ...s.ctx, log }) } finally { Date.now = realNow }
  result === 'HIT ' ? hit++ : miss++
  const le = s.ctx.logearn || {}
  console.log(`[${result}] ${key}  pool=$${Math.round(le.pool_liquidity || 0)}`)
  const fails = (detail.split('||')[1] || '').split('|').filter((x) => x.includes('❌')).map((x) => x.trim())
  if (fails.length) console.log('       拦截原因: ' + fails.join(' | '))
  console.log()
}
console.log(`共 ${hit + miss} 单：命中 ${hit}，拦下 ${miss}`)
