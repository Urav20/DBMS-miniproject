// Point IDs and payload conventions (design doc section 5.3).
//
//   Point ID : UUIDv5 of "evidence:{id}" or "finding:{id}". Deterministic, so
//              indexing the same record twice overwrites the same point.
//   Payload  : kind, record_id, evidence_id, case_id, content_version.
//              NO raw text, no titles, no names. Qdrant is never trusted for
//              authorization: this metadata is only a search hint.

import { createHash } from "node:crypto";
import { VectorError } from "./errors.js";

export const KINDS = Object.freeze(["evidence", "finding"]);

// Project-specific namespace. Never change it: every existing point ID derives
// from it. (Generated once for TRACE-X.)
export const TRACEX_NAMESPACE = "6f1c1b5e-2d4a-4c1e-9a53-7a3c8d2b9e10";

function uuidToBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function bytesToUuid(b) {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// RFC 4122 version 5 (SHA-1, name-based).
export function uuidv5(name, namespace = TRACEX_NAMESPACE) {
  const hash = createHash("sha1")
    .update(uuidToBytes(namespace))
    .update(Buffer.from(String(name), "utf8"))
    .digest()
    .subarray(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(hash);
}

function assertKind(kind) {
  if (!KINDS.includes(kind)) {
    throw new VectorError("VECTOR_INVALID_INPUT", `Unknown record kind "${kind}".`, {
      status: 400,
    });
  }
}

function assertId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4294967295) {
    throw new VectorError("VECTOR_INVALID_INPUT", `${label} must be a positive whole number.`, {
      status: 400,
    });
  }
}

export function pointId(kind, recordId) {
  assertKind(kind);
  assertId(recordId, "recordId");
  return uuidv5(`${kind}:${recordId}`);
}

// evidenceId and caseId are optional hints. For a finding they are filled only
// when the indexing worker is allowed to read them (see worker notes); the app
// never relies on them for access decisions.
export function buildPayload({ kind, recordId, evidenceId = null, caseId = null, contentVersion }) {
  assertKind(kind);
  assertId(recordId, "recordId");
  assertId(contentVersion, "contentVersion");
  if (evidenceId !== null) assertId(evidenceId, "evidenceId");
  if (caseId !== null) assertId(caseId, "caseId");
  if (kind === "evidence" && evidenceId !== null && evidenceId !== recordId) {
    throw new VectorError(
      "VECTOR_INVALID_INPUT",
      "For evidence points, evidenceId must equal recordId.",
      { status: 400 },
    );
  }
  return {
    kind,
    record_id: recordId,
    evidence_id: kind === "evidence" ? recordId : evidenceId,
    case_id: caseId,
    content_version: contentVersion,
  };
}

// Reads a payload returned by Qdrant. Returns null when it is not one of ours,
// so a corrupted or foreign point is ignored instead of trusted.
export function parsePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const { kind, record_id, evidence_id, case_id, content_version } = payload;
  if (!KINDS.includes(kind)) return null;
  if (!Number.isSafeInteger(record_id) || record_id < 1) return null;
  if (!Number.isSafeInteger(content_version) || content_version < 1) return null;
  const optional = (v) => (Number.isSafeInteger(v) && v >= 1 ? v : null);
  return {
    kind,
    recordId: record_id,
    evidenceId: optional(evidence_id),
    caseId: optional(case_id),
    contentVersion: content_version,
  };
}
