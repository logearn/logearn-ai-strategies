// 由 js/pro-analytics.js 机械抽出的纯计算：策略编译/回放、检查项阈值扫描、共线性诊断等。
// 同样只搬不读全局状态的函数，函数体一行未改。依赖 activeRows 的 6 个（runStrategyOnRow /
// findSimilarCases / computeFeatureInteractions 等）留在原处，待改签名后再搬。
import { WIN_THRESHOLD, computeROC, percentile } from './utils.js';
import { getFeature, isFiniteNumber } from './data.js';

// 组装字段名只允许字母/数字/下划线/点，原始字段名里的其它符号（如空格、括号）统一替换成下划线
function sanitizeForFieldName(f) {
  return f.replace(/[^a-zA-Z0-9_.]/g, '_');
}

// 样本外验证：测试集必须用训练集算出来的 mean/std 标准化，而不是用测试集自己的分布重新标准化——
// 否则等于让测试集"偷看"了自己的统计信息，样本外 R² 会失去验证意义
function standardizeWith(values, mean, std) {
  return std > 1e-12 ? values.map(v => (v - mean) / std) : values.map(() => 0);
}

function standardize(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  return { mean, std, z: std > 1e-12 ? values.map(v => (v - mean) / std) : values.map(() => 0) };
}

// 样本外验证：测试集必须用训练集算出来的 mean/std 标准化，而不是用测试集自己的分布重新标准化——
// 否则等于让测试集"偷看"了自己的统计信息，样本外 R² 会失去验证意义

// 二分查找 value 在已排序数组里的百分位排名（0~1，即 <= value 的比例）。
function percentileRankOf(sortedVals, value) {
  if (!sortedVals.length || !isFiniteNumber(value)) return NaN;
  let lo = 0, hi = sortedVals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedVals[mid] <= value) lo = mid + 1; else hi = mid;
  }
  return lo / sortedVals.length;
}

// AUC 显著性判定：置信区间完全落在 0.5 一侧才算"优于随机猜测"。
// 跨过 0.5 就意味着——这个字段和抛硬币在统计上分不出高下，点估计再好看也不能用。
function aucVerdict(auc, ci) {
  if (!ci || !Number.isFinite(ci.lo)) return { text: '-', color: 'var(--text-muted)', significant: false };
  if (ci.lo > 0.5) return { text: '优于随机', color: 'var(--ok, #30d158)', significant: true };
  if (ci.hi < 0.5) return { text: '反向有效', color: 'var(--ok, #30d158)', significant: true };
  return { text: '不显著', color: 'var(--text-muted)', significant: false };
}

// 记录到的路径里既有叶子字段（gmgn.stat.bot_degen_rate）也有沿途的容器对象（gmgn、gmgn.stat）。
// 容器是访问叶子时顺带记下的，本身不是"策略用到的字段"，展示出来只会稀释清单。
// 判定：某条路径如果是另一条路径的前缀，就是容器，丢掉。

// 从 check 的"实际值"字符串里抠出数字。策略常把辅助信息拼进去（如 "3.30(2657/804)"、
// "2.032x"），parseFloat 只取前导数字正好合适；纯文本（平台名等）返回 NaN，该 check 不参与扫描。
function parseCheckNumber(v) {
  const n = parseFloat(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

// 从"期望"文字推断方向：'< 2.5' → 越小越好；'> 30' → 越大越好。
// 区间（'20~30'）和等值（'== 0'）没有单一切点，不给推荐。

// 从"期望"文字推断方向：'< 2.5' → 越小越好；'> 30' → 越大越好。
// 区间（'20~30'）和等值（'== 0'）没有单一切点，不给推荐。
function parseCheckDirection(expect) {
  const e = String(expect || '').trim();
  if (/~/.test(e) || /==/.test(e)) return null;
  if (/^<=?/.test(e)) return 'lt';
  if (/^>=?/.test(e)) return 'gt';
  return null;
}

// 为一条 check 扫描候选阈值：在两侧都保留足够样本的前提下，找"通过侧胜率最高"的切点。
// 返回 { rows, best, curr }，rows 是每个候选阈值的通过数/胜率/中位数，供表格展示。

// 组装字段名只允许字母/数字/下划线/点，原始字段名里的其它符号（如空格、括号）统一替换成下划线

// 自动分位数分层（混杂控制）通用工具：把一组数值按分位数切成 quantileCount 层，每层样本量大致相等，
// 避免手动断点容易出现的"某一层几乎包揽全部样本"问题。返回 { breakpoints } 或 { error } 二选一，
// 由调用方决定用 showToast 还是别的方式呈现——这个函数本身不做 UI 交互，保持纯函数、方便复用/测试。
function computeQuantileBreakpoints(values, quantileCount) {
  const vals = values.filter(isFiniteNumber).map(Number).sort((a, b) => a - b);
  if (vals.length < quantileCount * 5) {
    return { error: `有效数值样本仅 ${vals.length} 条，不足以做 ${quantileCount} 分位分层（每层至少需要约 5 条）` };
  }
  const cuts = [];
  for (let i = 1; i < quantileCount; i++) cuts.push(percentile(vals, i / quantileCount));
  const breakpoints = [...new Set(cuts)].filter(Number.isFinite);
  if (!breakpoints.length) return { error: '取值过于集中，分位数切点全部重合，无法分层' };
  return { breakpoints };
}

// ---------- 3. 特征重要性（多元线性回归，标准化系数） ----------
// 高斯消元（带部分选主元）求解线性方程组 A x = b，A 为 n x n。
// 不再用 ridge 微小正则"悄悄掩盖"共线问题——矩阵（近）奇异时直接返回 null，
// 让调用方明确知道"这组特征算不出稳定的系数"，而不是输出一个看似精确、实则没有意义的数字。
function solveLinearSystem(A, b) {
  const n = A.length;
  if (n === 0) return [];
  const scale = Math.max(...A.map((row, i) => Math.abs(row[i]))) || 1;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    if (Math.abs(M[col][col]) < 1e-9 * scale) return null; // 矩阵（近）奇异，无法稳定求解
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// 简易 VIF（方差膨胀因子）：对每个自变量，用它对其余自变量做回归得到 R²ᵢ，VIF = 1 / (1 - R²ᵢ)。
// VIF 越大说明该字段能被其余字段线性解释的程度越高，共线性越严重；
// 如果其余字段之间本身就高度共线导致这个子回归也解不出来，直接视为 VIF = Infinity（共线性已经严重到无法量化的程度）。

// 简易 VIF（方差膨胀因子）：对每个自变量，用它对其余自变量做回归得到 R²ᵢ，VIF = 1 / (1 - R²ᵢ)。
// VIF 越大说明该字段能被其余字段线性解释的程度越高，共线性越严重；
// 如果其余字段之间本身就高度共线导致这个子回归也解不出来，直接视为 VIF = Infinity（共线性已经严重到无法量化的程度）。
function computeVIFs(usedX, n) {
  return usedX.map((xi, i) => {
    const others = usedX.filter((_, j) => j !== i);
    const kk = others.length;
    const XtX = Array.from({ length: kk }, (_, a) => Array.from({ length: kk }, (_, b) => {
      let s = 0; for (let r = 0; r < n; r++) s += others[a].z[r] * others[b].z[r]; return s;
    }));
    const Xty = others.map(o => { let s = 0; for (let r = 0; r < n; r++) s += o.z[r] * xi.z[r]; return s; });
    const solved = solveLinearSystem(XtX, Xty);
    if (!solved) return Infinity;
    let sse = 0, sst = 0;
    for (let r = 0; r < n; r++) {
      let yhat = 0;
      for (let a = 0; a < kk; a++) yhat += solved[a] * others[a].z[r];
      sse += (xi.z[r] - yhat) ** 2;
      sst += xi.z[r] ** 2;
    }
    const r2i = sst > 0 ? 1 - sse / sst : 0;
    return r2i >= 0.999999 ? Infinity : 1 / (1 - r2i);
  });
}

// 把整个 Date 冻结到 nowMs（= 该样本的信号买入时刻），让策略里所有"读当前时间"的写法都拿到
// 买入时刻而不是浏览器现在。用 Proxy 包真实 Date，把"当前时间"的全部入口一网打尽：
//   new Date()            → 买入时刻（无参构造）      new Date(x) → 正常按 x 构造（不动）
//   Date.now()            → 买入时刻（毫秒）
//   new Date().getTime()  → 买入时刻（实例就是那一刻，valueOf/+new Date 同理）
//   Date()  直接当函数调用 → 买入时刻的字符串（class 写法会在这里抛错，Proxy 补上）
// Date.parse / Date.UTC 等静态方法原样透传（它们跟"现在"无关，不该被冻结）。
// 这一步只在回放编译时注入，不改策略源码一个字——所以贴到线上的代码照常用 Date.now()，不会有 bug。
function makeFrozenDate(nowMs) {
  return new Proxy(RealDate, {
    construct(target, args) { return args.length === 0 ? new RealDate(nowMs) : new RealDate(...args); },
    apply() { return new RealDate(nowMs).toString(); },
    get(target, prop, recv) {
      if (prop === 'now') return () => nowMs;
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

// 编译时"时间类"自动检测：数一数策略里有几处"读当前时间"的写法（回放时它们已被 makeFrozenDate
// 全部冻结到信号买入时刻），另外挑出几个"快照导出时刻"性质的 ctx 时间字段——这些字段的值本身
// 晚于买入时刻，若当成"现在"来用属于未来函数，冻结 Date 管不到，只能提示人工核对。纯字符串扫描，
// 给看板的"回放时间基准"备注用。
const TIME_READ_RE = /\bDate\s*\.\s*now\s*\(|\bnew\s+Date\b|\.\s*getTime\s*\(/g;
const LOOKAHEAD_TIME_FIELDS = ['kline_and_indicators.timestamp', 'last_traded', 'last_alert'];
export function detectTimeReads(src) {
  const s = String(src || '');
  const count = (s.match(TIME_READ_RE) || []).length;
  const lookaheadFields = LOOKAHEAD_TIME_FIELDS.filter(f => s.includes(f));
  return { count, lookaheadFields };
}

// 用 Proxy 递归包一层 ctx，把策略实际读到的属性路径记下来——这比正则扫源码可靠得多：
// 策略普遍会先起别名（var ki = ctx.kline_and_indicators、var gmgnStat = ctx.gmgn.stat），
// 正则只认 ctx.a.b 的写法就会大面积漏掉，而运行时记录拿到的是真正被读过的字段。

// 用 Proxy 递归包一层 ctx，把策略实际读到的属性路径记下来——这比正则扫源码可靠得多：
// 策略普遍会先起别名（var ki = ctx.kline_and_indicators、var gmgnStat = ctx.gmgn.stat），
// 正则只认 ctx.a.b 的写法就会大面积漏掉，而运行时记录拿到的是真正被读过的字段。
function makeCtxRecorder(ctx, seen) {
  const wrap = (val, path) => {
    if (val === null || typeof val !== 'object') return val;
    return new Proxy(val, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof prop === 'symbol') return v;
        // 数组下标和数组方法不记路径（ao_bars[0].value 这种记成 ao_bars.value 才是有用的信息，
        // 记成 ao_bars.0.value 只会把清单撑爆），但仍继续往下包，保证深层字段名能被记到。
        const isIndexLike = typeof prop === 'string' && /^\d+$/.test(prop);
        const nextPath = (isIndexLike || Array.isArray(target)) ? path : (path ? path + '.' + prop : prop);
        if (!isIndexLike && !Array.isArray(target) && typeof v !== 'function' && nextPath) seen.add(nextPath);
        if (typeof v === 'function') return v.bind(target);
        return wrap(v, nextPath);
      }
    });
  };
  return wrap(ctx, '');
}

// 策略读到的原始 ctx 路径 → 本工具的字段名。对应 data.js 里 flattenObject/flattenCtx 的展开口径：
// ctx.logearn.* 与 signal 同源，展开时不加前缀（所以 logearn.mcap → mcap）；
// ctx.gmgn.* / ctx.kline_and_indicators.* 保留各自前缀。其余（native_coin_price 等）不进特征体系。

function compileStrategy(src) {
  // 只去掉声明关键字（var/const/let），变量名仍然叫 checks——策略后面还会用 checks.every(...)
  // 之类引用它，改名会直接 ReferenceError。配合在最外层预声明一个 checks，就把它从"try 块内的
  // 局部变量"提升成了"整个函数体可见"，finally 里才拿得到（const/let 是块级作用域，
  // 不这么改的话 PVP 那种 `const checks = [...]` 在 finally 里根本不可见）。
  const capturedDecl = STRATEGY_CHECKS_DECL_RE.test(src);
  const rewritten = src.replace(STRATEGY_CHECKS_DECL_RE, 'checks =');
  // try/finally：策略未命中时会中途 return false，finally 保证 checks 仍然被交出来
  const body = `let checks = null;\ntry {\n${rewritten}\n} finally { __emit(checks); }`;
  let fn;
  try {
    // 参数多一个 f：让策略能按【分析字段】（features，算出来的扁平字段）过滤，而不只是 ctx 原始路径。
    // f 是个函数：f('holder_top30_share_pct') 取该字段值；没有则返回 undefined。
    // 老策略只用 ctx，多一个参数不影响它们。
    fn = new Function('ctx', 'f', 'Date', '__emit', body);
  } catch (e) {
    return { error: `策略代码语法错误：${e.message}` };
  }
  return { fn, capturedDecl };
}

// 单行回放。返回 { passed, checks, logs, error, usedPaths }

// 为一条 check 扫描候选阈值：在两侧都保留足够样本的前提下，找"通过侧胜率最高"的切点。
// 返回 { rows, best, curr }，rows 是每个候选阈值的通过数/胜率/中位数，供表格展示。
function scanCheckThreshold(all, direction) {
  const pts = all.map(a => ({ v: parseCheckNumber(a.val), r: a.ret }))
                 .filter(p => Number.isFinite(p.v) && isFiniteNumber(p.r));
  if (pts.length < 20) return null;
  const medOf = a => { if (!a.length) return NaN; const x = a.slice().sort((p, q) => p - q); const m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
  const winOf = a => a.length ? a.filter(v => v > WIN_THRESHOLD).length / a.length * 100 : NaN;
  const baseWin = winOf(pts.map(p => p.r));
  // 候选切点取 5%~95% 分位，避免切出一侧样本极少的极端阈值
  const sorted = pts.map(p => p.v).slice().sort((a, b) => a - b);
  const cands = [];
  const seen = new Set();
  for (let q = 5; q <= 95; q += 5) {
    const v = sorted[Math.min(sorted.length - 1, Math.floor(q / 100 * (sorted.length - 1)))];
    if (!seen.has(v)) { seen.add(v); cands.push(v); }
  }
  const minSide = Math.max(10, Math.round(pts.length * 0.15));
  const rows = [];
  for (const t of cands) {
    const passSide = direction === 'lt' ? pts.filter(p => p.v < t) : pts.filter(p => p.v > t);
    const blockSide = direction === 'lt' ? pts.filter(p => p.v >= t) : pts.filter(p => p.v <= t);
    if (passSide.length < minSide || blockSide.length < minSide) continue;
    rows.push({ t, nPass: passSide.length, win: winOf(passSide.map(p => p.r)), med: medOf(passSide.map(p => p.r)),
                blockWin: winOf(blockSide.map(p => p.r)) });
  }
  if (!rows.length) return null;
  // 推荐：通过侧胜率最高的那个（同胜率取通过样本更多的，保守）
  const best = rows.slice().sort((a, b) => b.win - a.win || b.nPass - a.nPass)[0];
  return { rows, best, baseWin, total: pts.length };
}

// ---------- 8b. 策略诊断：把策略源码原样回放，看目标 CA 到底卡在哪一条 check ----------
// 目标问题：上面的"过滤建议"是【反推】——从数据分布里找能挡住目标 CA 的阈值。但很多时候策略本来
// 就已经上线跑了，真正想问的是【正推】：这个 CA 当时被我的策略拦了吗？卡在哪一条？实际值是多少？
// 靠人肉读策略代码 + 翻快照 JSON 对答案非常慢且容易看错，所以这里直接把策略源码跑一遍。
//
// 依赖的约定（本仓库 强势盘/PVP/1.5段/苏醒接力 四个策略均遵守）：策略是一段以 ctx 为入参的函数体，
// 内部构造 checks = [[名称, 是否通过, 实际值], ...]，然后 return true/false。
// 这里不解析源码语义，只做两件事：把 checks 抓出来、把 ctx 的属性读取路径记下来。

// 策略里的 checks 是函数内的局部变量，外部拿不到；把它的声明改写成对外部变量赋值，
// 就能在策略 return 之后（try/finally 保证一定执行）把整张表捞出来。
// 只改写第一处声明——四个策略都只有一个 checks 变量；万一改写没命中，回退到解析 ctx.log 的输出文本。
const STRATEGY_CHECKS_DECL_RE = /\b(?:var|const|let)\s+checks\s*=/;
const STRATEGY_CODE_STORAGE_KEY = 'chart_strategy_diag_code';

// 历史回放的时间基准：策略里的年龄/新鲜度判断走 Date.now()，直接用浏览器当前时间的话，
// 几个月前的样本会被算成"年龄几个月"，年龄类 check 全线失败，回放结果就没有意义了。
// 把 Date 整个替换成"当下 = 快照抓取时刻"的版本（同时覆盖 Date.now() 和 new Date() 两种写法）。
const RealDate = Date;

// 策略有效性判定：不能只看中位数。
// meme 的收益极度右偏，价值几乎全在尾部——一个策略完全可能"把中位数抬高、同时把 100x 的票
// 全过滤掉"，那是最坏的结果，但只看中位数会判成"方向对"。所以同时看三个维度：
//   1) 中位数     —— 典型样本表现
//   2) 多档命中率 —— >2/>5/>10，>10 那档才真正代表能不能抓到大票
//   3) 大票捕获   —— 未命中组里有没有出现比命中组最大值还高的票（漏掉巨鲸是致命的）
// 三者不一致时明确指出来，而不是给一个笼统的"方向对/不对"。
function buildStrategyVerdict(hitRets, missRets) {
  if (!hitRets.length || !missRets.length) return '';
  const med = a => { const x = a.slice().sort((p, q) => p - q); const m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };
  const rateAt = (a, t) => a.length ? a.filter(v => v > t).length / a.length * 100 : NaN;
  const hitMed = med(hitRets), missMed = med(missRets);
  const hitMax = Math.max(...hitRets), missMax = Math.max(...missRets);
  const THRESHOLDS = [WIN_THRESHOLD, 5, 10];

  const rows = THRESHOLDS.map(t => {
    const h = rateAt(hitRets, t), m = rateAt(missRets, t);
    return { t, h, m, better: h > m };
  });
  // 判定不以中位数为主裁判——meme 收益是极端右尾分布，大部分样本挤在 1x 附近，
  // 中位数落在"输家区"几乎不动（本工具别处的注释早就写过"中位数会被分布形状骗"，
  // 早期版本的判定却把它当了第一优先级，导致"每条 check 都有效、整体却报警"的自相矛盾）。
  // 真正决定 meme 策略好坏的是【胜率】和【尾部捕获】。中位数只做脚注。

  // 胜率优势：命中组在 2x/5x/10x 三档里赢了几档（差异 > 1pp 才算，避免噪声）
  const winWins = rows.filter(r => Number.isFinite(r.h) && (r.h - (Number.isFinite(r.m) ? r.m : 0)) > 1).length;
  const winLoses = rows.filter(r => Number.isFinite(r.m) && ((Number.isFinite(r.h) ? r.h : 0) - r.m) < -1).length;
  const baseRow = rows[0];           // >2x 那档，最基础的胜率
  const baseBetter = Number.isFinite(baseRow.h) && Number.isFinite(baseRow.m) && baseRow.h > baseRow.m;
  // 漏掉大票：未命中组的最大值显著超过命中组（1.5 倍以上才算"显著漏"）
  const missedWhale = missMax > hitMax * 1.5;
  // 中位数差异：1% 以内视为持平——不足以支撑任何方向的结论
  const medRel = missMed !== 0 ? (hitMed - missMed) / Math.abs(missMed) : 0;
  const medTie = Math.abs(medRel) < 0.01;
  const medNote = medTie
    ? `中位数基本持平（${hitMed.toFixed(3)}x vs ${missMed.toFixed(3)}x）——大部分样本在 2x 以下，中位数落在输家区、参考价值低，不用纠结这 1% 的差。`
    : hitMed > missMed
      ? `中位数也占优（${hitMed.toFixed(3)}x vs ${missMed.toFixed(3)}x）。`
      : `中位数略低（${hitMed.toFixed(3)}x vs ${missMed.toFixed(3)}x），但 meme 看尾部不看中位数。`;

  let tone, headline;
  if (missedWhale && winLoses >= winWins) {
    // 既漏了巨鲸、胜率又没占到便宜 —— 真正的坏策略
    tone = 'var(--danger,#ff453a)';
    headline = `⚠️ 严重信号：被拦掉的样本里出现了 <b>${missMax.toFixed(1)}x</b>，远高于命中组的最高 ${hitMax.toFixed(1)}x，而且胜率也没占到便宜 —— 策略把最大的票挡在外面。`;
  } else if (winWins > winLoses && baseBetter) {
    // 胜率广泛占优 = 策略在起作用，哪怕中位数是平的
    tone = 'var(--ok,#30d158)';
    headline = `✓ 策略明显提升了胜率（&gt;2x：${baseRow.h.toFixed(1)}% vs ${baseRow.m.toFixed(1)}%，且在更高倍数档同样占优），过滤方向是对的。${medNote}`
      + (missedWhale ? `<br>唯一要留意：被拦样本里有个 <b>${missMax.toFixed(1)}x</b>（命中组最高 ${hitMax.toFixed(1)}x），检查是不是误伤了某个大票。` : '');
  } else if (winLoses > winWins) {
    // 胜率反向落后 —— 才是真正"拦掉的反而不比放行的差"
    tone = 'var(--warn,#ff9f0a)';
    headline = `⚠️ 命中组胜率【低于】未命中组（&gt;2x：${baseRow.h.toFixed(1)}% vs ${baseRow.m.toFixed(1)}%）——策略拦掉的反而不比放行的差，过滤条件值得重新审视。${medNote}`;
  } else {
    tone = 'var(--text-muted)';
    headline = `胜率与未命中组接近（&gt;2x：${baseRow.h.toFixed(1)}% vs ${baseRow.m.toFixed(1)}%），这套过滤没有明显改变样本质量。${medNote}`;
  }

  const cells = rows.map(r => `<td class="num">${Number.isFinite(r.h) ? r.h.toFixed(1) + '%' : '-'}</td><td class="num" style="color:var(--text-muted)">${Number.isFinite(r.m) ? r.m.toFixed(1) + '%' : '-'}</td>`).join('');
  return `<div class="hint" style="margin:0 0 10px; padding:8px 10px; border-radius:6px; background:var(--surface-2);">
    <div style="color:${tone}; margin-bottom:6px;">${headline}</div>
    <table class="desc-table" style="background:var(--surface); border-radius:6px;">
      <thead><tr><th>指标</th>${THRESHOLDS.map(t => `<th class="num" colspan="2">&gt;${t}x 命中率</th>`).join('')}<th class="num">中位数</th><th class="num">最高</th></tr></thead>
      <tbody>
        <tr><td><b>命中组</b>（n=${hitRets.length}）</td>${rows.map(r => `<td class="num" colspan="2"><b>${Number.isFinite(r.h) ? r.h.toFixed(1) + '%' : '-'}</b></td>`).join('')}<td class="num"><b>${hitMed.toFixed(3)}x</b></td><td class="num">${hitMax.toFixed(1)}x</td></tr>
        <tr><td>未命中组（n=${missRets.length}）</td>${rows.map(r => `<td class="num" colspan="2" style="color:var(--text-muted)">${Number.isFinite(r.m) ? r.m.toFixed(1) + '%' : '-'}</td>`).join('')}<td class="num" style="color:var(--text-muted)">${missMed.toFixed(3)}x</td><td class="num" style="color:${missedWhale ? 'var(--danger,#ff453a)' : 'var(--text-muted)'}">${missMax.toFixed(1)}x</td></tr>
      </tbody>
    </table>
    <div style="margin-top:6px; color:var(--text-muted)">未命中组样本量 ${missRets.length} 条${missRets.length < 30 ? '（偏少，各档比率波动很大，别据此下定论）' : ''}；此处未做显著性检验，差异可能来自抽样运气。</div>
  </div>`;
}

// 最近一次回放的命中组 returnMax 列表，供"放宽这一条值不值"做对照

// 从 check 的"实际值"字符串里抠出数字。策略常把辅助信息拼进去（如 "3.30(2657/804)"、
// "2.032x"），parseFloat 只取前导数字正好合适；纯文本（平台名等）返回 NaN，该 check 不参与扫描。

// 在单条样本上回放策略。ctx 用浅拷贝并注入 log 桩，避免策略往里写东西污染原始快照；
// Date 冻结在买入时刻（makeFrozenDate），否则策略里任何 Date.now() 都会读到运行时的“现在”，
// 那就是彻头彻尾的未来函数。
function runStrategyOnRow(compiled, row) {
  if (!row.rawCtx) return { error: '该样本没有原始 ctx（快照数据缺失），无法回放策略' };
  const seen = new Set();
  const logs = [];
  let captured = null;
  // ctx.log 是平台注入的，快照里没有，得自己补；同时 ctx 用浅拷贝，避免策略往里写东西污染原始快照
  const logShim = {
    error: (...a) => logs.push({ level: 'error', text: a.join(' ') }),
    success: (...a) => logs.push({ level: 'success', text: a.join(' ') }),
    info: (...a) => logs.push({ level: 'info', text: a.join(' ') }),
    warn: (...a) => logs.push({ level: 'warn', text: a.join(' ') }),
  };
  const baseCtx = Object.assign({}, row.rawCtx, { log: logShim });
  const nowMs = Number.isFinite(row.buyTimestamp) ? row.buyTimestamp * 1000 : RealDate.now();
  let passed, error = null;
  try {
    // f：按字段名取 features 值。用 getFeature 兼容点号路径（和分析里其它地方一致）。
    const fGet = name => getFeature(row, name);
    passed = compiled.fn(makeCtxRecorder(baseCtx, seen), fGet, makeFrozenDate(nowMs), c => { captured = c; });
  } catch (e) {
    error = `${e.name}: ${e.message}`;
  }
  // checks 没抓到（策略写法不符合约定）时，回退到 ctx.log 里那条"未命中 ... | 失败:xxx"文本，
  // 至少还能把失败原因原样展示出来，而不是整个功能失效
  const checks = Array.isArray(captured)
    // c[3] 是可选的"期望条件"文字（如 '< 10'）——本仓库较新的策略会带上它。有它就展示，
    // 否则光看"值=14"根本判断不出阈值是多少，阈值记混了也发现不了（真实踩过：把"创建者发币数<80"
    // 误当成"推特发币数<80"，实际代码是 <10，8 个样本被拦却以为是工具算错）。
    ? captured.map(c => ({ name: String(c[0]), ok: !!c[1], value: c[2] === undefined ? '' : String(c[2]), expect: c[3] === undefined ? '' : String(c[3]) }))
    : null;
  return { passed: !!passed, checks, logs, error, usedPaths: seen, nowMs };
}

// ---------- 打分版策略的逐因子聚合 ----------
// 硬 AND 策略的「通过/拦截/单点否决」语义对打分因子不成立：因子 0 分不拦人，只是少贡献分。
// 这里按【得分】口径重新聚合。识别方式：check 的期望文本形如 '满分 a~b 权重 w'
//（code-score.js 与「回测·因子」代码生成器都用这个固定格式），且存在名为 '总分' 的 check。
// 因子 check 的实际值形如 '12.34 → 5.2分' / '12.34 → -5.2分'（邪恶阵营命中危险区）/ '缺失 → 0.0分'，
// 从中解析出该因子的得分贡献（可正可负）。
// 期望文本前缀区分阵营：'满分 ...' = 勇者阵营（加分），'危险区 ...' = 邪恶阵营（减分）——
// 两种前缀都要认，否则邪恶阵营因子会被误判成非因子的硬否决行。
// 权重数字允许带负号——不是这个工具自己生成的策略代码（比如手工维护的 code-score.js）可能
// 把邪恶阵营也写成"满分"前缀、靠权重本身是负数来表达扣分（跟本工具"前缀分阵营、权重恒正"的
// 约定不是同一套写法）。权重正则不认负号的话，这类因子的 expect 匹配不上，会被整体判定成
// "不是打分因子"，进而在逐样本弹窗里被错误归进"硬否决未通过"——这是真实踩过的坑（Rizzmr 样本：
// shit_volume(分) 权重 -10，被显示成硬否决，实际是邪恶阵营打分因子只是这次没触发/贡献是 0）。
const SCORE_FACTOR_EXPECT_RE = /^(?:满分|危险区)\s.*权重\s*-?[\d.]+/;

// 解析单条打分因子 check（{name, ok, value, expect}）——两处都要用同一份解析：
// aggregateScoreStats 聚合全部样本算统计，StrategyReplay 的逐样本明细弹窗只解析当前这一行
// 给条形图用。抽成一个函数避免两处正则各写一份、以后改动脱节。
// 非因子 check（硬否决/总分）返回 null。
export function parseFactorCheck(c) {
  const expectStr = String(c.expect);
  if (!SCORE_FACTOR_EXPECT_RE.test(expectStr)) return null;
  const m = String(c.value).match(/→\s*(-?[\d.]+)\s*分/);
  const w = expectStr.match(/权重\s*(-?[\d.]+)/);
  const weight = w ? parseFloat(w[1]) : NaN;
  // 范围只解析核心区 [lo1,hi1]（生成代码的 expect 文案里只带了这半段，硬界 lo0/hi0 没编码进去）——
  // 对人读来说"满分/危险区落在哪个区间"就是这两个数，够用；三个字符类里含 Infinity 的字面量
  const range = expectStr.match(/^(?:满分|危险区)\s+(-?[\w.]+)~(-?[\w.]+)/);
  return {
    name: c.name.replace(/\(分\)$/, ''),
    contrib: m ? parseFloat(m[1]) : NaN,
    weight,
    missing: String(c.value).startsWith('缺失'),
    // "危险区"前缀无条件判邪恶；"满分"前缀但权重本身是负数（上面注释里那种手工写法）也算邪恶——
    // 不能只看前缀文字，两种写法都得认出来。
    camp: (/^危险区/.test(expectStr) || weight < 0) ? 'evil' : 'hero',
    coreLo: range ? range[1] : null,
    coreHi: range ? range[2] : null,
  };
}

export function aggregateScoreStats(results, winThreshold = WIN_THRESHOLD) {
  const rowsData = [];
  for (const r of results) {
    const res = r.res || {};
    if (res.error || !Array.isArray(res.checks)) continue;
    const totalCheck = res.checks.find(c => c.name === '总分');
    if (!totalCheck) continue;
    const score = parseFloat(totalCheck.value);
    const cutoff = parseFloat(String(totalCheck.expect).replace(/[^\d.-]/g, ''));
    const factors = [];
    let vetoOk = true;
    for (const c of res.checks) {
      if (c === totalCheck) continue;
      const parsed = parseFactorCheck(c);
      if (parsed) factors.push(parsed);
      else if (!c.ok) vetoOk = false;   // 非因子、非总分的 check = 硬否决行
    }
    if (!factors.length || !Number.isFinite(score) || !Number.isFinite(cutoff)) continue;
    rowsData.push({ ret: Number(r.row && r.row.returnMax), passed: !!res.passed, score, cutoff, vetoOk, factors,
      symbol: r.row && r.row.symbol, addr: r.row && r.row.tokenAddress, label: r.row && r.row.label });
  }
  if (!rowsData.length) return null;

  const cutoff = rowsData[0].cutoff;
  const wsum = rowsData[0].factors.reduce((a, f) => a + (Number.isFinite(f.weight) ? f.weight : 0), 0);

  // 差此一项/依赖此项要模拟"把某因子补满/删掉之后总分会变成多少"，必须按策略【真实的打分公式】
  // 重算——不能拿最终 score 去裸减一个原始贡献分。原因：策略可能是"原始累加分"(score=Σcontrib)，
  // 也可能是"归一化到 0~100"(score=Σcontrib/Σ正权重×100)，两种口径下"删掉一个因子"对总分的
  // 影响完全不同（归一化下分子分母一起变）。这里先给每行算好 rawTotal（贡献累加）和 posWeightSum
  // （正权重之和，= 归一化公式的分母），再探测策略用的是哪种口径。
  const rowAgg = rowsData.map(row => {
    let rawTotal = 0, posWeightSum = 0;
    for (const f of row.factors) {
      if (Number.isFinite(f.contrib)) rawTotal += f.contrib;
      if (Number.isFinite(f.weight) && f.weight > 0) posWeightSum += f.weight;
    }
    return { rawTotal, posWeightSum };
  });
  // 探测口径：两个已知模型各自用 rawTotal/posWeightSum 预测 score，只在两者预测明显不同的行上
  // 投票（wsum 恰好=100 时归一化和原始累加数值重合，这种行没区分力、不投票）。多数决。
  let normVotes = 0, rawVotes = 0;
  for (let i = 0; i < rowsData.length; i++) {
    const { rawTotal, posWeightSum } = rowAgg[i];
    const obs = rowsData[i].score;
    if (!Number.isFinite(obs) || posWeightSum <= 0) continue;
    const normPred = rawTotal / posWeightSum * 100;
    if (Math.abs(normPred - rawTotal) < 1e-6) continue; // 两模型重合，无区分力
    if (Math.abs(normPred - obs) < Math.abs(rawTotal - obs)) normVotes++; else rawVotes++;
  }
  const normalized = normVotes > rawVotes;
  // 给定"改动后的贡献累加分 + 改动后的分母"，按探测到的口径算这一行的新总分
  const scoreOf = (rawT, denom) => (normalized ? (denom > 0 ? rawT / denom * 100 : 0) : rawT);

  const stats = new Map();
  for (let ri = 0; ri < rowsData.length; ri++) {
    const row = rowsData[ri];
    const { rawTotal, posWeightSum } = rowAgg[ri];
    for (const f of row.factors) {
      if (!stats.has(f.name)) {
        stats.set(f.name, { name: f.name, weight: f.weight, camp: f.camp, coreLo: f.coreLo, coreHi: f.coreHi,
          n: 0, hitSum: 0, hitN: 0, missSum: 0, missN: 0,
          full: 0, zero: 0, missingN: 0, lackOne: 0, dependOn: 0,
          scoredWins: 0, scoredN: 0, zeroWins: 0, zeroN: 0, samples: [] });
      }
      const st = stats.get(f.name);
      if (!Number.isFinite(f.contrib)) continue;
      st.n++;
      // 均分对比只取 命中 vs 分低未命中：硬否决拦掉的盘分数可能很高（它是被否决的，
      // 不是分不够），混进 miss 组会把"未命中组均分"抬高，误导权重调整方向
      if (row.passed) { st.hitSum += f.contrib; st.hitN++; }
      else if (row.vetoOk) { st.missSum += f.contrib; st.missN++; }
      // 阵营对称的"满效应/无效应"判定：勇者阵营满效应=贡献拉满到 +weight（最好情况）；
      // 邪恶阵营满效应=贡献压到 -weight（最坏情况，危险区命中最深）。
      // 无效应统一按 |contrib|≈0 判——邪恶阵营的 contrib 本来就是负数或 0，不能用
      // "contrib<=1e-9" 这种只认非正数的旧判法，那会把"命中最深危险区(-weight)"也误判成"无效应"。
      const isFull = f.camp === 'evil' ? f.contrib <= -f.weight + 1e-9 : f.contrib >= f.weight - 1e-9;
      const isZero = Math.abs(f.contrib) <= 1e-9;
      if (isFull) st.full++;
      if (isZero) st.zero++;
      if (f.missing) st.missingN++;
      // 差此一项："把这一个因子补到本阵营最好情况，能不能过线"——勇者=补满到 +weight，
      // 邪恶=压到 0（不被判进危险区）。因子还留在数组里，分母(posWeightSum)不变，只有分子变。
      // 按 scoreOf 用策略真实口径算改动后的总分，而不是拿归一化后的 score 裸加一个原始贡献分。
      const bestCaseContrib = f.camp === 'evil' ? 0 : (Number.isFinite(f.weight) ? f.weight : 0);
      const bumpRawTotal = rawTotal + (bestCaseContrib - f.contrib);
      if (row.vetoOk && !row.passed && row.score < cutoff
          && scoreOf(bumpRawTotal, posWeightSum) >= cutoff) st.lackOne++;
      // 依赖此项：已命中，把这个因子整条【删掉】（不是留着归零）就跌破线——删掉意味着分子少它的
      // 贡献、分母也少它的正权重（归一化口径下这一点最关键，跟"留着但归零"结果不同）。
      // 邪恶阵营 contrib<=0，删掉只会让分数不降反升，scoreOf 结果不会 < cutoff，天然算不出依赖。
      const dropDenom = posWeightSum - (Number.isFinite(f.weight) && f.weight > 0 ? f.weight : 0);
      if (row.passed && scoreOf(rawTotal - f.contrib, dropDenom) < cutoff) st.dependOn++;
      // 得分组 vs 零分组的高倍率对比（>winThreshold），对应硬 AND 表的「效果」列
      if (Number.isFinite(row.ret)) {
        if (isZero) { st.zeroN++; if (row.ret > winThreshold) st.zeroWins++; }
        else { st.scoredN++; if (row.ret > winThreshold) st.scoredWins++; }
      }
      // 留一份逐样本明细（"区分效果"给"反向"这种负相关信号时，人工点开看是哪些具体的盘，
      // 不能只看一个汇总百分比就下结论——两组各自的样本列表才是真正拿去人工审核的东西）。
      st.samples.push({ symbol: row.symbol || '', addr: row.addr || '', ret: row.ret, contrib: f.contrib, isZero, label: row.label || null });
    }
  }
  const factors = [...stats.values()].map(st => ({
    name: st.name, weight: st.weight, camp: st.camp || 'hero', coreLo: st.coreLo, coreHi: st.coreHi, n: st.n,
    avgHit: st.hitN ? st.hitSum / st.hitN : NaN,
    avgMiss: st.missN ? st.missSum / st.missN : NaN,
    fullRate: st.n ? st.full / st.n : NaN,
    zeroRate: st.n ? st.zero / st.n : NaN,
    missingRate: st.n ? st.missingN / st.n : NaN,
    lackOne: st.lackOne, dependOn: st.dependOn,
    scoredWin: st.scoredN ? st.scoredWins / st.scoredN : NaN, scoredN: st.scoredN,
    zeroWin: st.zeroN ? st.zeroWins / st.zeroN : NaN, zeroN: st.zeroN,
    samples: st.samples,
  })).sort((a, b) => (b.weight || 0) - (a.weight || 0));

  const hits = rowsData.filter(r => r.passed);
  const scoreMiss = rowsData.filter(r => r.vetoOk && !r.passed);
  const vetoBlocked = rowsData.filter(r => !r.vetoOk && !r.passed).length;
  const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  return {
    cutoff, wsum, n: rowsData.length, hits: hits.length,
    vetoBlocked, scoreBlocked: scoreMiss.length,
    avgScoreHit: avg(hits.map(r => r.score)),
    avgScoreMiss: avg(scoreMiss.map(r => r.score)),
    factors,
  };
}

// 逐 check 汇总。币一多就看不出规律了，这里按 check 聚合：
//   pass/fail —— 哪一条最严
//   soleBlock —— 该样本【只】卡在这一条（放宽它就能直接多命中这么多个），最有行动价值
//   all —— 通过的样本也要记 value，否则没法扫“阈值卡在哪里区分度最好”（只有被拦的那侧搜不出来）
export function aggregateCheckStats(results) {
  const checkStats = new Map();
  // 注意元素形状是 { input, row, res }，命中/报错在 res 里。
  // 旧版误写成 r.passed / r.error（永远 undefined），命中数恒为 0——
  // 手动粘几个 CA 时恰好都未命中，一直没暴露，跑全量数据源才显出来。
  // 区分三种状态：跑通(ran) / 有逐条明细(withChecks) / 报错(errored)。
  // 关键修正：以前只把"有 checks 明细"的样本算进 valid，导致【在 checks 赋值前就 return 的样本】
  // （策略里常有前置 if(...) return false）从所有统计里消失——命中 0、未命中也是空、看板"暂无数据"。
  // 现在：胜率/中位数按【所有跑通的样本】算（提前退出的算未命中）；逐条明细只用有 checks 的。
  const ran = results.filter(r => r.res && !r.res.error);
  const valid = ran.filter(r => Array.isArray(r.res.checks));
  for (const { row, res } of valid) {
    const failedNames = res.checks.filter(c => !c.ok).map(c => c.name);
    const sole = failedNames.length === 1 ? failedNames[0] : null;
    for (const c of res.checks) {
      if (!checkStats.has(c.name)) {
        checkStats.set(c.name, { pass: 0, fail: 0, soleBlock: 0, blocked: [], all: [], expect: c.expect || '' });
      }
      const st = checkStats.get(c.name);
      st.all.push({ val: c.value, ret: row.returnMax, ok: c.ok });
      if (c.ok) st.pass++;
      else {
        st.fail++;
        st.blocked.push({ symbol: row.symbol || '', addr: row.tokenAddress || '',
          ret: row.returnMax, val: c.value, expect: c.expect || '', sole: sole === c.name });
      }
    }
    if (sole) checkStats.get(sole).soleBlock++;
  }
  // 每条 check 到底是"过滤掉差的"还是"误杀好的"：对比它【拦掉的样本】和【放行的样本】
  // 各自的胜率。st.all 里每条带 { ret, ok }，ok=是否通过这条 check。
  //   放行组胜率 > 拦掉组 → 这条在起正作用（拦掉的确实更差）
  //   拦掉组胜率 > 放行组 → 这条在帮倒忙，把赢家误杀了 → 标红提醒
  // 拦截数太少（<3）时不下"退步"结论——一两个样本的差异是噪声。
  const winRate = arr => arr.length ? arr.filter(a => a.ret > WIN_THRESHOLD).length / arr.length : NaN;
  const MIN_BLOCK_FOR_VERDICT = 3;
  const withEffect = st => {
    const passed = st.all.filter(a => a.ok);
    const blocked = st.all.filter(a => !a.ok);
    const passWin = winRate(passed);
    const blockWin = winRate(blocked);
    // 单点否决样本的胜负——这才是"松绑这条 check 能多抓什么"的真实边际。
    // 全部拦截的胜率被"还被别的 check 一起拦"的样本稀释了；单点否决是【只】卡这一条的，
    // 松绑它正好把这些放回来。所以判断一条 check 该不该留，看的是这批人是赢家还是输家。
    const soleRows = st.blocked.filter(b => b.sole);
    const soleWins = soleRows.filter(b => Number(b.ret) > WIN_THRESHOLD).length;
    st.soleTotal = soleRows.length;
    st.soleWins = soleWins;
    st.soleWinRate = soleRows.length ? soleWins / soleRows.length : NaN;
    // winLift > 0 = 放行组更能赢 = check 有效；< 0 = 拦掉的反而更能赢 = 退步
    const winLift = (Number.isFinite(passWin) && Number.isFinite(blockWin)) ? passWin - blockWin : NaN;
    let effect = 'neutral';
    if (st.fail === 0) effect = 'idle';                    // 什么都没拦，不起作用
    else if (st.fail >= MIN_BLOCK_FOR_VERDICT && Number.isFinite(winLift)) {
      if (winLift < -1e-9) effect = 'hurts';               // 拦掉的更能赢 → 退步
      else if (winLift > 1e-9) effect = 'helps';           // 放行的更能赢 → 有效
    }
    // 单点否决里赢家过半，且松绑能明显提升——即使全局看"有效"，边际上这条也在误杀。
    // 这是比全局 effect 更该盯的信号：它直接说"松绑这条 check 能净赚赢家"。
    // 需要 ≥3 个单点否决才下判断，1-2 个是噪声。
    st.soleHurts = st.soleTotal >= MIN_BLOCK_FOR_VERDICT
      && Number.isFinite(st.soleWinRate) && st.soleWinRate > 0.5;
    return { ...st, passWin, blockWin, winLift, effect };
  };
  const ranked = [...checkStats.entries()].map(([name, st]) => ({ name, ...withEffect(st) }))
    .sort((a, b) => b.soleBlock - a.soleBlock || b.fail - a.fail);
  const hitRets = ran.filter(r => r.res.passed).map(r => Number(r.row.returnMax)).filter(Number.isFinite);
  const missRets = ran.filter(r => !r.res.passed).map(r => Number(r.row.returnMax)).filter(Number.isFinite);
  // 提前退出（跑通但没产出 checks 明细）的样本：它们大多是未命中，收集一批"退出原因"
  // （策略里 ctx.log.error 写的文本）供界面展示——回答用户的"就算没命中也要有拦截日志"。
  const noChecks = ran.filter(r => !Array.isArray(r.res.checks));
  const noChecksMiss = noChecks.filter(r => !r.res.passed).length;
  const noCheckReasons = [];
  for (const r of noChecks) {
    const errLog = (r.res.logs || []).filter(l => l.level === 'error' || l.level === 'warn');
    const text = errLog.length ? errLog.map(l => l.text).join(' ') : (r.res.passed ? '通过但未产出 checks' : '在 checks 赋值前就 return 了');
    if (noCheckReasons.length < 5) noCheckReasons.push({ symbol: r.row.symbol || '', addr: r.row.tokenAddress || '', ret: r.row.returnMax, reason: text.slice(0, 120) });
  }
  // 未命中账拆开（只统计有 checks 明细的那部分——提前退出的没有逐条信息）
  let soleBlocked = 0, multiBlocked = 0;
  for (const { res } of valid) {
    if (res.passed) continue;
    const failN = res.checks.filter(c => !c.ok).length;
    if (failN === 1) soleBlocked++;
    else if (failN >= 2) multiBlocked++;
  }
  return { ranked, checkStats, hitRets, missRets,
    total: results.length,
    valid: ran.length,                     // 跑通的样本数（含提前退出的）
    withChecks: valid.length,              // 有逐条 check 明细的
    noChecks: noChecks.length,             // 跑通但没产出 checks（提前 return）
    noChecksMiss, noCheckReasons,
    errored: results.filter(r => r.res && r.res.error).length,
    hits: hitRets.length, soleBlocked, multiBlocked };
}

// computeVIFs 收的是【已标准化的列】+ 行数，直接拿行数据调用会得到一堆 null。
// 这里包一层：从 rows 里取完整个案、标准化、算 VIF，返回按严重程度排序的结果。
//
// 两个必须处理的前提：
// 1) 只能用【完整个案】（所有字段都有值的行）。缺值字段各自不同会让不同列的样本集不一致，
//    算出来的相关结构没有意义。
// 2) 零方差列必须先剔除——标准化时会除以 0，整个线性方程组直接崩掉。
export function collinearityReport(rows, fields) {
  const cols = fields.map(f => ({ field: f, raw: [] }));
  let n = 0;
  for (const r of rows) {
    const vals = fields.map(f => {
      const v = getFeature(r, f);
      if (v === undefined || v === null || v === '') return NaN;
      return Number(v);
    });
    if (vals.some(v => !Number.isFinite(v))) continue;   // 完整个案
    vals.forEach((v, i) => cols[i].raw.push(v));
    n++;
  }
  if (n < fields.length + 5) {
    return { error: `完整个案仅 ${n} 条，少于字段数+5，无法评估共线性`, n };
  }
  const usable = [], dropped = [];
  for (const c of cols) {
    const st = standardize(c.raw);
    if (!(st.std > 1e-12)) { dropped.push(c.field); continue; }  // 零方差
    usable.push({ field: c.field, z: st.z });
  }
  if (usable.length < 2) return { error: '可用字段少于 2 个，无法评估共线性', n, dropped };
  const vifs = computeVIFs(usable, n);
  const results = usable.map((c, i) => ({ field: c.field, vif: vifs[i] }))
    .sort((a, b) => (b.vif === Infinity ? 1e18 : b.vif) - (a.vif === Infinity ? 1e18 : a.vif));
  return { n, results, dropped };
}

export {
  runStrategyOnRow,
  sanitizeForFieldName,
  standardizeWith,
  standardize,
  percentileRankOf,
  aucVerdict,
  parseCheckNumber,
  parseCheckDirection,
  computeQuantileBreakpoints,
  solveLinearSystem,
  computeVIFs,
  makeFrozenDate,
  makeCtxRecorder,
  compileStrategy,
  scanCheckThreshold,
  buildStrategyVerdict,
};
