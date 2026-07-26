// 多天 calls/snapshots 合并去重（DataLoader 多文件上传用）。
// 去重必须发生在 buildRows 之前——同一条 call 出现两次会在结果里生成两行完全相同的样本，
// 所有统计的 n 都会虚高。
import { snapKey, tsOrZeroMs } from './data.js';

// calls 去重键：优先 id；缺 id 时退化到 token_address+timestamp（同一条 call 在多天导出里
// 这两个值不变）。
function callDedupKey(c) {
  if (c && c.id != null) return 'id:' + c.id;
  return 'k:' + (c && c.token_address) + '_' + (c && c.timestamp);
}

// calls 重复时保留 timestamp 更大的那条——导出越晚观察窗越长，max_mcap/returnMax 越接近定型；
// snapshots 按 snapKey+timestamp 去重，保留首见（同键快照内容相同，先后无差别）。
export function mergeDaily(callsArrays, snapsArrays) {
  const callMap = new Map();
  let dupCalls = 0;
  for (const arr of callsArrays) for (const c of arr) {
    const k = callDedupKey(c);
    const prev = callMap.get(k);
    if (!prev) { callMap.set(k, c); continue; }
    dupCalls++;
    if (tsOrZeroMs(c.timestamp) > tsOrZeroMs(prev.timestamp)) callMap.set(k, c);
  }
  const snapSeen = new Set();
  const snapshots = [];
  let dupSnaps = 0;
  for (const arr of snapsArrays) for (const s of arr) {
    const k = snapKey(s) + '_' + tsOrZeroMs(s.timestamp);
    if (snapSeen.has(k)) { dupSnaps++; continue; }
    snapSeen.add(k);
    snapshots.push(s);
  }
  return { calls: [...callMap.values()], snapshots, dupCalls, dupSnaps };
}
