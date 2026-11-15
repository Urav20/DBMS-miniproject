// node evaluation/scripts/sql.mjs --size 500|2000     writes evaluation/tmp/eval_setup_<size>.sql
// node evaluation/scripts/sql.mjs --cleanup            writes evaluation/tmp/eval_cleanup.sql
// Reads database/01..03 (never writes them) and writes ONLY under evaluation/tmp/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, sizeArg, fail } from "../src/cli.mjs";
import { buildSetupSql, buildCleanupSql } from "../src/sql-transform.mjs";
import { evalDbName } from "../src/safety.mjs";
import { SIZES } from "../config.mjs";

try {
  const here = dirname(fileURLToPath(import.meta.url));
  const databaseDir = resolve(here, "..", "..", "database");
  const tmp = resolve(here, "..", "tmp");
  mkdirSync(tmp, { recursive: true });
  const args = parseArgs(process.argv.slice(2));
  if (args.cleanup) {
    const file = join(tmp, "eval_cleanup.sql");
    writeFileSync(file, buildCleanupSql(SIZES.map(evalDbName)));
    console.log(`Wrote ${file}\nRun:  cmd /c "mysql -u root -p < evaluation\\tmp\\${file.split(/[\\/]/).pop()}"`);
  } else {
    const size = sizeArg(args);
    const file = join(tmp, `eval_setup_${size}.sql`);
    writeFileSync(file, buildSetupSql({ databaseDir, dbName: evalDbName(size) }));
    console.log(`Wrote ${file}\nIt drops and recreates ONLY ${evalDbName(size)}.\nRun:  cmd /c "mysql -u root -p < evaluation\\tmp\\${file.split(/[\\/]/).pop()}"`);
  }
} catch (e) { fail(e); }
