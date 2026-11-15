import { authorizeRequest, toDbSession, jsonResponse } from "@/lib/auth/access.js";
import { query } from "@/lib/db/index.js";
import { getVectorServices } from "@/lib/vector/index.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const auth = authorizeRequest(request, { roles: ["admin"] });
  if (!auth.ok) return auth.response;
  try {
    const { store } = getVectorServices();
    const [health, counts] = await Promise.all([
      store.inspectCollection(),
      query(toDbSession(auth.session), "SELECT status, operation, COUNT(*) AS total FROM index_job GROUP BY status, operation ORDER BY status, operation"),
    ]);
    return jsonResponse(200, { collection: store.name, ...health, jobs: counts });
  } catch (error) {
    console.error("[tracex:admin:vector]", { code: error?.code, name: error?.name });
    return jsonResponse(503, { error: { message: "Vector status is unavailable. Check Qdrant and the server configuration." } });
  }
}
