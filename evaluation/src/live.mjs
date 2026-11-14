// Wires the evaluation to the REAL project modules. Everything here talks to live MySQL, Qdrant
// and the embedding model, so unit tests never import this file.
// applyEvalEnv() runs first: it points DB_NAME and QDRANT_COLLECTION at the evaluation targets
// before any project module reads them, and every later step re-verifies the connection.
import { applyEvalEnv, assertEvalCollection } from "./safety.mjs";

export async function createLiveContext(size) {
  const target = applyEvalEnv(size);
  const db = await import("../../app/src/lib/db/index.js");
  const { getVectorServices } = await import("../../app/src/lib/vector/index.js");
  const retrieval = await import("../../app/src/lib/retrieval/index.js");
  const indexing = await import("../../app/src/lib/indexing/index.js");
  const vector = getVectorServices(process.env);
  assertEvalCollection(vector.store.name);
  if (vector.store.name !== target.collection) throw new Error("Vector store is not using the evaluation collection.");
  return { target, db, vector, retrieval, indexing };
}
