import { createSemanticSearchHandler } from "@/lib/retrieval/handlers";
import { getSearchService } from "@/lib/retrieval";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // the embedding model uses ONNX Runtime (native), not the Edge runtime

// POST /api/search/semantic
// body: { query, case_id? | case_ids?, kind?, limit?, min_score? }   (see app/src/lib/retrieval/README.md)
export const POST = createSemanticSearchHandler({ getService: getSearchService });
