# Person A independent workstream

This work is intentionally isolated from Person B's Qdrant, embedding, indexing-worker and retrieval implementation.

## Added deliverables

- `database/07_demo.sql`: read-only MySQL classroom walkthrough.
- `database/08_verify_database.sql`: read-only schema, routine, trigger, view, seed and grant verification report.
- `app/src/app/(workspace)/demo-preview/page.js`: authenticated UI preview route.
- `app/src/components/demo/DemoWorkspace.js`: standalone case/evidence/custody/audit UI using local mock data only.

## Run the UI preview

From the app directory, install dependencies if needed and start the Next.js development server:

```bash
npm install
npm run dev
```

Sign in using the configured demo account and open:

```
http://localhost:3000/demo-preview
```

The preview is intentionally not connected to API routes, MySQL or Qdrant. It does not change Person B's contracts or worker/retrieval files. It provides a place to review layout and interactions before the team connects real data.

## MySQL verification workflow

Use a disposable local MySQL 8.0.16+ instance. Do not run the destructive `01_schema.sql` reset against a shared or valuable database.

```sql
source database/01_schema.sql
source database/02_access.sql
source database/03_routines.sql
source data/out/seed_demo.sql
source database/08_verify_database.sql
source database/07_demo.sql
```

Then run `database/05_queries.sql` for query examples and `database/04_dml.sql` separately for state-changing demonstrations.

## RBAC manual test

1. Connect as an administrator and run `SET @tracex_user_id = 1;`.
2. Connect separately as `tracex_investigator_app`.
3. Set `@tracex_user_id = 3;`.
4. Confirm investigator reads through `v_my_cases`, `v_my_evidence` and other permitted `v_my_*` views return only assigned-case data.
5. Confirm direct reads such as `SELECT * FROM app_user;` and `SELECT * FROM custody_event;` are denied.
6. Save actual terminal output and record the MySQL server version.

## Test status

The SQL scripts and UI preview are committed as implementation artifacts. They have not been executed against a live MySQL instance or browser in the contributor's environment by this commit. Mark them verified only after running the steps above and recording actual output. The UI mock data is illustrative, not a substitute for live API integration.
