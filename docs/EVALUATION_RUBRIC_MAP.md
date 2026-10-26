# TRACE-X: Evaluation Rubric Map (50 marks)

Every implementation step is checked against this table. Status values: Designed, Not started, Done (update as work completes).

| # | Rubric component | Marks | What TRACE-X delivers | Status |
|---|---|---|---|---|
| 1 | ER diagram | 2 | Four Chen diagrams (`docs/design/er/`) | Designed |
| 2 | Relational schema with keys, relationships, constraints | 3 | Section 4 of `TRACE-X_Phase2_Design.md` (15 tables, PK/FK/UQ/CHECK/defaults, referential actions) | Designed |
| 3 | SQL implementation: DDL with constraints | 4 | `database/schema.sql` | Not started |
| 4 | NoSQL/Vector database creation | 4 | Qdrant collection `tracex_records` (384-d, cosine, payload indexes) created by a setup script | Designed |
| 5 | Technology justification | 1 | Report section: why MySQL + Qdrant, why bge-small, why modular monolith | Partly in design doc |
| 6 | DML operations | 4 | `database/dml.sql`: INSERT/UPDATE/DELETE with realistic cases (including a rejected invalid update) | Not started |
| 7 | Nested / correlated / recursive queries, joins | 4 | `database/queries.sql`: nested and correlated subqueries, multi-table joins, **recursive CTE** over `evidence_relationship` to walk linked evidence chains | Not started |
| 8 | Advanced SQL: procedure/function, trigger, CTE | 6 | `transfer_custody` and `register_evidence` procedures, outbox/version triggers, CTE queries (explicit in the report) | Designed |
| 9 | NoSQL/Vector feature, **RUD** | 7 | Semantic search (Read), re-embed on edit (Update), withdraw/delete a vector (Delete), all reachable from the UI and demonstrable on Qdrant | Designed; see gap A |
| 10 | Next.js interface | 3 | Login, dashboard, cases, evidence, provenance timeline, search, admin | Not started |
| 11 | Backend/API and database integration | 2 | Route Handlers calling MySQL and Qdrant for real | Not started |
| 12 | Authentication and authorization: two roles, **role-based access control in the database** | 4 | Login UI plus DB-level enforcement; see gap B | Partly designed |
| 13 | Documentation, Git/GitHub | 2 | README, design docs, meaningful commits from both members | In progress |
| 14 | Originality, individual contribution, modification/viva | 4 | Hybrid provenance-aware retrieval and evaluation; each member can explain and modify their own part | Ongoing |

## Gaps this rubric exposes, and the planned fixes

**A. Vector RUD must be visible.** The rubric scores Read, Update and Delete on the vector database as 7 marks. Plan: a "Vector index" admin view that shows a record's point, lets an admin re-embed it (Update), delete its point (Delete), and a search page (Read). Each action is also logged in `audit_log`.

**B. Role-based access control "in database".** The current design checks permissions only in application code. Add database-level enforcement: MySQL roles (`tracex_admin`, `tracex_investigator`) with `GRANT`s, access views such as `v_my_cases` / `v_my_evidence` that filter by the session user, and append-only protection on `custody_event` and `audit_log` (no UPDATE/DELETE grants). The application keeps its own checks as a second layer.

**C. Recursive queries.** Use `evidence_relationship` as a graph and demonstrate a recursive CTE (for example, all evidence reachable from one item within the same case, with depth and cycle protection).

**D. Individual contribution and viva.** Split work so each member owns identifiable pieces (schema and procedures vs. app and vector pipeline) and keeps commits under their own name. Each should be able to explain and modify their own part live.

## Scope reminder

The research evaluation (keyword vs vector vs hybrid) supports the originality mark but is not scored on its own, so it stays small and honest, and it must never block the scored items above.
