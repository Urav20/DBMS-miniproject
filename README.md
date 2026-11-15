# TRACE-X

**TRACE-X: A Provenance-Aware Hybrid Relational–Vector Database for Digital Evidence Provenance and Semantic Correlation**

A two-member DBMS semester project. TRACE-X stores authoritative case, evidence and provenance records in MySQL and uses Qdrant for semantic retrieval. Similarity results are investigative leads only: MySQL re-checks access, status and content version before any result is returned.

> **Project status (November 2026):** The relational schema, database roles/views, stored procedures/triggers, Qdrant integration, indexing worker, authentication, semantic retrieval API and Phase 4 evaluation are implemented. Case creation/status and assignment management, evidence metadata registration, custody transfer, analysis/finding entry and human-recorded relationship entry are now exposed through the workspace and call the existing MySQL stored procedures. Evidence update preserves the existing extracted text and queues re-indexing. The database stores metadata/hash/file size/extracted text; original binary file upload/storage is not implemented. Run the application checks in [SETUP.md](docs/SETUP.md) before treating the UI changes as verified.

## Architecture

| Component | Responsibility |
|---|---|
| MySQL | Source of truth for users, roles, cases, evidence, collection, custody, analysis, findings, relationships, audit events and indexing jobs |
| Qdrant | Stores 384-dimensional BGE-small vectors and minimal payload metadata for semantic candidate retrieval |
| Next.js (JavaScript) | Authentication, role-aware workspace and Route Handlers |
| Indexing worker | Consumes the MySQL outbox and upserts/deletes Qdrant points |

Investigators read through case-filtered `v_my_*` views and use stored procedures for permitted changes. The worker has a separate MySQL account. Qdrant metadata is never an authorization source.

## Main capabilities

- **Relational database:** 15 tables, keys, constraints, indexes, views, procedures, functions, triggers, recursive/query examples and a seed dataset.
- **Security:** Administrator and Investigator roles, separate application accounts, case-scoped views, append-only custody/audit history and signed sessions.
- **Vector pipeline:** Qdrant collection setup/health, local `BAAI/bge-small-en-v1.5` embeddings, deterministic point IDs, an outbox-driven worker, retry/recovery and stale-version validation.
- **Retrieval:** Authenticated semantic search with case scoping, evidence/finding kinds, over-fetch and MySQL re-validation.
- **Workspace:** Dashboard; case creation, status and assignment controls; evidence metadata registration and detail; custody timeline/transfer; analysis and findings; human-recorded evidence relationships; semantic search; audit report; and administrator vector inspection/re-index queue. Original binary file upload/storage is not implemented by the current schema; see [the rubric map](docs/EVALUATION_RUBRIC_MAP.md).
- **Evaluation:** Keyword, vector-only and RRF-hybrid retrieval compared on synthetic 500- and 2,000-record datasets.

## Quick setup

See **[docs/SETUP.md](docs/SETUP.md)** for complete macOS/Linux and Windows-oriented setup, database initialization, Qdrant, environment variables, worker and test commands.

The usual local prerequisites are Node.js 22+, MySQL 8.0.16+, Docker, and a running Qdrant instance. Copy `.env.example` to `app/.env.local`, replace every placeholder locally, and never commit real credentials. When upgrading an existing database created before the latest retrieval/workspace SQL, re-run `database/02_access.sql` and `database/03_routines.sql` to refresh the filtered views, worker grants and stored procedures. Do not re-run `01_schema.sql` on a database you need to preserve. After the SQL update, use the administrator re-index control if vectors are missing or stale.

## Run the application

From the repository root:

```bash
cd app
npm ci
npm run vector:setup
npm run vector:health
npm run dev
```

In a second terminal, from `app/`, run the worker:

```bash
npm run worker
```

Open `http://localhost:3000`. Demo accounts and the local demonstration password are documented in [data/README.md](data/README.md). Change placeholder MySQL account passwords to match the values in your local `app/.env.local`.

## Test

From `app/`:

```bash
npm run test:db
npm run test:auth
npm run test:vector
npm run test:indexing
npm run test:retrieval
npm run build
```

Live tests require the local MySQL/Qdrant environment. Phase 4 evaluation tests and its archived evidence are under `evaluation/`; see [evaluation/README.md](evaluation/README.md).

## Phase 4 results and limitations

The [benchmark report](evaluation/results/REPORT.md) compares keyword, vector-only and hybrid retrieval on synthetic data. In the committed runs, vector-only outperformed hybrid on Precision@10, Recall@10, F1@10, MAP and NDCG@10 at both corpus sizes. Hybrid was not universally superior. Results describe this synthetic benchmark and one local environment; they do not establish performance on real forensic evidence or prove forensic relationships.

Other limitations include synthetic single-author data and evaluation of evidence records rather than findings. See the report for methodology and details.

## Team

| Member | SRN |
|---|---|
| Urav B S | PES1UG24CS507 |
| Uttam B S | PES1UG24CS508 |

## Repository map

- `database/` — schema, access control, routines, DML/query demos and verification scripts
- `data/` — fictional case templates, generator and seed SQL
- `docs/` — design, API contract, setup and rubric map
- `app/` — Next.js application, database, authentication, retrieval, vector and indexing modules
- `worker/` — standalone indexing worker entry point
- `vector/` — Qdrant setup and health scripts
- `evaluation/` — dataset, evaluation code, tests, metrics, report, CSV/JSON and SVG outputs

