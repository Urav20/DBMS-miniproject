import { authorizeRequest, jsonResponse } from "@/lib/auth/access.js";
import { getVectorServices, pointId, KINDS } from "@/lib/vector/index.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = authorizeRequest(request, { roles: ["admin"] });
  if (!auth.ok) return auth.response;
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const rawId = url.searchParams.get("id");
  const recordId = rawId && /^\d+$/.test(rawId) ? Number(rawId) : NaN;
  if (!KINDS.includes(kind) || !Number.isSafeInteger(recordId) || recordId < 1 || recordId > 4294967295) {
    return jsonResponse(400, { error: { message: "Provide kind=evidence|finding and a positive record ID." } });
  }
  try {
    const { store } = getVectorServices();
    const point = await store.retrievePoint(pointId(kind, recordId));
    if (!point) return jsonResponse(404, { found: false, message: "No vector point exists for this record ID." });
    return jsonResponse(200, { found: true, point });
  } catch (error) {
    console.error("[tracex:admin:vector-point]", { code: error?.code, name: error?.name });
    return jsonResponse(503, { error: { message: "The vector point could not be inspected. Check Qdrant connectivity." } });
  }
}
