// Public entry point for semantic retrieval (server-side only).
//
//   import { getSearchService } from "@/lib/retrieval";
//   const outcome = await getSearchService().search({ role, userId }, validatedParams);
//
// Reuses the existing layers: lib/db (per-request pool + @tracex_user_id) and lib/vector
// (the one embedder and the one Qdrant store, shared with the indexing worker). Nothing is
// created at import time, so `next build` needs no .env.

import * as dbLayer from "../db/index.js";
import { getVectorServices } from "../vector/index.js";
import { createRetrievalRepository } from "./repository.js";
import { createSearchService } from "./service.js";

const globalKey = Symbol.for("tracex.retrieval.service");

export function getSearchService() {
  if (!globalThis[globalKey]) {
    globalThis[globalKey] = createSearchService({
      repo: createRetrievalRepository({ db: dbLayer }),
      getVector: () => getVectorServices(),
    });
  }
  return globalThis[globalKey];
}

export { createSearchService } from "./service.js";
export { createRetrievalRepository, ADMIN_ROLE_NAME } from "./repository.js";
export { createSemanticSearchHandler } from "./handlers.js";
export { validateSearchRequest } from "./validation.js";
export { RetrievalError, toSearchError } from "./errors.js";
export { RETRIEVAL_LIMITS, SEARCH_KINDS } from "./config.js";
export { parseHits, reconcile, checkCandidate, DISCARD } from "./candidates.js";
