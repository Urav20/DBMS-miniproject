// Fixed limits for the semantic retrieval API. Nothing here is read from the environment,
// so importing this file (or running `next build`) needs no .env.
//
// Qdrant and embedding settings are NOT repeated here: they come from lib/vector/config.js
// (QDRANT_URL, QDRANT_COLLECTION, EMBEDDING_MODEL, ...). MySQL settings come from lib/db.

export const RETRIEVAL_LIMITS = Object.freeze({
  defaultLimit: 10, // results returned when the caller does not say
  maxLimit: 50, // most results one request may ask for
  maxQueryChars: 1000, // bge-small truncates at 512 tokens anyway; this bounds the work
  maxCaseIds: 50, // most case ids one request may name
  overfetchFactor: 3, // ask Qdrant for limit x 3 candidates: MySQL will discard some
  maxCandidates: 200, // lib/vector/qdrant.js search() refuses more than 200
  maxBodyChars: 16384, // request body size guard
});

// "all" = evidence and findings. Maps to the `kind` payload field in Qdrant.
export const SEARCH_KINDS = Object.freeze(["all", "evidence", "finding"]);

// Shown in every response. Semantic similarity is a lead, never proof.
export const SIMILARITY_NOTICE =
  "Similarity scores are leads for a human analyst to review. They are not proof that records " +
  "are related. Only an analyst can record a relationship between evidence items.";
