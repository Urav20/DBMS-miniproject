# database/

| File | What it does |
|---|---|
| `01_schema.sql` | Drops and recreates the `tracex` database: 15 tables, constraints, indexes |
| `02_access.sql` | Session function, investigator-filtered views, MySQL roles, grants and three application accounts |
| `06_verify_access.sql` | Post-load checks for the three investigator views, grants and the expected 130 indexing jobs |

## Run (MySQL 8.0.16 or newer)

```bash
mysql -u root -p < database/01_schema.sql
mysql -u root -p < database/02_access.sql
```

`01_schema.sql` deletes any existing `tracex` database first. Do not run it on data you want to keep.

## Quick check

```sql
USE tracex;
SHOW TABLES;                        -- 15 tables plus 12 views
SELECT TABLE_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = 'tracex' AND REFERENCED_TABLE_NAME IS NOT NULL;   -- 25 foreign keys
SHOW GRANTS FOR 'tracex_investigator_app'@'localhost' USING 'tracex_investigator';
SHOW GRANTS FOR 'tracex_investigator'@'%';
```

## Account passwords

`02_access.sql` creates three accounts with placeholder passwords (`change_me_*`). Change them and keep the real values only in your local `.env`.

## Status

Written and statically cross-checked (all 25 foreign keys reference existing columns of matching type and a unique key; no foreign key breaks MySQL's CHECK rule). Run `06_verify_access.sql` after loading the schema, routines and seed to check the investigator views and the expected 130 `index_job` rows. The SQL has not yet been executed on a live MySQL server in this environment.


## Step 4 files
- `03_routines.sql`: functions (`fn_actor`, `fn_is_admin`, ...), triggers (version bump and outbox, same-case links, append-only tables, immutable hash), extra views, stored procedures (`sp_*`) and EXECUTE grants. Run after 02.
- `04_dml.sql`: INSERT/UPDATE/DELETE demo through the procedures, with a section of statements that must be rejected (uses the helper `demo_try`). Changes data; reset by re-running 01, 02, 03 and the seed.
- `05_queries.sql`: joins, nested and correlated subqueries, window functions, recursive CTEs, full-text search.

Full load order: `source database/01_schema.sql`, `02_access.sql`, `03_routines.sql`, `source data/out/seed_demo.sql`.
The seed loaded after 03 also fills `index_job` (one upsert per active evidence and per finding).
If you loaded the seed first, run as admin: `SET @tracex_user_id = 1; CALL sp_backfill_index_jobs();`


## Verify the merged database/API contract

After loading the schema, access views, routines and generated seed in that order, run:

```sql
source database/06_verify_access.sql
```

The script reports whether all three investigator views exist, displays their columns and the investigator role grants, compares visible evidence with visible current-custody rows, and checks that `index_job` contains 130 rows (57 active evidence items + 73 findings).

For a real privilege test, connect separately as `tracex_investigator_app`, set `@tracex_user_id` to an active investigator ID (for example, 3), and run the four `SELECT` statements against `v_my_current_custody`, `v_my_users`, and `v_my_teammates`. A direct `SELECT` from `app_user` or `custody_event` must be denied.
