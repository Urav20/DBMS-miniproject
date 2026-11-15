# TRACE-X presentation evidence checklist

Use this checklist on the final presentation Mac after syncing the latest `main`. It is designed to produce the screenshots and terminal output needed for the report and viva. Do not mark a check complete until you have captured the actual result.

## A. Before running anything

- [ ] Pull the final `main` branch and confirm `git status` is clean.
- [ ] Confirm Docker Desktop, MySQL and Qdrant are running.
- [ ] Confirm `app/.env.local` contains the current local database passwords, Qdrant URL, collection name and session secret. Never commit or screenshot the secrets.
- [ ] Confirm the demo schema/seed data exists.
- [ ] For an existing database created before the recent view/routine changes, refresh only the access and routine definitions:

```bash
mysql -u root -p < database/02_access.sql
mysql -u root -p < database/03_routines.sql
```

**Important:** Do not run `database/01_schema.sql` on the working presentation database. It starts by dropping and recreating `tracex`. If vectors are missing or stale after the SQL update, sign in as an administrator, use **Administration → Queue missing or stale records**, and let the single background worker process the jobs.

## B. Terminal verification

From the repository root, save terminal output for:

- [ ] `mysql -u root -p < database/08_verify_database.sql` — schema objects, views, grants and seed checks.
- [ ] `mysql -u root -p < database/07_demo.sql` — read-only database walkthrough.
- [ ] `mysql -u root -p < database/05_queries.sql` — joins, subqueries, recursive CTE and FULLTEXT query examples.
- [ ] `mysql -u root -p < database/04_dml.sql` — DML demonstration. Run separately because it intentionally changes demo data and includes rejected-operation examples.
- [ ] Connect as the investigator application account and run `database/06_verify_access.sql`; show filtered-view access succeeds while restricted base-table reads are denied.

From `app/`, save:

```bash
npm run test:db
npm run test:auth
npm run test:vector
npm run test:indexing
npm run test:retrieval
npm run test:workspace
npm run build
npm run test:db:live
npm run test:auth:live
npm run test:retrieval:live
npm run test:indexing:live
npm run test:vector:live
```

The `*:live` tests contact real services. Keep their output separate from the unit-test output.

## C. Start the live application

Open two terminals in `app/`.

Terminal 1 — start exactly one indexing worker:

```bash
npm run worker
```

Terminal 2 — start the Next.js app:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## D. Screenshots to capture

Save screenshots without exposing passwords, session cookies, database credentials or personal information beyond the fictional demo records.

1. [ ] Login page.
2. [ ] Investigator dashboard with live MySQL/Qdrant connection status.
3. [ ] Investigator case list showing only assigned cases.
4. [ ] Case detail showing case metadata, evidence and chain-of-custody timeline.
5. [ ] Evidence list and one evidence detail page showing collection metadata, hash/version information and extracted text.
6. [ ] Evidence registration form and success message for a safe demo record.
7. [ ] Custody transfer form and the updated timeline, using two users assigned to the same open case.
8. [ ] Analysis start/completion and a recorded finding.
9. [ ] Human-recorded evidence relationship with its written rationale.
10. [ ] Semantic search query and results. Explain that similarity is a lead, not proof.
11. [ ] Admin audit/report page.
12. [ ] Admin Qdrant point lookup showing point ID/payload metadata.
13. [ ] Admin queue/backfill action and indexing-worker output.
14. [ ] Evidence withdrawal followed by worker output showing deletion processing; confirm the withdrawn record remains in MySQL provenance but no longer appears in search.

If a demo workflow would change important seeded records, use a disposable duplicate database and Qdrant collection rather than damaging the presentation seed.

## E. Evaluation evidence

- [ ] Include the committed report at `evaluation/results/REPORT.md`.
- [ ] Include the SVG charts under `evaluation/results/charts/`.
- [ ] Clearly state that the evaluation uses synthetic data and that vector-only led the tested hybrid configuration on Precision@10, Recall@10, F1@10, MAP and NDCG@10.
- [ ] Do not claim the benchmark proves performance on real forensic evidence.
- [ ] Do not describe the experiment as evaluating findings; the experiment corpus contains evidence records only.

## F. Final report completion

- [ ] Add the actual dates and outputs to Section 14 of `docs/FINAL_PROJECT_REPORT.md`.
- [ ] Insert the captured screenshots with numbered captions.
- [ ] Verify the team names/SRNs and course/institution details.
- [ ] Export the final report to the required submission format.
- [ ] Both team members can explain the ER model, 3NF rationale, RBAC, outbox worker, content-version stale check, semantic search and the benchmark's result/limitations.

## G. Important operational rules

- Use exactly one standalone indexing worker with the current schema.
- Do not directly delete Qdrant points from the browser; withdrawal is a MySQL stored procedure/outbox operation.
- Do not convert semantic similarity into a relationship automatically.
- Do not hard-delete evidence; use the withdrawal procedure.
- Do not run the destructive schema reset on the only presentation database.
