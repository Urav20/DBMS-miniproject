// The comparison runner. It is backend-agnostic: it receives method objects ({ name, search(text) })
// so the same code runs against the live stack or against fakes in unit tests.
//
// For every method, on the same queries and the same labels:
//   1. warm-up pass   : every query once, results discarded; the very first call is recorded as the
//                        FIRST-CALL latency (in this process, after earlier methods ran: NOT an independent
//                        cold start; see src/cold.mjs for fresh-process cold probes)
//   2. timed passes   : `timedPasses` full passes; latency samples = every (query, pass) call
//   3. quality        : computed from the first timed pass; later passes must return the same list
import { evaluateQuery } from "./metrics.mjs";
import { aggregateQuality } from "./aggregate.mjs";
import { mean, summarizeMs, pairedBootstrap } from "./stats.mjs";

const STAGE_KEYS = (rows) => [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))];

export async function runEvaluation({ methods, queries, qrels, idToKey, config, now = () => performance.now(), log = () => {} }) {
  const { k, latency, bootstrap } = config;
  if (latency.warmupPasses < 1 || latency.timedPasses < 1) throw new RangeError("need >= 1 warm-up and >= 1 timed pass");
  const out = {};

  for (const method of methods) {
    log(`method ${method.name}: warm-up (${queries.length} queries)`);
    let firstCall = null;
    for (let p = 0; p < latency.warmupPasses; p += 1) {
      for (const q of queries) {
        const t0 = now();
        await method.search(q.text);
        const ms = now() - t0;
        if (firstCall === null) firstCall = { ms, query_id: q.id };
      }
    }

    const samples = [];
    const stageSamples = [];
    const perQuery = new Map(queries.map((q) => [q.id, { query_id: q.id, category: q.category, ranked_ids: null, ms: [] }]));
    let unstable = 0;
    for (let p = 0; p < latency.timedPasses; p += 1) {
      log(`method ${method.name}: timed pass ${p + 1}/${latency.timedPasses}`);
      for (const q of queries) {
        const t0 = now();
        const res = await method.search(q.text);
        const ms = now() - t0;
        const rec = perQuery.get(q.id);
        rec.ms.push(ms);
        samples.push(ms);
        if (res.stages) stageSamples.push(res.stages);
        const ids = res.ids.slice(0, k);
        if (rec.ranked_ids === null) rec.ranked_ids = ids;
        else if (JSON.stringify(rec.ranked_ids) !== JSON.stringify(ids)) {
          unstable += 1;
        }
      }
    }

    const rows = [];
    for (const q of queries) {
      const rec = perQuery.get(q.id);
      const unmapped = rec.ranked_ids.filter((id) => !idToKey.has(id));
      if (unmapped.length) {
        throw new Error(`${method.name} returned ${unmapped.length} record(s) that are not part of the evaluation dataset (query ${q.id}). The evaluation database must hold only evaluation records.`);
      }
      const ranked = rec.ranked_ids.map((id) => idToKey.get(id));
      rows.push({
        query_id: q.id, category: q.category, text: q.text, ranked_keys: ranked,
        metrics: evaluateQuery({ ranked, grades: qrels[q.id], k }),
        median_ms: summarizeMs(rec.ms).median,
      });
    }

    out[method.name] = {
      per_query: rows,
      quality: aggregateQuality(rows),
      latency: {
        first_call_in_process_ms: firstCall,
        warm: summarizeMs(samples),
        warm_per_query_median_mean_ms: mean(rows.map((r) => r.median_ms)),
        stages_mean_ms: Object.fromEntries(STAGE_KEYS(stageSamples).map((s) => [s, mean(stageSamples.map((x) => x[s] ?? null))])),
      },
      unstable_rankings_across_passes: unstable,
    };
  }

  return { methods: out, comparisons: compare(out, bootstrap) };
}

// Hybrid against each single method, per metric, on answerable queries only.
export function compare(results, bootstrap) {
  if (!results.hybrid) return {};
  const metricOf = { ndcg: (r) => r.metrics.ndcg, map: (r) => r.metrics.strict.ap, mrr: (r) => r.metrics.strict.rr, p_at_k: (r) => r.metrics.strict.p, r_at_k: (r) => r.metrics.strict.r, f1_at_k: (r) => r.metrics.strict.f1 };
  const out = {};
  for (const other of ["keyword", "vector"]) {
    if (!results[other]) continue;
    out[`hybrid_vs_${other}`] = {};
    for (const [name, get] of Object.entries(metricOf)) {
      const a = results.hybrid.per_query.map((r) => (r.metrics.strict.relevant_count > 0 ? get(r) : null));
      const b = results[other].per_query.map((r) => (r.metrics.strict.relevant_count > 0 ? get(r) : null));
      out[`hybrid_vs_${other}`][name] = pairedBootstrap(a, b, bootstrap);
    }
  }
  return out;
}
