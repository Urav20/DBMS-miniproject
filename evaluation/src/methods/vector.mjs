// Vector retrieval = the existing Phase 3 search service, unchanged (embed -> Qdrant ->
// MySQL re-validation). We only wrap its dependencies with timers to split latency into
// stages. The wrappers pass every call straight through.

export function instrument({ repo, getVector, now }) {
  const t = { embed_ms: 0, qdrant_ms: 0, mysql_ms: 0 };
  const timed = async (key, fn) => {
    const t0 = now();
    try {
      return await fn();
    } finally {
      t[key] += now() - t0;
    }
  };
  const wrappedRepo = {
    ...repo,
    resolveCaseScope: (...a) => timed("mysql_ms", () => repo.resolveCaseScope(...a)),
    loadAuthoritativeRows: (...a) => timed("mysql_ms", () => repo.loadAuthoritativeRows(...a)),
  };
  const wrappedGetVector = () => {
    const { embedder, store } = getVector();
    return {
      embedder: { ...embedder, embedQuery: (x) => timed("embed_ms", () => embedder.embedQuery(x)) },
      store: { ...store, search: (x) => timed("qdrant_ms", () => store.search(x)) },
    };
  };
  return {
    repo: wrappedRepo,
    getVector: wrappedGetVector,
    take() {
      const out = { ...t };
      t.embed_ms = t.qdrant_ms = t.mysql_ms = 0;
      return out;
    },
  };
}

// deps: { service (createSearchService result), take (from instrument), validate (validateSearchRequest) }
export function createVectorMethod({ service, take, validate, session, caseIds, limit, name = "vector" }) {
  return {
    name,
    async search(text) {
      const v = validate({ query: text, case_ids: caseIds, kind: "evidence", limit });
      if (!v.ok) throw new Error(`Phase 3 validation rejected the evaluation query: ${JSON.stringify(v.errors ?? v)}`);
      take(); // clear any stale timings
      const out = await service.search(session, v.value);
      const stages = take();
      return { ids: out.results.map((r) => Number(r.record_id)), scores: out.results.map((r) => r.similarity_score), stages };
    },
  };
}
