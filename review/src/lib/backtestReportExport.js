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
