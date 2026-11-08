# worker/ — indexing worker (Person B, Phase 2)

Keeps Qdrant in step with MySQL. It reads the `index_job` outbox, loads the record from MySQL,
embeds it with BGE-small, and writes (or deletes) the matching Qdrant point.

MySQL stays the source of truth. Qdrant only receives the vector and the minimal payload
(`kind, record_id, evidence_id, case_id, content_version`). No text, titles, names, permissions
or provenance are ever written to Qdrant.

The code lives in `app/src/lib/indexing/` (same pattern as `app/src/lib/vector/`: one copy, one
`node_modules`). `worker/run.mjs` is only the entry point.

```
app/src/lib/indexing/
  config.js       WORKER_* settings
  errors.js       failure classes (permanent / transient / outage), safe last_error text
  repository.js   the ONLY file with SQL; uses lib/db with { role: "worker", userId: null }
  processor.js    decides and performs one batch (idempotent reconcile logic)
  runner.js       polling loop, crash recovery, back-off
  index.js        createDefaultWorker()
worker/run.mjs    entry point
app/tests/indexing/indexing.unit.test.mjs      unit tests (fakes, no services)
app/tests/indexing/sql-contract.unit.test.mjs  reads database/*.sql as text and checks repository.js against it
app/tests/indexing/live.test.mjs               Qdrant integration + MySQL contract probes (need services)
```

## Setup

1. MySQL: create the database and accounts from Person A's `database/` scripts (`01_schema.sql`,
   `02_access.sql`, `03_routines.sql`). The worker uses the **`tracex_worker_app`** account
   (`DB_WORKER_USER` / `DB_WORKER_PASSWORD`). It must be a different account from the admin and
   investigator ones (the db layer refuses otherwise).
2. Qdrant: `docker run -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant`
3. `cd app && npm ci` (Linux x64: `ONNXRUNTIME_NODE_INSTALL=skip npm ci` if nuget.org is blocked).
4. `cp ../.env.example .env.local` (PowerShell: `Copy-Item ..\.env.example .env.local`) and fill in the
   real values. Worker options are the optional `WORKER_*` lines.
5. `npm run vector:setup` (the worker also runs the same non-destructive check on start).
6. The first embedding downloads the model (~130 MB) into the Transformers.js cache.

## Run

```
cd app
npm run worker         # runs until Ctrl+C / SIGTERM; finishes the current batch first
npm run worker:once    # drains the queue once, then exits (0 ok, 1 some jobs failed, 2 dependency down)
```

**Run exactly one worker process.** `index_job` has no claim token or lease column (see
"Concurrency"). On start the worker warns if its MySQL account cannot read `analysis` (see B1).

## What a job does

A job is a *hint to reconcile one record*. The decision comes from the record's current MySQL state.

| Situation | Result |
|---|---|
| `upsert`, evidence active, job version = row version | embed `title + description + extracted_text` (finding: `title + description`), upsert point `UUIDv5("kind:id")`, set `indexed_version`/`indexed_at`, job `done` |
| `upsert`, job version < row version | skipped, job `done` (a newer job exists) |
| `upsert`, job version > row version | job `failed` (`INDEX_VERSION_MISMATCH`): inconsistent data is not indexed |
| `upsert`, evidence withdrawn (or finding's evidence withdrawn) | point deleted instead, no embedding, job `done` |
| `delete`, evidence withdrawn / finding | point deleted (already missing is fine), job `done` |
| `delete`, but MySQL says evidence is active | ignored, job `done` with a `skipped:` note (MySQL wins) |
| several jobs for one record in a batch | only the newest does the work; the older ones are closed as duplicates **after** the newest one succeeded, otherwise handed back to `pending` without using an attempt |
| source row missing, no text, job names 0 or 2 targets | job `failed` immediately |
| finding upsert while the worker cannot read `analysis` | job `failed` (`INDEX_FINDING_ACCESS_MISSING`), see B1 |

Idempotency: the point ID is deterministic, so repeating a job overwrites the same point; deleting a
missing point is a no-op. Write order is Qdrant, then `indexed_version`, then job `done`: a job is
closed only after both the Qdrant write and the MySQL bookkeeping succeeded, and a crash between
steps only causes a harmless repeat. `indexed_version` never moves backwards.

Withdrawal: `trg_evidence_au` queues a `delete` job for the evidence **and one for each of its
findings** in the same statement. The worker deletes those points. Finding delete jobs need no read of
the finding row, so they work today.

### Retries and failures

- **Transient** (one bad embedding, Qdrant 5xx, bookkeeping write failed): job returns to `pending`
  and the attempt stays counted. The loop then waits `base × 2^(attempts-1)` ms (cap
  `WORKER_BACKOFF_MAX_MS`) before claiming again, so the attempts of one job are not used up within
  seconds (there is no "retry after" column, so this delay is per batch and in memory). After
  `WORKER_MAX_ATTEMPTS` (default 5) the job becomes `failed`.
- **Outage** (Qdrant/MySQL unreachable, bad credentials, model cannot load): the job returns to
  `pending` **without** using an attempt and the worker waits `base × 2ⁿ` ms (cap
  `WORKER_BACKOFF_MAX_MS`), so a Qdrant restart does not push the whole queue to `failed`.
- **Permanent**: `failed` at once.
- `last_error` holds only `[CODE] safe message` (max 500 chars): never SQL, URLs, keys or document text.
- A failed read affects only the jobs that needed it: an unreadable finding no longer fails or stalls
  the evidence jobs of the same batch.

### Crash recovery

Claiming a job adds 1 to `attempts`, so a job that keeps killing the process runs out of attempts.
On start (`WORKER_RECOVER_ON_START=true`, default) and after any batch whose result could not be
recorded or that met an outage, rows left in `processing` are requeued; rows already at the attempt
limit become `failed`. This is only correct with ONE worker: with no lease column the worker cannot
tell a dead run's `processing` rows from another live worker's.

To re-run `failed` upsert jobs after fixing the cause, an administrator calls `sp_backfill_index_jobs()`
(it queues a fresh upsert for every active record whose `indexed_version` is missing or stale, and only
treats `pending`/`processing` jobs as "already queued"). It does **not** requeue failed `delete` jobs.

## Concurrency

`index_job` has **no** claim-token, lease, `claimed_at` or `next_attempt_at` column (checked in
`01_schema.sql`), so a lease cannot be built in the worker. So:

- **Fixed: claim race.** The old claim ran one `UPDATE ... WHERE status='pending' LIMIT n` and then
  `SELECT ... WHERE status='processing'`. That read-back returned *every* `processing` row (leftovers
  of a crashed run when recovery is off, rows whose result was not recorded, another process's jobs),
  which were then processed without a new attempt, defeating the attempt limit and the batch size.
  `claimPending()` now lists candidate ids, claims each with its own compare-and-set
  `UPDATE ... WHERE job_id = ? AND status = 'pending'` (`affectedRows = 1` means this call changed it),
  and reads back only the ids it claimed.
- **Not fixed, cannot be without a SQL change: multi-process safety.** Even with an exact claim, two
  workers could embed two versions of the same record at the same time and the older one could
  overwrite the newer point in Qdrant; recovery would take over the other worker's live jobs; a
  `delete` could race an in-flight `upsert`. The worker is therefore **single-process by design** and
  the README, `run.mjs` and `.env.example` say so. A multi-worker design needs a lease column
  (`claimed_at` / `claim_token`) from Person A, or an advisory lock held on a dedicated connection
  (the db layer does not expose one). Nothing here enforces "one worker": it is an operating rule.

## SQL verification (against the real `database/` files)

Checked by reading `01_schema.sql`, `02_access.sql`, `03_routines.sql`, and enforced by
`tests/indexing/sql-contract.unit.test.mjs` (which skips itself when the files are not found).

| Check | Result |
|---|---|
| Every table/column in `repository.js` exists | yes: `index_job` (job_id, evidence_id, finding_id, operation, content_version, status, attempts, last_error, processed_at), `evidence` (evidence_id, case_id, title, description, extracted_text, status, content_version, indexed_version, indexed_at), `finding` (finding_id, analysis_id, title, description, content_version, indexed_version, indexed_at), `analysis` (analysis_id, evidence_id) |
| `finding` has `case_id`/`evidence_id` | **no**: they are reached through `analysis` (the JOIN in `fetchFindings` is the only way) |
| `index_job.status` values | `pending, processing, done, failed` (exactly what the worker uses); `operation`: `upsert, delete` |
| Transitions the worker makes | `pending→processing` (claim, attempts+1), `processing→done`, `processing→failed`, `processing→pending` (retry/outage/recovery). Nothing leaves `done`/`failed` |
| `attempts` | `TINYINT UNSIGNED` (max 255); `WORKER_MAX_ATTEMPTS` is capped at 20 |
| `tracex_worker` on `index_job` | SELECT, INSERT, UPDATE: enough |
| `tracex_worker` on `evidence`, `finding` | SELECT + UPDATE(indexed_version, indexed_at) only: enough for `markIndexed` |
| `tracex_worker` on `analysis` | **no privilege** → B1 |
| `indexed_version` update vs triggers | `trg_*_bu` bump `content_version` only when title/description(/extracted_text) change; `trg_*_au` queue a job only when `content_version` changes. `markIndexed` sets only `indexed_version, indexed_at`: no version bump, no new job |
| `ck_*_indexed_version` (`indexed_version <= content_version`) | holds: the worker writes the version it read and never moves backwards |
| Withdrawal | `trg_evidence_au` queues `delete` for the evidence and for each of its findings; withdrawn evidence cannot be reactivated (`trg_evidence_bu`) |

## Tests

```
cd app
npm run test:indexing        # unit tests + SQL-contract tests, no services needed
npm run test:vector          # existing suite, unchanged
npm run test:db              # existing suite, unchanged
npm run test:auth            # existing suite, unchanged
npm run test:indexing:live   # needs Qdrant (part 1) and MySQL + schema (part 2); skipped otherwise
```

- `indexing.unit.test.mjs`: processor, runner, repository SQL text, config, errors. All fakes.
- `sql-contract.unit.test.mjs`: reads `<repo>/database/*.sql` (or `TRACEX_DATABASE_DIR`) as text; **skipped,
  not passed,** if they are missing. One test is `todo` on purpose: "worker can SELECT analysis" fails
  until Person A adds the grant; a `todo` failure is reported but does not fail the run.
- `live.test.mjs`: part 1 runs the processor against real Qdrant in a throwaway collection; part 2 sends
  statements that change nothing (`... WHERE 1 = 0`) to prove, on the real MySQL, that each table, column
  and privilege exists for `tracex_worker_app`, and that least privilege holds (no other tables, no DELETE,
  no UPDATE of content columns). The `analysis` probe is also `todo`.

Neither of these has been run against a live MySQL, Qdrant or the real BGE model yet; see "Not verified".

## Blockers and limitations (nothing is invented around them)

**B1. The worker cannot resolve a finding's evidence and case (needs a SQL change by Person A).**
`02_access.sql` gives `tracex_worker` no privilege on `analysis`, but `finding` only holds `analysis_id`.
Without it the worker cannot build the Qdrant payload (`evidence_id`, `case_id`) of a finding, nor see
that a finding's evidence is withdrawn. Until fixed: finding **upsert** jobs end as `failed`
(`INDEX_FINDING_ACCESS_MISSING`) without affecting anything else; evidence jobs and finding **delete**
jobs work. Fix (Person A, one line): `GRANT SELECT ON tracex.analysis TO 'tracex_worker';`. Afterwards an
administrator runs `sp_backfill_index_jobs()` to requeue the failed finding upserts. No view or procedure
was invented, and the worker does not borrow the admin account.

**B2. Single worker only.** See "Concurrency". Needs a lease column to change.

**B3. `failed` is terminal for the worker.** Failed upserts can be requeued with `sp_backfill_index_jobs()`;
failed `delete` jobs cannot (the procedure only looks at active records). A failed delete would leave the
vector of a withdrawn record in Qdrant. Retrieval must therefore re-check status/permissions in MySQL
(per the design); this was not verified here. Delete jobs only fail after the full attempt limit of
non-outage errors, which is rare.

**B4. `indexed_version` is not cleared on withdrawal.** The worker deletes the point but leaves
`indexed_version`/`indexed_at` as they were. `sp_backfill_index_jobs()` only looks at active records,
so this causes no re-queueing. Clearing it would be allowed by the column grant and the CHECK; left as is
to keep the change small.

**B5. Findings added to withdrawn evidence.** `sp_add_finding` does not check the evidence status, so such
a finding gets an upsert job. Once B1 is fixed the worker sees `evidence_status = 'withdrawn'` and deletes
instead of indexing.

**B6. The db layer's behaviour is assumed from existing code.** `claimPending` needs `query()` to return
`affectedRows` for UPDATEs (already relied on by `recoverInterrupted`); if it does not, claiming throws
`INDEX_DB_RESULT` instead of idling. The mapping of MySQL privilege errors 1142/1143 to
`DB_PERMISSION_DENIED` is also taken from the names in `errors.js`; `repository.js` additionally checks
`errno` 1142/1143 on the error or its cause. Part 2 of the live test confirms both.

**Not verified in this environment:** nothing was run against real MySQL, real Qdrant or the real BGE
model. Unit tests used fakes; the db and vector Phase 1 modules were stand-ins outside the delivered
files. Run `npm run test:indexing` and `npm run test:indexing:live` in the real repository.
