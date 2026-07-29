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
//   bucketRhoOpt: { rhoTrainBefore, rhoTrainAfter, rhoTestBefore, rhoTestAfter, nTrain, nTest, zeroedFields } | null,
//     —— 分层秩相关（唯一的配权口径，不吃 cutoff，见 lib/factorLab.js 的 optimizeWeightsForBucketRho）。
//     2026-07-28：rhoOpt/tierGainOpt 两个字段已废弃（UI 不再产出，函数里仍保留 if(rhoOpt)/if(tierGainOpt)
//     的兼容判断，永远读不到但不影响功能，没必要为了这个再改一遍这个文件）。
//   current: { triggered, hitRate, capture, lift },   // 当前 cutoff 的回测
//   sweep: [{ cut, triggered, hitRate, capture, lift }],
//   deciles: [{ bin, scoreLo, scoreHi, n, pos, hiRate, wilson:{lo,hi}, avgRet, medRet }],
//   oos: { trainSize, testSize, train:{triggered,hitRate,capture,lift}, test:{...}, skipped:[{field,reason}] } | null,
//   missed: [{ ca, symbol, score, ret }],   // 漏网之鱼（score<cutoff 但 >阈值）
// }
export function buildBacktestReport(input) {
  const { config: c = {}, base = {}, factors = [], corr = [], rhoOpt, tierGainOpt, bucketRhoOpt, current = {}, sweep = [], deciles = [], oos, missed = [] } = input || {};
  const L = [];

  L.push(`# 打分策略回测报告`);
  L.push(`> 供 AI 诊断调试。北极星默认口径 = 总分↔returnMax 的 Spearman ρ；筛垃圾类策略例外为过线/未过线分层增益（绑定 cutoff）；推荐类策略例外为分层秩相关（不吃 cutoff，配完权重后 cutoff 另用「推荐阈值」单独定）。实盘按触发阈值 cutoff 买入，故也看 lift@cutoff。`);
  L.push('');

  L.push(`## 1. 配置`);
  L.push(`- 样本数：**${c.sampleN ?? base.n ?? '-'}**`);
  L.push(`- 高倍阈值：**>${c.threshold}x**（高倍盘 ${base.pos ?? '-'} 个，基准高倍率 **${pct(base.baseRate)}**，Wilson区间 ${pct(base.wilson?.lo)}~${pct(base.wilson?.hi)}）`);
  L.push(`- 触发阈值 cutoff：**${c.cutoff}**`);
  L.push(`- 缺失口径：${c.missingPolicy === 'renorm' ? '缺失重归一' : '缺失记0分'} · 打分形状：${c.scoreShape === 'interval' ? '区间命中' : '梯形'} · 字段范围：${c.fieldScope === 'assembled' ? '组装字段' : '原字段'}`);
  L.push('');

  L.push(`## 2. 因子池（${factors.length} 个）`);
  L.push(mdTable(
    ['字段', '阵营', '权重', 'lo0', 'lo1', 'hi1', 'hi0', 'AUC', '缺失率'],
    factors.map(f => [
      f.field, f.camp === 'evil' ? '邪恶' : '勇者', num(f.weight, 1),
      bnd(f.lo0), bnd(f.lo1), bnd(f.hi1), bnd(f.hi0),
      Number.isFinite(f.auc) ? f.auc.toFixed(3) : '-', pct(f.missRate),
    ])));
  L.push('');
  L.push(`> 打分：勇者命中核心区[lo1,hi1] = +权重×命中度；邪恶 = −权重×命中度。总分 = Σ(±权重×命中度)/Σ正权重 ×100。`);
  L.push('');

  L.push(`## 3. 去冗余（两两 Spearman ρ，按 |ρ| 降序）`);
  if (corr.length) L.push(corr.map(x => `- \`${x.a}\` ↔ \`${x.b}\`：ρ=${num(x.rho)}（n=${x.n}）`).join('\n'));
  else L.push(`（因子<2 或无重叠样本，无相关性可算）`);
  L.push('');

  L.push(`## 4. 北极星（默认：score↔returnMax 的 Spearman ρ；筛垃圾例外：分层增益；推荐例外：分层秩相关）`);
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
  L.push(mdTable(
    ['cut', '触发', '命中率', '捕获率', 'lift'],
    sweep.map(p => [p.cut, p.triggered, pct(p.hitRate), pct(p.capture), num(p.lift)])));
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
    L.push(mdTable(
      ['指标', `训练段(n=${oos.trainSize})`, `验证段(n=${oos.testSize})`],
      [
        [`触发数@${c.cutoff}`, oos.train?.triggered ?? '-', oos.test?.triggered ?? '-'],
        ['高倍命中率', pct(oos.train?.hitRate), pct(oos.test?.hitRate)],
        ['高倍捕获率', pct(oos.train?.capture), pct(oos.test?.capture)],
        ['lift', num(oos.train?.lift), num(oos.test?.lift)],
      ]));
    const trL = oos.train?.lift, teL = oos.test?.lift;
    if (Number.isFinite(trL) && Number.isFinite(teL)) {
      const gap = trL - teL;
      L.push(`> train→val lift 落差 = ${num(gap)}${teL < trL * 0.6 ? '（验证段不到训练段 60%，疑似过拟合）' : gap > 0.3 ? '（落差偏大，注意过拟合）' : '（落差小，泛化较好）'}`);
    }
    if (oos.skipped?.length) L.push(`> 训练段推导时跳过：${oos.skipped.map(s => `${s.field}(${s.reason})`).join('；')}`);
  } else L.push(oos?.error ? `（${oos.error}）` : `（未跑时间外推验证）`);
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
    `1. **过拟合**：看第 8 节 train→val lift 落差；落差大(>0.3)或验证段<训练段60% = 过拟合，配权或因子在贴训练期噪声。`,
    `2. **弱因子权重过高**：看第 2 节，AUC 低(接近0.5)的因子却拿高权重 = 风险；对照第 4 节 ρ最优是否把权重堆到弱因子上。`,
    `3. **分数饱和**：看第 7 节分数区间，若顶部多段都是同一分数(如 100~100) = 顶部区分不了、压住 ρ；建议加邪恶因子把满分盘拉开。`,
    `4. **单调性**：第 7 节高倍率/倍数中位是否随分段上升；顶段反而低多半是饱和噪声，不是信号。`,
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
  L.push('');
  if (!path?.length) { L.push(`（路径为空，无步骤可诊断）`); return L.join('\n'); }

  path.forEach((p, i) => {
    L.push(`## 第 ${i + 1} 步：${p.camp === 'evil' ? '☠' : '🛡'} \`${p.field}\`（held-out Δρ ${num(p.deltaTest, 3)}，样本内 Δρ ${num(p.deltaIn, 3)}${p.overfit ? '，⚠️疑似过拟合' : ''}）`);
    for (const [label, buckets, zigzag] of [
      ['held-out(test)', p.testBuckets, p.testZigzag],
      ['样本内(全量)', p.inBuckets, p.inZigzag],
    ]) {
      if (!buckets) { L.push(`- ${label}：档数不足，未计算`); continue; }
      L.push(`- ${label}：${buckets.length} 档，打架 **${zigzag.inversionCount}** 处，最大单档回落 **${pct(zigzag.worstDrop)}**`);
      L.push(mdTable(
        ['档', '分数区间', 'n', '命中率'],
        buckets.map((b, bi) => [bi + 1, `${num(b.loScore, 1)}~${num(b.hiScore, 1)}`, b.n, pct(b.hitRate)])));
      if (zigzag.inversions.length) {
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
//   testSize, tr, te, decay }]，tr/te 是 sweepScoreCutoffs 的 point，decay 是 factorLab.js
//   assessSplitDecay 的返回值。本模块保持"纯格式化、不重新计算业务逻辑"的既有约定（这个文件
//   本来就没有任何 import），不重新实现一遍两比例检验——避免页面显示"显著衰减"但导出报告
//   算出"未衰减"这种两处判定不一致的风险，两边永远读同一份计算结果。
// opts: { cutoff, threshold }。
export function buildWalkForwardReport(oos, foldRows, opts = {}) {
  const { cutoff, threshold } = opts;
  const L = [];
  L.push(`# 时间外推验证（walk-forward 多段滚动）诊断报告`);
  L.push(`> 供 AI 判断这套因子/权重是不是真的稳，不是只切一刀看运气。高倍阈值 >${threshold}x，当前 cutoff=${cutoff}。`);
  L.push('');
  if (!oos || oos.error) { L.push(`（${oos?.error || '未跑时间外推验证'}）`); return L.join('\n'); }

  const fmtT = ts => Number.isFinite(ts) ? new Date(ts * 1000).toLocaleDateString() : '-';

  L.push(`## 1. 切分配置`);
  L.push(`- 训练起步比例：**${num(oos.trainRatio, 2)}**（第 0 段跟单次70/30切分等价） · 共切 **${oos.splits}** 段（扩张窗口：每段训练集=从最早到该段验证窗口开始为止的全部历史）`);
  L.push('');

  const nSig = foldRows.filter(r => r.decay?.significant).length;
  L.push(`## 2. 各段总览（共 ${oos.folds.length} 段，其中 **${nSig}** 段判定「验证段命中率显著低于训练段」——两比例检验 p<0.05，不是固定比例阈值）`);
  L.push(mdTable(
    ['段', '验证窗口时间', 'train n', 'test n', '验证段高倍盘数(基准率)', `触发数@${cutoff}(train/test)`, '命中率(train/test)', 'lift(train/test)', 'p值', '判定'],
    foldRows.map(r => {
      if (r.error) return [`#${r.idx + 1}`, '-', r.trainSize, r.testSize, '-', '-', '-', '-', '-', `训练段推导失败：${r.error}`];
      const testBase = oos.folds[r.idx].test.base;
      return [
        `#${r.idx + 1}`, `${fmtT(r.testStart)}~${fmtT(r.testEnd)}`, r.trainSize, r.testSize,
        `${testBase.pos}（${pct(testBase.baseRate)}）`,
        `${r.tr.triggered}/${r.te.triggered}`, `${pct(r.tr.hitRate)}/${pct(r.te.hitRate)}`,
        `${num(r.tr.lift)}/${num(r.te.lift)}`,
        r.decay.insufficientN ? '样本不足' : num(r.decay.p, 3),
        r.decay.insufficientN ? '样本不足，不下结论' : r.decay.significant ? '⚠️显著衰减' : r.decay.decayed ? '略降未达显著' : '未衰减',
      ];
    })));
  L.push(`> "验证段高倍盘数(基准率)"很小（个位数）时，这一段的命中率/lift/AUC 都该打折扣看——样本太少，数字天然噪声大。`);
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
