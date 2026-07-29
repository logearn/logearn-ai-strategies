// ========== 上线代码覆盖度守护测试 ==========
// 背景：FactorLab 会把"组装字段"（data.js 里 features['xxx']=... 算出来、原始 ctx 没有的字段）
// 标成"映射不回 ctx，上线后恒为缺失"。但很多组装字段其实是有【现成公式】的（比如
// chip_analysis.above_below_ratio、holder_hhi），只是没人把公式搬进 onlineExport.js 的 BLOCKS
// 注册表——那才是它们在生成的上线代码里变成 null 的真正原因，不是"不可能算"。
//
// 这个测试做的事：静态扫描 data.js 源码里所有 features['字段名']=/ features["字段名"]=/
// features[`字段名`]= 这种【字面量键】赋值，把 review 侧实际会产出的组装字段名字全部枚举出来
// （不依赖任何手工维护的清单，新增一行 features['xxx']=... 自动被扫到）；对每一个被
// classifyFieldOrigin 判定"非原字段"的，检查它是否已经在 onlineExport.js 的 FIELD_TO_BLOCK
// 里登记过派生算法——没有的话，要么是真该搬（还没搬）的缺口，要么就得进下面的 EXEMPT 显式豁免
// 清单（附无法/不该搬的理由）。CI 意义：以后谁加新组装字段，不补 BLOCKS 或不补豁免理由，这个
// 测试就会红，不会再悄悄漏掉。
//
// 已知不在扫描范围内（不是缺陷，是这个正则的天然边界，见下）：
//   1. 动态模板键 features[`holder_top${N}_share_pct`] 这类——正则只认字面量键，扫不到。
//      这几个字段（holder_top30/50_share_pct 等 8 个）已经在 onlineExport.js 的 holderStats
//      块里正确注册，只是不会被这条正则"发现"，不影响其正确性，只是测不到它们。
//   2. composite_score（Pro"组合评分"）、customFields（用户在 UI 自定义的任意公式字段）——
//      两者都不是 data.js 里的字面量 features[...]= 赋值，天然不在这次扫描范围内，需要单独评估
//      （见 review/找因子流程与函数说明.md 或相关 task 记录），不属于这条测试要守的范围。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyFieldOrigin } from '../src/lib/factorLab.js';
import { FIELD_TO_BLOCK } from '../src/lib/onlineExport.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 扫描 data.js 源码，提取所有 features[字面量键] = 赋值出现过的字段名（去重）。
// 只认单引号/双引号/反引号包裹、且内容只含字段名合法字符（字母数字下划线点号）的字面量——
// 反引号模板里带 ${...} 插值的动态键会因为内容含 $ { } 而不匹配，安全跳过（见文件头注释①）。
function scanAssembledFieldNames() {
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/data.js'), 'utf8');
  const re = /features\[(['"`])([a-zA-Z0-9_.]+)\1\]\s*=/g;
  const keys = new Set();
  let m;
  while ((m = re.exec(src))) keys.add(m[2]);
  return [...keys].sort();
}

// 显式豁免清单：字段名 → 不用/不能搬进 onlineExport.js 的理由。
// 每一条都必须是"经过判断、真的不该自动内联"，不是"还没来得及搬"的借口——后者应该去补 BLOCKS，
// 不是加进这里。加新豁免项时请在这里写清楚为什么。
const EXEMPT = {
  // 依赖买入之后才知道的数据（call.min_mcap 是买入后市值最低点），任何用它做打分因子的策略
  // 都是前视偏差（look-ahead bias）——该做的是把它从因子池删掉，不是指望上线代码把它"算出来"
  // （买点当刻根本不存在这个数）。data.js:391-393。
  'post_buy_max_drawdown_pct': '事后特征（依赖买入后的 min_mcap），不该被当作买点打分因子，应从因子池删除而非上线内联',
};

export function run(test) {
  test('data.js 里出现过的组装字段，要么已在 onlineExport.js 登记派生算法，要么在 EXEMPT 里说明原因', () => {
    const allKeys = scanAssembledFieldNames();
    assert.ok(allKeys.length > 50, `扫到的字段数太少（${allKeys.length}），正则可能没生效`);

    const assembled = allKeys.filter(k => !classifyFieldOrigin(k).original);
    const gap = assembled.filter(k => !FIELD_TO_BLOCK.has(k) && !(k in EXEMPT));

    assert.deepStrictEqual(gap, [],
      `以下 ${gap.length} 个组装字段既没有在 onlineExport.js 的 BLOCKS 里登记派生算法，也没有在本文件的 ` +
      `EXEMPT 里说明豁免理由——上线代码生成时它们会变成字面量 null（记0分但权重仍占分母）：\n` +
      gap.join('、'));

    // 反向校验：EXEMPT 里的字段必须真实存在于当前 data.js（防止字段改名/删除后豁免项变成死配置，
    // 悄悄掩盖掉一个本该重新评估的新字段——如果 EXEMPT 的 key 已经不再是任何真实字段，说明配置
    // 该清理了）。
    for (const k of Object.keys(EXEMPT)) {
      assert.ok(allKeys.includes(k), `EXEMPT 里的 "${k}" 在 data.js 里已经找不到对应字段了，该清理这条豁免`);
    }
  });

  test('FIELD_TO_BLOCK 覆盖的字段名不应与 EXEMPT 重叠（避免两边同时维护、口径漂移）', () => {
    const overlap = Object.keys(EXEMPT).filter(k => FIELD_TO_BLOCK.has(k));
    assert.deepStrictEqual(overlap, [], `以下字段同时出现在 FIELD_TO_BLOCK 和 EXEMPT：${overlap.join('、')}——留一处就行`);
  });
}
