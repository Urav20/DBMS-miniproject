// Indexing worker entry point (Person B, Phase 2).
//
//   cd app
//   npm run worker            # run until Ctrl+C / SIGTERM
//   npm run worker:once       # drain the queue once, then exit
//
// Reads app/.env.local (DB_*, QDRANT_*, EMBEDDING_*, optional WORKER_*).
// Run ONE instance only: index_job has no claim token or lease (see worker/README.md).

import { createDefaultWorker } from "../app/src/lib/indexing/index.js";
import { closeAll } from "../app/src/lib/db/index.js";

const once = process.argv.includes("--once");
let exitCode = 0;

try {
  const { worker, vector, repo } = createDefaultWorker();

  // Creates the collection if missing, validates it if present. Never recreates one.
  await vector.store.ensureCollection();

  // 02_access.sql gives tracex_worker no privilege on `analysis`, which finding upserts need
  // (finding -> analysis -> evidence). Say so loudly instead of failing job by job in silence.
  try {
    if (!(await repo.canResolveFindings())) {
      console.warn(
        "[tracex:worker] WARNING: the worker account cannot read table `analysis`. " +
          "Finding upsert jobs will be marked failed (INDEX_FINDING_ACCESS_MISSING) until " +
          "Person A grants SELECT on it. Evidence jobs and finding delete jobs are unaffected.",
      );
    }
  } catch {
    // MySQL not reachable yet: the main loop reports and backs off on its own.
  }

  const shutdown = (signal) => {
    console.log(`[tracex:worker] ${signal} received, finishing the current batch...`);
    worker.stop();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (once) {
    const total = await worker.drain();
    console.log("[tracex:worker] drained", total);
    if (total.outage) exitCode = 2; // a dependency was down; jobs were left pending
    else if (total.failed > 0) exitCode = 1;
  } else {
    await worker.start();
  }
} catch (err) {
  console.error(`Worker failed [${err.code ?? "ERROR"}]: ${err.message}`);
  exitCode = 1;
} finally {
  await closeAll();
}
process.exitCode = exitCode;
