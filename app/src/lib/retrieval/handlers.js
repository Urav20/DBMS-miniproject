// POST /api/search/semantic request handler. src/app/api/search/semantic/route.js only plugs
// the real dependencies into this function; the tests plug in fakes (same pattern as
// lib/auth/handlers.js).
//
// POST (not GET) so that the search text, which may itself be sensitive, never ends up in
// URLs, browser history or access logs. The endpoint changes no data.

import { AuthError } from "../auth/errors.js";
import { authorizeRequest, jsonResponse, toDbSession } from "../auth/access.js";
import { RETRIEVAL_LIMITS } from "./config.js";
import { toSearchError } from "./errors.js";
import { validateSearchRequest } from "./validation.js";

const SEARCH_ROLES = Object.freeze(["admin", "investigator"]);

const badRequest = (message, field) =>
  jsonResponse(400, { error: { code: "SEARCH_BAD_REQUEST", message, ...(field ? { field } : {}) } });

export function createSemanticSearchHandler({
  getService, // () -> { search(session, params) }
  authorize = authorizeRequest,
  logger = console,
  limits = RETRIEVAL_LIMITS,
}) {
  return async function POST(request) {
    // 1. Who is asking? The API checks the signed session itself (the proxy is only a first check).
    let auth;
    try {
      auth = authorize(request, { roles: SEARCH_ROLES });
    } catch (err) {
      if (err instanceof AuthError) {
        if (err.status >= 500) logger.error("[tracex:auth]", { code: err.code, reason: err.reason });
        return jsonResponse(err.status, err.toResponseBody());
      }
      throw err;
    }
    if (!auth.ok) return auth.response;

    // 2. Read and validate the body before any database, embedding or Qdrant work.
    let text;
    try {
      text = await request.text();
    } catch {
      return badRequest("The request could not be read.");
    }
    if (text.length > limits.maxBodyChars) {
      return jsonResponse(413, {
        error: { code: "SEARCH_TOO_LARGE", message: "The request is too large." },
      });
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return badRequest("The request body must be valid JSON.");
    }
    const checked = validateSearchRequest(body, limits);
    if (!checked.ok) return badRequest(checked.message, checked.field);

    // 3. Search as the signed-in user.
    try {
      const outcome = await getService().search(toDbSession(auth.session), checked.value);
      return jsonResponse(200, outcome);
    } catch (err) {
      const mapped = toSearchError(err);
      return jsonResponse(mapped.status, mapped.toResponseBody());
    }
  };
}
