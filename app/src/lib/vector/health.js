// Health checks for the vector layer. Each part reports "ok" or "error" plus a short
// safe message; nothing here prints URLs with keys or document text.

import { VectorError } from "./errors.js";

function describe(err) {
  return err instanceof VectorError ? { code: err.code, message: err.message } : {
    code: "VECTOR_UNKNOWN",
    message: "Unexpected error.",
  };
}

// includeEmbedding loads the model (slow the first time, downloads it) and embeds one probe.
export async function checkVectorHealth({ store, embedder, includeEmbedding = false }) {
  const report = {
    ok: true,
    qdrant: { status: "ok" },
    collection: { status: "ok", name: store.name },
    embedding: { status: includeEmbedding ? "ok" : "skipped" },
  };

  try {
    await store.ping();
  } catch (err) {
    report.ok = false;
    report.qdrant = { status: "error", ...describe(err) };
    report.collection = { status: "skipped", name: store.name };
  }

  if (report.qdrant.status === "ok") {
    try {
      const state = await store.inspectCollection();
      if (!state.exists) {
        report.ok = false;
        report.collection = {
          status: "error",
          name: store.name,
          message: "Collection does not exist. Run the vector setup script.",
        };
      } else if (state.problems.length > 0) {
        report.ok = false;
        report.collection = {
          status: "error",
          name: store.name,
          message: `Collection does not match the design: ${state.problems.join("; ")}.`,
        };
      } else {
        const missing = Object.entries(state.indexes)
          .filter(([, type]) => !type)
          .map(([field]) => field);
        if (missing.length > 0) {
          report.ok = false;
          report.collection = {
            status: "error",
            name: store.name,
            message: `Missing payload index: ${missing.join(", ")}. Run the vector setup script.`,
          };
        } else {
          report.collection.points = state.points;
        }
      }
    } catch (err) {
      report.ok = false;
      report.collection = { status: "error", name: store.name, ...describe(err) };
    }
  }

  if (includeEmbedding) {
    try {
      const { dimensions } = await embedder.probe();
      report.embedding = { status: "ok", dimensions };
    } catch (err) {
      report.ok = false;
      report.embedding = { status: "error", ...describe(err) };
    }
  }
  return report;
}
