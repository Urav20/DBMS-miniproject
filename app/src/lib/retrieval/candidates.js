// Pure functions (no I/O) that turn Qdrant hits into either "return this" or "discard".
// Kept separate so the security rules are easy to read and to test.
//
// Rule: a hit becomes a result ONLY if MySQL returned a row for it and every check below
// passes. Qdrant's payload is used for two things only: to know which MySQL row to look up,
// and as a consistency hint to spot stale or corrupted points. It never grants access.

import { pointId, parsePayload } from "../vector/ids.js";

export const DISCARD = Object.freeze({
  MALFORMED: "malformed_hit", // payload not ours, point id does not match the payload, bad score
  NO_ROW: "no_mysql_row", // MySQL returned nothing: missing, or the user cannot access it
  OUT_OF_SCOPE: "out_of_scope", // row is in a case outside the validated scope
  WITHDRAWN: "withdrawn", // evidence (or the finding's evidence) is withdrawn
  CASE_MISMATCH: "case_mismatch", // payload case_id differs from MySQL
  EVIDENCE_MISMATCH: "evidence_mismatch", // payload evidence_id differs from MySQL
  STALE: "stale_version", // payload content_version differs from MySQL content_version
});

// hits = [{ id, score, payload }] from store.search().
// -> { candidates: [{ kind, recordId, score, payload }], malformed: number }
// A hit is malformed when the payload is not one of ours, the score is not a number, or the
// point id is not the UUIDv5 of "<kind>:<record_id>" (a forged or foreign point).
export function parseHits(hits) {
  const candidates = [];
  const seen = new Set();
  let malformed = 0;
  for (const hit of Array.isArray(hits) ? hits : []) {
    const payload = parsePayload(hit?.payload);
    let idOk = false;
    if (payload) {
      try {
        idOk = typeof hit.id === "string" && hit.id === pointId(payload.kind, payload.recordId);
      } catch {
        idOk = false;
      }
    }
    const key = payload ? `${payload.kind}:${payload.recordId}` : null;
    if (!payload || !idOk || !Number.isFinite(hit.score) || seen.has(key)) {
      malformed += 1;
      continue;
    }
    seen.add(key);
    candidates.push({ kind: payload.kind, recordId: payload.recordId, score: hit.score, payload });
  }
  return { candidates, malformed };
}

// Decides one candidate. `row` is the normalized MySQL row (or undefined).
// -> { ok: true } | { ok: false, reason }
export function checkCandidate(candidate, row, scopeCaseIds) {
  if (!row) return { ok: false, reason: DISCARD.NO_ROW };
  if (!scopeCaseIds.includes(row.caseId)) return { ok: false, reason: DISCARD.OUT_OF_SCOPE };
  if (row.status !== "active") return { ok: false, reason: DISCARD.WITHDRAWN };

  const { payload } = candidate;
  if (payload.caseId !== null && payload.caseId !== row.caseId) {
    return { ok: false, reason: DISCARD.CASE_MISMATCH };
  }
  if (payload.evidenceId !== null && payload.evidenceId !== row.evidenceId) {
    return { ok: false, reason: DISCARD.EVIDENCE_MISMATCH };
  }
  // Only possible when MySQL gave us the version (admin path today). `null` = unavailable.
  if (row.contentVersion !== null && payload.contentVersion !== row.contentVersion) {
    return { ok: false, reason: DISCARD.STALE };
  }
  return { ok: true };
}

const round4 = (x) => Math.round(x * 10000) / 10000;

// Response item. Every field except `similarity_score` comes from MySQL, not from Qdrant.
// No description or extracted text is returned: the evidence detail screen shows those.
function toResult(row, score, rank) {
  const base = {
    rank,
    record_type: row.kind,
    record_id: row.recordId,
    evidence_id: row.evidenceId,
    evidence_no: row.evidenceNo,
    case_id: row.caseId,
    title: row.title,
    similarity_score: round4(score),
  };
  if (row.kind === "evidence") {
    return { ...base, type_id: row.typeId, registered_at: row.registeredAt };
  }
  return { ...base, analysis_id: row.analysisId, severity: row.severity, created_at: row.createdAt };
}

// candidates: from parseHits (best score first). rows: { evidence, findings } from the
// repository. -> { results (best first, at most `limit`), discarded: { reason: count } }
export function reconcile({ candidates, rows, scopeCaseIds, limit }) {
  const evidenceById = new Map(rows.evidence.map((r) => [r.recordId, r]));
  const findingById = new Map(rows.findings.map((r) => [r.recordId, r]));

  const discarded = {};
  const kept = [];
  for (const c of candidates) {
    const row = (c.kind === "evidence" ? evidenceById : findingById).get(c.recordId);
    const verdict = checkCandidate(c, row, scopeCaseIds);
    if (verdict.ok) kept.push({ row, score: c.score });
    else discarded[verdict.reason] = (discarded[verdict.reason] ?? 0) + 1;
  }
  kept.sort((a, b) => b.score - a.score); // Array.sort is stable: ties keep Qdrant's order
  const results = kept.slice(0, limit).map((k, i) => toResult(k.row, k.score, i + 1));
  return { results, discarded };
}
