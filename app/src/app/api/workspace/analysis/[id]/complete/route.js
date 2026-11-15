import { authorizeRequest, toDbSession, jsonResponse } from "@/lib/auth/access.js";
import { callProcedure } from "@/lib/db/index.js";
import { isSameOrigin, readPositiveId } from "@/lib/api/write-guards.js";

export const dynamic = "force-dynamic";

export async function POST(request, context) {
  if (!isSameOrigin(request)) return jsonResponse(403, { error: { message: "This request was not sent from this site." } });
  const auth = authorizeRequest(request, { roles: ["admin", "investigator"] });
  if (!auth.ok) return auth.response;
  const analysisId = await readPositiveId(context);
  if (!analysisId) return jsonResponse(400, { error: { message: "A valid analysis ID is required." } });
  try {
    await callProcedure(toDbSession(auth.session), "sp_complete_analysis", [analysisId]);
    return jsonResponse(200, { ok: true, message: "Analysis marked as completed." });
  } catch (error) {
    console.error("[tracex:analysis:complete]", { code: error?.code, errno: error?.mysqlErrno });
    return jsonResponse(409, { error: { message: "Only the analyst who started this analysis can complete it, and the case must remain open." } });
  }
}
