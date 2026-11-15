import { authorizeRequest, toDbSession, jsonResponse } from "@/lib/auth/access.js";
import { query } from "@/lib/db/index.js";
import { getVectorServices, checkVectorHealth } from "@/lib/vector/index.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = authorizeRequest(request, { roles: ["admin", "investigator"] });
  if (!auth.ok) return auth.response;
  const result = { mysql: { status: "error" }, qdrant: { status: "error" }, embedding: { status: "lazy" } };
  try { await query(toDbSession(auth.session), "SELECT 1 AS ok"); result.mysql = { status: "ok" }; }
  catch { result.mysql = { status: "error", message: "MySQL query failed for this account." }; }
  try {
    const { store, embedder } = getVectorServices();
    const health = await checkVectorHealth({ store, embedder, includeEmbedding: false });
    result.qdrant = health.qdrant;
    result.collection = health.collection;
    result.embedding = { status: "lazy", model: "BAAI/bge-small-en-v1.5", dimensions: 384, detail: "Loaded when semantic search or indexing first needs it." };
  } catch { result.qdrant = { status: "error", message: "Qdrant configuration or connection failed." }; }
  const ok = result.mysql.status === "ok" && result.qdrant.status === "ok" && result.collection?.status === "ok";
  return jsonResponse(ok ? 200 : 503, { ok, ...result });
}
