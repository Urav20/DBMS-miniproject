import { authorizeRequest, toDbSession, jsonResponse } from "@/lib/auth/access.js";
import { callProcedure } from "@/lib/db/index.js";
import { isSameOrigin, readJson, readPositiveId, cleanText, parsePositiveId } from "@/lib/api/write-guards.js";

export const dynamic = "force-dynamic";

export async function POST(request, context) {
  if (!isSameOrigin(request)) return jsonResponse(403, { error: { message: "This request was not sent from this site." } });
  const auth = authorizeRequest(request, { roles: ["admin", "investigator"] });
  if (!auth.ok) return auth.response;
  const evidenceId = await readPositiveId(context);
  if (!evidenceId) return jsonResponse(400, { error: { message: "A valid evidence ID is required." } });
  const parsed = await readJson(request);
  if (!parsed.ok) return jsonResponse(400, { error: { message: "The request must contain valid JSON." } });
  const toolId = parsePositiveId(parsed.value?.tool_id);
  const notes = parsed.value?.notes == null || parsed.value.notes === "" ? null : cleanText(parsed.value.notes, 60000);
  if (!toolId || (parsed.value?.notes != null && parsed.value.notes !== "" && notes === null)) {
    return jsonResponse(400, { error: { message: "Choose an analysis tool and provide optional notes up to 60,000 characters." } });
  }
  try {
    const result = await callProcedure(toDbSession(auth.session), "sp_record_analysis", [evidenceId, toolId, notes]);
    const row = result?.resultSets?.[0]?.[0] ?? null;
    return jsonResponse(201, { ok: true, analysis_id: row?.analysis_id ?? null, message: "Analysis started." });
  } catch (error) {
    console.error("[tracex:analysis:start]", { code: error?.code, errno: error?.mysqlErrno });
    return jsonResponse(409, { error: { message: "Analysis could not be started. The evidence may be withdrawn, its case closed, or access denied." } });
  }
}
