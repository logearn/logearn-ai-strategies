import { heroWeightSum, fieldScopeLabel } from './factorLab.js';
import { factorInfluence, topBinHealth, missingImpact, weightEvidenceAlignment,
  enrichSweepWithReturns, nearCutoffOutliers, splitPathByNoiseFloor } from './factorDiagnostics.js';

// 回测报告导出：把因子池 + 回测 + OOS + 北极星（默认ρ，筛垃圾类策略例外走分层增益）+ 漏网之鱼等，
// 拼成一份【喂给 AI 调试】的 markdown。
// 纯函数、只做格式化；数据由 FactorLab 侧抽好传进来（它才拿得到全部 state）。
// 目标：AI 拿到这一份就能诊断——过拟合(train→val lift 落差)、弱因子权重过高、分数饱和、顶段是否单调、
// ρ/分层增益 与 lift@cutoff 是否一致——不用再来回问。

const pct = v => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '-');
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const bnd = v => (v === -Infinity ? '-∞' : v === Infinity ? '∞' : (Number.isFinite(v) ? (Math.abs(v) >= 1e6 || (v !== 0 && Math.abs(v) < 1e-3) ? v.toExponential(3) : String(Math.round(v * 1e4) / 1e4)) : '-'));

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(r => `| ${r.join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}

// input: {
//   config: { sampleN, threshold, cutoff, missingPolicy, scoreShape, fieldScope },
//   base: { n, pos, baseRate, wilson:{lo,hi} },
//   factors: [{ field, camp, weight, lo0, lo1, hi1, hi0, auc, missRate }],
//   corr: [{ a, b, rho, n }],           // 两两相关（按 |ρ| 降序，全部或前若干）
//   northStar: { rho, n, tieScore, tieN, tieRatio, distinct } | null,
//     —— 当前因子池【原样】打分的北极星 ρ + 同分饱和度。不依赖任何按钮，只要有因子池就该有值。
//     跟下面三个 *Opt 的区别：那三个是"优化之后能到多少"，这个是"现在是多少"。
//     tieN/tieRatio = 最大同分块的样本数/占比，distinct = 不同分值个数。
//   bucketRhoOpt: { rhoTrainBefore, rhoTrainAfter, rhoTestBefore, rhoTestAfter, nTrain, nTest, zeroedFields } | null,
//     —— 分层秩相关（唯一的配权口径，不吃 cutoff，见 lib/factorLab.js 的 optimizeWeightsForBucketRho）。
//     2026-07-28：rhoOpt/tierGainOpt 两个字段已废弃（UI 不再产出，函数里仍保留 if(rhoOpt)/if(tierGainOpt)
//     的兼容判断，永远读不到但不影响功能，没必要为了这个再改一遍这个文件）。
//   current: { triggered, hitRate, capture, lift },   // 当前 cutoff 的回测
//   sweep: [{ cut, triggered, hitRate, capture, lift }],
//   deciles: [{ bin, scoreLo, scoreHi, n, pos, hiRate, wilson:{lo,hi}, avgRet, medRet }],
//   oos: { trainSize, testSize, train:{triggered,hitRate,capture,lift}, test:{...}, skipped:[{field,reason}],
//          cutoff, cutoffSource:'train'|'fallback'|'fixed', weightSource:'auto'|'pool'|'auto-fallback',
//          inert:{frac,inert} } | null,
//     —— cutoff 是【该段训练集上重新定】的，跟 config.cutoff（全样本）不同源、数值不可比；
//        inert.inert=true 表示阈值放行了≥95%训练样本、这一节的结论不成立（见下面 assessCutoffInert）。
//   missed: [{ ca, symbol, score, ret }],   // 漏网之鱼（score<cutoff 但 >阈值）
// }
export function buildBacktestReport(input) {
  const { config: c = {}, base = {}, factors = [], corr = [], northStar, rhoOpt, tierGainOpt, bucketRhoOpt, current = {}, sweep = [], deciles = [], oos, missed = [],
    // 因子体检要按【样本】重算（摆幅/满命中/缺失落在哪一档），聚合好的 deciles/sweep 不够用。
    // 全部走这里的默认值，别在函数体里写 input.xxx —— input 本身可能是 undefined（测试覆盖了这条）。
    rows = [], backtest = null, recommendPath = null } = input || {};
  const L = [];

  L.push(`# 打分策略回测报告`);
  L.push(`> 供 AI 诊断调试。北极星默认口径 = 总分↔returnMax 的 Spearman ρ；筛垃圾类策略例外为过线/未过线分层增益（绑定 cutoff）；推荐类策略例外为分层秩相关（不吃 cutoff，配完权重后 cutoff 另用「推荐阈值」单独定）。实盘按触发阈值 cutoff 买入，故也看 lift@cutoff。`);
  L.push('');

  L.push(`## 1. 配置`);
  L.push(`- 样本数：**${c.sampleN ?? base.n ?? '-'}**`);
  L.push(`- 高倍阈值：**>${c.threshold}x**（高倍盘 ${base.pos ?? '-'} 个，基准高倍率 **${pct(base.baseRate)}**，Wilson区间 ${pct(base.wilson?.lo)}~${pct(base.wilson?.hi)}）`);
  L.push(`- 触发阈值 cutoff：**${c.cutoff}**`);
  L.push(`- 缺失口径：${c.missingPolicy === 'renorm' ? '缺失重归一' : '缺失记0分'} · 打分形状：${c.scoreShape === 'interval' ? '区间命中' : '梯形'} · 字段范围：${fieldScopeLabel(c.fieldScope)}`);
  L.push('');

  L.push(`## 2. 因子池（${factors.length} 个）`);
  // 摆幅 / 满命中 / 有效n 三列（readme 第 44 节）：光看「权重」判断不了影响力——
  // 它是原始配比，真正的推动力是 权重/Σ勇者×100，而 Σ勇者 不在这张表里。
  // 42 轮就是这么漏掉的：权重 36.8 的因子摆幅 45.0（全池最大）、held-out Δρ 却是全池最小。
  const infl = rows.length ? factorInfluence(rows, factors) : [];
  const inflOf = f => infl.find(i => i.field === f.field && i.camp === f.camp);
  L.push(mdTable(
    ['字段', '阵营', '权重', '摆幅', '满命中', '有效n', 'lo0', 'lo1', 'hi1', 'hi0', 'AUC', '缺失率'],
    factors.map(f => {
      const i = inflOf(f);
      return [
        f.field, f.camp === 'evil' ? '邪恶' : '勇者', num(f.weight, 1),
        i && Number.isFinite(i.swing) ? (i.swing > 0 ? '+' : '') + num(i.swing, 1) : '-',
        i && Number.isFinite(i.modalShare) ? (i.modalShare * 100).toFixed(0) + '%' + (i.nearDegenerate ? ' ⚠️' : '') : '-',   // ⚠️ 只在真的 ≥90% 时才出，见下方图例的条件输出
        i && Number.isFinite(i.effectiveN) ? String(i.effectiveN) : '-',
        bnd(f.lo0), bnd(f.lo1), bnd(f.hi1), bnd(f.hi0),
        Number.isFinite(f.auc) ? f.auc.toFixed(3) : '-', pct(f.missRate),
      ];
    })));
  L.push('');
  L.push(`> 摆幅 = 权重/Σ勇者×100 = 这个因子最多能把总分推动多少（勇者向上、邪恶向下），**这才是真实影响力**；`);
  L.push(`> 满命中 = 有多大比例的样本拿到同一个命中度；有效n = n×(1−满命中) = 它真正在区分的样本数。`);
  L.push(`> **三个要一起看**：摆幅 45 但只对 70 个样本说话，和摆幅 20 却对 500 个说话，是两回事。`);
  // 图例里的告警符号【只在真有因子命中时才输出】。写成无条件的静态图例会让"整份报告里出现 ⚠️"
  // 恒为真——既有测试正是拿这个当"没有凭空报警"的判据，静态图例会把那条不变量废掉。
  if (infl.some(i => i.nearDegenerate)) {
    L.push(`> ⚠️ = 满命中 ≥90%：这个因子对绝大多数样本一视同仁，摆幅再大也是白推，**优先考虑删掉或换维度不同的字段**。`);
  }
  L.push('');
  // 分母写清楚是「Σ勇者权重」，并说明它就是满分上限：2026-07-29 起 review 的 scoreRow 跟策略
  // 模板逐位对齐（都是 `wsum += Math.max(0, weight)` 的语义），cutoff 两边通用，不再需要换算。
  // 原文案写的是含糊的「Σ正权重」，而当时 review 实际除的是【全部权重】——两边差一个正的常数倍，
  // 排序一致但 cutoff 绝对值不通用，是个真分叉，不是笔误。详见 readme 第 32/33 节。
  const wHero = heroWeightSum(factors);
  const wEvil = factors.reduce((a, f) => a + (f.camp === 'evil' ? (Number(f.weight) || 0) : 0), 0);
  L.push(`> 打分：勇者命中核心区[lo1,hi1] = +权重×命中度；邪恶 = −权重×命中度。`
    + `总分 = Σ(±权重×命中度)/**Σ勇者权重（=满分上限 ${num(wHero, 1)}）** ×100，跟实盘策略同一尺度，cutoff 可直接搬。`);
  if (wHero > 0 && wEvil > 0) {
    L.push(`>`);
    L.push(`> 分数范围：勇者全中、邪恶一个不踩 = +100；邪恶权重合计 ${num(wEvil, 1)}，`
      + `全踩中时最低可到 **${num(-wEvil / wHero * 100, 1)}** —— 邪恶占比越高分数越负，**下界不是 −100**。`);
  }
  if (wHero <= 0 && factors.length) {
    L.push(`>`);
    L.push(`> ⚠️ **这个池子没有勇者因子**（Σ勇者权重=0）：满分上限为 0、归一无定义，`
      + `review 和实盘策略都会让**所有样本的分数恒为 0**，下面所有分数相关的数字都不成立。至少要加一个勇者因子。`);
  }
  L.push('');

  L.push(`## 3. 去冗余（两两 Spearman ρ，按 |ρ| 降序）`);
  if (corr.length) L.push(corr.map(x => `- \`${x.a}\` ↔ \`${x.b}\`：ρ=${num(x.rho)}（n=${x.n}）`).join('\n'));
  else L.push(`（因子<2 或无重叠样本，无相关性可算）`);
  L.push('');

  L.push(`## 4. 北极星（默认：score↔returnMax 的 Spearman ρ；筛垃圾例外：分层增益；推荐例外：分层秩相关）`);
  // 这两行【无条件】出：下面三种配权都要用户点按钮才有数，都没点时整节曾经只剩三行"未跑"，
  // 于是"当前这套权重此刻到底几分"从来没写进过报告，诊断只能靠 lift@cutoff 反推。
  // 北极星本身不依赖任何按钮——它就是 rows+factors 的函数。
  if (northStar && Number.isFinite(northStar.rho)) {
    L.push(`- **当前因子池原样打分（未做任何优化）：ρ(score, returnMax) = ${num(northStar.rho, 3)}**（n=${northStar.n}）——这是这套权重此刻的北极星，下面三种配权都是在它基础上找改进。`);
  } else if (northStar) {
    L.push(`- 当前因子池原样打分：ρ 算不出（有效样本 <8 或因子池为空）。`);
  }
  // 同分饱和：分段表里"连着几段分数区间一模一样"就是它，但那要人肉数。真实数据上出现过
  // 344/688（50%）和 145/728（20%）两次，两次都恰好是命中率塌陷的那几段。
  if (northStar && Number.isFinite(northStar.tieRatio)) {
    L.push(`- 同分饱和：最大同分块 **${northStar.tieN} 个样本（${pct(northStar.tieRatio)}）** 都是 ${num(northStar.tieScore, 1)} 分；全样本共 ${northStar.distinct} 个不同分值。`);
    // 三条后果各自有条件，分开写。原来是一句笼统的"⚠️ 同分块内部无法排序，直接压住 ρ 的上限，
    // 也让第 7 节对应分段的高倍率失去意义"，触发线 10%。问题出在【第一句】：同分块对 ρ 的代价
    // 是 f(块大小, 信号强度)，弱信号下小得多——实测 ρ≈0.19 时 36% 的块只值 +0.005，
    // 而 10%（那条触发线本身）的代价是 0.000。见 readme 第 35 节。
    // 后两条（分段表可读性、cutoff 没有中间档位）在 10% 就已经成立，照常报。
    const hr = northStar.tieRhoCost;
    if (Number.isFinite(hr)) {
      // 0.02 这条线是"够不够得上一次有意义的改进"：低于它，拉宽梯形/换更连续的因子最多赚这么多。
      // 注意措辞必须写明是【估计】——真实代价取决于被打平抹掉的那部分信息，测不出来。
      L.push(hr >= 0.02
        ? `  - **对 ρ 的代价估计 +${num(hr, 3)}**（拆干净并列后 ρ 约 ${num(northStar.rhoUntiedEst, 3)}）——值得去拉宽梯形过渡带或换更连续的因子。`
        : `  - **对 ρ 的代价估计只有 +${num(hr, 3)}**（拆干净了 ρ 也只到约 ${num(northStar.rhoUntiedEst, 3)}）——ρ 的瓶颈**不在分数粒度上**，拉宽梯形过渡带／换更连续的因子赚不到东西，别在这上面花时间。要抬 ρ 只能加信息量（更多样本／更强的因子）。`);
      L.push(`    （代价 = f(同分块占比, 信号强度)，两个方向都单调；ρ 越弱、块内排序本来携带的信息就越少，打平它损失越小。这是模型估计不是测量值，只看量级。）`);
    }
    if (northStar.tieRatio >= 0.1) {
      const spanDeciles = Math.max(1, Math.round(northStar.tieRatio * 10));
      L.push(`  - ⚠️ **第 7 节有约 ${spanDeciles} 个十分位落在这同一个分数上**，那几档之间的高倍率差异是随机切分的产物，不是信号，别据此判断单调性。`);
      L.push(`  - ⚠️ **cutoff 在这里没有中间档位**：阈值跨过 ${num(northStar.tieScore, 1)} 分时触发数会一步跳掉约 ${northStar.tieN} 个样本（见第 6 节扫描表的断崖），${pct(northStar.tieRatio)} 那一档区间内你无法再细调。`);
    }
  }
  if (rhoOpt) {
    L.push(`- ρ最优配权（默认口径）：train ${num(rhoOpt.rhoTrainBefore, 3)} → **${num(rhoOpt.rhoTrainAfter, 3)}**，held-out test ${num(rhoOpt.rhoTestBefore, 3)} → **${num(rhoOpt.rhoTestAfter, 3)}**（train ${rhoOpt.nTrain} / test ${rhoOpt.nTest}）`);
    if (rhoOpt.zeroedFields?.length) L.push(`- ρ最优把这些因子权重压到 0（对 ρ 无贡献/有害）：${rhoOpt.zeroedFields.join('、')}`);
  } else L.push(`（未跑「按 ρ 最优配权」，无 ρ 数据）`);
  if (tierGainOpt) {
    L.push(`- 分层增益配权（筛垃圾例外口径，绑定 cutoff=${c.cutoff}）：train ${num(tierGainOpt.rhoTrainBefore, 3)} → **${num(tierGainOpt.rhoTrainAfter, 3)}**，held-out test ${num(tierGainOpt.rhoTestBefore, 3)} → **${num(tierGainOpt.rhoTestAfter, 3)}**（train ${tierGainOpt.nTrain} / test ${tierGainOpt.nTest}）`);
    if (tierGainOpt.zeroedFields?.length) L.push(`- 分层增益把这些因子权重压到 0（对台阶差无贡献/有害）：${tierGainOpt.zeroedFields.join('、')}`);
  } else L.push(`（未跑「按分层增益配权」，无分层增益数据）`);
  if (bucketRhoOpt) {
    L.push(`- 分层秩相关配权（推荐例外口径，不吃 cutoff）：train ${num(bucketRhoOpt.rhoTrainBefore, 3)} → **${num(bucketRhoOpt.rhoTrainAfter, 3)}**，held-out test ${num(bucketRhoOpt.rhoTestBefore, 3)} → **${num(bucketRhoOpt.rhoTestAfter, 3)}**（train ${bucketRhoOpt.nTrain} / test ${bucketRhoOpt.nTest}）——配完权重后，cutoff 应另用「推荐阈值」单独确定，不该反过来先猜 cutoff 再配权`);
    if (bucketRhoOpt.zeroedFields?.length) L.push(`- 分层秩相关把这些因子权重压到 0（对分档排序无贡献/有害）：${bucketRhoOpt.zeroedFields.join('、')}`);
  } else L.push(`（未跑「按分层秩相关配权」，无分层秩相关数据）`);
  L.push('');

  L.push(`## 5. 当前 cutoff=${c.cutoff} 回测`);
  L.push(`- 触发数：**${current.triggered ?? '-'} / ${base.n ?? '-'}**`);
  L.push(`- 高倍命中率：**${pct(current.hitRate)}**（基准 ${pct(base.baseRate)}）`);
  L.push(`- 高倍捕获率：**${pct(current.capture)}**`);
  L.push(`- **lift：${num(current.lift)}**`);
  L.push('');

  L.push(`## 6. Cutoff 扫描`);
  // 补一列「触发集倍数中位」（readme 43.5）：lift 按 ">阈值与否" 二元计数，一个 208x 和一个
  // 3.1x 在它眼里完全等重。真实事故——最大赢家 208.35x 得分 83.3，被 lift 最优的 cutoff=84
  // 差 0.7 分挡在外面，而这张表当时只有 lift 一列，完全看不出来。
  // 有 scored 才算得出来；没有就退回旧五列（既有调用方/测试不受影响）。
  const sweepRich = backtest?.scored?.length
    ? enrichSweepWithReturns({ points: sweep }, backtest.scored).points : null;
  L.push(sweepRich
    ? mdTable(['cut', '触发', '命中率', '捕获率', 'lift', '倍数中位'],
        sweepRich.map(p => [p.cut, p.triggered, pct(p.hitRate), pct(p.capture), num(p.lift),
          Number.isFinite(p.medRet) ? num(p.medRet, 2) + 'x' : '-']))
    : mdTable(['cut', '触发', '命中率', '捕获率', 'lift'],
        sweep.map(p => [p.cut, p.triggered, pct(p.hitRate), pct(p.capture), num(p.lift)])));
  if (sweepRich) {
    L.push('');
    L.push(`> 「倍数中位」= 该档触发集的 returnMax 中位数。**lift 和它经常给出不同的最优档** ——`);
    L.push(`> lift 只数"是不是 >${c.threshold}x"，倍数中位才反映典型收益。定 cutoff 时两列一起看。`);
  }
  // 临界分下方的大鱼：差几分没进触发集、但倍数很大的样本。lift 结构上看不见它们。
  if (backtest?.scored?.length) {
    const whales = nearCutoffOutliers(backtest.scored, c.cutoff, { window: 3, minMultiple: 10 });
    if (whales.length) {
      L.push('');
      L.push(`> 🐋 **当前 cutoff=${c.cutoff} 下方 3 分之内，有 ${whales.length} 个 ≥10x 被挡在外面**：`
        + whales.map(w => `${w.symbol} ${num(w.returnMax, 2)}x（${num(w.score, 1)} 分，差 ${num(w.gap, 1)}）`).join('、')
        + ` —— 往下松一两档 lift 通常只掉 0.03~0.05，对照上面的倍数中位再定。`);
    }
  }
  L.push('');

  L.push(`## 7. 分段表（按总分十分位，低→高）`);
  L.push(mdTable(
    ['段', '分数区间', 'n', `>${c.threshold}x`, '高倍率', '倍数均值', '倍数中位'],
    deciles.map(d => [
      d.bin, `${num(d.scoreLo, 1)}~${num(d.scoreHi, 1)}`, d.n, d.pos,
      `${pct(d.hiRate)}(${pct(d.wilson?.lo)}~${pct(d.wilson?.hi)})`, num(d.avgRet) + 'x', num(d.medRet) + 'x',
    ])));
  L.push(`> 打分有效时：高倍率/倍数中位应从段1到段10单调上升；若顶段全是同一分数(如都=100)则顶段排名无意义（饱和）。`);
  L.push('');

  L.push(`## 8. 时间外推验证（前70%推导→后30%检验）`);
  if (oos && !oos.error) {
    // cutoff 是该段【在训练段上重新定】的，不是第 1/5/6 节那个全样本 cutoff——区间/权重都重训过，
    // 分数分布跟全样本对不上，套同一个数值阈值会整体失效（曾经导致本节恒定输出"泛化较好"）。
    // oos.cutoff 缺失 = 旧版调用方没传，退回全样本 cutoff 并且不打这段说明（免得凭空报警）。
    const oosCut = Number.isFinite(oos.cutoff) ? oos.cutoff : c.cutoff;
    if (Number.isFinite(oos.cutoff)) {
      L.push(`- 本节 cutoff = **${oosCut}**（${oos.cutoffSource === 'train' ? '该段训练集上重新定的，净超额命中数最大' : `⚠️ 该段训练集太薄、定不出阈值，退回全样本 cutoff=${c.cutoff}，本节结论请打折扣看`}）· 权重口径：${oos.weightSource === 'pool' ? '沿用因子池现有权重（只重挖区间）' : '每段重新自动配权'}`);
      L.push(`> 别拿这个 cutoff 跟第 5/6 节的 ${c.cutoff} 比大小——两套分数不同源，数值不可比。`);
    }
    L.push(mdTable(
      ['指标', `训练段(n=${oos.trainSize})`, `验证段(n=${oos.testSize})`],
      [
        [`触发数@${oosCut}`, oos.train?.triggered ?? '-', oos.test?.triggered ?? '-'],
        ['高倍命中率', pct(oos.train?.hitRate), pct(oos.test?.hitRate)],
        ['高倍捕获率', pct(oos.train?.capture), pct(oos.test?.capture)],
        ['lift', num(oos.train?.lift), num(oos.test?.lift)],
      ]));
    const trL = oos.train?.lift, teL = oos.test?.lift;
    if (oos.inert?.inert) {
      // 阈值放行了几乎全部训练样本 → 命中率退化成基准高倍率、lift 恒 1.00。这时"落差 0.00 =
      // 泛化较好"是彻头彻尾的假结论，必须换成警告，不能照常输出那句让人放心的话。
      L.push(`> ⚠️ **本节无效**：训练段触发率 ${pct(oos.inert.frac)} ≥95%，阈值形同虚设——两侧"高倍命中率"实际就是各自的基准高倍率，lift 必然≈1.00，"落差小"不代表泛化好，而是**根本没测到**。请改看下一份 walk-forward 报告里 cutoff 正常的那几段。`);
    } else if (Number.isFinite(trL) && Number.isFinite(teL)) {
      const gap = trL - teL;
      // 判定必须【先看绝对水平、再看相对落差】。原来只比 trL/teL 的差值，于是
      // train 1.13 → val 0.96（落差 0.17）会输出"落差小，泛化较好"——可 lift<1 的意思是
      // **这个筛子比不筛还差**（触发的那批里高倍率低于基准），落差再小也不是"泛化好"。
      // 真实数据上撞到过：用户 4 因子那轮第 8 节 val lift=0.96，报告照样说泛化较好。
      // lift≈1（0.95~1.05）同样不算好，只是"没筛出东西"，跟"筛出来且守住了"是两回事。
      const verdict = teL < 0.95
        ? `（⚠️ **验证段 lift<1，比不筛还差**——落差小只说明训练段也没多好，不是泛化好）`
        : teL < 1.05
          ? `（⚠️ 验证段 lift≈1，**阈值在验证段没筛出超额**，落差小不代表有效）`
          : teL < trL * 0.6 ? '（验证段不到训练段 60%，疑似过拟合）'
            : gap > 0.3 ? '（落差偏大，注意过拟合）' : '（落差小且验证段 lift>1，泛化较好）';
      L.push(`> train→val lift 落差 = ${num(gap)}${verdict}`);
    }
    if (oos.skipped?.length) L.push(`> 训练段推导时跳过：${oos.skipped.map(s => `${s.field}(${s.reason})`).join('；')}`);
  } else L.push(oos?.error ? `（${oos.error}）` : `（未跑时间外推验证）`);
  L.push('');

  // ---- 因子体检：把手算的三件事写进报告（readme 第 44 节） ----
  L.push(`## 8.5 因子体检（顶档 / 缺失按阵营 / 权重↔证据）`);
  const health = backtest ? topBinHealth(backtest, c.threshold) : null;
  if (health) {
    const tb = health.topBin;
    L.push(`- **顶档**（分数 ${num(tb?.scoreLo, 1)}~${num(tb?.scoreHi, 1)}，n=${tb?.n ?? '-'}）：高倍率 ${pct(tb?.hiRate)}、lift **${num(tb?.lift, 2)}**${health.topBinBelowBase ? ' ⛔ **低于基准，分数最高的那批样本表现不如不筛**' : ' ✅'}`);
    if (health.highCutWarning) {
      L.push(`- ⛔ **高分段反转**：cutoff=${health.highCutWarning.cut} 时触发 ${health.highCutWarning.triggered} 个，lift 只有 **${num(health.highCutWarning.lift, 2)}** —— 阈值往上拉反而更差，这一段别用。`);
    }
    if (health.saturation) {
      L.push(`- **同分饱和**：${health.saturation.n} 个样本（${pct(health.saturation.share)}）都是 ${num(health.saturation.score, 1)} 分，块内高倍率 ${pct(health.saturation.hiRate)}、lift ${num(health.saturation.lift, 2)}，横跨约 ${health.saturation.spansBins} 个十分位（这几档之间的差异是随机切分的产物）。`);
    }
  }
  const miss = rows.length ? missingImpact(rows, factors, c.threshold) : [];
  const missBonus = miss.filter(m => m.direction === 'bonus');
  if (missBonus.length) {
    L.push(`- ⛔ **邪恶因子的缺失样本在白得分**（缺失记 0 分 = 躲掉扣分 = 奖励，跟勇者阵营方向相反）：`);
    for (const m of missBonus) {
      L.push(`  - \`${m.field}\`：${m.missingN} 个缺失（${pct(m.missingRate)}）白得 **${num(m.points, 1)} 分**，分数中位排在全样本 **${pct(m.medScorePct)}** 分位，这批样本自己的高倍率 ${pct(m.hiRate)}（lift ${num(m.lift, 2)}）`);
    }
    L.push(`  > 分位越高 + lift 越接近 1 = **顶档被"我们对它一无所知"的样本占据，等于不筛**。42 轮的事故就是这个形状。`);
  } else if (miss.length) {
    L.push(`- 池里有缺失的都是勇者因子（缺失 = 拿不到加分 = 惩罚，方向保守）：${miss.map(m => `\`${m.field}\` ${m.missingN} 个/分位 ${pct(m.medScorePct)}`).join('　')}`);
  }
  if (recommendPath?.length && infl.length) {
    const al = weightEvidenceAlignment(infl, recommendPath);
    if (al.rows.length >= 2) {
      L.push(al.inversions > 0
        ? `- ⚠️ **权重跟证据没对齐**：${al.inversions} 处倒挂（摆幅更大的因子 held-out Δρ 反而更小），秩相关 ρ=${num(al.rankRho, 2)}。最刺眼：\`${al.worst.heavy.field}\`（摆幅 ${num(al.worst.heavy.swingAbs, 1)} / Δρ ${num(al.worst.heavy.deltaTest, 3)}）vs \`${al.worst.strong.field}\`（摆幅 ${num(al.worst.strong.swingAbs, 1)} / Δρ ${num(al.worst.strong.deltaTest, 3)}）`
        : `- ✅ 权重与证据对齐：摆幅排序跟 held-out Δρ 排序一致（0 处倒挂，秩相关 ρ=${num(al.rankRho, 2)}）`);
    }
  }
  L.push('');

  L.push(`## 9. 漏网之鱼（score<${c.cutoff} 但实际 >${c.threshold}x，共 ${missed.length} 个，列前 20）`);
  if (missed.length) {
    L.push(mdTable(
      ['CA', 'symbol', '得分', '倍数'],
      missed.slice(0, 20).map(m => [m.ca || '-', m.symbol || '-', num(m.score, 1), num(m.ret) + 'x'])));
  } else L.push(`（无——所有高倍盘都在触发线以上）`);
  L.push('');

  L.push(`## 10. 给 AI 的诊断清单`);
  L.push([
    `1. **过拟合**：看第 8 节 train→val lift。**先看绝对值再看落差**——验证段 lift<1 = 比不筛还差，lift≈1 = 没筛出超额，这两种情况下"落差小"毫无意义；确认验证段 lift>1 之后，再看落差大(>0.3)或验证段<训练段60% = 过拟合。`,
    `2. **弱因子权重过高**：看第 2 节，AUC 低(接近0.5)的因子却拿高权重 = 风险；对照第 4 节 ρ最优是否把权重堆到弱因子上。`,
    `3. **分数饱和**：直接看第 4 节「同分饱和」那一行——最大同分块占比 ≥10% 就该处理（它同时压 ρ 和第 7 节对应分段的可读性）。饱和在顶部(如 100~100)=顶部区分不了，加邪恶因子拉开；饱和在中部=那批样本在所有因子上都落同一档，得换维度不同的因子，不是调权重能解决的。`,
    `4. **单调性**：第 7 节高倍率/倍数中位是否随分段上升；顶段反而低多半是饱和噪声，不是信号。`,
    `4.5 **顶档体检**：直接看第 8.5 节。顶档 lift<1 = "越高分越差"的顶部反转（真实踩过），两个最常见的成因：① 邪恶因子的缺失样本被顶上来（缺失记0在邪恶阵营下是奖励）；② 所有因子都是同一种单边斜坡、核心区各自盖住大半样本，于是只能识别底部识别不了顶部——后者调权重没用，得加维度不同的因子。`,
    `4.6 **lift 看不见倍数大小**：lift 按">阈值与否"二元计数，一个 208x 和一个 3.1x 完全等重。定 cutoff 时**必须同时看第 7 节「倍数中位」那一列**，两个口径给出的最佳段经常不是同一段（真实案例：最大赢家 208x 差 0.7 分没进触发集）。`,
    `5. **ρ vs lift@cutoff 打架**：第 4 节 ρ 涨但第 8 节 val lift 跌 = ρ(全体单调)好但顶部薄片(实盘买的)没守住；实盘看 lift@cutoff。`,
    `6. **样本量**：验证段触发数小(<60)时所有 OOS 数字噪声大，别据此反复手调权重。`,
  ].join('\n'));

  return L.join('\n');
}

// ── 因子推荐路径诊断导出：定位贪心推荐每一步是否把分档命中率搅乱（打架/锯齿）──
// 背景：分层秩相关(bucketRankRho)只看"档序号 vs 档命中率"的排序对不对，一条中段反复
// 倒挂但两端撑得住的锯齿曲线，Spearman 照样能给出不低的 rho——数值上"及格"但视觉上明显
// 不单调。之前靠人工在 UI 上逐步点 path 的每一步（onAdopt 前 i 个）、对照散点图紫线找是哪一步
// 引入的锯齿，太慢。这里直接把 recommendFactorPath 每一步在 held-out(test)/样本内(rows) 上的
// 分档命中率剖面 + 打架汇总(bucketZigzag) 导出成 markdown，能直接数据定位，不用来回截图。
// path: recommendFactorPath 的返回值 .path（每项已带 testBuckets/testZigzag/inBuckets/inZigzag，
// 见 lib/factorLab.js 的 recommendFactorPath）。
export function buildRecommendPathReport(path, meta = {}) {
  const L = [];
  L.push(`# 因子推荐路径 · 分档命中率诊断`);
  L.push(`> 每一步选中因子后，held-out(test)/样本内(全量) 各自的分档命中率剖面；"打架"=某档命中率比前一档还低（曲线倒挂/锯齿），`);
  L.push(`> 分层秩相关只看整体排序、对这种中段反复无感——数值上 rho 不低不代表曲线真的单调爬升，得看这份剖面。`);
  if (meta.threshold != null) L.push(`> 高倍阈值：>${meta.threshold}x`);
  // 黑名单必须写进报告：这份路径是"在排除了这些字段的前提下"选出来的，不写清楚，读报告的人
  // （或者拿去问 AI 的时候）会把"某个明显该上的字段没出现"当成算法有问题去查。
  if (meta.blacklist?.length) {
    L.push(`> 🚫 本次推荐排除了 ${meta.blacklist.length} 个黑名单字段（人工判定不许算法选，指标仍照常统计）：`
      + meta.blacklist.map(b => `\`${b.camp === 'evil' ? '☠' : '🛡'}${b.field}\``).join('、'));
  }
  // 同字段跨阵营闸门拦下的候选。写进报告的理由跟黑名单一样：不写，读报告的人会以为
  // 这个字段没被评估过。反过来，闸门生效【之前】的报告里同字段两阵营会隔着好几步各出现一次
  // （真实案例：holder_gini 第 3 步 ☠、第 10 步 🛡），谁都看不出是同一个字段——所以下面
  // 还额外做一次自检，万一将来有人开了 allowCrossCamp，报告要自己把它顶到最前面说清楚。
  if (meta.crossCampBlocked?.length) {
    L.push(`> 🔁 有 ${meta.crossCampBlocked.length} 个候选被「同字段跨阵营」闸门拦下（同一字段的勇者版和邪恶版不许同时进池）：`
      + meta.crossCampBlocked.map(b => `\`${b.camp === 'evil' ? '☠' : '🛡'}${b.field}\`（held-out Δρ ${num(b.deltaTest, 3)}，`
        + `已被 ${b.blockedBy === 'evil' ? '☠' : '🛡'} 版占位）`).join('、'));
  }
  const dupFields = (() => {
    const byField = new Map();
    for (const p of path || []) byField.set(p.field, (byField.get(p.field) || 0) + 1);
    return [...byField.entries()].filter(([, c]) => c > 1).map(([f]) => f);
  })();
  if (dupFields.length) {
    L.push(`> ⚠️ **同一字段在本路径里出现了多次**：${dupFields.map(f => `\`${f}\``).join('、')}`
      + ` —— 勇者版与邪恶版同时进池，"值高加分"和"值低扣分"同时成立，无法向实盘复刻，且勇者版计入 Σ勇者 分母、邪恶版不计入。`);
  }
  // 噪声地板（readme 第 44 节）：12 步平铺、排版一模一样，读报告的人得自己拿一条线去卡。
  // 地板 = 该 test 段上 spearman ρ 的标准误 1/√(n−3)，随样本量现算（写死 0.064 只对 n≈218 成立）。
  // 必须按【前缀】切：第 5 步的 Δρ 是"在前 4 步基础上"的增量，摘掉第 3 步之后它就不成立了。
  if (path?.length && Number.isFinite(meta.nTest)) {
    const nf = splitPathByNoiseFloor(path, meta.nTest);
    if (!nf.unknown) {
      L.push(nf.adoptCount === 0
        ? `> 🚫 **整条路径都在噪声里**：第 1 步的 held-out Δρ ${num(path[0].deltaTest, 3)} 就已低于噪声地板 **${num(nf.floor, 3)}**（test 段 n=${meta.nTest} 时 ρ 的标准误 1/√(n−3)）。这批候选没有一个站得住，别采用。`
        : `> 📏 **建议只采纳前 ${nf.adoptCount} 步**（噪声地板 ${num(nf.floor, 3)}，按 test 段 n=${meta.nTest} 现算）`
          + (nf.noise.length
            ? `：从第 ${nf.adoptCount + 1} 步（Δρ ${num(nf.noise[0].deltaTest, 3)}）起已低于地板，后面 ${nf.noise.length} 步跟随机噪声分不开。`
            : `：全部 ${nf.adoptCount} 步都高于地板。`));
    }
  }
  if (meta.objective && meta.objective !== 'rho') {
    L.push(`> ⚖️ **本路径的目标函数是「${meta.objective === 'topLift' ? '顶档 lift' : meta.objective}」，不是 ρ** —— 下面每步的 Δ 是该目标的增量，量级跟 Δρ 不可比。`);
  }
  L.push('');
  if (!path?.length) { L.push(`（路径为空，无步骤可诊断）`); return L.join('\n'); }

  path.forEach((p, i) => {
    L.push(`## 第 ${i + 1} 步：${p.camp === 'evil' ? '☠' : '🛡'} \`${p.field}\`（held-out Δρ ${num(p.deltaTest, 3)}，样本内 Δρ ${num(p.deltaIn, 3)}${p.overfit ? '，⚠️疑似过拟合' : ''}）`);
    for (const [label, buckets, zigzag] of [
      ['held-out(test)', p.testBuckets, p.testZigzag],
      ['样本内(全量)', p.inBuckets, p.inZigzag],
    ]) {
      if (!buckets) { L.push(`- ${label}：档数不足，未计算`); continue; }
      // zigzag 跟 buckets 是 recommendFactorPath 一起塞进来的，但这里原来只守了 buckets。
      // 导出器崩掉的代价是整份报告都拿不到，比缺一行锯齿统计严重得多——两个都守。
      L.push(zigzag
        ? `- ${label}：${buckets.length} 档，打架 **${zigzag.inversionCount}** 处，最大单档回落 **${pct(zigzag.worstDrop)}**`
        : `- ${label}：${buckets.length} 档（本条路径没带锯齿统计）`);
      L.push(mdTable(
        ['档', '分数区间', 'n', '命中率'],
        buckets.map((b, bi) => [bi + 1, `${num(b.loScore, 1)}~${num(b.hiScore, 1)}`, b.n, pct(b.hitRate)])));
      if (zigzag?.inversions?.length) {
        L.push(`  打架明细：` + zigzag.inversions.map(iv =>
          `第${iv.fromIdx + 1}→${iv.toIdx + 1}档(分数${num(iv.scoreRange[0], 1)}~${num(iv.scoreRange[1], 1)}) ${pct(iv.fromHitRate)}→${pct(iv.toHitRate)}(回落${pct(iv.drop)})`
        ).join('；'));
      }
    }
    L.push('');
  });
  return L.join('\n');
}

// ── 时间外推验证（walk-forward）导出：把多段滚动验证的全部诊断数据拼成一份 markdown，
// 供 AI 判断"这套参数是不是真的稳"，不用来回追问"这段 test n 多少/这段判显著没有"。
// oos: runWalkForwardBacktest 的返回值 { folds:[{splitIndex,trainSize,testSize,testStart,testEnd,
//   train:{sweep,base,...}, test:{...}, factorDecay:[{field,camp,trainAuc,testAuc,testN,testPos,aucDrop}],
//   skipped, error? }], splits, trainRatio, burnIn } | { error }。
// foldRows: 调用方（FactorLab.jsx）已经算好、跟页面总览表用的是同一份——[{ idx, error?, trainSize,
//   testSize, tr, te, decay, cutoff, cutoffSource, inert }]，tr/te 是 sweepScoreCutoffs 的 point
//   （在【该段自己的 cutoff】上取的，不是全样本 cutoff），decay 是 factorLab.js assessSplitDecay
//   的返回值，inert 是 assessCutoffInert 的返回值。本模块保持"纯格式化、不重新计算业务逻辑"的既有约定（这个文件
//   本来就没有任何 import），不重新实现一遍两比例检验——避免页面显示"显著衰减"但导出报告
//   算出"未衰减"这种两处判定不一致的风险，两边永远读同一份计算结果。
// opts: { cutoff, threshold }。
export function buildWalkForwardReport(oos, foldRows, opts = {}) {
  const { cutoff, threshold } = opts;
  const L = [];
  L.push(`# 时间外推验证（walk-forward 多段滚动）诊断报告`);
  L.push(`> 供 AI 判断这套因子/权重是不是真的稳，不是只切一刀看运气。高倍阈值 >${threshold}x。`);
  L.push(`> ⚠️ **每段的 cutoff 是各自在该段训练集上重新定的（见「该段cutoff」列），不是页面上那个全样本 cutoff=${cutoff}。**`);
  L.push(`> 各段的区间/权重都是独立重训的，分数分布跟全样本不同源，所以段间 cutoff 数值、以及它们跟 ${cutoff} 之间，都不可直接比大小。`);
  L.push('');
  if (!oos || oos.error) { L.push(`（${oos?.error || '未跑时间外推验证'}）`); return L.join('\n'); }

  const fmtT = ts => Number.isFinite(ts) ? new Date(ts * 1000).toLocaleDateString() : '-';

  L.push(`## 1. 切分配置`);
  L.push(`- 训练起步比例：**${num(oos.trainRatio, 2)}**（第 0 段跟单次70/30切分等价） · 共切 **${oos.splits}** 段（扩张窗口：每段训练集=从最早到该段验证窗口开始为止的全部历史）`);
  L.push('');

  const usable = foldRows.filter(r => !r.error && !r.inert?.inert);
  const nSig = usable.filter(r => r.decay?.significant).length;
  const nInert = foldRows.filter(r => !r.error && r.inert?.inert).length;
  L.push(`## 2. 各段总览（共 ${oos.folds.length} 段，其中 ${nInert} 段阈值失效不计入；余下 ${usable.length} 段里 **${nSig}** 段判定「验证段命中率显著低于训练段」——两比例检验 p<0.05，不是固定比例阈值）`);
  L.push(mdTable(
    ['段', '验证窗口时间', 'train n', 'test n', '验证段高倍盘数(基准率)', '该段cutoff', '触发数(train/test)', '命中率(train/test)', 'lift(train/test)', 'p值', '判定'],
    foldRows.map(r => {
      if (r.error) return [`#${r.idx + 1}`, '-', r.trainSize, r.testSize, '-', '-', '-', '-', '-', '-', `训练段推导失败：${r.error}`];
      const testBase = oos.folds[r.idx].test.base;
      // 阈值失效（训练段触发率≥95%）的段：命中率退化成两段各自的基准高倍率，衰减检验比的是
      // 行情本身的差异而不是因子池，必须把判定换成明确的"无意义"，不能输出"未衰减"。
      const verdict = r.inert?.inert
        ? `⚠️阈值失效(train触发率${pct(r.inert.frac)})，判定无意义`
        : r.decay.insufficientN ? '样本不足，不下结论'
        : r.decay.significant ? '⚠️显著衰减' : r.decay.decayed ? '略降未达显著' : '未衰减';
      return [
        `#${r.idx + 1}`, `${fmtT(r.testStart)}~${fmtT(r.testEnd)}`, r.trainSize, r.testSize,
        `${testBase.pos}（${pct(testBase.baseRate)}）`,
        // cutoffSource 缺失 = 旧版调用方没传，只显示数值不凭空报警
        `${Number.isFinite(r.cutoff) ? r.cutoff : cutoff}${r.cutoffSource && r.cutoffSource !== 'train' ? '⚠兜底' : ''}`,
        `${r.tr.triggered}/${r.te.triggered}`, `${pct(r.tr.hitRate)}/${pct(r.te.hitRate)}`,
        `${num(r.tr.lift)}/${num(r.te.lift)}`,
        r.inert?.inert || r.decay.insufficientN ? '-' : num(r.decay.p, 3),
        verdict,
      ];
    })));
  L.push(`> "验证段高倍盘数(基准率)"很小（个位数）时，这一段的命中率/lift/AUC 都该打折扣看——样本太少，数字天然噪声大。`);
  if (nInert) {
    L.push(`> ⚠️ 标「阈值失效」的 ${nInert} 段：该段 cutoff 放行了 ≥95% 的训练样本，等于没筛——命中率就是基准高倍率、lift 必然≈1.00。**这不是"泛化好"，是这一段没测到东西**，下结论时请整段排除。多半是该段训练集正类太少，recommendCutoff 找不到净超额为正的档位。`);
  }
  L.push('');

  L.push(`## 3. 逐段·逐因子归因（该字段独立算的 AUC 在训练段/验证段的差值，跌得最多的排最前；粗略诊断，不是严格检验）`);
  oos.folds.forEach((f, i) => {
    L.push(`### 第 ${i + 1} 段`);
    if (f.error) { L.push(`（该段训练失败：${f.error}）`); L.push(''); return; }
    if (!f.factorDecay?.length) { L.push(`（无归因数据）`); L.push(''); return; }
    const rowsD = f.factorDecay.slice()
      .sort((a, b) => (Number.isFinite(b.aucDrop) ? b.aucDrop : -1) - (Number.isFinite(a.aucDrop) ? a.aucDrop : -1));
    L.push(mdTable(
      ['阵营', '字段', 'train AUC', 'test AUC', 'AUC跌幅', 'test样本量(正类数)'],
      rowsD.map(d => [
        d.camp === 'evil' ? '邪恶' : '勇者', d.field,
        num(d.trainAuc, 3), num(d.testAuc, 3),
        Number.isFinite(d.aucDrop) ? (d.aucDrop >= 0 ? '+' : '') + num(d.aucDrop, 3) : '-',
        `${d.testN ?? '-'}（${d.testPos ?? '-'}）`,
      ])));
    if (f.skipped?.length) L.push(`> 该段训练时跳过：${f.skipped.map(s => `${s.field}(${s.reason})`).join('；')}`);
    L.push('');
  });

  L.push(`## 4. 给 AI 的诊断清单`);
  L.push([
    `0. **先剔掉不可用的段**：第2节判定列里标「⚠️阈值失效」的段，命中率/lift/p值全部无意义（阈值没在筛东西，两侧命中率就是各自的基准高倍率），别拿它们的"未衰减/落差小"当泛化好的证据；标「⚠兜底」cutoff 的段也要打折扣（阈值不是训出来的）。剩下的段才进入下面的判断。`,
    `1. **是不是真的过拟合**：看第2节"判定"列，多段都判显著衰减 = 真的靠不住；只有个别段判显著、且那几段"验证段高倍盘数"本来就很小 = 更可能是那几段样本太少，不是参数坏了。`,
    `2. **别被单段的巨大AUC波动唬住**：第3节里 aucDrop 绝对值很大（比如±0.15以上）但对应的"test样本量(正类数)"很小（比如正类数<10）时，这个波动大概率是噪声，不代表这个字段真的变强/变弱了——AUC是排序统计量，正类数太少时方差极大。`,
    `3. **定位哪个字段该重新审视**：优先看在【多个段】里都稳定出现较大正向aucDrop（真衰减）、且对应段"test样本量"不算太小的字段——这才是真正值得怀疑的候选，不是随便挑单段里数字最大的那一个。`,
    `4. **段数越靠后训练集越大**：最后一段训练集最接近"现在全部历史"，最贴近"如果现在上线"的情形，但它的验证窗口不一定是最大的（扩张窗口只让训练集变大，验证窗口大小基本固定）——判断"现在这套参数稳不稳"时，多看几段的一致性，不要只看最后一段。`,
  ].join('\n'));

  return L.join('\n');
}

// ── 基线库 vs 训练集(按天) 对比导出：跟 buildWalkForwardReport 是两套不同的东西——那个是"当前
// 样本内自动按时间切分、重新训练再验证"（过拟合检验）；这个是用【当前因子池】原样打分，对比
// 用户在「数据与过滤」手动归类的「基准库」(整体)和「训练集」(按天)，监控"现成策略在不同数据
// 来源/时间上表现是否一致"（数据/概念漂移监控，不重新推导任何参数）。
// result: compareGroupsAgainstBaseline 的返回值 { baseline:{n,triggered,hitRate,lift,...},
//   groups:[{label,n,triggered,hitRate,lift,decay:{p,decayed,significant,insufficientN},error?}] } | { error }。
// opts: { cutoff, threshold }。
export function buildBaselineVsTrainReport(result, opts = {}) {
  const { cutoff, threshold, strategyName } = opts;
  const L = [];
  L.push(`# 基线库 vs 训练集(按天) 对比诊断报告`);
  L.push(`> 用当前因子池原样打分（不重新推导任何参数），监控策略在不同数据来源/时间上表现是否一致。高倍阈值 >${threshold}x，cutoff=${cutoff}。`);
  if (strategyName) L.push(`> 对比范围已收窄到单个策略：**${strategyName}**（基准库/训练集归类按"策略+天"两个维度记，不同策略互不混淆）。`);
  L.push('');
  if (!result || result.error) { L.push(`（${result?.error || '未跑基线库/训练集对比'}）`); return L.join('\n'); }

  const b = result.baseline;
  L.push(`## 基准库（整体，n=${b.n}）`);
  L.push(`触发数 **${b.triggered}** · 命中率 **${pct(b.hitRate)}** · lift **${num(b.lift)}**`);
  L.push('');

  const nSig = result.groups.filter(g => g.decay?.significant).length;
  L.push(`## 训练集·按天（共 ${result.groups.length} 天，其中 **${nSig}** 天判定「命中率显著低于基准库」——两比例检验 p<0.05，不是固定比例阈值）`);
  L.push(mdTable(
    ['天', 'n', '触发数', '命中率', 'lift', 'p值', '判定'],
    result.groups.map(g => {
      if (g.error) return [g.label, g.n, '-', '-', '-', '-', g.error];
      const d = g.decay;
      const verdict = d.insufficientN ? '样本不足，不下结论' : d.significant ? '⚠️显著偏离' : d.decayed ? '略降未达显著' : '正常';
      return [g.label, g.n, g.triggered, pct(g.hitRate), num(g.lift), d.insufficientN ? '样本不足' : num(d.p, 3), verdict];
    })));
  L.push(`> 触发数很小的天，命中率/lift/p值都该打折扣看——样本太少，数字天然噪声大，不代表真的偏离。`);
  L.push('');

  L.push(`## 给 AI 的诊断清单`);
  L.push([
    `1. **是否有系统性偏移**：多天都判显著偏离、且方向一致（都偏低）= 训练集这段时间的数据/市场特征跟基准库系统性不一样了，策略可能需要重新审视；只有个别天判显著、且那几天触发数本来就小 = 更可能是那几天样本太少的噪声。`,
    `2. **看趋势不只看单天**：把判定为"⚠️显著偏离"和"略降未达显著"的天按日期排一遍，看是不是越往后越差（真漂移的典型模式），还是随机散布在各天（更像噪声）。`,
    `3. **基准库本身的代表性**：如果基准库样本量远大于每天的训练集样本量，基准库的命中率估计更稳，训练集某天的偶然波动更容易被误判——反过来，基准库如果样本量也不大，基准数字本身也不该太当真。`,
  ].join('\n'));

  return L.join('\n');
}

// ── 策略回放"每日报告存档"导出（跟上面 FactorLab 的回测报告是两套不同的报告体系，
// 分开导出：这套挂 kind/pairId/changeSummary，服务"每天一份 + 优化前后配对"的存档场景）──
const reportKindLabel = k => (k === 'optimized' ? '优化前/后配对' : '日报');

function reportMetricsSection(m) {
  if (!m) return `（无指标）`;
  const L = [];
  L.push(`- 样本数：**${m.total ?? '-'}**（命中 ${m.hits ?? '-'}）`);
  L.push(`- 命中率：**${pct(m.hitRate)}**`);
  L.push(`- 命中组中位数：${num(m.hitMedian)}x　未命中组中位数：${num(m.missMedian)}x`);
  if (m.scoreReturn) {
    L.push(`- score-收益 r(log)：**${num(m.scoreReturn.rLog, 3)}**${Number.isFinite(m.scoreReturn.pLog) ? `（p=${m.scoreReturn.pLog.toExponential(2)}）` : ''}`);
    L.push(`- 单调性 spearman ρ（score↔倍率·北极星默认口径）：**${num(m.scoreReturn.rho, 3)}**`);
  }
  if (m.monotonicity) L.push(`- 十分位单调性 ρ（佐证）：${num(m.monotonicity.rho, 3)}`);
  if (Number.isFinite(m.cutoff)) L.push(`- 打分 cutoff：${m.cutoff}`);
  return L.join('\n');
}

// 单份报告 → markdown（含策略代码全文，方便回溯这天/这次优化到底跑的是哪版代码）。
export function buildDailyReportMarkdown(r) {
  const L = [];
  L.push(`# 回测报告存档 · ${r.date}`);
  L.push(`> 类型：${reportKindLabel(r.kind)}${r.changeSummary ? ` · ${r.changeSummary}` : ''} · 存入时间 ${new Date(r.savedAt).toLocaleString('zh-CN', { hour12: false })}`);
  if (r.note) L.push(`> 备注：${r.note}`);
  L.push('');
  L.push(`## 指标`);
  L.push(reportMetricsSection(r.metrics));
  L.push('');
  L.push(`## 策略代码`);
  L.push('```js');
  L.push(r.code || '（无代码）');
  L.push('```');
  return L.join('\n');
}

// 批量导出：先给一张汇总表方便扫一眼趋势，再逐份展开明细（含代码）。
export function buildDailyReportsMarkdown(reports) {
  if (!reports?.length) return '（没有报告可导出）';
  const sorted = reports.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.savedAt - b.savedAt));
  const L = [];
  L.push(`# 回测报告存档汇总（共 ${sorted.length} 份）`);
  L.push('');
  L.push(mdTable(
    ['日期', '类型', '样本数', '命中率', '命中中位数', 'r(log)', '单调性ρ', '备注'],
    sorted.map(r => [
      r.date, reportKindLabel(r.kind), r.metrics?.total ?? '-', pct(r.metrics?.hitRate),
      num(r.metrics?.hitMedian) + 'x', num(r.metrics?.scoreReturn?.rLog, 3), num(r.metrics?.monotonicity?.rho, 3),
      r.note || '',
    ])));
  L.push('');
  for (const r of sorted) {
    L.push('---');
    L.push('');
    L.push(buildDailyReportMarkdown(r));
    L.push('');
  }
  return L.join('\n');
}
