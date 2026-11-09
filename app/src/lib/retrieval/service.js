// The semantic search workflow:
//
//   1. MySQL   decides which cases this user may search now          (repo.resolveCaseScope)
//   2. Embed   the query with the existing embedder (bge, query prefix)
//   3. Qdrant  top candidates, filtered to those cases (a speed hint only)
//   4. MySQL   re-reads every candidate with the user's permissions   (repo.loadAuthoritativeRows)
//   5. Discard withdrawn, stale, inaccessible, out-of-scope, malformed candidates
//   6. Return  only what survived, with MySQL's data and Qdrant's similarity score
//
// Fail closed: if step 1, 2, 3 or 4 fails, NOTHING is returned. There is no path that returns
// a Qdrant hit without a successful step 4 for that same hit.
//
// The DB layer and the vector services are passed in (the same ones the worker uses), so
// nothing here creates a Qdrant client, an embedder or a MySQL pool.

import { RETRIEVAL_LIMITS, SIMILARITY_NOTICE } from "./config.js";
import { toSearchError, RetrievalError } from "./errors.js";
import { parseHits, reconcile, DISCARD } from "./candidates.js";

function meta({ examined, returned, discarded, accessPath, versionsAvailable }) {
  return {
    candidates_examined: examined,
    discarded,
    returned,
    verification: {
      authority: "mysql",
      access_path: accessPath, // "investigator_views" | "admin_base_tables" | "none" (nothing to check)
      stale_version_check: versionsAvailable,
    },
    notice: SIMILARITY_NOTICE,
  };
}

export function createSearchService({
  repo,
  getVector, // () -> { embedder, store }   (lib/vector getVectorServices)
  limits = RETRIEVAL_LIMITS,
  logger = console,
} = {}) {
  if (!repo?.resolveCaseScope || !repo?.loadAuthoritativeRows) {
    throw new Error("createSearchService requires a retrieval repository.");
  }
  if (typeof getVector !== "function") throw new Error("createSearchService requires getVector().");

  // params: output of validateSearchRequest().value.  session: { role, userId } for lib/db.
  async function search(session, params) {
    try {
      // 1. Which cases may this user search? MySQL answers; the request only narrows it.
      const scopeCaseIds = await repo.resolveCaseScope(session, params.caseIds);
      if (scopeCaseIds.length === 0) {
        return {
          results: [],
          meta: meta({ examined: 0, returned: 0, discarded: 0, accessPath: "none", versionsAvailable: false }),
        };
      }

      // 2-3. Embed, then ask Qdrant for more candidates than needed (MySQL will drop some).
      const { embedder, store } = getVector();
      const vector = await embedder.embedQuery(params.query);
      const candidateLimit = Math.min(
        limits.maxCandidates,
        Math.max(params.limit * limits.overfetchFactor, params.limit + 10),
      );
      const hits = await store.search({
        vector,
        caseIds: scopeCaseIds,
        kind: params.kind === "all" ? undefined : params.kind,
        limit: candidateLimit,
        scoreThreshold: params.minScore,
      });

      const { candidates, malformed } = parseHits(hits);
      const examined = Array.isArray(hits) ? hits.length : 0;
      if (candidates.length === 0) {
        logOutcome(logger, session, { examined, returned: 0, discarded: malformed ? { [DISCARD.MALFORMED]: malformed } : {} });
        return {
          results: [],
          meta: meta({ examined, returned: 0, discarded: malformed, accessPath: "none", versionsAvailable: false }),
        };
      }

      // 4. Re-read every candidate from MySQL as this user. Failure here = no results.
      const rows = await repo.loadAuthoritativeRows(session, {
        evidenceIds: candidates.filter((c) => c.kind === "evidence").map((c) => c.recordId),
        findingIds: candidates.filter((c) => c.kind === "finding").map((c) => c.recordId),
        caseIds: scopeCaseIds,
      });

      // 5-6. Discard and shape. Only candidates with a passing MySQL row become results.
      const { results, discarded } = reconcile({ candidates, rows, scopeCaseIds, limit: params.limit });
      if (malformed) discarded[DISCARD.MALFORMED] = malformed;
      const discardedCount = Object.values(discarded).reduce((a, b) => a + b, 0);

      logOutcome(logger, session, { examined, returned: results.length, discarded });
      return {
        results,
        meta: meta({
          examined,
          returned: results.length,
          discarded: discardedCount,
          accessPath: rows.accessPath,
          versionsAvailable: rows.versionsAvailable,
        }),
      };
    } catch (err) {
      const mapped = toSearchError(err);
      // Unexpected faults are logged by name only: never the query, SQL, ids or record text.
      if (mapped.code === "SEARCH_ERROR" || mapped.code === "SEARCH_INTERNAL") {
        logger.error("[tracex:search] unexpected error", { name: mapped.cause?.name });
      }
      throw mapped;
    }
  }

  return { search };
}

// One info line per request: who, how many, why discarded. Never the query text or any id.
function logOutcome(logger, session, { examined, returned, discarded }) {
  logger.info?.("[tracex:search]", {
    role: session.role,
    userId: session.userId,
    examined,
    returned,
    discarded,
  });
}

export { RetrievalError };
