// 两组样本的对比。典型用途：策略改动前后、过滤前后、两个不同的 calls 导出。
//
// 关键取舍：不做 t 检验。收益是极端右尾分布（少数几个 50x 撑起整个均值），
// 均值差的 t 检验在这种分布上几乎没有意义。改用：
//   - 中位数（抗尾）
//   - 各倍数档的胜率 + 两比例 z 检验（这才是"能不能赚到"的直接问法）
//   - MDE：告诉你以当前样本量，多大的差异才可能被检测出来
// 最后这条最重要——n 小的时候看到的差异多半是噪声，与其给个 p 值不如直说"这个样本量看不出来"。
import { WIN_THRESHOLD, twoProportionTestP, wilsonInterval, median } from './utils.js';
import { minDetectableDiff } from './analytics.js';

export const COMPARE_THRESHOLDS = [WIN_THRESHOLD, 5, 10];

export function compareGroups(aRows, bRows, { labelA = 'A', labelB = 'B' } = {}) {
  const retA = aRows.map(r => Number(r.returnMax)).filter(Number.isFinite);
  const retB = bRows.map(r => Number(r.returnMax)).filter(Number.isFinite);
  if (!retA.length || !retB.length) return { error: '两组都需要有样本才能对比' };

  const rates = COMPARE_THRESHOLDS.map(t => {
    const kA = retA.filter(v => v > t).length, kB = retB.filter(v => v > t).length;
    const pA = kA / retA.length, pB = kB / retB.length;
    return {
      threshold: t, kA, kB, pA, pB,
      ciA: wilsonInterval(kA, retA.length), ciB: wilsonInterval(kB, retB.length),
      diff: pB - pA,
      p: twoProportionTestP(kA, retA.length, kB, retB.length),
    };
  });

  // MDE 按较小的那组算——检验能力受制于样本少的一侧
  const nEff = Math.min(retA.length, retB.length) * 2;
  const baseRate = rates[0].pA || 0.5;
  const mde = minDetectableDiff(nEff, baseRate);

  const medA = median(retA), medB = median(retB);
  // 用 reduce 而不是 Math.max(...retA)：retA/retB 是整组样本的 returnMax 全量数组，
  // 展开成参数列表在大样本（约 10 万起）会撞 JS 引擎的参数数量上限直接抛 RangeError，
  // 把「分组对比」整块打挂。同样的坑 factorLab.js 的 sweepScoreCutoffs 已经踩过并修过，
  // 这里是当时漏掉的三处之一（2026-07-29 补齐）。
  const maxOf = arr => arr.reduce((m, v) => (v > m ? v : m), -Infinity);
  const maxA = maxOf(retA), maxB = maxOf(retB);

  return {
    labelA, labelB,
    nA: retA.length, nB: retB.length,
    medianA: medA, medianB: medB, medianDiff: medB - medA,
    maxA, maxB,
    meanA: retA.reduce((s, v) => s + v, 0) / retA.length,
    meanB: retB.reduce((s, v) => s + v, 0) / retB.length,
    rates, mde,
    // 样本量够不够：观察到的最大胜率差没超过 MDE 时，任何"看起来的差异"都读不出结论
    underpowered: Number.isFinite(mde) && maxOf(rates.map(r => Math.abs(r.diff))) < mde,
  };
}
