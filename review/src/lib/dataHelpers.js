// 判断某字段在这批行里是不是数值型。
// 旧版的 isNumericColumn 读全局 matchedRows，这里改成入参——同一个字段在不同工作集里
// 判定可能不同（过滤后可能只剩数值），把数据来源写死在全局会让结果不可预期。
import { getFeature } from './data.js';

export function isNumericLike(rows, field) {
  let seen = 0;
  for (const r of rows) {
    const v = getFeature(r, field);
    if (v === undefined || v === null || v === '') continue;
    if (!Number.isFinite(Number(v))) return false;
    seen++;
    if (seen > 200) break;   // 看前 200 个有效值足够定性，不必扫全量
  }
  return seen > 0;
}
