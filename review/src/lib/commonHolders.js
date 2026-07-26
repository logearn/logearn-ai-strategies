// 公共持有人提取：跨多个代币，找出在多个币的 holders 里都出现的钱包地址。
//
// 用途：一个钱包如果反复出现在你的多个（比如都是大涨的）币里，它可能是聪明钱、
// 狙击手、或同一个庄的地址。把这些"常客"挖出来，就能建自己的跟单/黑名单地址库。
//
// 口径：默认剔除 addr_type===2（交易所/流动性池），它们本来就出现在无数币里、没有意义。
// 同一个币里一个钱包只算一次（有的持有人列表会有重复行）。

export function extractCommonHolders(rows, { minTokens = 2, excludeExchange = true } = {}) {
  const byAddr = new Map();
  let withHolders = 0;
  for (const row of rows) {
    const holders = row.rawCtx && row.rawCtx.holders;
    if (!Array.isArray(holders) || !holders.length) continue;
    withHolders++;
    const seen = new Set();                       // 同一个币内去重
    for (const h of holders) {
      if (excludeExchange && Number(h && h.addr_type) === 2) continue;
      const addr = h && h.address;
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      if (!byAddr.has(addr)) byAddr.set(addr, { address: addr, count: 0, tokens: [], pcts: [], tags: new Set() });
      const rec = byAddr.get(addr);
      rec.count++;
      const pct = Number(h.amount_percentage);
      rec.tokens.push({ ca: row.tokenAddress || '', symbol: row.symbol || '',
        ret: Number(row.returnMax), pct: Number.isFinite(pct) ? pct * 100 : null });
      if (Number.isFinite(pct)) rec.pcts.push(pct);
      for (const t of (Array.isArray(h.tags) ? h.tags : [])) rec.tags.add(String(t));
      for (const t of (Array.isArray(h.maker_token_tags) ? h.maker_token_tags : [])) rec.tags.add(String(t));
    }
  }
  const addresses = [...byAddr.values()]
    .filter(r => r.count >= minTokens)
    .map(r => ({
      address: r.address,
      count: r.count,
      tokens: r.tokens.slice().sort((a, b) => (b.ret || 0) - (a.ret || 0)),
      avgPct: r.pcts.length ? r.pcts.reduce((a, b) => a + b, 0) / r.pcts.length * 100 : NaN,
      // 这些常客里，它持有的币平均涨了多少——高=它总在赢家里出现（跟单价值），低=它啥都买（噪声）
      avgRet: (() => {
        const rs = r.tokens.map(t => t.ret).filter(Number.isFinite);
        return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN;
      })(),
      tags: [...r.tags],
    }))
    .sort((a, b) => b.count - a.count || (b.avgRet || 0) - (a.avgRet || 0));
  return { addresses, withHolders, totalRows: rows.length };
}
