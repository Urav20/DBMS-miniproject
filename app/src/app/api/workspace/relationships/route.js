import { authorizeRequest, toDbSession, jsonResponse } from "@/lib/auth/access.js";
import { callProcedure } from "@/lib/db/index.js";
import { isSameOrigin, readJson, cleanText, parsePositiveId } from "@/lib/api/write-guards.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  if (!isSameOrigin(request)) return jsonResponse(403, { error: { message: "This request was not sent from this site." } });
  const auth = authorizeRequest(request, { roles: ["admin", "investigator"] });
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request);
  if (!parsed.ok) return jsonResponse(400, { error: { message: "The request must contain valid JSON." } });
  const body = parsed.value ?? {};
  const a = parsePositiveId(body.evidence_a_id), b = parsePositiveId(body.evidence_b_id);
  const type = cleanText(body.rel_type, 20, { required: true });
  const rationale = cleanText(body.rationale, 60000, { required: true });
  if (!a || !b || a === b ||
      !["derived_from", "corroborates", "contradicts", "related_activity", "other"].includes(type) || !rationale) {
    return jsonResponse(400, { error: { message: "Choose two different evidence records, a valid relationship type and a written rationale." } });
  }
  try {
    const result = await callProcedure(toDbSession(auth.session), "sp_link_evidence", [a, b, type, rationale]);
    const row = result?.resultSets?.[0]?.[0] ?? null;
    return jsonResponse(201, { ok: true, relationship_id: row?.rel_id ?? null, message: "Relationship recorded by the analyst." });
  } catch (error) {
    console.error("[tracex:relationship:create]", { code: error?.code, errno: error?.mysqlErrno });
    return jsonResponse(409, { error: { message: "Relationship rejected. Both records must be accessible in the same open case, and the pair/type must not already exist." } });
  }
}
