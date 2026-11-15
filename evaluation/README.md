# TRACE-X Phase 4: Retrieval Evaluation

Compares **keyword** (MySQL FULLTEXT), **vector-only** (the Phase 3 Qdrant semantic search) and **hybrid** (keyword + vector using Reciprocal Rank Fusion) on the same synthetic queries, relevance labels and evidence records at sizes 500 and 2,000.

## Safety boundary

| Resource | Evaluation behavior |
|---|---|
| Development MySQL database `tracex` | Never read, written or deleted |
| Development Qdrant collection `tracex_records` | Never read, written or deleted |
| `tracex_eval_500`, `tracex_eval_2000` databases and same-named Qdrant collections | Isolated evaluation targets; these scripts create, fill and can delete only these names |

The scripts force their process-local `DB_NAME` and `QDRANT_COLLECTION` to `tracex_eval_<size>`, verify the selected MySQL database with `SELECT DATABASE()`, and reject other database/collection names. SQL setup is generated from the real schema/access/routine files after replacing the bare database name in memory. Read the source script guards before changing them.

**Do not run the cleanup steps against anything except the two evaluation targets.** The cleanup scripts are deliberately restricted to those names.

## Requirements

- Node.js 22+, with dependencies installed by `cd app && npm ci`.
- MySQL 8 and Qdrant running.
- `app/.env.local` configured with the role-specific MySQL credentials, `QDRANT_URL` and embedding settings.
- A MySQL administrator account able to create/drop the isolated evaluation databases and grant privileges. The password is entered at the MySQL prompt and is not stored by these scripts.
- Internet access on the first real embedding-model load.

## macOS / Linux (Bash or Zsh)

Run these commands from the repository root. They are the shell equivalents of the Windows sequence below; the archive's benchmark runs were performed on Windows, so this platform-specific procedure should be executed and checked on the target Mac/Linux machine before claiming platform verification.

### 0. Install app dependencies and check unit tests

```bash
cd app
npm ci
cd ..
node evaluation/scripts/test.mjs
```

Expected unit-test evidence from the committed run is saved in `evaluation/results/verification/unit-tests.txt`.

### 1. Generate the deterministic dataset (optional if committed files are unchanged)

```bash
node evaluation/scripts/generate.mjs
```

### 2. Create and import the isolated MySQL evaluation database

```bash
node evaluation/scripts/sql.mjs --size 500
mysql -u root -p < evaluation/tmp/eval_setup_500.sql
```

The SQL file is generated at `evaluation/tmp/eval_setup_500.sql`. It is safe only for the isolated evaluation database name. Repeat with `--size 2000` and `eval_setup_2000.sql` for the larger test.

### 3. Load the synthetic records

```bash
node --env-file=app/.env.local evaluation/scripts/load.mjs --size 500
```

The loader uses the existing `sp_create_case` and `sp_register_evidence` procedures as the seeded non-login `eval_admin`; triggers enqueue the records for indexing.

### 4. Index into the isolated Qdrant collection

```bash
node --env-file=app/.env.local evaluation/scripts/index.mjs --size 500
```

It drains the existing outbox worker and verifies the indexed-version and Qdrant point counts. Repeat steps 2–4 using `--size 2000`.

### 5. Run keyword/vector/hybrid retrieval comparison

```bash
node --env-file=app/.env.local evaluation/scripts/run.mjs --size 500
node --env-file=app/.env.local evaluation/scripts/run.mjs --size 2000
```

Each run writes raw JSON plus per-query and summary CSV files under `evaluation/results/`.

### 6. Generate the report and SVG graphs

```bash
node evaluation/scripts/report.mjs
```

Outputs include `evaluation/results/REPORT.md` and `evaluation/results/charts/*.svg`.

### 7. Optional fresh-process cold-start probes

```bash
node evaluation/scripts/cold.mjs --size 500
node evaluation/scripts/cold.mjs --size 2000
node evaluation/scripts/report.mjs
```

These probe the first search in a new Node process; MySQL/Qdrant server and OS caches are not cleared.

### 8. Optional live integration tests

```bash
node evaluation/scripts/test.mjs --live
EVAL_TEST_SIZE=2000 node evaluation/scripts/test.mjs --live
```

These require the corresponding isolated database and Qdrant collection to have been created, populated and indexed first.

### 9. Clean up evaluation resources only

```bash
node evaluation/scripts/sql.mjs --cleanup
mysql -u root -p < evaluation/tmp/eval_cleanup.sql
node --env-file=app/.env.local evaluation/scripts/clean-qdrant.mjs --all --yes
```

The SQL cleanup drops only `tracex_eval_500` and `tracex_eval_2000`; the Qdrant cleanup script refuses other collection names. It does not remove the development database or its collection.

## Windows PowerShell

The committed benchmark was recorded on Windows with Node.js v22.19.0, Docker-hosted MySQL 8.0.46 and Qdrant. From the repository root:

```powershell
cd app
npm ci
cd ..
node evaluation/scripts/test.mjs
node evaluation/scripts/generate.mjs
node evaluation/scripts/sql.mjs --size 500
cmd /c "mysql -u root -p < evaluation\tmp\eval_setup_500.sql"
node --env-file=app/.env.local evaluation/scripts/load.mjs --size 500
node --env-file=app/.env.local evaluation/scripts/index.mjs --size 500
node --env-file=app/.env.local evaluation/scripts/run.mjs --size 500
```

Repeat database setup/load/index/run for size 2000. Then run:

```powershell
node evaluation/scripts/report.mjs
node evaluation/scripts/test.mjs --live
```

## Experiment design and interpretation

- The records, queries and graded relevance labels are synthetic. Labels are derived from pre-defined event-group membership, not from search output.
- Keyword uses MySQL InnoDB FULLTEXT natural-language mode. Vector-only uses the existing BGE-small → Qdrant → MySQL re-validation path. Hybrid fuses top-50 lists using RRF.
- Metrics include Precision@10, Recall@10, F1@10, MRR, MAP and NDCG@10, with paired bootstrap confidence intervals. Latency includes warm mean/median/p95 and separate first-call-in-process numbers.
- In the committed runs, vector-only led hybrid on Precision@10, Recall@10, F1@10, MAP and NDCG@10 at both sizes. Hybrid was not universally superior.
- The benchmark uses a synthetic dataset and 40 queries written by one author; results do not generalize to real forensic casework. Keyword and hybrid are run with an evaluation administrator because FULLTEXT cannot use the filtered investigator views. Only evidence records are included in this benchmark; the application worker supports finding indexing, but findings are outside this experiment's dataset.

The report and raw artifacts are under `evaluation/results/`. Archived test evidence is under `evaluation/results/verification/`.
