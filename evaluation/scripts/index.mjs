// node --env-file=app/.env.local evaluation/scripts/index.mjs --size 500|2000
// Recreates the tracex_eval_<size> Qdrant collection and indexes the pending jobs with the Phase 2 worker.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, sizeArg, fail } from "../src/cli.mjs";
import { createLiveContext } from "../src/live.mjs";
import { loadDataset, tierRecords } from "../src/dataset.mjs";
import { resolveEvalAdmin } from "../src/eval-env.mjs";
import { indexEvalCollection } from "../src/indexer.mjs";
import { RESULTS_DIR } from "../src/results-io.mjs";

const size = sizeArg(parseArgs(process.argv.slice(2)));
let ctx;
try {
  ctx = await createLiveContext(size);
  console.log(`Target: database ${ctx.target.dbName}, collection ${ctx.target.collection}`);
  const { dataset } = loadDataset();
  const admin = await resolveEvalAdmin({ db: ctx.db, expectedId: process.env.EVAL_ADMIN_USER_ID ?? null });
  const quiet = { info() {}, debug() {}, warn: console.warn, error: console.error };
  const { worker } = ctx.indexing.createDefaultWorker(process.env, quiet);
  console.log("Indexing (the first run downloads the embedding model; this can take a while)...");
  const res = await indexEvalCollection({
    db: ctx.db, adminSession: admin, workerSession: ctx.indexing.WORKER_SESSION, worker, store: ctx.vector.store,
    expectedRecords: tierRecords(dataset, size).length, log: console.log,
  });
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, `indexing-${size}.json`), JSON.stringify({ ...res, finished_at: new Date().toISOString() }, null, 1) + "\n");
  console.log(`Indexed ${res.points} points in ${res.seconds.toFixed(1)} s (${res.records_per_second.toFixed(1)} records/s). Verified: no jobs left, all evidence indexed.`);
} catch (e) { fail(e); } finally { await ctx?.db.closeAll?.(); }
