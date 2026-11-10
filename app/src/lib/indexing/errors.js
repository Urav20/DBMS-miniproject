// Error type and failure classification for the indexing worker.
//
// Every failure is put into one of three classes, which decide what happens to the job:
//   permanent : retrying cannot help (bad job, missing source row). Job -> 'failed' at once.
//   transient : may work next time (one bad embedding, a Qdrant 5xx). Job -> 'pending' again;
//               it counts against the attempt limit, then -> 'failed'.
//   outage    : the fault is in a dependency (MySQL, Qdrant, model download), not in the
//               job. Job -> 'pending' again WITHOUT using up an attempt, and the worker
//               backs off instead of burning through the whole queue.
//
// Messages stored in index_job.last_error are the SAFE messages of VectorError /
// DatabaseError / IndexingError (no SQL, no URLs, no document text). Anything else is
// reduced to a generic message; the original error is only ever logged by code.

import { VectorError } from "../vector/errors.js";
import { DatabaseError } from "../db/errors.js";

export const FAILURE = Object.freeze({
  PERMANENT: "permanent",
  TRANSIENT: "transient",
  OUTAGE: "outage",
});

export class IndexingError extends Error {
  constructor(code, message, { failure = FAILURE.TRANSIENT, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "IndexingError";
    this.code = code; // e.g. "INDEX_SOURCE_NOT_FOUND"
    this.failure = failure;
  }
}

const VECTOR_OUTAGE = new Set([
  "QDRANT_UNAVAILABLE",
  "QDRANT_AUTH_FAILED",
  "QDRANT_COLLECTION_MISMATCH",
  "EMBEDDING_MODEL_UNAVAILABLE",
  "VECTOR_CONFIG",
]);

const DB_OUTAGE = new Set([
  "DB_UNAVAILABLE",
  "DB_POOL_TIMEOUT",
  "DB_AUTH_FAILED",
  "DB_ACCESS_DENIED",
  "DB_PERMISSION_DENIED",
  "DB_CONFIG",
  "DB_CONFLICT", // deadlock / lock wait: try again shortly
]);

// Returns { failure, code, message } for anything thrown while processing a job.
export function classifyError(err) {
  if (err instanceof IndexingError) {
    return { failure: err.failure, code: err.code, message: err.message };
  }
  if (err instanceof VectorError) {
    if (VECTOR_OUTAGE.has(err.code)) {
      return { failure: FAILURE.OUTAGE, code: err.code, message: err.message };
    }
    if (err.code === "VECTOR_INVALID_INPUT") {
      return { failure: FAILURE.PERMANENT, code: err.code, message: err.message };
    }
    return { failure: FAILURE.TRANSIENT, code: err.code, message: err.message };
  }
  if (err instanceof DatabaseError) {
    if (DB_OUTAGE.has(err.code)) {
      return { failure: FAILURE.OUTAGE, code: err.code, message: err.message };
    }
    return { failure: FAILURE.TRANSIENT, code: err.code, message: err.message };
  }
  return { failure: FAILURE.TRANSIENT, code: "INDEX_UNEXPECTED", message: "Unexpected error." };
}

// index_job.last_error is VARCHAR(500).
export const LAST_ERROR_MAX = 500;

export function formatLastError({ code, message }) {
  return `[${code}] ${message}`.slice(0, LAST_ERROR_MAX);
}
