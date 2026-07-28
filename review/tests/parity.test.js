// 新旧两版对拍：同一份数据分别喂给 js/（旧，全局脚本）和 src/lib/（新，ES 模块），
// 逐项核对结果是否一致。这是整次重构真正的验收——测试通过只能说明新代码自洽，
// 对拍通过才能说明"行为没变"。
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 把旧版按老方式（vm + 全局作用域）加载起来，尽量还原它在浏览器里的运行环境
function loadLegacy() {
  const sandbox = { console };
  vm.createContext(sandbox);
  sandbox.customFields = [];
  sandbox.matchedRows = [];
  sandbox.activeRows = [];
  for (const f of ['utils.js', 'dictionary.js', 'data.js', 'custom-fields.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox;
}

export function makeFixture(n = 120) {
  let seed = 20260722;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const calls = [], snapshots = [];
  for (let i = 0; i < n; i++) {
    const t = 1784690000000 + i * 600000;
    const ca = 'CA' + String(i).padStart(3, '0');
    const init = 5000 + rnd() * 20000;
    const sv = rnd() * 100;
    calls.push({ id: i + 1, token_address: ca, swap_begin_time: Math.floor(t / 1000), timestamp: t,
      symbol: 'TK' + i, initial_mcap: init, current_mcap: init * (1 + rnd()),
      max_mcap: init * (1 + Math.pow(rnd(), 2) * (sv > 60 ? 6 : 1) * 3) });
    snapshots.push({ timestamp: t, signal: {
      token_address: ca, swap_begin_time: Math.floor(t / 1000), symbol: 'TK' + i,
      smart_volume: sv, new_volume: rnd() * 80, shit_volume: rnd() * 20,
      buyer_count_d1: Math.round(rnd() * 3000), total_supply: 1e9,
      // 让信号/量能/持有人几条支路都被触发，覆盖面更宽
      v_breakout_volume_list: [{ n_pattern_confirmed: true, signalTime: Math.floor(t / 1000) - 300,
        top_price_time: Math.floor(t / 1000) - 600, low_price_time: Math.floor(t / 1000) - 400,
        n_pattern_retracement: rnd(), fibon_break4: rnd() }],
    }, ctx: {
      kline_and_indicators: {
        resolution: 60, current_avg_price: 0.00002, kline_is_usd: true,
        avg_price_deviation_pct: rnd() * 200 - 100,
        avg_price_bars: [{ time: Math.floor(t / 1000) - 600, value: 0.000018 }],
        kline_bars: Array.from({ length: 40 }, (_, k) => ({
          time: t - k * 60000, open: 1 + rnd() * 0.1, high: 1.2 + rnd() * 0.1,
          low: 0.9 - rnd() * 0.1, close: 1.1 + rnd() * 0.1,
          volume: 100 + rnd() * 900, token_volume: 1000 + rnd() * 9000 })),
      },
      holders: Array.from({ length: 40 }, (_, k) => ({
        addr_type: k === 0 ? 2 : 0, address: 'W' + k, balance: (40 - k) * 1000,
        amount_percentage: (40 - k) * 1000 / 1e9, buy_volume_cur: rnd() * 100,
        buy_amount_cur: 1e6, history_bought_cost: rnd() * 50, history_bought_fee: rnd(),
        sell_amount_cur: k % 3 ? 0 : 5e5, history_sold_income: k % 3 ? 0 : rnd() * 80,
        history_sold_fee: 0, sell_tx_count_cur: k % 3 ? 0 : 1, realized_profit: k % 5 ? 0 : -1,
        unrealized_pnl: rnd() * 8 - 1, avg_cost: 0.00001 + rnd() * 0.00004,
        native_balance: k % 7 ? '100' : '0', start_holding_at: Math.floor(t / 1000) - (k % 4) * 60,
        tags: k % 6 ? [] : ['kol'], maker_token_tags: k % 4 ? ['bundler'] : ['sniper'],
        transfer_in: false, is_new: k % 3 === 0, is_suspicious: k % 11 === 0,
        native_transfer: { from_address: k % 5 ? 'PRIV_' + (k % 3) : 'CEX', name: k % 5 ? null : 'Binance' },
        token_transfer_in: null, token_transfer_out: null,
      })),
    } });
  }
  return { calls, snapshots };
}

export function run(test, testAsync) {
  // 对拍契约的演进：迁移阶段它验证"src 与 js 逐字节一致"。迁移完成后 src 成了活代码、
  // js 冻结，src 会【有意地领先】——新增字段、删掉冗余字段。所以契约改成：
  //   • src 新增字段（js 没有）→ 允许（加法不破坏共享逻辑）
  //   • src 改动或丢失 js 已有字段的值 → 报错（共享逻辑不许退化），除非在下面白名单里
  // 白名单里每一项都是这个会话里【有意】改动 src 而没同步 js 的，附原因。
  const INTENTIONAL_SRC_ONLY_REMOVED = new Set([
    'chip_analysis.pressure_net',   // 与 above_below_ratio 数学冗余，已从 src 移除（js 冻结未动）
  ]);

  testAsync('对拍：新旧两版 buildRows 应产出完全相同的行与字段值', async () => {
    const { calls, snapshots } = makeFixture();
    const legacy = loadLegacy();
    const { buildRows } = await import('../src/lib/data.js');

    const oldRows = await legacy.buildRows(calls, snapshots);
    const newRows = await buildRows(calls, snapshots);

    assert.strictEqual(newRows.length, oldRows.length, '行数应一致');
    assert.ok(oldRows.length > 50, `样本量太小对拍没意义，实际 ${oldRows.length}`);

    const diffs = [];
    for (let i = 0; i < oldRows.length; i++) {
      const o = oldRows[i], nw = newRows[i];
      if (o.tokenAddress !== nw.tokenAddress) diffs.push(`行${i} tokenAddress 不一致`);
      if (Math.abs(o.returnMax - nw.returnMax) > 1e-12) diffs.push(`行${i} returnMax ${o.returnMax} vs ${nw.returnMax}`);
      const keys = new Set([...Object.keys(o.features), ...Object.keys(nw.features)]);
      for (const k of keys) {
        const a = o.features[k], b = nw.features[k];
        if (a === undefined && b === undefined) continue;
        // src 新增字段（旧无新有）：加法，允许
        if (a === undefined && b !== undefined) continue;
        // src 丢了 js 有的字段（旧有新无）：默认算退化，除非是有意移除
        if (a !== undefined && b === undefined) {
          if (!INTENTIONAL_SRC_ONLY_REMOVED.has(k)) diffs.push(`行${i} 字段 ${k} 在新版丢失（旧=${a}）`);
          continue;
        }
        if (typeof a === 'number' && typeof b === 'number') {
          if (!(Object.is(a, b) || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)))) {
            diffs.push(`行${i} 字段 ${k}：旧=${a} 新=${b}`);
          }
        } else if (a !== b) diffs.push(`行${i} 字段 ${k}：旧=${JSON.stringify(a)} 新=${JSON.stringify(b)}`);
      }
      if (diffs.length > 8) break;
    }
    assert.deepStrictEqual(diffs, [], '字段值应逐个一致：\n' + diffs.slice(0, 8).join('\n'));

    const fieldCount = Object.keys(newRows[0].features).length;
    assert.ok(fieldCount > 30, `对拍覆盖的字段数应足够多，实际 ${fieldCount}`);
  });

  testAsync('对拍：新旧两版 computeCorrelations 结果应一致', async () => {
    const { calls, snapshots } = makeFixture(100);
    const legacy = loadLegacy();
    const { buildRows, computeCorrelations } = await import('../src/lib/data.js');
    const rows = await buildRows(calls, snapshots);
    legacy.matchedRows = rows;

    const oldList = legacy.computeCorrelations(rows);
    const newList = computeCorrelations(rows);
    assert.strictEqual(newList.length, oldList.length, '参与检验的字段数应一致');

    const key = x => `${x.target}|${x.feature}`;
    const oldMap = new Map(oldList.map(x => [key(x), x]));
    const diffs = [];
    for (const nx of newList) {
      const ox = oldMap.get(key(nx));
      if (!ox) { diffs.push(`新版多出 ${key(nx)}`); continue; }
      // 'p' 是有意的行为分叉，不是移植疏漏：旧版（js/data.js，legacy UI 按线性 r 排序/筛选）的 p
      // 算的是 r 的显著性；新版（React UI）已把 Spearman ρ 提为主排序指标（P1-1），p 若还按 r 算，
      // 会跟界面上加★的 ρ 对不上（曾是真实 bug）。新版另存了一份 'pr'（=旧版 p 的算法），
      // 下面单独拿它跟旧版 p 对比，确认"旧算法本身没被改坏"，只是不再挂在 'p' 这个字段名下。
      for (const f of ['r', 'rho', 'n', 'quality']) {
        const a = ox[f], b = nx[f];
        if (Number.isFinite(a) && Number.isFinite(b)) {
          if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(a))) diffs.push(`${key(nx)}.${f}：旧=${a} 新=${b}`);
        } else if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) {
          diffs.push(`${key(nx)}.${f}：旧=${a} 新=${b}`);
        }
      }
      const op = ox.p, npr = nx.pr;
      if (Number.isFinite(op) && Number.isFinite(npr)) {
        if (Math.abs(op - npr) > 1e-9 * Math.max(1, Math.abs(op))) diffs.push(`${key(nx)}.p(旧)≠pr(新)：旧=${op} 新=${npr}`);
      } else if (op !== npr && !(Number.isNaN(op) && Number.isNaN(npr))) {
        diffs.push(`${key(nx)}.p(旧)≠pr(新)：旧=${op} 新=${npr}`);
      }
    }
    assert.deepStrictEqual(diffs.slice(0, 8), [], '相关性结果应一致');

    // 候选池剔除的口径也要一致。这里【必须】按成员比对，不能用 deepStrictEqual：
    // 旧版的数组是在 vm 沙箱里创建的，它们的 Array.prototype 与主 realm 不是同一个对象，
    // deepStrictEqual 会因为跨 realm 的原型不匹配报
    // "Values have same structure but are not reference-equal"——内容明明一致却判红。
    // 顺带好处：精简 diff 只打印真正不同的字段，而不是把两个几十项的对象整个吐出来。
    const bucketDiffs = [];
    const allKeys = new Set([...Object.keys(oldList._excluded), ...Object.keys(newList._excluded)]);
    for (const k of allKeys) {
      const A = (oldList._excluded[k] || []).slice().sort();
      const B = (newList._excluded[k] || []).slice().sort();
      const onlyOld = A.filter(x => !B.includes(x));
      const onlyNew = B.filter(x => !A.includes(x));
      if (onlyOld.length) bucketDiffs.push(`${k} 仅旧版有：${onlyOld.slice(0, 5).join(', ')}`);
      if (onlyNew.length) bucketDiffs.push(`${k} 仅新版有：${onlyNew.slice(0, 5).join(', ')}`);
    }
    assert.deepStrictEqual(bucketDiffs, [], '剔除分桶应一致：\n' + bucketDiffs.join('\n'));
  });
}
