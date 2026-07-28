// 阵营库：从散点图里看出"这个字段这个区间像是有信号"时，先收藏下来（字段/阵营/区间/权重），
// 不用当场决定要写进哪一份策略代码。跟 labels.js 一样按 localStorage 存，是"公开"的收藏夹——
// 不属于任何一份具体策略，不会随策略代码走，可以被发送到"策略"tab 变成任意一份正在编辑的
// 策略里的一行打分因子 check。

const STORAGE_KEY = 'chart_camp_library_v1';
const ACTIVE_GROUP_KEY = 'chart_camp_active_group_v1';

// 收藏没标分组时归到这个默认组。老收藏（v1，没有 group 字段）也一律当成这个组，
// 用户可以把它改名成"强势盘v1"之类，把上一轮测出来的因子归拢到一起。
export const DEFAULT_CAMP_GROUP = '未分组';

// 一条收藏属于哪个分组：显式 group 优先（去空白），没有就是默认组。
export function campGroupOf(entry) {
  const g = entry && entry.group;
  return g != null && String(g).trim() !== '' ? String(g).trim() : DEFAULT_CAMP_GROUP;
}

// 按 field+camp 去重：同一字段同一阵营只留一条，多条时留 addedAt 最新的那条。
// addCampEntry 改成 upsert 之后新收藏不会再产生重复，这里是清掉历史已经攒下的重复
// （比如这个修复上线前反复从图表收藏同一字段攒出来的那些）。
export function dedupeCampEntries(list) {
  const byKey = new Map();
  for (const e of list || []) {
    const key = e.field + ':' + (e.camp === 'evil' ? 'evil' : 'hero');
    const prev = byKey.get(key);
    if (!prev || (e.addedAt || 0) >= (prev.addedAt || 0)) byKey.set(key, e);
  }
  return list.filter(e => byKey.get(e.field + ':' + (e.camp === 'evil' ? 'evil' : 'hero')) === e);
}

export function loadCampLibrary() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? dedupeCampEntries(arr) : [];
  } catch { return []; }
}

export function saveCampLibrary(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* 隐私模式 */ }
}

// "新增归入哪个分组"是个跨会话的偏好——图表里收藏新因子时默认落进这个组，单独存一个 key。
export function loadCampActiveGroup() {
  try { return localStorage.getItem(ACTIVE_GROUP_KEY) || DEFAULT_CAMP_GROUP; } catch { return DEFAULT_CAMP_GROUP; }
}
export function saveCampActiveGroup(name) {
  try { localStorage.setItem(ACTIVE_GROUP_KEY, name || DEFAULT_CAMP_GROUP); } catch { /* 隐私模式 */ }
}

// 同一字段同一阵营再次收藏＝更新，不再插入新的一条——反复从图表收藏同一字段（比如换了个时间段
// 重新看区间）以前会一直堆重复行，现在就地覆盖 lo/hi/weight/note，分组和 id 保留原来那条的
// （不会因为重新收藏而被挪到别的分组），addedAt 刷新成本次时间。
export function addCampEntry(list, entry) {
  const camp = entry.camp === 'evil' ? 'evil' : 'hero';
  const idx = list.findIndex(x => x.field === entry.field && (x.camp === 'evil' ? 'evil' : 'hero') === camp);
  if (idx >= 0) {
    const prev = list[idx];
    const updated = {
      ...prev,
      lo: entry.lo,
      hi: entry.hi,
      weight: Number.isFinite(entry.weight) ? entry.weight : prev.weight,
      note: entry.note || prev.note,
      addedAt: Date.now(),
    };
    const next = [...list];
    next[idx] = updated;
    return next;
  }
  const item = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    field: entry.field,
    camp,
    lo: entry.lo,
    hi: entry.hi,
    weight: Number.isFinite(entry.weight) ? entry.weight : 10,
    group: entry.group != null && String(entry.group).trim() !== '' ? String(entry.group).trim() : DEFAULT_CAMP_GROUP,
    note: entry.note || '',
    addedAt: Date.now(),
  };
  return [item, ...list];
}

export function removeCampEntry(list, id) {
  return list.filter(x => x.id !== id);
}

// 批量删除：一次性过滤掉所有 ids，供"一键删除"用。不能用循环调用 removeCampEntry 实现——
// 调用方那层 setState 每次都是基于同一份闭包里的旧 list 算 next，循环调多次只有最后一次生效，
// 前面几条删除会被悄悄吞掉。
export function removeCampEntries(list, ids) {
  const idSet = new Set(ids);
  return list.filter(x => !idSet.has(x.id));
}

// 按分组归拢收藏，给界面渲染分组表用。extraGroups 传"名单里有、但还没收藏落进去"的空分组
// （比如刚建好、准备往里收东西的当前分组），好让它也能显示出来。返回 [{ group, entries, count }]，
// 按收藏数降序（多的排前面），同组内保留原顺序（新收藏在前）。
export function groupCampEntries(list, extraGroups = []) {
  const byGroup = new Map();
  for (const g of extraGroups) if (g && !byGroup.has(g)) byGroup.set(g, []);
  for (const e of list || []) {
    const g = campGroupOf(e);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(e);
  }
  return [...byGroup.entries()]
    .map(([group, entries]) => ({ group, entries, count: entries.length }))
    .sort((a, b) => b.count - a.count || (a.group < b.group ? -1 : 1));
}

// 分组改名：把所有属于 from 组的收藏改成 to 组（老收藏 group 为空、算作默认组的也一并迁移）。
export function renameCampGroup(list, from, to) {
  const target = to != null && String(to).trim() !== '' ? String(to).trim() : DEFAULT_CAMP_GROUP;
  return (list || []).map(e => (campGroupOf(e) === from ? { ...e, group: target } : e));
}

// 把指定 id 的收藏挪到某个分组。
export function moveCampEntriesToGroup(list, ids, to) {
  const idSet = new Set(ids);
  const target = to != null && String(to).trim() !== '' ? String(to).trim() : DEFAULT_CAMP_GROUP;
  return (list || []).map(e => (idSet.has(e.id) ? { ...e, group: target } : e));
}

// ── 高倍落点校验 ───────────────────────────────────────────────────────────────
// "高倍阈值"（returnMax > 阈值 才算高倍）按【分组】设置一个，整组共用——同一批收藏
// （比如一轮策略测出来的）看的是同一个倍数口径，不用每条单独调。缺省 2x。
export const CAMP_WIN_THRESHOLDS = [2, 3, 5, 10];
export const DEFAULT_CAMP_WIN_THRESHOLD = 2;

const GROUP_THRESHOLDS_KEY = 'chart_camp_group_thresholds_v1';
// 分组 → 高倍阈值 的映射，单独存一个 key（跨会话记住）。
export function loadCampGroupThresholds() {
  try { const raw = localStorage.getItem(GROUP_THRESHOLDS_KEY); const o = raw ? JSON.parse(raw) : {}; return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}
export function saveCampGroupThresholds(map) {
  try { localStorage.setItem(GROUP_THRESHOLDS_KEY, JSON.stringify(map || {})); } catch { /* 隐私模式 */ }
}
// 取某个分组的高倍阈值：没设过回落默认。
export function campGroupThresholdOf(map, group) {
  const t = map && Number(map[group]);
  return Number.isFinite(t) && t > 0 ? t : DEFAULT_CAMP_WIN_THRESHOLD;
}
export function setCampGroupThreshold(map, group, winThreshold) {
  return { ...(map || {}), [group]: winThreshold };
}
// 用实测高倍落点区间修正一条收藏的区间（"修正"按钮点了之后写回）。
export function applyCampEntryInterval(list, id, lo, hi) {
  return (list || []).map(e => (e.id === id ? { ...e, lo, hi } : e));
}

// 保存区间里 null 表示该侧开区间；跟实测区间比时对齐成 ±Infinity。
function normBound(v, openVal) { return v === null || v === undefined ? openVal : Number(v); }

// 保存的区间 vs 数据实测的"高倍落点区间"是否有实质变化。tol 是相对容差（默认 15%），
// 避免 9.8 vs 10 这种四舍五入被判成"变了"；任一侧从开区间变成有界（或反之）都算变化。
// saved: { lo, hi }（null=开），data: { lo, hi }（±Infinity=开，来自 findHotInterval/findColdInterval）。
export function intervalChanged(saved, data, tol = 0.15) {
  const sLo = normBound(saved.lo, -Infinity), sHi = normBound(saved.hi, Infinity);
  const cmp = (a, b) => {
    const aFin = Number.isFinite(a), bFin = Number.isFinite(b);
    if (aFin !== bFin) return true;                 // 一侧开、一侧闭 → 变了
    if (!aFin) return a !== b;                       // 都是 ±Infinity，正负不同才算变
    const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
    return Math.abs(a - b) / scale > tol;
  };
  return cmp(sLo, data.lo) || cmp(sHi, data.hi);
}

// 实测区间的边界写回收藏时的取整：开区间→null，否则保留 4 位有效数字（去掉长小数尾巴）。
export function roundCampBound(v) {
  if (!Number.isFinite(v)) return null;
  return Number(v.toPrecision(4));
}

// 把源码里插入一行 check——跟 StrategyReplay 的"按字段追加条件"用的是同一个"找 checks 声明"
// 的兜底策略：找不到声明就顺手补一个最小骨架，保证插入后代码仍然能跑。
export function insertLineIntoStrategySrc(src, line) {
  const declRe = /((?:var|const|let)\s+checks\s*=\s*\[)/;
  // 插入行后面必须补换行——原来紧跟 "[" 的内容（哪怕只是收尾的 "]"，比如 const checks = []
  // 这种先声明空数组、再用 for 循环 push 的写法）不能被粘到插入行的行尾，否则后面按行删除
  // 这条 check 时会连着把收尾的 "]" 一起删掉，数组从此不闭合。
  if (declRe.test(src)) return src.replace(declRe, `$1\n${line}\n`);
  return `const checks = [\n${line}\n];\nreturn checks.every(c => c[1]);\n` + (src ? '\n' + src : '');
}

// lo/hi 可能是 null（"只设下限/上限"，ScatterCard 三选一里选了单边）——JSON 存储不能用字面量
// Infinity（JSON.stringify(Infinity) 会变成 null，反而混淆），所以阵营库记录里统一用 null 表示
// "这一侧没有边界"，到生成代码这一步才翻译成真正的 -Infinity/Infinity 字面量。
const boundText = (v, fallback) => (v === null || v === undefined ? fallback : String(v));

// 因子行的标签：用完整字段名，只去掉会破坏 JS 字符串/正则的中文标点，不做长度截断。
// 标签会进打分因子表当显示名、也是 getFieldDesc 查描述的 key——截断会让描述查不到（见
// buildAllChecksRow/buildCampCheckLine 的注释）。字段名里本来就没有这些标点，replace 一般是空转，
// 只是防手工传进来的带标点的自定义字段名。
const fieldLabel = field => (String(field).replace(/[，。：（）"']/g, '') || String(field));

// 把一条阵营库记录翻译成策略代码里的一行打分因子 check——expect 文案要匹配
// parseFactorCheck 认得的 "满分/危险区 lo~hi 权重 w" 格式（见 proAnalytics.js），
// 这样发送到策略之后回放看板能自动把它归到对应阵营的因子表里。
// 条件默认是【区间】（lo<=x<=hi），lo/hi 为 null 时那一侧不设边界（只留单边判断）。
export function buildCampCheckLine(entry) {
  const { field, camp, lo, hi, weight } = entry;
  // 用完整字段名当标签——不再截断到 20 字符：截断后（如 chip_analysis.above_below_ratio →
  // chip_analysis.above_）打分因子表里查字段描述会失败，提示退化成逐词硬翻。字段名只是标签
  // 字符串，多长都不影响判定/正则匹配，留全名让 getFieldDesc 能查到描述。
  const label = fieldLabel(field);
  const parts = [];
  if (lo !== null && lo !== undefined) parts.push(`f('${field}') >= ${lo}`);
  if (hi !== null && hi !== undefined) parts.push(`f('${field}') <= ${hi}`);
  const cond = parts.length ? parts.join(' && ') : 'true';
  const prefix = camp === 'evil' ? '危险区' : '满分';
  const sign = camp === 'evil' ? '-' : '';
  const loText = boundText(lo, '-Infinity'), hiText = boundText(hi, 'Infinity');
  return `  ["${label}(分)", ${cond}, (f('${field}')==null?'缺失':f('${field}')) + ' → ' + (${cond} ? ${sign}${weight} : 0).toFixed(1) + '分', "${prefix} ${loText}~${hiText} 权重 ${weight}"],`;
}

// 这份策略是不是"强势盘"那种 ALL_CHECKS + VETO_NAMES 架构（see code-score.js）——
// 检测方式很直接：源码里有没有 ALL_CHECKS 声明。这类架构的真实总分只认 ALL_CHECKS 数组里的行
// （被 for 循环读到、真正 total += s*weight），buildCampCheckLine 生成的独立 tuple 不管长得
//多像"打分因子"，都不会被那个循环碰到，代码真跑出来贡献恒为 0——这就是"加了因子、总分却总是 0"
// 的根源。检测到这个架构就该往 ALL_CHECKS 里加一行，而不是走独立 tuple 那条路。
const ALL_CHECKS_DECL_RE = /((?:var|const|let)\s+ALL_CHECKS\s*=\s*\[)/;
export function hasAllChecksArchitecture(src) {
  return ALL_CHECKS_DECL_RE.test(src);
}

// ALL_CHECKS 每行是 [name, value, weight, lo0, lo1, hi1, hi0, actualOverride, expectOverride]，
// 用的是 trap() 梯形打分（见 code-score.js）；这里统一写成 lo0=lo1、hi1=hi0 的零宽度写法——
// 退化成普通阶跃：区间内满分，区间外 0 分，跟阵营库"圈一段区间"的语义直接对应，不用额外算过渡带。
// value 用 f('field') 取值——f 是 compileStrategy 注入进函数作用域的，ALL_CHECKS 数组字面量
// 里能直接调用。危险区（evil）用负权重实现："命中危险区" 时 s=1，total += -|weight| 是实打实扣分；
// 没命中时 s=0，贡献是 0（不额外加分）——不用改这条策略自己的 for 循环就能支持扣分语义。
// 支持两种入参：
//   - 阵营库单区间：{lo, hi} → 写成 lo0=lo1=lo、hi1=hi0=hi 的零宽度阶跃（区间内满分、外 0）；
//   - 找因子因子池：{lo0, lo1, hi1, hi0} → 原样写四点梯形（带过渡带），忠实搬运找因子挖出的形状。
export function buildAllChecksRow({ field, camp, lo, hi, lo0, lo1, hi1, hi0, weight, label: labelOverride }) {
  const label = labelOverride || fieldLabel(field);
  const w = camp === 'evil' ? -Math.abs(weight) : Math.abs(weight);
  const has4 = lo0 !== undefined || lo1 !== undefined || hi1 !== undefined || hi0 !== undefined;
  const lo0T = boundText(has4 ? lo0 : lo, '-Infinity');
  const lo1T = boundText(has4 ? lo1 : lo, '-Infinity');
  const hi1T = boundText(has4 ? hi1 : hi, 'Infinity');
  const hi0T = boundText(has4 ? hi0 : hi, 'Infinity');
  return `  ['${label}', f('${field}'), ${w}, ${lo0T}, ${lo1T}, ${hi1T}, ${hi0T}, null, '${lo1T}~${hi1T}'],`;
}

// 插入到 ALL_CHECKS 数组里——跟 insertLineIntoStrategySrc 一样，换行必须紧跟在插入行后面，
// 不能把原来紧跟 "[" 的内容粘到插入行行尾（同样的教训：粘住之后按行删除会带走不该删的内容）。
// 调用方应该先用 hasAllChecksArchitecture 探测过，探测不到就没有 ALL_CHECKS 可插，直接返回 null。
export function insertIntoAllChecks(src, row) {
  if (!ALL_CHECKS_DECL_RE.test(src)) return null;
  return src.replace(ALL_CHECKS_DECL_RE, `$1\n${row}\n`);
}

// 判断某个字段是不是已经在源码里加过 check 了——两种都要拦：
//   1) 已经是硬性条件（VETO_NAMES 里一票否决）：能走到打分环节的样本必然全部满足它，
//      再加成打分项毫无区分度，纯属误加。
//   2) 已经是打分项/普通 check 了（不管在 ALL_CHECKS 里还是独立 tuple 里）：重复添加只会
//      撞出两行同名/同字段的 check，行为以谁在数组里更靠后生效为准，容易让人以为改了
//      权重/区间却没生效，还不如干脆不让加。
// 只识别本工具自己生成的行（value 引用是 f('字段名') 这种字面量调用）——手写的 ctx 取值表达式
// （比如 num(dev.top_10_holder_rate)）认不出来对应哪个分析字段，宁可不拦，也不做不可靠的匹配。
// 返回 { name, isVeto }：name 是源码里这一行自己的标签（不一定等于 field，因为标签可能是
// 中文描述），isVeto 表示这一行是不是硬性条件。
export function findFieldConflict(src, field) {
  const vetoMatch = src.match(/VETO_NAMES\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/);
  const vetoNames = new Set();
  if (vetoMatch) {
    const nameRe = /['"]([^'"]+)['"]/g;
    let nm;
    while ((nm = nameRe.exec(vetoMatch[1]))) vetoNames.add(nm[1]);
  }

  const escaped = String(field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldRefRe = new RegExp(`f\\(\\s*['"]${escaped}['"]\\s*\\)`);
  const rowNameRe = /^\s*\[\s*['"]([^'"]+)['"]/;
  for (const line of src.split('\n')) {
    if (!fieldRefRe.test(line)) continue;
    const m = line.match(rowNameRe);
    const name = m ? m[1] : field;
    return { name, isVeto: vetoNames.has(name) };
  }
  return null;
}

// 按字段删掉它对应的那一行 check（匹配 f('字段')）——供"发送到策略"做 upsert（先删旧行再插新行）。
// 本工具生成的 check 都是单行 tuple，且只有 check 行会出现 f('字段')，逐行删安全。返回 {next, removed}。
export function removeCheckLineByField(src, field) {
  const escaped = String(field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fieldRefRe = new RegExp(`f\\(\\s*['"]${escaped}['"]\\s*\\)`);
  const lines = String(src).split('\n');
  const kept = lines.filter(line => !fieldRefRe.test(line));
  return { next: kept.join('\n'), removed: lines.length - kept.length };
}

// 解析源码里的 VETO_NAMES 硬否决名单（跟 findFieldConflict 里同一套读法）
export function parseVetoNames(src) {
  const m = String(src).match(/VETO_NAMES\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/);
  const names = new Set();
  if (m) { const re = /['"]([^'"]+)['"]/g; let nm; while ((nm = re.exec(m[1]))) names.add(nm[1]); }
  return names;
}

// 「找因子 → 发送到策略」整体替换打分段：
//   - 保留 VETO_NAMES 里的硬否决行（哪怕它们也用 f('字段') 取值，靠名字判定，绝不误删）；
//   - 删掉其余"本工具生成的打分行"（value 是 f('字段') 且名字不在 VETO_NAMES 里）；
//   - 把因子池整体写成新的 ALL_CHECKS 打分行（带真实梯形四点 + 真实权重，负权重=邪恶阵营扣分）；
//   - 可选把 const CUTOFF 同步成找因子的触发阈值。
// factors: [{field, camp, weight, lo0, lo1, hi1, hi0}]（就是 FactorLab 的因子池）。
// 返回 { next, removed, inserted, cutoffSynced } 或 { error }。
// 注意：只删 f('字段') 形态的打分行——手写 ctx 表达式的打分行认不出、不动（跟 removeCheckLineByField 同口径）。
export function replaceScoreRowsInAllChecks(src, factors, { cutoff } = {}) {
  if (!hasAllChecksArchitecture(src)) {
    return { error: '当前策略不是 ALL_CHECKS 架构（没找到 const ALL_CHECKS = [...]），无法自动替换打分段。请先在「策略」tab 放一份 ALL_CHECKS 架构的基础策略（含硬否决段）。' };
  }
  const veto = parseVetoNames(src);
  // 打分行特征：行首是 [ '名称', f( ...；名字不在 VETO_NAMES 里才算打分行（VETO 行一律保留）
  const rowRe = /^\s*\[\s*['"]([^'"]+)['"]\s*,\s*f\(/;
  const lines = String(src).split('\n');
  let removed = 0;
  const kept = lines.filter(line => {
    const m = line.match(rowRe);
    if (m && !veto.has(m[1])) { removed++; return false; }
    return true;
  });
  let next = kept.join('\n');
  const rows = (factors || []).map(f => buildAllChecksRow({
    field: f.field, camp: f.camp, weight: f.weight, lo0: f.lo0, lo1: f.lo1, hi1: f.hi1, hi0: f.hi0,
  }));
  if (rows.length) next = next.replace(ALL_CHECKS_DECL_RE, `$1\n${rows.join('\n')}\n`);
  let cutoffSynced = false;
  if (cutoff !== undefined && cutoff !== null) {
    const cutRe = /((?:var|const|let)\s+CUTOFF\s*=\s*)(-?\d+(?:\.\d+)?)/;
    if (cutRe.test(next)) { next = next.replace(cutRe, `$1${cutoff}`); cutoffSynced = true; }
  }
  return { next, removed, inserted: rows.length, cutoffSynced };
}

// 批量把权重数字写回源码——在源码文本里找 ['字段名', ... , 权重数字, ... 这一行，替换权重数字。
// 只动权重（第 3 个数字），不碰区间/lo0/lo1/hi1/hi0——区间形状改动风险更高。
// 只认 ALL_CHECKS 行的形状（单引号，权重是数组第 3 个干净的数字元素）——独立 tuple 那种写法
// 权重是嵌在一个大表达式里的（cond ? weight : 0 连同 expect 文案里也有一份），没有一个干净的
// "第三个元素就是权重数字"的位置，硬套同样的正则容易替换错——万一匹配到 cond 表达式里的阈值
// 数字，改的就不是权重、是判断条件了，比"匹配不上"更危险。
// weightList: [{name, weight}]（字段名 + 目标权重值）。返回替换后的源码 + 实际命中的条数——
// 调用方拿命中数判断要不要提示"代码里没找到这些字段对应的行"。
export function applyWeightsToSrc(src, weightList) {
  let next = src;
  let appliedCount = 0;
  for (const f of weightList) {
    const escaped = f.name.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&');
    const re = new RegExp(`(\\['${escaped}',[^\\n]*?,\\s*)(-?\\d+(?:\\.\\d+)?)(\\s*,)`);
    if (re.test(next)) { next = next.replace(re, `$1${f.weight}$3`); appliedCount++; }
  }
  return { next, appliedCount };
}

// 从源码里删掉一条 check 行——纯函数版本（StrategyReplay 里那份 removeCheckFromCode 的逻辑
// 抽出来，好让"试算"和"批量应用"都复用，同时返回删掉的那一整行文本，供"加回来"用）。
// candidates 是候选标签数组（打分因子可能带 "(分)" 后缀、也可能不带，见 removeCheckFromCode 注释），
// 逐个试，命中一个就停。删除同样按括号计数只删这条 tuple 本身，不误伤后面粘着的收尾 "]"
// （历史事故：整行删把数组收尾括号一起带走了，编译报 Unexpected token）。
// 返回 { next, removedLine }：removedLine 是被删掉的那条 tuple 原文（trim 过），没删到则 removedLine=null。
export function removeCheckLineFromSrc(src, candidates) {
  for (const label of candidates) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^(\\s*)\\[["']${escaped}["']`);
    const lines = src.split('\n');
    let removed = false, removedLine = null;
    const kept = [];
    for (const l of lines) {
      const m = l.match(re);
      if (!m) { kept.push(l); continue; }
      const startIdx = l.indexOf('[', m[1].length);
      let depth = 0, endIdx = -1, inStr = null;
      for (let i = startIdx; i < l.length; i++) {
        const ch = l[i];
        if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
        if (ch === '[') depth++;
        else if (ch === ']') { depth--; if (depth === 0) { endIdx = i; break; } }
      }
      if (endIdx === -1) { removed = true; removedLine = l.trim(); continue; }
      removed = true;
      removedLine = l.slice(startIdx, endIdx + 1).trim(); // 只截 tuple 本身，不含后面粘着的内容
      const rest = l.slice(endIdx + 1).replace(/^\s*,/, '');
      if (rest.trim()) kept.push(rest);
    }
    if (removed) return { next: kept.join('\n'), removedLine };
  }
  return { next: src, removedLine: null };
}

// 把删掉的因子行原样加回源码——"已删因子回收站"的加回来按钮用。line 是 removeCheckLineFromSrc
// 截出来的 tuple 原文（不含结尾逗号），这里补上逗号再插：源码里是 ALL_CHECKS 架构就插进 ALL_CHECKS，
// 否则插进 checks 数组。位置无所谓（打分不看行顺序），插在数组声明后第一行最省事、也最不容易出错。
export function reAddFactorLine(src, line) {
  const row = '  ' + (/,\s*$/.test(line) ? line : line + ',');
  if (hasAllChecksArchitecture(src)) {
    const next = insertIntoAllChecks(src, row);
    if (next) return next;
  }
  return insertLineIntoStrategySrc(src, row);
}

// 把一整套调权建议（要调的权重 + 要删的因子）一次性套进源码，返回改完的代码 + 实际发生了什么——
// 给"试算"和"确认应用"共用同一套改法，保证试算时看到的 next 就是应用时写回去的 next，不会两套逻辑跑偏。
// changeSet: { adjusts: [{name, weight}], removes: [{name, candidates}] }
//   （removes 里每条自带 candidates 候选标签数组，调用方按 isFactor 拼好——见 StrategyReplay）
// 返回 { next, adjustedCount, removedLines: [{name, line}] }：removedLines 供"加回来"回收站记录原文。
export function applyChangeSetToSrc(src, changeSet) {
  const { adjusts = [], removes = [] } = changeSet || {};
  let next = src;
  let adjustedCount = 0;
  if (adjusts.length) {
    const r = applyWeightsToSrc(next, adjusts);
    next = r.next; adjustedCount = r.appliedCount;
  }
  const removedLines = [];
  for (const rm of removes) {
    const { next: after, removedLine } = removeCheckLineFromSrc(next, rm.candidates);
    if (removedLine != null) { next = after; removedLines.push({ name: rm.name, line: removedLine }); }
  }
  return { next, adjustedCount, removedLines };
}
