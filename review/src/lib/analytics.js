// 由 js/charts.js 机械抽出的纯统计计算：峰值检测的置换检验、断点解析、MDE 等。
// 只搬了【不读任何全局状态】的函数，函数体一行未改。读 activeRows / chartSettings 的
// 那批（scanFieldsForPeaks / mineBreakpointsOOS / buildBinBarAiReport 等）留在原处，
// 等对应 React 组件落地时把状态改成入参再搬，那时才有办法做差分验证。
import { WIN_THRESHOLD, benjaminiHochbergAdjust, percentile, rankAuc, wilsonInterval } from './utils.js';
import { getFeature, isFiniteNumber } from './data.js';

// ---------- 常用字段集体检测 ----------
// 逐个字段跑上面那套置换检验，把"确实存在非噪声波峰"的字段挑出来，省去一个个手动试。
// 关键：这里同时检验几十个字段，本身又是一次多重比较——46 个字段纯随机也会有 2~3 个 p<0.05，
// 所以对所有字段的置换 p 再做一次 BH-FDR 校正，只有校正后仍显著的才标为可用。
// permN 的下限由字段数决定：置换 p 的最小可能值是 1/(permN+1)，而 BH 校正在最好情况下要求
// 原始 p < 0.05/m（m = 字段数）。若 permN 不够，即使效应极强、置换中一次都没被超过，
// p 也只能触底在 1/(permN+1)，乘以 m 之后必然 >0.05——真信号会被数学上判死。
// 实测：43 个字段 × 200 次置换，一个"最长区段 73 vs 随机 23"的强信号照样被判不通过。
// 所以按字段数自动抬高置换次数，取 m/0.04 留出余量。
function requiredPermN(m) {
  return Math.ceil(m / 0.04);
}

// 当前样本量下能检出的最小差异（α=0.05 双尾、power=0.8、两组等分的经典近似）。
// 用途：让使用者知道能力边界——观察到的差异若小于它，就算是真的也测不出来。
function minDetectableDiff(n, baseRate) {
  if (!Number.isFinite(n) || n < 10 || !Number.isFinite(baseRate) || baseRate <= 0 || baseRate >= 1) return NaN;
  return (1.96 + 0.8416) * Math.sqrt(2 * baseRate * (1 - baseRate) / (n / 2));
}

// 当前"赢"的阈值：默认 WIN_THRESHOLD(2)，但胜率曲线/集体检测面板可切到 5、10——
// meme 极度右偏，只看 >2 看不见"哪个区间更容易出大票"。下拉不存在时退回 2。

// 滑动窗口胜率曲线的核心：给定按 x 排好序的 0/1 胜负序列，返回"Wilson 下界高于基准"的
// 最长连续区段长度。用增量更新维护窗口内赢数（进一个出一个），整条曲线 O(n)，
// 这样几百次置换才跑得动。
function longestAboveRun(arr, W, baselinePct) {
  if (arr.length < W) return 0;
  let k = 0;
  for (let i = 0; i < W; i++) k += arr[i];
  let best = 0, cur = 0;
  for (let i = 0; i + W <= arr.length; i++) {
    if (i > 0) k += arr[i + W - 1] - arr[i - 1];
    if (wilsonInterval(k, W).lo * 100 > baselinePct) { cur++; if (cur > best) best = cur; }
    else cur = 0;
  }
  return best;
}

// 置换检验：把胜负标签相对字段值随机打乱若干次，得到"纯随机下最长达标区段"的分布，
// 只有实际数据的最长区段显著长于它，波峰才不是噪声。
// 为什么必须这么做：曲线上有几百个位置、每个按 95% 判一次，纯随机也会有约 5% 越界；
// 而且滑动窗口相邻点高度相关，一次随机偏高会连续影响约 W 个窗口，噪声区段长度天然接近 W，
// 靠固定宽度门槛分不开（实测 5 次纯噪声有 3 次报出跨 13~20 个位置的"波峰"）。
// 置换用数据自身的重排定基准，自动把这层自相关也包含进去。

// 置换检验：把胜负标签相对字段值随机打乱若干次，得到"纯随机下最长达标区段"的分布，
// 只有实际数据的最长区段显著长于它，波峰才不是噪声。
// 为什么必须这么做：曲线上有几百个位置、每个按 95% 判一次，纯随机也会有约 5% 越界；
// 而且滑动窗口相邻点高度相关，一次随机偏高会连续影响约 W 个窗口，噪声区段长度天然接近 W，
// 靠固定宽度门槛分不开（实测 5 次纯噪声有 3 次报出跨 13~20 个位置的"波峰"）。
// 置换用数据自身的重排定基准，自动把这层自相关也包含进去。
function permutationPeakTest(wins01, W, baselinePct, permN = 300) {
  const obs = longestAboveRun(wins01, W, baselinePct);
  const shuffled = wins01.slice();
  const runs = [];
  for (let t = 0; t < permN; t++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
    }
    runs.push(longestAboveRun(shuffled, W, baselinePct));
  }
  runs.sort((a, b) => a - b);
  return { obs, perm95: percentile(runs, 0.95), p: (runs.filter(r => r >= obs).length + 1) / (permN + 1) };
}

// ---------- 常用字段集体检测 ----------
// 逐个字段跑上面那套置换检验，把"确实存在非噪声波峰"的字段挑出来，省去一个个手动试。
// 关键：这里同时检验几十个字段，本身又是一次多重比较——46 个字段纯随机也会有 2~3 个 p<0.05，
// 所以对所有字段的置换 p 再做一次 BH-FDR 校正，只有校正后仍显著的才标为可用。
// permN 的下限由字段数决定：置换 p 的最小可能值是 1/(permN+1)，而 BH 校正在最好情况下要求
// 原始 p < 0.05/m（m = 字段数）。若 permN 不够，即使效应极强、置换中一次都没被超过，
// p 也只能触底在 1/(permN+1)，乘以 m 之后必然 >0.05——真信号会被数学上判死。
// 实测：43 个字段 × 200 次置换，一个"最长区段 73 vs 随机 23"的强信号照样被判不通过。
// 所以按字段数自动抬高置换次数，取 m/0.04 留出余量。

function parseBreakpoints(text) {
  return text.split(',').map(s => parseFloat(s.trim())).filter(Number.isFinite).sort((a, b) => a - b);
}

// 最优分箱阈值推荐（design doc §8.2）：简化版单变量决策树分裂思路——按分位数取候选分裂点，
// 每个候选点把样本分两组，衡量两组目标字段分布的区分度，选出差异最大的几个分裂点，贪心去重
// 避免选出彼此过近、没有额外信息量的点。
//
// 【2026-07 修正】原先用 ANOVA F（比较两组均值）打分，对 returnMax 这类右尾极端分布极不稳健：
// 只要某一侧恰好混进一两个几十倍的暴涨样本，均值就能被拉到看起来"区分度很高"，选出的断点
// 实质是在隔离离群值（真实出现过 n=132 vs n=16 这种切分，n=16 那组均值15.77但中位数只有1.62、
// 标准差52，纯粹是被极端值污染），而不是反映真实的分布差异。改用秩和（Mann-Whitney U）算的
// AUC 衡量两组区分度——只看排序、不看数值大小，同等程度不会被极端值的绝对幅度带偏；同时把
// 每组最小样本数从固定 3 提到"绝对下限 + 总量5%"，避免挑出一个只占样本总量个位数百分比的
// 极端小组。

function binLabel(lo, hi) {
  if (lo === -Infinity) return `<${hi}`;
  if (hi === Infinity) return `>=${lo}`;
  return `${lo}~${hi}`;
}

// 最近一次分箱图 / 断点挖掘的计算结果快照，供"导出给 AI 诊断"复用——
// 导出时重算一遍不仅浪费，还可能因为用户中途改了输入框而与屏幕上看到的图不一致

// ---------- 断点挖掘（样本外验证版）----------
// 为什么不走"找最优切点 + 显著性检验"那条路：实测用户场景 n≈148、基准胜率 31.8%，
// 该样本量下能检出的最小差异约 21pp，而字段里实际最大差异只有 7.5pp——要测出 7.5pp 需要约
// 1200 条样本。也就是说，在这个量级上【所有】字段都必然显示"不显著"，换任何检验方法都一样，
// p 值这条路提供不了任何区分度。
//
// 改用样本外验证：按时间把样本切成前后两段，只在前段（训练集）搜索最优切点，然后拿到后段
// （验证集）上原样套用。逻辑是——过拟合出来的规则在新数据上会失效甚至反向，真实规律则会保持
// 同方向。这不需要样本量达到检验功效的门槛，小样本下也能给出可操作的判断。
// 按【时间】而不是随机切分：策略是拿历史推未来，随机切分会让未来信息泄漏进训练集，高估效果。
const OOS_TRAIN_RATIO = 0.7;

// 当前样本量下能检出的最小差异（α=0.05 双尾、power=0.8、两组等分的经典近似）。
// 用途：让使用者知道能力边界——观察到的差异若小于它，就算是真的也测不出来。

// 旧版是 winRateOf(pairs, winThreshold)，内部调 currentWinThreshold() 去读 DOM 上的下拉框。
// 这里把阈值改成显式入参——同一份数据在不同阈值下的胜率本来就该是不同的结果，
// 藏在 DOM 里读会让这个函数的输出不可复现。
function winRateOf(pairs, winThreshold = WIN_THRESHOLD) {
  if (!pairs.length) return NaN;
  // 注意两点（都是差分测试抓出来的，我第一次凭印象重写时两处都写错了）：
  //   1) pairs 的元素是数组 [x, y]，不是 { x, y } 对象；
  //   2) 返回的是【比例】不是百分数，调用方自己决定要不要乘 100。
  return pairs.filter(([, y]) => y > winThreshold).length / pairs.length;
}

// ===== 以下三个函数原先直接读全局 activeRows / scatterOptions / currentWinThreshold =====
// 搬过来时把这些全局改成了入参（这是本次重构里唯一改了签名的一批）。
// 因为不再是"逐字节机械搬运"，配了差分测试：同一份数据分别喂给 js/charts.js 里的旧版
// （在 vm 里把 activeRows 设好）和这里的新版，断言输出完全一致——签名变了但行为没变。
// 最优分箱阈值推荐（design doc §8.2）：简化版单变量决策树分裂思路——按分位数取候选分裂点，
// 每个候选点把样本分两组，衡量两组目标字段分布的区分度，选出差异最大的几个分裂点，贪心去重
// 避免选出彼此过近、没有额外信息量的点。
//
// 【2026-07 修正】原先用 ANOVA F（比较两组均值）打分，对 returnMax 这类右尾极端分布极不稳健：
// 只要某一侧恰好混进一两个几十倍的暴涨样本，均值就能被拉到看起来"区分度很高"，选出的断点
// 实质是在隔离离群值（真实出现过 n=132 vs n=16 这种切分，n=16 那组均值15.77但中位数只有1.62、
// 标准差52，纯粹是被极端值污染），而不是反映真实的分布差异。改用秩和（Mann-Whitney U）算的
// AUC 衡量两组区分度——只看排序、不看数值大小，同等程度不会被极端值的绝对幅度带偏；同时把
// 每组最小样本数从固定 3 提到"绝对下限 + 总量5%"，避免挑出一个只占样本总量个位数百分比的
// 极端小组。
function recommendBreakpoints(rows, field, targetField) {
  const pairs = [];
  for (const r of rows) {
    const x = getFeature(r, field);
    const y = getFeature(r, targetField);
    if (isFiniteNumber(x) && isFiniteNumber(y)) pairs.push([Number(x), Number(y)]);
  }
  if (pairs.length < 10) return { error: '有效样本不足（<10），无法推荐断点' };
  const sortedX = pairs.map(p => p[0]).sort((a, b) => a - b);
  if (new Set(sortedX).size < 4) return { error: '该字段取值种类较少，建议直接手动设置断点' };

  const n = pairs.length;
  const ys = pairs.map(p => p[1]);
  // 每组最少样本数：绝对下限 8（太少了统计上没意义），且不能低于总量的 8%（避免挑出一个只占
  // 个位数百分比的极端小组，靠寥寥几个样本的"伪区分度"胜出）
  const minGroupSize = Math.max(8, Math.ceil(n * 0.08));

  // 候选分裂点：按 5%~95% 分位数取 19 个候选（避开首尾，避免产生空分组）
  const candidates = new Set();
  for (let p = 5; p <= 95; p += 5) {
    const idx = Math.floor((p / 100) * (sortedX.length - 1));
    candidates.add(sortedX[idx]);
  }
  const scored = [];
  for (const c of candidates) {
    const labels = new Array(n);
    let n1 = 0;
    for (let i = 0; i < n; i++) {
      labels[i] = pairs[i][0] <= c ? 0 : 1;
      if (labels[i] === 1) n1++;
    }
    const n0 = n - n1;
    if (n0 < minGroupSize || n1 < minGroupSize) continue;
    const auc = rankAuc(ys, labels, 'higher');
    if (Number.isFinite(auc)) scored.push({ c, score: Math.abs(auc - 0.5) });
  }
  if (!scored.length) return { error: `未找到有效的候选分裂点（每组样本数需 ≥ ${minGroupSize}），建议直接手动设置断点或换个字段` };
  scored.sort((a, b) => b.score - a.score);

  // 贪心挑选区分度最高的最多 4 个分裂点，要求彼此间距 >= 数据整体范围的 5%，避免挑出挤在一起的重复点
  const range = sortedX[sortedX.length - 1] - sortedX[0];
  const minGap = range * 0.05;
  const picked = [];
  for (const s of scored) {
    if (picked.length >= 4) break;
    if (picked.every(p => Math.abs(p - s.c) >= minGap)) picked.push(s.c);
  }
  picked.sort((a, b) => a - b);
  return { breakpoints: picked };
}

function mineBreakpointsOOS(sourceRows, field, targetField, minSide, winThreshold = WIN_THRESHOLD) {
  const rows = [];
  for (const r of sourceRows) {
    const x = getFeature(r, field), y = getFeature(r, targetField);
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) continue;
    // 时间锚点：优先开仓时间，退回买入时刻；都没有的排最后（不会污染训练集的时间顺序）
    const t = Number.isFinite(r.swapBeginTime) ? r.swapBeginTime
            : (Number.isFinite(r.buyTimestamp) ? r.buyTimestamp : Infinity);
    rows.push({ x: Number(x), y: Number(y), t });
  }
  if (rows.length < minSide * 3) {
    return { error: `有效样本 ${rows.length} 条太少：样本外验证需要先切出训练/验证两段，每段还要能再分两侧，建议调低"每侧最少样本"或换字段` };
  }
  rows.sort((a, b) => a.t - b.t);
  const splitAt = Math.floor(rows.length * OOS_TRAIN_RATIO);
  const train = rows.slice(0, splitAt).map(r => [r.x, r.y]);
  const test = rows.slice(splitAt).map(r => [r.x, r.y]);

  const trainBase = winRateOf(train, winThreshold), testBase = winRateOf(test, winThreshold);
  const sortedX = train.map(p => p[0]).sort((a, b) => a - b);
  if (new Set(sortedX).size < 3) return { error: '训练段里该字段取值种类太少（<3），没有可搜索的切分点' };

  const seen = new Set(), results = [];
  for (let q = 2.5; q <= 97.5; q += 2.5) {
    const c = percentile(sortedX, q / 100);
    if (!Number.isFinite(c) || seen.has(c)) continue;
    seen.add(c);
    const trL = train.filter(([x]) => x < c), trR = train.filter(([x]) => x >= c);
    if (trL.length < minSide || trR.length < minSide) continue;
    const trLw = winRateOf(trL, winThreshold), trRw = winRateOf(trR, winThreshold);
    // 训练段上哪一侧更好，就把哪一侧定为"选中侧"；验证段必须沿用同一个方向，
    // 不能在验证段上重新挑方向——那等于又用了一次验证数据，样本外就不再是样本外了
    const better = trRw >= trLw ? 'right' : 'left';
    const trSel = better === 'right' ? trRw : trLw;
    const trLift = trainBase > 0 ? trSel / trainBase : NaN;

    const teSelPairs = better === 'right' ? test.filter(([x]) => x >= c) : test.filter(([x]) => x < c);
    const teSel = winRateOf(teSelPairs, winThreshold);
    const teLift = (testBase > 0 && Number.isFinite(teSel)) ? teSel / testBase : NaN;

    results.push({
      cut: c, better,
      trainN: better === 'right' ? trR.length : trL.length, trainWin: trSel, trainLift: trLift,
      testN: teSelPairs.length, testWin: teSel, testLift: teLift,
    });
  }
  if (!results.length) return { error: `训练段里没有候选切点能让两侧各留 ${minSide} 条，请调低该值` };
  return { results, trainBase, testBase, trainSize: train.length, testSize: test.length };
}

function scanFieldsForPeaks(rows, candidateFields, targetField, permN, winThreshold) {
  const excluded = new Set([targetField, 'returnMax', 'logReturnMax']);
  const candidates = candidateFields.filter(f => !excluded.has(f));
  // 先按候选字段数把置换次数抬到够用的水平，否则多重比较校正会把真信号一并判死
  const effPermN = Math.max(permN, requiredPermN(candidates.length));
  const out = [];
  for (const field of candidates) {
    const pairs = [];
    for (const r of rows) {
      const x = getFeature(r, field), y = getFeature(r, targetField);
      if (isFiniteNumber(x) && isFiniteNumber(y)) pairs.push([Number(x), Number(y)]);
    }
    // 样本太少或字段几乎是常量，都没有"沿着取值找波峰"的意义
    if (pairs.length < 40) continue;
    if (new Set(pairs.map(p => p[0])).size < 5) continue;
    pairs.sort((a, b) => a[0] - b[0]);
    const T = winThreshold;
    const wins01 = pairs.map(([, y]) => y > T ? 1 : 0);
    const base = wins01.reduce((a, b) => a + b, 0) / wins01.length;
    if (base <= 0 || base >= 1) continue; // 全赢或全输，没有可比的基准
    // 窗口随该字段的有效样本量自适应：太大曲线被抹平（用户实测窗口 140 / 样本 148 只剩 9 个位置），
    // 太小噪声压不住。取 n/5 并夹在 [20, 60]。
    const W = Math.min(60, Math.max(20, Math.round(pairs.length / 5)));
    const t = permutationPeakTest(wins01, W, base * 100, effPermN);
    // 波峰位置：实际曲线上达标区段对应的字段取值范围
    let bestSeg = null;
    if (t.obs > 0) {
      let k = 0; for (let i = 0; i < W; i++) k += wins01[i];
      let cur = 0, curStart = -1;
      for (let i = 0; i + W <= wins01.length; i++) {
        if (i > 0) k += wins01[i + W - 1] - wins01[i - 1];
        if (wilsonInterval(k, W).lo * 100 > base * 100) {
          if (cur === 0) curStart = i;
          cur++;
          if (cur === t.obs) { bestSeg = [pairs[curStart + Math.floor(W / 2)][0], pairs[i + Math.floor(W / 2)][0]]; break; }
        } else cur = 0;
      }
    }
    out.push({ field, n: pairs.length, W, base, obs: t.obs, perm95: t.perm95, p: t.p, seg: bestSeg });
  }
  const adj = benjaminiHochbergAdjust(out.map(r => r.p));
  out.forEach((r, i) => { r.adjP = adj[i]; });
  return { rows: out, scanned: candidates.length, effPermN };
}

let lastFieldScanPassed = [];

// 样本外断点挖掘的零假设校准。
//
// 为什么需要它：mineBreakpointsOOS 会在几十个候选切点里挑测试集表现最好的一个，
// 这等于把选择偏差又带回了测试集——纯噪声字段照样能挑出一个 1.5x 的"最佳切点"。
// 实测：真信号的测试集提升中位数约 2.1x，纯噪声约 1.07x，但这个界线随数据集浮动，
// 写死一个阈值（比如"中位数 >1.3 才算有效"）纯属拍脑袋。
//
// 做法：把目标变量打散若干次，每次重跑一遍完整的挖掘流程，得到"这个字段在毫无关系时
// 能挖出多大的提升"的分布，再看真实观测值落在这个分布的什么位置。
// 注意打散的是 target 而不是 field —— 要破坏的是两者的关联，同时保留 field 自身的分布
// 和时间切分结构，否则零分布就不可比了。
export function calibrateOOSMining(rows, field, targetField, minSide, permN = 20, rnd = Math.random) {
  const medianOf = a => {
    if (!a.length) return NaN;
    const x = a.slice().sort((p, q) => p - q); const m = x.length >> 1;
    return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
  };
  const medLift = res => (res && res.results && res.results.length)
    ? medianOf(res.results.map(r => r.testLift)) : NaN;

  const observed = medLift(mineBreakpointsOOS(rows, field, targetField, minSide));
  if (!Number.isFinite(observed)) return { error: '真实数据上没有可用切点，无法校准' };

  const targets = rows.map(r => r[targetField]);
  const nulls = [];
  for (let k = 0; k < permN; k++) {
    const shuffled = targets.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const permRows = rows.map((r, i) => ({ ...r, [targetField]: shuffled[i] }));
    const v = medLift(mineBreakpointsOOS(permRows, field, targetField, minSide));
    if (Number.isFinite(v)) nulls.push(v);
  }
  if (nulls.length < 5) return { error: '置换样本太少，无法校准' };
  const sorted = nulls.slice().sort((a, b) => a - b);
  const beat = nulls.filter(v => v >= observed).length;
  return {
    observed,
    nullMedian: medianOf(sorted),
    null95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    // +1 平滑：置换检验的 p 不能为 0，最小值是 1/(permN+1)
    p: (beat + 1) / (nulls.length + 1),
    permN: nulls.length,
  };
}

export {
  winRateOf,
  recommendBreakpoints,
  mineBreakpointsOOS,
  scanFieldsForPeaks,
  requiredPermN,
  minDetectableDiff,
  longestAboveRun,
  permutationPeakTest,
  parseBreakpoints,
  binLabel,
};
