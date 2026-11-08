// Public entry point for the vector layer (server-side only).
//
//   import { getVectorServices, pointId, buildPayload } from "@/lib/vector";
//   const { store, embedder, config } = getVectorServices();
//
// Services are created on first use (so builds need no .env) and kept across Next.js
// dev reloads so the embedding model is not loaded twice.

import { loadVectorConfig } from "./config.js";
import { createEmbedder } from "./embedding.js";
import { createVectorStore } from "./qdrant.js";

const globalKey = Symbol.for("tracex.vector.services");

export function getVectorServices(env = process.env) {
  if (!globalThis[globalKey]) {
    const config = loadVectorConfig(env);
    globalThis[globalKey] = {
      config,
      store: createVectorStore({ config }),
      embedder: createEmbedder({ config }),
    };
  }
  return globalThis[globalKey];
}

export { loadVectorConfig, VECTOR_SIZE, VECTOR_DISTANCE } from "./config.js";
export { VectorError } from "./errors.js";
export { pointId, buildPayload, parsePayload, uuidv5, KINDS } from "./ids.js";
export { buildEvidenceText, buildFindingText, QUERY_PREFIX } from "./text.js";
export { createEmbedder } from "./embedding.js";
export { createVectorStore, PAYLOAD_INDEXES } from "./qdrant.js";
export { checkVectorHealth } from "./health.js";
