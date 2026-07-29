// 差分测试：recommendBreakpoints / mineBreakpointsOOS 两个函数
// 在搬运时改了签名（全局 activeRows / scatterOptions / currentWinThreshold → 入参），
// 不再是逐字节机械搬运，所以必须证明"签名变了但行为没变"：
// 同一份数据分别喂给旧版（vm 里设好全局）和新版（参数传入），断言输出一致。
// 2026-07-29：scanFieldsForPeaks 差分测试已删——该函数只服务已删除的"波峰扫描"面板
// （见 src/ui/FieldHealth.jsx），随之一并删除。
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recommendBreakpoints, mineBreakpointsOOS, calibrateOOSMining } from '../src/lib/analytics.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 旧版这几个函数在 charts.js 里，而 charts.js 顶层有大量 DOM 操作会直接抛。
// 这里只把它们需要的依赖 + 函数本体挑出来在 vm 里跑，不加载整个 charts.js。
function loadLegacyAnalytics(rows, candidateFields, winThreshold) {
  const sandbox = { console, activeRows: rows, scatterOptions: candidateFields,
    currentWinThreshold: () => winThreshold, isTrustedField: () => true,
    matchedRows: rows, customFields: [] };
  vm.createContext(sandbox);
  for (const f of ['utils.js', 'dictionary.js', 'data.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), sandbox, { filename: f });
  }
  const src = fs.readFileSync(path.join(ROOT, 'js', 'charts.js'), 'utf8');
  const lines = src.split('\n');
  const pick = name => {
    const starts = lines.map((l, i) => [i, /^(?:async )?function ([A-Za-z0-9_$]+)/.exec(l)])
      .filter(([, m]) => m).map(([i, m]) => [i, m[1]]);
    const k = starts.findIndex(([, n]) => n === name);
    const i = starts[k][0], e = k + 1 < starts.length ? starts[k + 1][0] : lines.length;
    return lines.slice(i, e).join('\n');
  };
  // 这几个函数依赖的其它纯函数也要一起放进去
  for (const n of ['binLabel', 'parseBreakpoints', 'minDetectableDiff', 'winRateOf',
                   'recommendBreakpoints', 'mineBreakpointsOOS']) {
    vm.runInContext(pick(n), sandbox, { filename: n });
  }
  return sandbox;
}

function fixture(n = 200) {
  let seed = 424242;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: n }, () => {
    const good = rnd();
    return {
      returnMax: good > 0.55 ? 1 + rnd() * 12 : 0.3 + rnd() * 1.6,
      features: { sig: good * 100, noise: rnd() * 100, few: rnd() > 0.8 ? rnd() * 10 : null },
    };
  });
}

// 递归比较，容忍浮点误差；同时绕开 vm 跨 realm 的原型不匹配
// （deepStrictEqual 会因为旧版数组来自另一个 realm 而误报 not reference-equal）
function sameDeep(a, b, pathStr = '', out = []) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (!(Object.is(a, b) || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)))) out.push(`${pathStr}: ${a} vs ${b}`);
    return out;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) { out.push(`${pathStr}: 一侧不是数组`); return out; }
    if (a.length !== b.length) { out.push(`${pathStr}: 长度 ${a.length} vs ${b.length}`); return out; }
    a.forEach((v, i) => sameDeep(v, b[i], `${pathStr}[${i}]`, out));
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) sameDeep(a[k], b[k], pathStr ? `${pathStr}.${k}` : k, out);
    return out;
  }
  if (a !== b) out.push(`${pathStr}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  return out;
}

export function run(test) {
  test('差分：recommendBreakpoints 改签名后结果应与旧版一致', () => {
    const rows = fixture();
    const legacy = loadLegacyAnalytics(rows, ['sig', 'noise'], 2);
    for (const field of ['sig', 'noise']) {
      const o = legacy.recommendBreakpoints(field, 'returnMax');
      const n = recommendBreakpoints(rows, field, 'returnMax');
      assert.deepStrictEqual(sameDeep(o, n), [], `${field} 结果不一致`);
    }
  });

  test('差分：mineBreakpointsOOS 改签名后结果应与旧版一致', () => {
    const rows = fixture();
    const legacy = loadLegacyAnalytics(rows, ['sig', 'noise'], 2);
    for (const field of ['sig', 'noise']) {
      const o = legacy.mineBreakpointsOOS(field, 'returnMax', 20);
      const n = mineBreakpointsOOS(rows, field, 'returnMax', 20);
      assert.deepStrictEqual(sameDeep(o, n), [], `${field} 结果不一致`);
    }
  });

  test('calibrateOOSMining: 应能把真信号和纯噪声区分开', () => {
    // 样本外挖掘会在几十个候选切点里挑测试集最好的一个，等于把选择偏差带回测试集——
    // 纯噪声也能挑出 1.5x 的"最佳切点"。这里用置换零分布校准，不靠写死阈值。
    let s = 31;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const rows = Array.from({ length: 300 }, () => {
      const g = rnd();
      return { returnMax: g > 0.6 ? (1 + rnd() * 12) : (0.3 + rnd() * 1.6),
               features: { sig: g * 100, noise: rnd() * 100 } };
    });
    let s2 = 99;
    const permRnd = () => (s2 = (s2 * 1103515245 + 12345) % 2147483648) / 2147483648;

    const sig = calibrateOOSMining(rows, 'sig', 'returnMax', 24, 20, permRnd);
    const noise = calibrateOOSMining(rows, 'noise', 'returnMax', 24, 20, permRnd);

    assert.ok(sig.observed > sig.null95, `真信号的观测值应超出零分布 95 分位：${sig.observed} vs ${sig.null95}`);
    assert.ok(sig.p <= 0.1, `真信号 p 应较小，实际 ${sig.p}`);
    assert.ok(noise.observed <= noise.null95 * 1.05, `噪声不应显著超出零分布：${noise.observed} vs ${noise.null95}`);
    assert.ok(noise.p > sig.p, `噪声的 p 应明显大于真信号：${noise.p} vs ${sig.p}`);
    // 零分布中位数应接近 1（打散之后本来就不该有提升）
    assert.ok(Math.abs(noise.nullMedian - 1) < 0.2, `零分布中位数应接近 1，实际 ${noise.nullMedian}`);
  });

  test('calibrateOOSMining: 置换 p 不能为 0（+1 平滑）', () => {
    let s = 7;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const rows = Array.from({ length: 200 }, (_, i) => ({ returnMax: i < 100 ? 1 : 10, features: { f: i } }));
    const c = calibrateOOSMining(rows, 'f', 'returnMax', 20, 10, rnd);
    if (!c.error) assert.ok(c.p >= 1 / (c.permN + 1), 'p 有下界，不能是 0');
  });

  test('新版不再依赖任何全局：不设 activeRows 也能正常工作', () => {
    // 这是改签名的直接收益——函数变成可测的纯函数
    const rows = fixture(120);
    assert.ok(recommendBreakpoints(rows, 'sig', 'returnMax'));
    assert.ok(mineBreakpointsOOS(rows, 'sig', 'returnMax', 15));
  });
}
