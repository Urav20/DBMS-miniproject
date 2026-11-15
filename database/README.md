# database/

| File | Purpose |
|---|---|
| `01_schema.sql` | Drops/recreates `tracex`; creates 15 tables, constraints and indexes |
| `02_access.sql` | Session helper, filtered investigator views, MySQL roles/grants and three application accounts |
| `03_routines.sql` | Functions, triggers, stored procedures, extra views and procedure grants |
| `04_dml.sql` | Allowed and intentionally rejected state-changing DML examples |
| `05_queries.sql` | Joins, nested/correlated queries, window functions, recursive CTE and FULLTEXT |
| `06_verify_access.sql` | Investigator view/privilege and indexing-outbox checks |
| `07_demo.sql` | Read-only classroom walkthrough of relational data and provenance |
| `08_verify_database.sql` | Read-only verification of schema objects, seed counts, view columns and grants |

## Load order

For a fresh, disposable MySQL 8.0.16+ database, from repository root:

```bash
mysql -u root -p < database/01_schema.sql
mysql -u root -p < database/02_access.sql
mysql -u root -p < database/03_routines.sql
mysql -u root -p < data/out/seed_demo.sql
```

**Destructive warning:** `01_schema.sql` begins with `DROP DATABASE IF EXISTS tracex`. It permanently removes an existing database named `tracex`. Never run it against the user's working database unless that database is disposable and backed up.

`02_access.sql` creates role-specific accounts using placeholder passwords. Change the passwords in MySQL and configure the same values in `app/.env.local`; do not put real credentials in Git.

### Upgrade an existing database after pulling code changes

If your local database predates the latest retrieval/workspace SQL, re-apply both the access/view/grant definitions and the stored routines:

```bash
mysql -u root -p < database/02_access.sql
mysql -u root -p < database/03_routines.sql
```

`02_access.sql` refreshes the investigator-filtered views (including `content_version`) and worker permissions (including `SELECT ON analysis`). `03_routines.sql` recreates the current procedures, triggers, extra views and grants, including `sp_update_evidence_metadata`. These scripts do not drop the `tracex` database or its tables/data. Afterward, use the Administrator workspace's **Queue missing or stale records** action if the existing vector index needs backfilling, and keep one standalone worker running. Do **not** re-run `01_schema.sql` for an ordinary application update. Back up your database before any schema-maintenance work.

## Demonstration sequence

Open a MySQL CLI session and run:

```sql
source database/08_verify_database.sql
source database/07_demo.sql
source database/05_queries.sql
```

Run `database/04_dml.sql` separately because it deliberately modifies demonstration data and includes operations expected to be rejected. For the investigator privilege check, connect as `tracex_investigator_app`, set `@tracex_user_id` to an active investigator ID and show that filtered-view reads work while direct reads of `app_user` and `custody_event` are denied.

## Verification evidence

The repository contains static SQL contracts and live integration tests for several app/database paths. The team should still run `08_verify_database.sql`, `07_demo.sql`, `05_queries.sql`, `04_dml.sql` and the separate investigator privilege check on the actual presentation database, then save the terminal output/screenshots. A verification script existing in Git does not imply that its output has been captured on the target machine.
