import { useState } from 'react';
import {
  scanFactorCandidates, buildFactors, autoWeights, computeHeldOutDeltaRho,
} from '../../lib/factorLab.js';
import { permutationNullMarginalRho } from '../../lib/factorLab.js';
import { scanCandidatesWithWorkers, evaluateCandidatesWithWorkers, runPermutationNullWithWorkers } from './workerPool.js';
import { loadFactorExclusions, saveFactorExclusions, excludeFactor,
         unexcludeFactor, filterExcluded, restoreAllExcluded, sortExclusionsByRecency } from '../../lib/factorExclusions.js';

// 因子发现（扫描/候选/勾选/边际ρ贡献/持久化排除）这一大块状态与逻辑从 FactorLab 组件里搬出来，
// 单独收进一个 hook——这部分内部耦合很深（扫描结果、已选字段、排除清单、边际ρ互相牵动），
// 但对外只需要"因子池"（factors/setFactors）和几个标量参数（threshold/scoreShape/...），
// 接口收敛后单独测试/复用都更容易。
//
// 入参：
//   rows           - 全体样本（扫描与边际ρ评估都用它）
//   scopedFields   - 当前字段范围（原字段/组装字段）下参与扫描的候选字段名单
//   fieldScope     - 'original' | 'assembled'，扫描时记一份，用于判断结果是否过期
//   threshold      - 高倍阈值（x），扫描时记一份，用于判断结果是否过期
//   scoreShape     - 打分形状（trap/interval），构建因子时用
//   missingPolicy  - 缺失口径，边际ρ评估打分时用
//   factors        - 当前因子池（外部 state，本 hook 只读+通过 setFactors 写）
//   setFactors     - 因子池 setter
//   invalidateDownstream - 任何改变打分参数的操作都要让外部使 OOS/生成代码失效
//   message        - antd message 实例（AntApp.useApp() 拿到的那个），用于操作反馈
//
// 2026-07-29 删除【残差模式】：它让扫描可以只在"当前因子池没打对的子集（score<cutoff）"上做，
// 想挖的是"漏网之鱼跟同子集真输家的差别"。但那正是 held-out 边际ρ 的定义——每评一个候选，
// 算的就是"并入当前池子之后排序还能再涨多少"，贪心推荐每一步都在做同一件事。为这个重复的入口，
// 本 hook 曾背 8 处分支、FactorLab 背 14 处，还把"结果已过期"做成了三选一的状态机
// （范围变了/阈值变了/残差开关变了）。功能删除，看漏网之鱼的能力保留在「低分高倍复盘」卡片里。
export function useFactorScan({ rows, scopedFields, fieldScope, threshold, scoreShape, missingPolicy,
  factors, setFactors, invalidateDownstream, message }) {
  // 两个阵营各自的扫描结果与已选字段：勇者阵营挖"高倍盘集中区"用来加分，
  // 邪恶阵营挖"输家集中区"用来减分。两套候选池独立扫描、独立勾选，最后合并成一份 factors。
  const [scanHero, setScanHero] = useState(null);
  const [scanEvil, setScanEvil] = useState(null);
  const [scanThreshold, setScanThreshold] = useState(null); // 扫描时用的阈值，切换后提示重扫
  const [scanScope, setScanScope] = useState(null);         // 扫描时用的字段范围，切换后提示重扫
  const [scanBusy, setScanBusy] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);      // 0~1，worker 并行扫描进度（几百字段时给个反馈）
  // 勾选状态从【当前因子池】初始化——因子池持久化了、但勾选没持久化，刷新后若不从池子恢复勾选，
  // 候选表会一个都没勾，再点「扫描」时按"空勾选"重建会把整池清空（真实事故）。池子是事实源，
  // 有因子就默认勾上（按阵营归位）；想删就主动取消勾选/删除。
  const [selectedHero, setSelectedHero] = useState(() => (factors || []).filter(f => f.camp !== 'evil').map(f => f.field));
  const [selectedEvil, setSelectedEvil] = useState(() => (factors || []).filter(f => f.camp === 'evil').map(f => f.field));
  // 因子发现表的"移除"清单：手动判定某字段不适合某阵营，持久化排除——扫描前过滤掉不再扫，
  // 已经扫出来的候选表也立刻过滤掉不再展示。camp+field 两边各自独立。
  const [exclusions, setExclusions] = useState(loadFactorExclusions);
  const [showExcluded, setShowExcluded] = useState({ hero: false, evil: false });
  // 打分形状/缺失口径：见 FactorLab 里对应字段的注释，这里只是持有 state，UI 在外层。
  // 候选字段的边际 ρ 贡献（held-out：computeHeldOutDeltaRho 的返回值，主看 deltaTest）：
  // 按需算，key = camp+':'+field；poolKey 记录算这份结果时的因子池签名，池子变了就判过期。
  const [marginalRho, setMarginalRho] = useState(null); // { poolKey, map }
  const [marginalBusy, setMarginalBusy] = useState(false);
  // 边际ρ 的置换零分布：{ poolKey, dist }。dist 见 factorLab.permutationNullMarginalRho ——
  // 打乱 returnMax 后整条流水线重跑出来的 Δρ 分布，用来回答"多大的边际ρ才算超出噪声"
  // （候选表的 0.005 阈值本来是拍脑袋定的）。跟 marginalRho 一样按 poolKey 判过期。
  const [permNull, setPermNull] = useState(null);
  const [permNullBusy, setPermNullBusy] = useState(false);
  const [permNullProgress, setPermNullProgress] = useState(0);
  // 2026-07-28 大回退：候选边际贡献评估中途试过分层秩相关（自适应粗粒度分档、档内看命中率、
  // 不吃 cutoff），真实数据上配权效果不理想，换回默认口径——全程 spearman
  // （computeHeldOutDeltaRho 默认 scoreFn=scorePoolRho，不用额外传）。
  // 记录上一次扫描实际用的行集：候选区间与梯形边界必须在同一份数据上推导。残差模式删掉之后
  // 它恒等于扫描【当时】那份 rows，但仍然不能直接换成当前的 rows——用户在「数据与过滤」里改了
  // 筛选、rows 换了一份而没重扫时，候选还是老那批，建梯形得用挖出它们的那份数据。
  const [scanRowsUsed, setScanRowsUsed] = useState(null);

  async function runScan() {
    const scanRows = rows;
    setScanBusy(true);
    setScanProgress(0);
    setMarginalRho(null); // 新一轮扫描的候选区间/AUC 全变了，旧的边际ρ结果直接作废
    setPermNull(null);    // 零分布是按当时那批候选跑出来的，候选换了标尺也就不作数了
    setScanRowsUsed(scanRows);
    await new Promise(r => setTimeout(r, 0));   // 让出一帧，按钮 loading 才能画出来
    try {
      const scanOpts = { winThreshold: threshold, bootstrapB: 200, minCoverage: 0.3 };
      // 已经判定"不适合该阵营"的字段直接不喂进扫描——既不浪费 bootstrap 算力，
      // 也保证它们以后不会又出现在候选表里（不是扫出来再过滤展示，是压根不扫）。
      const heroScanFields = filterExcluded(scopedFields, exclusions, 'hero');
      const evilScanFields = filterExcluded(scopedFields, exclusions, 'evil');
      // 优先走 worker 池并行扫描（几百个字段的 AUC bootstrap + 区间置换检验搬出主线程，页面不再冻死）；
      // 无 Worker 环境（SSR/测试）或 worker 构造失败时兜底回主线程串行，结果逐字段一致。
      let resHero, resEvil;
      try {
        if (typeof Worker === 'undefined') throw new Error('no worker');
        const both = await scanCandidatesWithWorkers(scanRows, heroScanFields, evilScanFields, {
          ...scanOpts,
          onProgress: ({ completed, total }) => setScanProgress(total ? completed / total : 0),
        });
        resHero = both.hero; resEvil = both.evil;
      } catch (e) {
        [resHero, resEvil] = await Promise.all([
          scanFactorCandidates(scanRows, heroScanFields, { ...scanOpts, camp: 'hero' }),
          scanFactorCandidates(scanRows, evilScanFields, { ...scanOpts, camp: 'evil' }),
        ]);
      }
      setScanHero(resHero); setScanEvil(resEvil);
      setScanThreshold(threshold);
      setScanScope(fieldScope);
      // 扫描【不动勾选】——因子不主动删就不丢：本次扫到区间的重建、没扫到的靠 rebuildFactors 的
      // preserved 原样保留（跨范围因子 + 仍勾选但这次没挖出区间的都留着）。只有手动取消勾选才移除。
      rebuildFactors(resHero, resEvil, selectedHero, selectedEvil, factors, scoreShape, scanRows);
      invalidateDownstream();
    } finally { setScanBusy(false); }
  }

  // 合并两个阵营的候选与已选字段，重新构建 factors。新增字段自动推导打分形状，
  // 已有字段保留手工编辑；权重整体重配（组合变了，旧权重的相对比例已失去意义）
  // rowsForBuild：候选区间是在哪份数据上挖出来的，梯形边界就必须在同一份数据上推导（默认取
  // 上一次扫描实际用的行集 scanRowsUsed，见其定义处——rows 换过而没重扫时两者会不同）。
  // preserveExisting=false：不保留当前池里的任何旧因子（含跨字段范围的），池子=本次重建出来的那批。
  // 保留这个参数：从策略导入/清空重来等场景仍需要"池子=本次重建出来的那批"的语义。
  // （原「因子推荐」的「全部替换」按钮曾用它，2026-07-29 两卡合并后改由 adoptRecommendedFactors
  //   直接 setFactors 带精配权重的因子集，不再走这条。）
  function rebuildFactors(rHero, rEvil, heroSel, evilSel, prevFactors, shape = scoreShape, rowsForBuild = scanRowsUsed || rows, preserveExisting = true) {
    // 复合键 camp+field：只按 field 查会让"先勾了 hero 版的这个字段，再勾 evil 版的同一个字段"
    // 时，新算出来的 evil 因子被 prevMap 里那份【hero】的旧缓存整个覆盖掉（camp 也被带偏），
    // 这是真实踩过的 bug——两次勾选同一字段、后一次的阵营选择在权重表里被吃掉了
    const prevMap = new Map(prevFactors.map(f => [f.camp + ':' + f.field, f]));
    const candidates = [...(rHero ? rHero.candidates : []), ...(rEvil ? rEvil.candidates : [])];
    const scannedFields = new Set(candidates.map(c => c.field));
    // 必须带 camp 一起查（而不是只传字段名）：同一字段在勇者/邪恶两个阵营各自都有一份候选
    // （UI 对同一批字段跑了两次扫描），只按字段名查会让结果取决于 candidates 数组的拼接顺序，
    // 跟用户到底在哪张表里勾选的完全无关。只重建"本次扫描里有候选"的已选字段。
    const fieldSpecs = [
      ...heroSel.filter(f => scannedFields.has(f)).map(field => ({ field, camp: 'hero' })),
      ...evilSel.filter(f => scannedFields.has(f)).map(field => ({ field, camp: 'evil' })),
    ];
    const { factors: derived, skipped } = buildFactors(rowsForBuild, candidates, fieldSpecs, threshold, { shape });
    const derivedKeys = new Set(derived.map(f => f.camp + ':' + f.field));
    const selKeys = new Set([...heroSel.map(f => 'hero:' + f), ...evilSel.map(f => 'evil:' + f)]);
    // 因子不主动删就不丢：保留 ① 不在本次扫描范围的已有因子（另一字段范围，跨范围共存）；
    // ② 仍勾选、但本次没能重建的因子（如这次没挖出区间）——都不丢。只有【取消勾选】的才真正移除。
    const preserved = preserveExisting ? factors.filter(f => {
      const key = f.camp + ':' + f.field;
      if (derivedKeys.has(key)) return false;         // 已用本次扫描重建
      if (!scannedFields.has(f.field)) return true;   // 另一字段范围 → 原样保留
      return selKeys.has(key);                        // 本范围内：仍勾选→保留，取消勾选→丢
    }) : [];                                          // 全部替换：旧因子一个不留
    const merged = derived.map(f => {
      const prev = prevMap.get(f.camp + ':' + f.field);
      return prev ? { ...prev, auc: f.auc, weight: 0 } : f;
    });
    setFactors(autoWeights([...preserved, ...merged]));
    if (skipped.length) message.warning(`${skipped.length} 个字段无法推导区间被跳过：` + skipped.map(s => s.field).join('、'));
    invalidateDownstream();
  }

  // 因子发现候选表里的"移除"：判定这个字段不适合这个阵营，持久化排除（不是取消勾选那种临时的）。
  // 如果当时已经勾选了，一并取消勾选、从因子表里删掉——判定不适合了就不该继续参与打分。
  function handleExcludeCandidate(camp, field) {
    const next = excludeFactor(exclusions, { camp, field });
    setExclusions(next);
    saveFactorExclusions(next);
    if (camp === 'evil' && selectedEvil.includes(field)) {
      const keys = selectedEvil.filter(f => f !== field);
      setSelectedEvil(keys);
      rebuildFactors(scanHero, scanEvil, selectedHero, keys, factors);
    } else if (camp === 'hero' && selectedHero.includes(field)) {
      const keys = selectedHero.filter(f => f !== field);
      setSelectedHero(keys);
      rebuildFactors(scanHero, scanEvil, keys, selectedEvil, factors);
    }
    message.success(`已把「${field}」标记为不适合${camp === 'evil' ? '邪恶' : '勇者'}阵营，以后扫描不会再出现`);
  }

  function handleUnexcludeCandidate(camp, field) {
    const next = unexcludeFactor(exclusions, { camp, field });
    setExclusions(next);
    saveFactorExclusions(next);
  }

  // 一键恢复：清空某个阵营的全部排除记录（不影响另一阵营）——排除多了之后逐个点×太慢，
  // 一次性恢复完再挑几个手动重排更快。跟单条 handleUnexcludeCandidate 同一套持久化写法。
  function handleRestoreAllExcluded(camp) {
    const next = restoreAllExcluded(exclusions, camp);
    setExclusions(next);
    saveFactorExclusions(next);
  }

  const staleScan = (scanHero || scanEvil) && (scanThreshold !== threshold || scanScope !== fieldScope);
  // 因子池签名：谁在池子里、打分方式/缺失口径是什么——任一项变了，已算出的边际ρ就该判过期
  // （不是删掉，界面上仍显示但标"已过期"，避免因子发现表整片瞬间清空造成跳动）
  const poolKey = factors.map(f => f.camp + ':' + f.field).sort().join(',') + '|' + scoreShape + '|' + missingPolicy + '|' + threshold;
  const marginalStale = marginalRho && marginalRho.poolKey !== poolKey;
  const permNullStale = !!permNull && permNull.poolKey !== poolKey;
  // key 必须带 camp：同一个字段在勇者/邪恶两张候选表里各有一份候选，边际贡献是两个不同的数
  // （一个是"进池当加分因子"、一个是"进池当减分因子"）。原来只按 field 存/查，两阵营互相覆盖，
  // 勇者表里显示的其实是邪恶那份的 Δρ；更糟的是候选表的「边际ρ≥」过滤器（默认 0.005）会拿这个
  // 串了阵营的数去筛候选，把该留的筛掉、该筛的留下。
  const getMarginal = (field, camp = 'hero') =>
    (marginalRho ? marginalRho.map.get((camp === 'evil' ? 'evil' : 'hero') + ':' + field) : undefined);

  // 已排除但候选表本身没扫出来（比如刚移除、还没重新扫描）的字段也该能在"已移除"里看到并恢复，
  // 所以不是单纯从 candidates 反查——扫描前已经把它们从 scopedFields 里过滤掉了。
  // 按排除时间【新→旧】排序（最近排除的排最前，方便找到刚手滑排除的字段恢复）。
  const excludedHero = sortExclusionsByRecency(exclusions.filter(x => x.camp === 'hero'));
  const excludedEvil = sortExclusionsByRecency(exclusions.filter(x => x.camp === 'evil'));
  const visibleHeroCandidates = scanHero ? filterExcluded(scanHero.candidates, exclusions, 'hero', c => c.field) : null;
  const visibleEvilCandidates = scanEvil ? filterExcluded(scanEvil.candidates, exclusions, 'evil', c => c.field) : null;

  async function runMarginalRho() {
    setMarginalBusy(true);
    await new Promise(r => setTimeout(r, 0));
    try {
      // 待评估候选：可见、有区间、且尚未在池子里（已在池子里的不算"加入"边际）。
      // 结果按 'camp:field' 存（见 getMarginal 注释）：同一字段两个阵营各存一份，不再互相覆盖。
      const heroSelSet = new Set(selectedHero), evilSelSet = new Set(selectedEvil);
      const cands = [];
      for (const [list, camp, selSet] of [[visibleHeroCandidates, 'hero', heroSelSet], [visibleEvilCandidates, 'evil', evilSelSet]]) {
        if (!list) continue;
        for (const c of list) if (c.interval && !selSet.has(c.field)) cands.push({ ...c, camp });
      }
      // 口径：held-out 边际ρ（computeHeldOutDeltaRho）——train 段推梯形边界、test 段读增量。
      // 2026-07-29 之前这个按钮走的是样本内版 factorMarginalRho（全样本评估、不切分），跟「算推荐」
      // 预筛用的 held-out 版并存，两个数意思不同却都叫"边际ρ"；更要命的是"挑因子"这一步因此完全
      // 没有过拟合防护，纯噪声候选可以带着虚高的增量进池。现在统一成这一个函数，展示的主数字是
      // deltaTest，deltaTrain 只作过拟合对照。
      // buildRows 用扫描时实际用的那份行集，保证候选 .interval 与梯形边界口径一致；
      // 它同样只取 train 段（见 computeHeldOutDeltaRho）。残差模式删掉后，它只在
      // "rows 换过但没重扫"时才与 rows 不同（见 scanRowsUsed 的注释）。
      const buildRows = scanRowsUsed || rows;
      // 逐候选并行搬进 worker 池（几百个候选各自 build+两段 spearman，串行会冻死页面）；
      // 无 Worker（SSR/测试）或失败兜底回主线程串行，结果一致。
      let entries;
      try {
        if (typeof Worker === 'undefined') throw new Error('no worker');
        const evalOpts = { threshold, missingPolicy, shape: scoreShape, concurrency: 4, batchSize: 16 };
        if (buildRows !== rows) evalOpts.buildRows = buildRows; // 通常两者同一份，不重复克隆
        const res = await evaluateCandidatesWithWorkers(rows, factors, cands, evalOpts);
        const byKey = new Map(res.map(r => [r.camp + ':' + r.field, r.result]));
        entries = cands.map(c => [c.camp + ':' + c.field, byKey.get(c.camp + ':' + c.field)]).filter(e => e[1] !== undefined);
      } catch (e) {
        entries = cands.map(c => [c.camp + ':' + c.field, computeHeldOutDeltaRho(rows, factors, c, c.camp, threshold,
          { shape: scoreShape, missingPolicy, buildRows: buildRows === rows ? null : buildRows })]);
      }
      const map = new Map();
      for (const [key, result] of entries) map.set(key, result);
      setMarginalRho({ poolKey, map });
    } finally { setMarginalBusy(false); }
  }

  // 置换零分布：把 returnMax 打乱后重跑整条"挖区间→建梯形→算Δρ"流水线，得到"纯噪声能凑出
  // 多大边际ρ"的经验分布。用来校准候选表那条 0.005 的手工阈值，以及给每个候选一个经验 p 值。
  //
  // 候选不跑满全表——成本是 permutations × candidates 次完整流水线。按区间判别力(interval.score)
  // 排序后【等间隔】抽样：强弱字段都覆盖到，且完全确定性（同一份数据反复点结果一致），
  // 比随机抽样更适合当标尺。
  async function runPermNull({ sampleSize = 24, permutations = 20 } = {}) {
    const pool = [];
    for (const [list, camp] of [[visibleHeroCandidates, 'hero'], [visibleEvilCandidates, 'evil']]) {
      if (!list) continue;
      for (const c of list) if (c.interval) pool.push({ field: c.field, camp, interval: c.interval });
    }
    if (pool.length < 3) { message.warning('可用候选太少，先扫描出候选表再跑置换零分布。'); return; }
    pool.sort((a, b) => (b.interval.score || 0) - (a.interval.score || 0));
    const step = Math.max(1, Math.floor(pool.length / Math.min(sampleSize, pool.length)));
    const sample = [];
    for (let i = 0; i < pool.length && sample.length < sampleSize; i += step) sample.push(pool[i]);

    setPermNullBusy(true);
    setPermNullProgress(0);
    await new Promise(r => setTimeout(r, 0));
    try {
      const buildRows = scanRowsUsed || rows;
      const opts = { winThreshold: threshold, shape: scoreShape, missingPolicy, permutations, buildRows };
      let dist;
      try {
        if (typeof Worker === 'undefined') throw new Error('no worker');
        dist = await runPermutationNullWithWorkers(rows, factors, sample, {
          ...opts, concurrency: 4,
          onProgress: ({ completed, total }) => setPermNullProgress(total ? completed / total : 0),
        });
      } catch (e) {
        dist = permutationNullMarginalRho(rows, factors, sample, threshold, opts);
      }
      setPermNull({ poolKey, dist });
      if (dist && dist.error) message.warning(dist.error);
    } finally { setPermNullBusy(false); }
  }

  // 重置扫描相关的所有状态（清空重来 / 从策略导入因子池时都要清掉旧的扫描痕迹）
  function resetScan() {
    setSelectedHero([]); setSelectedEvil([]);
    setScanHero(null); setScanEvil(null); setScanRowsUsed(null);
  }

  return {
    scanHero, scanEvil, scanBusy, scanProgress, scanThreshold, scanScope, scanRowsUsed,
    selectedHero, setSelectedHero, selectedEvil, setSelectedEvil,
    exclusions, showExcluded, setShowExcluded,
    marginalRho, marginalBusy,
    permNull: permNull?.dist || null, permNullBusy, permNullProgress, permNullStale, runPermNull,
    runScan, rebuildFactors, handleExcludeCandidate, handleUnexcludeCandidate, handleRestoreAllExcluded, runMarginalRho, resetScan,
    staleScan, marginalStale, getMarginal,
    excludedHero, excludedEvil, visibleHeroCandidates, visibleEvilCandidates,
  };
}
