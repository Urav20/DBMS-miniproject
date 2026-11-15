import { authorizeRequest, toDbSession, jsonResponse } from "@/lib/auth/access.js";
import { callProcedure } from "@/lib/db/index.js";
import { isSameOrigin, readJson, readPositiveId, cleanText } from "@/lib/api/write-guards.js";

export const dynamic = "force-dynamic";

export async function PATCH(request, context) {
  if (!isSameOrigin(request)) return jsonResponse(403, { error: { message: "This request was not sent from this site." } });
  const auth = authorizeRequest(request, { roles: ["admin"] });
  if (!auth.ok) return auth.response;
  const id = await readPositiveId(context);
  if (!id) return jsonResponse(400, { error: { message: "A valid case ID is required." } });
  const parsed = await readJson(request);
  if (!parsed.ok) return jsonResponse(400, { error: { message: "The request must contain valid JSON." } });
  const status = cleanText(parsed.value?.status, 20, { required: true });
  if (!["open", "under_review", "closed"].includes(status)) return jsonResponse(400, { error: { message: "Status must be open, under_review or closed." } });
  try {
    await callProcedure(toDbSession(auth.session), "sp_set_case_status", [id, status]);
    return jsonResponse(200, { ok: true, message: "Case status updated." });
  } catch (error) {
    console.error("[tracex:case:status]", { code: error?.code, errno: error?.mysqlErrno });
    return jsonResponse(409, { error: { message: "The case status could not be changed. Check the current status and database response." } });
  }
}
