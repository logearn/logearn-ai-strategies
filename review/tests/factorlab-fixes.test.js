// ========== 「找因子」逻辑审查修复的回归测试（2026-07-29） ==========
// 这一批修的都是"跑得通、也不报错，但结论/状态是错的"那类问题，所以每条都用一个能复现原症状的
// 构造钉住——回归了就会红，而不是悄悄回到旧行为。
// 单独成文件（不并进 factorlab.test.js）：那个文件已经 2000+ 行、且在被另一条线并行修改。
import assert from 'node:assert';
import {
  trapScore, autoWeights, assignFoldsByToken, buildFactors,
  recommendFactorPool, backtestFactors, recommendCutoff,
} from '../src/lib/factorLab.js';
import { buildCandidateExportTsv } from '../src/lib/factorScanExport.js';

export function run(test) {
  // ---------- 1. trapScore：上界右开，跟挖区间的 [lo, hi) 口径对齐 ----------
  test('trapScore: 区间命中形状(矩形)下，值等于上界应判 0 分——与区间 [lo,hi) 的统计口径一致', () => {
    // shape='interval' 时 buildFactors 造出来的就是这种矩形：lo0=lo1=lo, hi1=hi0=hi
    assert.strictEqual(trapScore(0, 0, 0, 1, 1), 1, '左端点属于区间内（左闭），应满分');
    assert.strictEqual(trapScore(1, 0, 0, 1, 1), 0, '右端点不属于区间（右开），应 0 分');
    assert.strictEqual(trapScore(0.5, 0, 0, 1, 1), 1);
  });
  test('trapScore: 布尔字段区间 [0,1) 只该覆盖 0——修复前 1 会被误判满分', () => {
    // 真实场景：布尔/计数字段大量样本恰好压在端点上，右闭会把"统计上不算命中"的样本打成满分
    const hit0 = trapScore(0, 0, 0, 1, 1), hit1 = trapScore(1, 0, 0, 1, 1);
    assert.ok(hit0 === 1 && hit1 === 0, `is_xxx=0 该满分、=1 该 0 分，实际 ${hit0}/${hit1}`);
  });
  test('trapScore: 梯形形状不受影响——过渡带/满分核/界外行为跟改动前一致', () => {
    // lo0=0 lo1=2 hi1=8 hi0=10
    assert.strictEqual(trapScore(5, 0, 2, 8, 10), 1, '核内满分');
    assert.strictEqual(trapScore(1, 0, 2, 8, 10), 0.5, '左过渡带线性');
    assert.strictEqual(trapScore(9, 0, 2, 8, 10), 0.5, '右过渡带线性');
    assert.strictEqual(trapScore(0, 0, 2, 8, 10), 0, '左硬界外');
    assert.strictEqual(trapScore(10, 0, 2, 8, 10), 0, '右硬界外');
    assert.strictEqual(trapScore(NaN, 0, 2, 8, 10), 0, '缺失记 0');
  });
  test('trapScore: 单边开区间（±Infinity）不受右开改动影响', () => {
    assert.strictEqual(trapScore(1e9, -Infinity, -Infinity, Infinity, Infinity), 1);
    assert.strictEqual(trapScore(5, 2, 2, Infinity, Infinity), 1, '[2,∞) 内应满分');
    assert.strictEqual(trapScore(1, 2, 2, Infinity, Infinity), 0);
  });

  // ---------- 2. autoWeights：不再把"没有区间分数"的因子权重清零 ----------
  test('autoWeights: 全部因子都有 interval.score 时行为完全不变（∝ score，和为 100）', () => {
    const fs = autoWeights([{ interval: { score: 2 } }, { interval: { score: 1 } }, { interval: { score: 1 } }]);
    assert.ok(Math.abs(fs.reduce((a, f) => a + f.weight, 0) - 100) < 1e-6);
    assert.ok(Math.abs(fs[0].weight - 50) < 0.2, `w0=${fs[0].weight}`);
  });
  test('autoWeights: 导入池（全部无 interval，但带真实权重）应保留权重比例，不被抹成均分', () => {
    // 症状：从策略代码导入的因子 interval=null，旧实现 raw 全是 0 → 走"退化均分"，
    // 策略里 60/30/10 的真实权重被抹平成 33/33/33，等于悄悄改了用户的策略。
    const fs = autoWeights([
      { field: 'a', interval: null, weight: 60 },
      { field: 'b', interval: null, weight: 30 },
      { field: 'c', interval: null, weight: 10 },
    ]);
    assert.ok(Math.abs(fs.reduce((a, f) => a + f.weight, 0) - 100) < 1e-6);
    assert.ok(fs[0].weight > fs[1].weight && fs[1].weight > fs[2].weight, `比例应保持：${fs.map(f => f.weight)}`);
    assert.ok(Math.abs(fs[0].weight - 60) < 0.2, `w_a=${fs[0].weight}`);
  });
  test('autoWeights: 全无 interval 且都没权重时仍退化为均分（旧行为不变）', () => {
    const fs = autoWeights([{ interval: { score: 0 } }, {}]);
    assert.ok(Math.abs(fs[0].weight - 50) < 0.11 && Math.abs(fs[1].weight - 50) < 0.11);
  });
  test('autoWeights: 混合池（导入因子 + 新扫出的因子）——导入因子的权重不该被清零', () => {
    // 症状复现：导入池之后随手点一次扫描/删一个因子，就会走到 autoWeights，
    // 旧实现下所有 interval=null 的导入因子 raw=0 → 权重直接变 0，池子形同废掉。
    const fs = autoWeights([
      { field: 'imported1', interval: null, weight: 50 },
      { field: 'imported2', interval: null, weight: 50 },
      { field: 'scanned', interval: { score: 1.2 } },
    ]);
    const imp1 = fs.find(f => f.field === 'imported1'), scanned = fs.find(f => f.field === 'scanned');
    assert.ok(imp1.weight > 0, `导入因子权重被清零了：${imp1.weight}`);
    assert.ok(scanned.weight > 0, '新扫出的因子也该有权重');
    assert.ok(Math.abs(fs.reduce((a, f) => a + f.weight, 0) - 100) < 1e-6);
    // 两个导入因子权重相同（它们原本就相同），量纲对齐后不该被新因子挤到接近 0
    assert.ok(Math.abs(imp1.weight - fs.find(f => f.field === 'imported2').weight) < 0.2);
    assert.ok(imp1.weight > 5, `导入因子被挤得只剩 ${imp1.weight}，量纲对齐没生效`);
  });

  // ---------- 3. 分折按 token 分组：同一 token 的信号不跨折 ----------
  test('assignFoldsByToken: 同一个 token 的多条信号必须落在同一折', () => {
    const rows = [];
    for (let t = 0; t < 12; t++) for (let k = 0; k < 3; k++) rows.push({ tokenAddress: 'T' + t, id: `T${t}_${k}` });
    const foldOf = assignFoldsByToken(rows, 5, 0x1234567);
    const byToken = new Map();
    rows.forEach((r, i) => {
      if (!byToken.has(r.tokenAddress)) byToken.set(r.tokenAddress, new Set());
      byToken.get(r.tokenAddress).add(foldOf[i]);
    });
    for (const [tok, folds] of byToken) {
      assert.strictEqual(folds.size, 1, `${tok} 被拆到了 ${folds.size} 个折，同 token 跨折 = held-out 泄漏`);
    }
  });
  test('assignFoldsByToken: 折数分布应大致均衡，且同一种子可复现', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ tokenAddress: 'T' + i, id: 'r' + i }));
    const a = assignFoldsByToken(rows, 5, 42), b = assignFoldsByToken(rows, 5, 42);
    assert.deepStrictEqual(a, b, '同种子应完全可复现');
    const counts = [0, 0, 0, 0, 0];
    a.forEach(f => counts[f]++);
    assert.ok(counts.every(c => c >= 8 && c <= 12), `各折样本数应均衡：${counts}`);
  });
  // 2026-07-29：上面那条"均衡"用例每个 token 只有 1 条信号，所以"按组轮转"和"按样本数装箱"
  // 结果一样，测不出区别。真实数据里组大小是**极度倾斜**的——热门币一天几十条信号、长尾币一两条，
  // 这时 pos % K 轮转只保证每折拿到差不多多少个 token，样本数可以差好几倍：某一折吃到远超 1/K，
  // 另一折少到被 heldOutFactorCurve 的 `test.length < 5` 整折丢掉，各 k 的 nFolds 不齐，
  // 而 1-SE 用的是 testStd/√nFolds —— 分母不同的两个 k 不可比，选出的 k*（推荐因子数）跟着偏。
  test('assignFoldsByToken: 组大小极度倾斜时，各折的【样本数】仍应大致均衡（不是只均衡 token 数）', () => {
    const rows = [];
    // 3 个热门币各 40 条信号 + 30 个长尾币各 1 条 = 150 条，5 折理想值 30 条/折
    for (let t = 0; t < 3; t++) for (let k = 0; k < 40; k++) rows.push({ tokenAddress: 'HOT' + t, id: `H${t}_${k}` });
    for (let t = 0; t < 30; t++) rows.push({ tokenAddress: 'TAIL' + t, id: 'L' + t });
    const foldOf = assignFoldsByToken(rows, 5, 42);
    const counts = [0, 0, 0, 0, 0];
    foldOf.forEach(f => counts[f]++);
    // 3 个 40 条的大组不可拆（同 token 不能跨折），所以最少也有一折 ≥40；只要求没有空折、
    // 且最大折不超过理想值的 1.6 倍（轮转在这个构造下会跑出 80 条 vs 极少的分布）
    assert.ok(counts.every(c => c >= 5), `不该有折被饿死：${counts}`);
    assert.ok(Math.max(...counts) <= 48, `最大折不该吃掉远超 1/K 的样本：${counts}`);
    // 同 token 不跨折这条硬约束在倾斜数据下同样必须成立
    const byToken = new Map();
    rows.forEach((r, i) => {
      if (!byToken.has(r.tokenAddress)) byToken.set(r.tokenAddress, new Set());
      byToken.get(r.tokenAddress).add(foldOf[i]);
    });
    for (const [tok, folds] of byToken) assert.strictEqual(folds.size, 1, `${tok} 跨折了`);
  });
  test('assignFoldsByToken: 没有 tokenAddress 时退回按行分折（每行自成一组）', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: 'r' + i }));
    const foldOf = assignFoldsByToken(rows, 4, 7);
    assert.strictEqual(foldOf.length, 20);
    assert.strictEqual(new Set(foldOf).size, 4, '应该用满 4 个折');
  });

  // ---------- 4. 组合路径：起点池里"本次候选查不到"的因子不能被静默丢掉 ----------
  test('recommendFactorPool: 起点池因子不在本次 candidates 里（如只看勇者阵营）时，采用结果仍应包含它', () => {
    // 构造：signalA 是真信号；起点池里放一个 evil 因子，但 candidates 只给 hero——
    // 复现"勾了『只看勇者阵营』→ 算推荐2 → 采用（整体替换池子）→ 池里的邪恶因子凭空消失"。
    const rows = [];
    for (let i = 0; i < 160; i++) {
      const a = i % 40;                       // 0..39
      const win = a >= 30;                     // a 大 = 高倍
      rows.push({
        id: 'r' + i, tokenAddress: 'T' + i, swapBeginTime: 1000 + i,
        returnMax: win ? 8 + (i % 5) : 1 + (i % 3) * 0.2,
        features: { signalA: a, riskB: (i % 7) },
      });
    }
    const T = 5;
    const heroCands = [{
      field: 'signalA', camp: 'hero',
      interval: { lo: 29.5, hi: Infinity, score: 1.5, lift: 2, coverage: 0.9, n: 40 },
    }];
    // 起点池：一个 evil 因子，边界自带（就像用户池子里已经有的那样），本次候选里没有它
    const startEvil = buildFactors(rows, [{
      field: 'riskB', camp: 'evil',
      interval: { lo: -Infinity, hi: 3, score: 1.0, lift: 1.2, coverage: 0.5, n: 80 },
    }], [{ field: 'riskB', camp: 'evil' }], T).factors;
    assert.strictEqual(startEvil.length, 1, '构造前提：起点 evil 因子该能建出来');

    const res = recommendFactorPool(rows, heroCands, { threshold: T, startFactors: startEvil });
    assert.ok(!res.error || res.factors, `不该直接报错：${res.error || ''}`);
    if (res.factors) {
      const kept = res.factors.some(f => f.field === 'riskB' && f.camp === 'evil');
      assert.ok(kept, '起点池里的 evil 因子被静默丢掉了——采用后用户池子会缺因子');
    }
  });

  // ---------- 5. 候选导出/边际ρ：同字段两阵营各取各的，不串表 ----------
  test('buildCandidateExportTsv: 同一字段在两个阵营的边际ρ应各取各的，不能串到一起', () => {
    const c = { field: 'x', auc: 0.6, direction: 'high', n: 100, pos: 20, ci: { lo: 0.52, hi: 0.68 },
                interval: { lo: 1, hi: 5, lift: 1.5, coverage: 0.4, n: 40 }, missRate: 0.1 };
    // 按 camp 返回不同的值：串表的话两行会显示同一个数
    const getMarginal = (field, camp) => ({ deltaTest: camp === 'evil' ? -0.222 : 0.111, deltaTrain: 0, baselineTest: 0, withTest: 0 });
    const { text } = buildCandidateExportTsv(
      [{ camp: 'hero', list: [c] }, { camp: 'evil', list: [c] }],
      { getDesc: () => '', getMarginal });
    assert.ok(text.includes('0.111'), '勇者行应显示勇者那份边际ρ');
    assert.ok(text.includes('-0.222'), '邪恶行应显示邪恶那份边际ρ');
  });

  // ---------- 5.5 阈值失效："0 触发"的锅不在 recommendCutoff ----------
  // readme 第6节长期把这个现象记成"recommendCutoff 选出了触发数为 0 的档"，实际不可能——
  // 它自带 minN=max(20, 5%n) 保护。真正的来源是【当前 cutoff 高于因子池打得出的最高分】。
  const buildLowCeilingPool = () => {
    // 6 个互不重叠的弱因子：任何样本最多只命中 1 个 → 总分上限 = 100/6 ≈ 16.7，远低于默认 cutoff 60
    const rows = [];
    for (let i = 0; i < 128; i++) {
      const r = { id: 'r' + i, tokenAddress: 'T' + i, swapBeginTime: 1000 + i,
                  returnMax: (i % 7 === 0) ? 7 : 1.3, features: {} };
      for (let k = 0; k < 6; k++) r.features['f' + k] = (i % 6 === k) ? 10 : 0;
      rows.push(r);
    }
    const factors = Array.from({ length: 6 }, (_, k) => ({
      field: 'f' + k, camp: 'hero', weight: 100 / 6,
      lo0: 9, lo1: 9.5, hi1: Infinity, hi0: Infinity, interval: { score: 1 },
    }));
    return { rows, factors };
  };
  test('recommendCutoff: 永远不会推荐触发数为 0（或不足 minN）的档位', () => {
    const { rows, factors } = buildLowCeilingPool();
    const bt = backtestFactors(rows, factors, 5);
    const rec = recommendCutoff(bt.sweep);
    const minN = Math.max(20, Math.ceil(rows.length * 0.05));
    assert.ok(rec, '这份数据应该能给出推荐');
    assert.ok(rec.triggered >= minN, `推荐档触发数 ${rec.triggered} 不该低于 minN=${minN}`);
  });
  test('"0 触发"的真实来源：cutoff 高于因子池分数上限（6 个互斥因子的池子上限只有 ~16.7）', () => {
    const { rows, factors } = buildLowCeilingPool();
    const bt = backtestFactors(rows, factors, 5);
    const maxScore = bt.scored.reduce((m, s) => Math.max(m, s.score), -Infinity);
    assert.ok(maxScore < 20, `分数上限应该很低，实际 ${maxScore}`);
    // UI 的 sweepAt：取最后一个 cut <= cutoff 的档
    const sweepAt = (b, cut) => b.sweep.points.reduce((best, p) => (p.cut <= cut ? p : best), b.sweep.points[0]);
    const atDefault = sweepAt(bt, 60);   // 默认/持久化下来的 cutoff
    assert.strictEqual(atDefault.triggered, 0, '默认 cutoff=60 下应该一个都不触发');
    assert.ok(!Number.isFinite(atDefault.hitRate), '命中率此时无定义（NaN），UI 该显示"无触发"而不是 0%');
    assert.strictEqual(atDefault.capture, 0, '捕获率会显示成 0.0%——正是被误读成"策略失效"的那个数');
    // 而阈值落在分布内时一切正常
    const atOk = sweepAt(bt, 16);
    assert.ok(atOk.triggered > 0 && Number.isFinite(atOk.hitRate), '阈值落在分布内就正常');
  });

  // ---------- 6. 生成代码的 cutoffUnreliable 标记：随 generateStrategyCode 一起删除（2026-07-29）----------
  // 它检查的是"有因子映射不回 ctx 时，生成代码要标出分数尺度已变"。函数删除后这个标记不复存在，
  // 但它防的那个坑还在——FactorLab 的「因子权重」卡里有一条常驻告警做同一件事（unmappableFactors：
  // 列出映射不回 ctx 的因子、算出它们占的权重、明说当前 cutoff 直接上线会偏紧），靠的是仍然保留的
  // classifyFieldOrigin / resolveCtxAccessor。
}
