import { authorizeRequest, toDbSession, jsonResponse } from "@/lib/auth/access.js";
import { callProcedure } from "@/lib/db/index.js";
import { getVectorServices } from "@/lib/vector/index.js";
import { createDefaultWorker } from "@/lib/indexing/index.js";

export const dynamic = "force-dynamic";

function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === (request.headers.get("host") || new URL(request.url).host); }
  catch { return false; }
}

export async function POST(request) {
  if (!sameOrigin(request)) return jsonResponse(403, { error: { message: "This request was not sent from this site." } });
  const auth = authorizeRequest(request, { roles: ["admin"] });
  if (!auth.ok) return auth.response;
  try {
    const vector = getVectorServices();
    await vector.store.ensureCollection();
    await callProcedure(toDbSession(auth.session), "sp_backfill_index_jobs", []);
    const { worker } = createDefaultWorker();
    const result = await worker.drain();
    return jsonResponse(result.failed > 0 || result.outage ? 503 : 200, { ok: result.failed === 0 && !result.outage, result, message: "The index queue was processed. Refresh this page to see remaining jobs." });
  } catch (error) {
    console.error("[tracex:admin:reindex]", { code: error?.code, name: error?.name });
    return jsonResponse(503, { error: { message: "Re-indexing did not complete. Check the worker account, MySQL and Qdrant logs." } });
  }
}
