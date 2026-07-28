import { useState } from 'react';
import {
  scanFactorCandidates, buildFactors, autoWeights, factorMarginalRho, scorePoolBucketRho,
} from '../../lib/factorLab.js';
import { loadFactorExclusions, saveFactorExclusions, excludeFactor,
         unexcludeFactor, filterExcluded } from '../../lib/factorExclusions.js';

// 因子发现（扫描/候选/勾选/边际ρ贡献/持久化排除）这一大块状态与逻辑从 FactorLab 组件里搬出来，
// 单独收进一个 hook——这部分内部耦合很深（扫描结果、已选字段、排除清单、边际ρ互相牵动），
// 但对外只需要"因子池"（factors/setFactors）和几个标量参数（threshold/scoreShape/...），
// 接口收敛后单独测试/复用都更容易。
//
// 入参：
//   rows           - 全体样本（边际ρ评估、runScan 非残差模式时用）
//   scopedFields   - 当前字段范围（原字段/组装字段）下参与扫描的候选字段名单
//   fieldScope     - 'original' | 'assembled'，扫描时记一份，用于判断结果是否过期
//   threshold      - 高倍阈值（x），扫描时记一份，用于判断结果是否过期
//   scoreShape     - 打分形状（trap/interval），构建因子时用
//   missingPolicy  - 缺失口径，边际ρ评估打分时用
//   cutoff         - 当前回测触发线，残差模式下用来提示子集大小
//   factors        - 当前因子池（外部 state，本 hook 只读+通过 setFactors 写）
//   setFactors     - 因子池 setter
//   residualRows   - 残差子集（score < cutoff 的样本），由外部依据 backtest 推导
//   invalidateDownstream - 任何改变打分参数的操作都要让外部使 OOS/生成代码失效
//   message        - antd message 实例（AntApp.useApp() 拿到的那个），用于操作反馈
export function useFactorScan({ rows, scopedFields, fieldScope, threshold, scoreShape, missingPolicy,
  cutoff, factors, setFactors, residualRows, invalidateDownstream, message }) {
  // 两个阵营各自的扫描结果与已选字段：勇者阵营挖"高倍盘集中区"用来加分，
  // 邪恶阵营挖"输家集中区"用来减分。两套候选池独立扫描、独立勾选，最后合并成一份 factors。
  const [scanHero, setScanHero] = useState(null);
  const [scanEvil, setScanEvil] = useState(null);
  const [scanThreshold, setScanThreshold] = useState(null); // 扫描时用的阈值，切换后提示重扫
  const [scanScope, setScanScope] = useState(null);         // 扫描时用的字段范围，切换后提示重扫
  const [scanResidual, setScanResidual] = useState(false);  // 扫描时是否处于残差模式，切换后提示重扫
  const [scanBusy, setScanBusy] = useState(false);
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
  // 候选字段的边际 ρ 贡献：按需算，key = camp+':'+field；poolKey 记录算这份结果时的因子池签名，
  // 池子变了就判过期。
  const [marginalRho, setMarginalRho] = useState(null); // { poolKey, map }
  const [marginalBusy, setMarginalBusy] = useState(false);
  // 2026-07-28 再订正：候选边际贡献评估固定用分层秩相关（自适应粗粒度分档、档内看倍数中位数，
  // 不吃 cutoff），不再按策略用途在"全局ρ/分层秩相关"之间切换——之前的区分（"筛垃圾"用全局ρ、
  // "推荐"用分层秩相关）只是约定，代码里从未真正强制过，用户决定不再需要这层区分，统一只用
  // 分层秩相关（见项目北极星笔记）。配权阶段的三种口径（ρ最优/分层增益/分层秩相关）不受影响。
  // 残差挖掘：不在全体样本里扫，只在当前因子池"没解释"的子集（score < cutoff）里扫，
  // 目标定义不变（returnMax>threshold=赢），但总体换成了残差子集——避免全局相关性被
  // 已经打对的大多数样本稀释，专挖"这批漏网之鱼跟同子集里的真输家比，哪些字段不一样"。
  const [residualMode, setResidualMode] = useState(false);
  // 记录上一次扫描实际用的行集（全体或残差子集）：候选区间/梯形边界必须用同一份数据推导，
  // 不能挖候选时用残差子集、建梯形时又悄悄换回全体（口径不一致，边界会对不上挖出来的区间）。
  const [scanRowsUsed, setScanRowsUsed] = useState(null);

  async function runScan() {
    // 残差模式必须先有一份可用的残差子集（依赖当前因子池的打分）——没有池子就没有"score<cutoff"这个概念
    if (residualMode && (!residualRows || !residualRows.length)) {
      message.warning('残差模式需要先有因子池打分：请先扫一遍全体样本、选几个因子，再切到残差模式细挖。');
      return;
    }
    const scanRows = residualMode ? residualRows : rows;
    setScanBusy(true);
    setMarginalRho(null); // 新一轮扫描的候选区间/AUC 全变了，旧的边际ρ结果直接作废
    setScanRowsUsed(scanRows);
    await new Promise(r => setTimeout(r, 0));   // 让出一帧，按钮 loading 才能画出来
    try {
      const scanOpts = { winThreshold: threshold, bootstrapB: 200 };
      // 已经判定"不适合该阵营"的字段直接不喂进扫描——既不浪费 bootstrap 算力，
      // 也保证它们以后不会又出现在候选表里（不是扫出来再过滤展示，是压根不扫）。
      const heroScanFields = filterExcluded(scopedFields, exclusions, 'hero');
      const evilScanFields = filterExcluded(scopedFields, exclusions, 'evil');
      const [resHero, resEvil] = await Promise.all([
        scanFactorCandidates(scanRows, heroScanFields, { ...scanOpts, camp: 'hero' }),
        scanFactorCandidates(scanRows, evilScanFields, { ...scanOpts, camp: 'evil' }),
      ]);
      setScanHero(resHero); setScanEvil(resEvil);
      setScanThreshold(threshold);
      setScanScope(fieldScope);
      setScanResidual(residualMode);
      // 扫描【不动勾选】——因子不主动删就不丢：本次扫到区间的重建、没扫到的靠 rebuildFactors 的
      // preserved 原样保留（跨范围因子 + 仍勾选但这次没挖出区间的都留着）。只有手动取消勾选才移除。
      rebuildFactors(resHero, resEvil, selectedHero, selectedEvil, factors, scoreShape, scanRows);
      invalidateDownstream();
    } finally { setScanBusy(false); }
  }

  // 合并两个阵营的候选与已选字段，重新构建 factors。新增字段自动推导打分形状，
  // 已有字段保留手工编辑；权重整体重配（组合变了，旧权重的相对比例已失去意义）
  // rowsForBuild：候选区间是在哪份数据上挖出来的，梯形边界就必须在同一份数据上推导（默认取
  // 上一次扫描实际用的行集 scanRowsUsed，残差模式下是残差子集，不能悄悄换回全体 rows）。
  function rebuildFactors(rHero, rEvil, heroSel, evilSel, prevFactors, shape = scoreShape, rowsForBuild = scanRowsUsed || rows) {
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
    const preserved = factors.filter(f => {
      const key = f.camp + ':' + f.field;
      if (derivedKeys.has(key)) return false;         // 已用本次扫描重建
      if (!scannedFields.has(f.field)) return true;   // 另一字段范围 → 原样保留
      return selKeys.has(key);                        // 本范围内：仍勾选→保留，取消勾选→丢
    });
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

  const staleScan = (scanHero || scanEvil) && (scanThreshold !== threshold || scanScope !== fieldScope || scanResidual !== residualMode);
  // 因子池签名：谁在池子里、打分方式/缺失口径是什么——任一项变了，已算出的边际ρ就该判过期
  // （不是删掉，界面上仍显示但标"已过期"，避免因子发现表整片瞬间清空造成跳动）
  const poolKey = factors.map(f => f.camp + ':' + f.field).sort().join(',') + '|' + scoreShape + '|' + missingPolicy + '|' + threshold;
  const marginalStale = marginalRho && marginalRho.poolKey !== poolKey;
  const getMarginal = field => (marginalRho ? marginalRho.map.get(field) : undefined);

  // 已排除但候选表本身没扫出来（比如刚移除、还没重新扫描）的字段也该能在"已移除"里看到并恢复，
  // 所以不是单纯从 candidates 反查——扫描前已经把它们从 scopedFields 里过滤掉了。
  const excludedHero = exclusions.filter(x => x.camp === 'hero');
  const excludedEvil = exclusions.filter(x => x.camp === 'evil');
  const visibleHeroCandidates = scanHero ? filterExcluded(scanHero.candidates, exclusions, 'hero', c => c.field) : null;
  const visibleEvilCandidates = scanEvil ? filterExcluded(scanEvil.candidates, exclusions, 'evil', c => c.field) : null;

  async function runMarginalRho() {
    setMarginalBusy(true);
    await new Promise(r => setTimeout(r, 0));
    try {
      const map = new Map();
      const heroSelSet = new Set(selectedHero), evilSelSet = new Set(selectedEvil);
      const pools = [
        [visibleHeroCandidates, 'hero', heroSelSet],
        [visibleEvilCandidates, 'evil', evilSelSet],
      ];
      // 边际贡献固定评"加入后对分层秩相关的增量"（不吃cutoff、粗粒度抗噪声）——
      // 用闭包绑定 winThreshold，形状对齐 factorMarginalRho 期望的 scoreFn(rows,factors,missingPolicy)。
      const scoreFnOpt = { scoreFn: (rowsSet, factorSet, mp) => scorePoolBucketRho(rowsSet, factorSet, mp, threshold) };
      for (const [list, camp, selSet] of pools) {
        if (!list) continue;
        for (const c of list) {
          if (!c.interval || selSet.has(c.field)) continue; // 已在池子里的因子不算"加入"边际
          // 始终在全体样本上评估（最终是要在全体样本上打分）；buildRows 用扫描时实际用的行集
          // （残差模式下是残差子集），保证候选的 .interval 与梯形边界口径一致。
          map.set(c.field, factorMarginalRho(rows, factors, c, camp, threshold,
            { shape: scoreShape, missingPolicy, buildRows: scanRowsUsed || rows, ...scoreFnOpt }));
        }
      }
      setMarginalRho({ poolKey, map });
    } finally { setMarginalBusy(false); }
  }

  // 重置扫描相关的所有状态（清空重来 / 从策略导入因子池时都要清掉旧的扫描痕迹）
  function resetScan() {
    setSelectedHero([]); setSelectedEvil([]);
    setScanHero(null); setScanEvil(null); setScanRowsUsed(null);
  }

  return {
    scanHero, scanEvil, scanBusy, scanThreshold, scanScope, scanResidual, scanRowsUsed,
    selectedHero, setSelectedHero, selectedEvil, setSelectedEvil,
    exclusions, showExcluded, setShowExcluded,
    marginalRho, marginalBusy, residualMode, setResidualMode,
    runScan, rebuildFactors, handleExcludeCandidate, handleUnexcludeCandidate, runMarginalRho, resetScan,
    staleScan, marginalStale, getMarginal,
    excludedHero, excludedEvil, visibleHeroCandidates, visibleEvilCandidates,
  };
}
