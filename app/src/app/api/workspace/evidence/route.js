import { authorizeRequest, toDbSession, jsonResponse } from "@/lib/auth/access.js";
import { callProcedure } from "@/lib/db/index.js";
import { isSameOrigin, readJson, cleanText, mysqlDateTimeLocal, parsePositiveId } from "@/lib/api/write-guards.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  if (!isSameOrigin(request)) return jsonResponse(403, { error: { message: "This request was not sent from this site." } });
  const auth = authorizeRequest(request, { roles: ["admin", "investigator"] });
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request);
  if (!parsed.ok) return jsonResponse(400, { error: { message: "The request must contain valid JSON." } });
  const body = parsed.value ?? {};
  const caseId = parsePositiveId(body.case_id);
  const typeId = parsePositiveId(body.type_id);
  const title = cleanText(body.title, 200, { required: true });
  const description = cleanText(body.description, 60000, { required: true });
  const extractedText = body.extracted_text == null ? null : cleanText(body.extracted_text, 500000);
  const collectedAt = mysqlDateTimeLocal(body.collected_at);
  const method = cleanText(body.method, 100, { required: true });
  const location = body.location == null || body.location === "" ? null : cleanText(body.location, 150);
  const notes = body.notes == null || body.notes === "" ? null : cleanText(body.notes, 60000);
  const sha256 = body.sha256 == null || body.sha256 === "" ? null : String(body.sha256).trim().toLowerCase();
  const fileSize = body.file_size_bytes == null || body.file_size_bytes === "" ? null :
    (typeof body.file_size_bytes === "number" ||
      (typeof body.file_size_bytes === "string" && /^\d+$/.test(body.file_size_bytes)))
      ? Number(body.file_size_bytes) : NaN;
  if (!caseId || !typeId || !title || !description || !collectedAt || !method ||
      (body.extracted_text != null && extractedText === null) ||
      (body.location != null && body.location !== "" && location === null) ||
      (body.notes != null && body.notes !== "" && notes === null) ||
      (sha256 !== null && !/^[0-9a-f]{64}$/.test(sha256)) ||
      (fileSize !== null && (!Number.isSafeInteger(fileSize) || fileSize < 0))) {
    return jsonResponse(400, { error: { message: "Check the required case, type, title, description, collection date and method. Optional SHA-256 must be 64 hex characters and file size must be a non-negative whole number." } });
  }
  try {
    const result = await callProcedure(toDbSession(auth.session), "sp_register_evidence", [
      caseId, null, typeId, title, description, extractedText, sha256, fileSize,
      collectedAt, method, location, notes,
    ]);
    const row = result?.resultSets?.[0]?.[0] ?? null;
    return jsonResponse(201, { ok: true, evidence_id: row?.evidence_id ?? null, evidence_no: row?.evidence_no ?? null, message: "Evidence registered. MySQL queued it for vector indexing." });
  } catch (error) {
    console.error("[tracex:evidence:register]", { code: error?.code, errno: error?.mysqlErrno });
    return jsonResponse(409, { error: { message: "Evidence registration was rejected. Check case access, case status, type and whether this SHA-256 is already registered in the case." } });
  }
}
