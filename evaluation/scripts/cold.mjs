// node evaluation/scripts/cold.mjs --size 500|2000 [--env-file app/.env.local] [--repeats 5]
// Starts a fresh Node process per sample (see src/cold.mjs) and writes results/cold-<size>.json.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, sizeArg, fail } from "../src/cli.mjs";
import { runColdProbes } from "../src/cold.mjs";
import { RESULTS_DIR } from "../src/results-io.mjs";
import { COLD_PROBE } from "../config.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  const size = sizeArg(args);
  const envFile = String(args["env-file"] ?? "app/.env.local");
  const repeats = Number(args.repeats ?? COLD_PROBE.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error("--repeats must be 1..20");
  const probe = join(dirname(fileURLToPath(import.meta.url)), "cold-probe.mjs");
  const spawn = ({ method }) => spawnSync(process.execPath, [`--env-file=${envFile}`, probe, "--size", String(size), "--method", method], { encoding: "utf8" });
  const { samples, summary } = runColdProbes({ size, repeats, spawn, log: console.log });
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `cold-${size}.json`);
  writeFileSync(file, JSON.stringify({ meta: { kind: "cold-start", size, query_id: COLD_PROBE.queryId, repeats, finished_at: new Date().toISOString(), node: process.version, platform: process.platform,
    definition: "Each sample = first search call in a brand-new Node process, timed after the environment checks (MySQL pool open) and before the model/Qdrant are touched. Server and OS caches are not reset." }, samples, summary }, null, 1) + "\n");
  console.log(`Wrote ${file}`);
  for (const [m, s] of Object.entries(summary)) console.log(`${m.padEnd(8)} first=${s.first_sample_ms.toFixed(0)}ms min=${s.min_ms.toFixed(0)}ms median=${s.median_ms.toFixed(0)}ms max=${s.max_ms.toFixed(0)}ms (n=${s.samples})`);
} catch (e) { fail(e); }
