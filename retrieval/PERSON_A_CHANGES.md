# Person A SQL changes — implemented on Person-A

The three SQL requirements identified during the Person B Phase 3 review are implemented in
`database/02_access.sql`:

1. `v_my_evidence` exposes `e.content_version`.
2. `v_my_findings` exposes `f.content_version`.
3. `tracex_worker` has `SELECT` on `tracex.analysis`, needed to resolve
   `finding.analysis_id -> analysis.evidence_id -> evidence.case_id` while building finding vectors.

The semantic retrieval repository now selects the version columns from the investigator views.
It uses MySQL's authoritative versions to discard stale Qdrant evidence and finding candidates.
The investigator continues to read only filtered `v_my_*` views; no base-table permission was added.

## Applying to an existing database

After deploying the updated access/views SQL, an administrator should run:

```sql
CALL sp_backfill_index_jobs();
```

This queues fresh upsert jobs for active records whose indexed version is missing or stale,
including finding jobs that previously failed because the worker could not read `analysis`.

## Verification commands

```sh
cd app
npm run test:retrieval
npm run test:indexing
npm run test:retrieval:live
npm run test:indexing:live
```

Unit and SQL-contract tests do not require live services. Live tests require the configured
MySQL schema/accounts and Qdrant service. Do not report live integration as passed until run
successfully in that environment.
