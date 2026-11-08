// Creates (or validates) the Qdrant collection and payload indexes.
// Safe to run repeatedly. Never deletes or recreates an existing collection.
//
//   cd app && npm run vector:setup

import { getVectorServices } from "../../app/src/lib/vector/index.js";

try {
  const { store, config } = getVectorServices();
  const result = await store.ensureCollection();
  console.log(
    result.created
      ? `Created collection "${config.collection}" (384 dimensions, Cosine).`
      : `Collection "${config.collection}" already exists and matches the design.`,
  );
  if (result.createdIndexes.length > 0) {
    console.log(`Created payload indexes: ${result.createdIndexes.join(", ")}.`);
  }
  console.log(`Points currently stored: ${await store.countPoints()}.`);
} catch (err) {
  console.error(`Setup failed [${err.code ?? "ERROR"}]: ${err.message}`);
  process.exitCode = 1;
}
