// node evaluation/scripts/report.mjs     -> evaluation/results/REPORT.md and results/charts/*.svg
// Uses whatever results-500.json / results-2000.json exist. Refuses to run if there are none.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SIZES } from "../config.mjs";
import { buildReport } from "../src/report.mjs";
import { RESULTS_DIR } from "../src/results-io.mjs";
import { fail } from "../src/cli.mjs";

try {
  const bySize = {};
  const coldBySize = {};
  for (const s of SIZES) {
    const p = join(RESULTS_DIR, `results-${s}.json`);
    if (existsSync(p)) bySize[s] = JSON.parse(readFileSync(p, "utf8"));
    const c = join(RESULTS_DIR, `cold-${s}.json`);
    if (existsSync(c) && bySize[s]) coldBySize[s] = JSON.parse(readFileSync(c, "utf8"));
  }
  if (!Object.keys(bySize).length) throw new Error("No results-<size>.json found in evaluation/results/. Run the experiment first (README, step 5).");
  const { markdown, charts } = buildReport(bySize, coldBySize);
  mkdirSync(join(RESULTS_DIR, "charts"), { recursive: true });
  for (const [name, svg] of Object.entries(charts)) writeFileSync(join(RESULTS_DIR, "charts", name), svg + "\n");
  writeFileSync(join(RESULTS_DIR, "REPORT.md"), markdown + "\n");
  console.log(`Wrote evaluation/results/REPORT.md and ${Object.keys(charts).length} charts from sizes: ${Object.keys(bySize).join(", ")}`);
} catch (e) { fail(e); }
