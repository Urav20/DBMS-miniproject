// Error type for the retrieval API, and the translation of everything that can go wrong
// below it (embedding, Qdrant, MySQL, programming mistakes) into a response that is safe to
// show: no SQL, no URLs, no keys, no query text, no record content.
//
// Existing VectorError and DatabaseError messages are already written to be safe (see
// lib/vector/errors.js and lib/db/errors.js), so they are passed through. Anything else is
// reduced to a generic message; the original stays in `cause` for server-side logs only.

import { VectorError } from "../vector/errors.js";
import { DatabaseError } from "../db/errors.js";

export class RetrievalError extends Error {
  constructor(code, message, { status = 500, detail, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "RetrievalError";
    this.code = code; // stable application code, e.g. "CASE_ACCESS_DENIED"
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    this.detail = detail;
  }

  toResponseBody() {
    const error = { code: this.code, message: this.message };
    if (this.detail) error.detail = this.detail;
    return { error };
  }
}

export function toSearchError(err) {
  if (err instanceof RetrievalError) return err;

  if (err instanceof VectorError) {
    // The route validates input before embedding or searching, so an invalid-input error
    // from the vector layer is our bug, not the caller's mistake.
    if (err.code === "VECTOR_INVALID_INPUT") {
      return new RetrievalError("SEARCH_INTERNAL", "The search could not be completed.", {
        status: 500,
        cause: err,
      });
    }
    return new RetrievalError(err.code, err.message, { status: err.status, cause: err });
  }

  if (err instanceof DatabaseError) {
    return new RetrievalError(err.code, err.message, {
      status: err.status,
      detail: err.detail,
      cause: err,
    });
  }

  return new RetrievalError("SEARCH_ERROR", "The search could not be completed.", {
    status: 500,
    cause: err,
  });
}
