import { authorizeRequest, toDbSession, jsonResponse } from "@/lib/auth/access.js";
import { callProcedure } from "@/lib/db/index.js";
import { isSameOrigin, readJson, readPositiveId, parsePositiveId } from "@/lib/api/write-guards.js";

export const dynamic = "force-dynamic";

export async function POST(request, context) {
  if (!isSameOrigin(request)) return jsonResponse(403, { error: { message: "This request was not sent from this site." } });
  const auth = authorizeRequest(request, { roles: ["admin"] });
  if (!auth.ok) return auth.response;
  const caseId = await readPositiveId(context);
  if (!caseId) return jsonResponse(400, { error: { message: "A valid case ID is required." } });
  const parsed = await readJson(request);
  if (!parsed.ok) return jsonResponse(400, { error: { message: "The request must contain valid JSON." } });
  const { action, user_id: userId } = parsed.value ?? {};
  const targetUserId = parsePositiveId(userId);
  if (!["grant", "revoke"].includes(action) || !targetUserId) {
    return jsonResponse(400, { error: { message: "Choose grant or revoke and provide a valid user ID." } });
  }
  try {
    await callProcedure(toDbSession(auth.session), action === "grant" ? "sp_grant_access" : "sp_revoke_access", [caseId, targetUserId]);
    return jsonResponse(200, { ok: true, message: action === "grant" ? "Case access granted." : "Case access revoked." });
  } catch (error) {
    console.error("[tracex:case:access]", { code: error?.code, errno: error?.mysqlErrno });
    return jsonResponse(409, { error: { message: "The access change was rejected. The user may already have the selected access state, or the case/user may be invalid." } });
  }
}
