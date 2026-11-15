import { authorizeRequest, toDbSession, jsonResponse } from "@/lib/auth/access.js";
import { callProcedure } from "@/lib/db/index.js";
import { isSameOrigin, readJson, readPositiveId, cleanText } from "@/lib/api/write-guards.js";

export const dynamic = "force-dynamic";

export async function POST(request, context) {
  if (!isSameOrigin(request)) return jsonResponse(403, { error: { message: "This request was not sent from this site." } });
  const auth = authorizeRequest(request, { roles: ["admin", "investigator"] });
  if (!auth.ok) return auth.response;
  const analysisId = await readPositiveId(context);
  if (!analysisId) return jsonResponse(400, { error: { message: "A valid analysis ID is required." } });
  const parsed = await readJson(request);
  if (!parsed.ok) return jsonResponse(400, { error: { message: "The request must contain valid JSON." } });
  const title = cleanText(parsed.value?.title, 200, { required: true });
  const description = cleanText(parsed.value?.description, 60000, { required: true });
  const severity = cleanText(parsed.value?.severity, 10, { required: true });
  if (!title || !description || !["info", "low", "medium", "high", "critical"].includes(severity)) {
    return jsonResponse(400, { error: { message: "Provide a title, description and severity (info, low, medium, high or critical)." } });
  }
  try {
    const result = await callProcedure(toDbSession(auth.session), "sp_add_finding", [analysisId, title, description, severity]);
    const row = result?.resultSets?.[0]?.[0] ?? null;
    return jsonResponse(201, { ok: true, finding_id: row?.finding_id ?? null, message: "Finding recorded and queued for vector indexing." });
  } catch (error) {
    console.error("[tracex:finding:create]", { code: error?.code, errno: error?.mysqlErrno });
    return jsonResponse(409, { error: { message: "Finding creation was rejected. Check case access, case status, analysis and severity." } });
  }
}
