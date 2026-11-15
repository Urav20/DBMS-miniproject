# TRACE-X technology justification

## Why a hybrid relational–vector design?

TRACE-X needs to answer two different kinds of questions:

1. **Exact, auditable questions:** Who owns this case? Who collected an evidence item? Who currently holds it? Has it been withdrawn? Who may read it?
2. **Meaning-based questions:** Which evidence descriptions or findings discuss activity similar to a natural-language description, even when different words are used?

A relational database is designed for the first group. A vector database is useful for the second. TRACE-X uses each for the part it handles best; the vector database never replaces MySQL as the source of truth.

## Technology choices

| Technology | TRACE-X responsibility | Why selected | Trade-off / safeguard |
|---|---|---|---|
| **MySQL 8** | Users, roles, cases, assignments, evidence, collection, custody, analysis, findings, relationships, audit and indexing outbox | Structured records need primary/foreign keys, constraints, joins, transactions and predictable updates. MySQL also provides role-specific accounts and filtered views for case access. | Relational joins are not designed for semantic similarity. MySQL remains authoritative for every result and provenance decision. |
| **Qdrant** | Stores vectors for evidence and findings and returns nearest-neighbour candidates | A vector index is suited to high-dimensional similarity search and payload filtering. It avoids forcing semantic search into ordinary SQL comparisons. | Similarity is not proof and the payload is not an access-control system. Qdrant stores minimal identifiers/version metadata; every candidate is re-read and checked by MySQL. |
| **BAAI/bge-small-en-v1.5** | Converts evidence text, finding text and user queries into 384-dimensional vectors | Compact retrieval-oriented model that runs locally through Transformers.js/ONNX. A local model avoids sending evidence text to a third-party embedding API and keeps the embedding pipeline in JavaScript. | The model has a 512-token input limit and one vector is used per record. Longer text is truncated; chunking is a future extension. The benchmark compares retrieval strategies using this model, not different embedding models. |
| **Next.js / React (JavaScript)** | Authenticated workspace, server-rendered pages and API routes | The same JavaScript stack handles the UI, database Route Handlers and calls into vector/embedding libraries. It avoids maintaining a separate backend language. | Server-side database and vector modules must never be imported into browser components. API routes authenticate the session and use the role-specific DB layer. |
| **MySQL outbox + Node worker** | Keeps Qdrant synchronized after evidence/finding changes | MySQL writes a versioned `index_job` in the same transaction as the evidence/finding change. The worker performs embedding and Qdrant writes asynchronously. | MySQL and Qdrant are eventually consistent, not one distributed transaction. Content versions reject stale candidates; deterministic point IDs make retries idempotent; retry/recovery handles transient failures. The current schema supports one worker process because it has no lease/claim-token columns. |

## Why not only MySQL?

MySQL is excellent for exact predicates, joins, constraints and provenance. It does not natively provide TRACE-X's intended natural-language similarity behavior over evidence descriptions and extracted text. FULLTEXT search is retained as a keyword baseline, but semantic retrieval uses embeddings and Qdrant to find conceptually similar text.

## Why not only Qdrant?

A vector similarity result cannot safely decide case access, current custody, withdrawn status, evidence version or whether two records are formally related. Those decisions require normalized relational records, transactional procedures and role-based permissions. Qdrant proposes candidates; MySQL checks case scope and revalidates status and content version before returning them.

## Security and provenance principles

- Investigator reads use MySQL's case-filtered `v_my_*` views; application accounts are separated by role.
- The indexing worker has a separate account and only the grants needed to read indexed text/outbox rows and update indexing bookkeeping.
- Qdrant payloads contain IDs, case/evidence links and content version, not document text or user permissions.
- An edit updates MySQL first and queues re-embedding. A withdrawal is a soft delete in MySQL and queues vector deletion; provenance remains.
- Semantic similarity never writes an evidence relationship. An analyst must select the relationship type and record a written rationale.
- Custody and audit history are append-only so later changes do not erase the chain of events.

## Evaluation boundary

The committed Phase 4 evaluation uses synthetic 500- and 2,000-record datasets and compares keyword, vector-only and RRF-hybrid retrieval. In those runs, vector-only led on Precision@10, Recall@10, F1@10, MAP and NDCG@10. Hybrid was not universally better. This is evidence about the benchmark setup, not proof of effectiveness on real forensic casework.
