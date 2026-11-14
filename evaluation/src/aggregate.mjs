// Turns per-query metrics into method-level numbers.
// Aggregation: macro average over ANSWERABLE queries (>= 1 grade-2 record). Each query counts
// once, whatever its number of relevant records. no_answer queries are reported separately.
import { mean } from "./stats.mjs";

const STRICT = ["p", "r", "f1", "rr", "ap"];

function block(rows) {
  const out = { queries: rows.length, ndcg: mean(rows.map((r) => r.metrics.ndcg)) };
  for (const m of STRICT) out[m] = mean(rows.map((r) => r.metrics.strict[m]));
  out.lenient = {};
  for (const m of STRICT) out.lenient[m] = mean(rows.map((r) => r.metrics.lenient[m]));
  return out;
}

// rows: [{ query_id, category, metrics }]. Returned names: p = Precision@K, r = Recall@K,
// rr = MRR, ap = MAP (means of RR@K and AP@K).
export function aggregateQuality(rows) {
  const answerable = rows.filter((r) => r.metrics.strict.relevant_count > 0);
  const none = rows.filter((r) => r.metrics.strict.relevant_count === 0 && r.metrics.lenient.relevant_count === 0);
  const categories = [...new Set(answerable.map((r) => r.category))];
  return {
    overall: block(answerable),
    by_category: Object.fromEntries(categories.map((c) => [c, block(answerable.filter((r) => r.category === c))])),
    no_answer: {
      queries: none.length,
      mean_results_returned: mean(none.map((r) => r.metrics.returned)),
      queries_returning_any_result: none.filter((r) => r.metrics.returned > 0).length,
    },
  };
}
