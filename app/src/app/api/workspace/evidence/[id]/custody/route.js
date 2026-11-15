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
  const toUserId = parsePositiveId(parsed.value?.to_user_id);
  const reason = cleanText(parsed.value?.reason, 255, { required: true });
  if (!toUserId || !reason) {
    return jsonResponse(400, { error: { message: "Choose a valid receiving teammate and provide a reason (up to 255 characters)." } });
  }
  try {
    await callProcedure(toDbSession(auth.session), "sp_transfer_custody", [evidenceId, toUserId, reason]);
    return jsonResponse(200, { ok: true, message: "Custody transfer recorded." });
  } catch (error) {
    console.error("[tracex:custody:transfer]", { code: error?.code, errno: error?.mysqlErrno });
    return jsonResponse(409, { error: { message: "Transfer rejected. Only the current custodian can transfer active evidence to another active teammate in the same open case." } });
  }
}
