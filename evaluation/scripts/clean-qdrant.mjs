// node --env-file=app/.env.local evaluation/scripts/clean-qdrant.mjs --all --yes
// Deletes ONLY Qdrant collections named tracex_eval_<size>. Nothing else can be deleted by this script.
import { parseArgs, fail } from "../src/cli.mjs";
import { SIZES } from "../config.mjs";
import { applyEvalEnv, deleteEvalCollection, evalCollectionName } from "../src/safety.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  const sizes = args.all ? [...SIZES] : [Number(args.size)];
  const names = sizes.map(evalCollectionName); // throws for anything but a known size
  if (!args.yes) {
    console.log(`Would delete Qdrant collections: ${names.join(", ")}\nRe-run with --yes to do it.`);
    process.exit(0);
  }
  applyEvalEnv(sizes[0]);
  const { createVectorStore, loadVectorConfig } = await import("../../app/src/lib/vector/index.js");
  const store = createVectorStore({ config: loadVectorConfig(process.env) });
  for (const name of names) console.log(`${name}: ${(await deleteEvalCollection(store.client, name)) ? "deleted" : "did not exist"}`);
} catch (e) { fail(e); }
