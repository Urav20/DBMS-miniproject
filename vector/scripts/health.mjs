// Prints the health of Qdrant, the collection and (with --embedding) the model.
// The first --embedding run downloads the model (about 130 MB) into the cache.
//
//   cd app && npm run vector:health
//   cd app && npm run vector:health -- --embedding

import { checkVectorHealth, getVectorServices } from "../../app/src/lib/vector/index.js";

try {
  const { store, embedder } = getVectorServices();
  const includeEmbedding = process.argv.includes("--embedding");
  const report = await checkVectorHealth({ store, embedder, includeEmbedding });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
} catch (err) {
  console.error(`Health check failed [${err.code ?? "ERROR"}]: ${err.message}`);
  process.exitCode = 1;
}
