# TRACE-X: Evaluation Rubric Map (50 marks)

Status key: **Implemented** = code/design artifact exists; **Partially implemented** = some required user workflow is present but material items remain; **Verification pending** = the team must run and retain actual output/screenshots. A file existing does not by itself prove a live demonstration.

| # | Rubric component | Marks | TRACE-X evidence | Current status |
|---|---|---:|---|---|
| 1 | ER diagram | 2 | Four Chen diagrams under `docs/design/er/` | Implemented; team should include diagrams in the final report |
| 2 | Relational schema with keys, relationships and constraints | 3 | `docs/design/TRACE-X_Phase2_Design.md`; 15-table MySQL schema | Implemented; final report walkthrough pending |
| 3 | SQL DDL and constraints | 4 | `database/01_schema.sql` | Implemented; retain `08_verify_database.sql` output from the presentation database |
| 4 | NoSQL/vector database creation | 4 | Qdrant collection setup, 384-dimensional cosine vectors and payload indexes | Implemented; show live collection health and point count |
| 5 | Technology justification | 1 | `docs/TECHNOLOGY_JUSTIFICATION.md` and the Phase 2 design | Implemented as a written rationale; include the key MySQL/Qdrant trade-offs in the final report |
| 6 | DML operations | 4 | `database/04_dml.sql` includes permitted and rejected operations | Implemented in SQL; execute and retain demonstration output |
| 7 | Joins, nested/correlated queries and recursive CTE | 4 | `database/05_queries.sql` | Implemented in SQL; execute and retain demonstration output |
| 8 | Procedures, functions, triggers and CTE | 6 | `database/03_routines.sql` and query showcase | Implemented in SQL; execute and retain verification output |
| 9 | Vector Read/Update/Delete | 7 | Semantic search reads; `sp_update_evidence_metadata` / `sp_update_evidence_text` queue re-embedding; `sp_withdraw_evidence` queues vector deletion; admin point inspection and backfill queue control | Implemented in code; live-test the database procedure, worker and Qdrant changes and capture UI evidence before marking demonstrated |
| 10 | Next.js interface | 3 | Login, live dashboard, case creation/status/assignment controls, evidence metadata registration and detail, custody timeline/transfer, analysis/findings, relationships, semantic search, reports/audit and administration pages | Partially implemented; original binary file upload/storage is not present in the schema, and final UI walkthrough/screenshots remain to be captured |
| 11 | Backend/API and database integration | 2 | Auth/search/health APIs and stored-procedure-backed routes for case, assignment, evidence, custody, analysis, findings and relationships | Implemented in code; apply updated `02_access.sql` and `03_routines.sql`, then verify every write against live MySQL/Qdrant |
| 12 | Authentication and authorization / database RBAC | 4 | Signed sessions, role-specific pools, MySQL roles/grants and investigator-filtered views | Implemented in code; retain a fresh live test showing investigator view access and base-table denial |
| 13 | Documentation and Git/GitHub | 2 | README, setup guide, API contract, design/rubric docs and PR history | Partially implemented; final report and reproducible presentation evidence remain |
| 14 | Originality, individual contribution and viva | 4 | Provenance-aware relational/vector architecture, worker and Phase 4 evaluation; two-person commit/PR history | Ongoing; both members should be able to explain and modify their own contributions |

## Remaining implementation and verification scope

The main database-backed case/evidence workflows now have UI entry points. The schema records evidence metadata, SHA-256, file size and extracted text, but it does not store original binary files; adding true file upload would require a separately designed storage layer and a trusted file-to-record workflow. The current registration form is therefore metadata/text registration, not a binary upload.

The remaining work is primarily live verification and deliverables: apply the current `02_access.sql` and `03_routines.sql` to the presentation database; use the administrator backfill control if vectors are missing/stale; run live MySQL/Qdrant/browser tests for each role; capture the write workflows and vector deletion/re-index behavior; and complete the final report/screenshots. The app intentionally does not equate semantic similarity with a verified relationship. A human analyst must record a relationship through the database procedure and supply a rationale.

## Database demonstration order

On a disposable MySQL database, load in this order:

1. `database/01_schema.sql`
2. `database/02_access.sql`
3. `database/03_routines.sql`
4. `data/out/seed_demo.sql`

Then run:

1. `database/08_verify_database.sql` — expected object and seed checks.
2. `database/07_demo.sql` — read-only classroom walkthrough.
3. `database/05_queries.sql` — query showcase.
4. `database/04_dml.sql` — state-changing DML demonstrations (separate from the read-only walkthrough).
5. Connect as `tracex_investigator_app`; confirm allowed filtered-view reads work and direct `SELECT` from `app_user` and `custody_event` is denied.

Record real output and resolve any failed checks before using the word “verified” in the final report.

## Phase 4 evaluation

The Phase 4 report compares keyword, vector-only and RRF-hybrid retrieval on synthetic 500- and 2,000-record corpora. In the committed experiment, vector-only led on Precision@10, Recall@10, F1@10, MAP and NDCG@10. Hybrid was not universally better. The results support a reproducible comparison; they do not show effectiveness on real forensic evidence.
