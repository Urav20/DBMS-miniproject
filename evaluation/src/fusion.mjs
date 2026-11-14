// Reciprocal Rank Fusion (Cormack et al. 2009): score(d) = sum over lists of 1 / (k + rank(d)),
// rank starting at 1. Uses ranks only, so the incomparable keyword and cosine scores never mix.
// Ties are broken by the best (smallest) rank in any list, then by id, so the result is deterministic.
export function reciprocalRankFusion(lists, k = 60) {
  const acc = new Map();
  for (const list of lists) {
    const seen = new Set();
    let rank = 0;
    for (const id of list) {
      if (seen.has(id)) continue; // a list can contribute a record once
      seen.add(id);
      rank += 1;
      const e = acc.get(id) ?? { id, score: 0, best: Infinity };
      e.score += 1 / (k + rank);
      e.best = Math.min(e.best, rank);
      acc.set(id, e);
    }
  }
  return [...acc.values()].sort((x, y) => y.score - x.score || x.best - y.best || String(x.id).localeCompare(String(y.id), "en", { numeric: true }));
}
