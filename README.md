# TRACE-X

**TRACE-X: A Provenance-Aware Hybrid Relational–Vector Database for Digital Evidence Provenance and Semantic Correlation**

A DBMS semester project by a two-member student team. TRACE-X helps authorized investigators find potentially relevant digital evidence through semantic search, while keeping the structured context that explains where evidence came from, which case it belongs to, how it was collected, and who has held it.

> **Status:** Phase 2 (database design) in progress. Nothing below is implemented unless marked as done.

## Core idea

| Database | Responsibility |
|---|---|
| **MySQL** | Authoritative store: users, roles, cases, evidence, collection and custody history, analyses, findings, audit log, indexing outbox |
| **Qdrant** | Semantic retrieval: embedding vectors plus minimal metadata for similarity search |

Semantic similarity is a lead, never proof that two evidence items are factually related. Qdrant is never the source of truth for provenance or authorization.

## Tech stack

- MySQL
- Qdrant
- Next.js (JavaScript) with Route Handlers as the backend API
- Local text-embedding model (to be finalized)
- Git and GitHub

## Planned features

- Authentication with Administrator and Investigator roles, plus case-level access
- Case and evidence management
- Provenance timeline: collection, custody transfers, analyses, findings, recorded relationships
- Semantic and hybrid evidence search
- Audit log and admin views
- MySQL-to-Qdrant synchronization through an outbox table, with retry and repair
- Reproducible evaluation: keyword vs vector-only vs hybrid retrieval

## Repository structure

```
trace-x/
├── docs/
│   ├── design/        # ER diagram, schema, data dictionary
│   ├── research/      # literature notes, evaluation plan
│   └── report/
├── database/          # schema.sql, seed.sql, queries.sql
├── app/               # Next.js application
├── worker/            # indexing worker
├── evaluation/        # dataset, benchmarks, results
├── .env.example
└── README.md
```

Folders are added as each phase is completed.

## Setup

> To be completed once the implementation exists. This section will cover prerequisites, installing MySQL and Qdrant, creating the database from `database/schema.sql`, seeding data, configuring `.env` from `.env.example`, and running the app and worker.

## Development phases

1. Requirements and research
2. Database design (ER diagram, relational schema, data dictionary, normalization)
3. Relational implementation (DDL, constraints, views, procedures, triggers)
4. Vector implementation (Qdrant, embeddings, indexing worker)
5. Hybrid retrieval
6. Application
7. Testing and evaluation
8. Finalization

## Team and workflow

- Work on short-lived feature branches (for example `feature/custody-transfer`) and merge through pull requests reviewed by the other member.
- Write descriptive commit messages.
- Never commit `.env` or other secrets.

| NAME | SRN |
|---|---|
| URAV B S  | PES1UG24CS507 |
| UTTAM B S | PES1UG24CS508 |

## Limitations and results

To be documented honestly after implementation and evaluation. No results are claimed yet.

## License

To be decided.
