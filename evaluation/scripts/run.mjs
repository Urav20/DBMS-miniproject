// node --env-file=app/.env.local evaluation/scripts/run.mjs --size 500|2000 [--methods keyword,vector,hybrid] [--tag name]
// Runs the three retrieval methods on the same records, queries and labels and writes
// evaluation/results/results-<size>.json plus two CSV files. Reads only; writes nothing to MySQL or Qdrant.
import { parseArgs, sizeArg, fail } from "../src/cli.mjs";
import { createLiveContext } from "../src/live.mjs";
import { prepareLive } from "../src/live-setup.mjs";
import { readMysqlMeta } from "../src/eval-env.mjs";
import { runEvaluation } from "../src/run-evaluation.mjs";
import { writeResults } from "../src/results-io.mjs";
import { evalConfigSnapshot, K } from "../config.mjs";

const args = parseArgs(process.argv.slice(2));
const size = sizeArg(args);
const wanted = String(args.methods ?? "keyword,vector,hybrid").split(",");
let ctx;
try {
  ctx = await createLiveContext(size);
  console.log(`Target: database ${ctx.target.dbName}, collection ${ctx.target.collection}`);
  const live = await prepareLive(ctx, size);
  const methods = wanted.map((m) => live.methods[m] ?? fail(`unknown method ${m}`));

  const config = evalConfigSnapshot();
  const result = await runEvaluation({ methods, queries: live.queries, qrels: live.qrels, idToKey: live.idToKey, config, now: live.now, log: (m) => console.log(m) });

  const payload = {
    meta: {
      kind: "live", mock: false, finished_at: new Date().toISOString(), size, database: ctx.target.dbName, collection: ctx.target.collection,
      records: live.idToKey.size, queries: live.queries.length, answerable_queries: live.queries.filter((q) => q.target_group).length,
      dataset: live.dataset.meta, config, methods_run: wanted, qdrant_points: live.info.points,
      embedding_model: ctx.vector.config?.embedding?.model ?? null, mysql: await readMysqlMeta({ db: ctx.db, session: live.admin }),
      node: process.version, platform: process.platform, cases: live.caseIds.length,
      notes: ["Keyword and hybrid run as the evaluation administrator (FULLTEXT cannot run through investigator views).", "Evidence records only; findings are not indexed by the Phase 2 worker.", "first_call_in_process_ms is NOT an independent cold start; see cold-<size>.json (scripts/cold.mjs)."],
    },
    ...result,
  };
  const tag = args.tag ? `-${args.tag}` : "";
  const files = writeResults(`${size}${tag}`, payload);
  console.log(`\nWrote ${files.json}\n      ${files.perQuery}\n      ${files.summary}`);
  for (const [name, r] of Object.entries(result.methods)) {
    const o = r.quality.overall;
    console.log(`${name.padEnd(8)} P@${K}=${o.p.toFixed(3)} R@${K}=${o.r.toFixed(3)} F1=${o.f1.toFixed(3)} MRR=${o.rr.toFixed(3)} MAP=${o.ap.toFixed(3)} NDCG@${K}=${o.ndcg.toFixed(3)} warm-median=${r.latency.warm.median.toFixed(1)}ms first-call=${r.latency.first_call_in_process_ms.ms.toFixed(1)}ms`);
  }
} catch (e) { fail(e); } finally { await ctx?.db.closeAll?.(); }
