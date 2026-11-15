import { authorizeRequest, toDbSession, jsonResponse } from "@/lib/auth/access.js";
import { callProcedure } from "@/lib/db/index.js";
import { isSameOrigin, readJson, cleanText } from "@/lib/api/write-guards.js";

export const dynamic = "force-dynamic";

export async function POST(request) {
  if (!isSameOrigin(request)) return jsonResponse(403, { error: { message: "This request was not sent from this site." } });
  const auth = authorizeRequest(request, { roles: ["admin"] });
  if (!auth.ok) return auth.response;
  const parsed = await readJson(request);
  if (!parsed.ok) return jsonResponse(400, { error: { message: "The request must contain valid JSON." } });
  const body = parsed.value;
  const caseNumber = cleanText(body?.case_number, 30, { required: true });
  const title = cleanText(body?.title, 200, { required: true });
  const description = body?.description == null ? null : cleanText(body.description, 10000);
  if (!caseNumber || !title || (body?.description != null && description === null)) {
    return jsonResponse(400, { error: { message: "Provide a case number (1–30 characters), title (1–200 characters), and an optional description up to 10,000 characters." } });
  }
  try {
    const result = await callProcedure(toDbSession(auth.session), "sp_create_case", [caseNumber, title, description]);
    const row = result?.resultSets?.[0]?.[0] ?? null;
    return jsonResponse(201, { ok: true, case_id: row?.case_id ?? null, message: "Case created." });
  } catch (error) {
    console.error("[tracex:case:create]", { code: error?.code, errno: error?.mysqlErrno });
    return jsonResponse(409, { error: { message: "The case could not be created. The case number may already exist, or the database rejected the request." } });
  }
}
