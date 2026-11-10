// Input checks for POST /api/search/semantic. Strict on purpose: unknown fields, wrong
// types, empty queries and an empty case list are all rejected instead of guessed at.

import { RETRIEVAL_LIMITS, SEARCH_KINDS } from "./config.js";

const MAX_ID = 4294967295; // INT UNSIGNED, same type as investigation_case.case_id
const ALLOWED_FIELDS = Object.freeze(["query", "case_id", "case_ids", "kind", "limit", "min_score"]);

// C0 controls except tab, line feed and carriage return; and DEL.
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const bad = (field, message) => ({ ok: false, field, message });

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isId(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= MAX_ID;
}

// body = parsed JSON.
// -> { ok: true, value: { query, caseIds | null, kind, limit, minScore | undefined } }
//  | { ok: false, field, message }
// caseIds === null means "every case I may access" (the server works the list out from MySQL).
export function validateSearchRequest(body, limits = RETRIEVAL_LIMITS) {
  if (!isPlainObject(body)) return bad("body", "The request body must be a JSON object.");

  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.includes(key)) {
      return bad("body", `Unknown field in the request. Allowed fields: ${ALLOWED_FIELDS.join(", ")}.`);
    }
  }
  const has = (k) => Object.hasOwn(body, k) && body[k] !== undefined;

  // query
  if (!has("query") || typeof body.query !== "string") {
    return bad("query", "query must be a text string.");
  }
  const query = body.query.trim();
  if (query.length === 0) return bad("query", "Enter a search query.");
  if (query.length > limits.maxQueryChars) {
    return bad("query", `The query is too long (at most ${limits.maxQueryChars} characters).`);
  }
  if (FORBIDDEN_CHARS.test(query) || (typeof query.isWellFormed === "function" && !query.isWellFormed())) {
    return bad("query", "The query contains characters that are not allowed.");
  }

  // case context: case_id (one) or case_ids (several) or neither (all my cases)
  if (has("case_id") && has("case_ids")) {
    return bad("case_ids", "Send either case_id or case_ids, not both.");
  }
  let caseIds = null;
  if (has("case_id")) {
    if (!isId(body.case_id)) return bad("case_id", "case_id must be a positive whole number.");
    caseIds = [body.case_id];
  } else if (has("case_ids")) {
    const list = body.case_ids;
    if (!Array.isArray(list) || list.length === 0) {
      // [] is refused rather than read as "all cases" or "no cases".
      return bad("case_ids", "case_ids must be a non-empty list. Leave it out to search all your cases.");
    }
    if (list.length > limits.maxCaseIds) {
      return bad("case_ids", `case_ids may hold at most ${limits.maxCaseIds} cases.`);
    }
    if (!list.every(isId)) return bad("case_ids", "Every case id must be a positive whole number.");
    caseIds = [...new Set(list)].sort((a, b) => a - b);
  }

  // kind
  let kind = "all";
  if (has("kind")) {
    if (typeof body.kind !== "string" || !SEARCH_KINDS.includes(body.kind)) {
      return bad("kind", `kind must be one of: ${SEARCH_KINDS.join(", ")}.`);
    }
    kind = body.kind;
  }

  // limit
  let limit = limits.defaultLimit;
  if (has("limit")) {
    const n = body.limit;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > limits.maxLimit) {
      return bad("limit", `limit must be a whole number from 1 to ${limits.maxLimit}.`);
    }
    limit = n;
  }

  // min_score (cosine similarity, 0 to 1)
  let minScore;
  if (has("min_score")) {
    const s = body.min_score;
    if (typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > 1) {
      return bad("min_score", "min_score must be a number from 0 to 1.");
    }
    minScore = s;
  }

  return { ok: true, value: { query, caseIds, kind, limit, minScore } };
}
