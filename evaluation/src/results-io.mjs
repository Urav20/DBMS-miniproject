// Machine-readable outputs: results-<size>.json (everything), per-query-<size>.csv, summary-<size>.csv.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "results");

const cell = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(6);
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header, rows) => [header.join(","), ...rows.map((r) => header.map((h) => cell(r[h])).join(","))].join("\n") + "\n";

export function perQueryRows(size, methods) {
  const rows = [];
  for (const [method, res] of Object.entries(methods)) {
    for (const r of res.per_query) {
      rows.push({
        size, method, query_id: r.query_id, category: r.category, query: r.text,
        relevant: r.metrics.strict.relevant_count, returned: r.metrics.returned,
        p_at_k: r.metrics.strict.p, r_at_k: r.metrics.strict.r, f1_at_k: r.metrics.strict.f1,
        rr: r.metrics.strict.rr, ap: r.metrics.strict.ap, ndcg_at_k: r.metrics.ndcg,
        median_ms: r.median_ms, top_keys: r.ranked_keys.join(" "),
      });
    }
  }
  return rows;
}
export const PER_QUERY_HEADER = ["size", "method", "query_id", "category", "query", "relevant", "returned", "p_at_k", "r_at_k", "f1_at_k", "rr", "ap", "ndcg_at_k", "median_ms", "top_keys"];

export function summaryRows(size, methods) {
  return Object.entries(methods).map(([method, res]) => {
    const o = res.quality.overall;
    const l = res.latency;
    return {
      size, method, answerable_queries: o.queries, p_at_k: o.p, r_at_k: o.r, f1_at_k: o.f1, mrr: o.rr, map: o.ap, ndcg_at_k: o.ndcg,
      lenient_p_at_k: o.lenient.p, lenient_r_at_k: o.lenient.r, lenient_mrr: o.lenient.rr, lenient_map: o.lenient.ap,
      no_answer_queries: res.quality.no_answer.queries, no_answer_with_results: res.quality.no_answer.queries_returning_any_result,
      first_call_in_process_ms: l.first_call_in_process_ms?.ms, warm_mean_ms: l.warm?.mean, warm_median_ms: l.warm?.median, warm_p95_ms: l.warm?.p95,
    };
  });
}
export const SUMMARY_HEADER = ["size", "method", "answerable_queries", "p_at_k", "r_at_k", "f1_at_k", "mrr", "map", "ndcg_at_k", "lenient_p_at_k", "lenient_r_at_k", "lenient_mrr", "lenient_map", "no_answer_queries", "no_answer_with_results", "first_call_in_process_ms", "warm_mean_ms", "warm_median_ms", "warm_p95_ms"];

export function writeResults(size, payload, dir = RESULTS_DIR) {
  mkdirSync(dir, { recursive: true });
  const files = {
    json: join(dir, `results-${size}.json`),
    perQuery: join(dir, `per-query-${size}.csv`),
    summary: join(dir, `summary-${size}.csv`),
  };
  writeFileSync(files.json, JSON.stringify(payload, null, 1) + "\n");
  writeFileSync(files.perQuery, toCsv(PER_QUERY_HEADER, perQueryRows(size, payload.methods)));
  writeFileSync(files.summary, toCsv(SUMMARY_HEADER, summaryRows(size, payload.methods)));
  return files;
}
