// INTERNAL: one independent cold-start sample, run by scripts/cold.mjs in a fresh Node process.
// node --env-file=app/.env.local evaluation/scripts/cold-probe.mjs --size 500 --method keyword|vector|hybrid
//
// Timed interval = the first search call of this process. It starts AFTER the environment checks
// (so the MySQL pool and its connections already exist) and BEFORE anything else is loaded, so for
// vector and hybrid it includes the embedding-model load and the first Qdrant request.
import { parseArgs, sizeArg, fail } from "../src/cli.mjs";
import { createLiveContext } from "../src/live.mjs";
import { prepareLive } from "../src/live-setup.mjs";
import { COLD_PROBE } from "../config.mjs";

const args = parseArgs(process.argv.slice(2));
const size = sizeArg(args);
let ctx;
try {
  ctx = await createLiveContext(size);
  const live = await prepareLive(ctx, size, { verifyQdrant: false });
  const method = live.methods[args.method] ?? fail(`unknown method ${args.method}`);
  const q = live.queries.find((x) => x.id === (args["query-id"] ?? COLD_PROBE.queryId)) ?? fail("unknown query id");
  const t0 = performance.now();
  const res = await method.search(q.text);
  const ms = performance.now() - t0;
  console.log(`COLD_PROBE_RESULT ${JSON.stringify({ method: args.method, query_id: q.id, ms, results: res.ids.length, stages: res.stages ?? null, pid: process.pid })}`);
} catch (e) { fail(e); } finally { await ctx?.db.closeAll?.(); }
