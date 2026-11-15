import { authorizeRequest, toDbSession, jsonResponse } from "@/lib/auth/access.js";
import { callProcedure } from "@/lib/db/index.js";
import { getVectorServices } from "@/lib/vector/index.js";

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
    // Validate/create the collection safely, then enqueue work. Do not start a
    // second worker in this web request: TRACE-X is explicitly single-worker.
    const vector = getVectorServices();
    await vector.store.ensureCollection();
    const queued = await callProcedure(toDbSession(auth.session), "sp_backfill_index_jobs", []);
    const row = queued?.resultSets?.[0]?.[0] ?? {};
    const result = {
      evidenceQueued: Number(row.evidence_jobs_queued ?? 0),
      findingsQueued: Number(row.finding_jobs_queued ?? 0),
    };
    return jsonResponse(200, {
      ok: true,
      result,
      message: "Missing and stale records were queued. The background indexing worker will process them.",
    });
  } catch (error) {
    console.error("[tracex:admin:reindex]", { code: error?.code, name: error?.name });
    return jsonResponse(503, { error: { message: "Index jobs could not be queued. Check the administrator MySQL connection and Qdrant configuration." } });
  }
}
