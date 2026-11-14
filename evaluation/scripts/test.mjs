// node evaluation/scripts/test.mjs [--live]
// Runs the unit tests (mocks only). With --live (and EVAL_LIVE=1 + .env.local) also the live tests.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "tests");
const live = process.argv.includes("--live");
const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs") && (live ? f.startsWith("live") : !f.startsWith("live"))).map((f) => join(dir, f));
const extra = live ? ["--env-file=app/.env.local"] : [];
const env = live ? { ...process.env, EVAL_LIVE: "1" } : process.env;
process.exit(spawnSync(process.execPath, [...extra, "--test", ...files], { stdio: "inherit", env }).status ?? 1);
