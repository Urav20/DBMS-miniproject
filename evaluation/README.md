# TRACE-X Phase 4: Retrieval Evaluation

Compares **keyword** (MySQL FULLTEXT), **vector** (the Phase 3 semantic search over Qdrant) and **hybrid**
(keyword + vector, Reciprocal Rank Fusion) on the same records, queries and relevance labels, at **500** and
**2,000** evidence records.

Everything lives in `evaluation/`. No existing project file is modified, and nothing here needs a new dependency.

## What touches what (safety model)

| Thing | Used by the evaluation? |
|---|---|
| Your development database `tracex` and Qdrant collection `tracex_records` | **Never read, written or deleted.** |
| MySQL databases `tracex_eval_500`, `tracex_eval_2000` (created by you in step 2) | Yes: the only databases it writes. |
| Qdrant collections `tracex_eval_500`, `tracex_eval_2000` | Yes: the only collections it creates, fills or deletes. |
| `database/01..03_*.sql` (Person A) | Read as text only. The setup SQL is a renamed copy written to `evaluation/tmp/` (git-ignored). |

Guards (all unit-tested):

- Every script sets `DB_NAME` and `QDRANT_COLLECTION` **inside its own process** to `tracex_eval_<size>`, overriding whatever `app/.env.local` says. Nothing is written back to any file.
- Names must match `tracex_eval...`; anything else (`tracex`, `tracex_records`, ...) is refused.
- After connecting, the scripts ask MySQL `SELECT DATABASE()` and refuse unless it is an evaluation database. This is checked on the admin connection **and** on the worker connection, so the evaluation worker cannot claim jobs from your development database.
- Indexing refuses to start unless the queue holds exactly this dataset's jobs. Loading refuses a database that already has data.
- The only collection delete in the code is guarded by the same name check.
- The generated setup SQL is verified before it is written: no bare `tracex`, exactly one `DROP DATABASE` and one `CREATE DATABASE` (both the evaluation database), every `USE` and every schema-qualified `GRANT` targets the evaluation database.
- The evaluation administrator is **looked up and verified** (exists, active, role Administrator); its id is never assumed.

## Requirements

- Node 22 or newer (same as the app), run from the **repository root**.
- `cd app && npm ci` already done (the evaluation reuses the app's `mysql2`, `@qdrant/js-client-rest` and embedding packages).
- MySQL 8 and Qdrant running; `app/.env.local` filled in as for Phases 1-3 (DB account passwords, `QDRANT_URL`, embedding settings). The accounts `tracex_admin_app`, `tracex_worker_app`, ... must already exist (they do if Phase 1 is set up).
- A MySQL account that can create databases and grants (e.g. `root`), used **only** for steps 2 and 8. Its password is typed at the prompt and never stored.
- The first indexing run downloads the embedding model (needs internet once).

## Step by step (PowerShell, from the repo root)

### 0. Unit tests (no services needed)

```powershell
node evaluation/scripts/test.mjs
```

Expected: all tests pass, none skipped.

### 1. Dataset (already generated; regenerate only if you change `queries.json` or `corpus.mjs`)

```powershell
node evaluation/scripts/generate.mjs
```

Deterministic: seed 20260509 always gives the same `data/dataset.json`, `data/qrels.json`, `data/query-audit.json`.
Loading refuses to run if these files differ from a fresh generation.

### 2. Create the isolated MySQL database (repeatable; re-running rebuilds it from scratch)

```powershell
node evaluation/scripts/sql.mjs --size 500
cmd /c "mysql -u root -p < evaluation\tmp\eval_setup_500.sql"
```

This creates `tracex_eval_500` from Person A's schema, access and routines (database name replaced in memory), the same roles/grants, plus a tiny seed: two roles, ten evidence types and one non-login administrator `eval_admin`. Use `--size 2000` for the large set.
If `mysql` is not on your PATH, call it by its full path, e.g. `& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"`.
(PowerShell does not support `<` redirection, hence `cmd /c`.)

### 3. Populate

```powershell
node --env-file=app/.env.local evaluation/scripts/load.mjs --size 500
```

Registers the 500 records through `sp_create_case` / `sp_register_evidence` as `eval_admin`. The existing triggers queue the `index_job` rows.

### 4. Index (Phase 2 worker -> `tracex_eval_500` collection)

```powershell
node --env-file=app/.env.local evaluation/scripts/index.mjs --size 500
```

Recreates the evaluation collection, drains the outbox with the existing worker, then verifies: no jobs left, every evidence row has `indexed_version`, Qdrant point count equals the record count. Writes `results/indexing-500.json` (time, records per second).

### 5. Run the comparison

```powershell
node --env-file=app/.env.local evaluation/scripts/run.mjs --size 500
```

Writes `results/results-500.json`, `results/per-query-500.csv`, `results/summary-500.csv`.
Repeat steps 2-5 with `--size 2000`.

### 5b. Independent cold-start probes (optional, after step 5; needs the real embedding model)

```powershell
node evaluation/scripts/cold.mjs --size 500
```

Writes `results/cold-500.json`. Each of the 15 samples (3 methods x 5 repeats) is a fresh Node process.

### 6. Report with tables and graphs

```powershell
node evaluation/scripts/report.mjs
```

Writes `results/REPORT.md` and `results/charts/*.svg` from whichever `results-<size>.json` (and `cold-<size>.json`) files exist. All numbers come from those files.

### 7. Live integration tests (optional, read-only, after steps 2-4)

```powershell
node evaluation/scripts/test.mjs --live        # uses size 500; set $env:EVAL_TEST_SIZE=2000 for the other
```

### 8. Clean up (removes only the evaluation environment)

```powershell
node evaluation/scripts/sql.mjs --cleanup
cmd /c "mysql -u root -p < evaluation\tmp\eval_cleanup.sql"
node --env-file=app/.env.local evaluation/scripts/clean-qdrant.mjs --all --yes
```

`eval_cleanup.sql` contains only `DROP DATABASE IF EXISTS tracex_eval_500;` and `...2000;`. `clean-qdrant.mjs` can only delete `tracex_eval_500` / `tracex_eval_2000` (without `--yes` it just prints what it would do). The MySQL accounts and roles are shared with your development setup and are left alone; table-level privileges recorded for the dropped schemas are harmless and may remain in `mysql.tables_priv`.
You can also delete `evaluation/tmp/` at any time.

## Design

**Records.** 2,000 synthetic records; the 500-record set is a subset of them. 14 "event" groups of 8 records (4 use the group's canonical keywords, 4 describe the same event in different words), 6 "trap" groups that reuse event vocabulary for harmless activity (e.g. a routine backup job vs. shadow-copy deletion), and templated routine IT filler. The 500-set holds every relevant record; the 2,000-set adds only non-relevant records, so the comparison isolates the effect of corpus size. Records are spread over 40 cases (a case can hold at most 99 records because `sp_register_evidence` numbers evidence with `LPAD(n, 2)`; Phase 3 allows at most 50 case ids).

**Queries.** 40, hand-written in `data/queries.json`: 8 exact keyword, 8 partial, 10 semantic (no event vocabulary), 8 related-concept, 6 with no relevant record.

**Labels.** Graded: 2 = record belongs to the event the query targets, 1 = belongs to a related event listed on the query, 0 otherwise. They are derived from group membership when the data is generated, before any search runs, and never from search output. `data/query-audit.json` lists, per query, how much of its wording appears in its relevant records.

**Methods** (all on the same case scope and the same active records):

- *Keyword*: InnoDB `MATCH(title, description, extracted_text) AGAINST (? IN NATURAL LANGUAGE MODE)`, as in Person A's Q13. Default token size and stopwords; no stemming or rewriting.
- *Vector*: the unmodified Phase 3 `createSearchService` (embed with BGE-small-en-v1.5 -> Qdrant -> MySQL re-validation), `kind = evidence`.
- *Hybrid*: top 50 of each list fused with RRF (`1/(60+rank)`), top 10 returned. Constants fixed in `config.mjs` before any run.

**Metrics** (K = 10; definitions are also printed in the report): Precision@10, Recall@10, F1@10, MRR, MAP (AP@10 normalised by min(|R|, 10)), NDCG@10 (linear gain, log2 discount); "relevant" = grade 2, with a lenient grade >= 1 view; macro average over answerable queries; no-answer queries reported separately; rankings de-duplicated before scoring. A seeded paired bootstrap (10,000 resamples) gives a 95% confidence interval for hybrid minus keyword and hybrid minus vector.

**Latency.** Per search call, in the evaluation process. One warm-up pass over all queries, then 5 timed passes (**warm**, 200 samples per method), reported as mean / median / p95. Vector latency is split into embed, Qdrant and MySQL stages; hybrid into keyword, vector and fusion. Standalone keyword and vector fetch K results; inside hybrid they fetch 50. Hybrid runs the two searches one after the other, so its latency is their sum.
Two different "first query" numbers exist and are labelled differently:

- **First call (in process)**: the first call of each method inside the main run. The three methods share one process and run in order (keyword, vector, hybrid), so this is **not** an independent cold start (hybrid, for instance, finds the model and connections already warm).
- **Cold start (fresh process)**: `scripts/cold.mjs` starts a brand-new Node process for every sample (`cold-probe.mjs`), interleaved keyword / vector / hybrid, 5 repeats each. The timed interval is the first search call of that process: it starts after the environment checks (MySQL pool open) and before the model or Qdrant are touched, so vector and hybrid include the model load and the first Qdrant request. The MySQL and Qdrant servers' caches and the OS file cache cannot be reset by a script, so repeats after the first begin with warm servers; min / median / max are all reported.

**Reproducibility.** Dataset seed 20260509, bootstrap seed 424242, K, depth, RRF constant, pass counts, MySQL version and FULLTEXT settings, embedding model and Node version are written into every results file.

## Verification status

The November 2026 benchmarks were run on Windows with Node.js v22.19.0, MySQL 8.0.46 in Docker, Qdrant, and isolated evaluation datasets of 500 and 2000 records. The committed result metadata records live execution (mock=false) and the BAAI/bge-small-en-v1.5 embedding model. The earlier stand-in-embedder note describes a previous environment, not these benchmark results.

Unit tests and three live integration tests per dataset were run. Exact test output is retained under evaluation/results/verification/. The benchmark does not establish complete UI/API integration or vector RUD demonstration.

### macOS / Linux instructions (not independently tested)

From the repository root, install dependencies using cd app, npm ci, then cd back. Generate setup SQL using node evaluation/scripts/sql.mjs --size 500 and import with the MySQL CLI using input redirection. Configure app/.env.local, then run evaluation/scripts/load.mjs, index.mjs and run.mjs with Node.js --env-file=app/.env.local and --size 500. Repeat for --size 2000. Run node evaluation/scripts/report.mjs to generate evaluation/results/REPORT.md, JSON/CSV results and SVG charts.

## Limitations

- Records, queries and labels are synthetic and written by one author; results describe this benchmark, not real casework. Please review `data/queries.json` and the group definitions in `src/corpus.mjs`.
- FULLTEXT cannot run through the investigator views (MATCH needs the base table), so keyword and hybrid run as the evaluation administrator. Access-control behaviour is not evaluated.
- Findings are not indexed by the Phase 2 worker (blocker B1 in the Phase 3 notes: the worker role has no SELECT on `analysis`), so only **evidence** is evaluated.
- Phase 3 always re-reads candidates from MySQL, so vector latency includes that validation by design.
- Latency is one machine, local services; operating-system caches cannot be cleared by the script.
- Only one hybrid configuration (RRF) is evaluated.
- Qdrant similarity is a retrieval signal only; MySQL remains the authority.

## Files

```
evaluation/
  config.mjs                  fixed parameters (K, seed, depth, RRF constant, pass counts)
  data/                       queries.json (hand-written), dataset.json, qrels.json, query-audit.json (generated)
  src/                        safety, sql-transform, corpus, dataset, metrics, stats, fusion, aggregate,
                              methods/{keyword,vector,hybrid}, run-evaluation, eval-env, loader, indexer,
                              live, live-setup, cold, results-io, charts, report, cli, rng
  scripts/                    generate, sql, load, index, run, cold, cold-probe (internal), report, clean-qdrant, test
  tests/                      unit tests (mocks) and live.test.mjs (needs the real stack)
  results/                    results-<size>.json, per-query-<size>.csv, summary-<size>.csv, REPORT.md, charts/
  tmp/                        generated SQL (git-ignored)
```
