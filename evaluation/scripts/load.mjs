// node --env-file=app/.env.local evaluation/scripts/load.mjs --size 500|2000
import { parseArgs, sizeArg, fail } from "../src/cli.mjs";
import { createLiveContext } from "../src/live.mjs";
import { loadDataset } from "../src/dataset.mjs";
import { resolveEvalAdmin } from "../src/eval-env.mjs";
import { populateEvalDatabase } from "../src/loader.mjs";

const size = sizeArg(parseArgs(process.argv.slice(2)));
let ctx;
try {
  ctx = await createLiveContext(size);
  console.log(`Target: database ${ctx.target.dbName}, collection ${ctx.target.collection}`);
  const { dataset } = loadDataset();
  const admin = await resolveEvalAdmin({ db: ctx.db, expectedId: process.env.EVAL_ADMIN_USER_ID ?? null });
  console.log(`Evaluation administrator verified (user id ${admin.userId}, role Administrator).`);
  const t0 = Date.now();
  const res = await populateEvalDatabase({ db: ctx.db, session: admin, dataset, size, log: console.log });
  console.log(`Loaded ${res.evidence} evidence records in ${res.cases} cases; ${res.pending_index_jobs} index jobs pending (${((Date.now() - t0) / 1000).toFixed(1)} s).`);
} catch (e) { fail(e); } finally { await ctx?.db.closeAll?.(); }
