import { authorizeRequest, toDbSession, jsonResponse } from "@/lib/auth/access.js";
import { callProcedure } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === (request.headers.get("host") || new URL(request.url).host); }
  catch { return false; }
}

async function recordId(context) {
  const params = await context.params;
  const id = Number(params?.id);
  return Number.isSafeInteger(id) && id > 0 && id <= 4294967295 ? id : null;
}

export async function PATCH(request, context) {
  if (!sameOrigin(request)) return jsonResponse(403, { error: { message: "This request was not sent from this site." } });
  const auth = authorizeRequest(request, { roles: ["admin", "investigator"] });
  if (!auth.ok) return auth.response;
  const id = await recordId(context);
  if (!id) return jsonResponse(400, { error: { message: "A valid evidence ID is required." } });
  let body;
  try { body = await request.json(); } catch { return jsonResponse(400, { error: { message: "The request must contain valid JSON." } }); }
  if (!body || typeof body.title !== "string" || typeof body.description !== "string" || !(body.extracted_text === null || typeof body.extracted_text === "string") || body.title.trim().length === 0 || body.title.length > 200 || body.description.trim().length === 0 || body.description.length > 60000 || (body.extracted_text?.length ?? 0) > 500000) {
    return jsonResponse(400, { error: { message: "Provide a title (1–200 characters), description (1–60,000 characters), and optional extracted text (up to 500,000 characters)." } });
  }
  try {
    await callProcedure(toDbSession(auth.session), "sp_update_evidence_text", [id, body.title, body.description, body.extracted_text]);
    return jsonResponse(200, { ok: true, message: "Evidence text updated. The database queued a vector refresh." });
  } catch (error) {
    console.error("[tracex:evidence:update]", { code: error?.code, errno: error?.mysqlErrno });
    return jsonResponse(Number(error?.status) >= 400 && Number(error?.status) < 500 ? error.status : 409, { error: { message: "The update was rejected. Check your case access, case status and evidence status." } });
  }
}

export async function DELETE(request, context) {
  if (!sameOrigin(request)) return jsonResponse(403, { error: { message: "This request was not sent from this site." } });
  const auth = authorizeRequest(request, { roles: ["admin", "investigator"] });
  if (!auth.ok) return auth.response;
  const id = await recordId(context);
  if (!id) return jsonResponse(400, { error: { message: "A valid evidence ID is required." } });
  let body;
  try { body = await request.json(); } catch { return jsonResponse(400, { error: { message: "The request must contain valid JSON." } }); }
  if (!body || typeof body.reason !== "string" || body.reason.trim().length === 0 || body.reason.length > 255) {
    return jsonResponse(400, { error: { message: "A withdrawal reason between 1 and 255 characters is required." } });
  }
  try {
    await callProcedure(toDbSession(auth.session), "sp_withdraw_evidence", [id, body.reason.trim()]);
    return jsonResponse(200, { ok: true, message: "Evidence withdrawn. The database queued removal of its vector." });
  } catch (error) {
    console.error("[tracex:evidence:withdraw]", { code: error?.code, errno: error?.mysqlErrno });
    return jsonResponse(Number(error?.status) >= 400 && Number(error?.status) < 500 ? error.status : 409, { error: { message: "The withdrawal was rejected. Only the registering user or an administrator may withdraw this record, and the case must remain open." } });
  }
}
