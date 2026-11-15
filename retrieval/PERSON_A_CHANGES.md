# Retrieval SQL prerequisites — current status on main

The three SQL changes identified during the Person B Phase 3 review are present in the current `main` branch in `database/02_access.sql`:

1. `v_my_evidence` exposes `e.content_version`.
2. `v_my_findings` exposes `f.content_version`.
3. `tracex_worker` has `SELECT` on `tracex.analysis`, required to resolve `finding.analysis_id -> analysis.evidence_id -> evidence.case_id` while indexing findings.

The retrieval repository reads the investigator version columns through the filtered views and discards stale Qdrant candidates for both investigator and administrator searches. The worker can resolve finding-to-case relationships when the updated grant is installed.

## Applying to an existing database

If your local database was created before these SQL changes, apply the updated access/view/grant definitions from the repository:

```bash
mysql -u root -p < database/02_access.sql
```

Then queue fresh upserts for active evidence/findings whose indexed version is missing or stale:

```sql
CALL sp_backfill_index_jobs();
```

The backfill procedure is administrator-only. It queues work; it does not run the worker. Keep exactly one standalone indexing worker process running to drain the queue.

## Verification commands

From `app/`:

```sh
npm run test:retrieval
npm run test:indexing
npm run test:retrieval:live
npm run test:indexing:live
```

Unit and SQL-contract tests do not require live services. Live tests require the configured MySQL schema/accounts and Qdrant service. Do not report live integration as passed until those commands complete successfully in the target environment.
