// ==============================================================
// 策略模板骨架（打分版）—— 复制这个开新策略，照 策略代码规范.md 填内容。
//
// 【f 垫片】如果你用了 f('字段')（review「发送到策略」生成的打分因子就是），需要在最顶上放
// f 兼容垫片，线上才不会 f is not defined。两种拿法：
//   (a) 把这份策略贴进 review「策略」看板，点规范校验里的「一键全修」→ 自动在顶部插入垫片；
//   (b) 从 强势盘策略/f-shim.js 复制那段垫片贴到本行上方。
// 如果整份策略只读 ctx.*、完全不用 f()，可以不要垫片。
// ==============================================================
const VERSION = 'my-strategy-v0.0.1'   // 改成你的版本号；会进 SCORE 标记
const CUTOFF = 0                        // 0~100 打分阈值；起步全硬条件时设 0（score 关卡恒过）

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0 }
// 梯形打分：[lo1,hi1] 满分 1，两侧线性过渡，界外 0，缺失 0；lo1===hi1 退化成布尔阶跃。
const trap = (x, lo0, lo1, hi1, hi0) => {
  if (x === null || !Number.isFinite(Number(x))) return 0
  const v = Number(x)
  if (v >= lo1 && v <= hi1) return 1
  if (v <= lo0 || v >= hi0) return 0
  if (v < lo1) { const w = lo1 - lo0; return Number.isFinite(w) && w > 0 ? (v - lo0) / w : 0 }
  const w = hi0 - hi1
  return Number.isFinite(w) && w > 0 ? (hi0 - v) / w : 0
}

// ========== 统一检查项清单 ==========
// [name, value, weight, lo0, lo1, hi1, hi0, actualDisplay(可选), expectLabel(可选)]
// - 打分因子：weight 给真实权重（勇者正/邪恶负），value 用 f('字段') 或 ctx 现算；区间按真实业务写。
// - 硬性条件：value 给判定布尔(ok?1:0)、区间 1,1,1,1（trap 只有 value===1 才给 1），名字要进 VETO_NAMES。
// - name 在本数组内必须唯一；gmgn.* 比例字段区间按百分比写（f/垫片已 ×100）。
const ALL_CHECKS = [
  // —— 打分因子示例（不在 VETO_NAMES 里）——
  ['新钱包持仓', f('new_volume'), 10, -Infinity, -Infinity, 60, 60, null, '<=60'],
  // —— 硬性条件示例（要进 VETO_NAMES）——
  ['市值', num(ctx.logearn && ctx.logearn.mcap) < 120000 ? 1 : 0, 1, 1, 1, 1, 1,
    String(num(ctx.logearn && ctx.logearn.mcap)), '<120k'],
]

// ========== 分组：谁是硬否决 ==========
// 【显式列出】真正的硬否决名字——不要用 new Set(ALL_CHECKS.map(c=>c[0]))（会把打分项也扫成硬否决）。
const VETO_NAMES = new Set([
  '市值',
])

// ========== 汇总（口径固定，一般不用改）==========
let total = 0, wsum = 0, vetoPassed = true
const checks = []
for (const c of ALL_CHECKS) {
  const [name, value, weight, lo0, lo1, hi1, hi0, actualOverride, expectOverride] = c
  const s = trap(value, lo0, lo1, hi1, hi0)
  const actualStr = actualOverride != null ? actualOverride : (value === null ? '缺失' : String(Number(Number(value).toFixed(4))))
  if (VETO_NAMES.has(name)) {
    const ok = s === 1
    if (!ok) vetoPassed = false
    checks.push([name, ok, actualStr, expectOverride != null ? expectOverride : (lo1 + '~' + hi1)])
  } else {
    total += s * weight; wsum += Math.max(0, weight)   // 分母只夹正权重
    checks.push([name + '(分)', s > 0, actualStr + ' → ' + (s * weight).toFixed(1) + '分', '满分 ' + lo1 + '~' + hi1 + ' 权重 ' + weight])
  }
}
const score = wsum > 0 ? total / wsum * 100 : 0        // 0~100 归一化
checks.push(['总分', score >= CUTOFF, score.toFixed(1), '>= ' + CUTOFF])   // 注意是 >= CUTOFF，不是 >= score

// ========== 输出：SCORE 标记（review 靠这行解析分数）==========
const grade = !vetoPassed ? '-' : (score >= 85 ? 'S' : (score >= CUTOFF ? 'A' : '-'))
const mark = 'SCORE=' + score.toFixed(1) + ' VER=' + VERSION + ' GRADE=' + grade
const detail = checks.map(([name, ok, actual, expect]) => `${name}(${ok}): ${actual} [期望 ${expect}]`).join('  |  ')
if (!vetoPassed) { ctx.log.error('未命中(否决) ' + mark + '  ||  ' + detail); return false }
if (score < CUTOFF) { ctx.log.error('未命中(分低) ' + mark + '  ||  ' + detail); return false }
ctx.log.success('命中 ' + mark + '  ||  ' + detail)
return true
