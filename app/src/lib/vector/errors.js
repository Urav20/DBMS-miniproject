// Error type for the Qdrant / embedding layer. Same idea as DatabaseError:
// `message` is always safe to show in the UI (no URLs with credentials, no API
// key, no document text). The original error stays in `cause` for server logs.

export class VectorError extends Error {
  constructor(code, message, { status = 500, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "VectorError";
    this.code = code; // stable application code, e.g. "QDRANT_UNAVAILABLE"
    this.status = status; // suggested HTTP status for route handlers
  }

  toResponseBody() {
    return { error: { code: this.code, message: this.message } };
  }
}

// Converts anything thrown by @qdrant/js-client-rest into a VectorError.
// The client throws an error with a numeric `status` when Qdrant answered, and a
// network/fetch error (no status) when it could not be reached.
export function toQdrantError(err, action = "complete the request") {
  if (err instanceof VectorError) return err;
  const httpStatus = typeof err?.status === "number" ? err.status : undefined;
  if (httpStatus === 401 || httpStatus === 403) {
    return new VectorError(
      "QDRANT_AUTH_FAILED",
      "The vector database rejected the application's credentials.",
      { status: 503, cause: err },
    );
  }
  if (httpStatus !== undefined) {
    return new VectorError(
      "QDRANT_ERROR",
      `The vector database could not ${action}.`,
      { status: 502, cause: err },
    );
  }
  if (isNetworkError(err)) {
    return new VectorError(
      "QDRANT_UNAVAILABLE",
      "The vector database is not reachable right now.",
      { status: 503, cause: err },
    );
  }
  // Not a Qdrant or network problem (for example a programming mistake): return it
  // unchanged so it is not hidden behind a misleading "not reachable" message.
  return err;
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
]);

function isNetworkError(err) {
  if (!err || typeof err !== "object") return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  const codes = [err.code, err.cause?.code, err.cause?.cause?.code];
  if (codes.some((c) => typeof c === "string" && NETWORK_CODES.has(c))) return true;
  return err instanceof TypeError && /fetch failed/i.test(err.message);
}
