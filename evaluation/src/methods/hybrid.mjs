// Hybrid retrieval = keyword list + vector list, fused with Reciprocal Rank Fusion (rank-based,
// so the two score scales never mix). Both lists are fetched at the same depth and each is
// restricted to the same cases. The two calls run one after the other so each stage's time is
// attributed cleanly; total latency is therefore keyword + vector + fusion.
// MySQL stays authoritative: the vector half already re-reads every record from MySQL.
import { reciprocalRankFusion } from "../fusion.mjs";

export function createHybridMethod({ keyword, vector, k, rrfK, now, name = "hybrid" }) {
  return {
    name,
    async search(text) {
      const t0 = now();
      const kw = await keyword.search(text);
      const t1 = now();
      const vec = await vector.search(text);
      const t2 = now();
      const fused = reciprocalRankFusion([kw.ids, vec.ids], rrfK).slice(0, k);
      const t3 = now();
      return {
        ids: fused.map((e) => e.id),
        scores: fused.map((e) => e.score),
        stages: { keyword_ms: t1 - t0, vector_ms: t2 - t1, fuse_ms: t3 - t2, ...Object.fromEntries(Object.entries(vec.stages ?? {}).map(([a, b]) => [`vector_${a}`, b])) },
        candidates: { keyword: kw.ids.length, vector: vec.ids.length },
      };
    },
  };
}
