// Ranking metrics. `ranked` is a list of record keys, best first. Duplicates are removed first
// (a record can only count once). `relevant` is a Set of keys; `grades` is { key: grade }.
//
// Definitions (K = cut-off, R = set of relevant records):
//   Precision@K = hits in top K / K            (K, not "results returned": returning fewer is not rewarded)
//   Recall@K    = hits in top K / |R|
//   F1@K        = 2PR/(P+R) per query (0 when P+R = 0), then averaged over queries
//   RR@K        = 1 / rank of the first relevant record within K, else 0   (MRR = mean RR)
//   AP@K        = sum over relevant ranks i <= K of Precision@i / min(|R|, K)   (MAP = mean AP)
//   NDCG@K      = DCG@K / IDCG@K, DCG = sum grade_i / log2(i + 1), linear graded gain
// Metrics that need |R| > 0 return null for queries with no relevant record.

export function dedupe(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

const top = (ranked, k) => dedupe(ranked).slice(0, k);

export function precisionAtK(ranked, relevant, k) {
  return top(ranked, k).filter((id) => relevant.has(id)).length / k;
}

export function recallAtK(ranked, relevant, k) {
  if (relevant.size === 0) return null;
  return top(ranked, k).filter((id) => relevant.has(id)).length / relevant.size;
}

export function f1(p, r) {
  if (p === null || r === null) return null;
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

export function reciprocalRankAtK(ranked, relevant, k) {
  if (relevant.size === 0) return null;
  const i = top(ranked, k).findIndex((id) => relevant.has(id));
  return i === -1 ? 0 : 1 / (i + 1);
}

export function averagePrecisionAtK(ranked, relevant, k) {
  if (relevant.size === 0) return null;
  let hits = 0;
  let sum = 0;
  top(ranked, k).forEach((id, i) => {
    if (relevant.has(id)) {
      hits += 1;
      sum += hits / (i + 1);
    }
  });
  return sum / Math.min(relevant.size, k);
}

export function dcgAtK(gains, k) {
  return gains.slice(0, k).reduce((acc, g, i) => acc + g / Math.log2(i + 2), 0);
}

export function ndcgAtK(ranked, grades, k) {
  const ideal = Object.values(grades).filter((g) => g > 0).sort((a, b) => b - a);
  const idcg = dcgAtK(ideal, k);
  if (idcg === 0) return null;
  return dcgAtK(top(ranked, k).map((id) => grades[id] ?? 0), k) / idcg;
}

export function relevantSet(grades, minGrade) {
  return new Set(Object.entries(grades).filter(([, g]) => g >= minGrade).map(([key]) => key));
}

// All metrics for one query. strict = grade >= strictMin, lenient = grade >= lenientMin.
export function evaluateQuery({ ranked, grades, k, strictMin = 2, lenientMin = 1 }) {
  const deduped = dedupe(ranked);
  const view = (min) => {
    const rel = relevantSet(grades, min);
    const p = precisionAtK(deduped, rel, k);
    const r = recallAtK(deduped, rel, k);
    return {
      relevant_count: rel.size,
      p,
      r,
      f1: f1(p, r),
      rr: reciprocalRankAtK(deduped, rel, k),
      ap: averagePrecisionAtK(deduped, rel, k),
    };
  };
  return { returned: deduped.length, ndcg: ndcgAtK(deduped, grades, k), strict: view(strictMin), lenient: view(lenientMin) };
}
