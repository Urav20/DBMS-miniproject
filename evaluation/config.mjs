// Fixed experiment parameters. Everything that affects a result lives here and is copied into
// every results file, so a run can be reproduced and audited.

export const EVAL_PREFIX = "tracex_eval"; // every database and Qdrant collection used here starts with this
export const SIZES = Object.freeze([500, 2000]);
export const SEED = 20260509; // dataset generator seed
export const DATASET_VERSION = 1;

export const K = 10; // cut-off for every @K metric and for what each method returns
export const DEPTH = 50; // candidates the hybrid method takes from EACH list (Phase 3 allows at most 50)
export const RRF_K = 60; // reciprocal-rank-fusion constant, fixed in advance (not tuned on labels)
// Evaluation cases the records are spread over. Two limits shape this number:
//  - Phase 3 search accepts at most 50 case ids;
//  - sp_register_evidence numbers evidence with LPAD(n, 2, '0'), which TRUNCATES at 100, so one case can hold at
//    most 99 records (found by running the 2,000-record load on a real MySQL). 2000 / 40 = 50 per case.
export const CASES = 40;
export const MAX_RECORDS_PER_CASE = 99;

export const LATENCY = Object.freeze({ warmupPasses: 1, timedPasses: 5 });
export const BOOTSTRAP = Object.freeze({ iterations: 10000, seed: 424242, alpha: 0.05 });

export const ADMIN_USERNAME = "eval_admin"; // the only user created by the evaluation seed
export const GRADE_STRICT = 2; // "relevant" for P/R/F1/MRR/MAP
export const GRADE_LENIENT = 1; // secondary, lenient view

export const EVIDENCE_TYPES = Object.freeze([
  "Disk image", "System log", "Email message", "Memory dump", "Network capture",
  "Document", "Chat export", "Screenshot", "Registry export", "Browser history",
]);

export function evalConfigSnapshot() {
  return {
    k: K, depth: DEPTH, rrf_k: RRF_K, cases: CASES, seed: SEED, dataset_version: DATASET_VERSION,
    latency: { ...LATENCY }, bootstrap: { ...BOOTSTRAP },
    relevance: { strict_min_grade: GRADE_STRICT, lenient_min_grade: GRADE_LENIENT },
  };
}

// Independent cold-start probes: every sample is a brand-new Node process (src/cold.mjs).
export const COLD_PROBE = Object.freeze({ repeats: 5, queryId: "Q17" });
