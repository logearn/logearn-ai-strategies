import assert from 'node:assert';
import { buildCandidateExportTsv, CANDIDATE_EXPORT_COLUMNS } from '../src/lib/factorScanExport.js';

// 造一条勇者候选 + 一条邪恶候选
function heroCand() {
  return {
    field: 'buy_sell_count_ratio', n: 500, pos: 120, auc: 0.642, ci: [0.61, 0.67],
    direction: 'high', significant: true, significantAdj: true, pAdj: 0.0001,
    interval: { lo: 2, hi: Infinity, n: 180, lift: 1.8, coverage: 0.42 }, missRate: 0.05,
  };
}
function evilCand() {
  return {
    field: 'gmgn.stat.fresh_wallet_rate', n: 480, pos: 60, auc: 0.38, ci: [0.34, 0.42],
    direction: 'low', significant: false, significantAdj: false, pAdj: 0.2,
    interval: null, intervalError: '无推荐区间', missRate: 0.12,
  };
}

export function run(test) {
  test('buildCandidateExportTsv: 表头包含方向/coverage/CI 等挑因子必看列', () => {
    for (const col of ['阵营', '方向', 'coverage', 'CI下', 'CI上', '边际ρ(test)', '边际ρ(train)']) {
      assert.ok(CANDIDATE_EXPORT_COLUMNS.includes(col), `缺列 ${col}`);
    }
  });

  test('buildCandidateExportTsv: 合并两阵营，count=行数，阵营列正确', () => {
    const { text, count } = buildCandidateExportTsv([
      { camp: 'hero', list: [heroCand()] },
      { camp: 'evil', list: [evilCand()] },
    ], { getDesc: () => '含义X' });
    assert.strictEqual(count, 2);
    const lines = text.split('\n');
    assert.strictEqual(lines[0], CANDIDATE_EXPORT_COLUMNS.join('\t'));
    assert.ok(lines[1].startsWith('勇者\tbuy_sell_count_ratio\t含义X\t值大更好\t0.642\t'));
    assert.ok(lines[2].startsWith('邪恶\tgmgn.stat.fresh_wallet_rate\t含义X\t值小更好\t0.380\t'));
  });

  test('buildCandidateExportTsv: 无区间候选的区间/lift/coverage 应落成占位，不抛错', () => {
    const { text } = buildCandidateExportTsv([{ camp: 'evil', list: [evilCand()] }], {});
    const cells = text.split('\n')[1].split('\t');
    const idx = CANDIDATE_EXPORT_COLUMNS.indexOf('集中区间');
    assert.strictEqual(cells[idx], '无');
    assert.strictEqual(cells[CANDIDATE_EXPORT_COLUMNS.indexOf('coverage')], '-');
  });

  // 边际ρ 走 held-out 一套口径（computeHeldOutDeltaRho），导出 test/train 两列：
  // test 是挑因子的判据，train 并排放着才能一眼看出"只有 train 涨"的过拟合候选。
  test('buildCandidateExportTsv: 边际ρ test/train 各占一列，有值时三位小数、无值留空', () => {
    const withM = buildCandidateExportTsv([{ camp: 'hero', list: [heroCand()] }],
      { getMarginal: () => ({ deltaTest: 0.0123, deltaTrain: 0.0456 }) });
    const cellsM = withM.text.split('\n')[1].split('\t');
    assert.strictEqual(cellsM[CANDIDATE_EXPORT_COLUMNS.indexOf('边际ρ(test)')], '0.012');
    assert.strictEqual(cellsM[CANDIDATE_EXPORT_COLUMNS.indexOf('边际ρ(train)')], '0.046');
    const noM = buildCandidateExportTsv([{ camp: 'hero', list: [heroCand()] }], {});
    const cellsN = noM.text.split('\n')[1].split('\t');
    assert.strictEqual(cellsN[CANDIDATE_EXPORT_COLUMNS.indexOf('边际ρ(test)')], '');
    assert.strictEqual(cellsN[CANDIDATE_EXPORT_COLUMNS.indexOf('边际ρ(train)')], '');
  });

  test('buildCandidateExportTsv: meta 作为 # 注释行置顶', () => {
    const { text } = buildCandidateExportTsv([{ camp: 'hero', list: [heroCand()] }], { meta: '阈值=3x' });
    assert.ok(text.startsWith('# 阈值=3x\n'));
  });

  test('buildCandidateExportTsv: 空/缺列表安全返回 count=0', () => {
    assert.strictEqual(buildCandidateExportTsv([], {}).count, 0);
    assert.strictEqual(buildCandidateExportTsv([{ camp: 'hero', list: null }], {}).count, 0);
  });
}
