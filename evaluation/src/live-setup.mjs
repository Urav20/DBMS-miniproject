// Everything the live scripts share: verify the environment, then build the three methods.
// Takes an already-created context (src/live.mjs createLiveContext) so the environment override
// has always happened first. Nothing here writes to MySQL or Qdrant.
import { loadDataset } from "./dataset.mjs";
import { resolveEvalAdmin, readEvalCases, assertOnlyEvalCases, buildIdMap } from "./eval-env.mjs";
import { assertConnectedToEvalDb } from "./safety.mjs";
import { createKeywordMethod } from "./methods/keyword.mjs";
import { instrument, createVectorMethod } from "./methods/vector.mjs";
import { createHybridMethod } from "./methods/hybrid.mjs";
import { K, DEPTH, RRF_K } from "../config.mjs";

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

// verifyQdrant=false skips the one Qdrant request made for the consistency check (the cold probe
// must not warm Qdrant before the measured call).
export async function prepareLive(ctx, size, { env = process.env, verifyQdrant = true, now = () => performance.now() } = {}) {
  const { db, vector, retrieval } = ctx;
  const { dataset, queries, qrels } = loadDataset();

  const admin = await resolveEvalAdmin({ db, expectedId: env.EVAL_ADMIN_USER_ID ?? null });
  await assertConnectedToEvalDb(db, admin);
  const repo = retrieval.createRetrievalRepository({ db });
  await repo.resolveCaseScope(admin, null); // Phase 3 code path: fails unless this is an active Administrator
  const cases = assertOnlyEvalCases(await readEvalCases({ db, session: admin, size }), size);
  const caseIds = cases.map((c) => c.case_id);
  const idToKey = await buildIdMap({ db, session: admin, dataset, size });

  let info = null;
  if (verifyQdrant) {
    info = await vector.store.inspectCollection();
    if (!info.exists || info.problems.length) {
      throw new Error(`Qdrant collection problem: ${info.exists ? info.problems.join("; ") : "collection does not exist, run the index step"}`);
    }
    if (info.points !== idToKey.size) throw new Error(`Qdrant holds ${info.points} points but MySQL holds ${idToKey.size} records. Re-run the index step.`);
  }

  const inst = instrument({ repo, getVector: () => vector, now });
  const service = retrieval.createSearchService({ repo: inst.repo, getVector: inst.getVector, logger: QUIET });
  const mkVec = (limit, name) => createVectorMethod({ service, take: inst.take, validate: retrieval.validateSearchRequest, session: admin, caseIds, limit, name });
  const keyword = createKeywordMethod({ db, session: admin, caseIds, depth: K });
  const keywordDeep = createKeywordMethod({ db, session: admin, caseIds, depth: DEPTH, name: "keyword@depth" });
  const vectorK = mkVec(K, "vector");
  const vectorDeep = mkVec(DEPTH, "vector@depth");
  const hybrid = createHybridMethod({ keyword: keywordDeep, vector: vectorDeep, k: K, rrfK: RRF_K, now });
  return { dataset, queries, qrels, admin, caseIds, idToKey, info, now, methods: { keyword, vector: vectorK, hybrid } };
}
