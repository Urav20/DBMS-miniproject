# TRACE-X Phase 2: Conceptual Design (Chen ER), Relational Schema, Qdrant Decisions

Status: design proposal for team review. Nothing here is implemented or measured yet.

Files in `docs/design/er/`: `chen_er.py` (generator and editable source), `chen_0_overview`, `chen_1_access_cases`, `chen_2_evidence_provenance`, `chen_3_analysis_indexing` (each as `.dot`, `.svg`, `.png`). Edit the tables at the top of `chen_er.py`, run `python3 chen_er.py .`, and all diagrams regenerate (needs Graphviz).

---

## 1. Decisions made (and changes from the earlier blueprint)

| Topic | Decision | Why |
|---|---|---|
| ER notation | **Chen** (rectangles, ellipses, diamonds) | Your requirement. Drawn with Graphviz because Mermaid cannot express Chen notation. |
| Diagram layout | One overview (no attributes) plus three detailed diagrams | One diagram with ~100 attribute ellipses is unreadable. |
| Weak entity | Only **CUSTODY_EVENT** (owner: EVIDENCE) | A custody event has no meaning without its evidence, and its identity is "evidence + position in chain". This is a real weak entity, not decoration. |
| Custody key | Composite PK `(evidence_id, seq_no)` | Direct result of the weak-entity mapping (replaces the surrogate key in the earlier blueprint). |
| Vector sync bookkeeping | `content_version`, `indexed_version`, `indexed_at` columns on EVIDENCE and FINDING; no separate `vector_index_state` table | Fewer tables; stale = `indexed_version <> content_version`. |
| Outbox | `index_job` points to exactly one of evidence or finding via two nullable FKs plus a CHECK | Keeps real foreign keys instead of a polymorphic "type + id" pair. |
| Deletion | Evidence is never hard-deleted; `status = 'withdrawn'` removes it from search and queues a Qdrant delete | Evidence must not vanish; retraction is still supported. |
| Embedding model | **BAAI bge-small-en-v1.5**, 384 dimensions, cosine | See section 5. |
| What is vectorized | **Evidence** and **findings** only | See section 5. |

Relationships: 23. Tables: 15 (role, app_user, investigation_case, case_assignment, evidence_source, evidence_type, evidence, collection_event, custody_event, analysis_tool, analysis, finding, evidence_relationship, audit_log, index_job).

---

## 2. Chen ER model

### Legend

| Symbol | Meaning |
|---|---|
| Rectangle | Entity |
| Double rectangle | Weak entity |
| Diamond | Relationship |
| Double diamond | Identifying relationship (weak entity to its owner) |
| Ellipse | Attribute |
| Underlined | Primary key |
| Italic and underlined | Partial key (weak entity) |
| Dashed ellipse | Derived attribute (computed, not stored) |
| Double line | Total participation (every instance must take part) |
| Single line | Partial participation |
| 1 / N / M | Cardinality ratio |

Red labels on the lines are cardinalities, read in the usual Chen way: ROLE 1 to N USER means one role has many users, and each user has one role.

### Relationship catalogue

| Relationship | Entities (ratio) | Participation | Notes |
|---|---|---|---|
| HAS_ROLE | ROLE 1 : N USER | USER total | Each user has exactly one role. |
| ASSIGNED_TO | USER M : N CASE | both partial | Attributes `granted_at`, `revoked_at`. Becomes the associative table `case_assignment`. |
| OPENS | USER 1 : N CASE | CASE total | Creator of the case. |
| CONTAINS_SOURCE | CASE 1 : N EVIDENCE_SOURCE | SOURCE total | |
| BELONGS_TO | CASE 1 : N EVIDENCE | EVIDENCE total | Case-level access hinges on this. |
| ORIGINATES_FROM | EVIDENCE_SOURCE 1 : N EVIDENCE | EVIDENCE partial | Source/device is optional. |
| CLASSIFIED_AS | EVIDENCE_TYPE 1 : N EVIDENCE | EVIDENCE total | |
| REGISTERS | USER 1 : N EVIDENCE | EVIDENCE total | |
| COLLECTED_VIA | EVIDENCE 1 : 1 COLLECTION_EVENT | COLLECTION total, EVIDENCE partial | One-to-one. |
| COLLECTS | USER 1 : N COLLECTION_EVENT | COLLECTION total | |
| HAS_CUSTODY (identifying) | EVIDENCE 1 : N CUSTODY_EVENT | both total | At least one custody event (the intake) is created with the evidence. |
| TRANSFERS_FROM | USER 1 : N CUSTODY_EVENT | CUSTODY partial | NULL for the first (intake) event. |
| TRANSFERS_TO | USER 1 : N CUSTODY_EVENT | CUSTODY total | |
| ANALYSED_IN | EVIDENCE 1 : N ANALYSIS | ANALYSIS total | |
| USES | ANALYSIS_TOOL 1 : N ANALYSIS | ANALYSIS total | |
| PERFORMS | USER 1 : N ANALYSIS | ANALYSIS total | |
| PRODUCES | ANALYSIS 1 : N FINDING | FINDING total | |
| SOURCE_OF / TARGET_OF | EVIDENCE 1 : N EVIDENCE_RELATIONSHIP (each) | RELATIONSHIP total | Together they model the **recursive many-to-many** "evidence A is linked to evidence B", resolved through the associative entity EVIDENCE_RELATIONSHIP. |
| RECORDS | USER 1 : N EVIDENCE_RELATIONSHIP | RELATIONSHIP total | Who asserted the link. Only humans create links; similarity scores never do. |
| ACTS_IN | USER 1 : N AUDIT_LOG | AUDIT partial | NULL user for system actions (for example the indexing worker). |
| LOGGED_FOR | CASE 1 : N AUDIT_LOG | AUDIT partial | Lets admins filter the log by case; NULL for non-case actions such as user management. |
| QUEUES_EVIDENCE / QUEUES_FINDING | EVIDENCE or FINDING 1 : N INDEX_JOB | both partial | **Exclusive arc:** each job belongs to exactly one of the two (enforced by CHECK). |

### Derived attribute

`EVIDENCE.current_custodian` is derived from the highest `seq_no` custody event (`to_user_id`). It is not stored, which avoids a second copy that could disagree with the history. A view provides it.

---

## 3. ER-to-relational mapping

### Rules applied

| ER construct | Rule | TRACE-X instances |
|---|---|---|
| Strong entity | Own table; PK = key attribute | role, app_user, investigation_case, evidence_source, evidence_type, evidence, collection_event, analysis_tool, analysis, finding, evidence_relationship, audit_log, index_job |
| Weak entity | Own table; PK = owner's PK + partial key; FK to owner | custody_event: PK `(evidence_id, seq_no)` |
| 1:N | FK on the N side | e.g. `evidence.case_id`, `app_user.role_id`, `analysis.evidence_id` |
| 1:1 | FK on the side with total participation, marked UNIQUE | `collection_event.evidence_id UNIQUE` |
| M:N with attributes | Separate table; PK = both FKs; relationship attributes become columns | `case_assignment(case_id, user_id, granted_at, revoked_at)` |
| Recursive M:N | Associative entity with two FKs to the same table | `evidence_relationship(evidence_a_id, evidence_b_id)` |
| Two relationships between the same pair | Two FK columns, distinct names | `custody_event.from_user_id`, `to_user_id` |
| Optional participation | FK nullable | `evidence.source_id`, `custody_event.from_user_id` |
| Total participation | FK `NOT NULL` | `evidence.case_id`, `finding.analysis_id` |
| Exclusive arc | Two nullable FKs + CHECK exactly one non-NULL | `index_job` |
| Derived attribute | Not stored; provided by a view | `current_custodian` |
| Multivalued attribute | None needed | none |
| Specialization | None justified | none |

### Integrity beyond plain keys

| Rule | How it is enforced |
|---|---|
| Evidence's source must belong to the same case as the evidence | Composite FK `evidence(case_id, source_id)` references `evidence_source(case_id, source_id)`. `case_id` is already in `evidence`, so this adds no redundancy. |
| Both ends of an evidence relationship are in the same case | Trigger on `evidence_relationship` (comparing the two evidence rows' `case_id`). A stored copy of `case_id` would break 3NF, so a trigger is used instead. |
| Custody chain continuity (`from` = previous `to`, `seq_no` increments by 1) | Stored procedure `transfer_custody`, which locks the evidence row with `SELECT ... FOR UPDATE` inside one transaction. CHECKs cover the simple cases (see table below). |
| Version bump and outbox | Triggers: when `title`, `description` or `extracted_text` (or a finding's text) changes, `content_version` increases and an `index_job` row is inserted in the same transaction. |
| Access | Application checks `case_assignment` (with `revoked_at IS NULL`) on every request. Qdrant filters are only a performance hint. |

---

## 4. Relational schema and data dictionary

Conventions: MySQL 8.0.16+ (CHECK constraints enforced). `PK` primary key, `FK` foreign key, `UQ` unique, `NN` NOT NULL. Default referential action is `ON DELETE RESTRICT ON UPDATE CASCADE` unless stated. IDs are `INT UNSIGNED AUTO_INCREMENT` unless stated. Timestamps are `DATETIME` defaulting to `CURRENT_TIMESTAMP`.

### 4.1 role
Why: lookup of the two roles, so role names are not repeated text in every user row.

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| role_id | TINYINT UNSIGNED | PK, AI | Role identifier |
| role_name | VARCHAR(30) | NN, UQ | `Administrator` or `Investigator` |

### 4.2 app_user
Why: accounts. (`user` is a reserved-ish word in some tools, hence `app_user`.)

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| user_id | INT UNSIGNED | PK, AI | |
| role_id | TINYINT UNSIGNED | FK to role, NN | The user's single role |
| username | VARCHAR(50) | NN, UQ | Login name |
| email | VARCHAR(120) | NN, UQ | |
| full_name | VARCHAR(100) | NN | Display name |
| password_hash | VARCHAR(255) | NN | bcrypt/argon2 hash, never the password |
| is_active | TINYINT(1) | NN, default 1 | Deactivate instead of deleting, so history keeps its author |
| created_at | DATETIME | NN, default now | |

### 4.3 investigation_case
Why: the unit of access control. (`case` is a reserved word in SQL.)

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| case_id | INT UNSIGNED | PK, AI | |
| case_number | VARCHAR(30) | NN, UQ | Human-facing reference, e.g. `TX-2026-014` |
| title | VARCHAR(200) | NN | |
| description | TEXT | NULL | |
| status | ENUM('open','under_review','closed') | NN, default 'open' | |
| opened_at | DATETIME | NN, default now | |
| closed_at | DATETIME | NULL | Set exactly when status is `closed` |
| created_by | INT UNSIGNED | FK to app_user, NN | Case creator |

CHECKs: `closed_at IS NULL OR closed_at >= opened_at`; `(status = 'closed') = (closed_at IS NOT NULL)`.

### 4.4 case_assignment
Why: resolves the user-to-case many-to-many and carries permission history.

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| case_id | INT UNSIGNED | PK part, FK to investigation_case | |
| user_id | INT UNSIGNED | PK part, FK to app_user | |
| granted_at | DATETIME | NN, default now | |
| revoked_at | DATETIME | NULL | NULL means access is active |

PK `(case_id, user_id)`. CHECK `revoked_at IS NULL OR revoked_at >= granted_at`. Re-granting after revocation updates the same row (clears `revoked_at`); the full history is in `audit_log`.

### 4.5 evidence_source
Why: devices or origins, stored once instead of repeated per evidence item.

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| source_id | INT UNSIGNED | PK, AI | |
| case_id | INT UNSIGNED | FK to investigation_case, NN | Case the source belongs to |
| label | VARCHAR(120) | NN | e.g. "Suspect laptop A" |
| source_kind | ENUM('computer','mobile','server','storage_media','cloud_account','network_capture','other') | NN | |
| serial_no | VARCHAR(80) | NULL | |
| description | TEXT | NULL | |

UQ `(case_id, label)`; UQ `(case_id, source_id)` (target for the composite FK from `evidence`).

### 4.6 evidence_type

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| type_id | TINYINT UNSIGNED | PK, AI | |
| name | VARCHAR(60) | NN, UQ | e.g. "Disk image", "System log", "Email", "Memory dump" |
| description | VARCHAR(255) | NULL | |

### 4.7 evidence
Why: the central record. Text fields here feed semantic search.

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| evidence_id | INT UNSIGNED | PK, AI | |
| evidence_no | VARCHAR(30) | NN, UQ | Human-facing label, e.g. `EV-000123` |
| case_id | INT UNSIGNED | FK, NN | Owning case |
| source_id | INT UNSIGNED | NULL | Origin device/source (optional) |
| type_id | TINYINT UNSIGNED | FK to evidence_type, NN | |
| title | VARCHAR(200) | NN | Short label |
| description | TEXT | NN | Analyst-written description (embedded) |
| extracted_text | MEDIUMTEXT | NULL | Text extracted from the item, synthetic in this project (embedded) |
| sha256 | CHAR(64) | NULL | Hex hash of the original file |
| file_size_bytes | BIGINT UNSIGNED | NULL | |
| status | ENUM('active','withdrawn') | NN, default 'active' | Withdrawn evidence is hidden from search |
| registered_by | INT UNSIGNED | FK to app_user, NN | |
| registered_at | DATETIME | NN, default now | |
| content_version | INT UNSIGNED | NN, default 1 | Bumped when embedded text changes |
| indexed_version | INT UNSIGNED | NULL | Version last written to Qdrant; NULL = never indexed |
| indexed_at | DATETIME | NULL | |

FKs: `(case_id, source_id)` to `evidence_source(case_id, source_id)` (composite; null `source_id` is allowed); `case_id` to `investigation_case`. UQ `(case_id, sha256)` (blocks duplicate registration of the same file in one case; allows NULL). CHECK `sha256 REGEXP '^[0-9a-f]{64}$'` when not NULL.

### 4.8 collection_event

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| collection_id | INT UNSIGNED | PK, AI | |
| evidence_id | INT UNSIGNED | FK, NN, **UQ** | The 1:1 link to evidence |
| collected_by | INT UNSIGNED | FK to app_user, NN | Who collected it |
| collected_at | DATETIME | NN | When it was collected (the real-world event) |
| method | VARCHAR(100) | NN | e.g. "Forensic imaging", "Log export" |
| location | VARCHAR(150) | NULL | |
| notes | TEXT | NULL | |

### 4.9 custody_event (weak entity)

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| evidence_id | INT UNSIGNED | PK part, FK to evidence | Owner |
| seq_no | INT UNSIGNED | PK part | 1 = intake; increases by 1 per transfer |
| from_user_id | INT UNSIGNED | FK to app_user, NULL | NULL only for `seq_no = 1` |
| to_user_id | INT UNSIGNED | FK to app_user, NN | New custodian |
| transferred_at | DATETIME | NN, default now | |
| reason | VARCHAR(255) | NULL | |

CHECKs: `from_user_id IS NULL OR from_user_id <> to_user_id`; `(seq_no = 1 AND from_user_id IS NULL) OR (seq_no > 1 AND from_user_id IS NOT NULL)`. The table is append-only: the application never issues UPDATE or DELETE on it.

### 4.10 analysis_tool

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| tool_id | INT UNSIGNED | PK, AI | |
| name | VARCHAR(80) | NN | e.g. "Autopsy", "Volatility" |
| version | VARCHAR(30) | NN | |
| description | VARCHAR(255) | NULL | |

UQ `(name, version)`.

### 4.11 analysis

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| analysis_id | INT UNSIGNED | PK, AI | |
| evidence_id | INT UNSIGNED | FK, NN | Evidence analysed |
| tool_id | INT UNSIGNED | FK to analysis_tool, NN | |
| analyst_id | INT UNSIGNED | FK to app_user, NN | |
| started_at | DATETIME | NN, default now | |
| completed_at | DATETIME | NULL | |
| notes | TEXT | NULL | Free notes (not embedded) |

CHECK `completed_at IS NULL OR completed_at >= started_at`.

### 4.12 finding

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| finding_id | INT UNSIGNED | PK, AI | |
| analysis_id | INT UNSIGNED | FK, NN | Analysis that produced it (case and evidence are reached through it) |
| title | VARCHAR(200) | NN | |
| description | TEXT | NN | The analyst's statement of what was found (embedded) |
| severity | ENUM('info','low','medium','high','critical') | NN, default 'info' | |
| created_at | DATETIME | NN, default now | |
| content_version | INT UNSIGNED | NN, default 1 | |
| indexed_version | INT UNSIGNED | NULL | |
| indexed_at | DATETIME | NULL | |

### 4.13 evidence_relationship
Why: explicit, human-asserted links between two evidence items. This is where "related" is recorded as a fact. Semantic similarity never writes here automatically.

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| rel_id | INT UNSIGNED | PK, AI | |
| evidence_a_id | INT UNSIGNED | FK to evidence, NN | Source end (direction matters) |
| evidence_b_id | INT UNSIGNED | FK to evidence, NN | Target end |
| rel_type | ENUM('derived_from','corroborates','contradicts','related_activity','other') | NN | |
| rationale | TEXT | NN | Why the analyst believes this link holds |
| recorded_by | INT UNSIGNED | FK to app_user, NN | |
| recorded_at | DATETIME | NN, default now | |

CHECK `evidence_a_id <> evidence_b_id`. UQ `(evidence_a_id, evidence_b_id, rel_type)`. Trigger enforces the same case for both ends.

### 4.14 audit_log

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| audit_id | BIGINT UNSIGNED | PK, AI | |
| user_id | INT UNSIGNED | FK to app_user, NULL | NULL for system actions |
| case_id | INT UNSIGNED | FK to investigation_case, NULL | For filtering by case |
| action | VARCHAR(50) | NN | e.g. `evidence.create`, `custody.transfer`, `access.revoke` |
| entity_type | VARCHAR(30) | NULL | Which table the action touched |
| entity_id | BIGINT UNSIGNED | NULL | Row id in that table |
| details | JSON | NULL | Before/after values, reason |
| created_at | DATETIME | NN, default now | |

`entity_type + entity_id` are deliberately not a foreign key: the log must survive and describe any table. This is the one intentional exception to "every reference is a real FK". Append-only.

### 4.15 index_job (outbox)

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| job_id | BIGINT UNSIGNED | PK, AI | |
| evidence_id | INT UNSIGNED | FK to evidence, NULL | Target if the job is for evidence |
| finding_id | INT UNSIGNED | FK to finding, NULL | Target if the job is for a finding |
| operation | ENUM('upsert','delete') | NN | |
| content_version | INT UNSIGNED | NN | Version this job should index |
| status | ENUM('pending','processing','done','failed') | NN, default 'pending' | |
| attempts | TINYINT UNSIGNED | NN, default 0 | Retry counter |
| last_error | VARCHAR(500) | NULL | |
| created_at | DATETIME | NN, default now | |
| processed_at | DATETIME | NULL | |

CHECK `(evidence_id IS NULL) <> (finding_id IS NULL)` (exactly one target).

### 4.16 Planned indexes (beyond PK/UQ), for Phase 3

`evidence(case_id, status)`; `evidence(type_id)`; `custody_event` PK already covers lookups by evidence; `analysis(evidence_id)`; `finding(analysis_id)`; `audit_log(case_id, created_at)`; `audit_log(user_id, created_at)`; `index_job(status, created_at)`; `case_assignment(user_id, revoked_at)`; `FULLTEXT(title, description, extracted_text)` on evidence (keyword baseline for the evaluation).

### 4.17 Planned database objects (Phase 3)

| Object | Purpose |
|---|---|
| View `v_current_custody` | Latest custody row per evidence (the derived `current_custodian`) |
| View `v_user_case_access` | Active assignments (`revoked_at IS NULL`, active user) |
| Procedure `register_evidence` | Inserts evidence, collection event, custody event 1, audit row in one transaction |
| Procedure `transfer_custody` | Locks the evidence row, checks sender is the current custodian, appends the event, writes the audit row; rolls back on any violation |
| Triggers on evidence and finding | Bump `content_version` on text change and insert the `index_job` row |
| Trigger on evidence_relationship | Same-case check |
| Trigger/permissions for append-only tables | Block UPDATE and DELETE on `custody_event` and `audit_log` |

---

## 5. Qdrant: embedding model and vectorization scope

### 5.1 Scope: what gets vectorized

| Record | Vectorized? | Reason |
|---|---|---|
| Evidence | **Yes** | `title + description + extracted_text` is the main investigative narrative. |
| Findings | **Yes** | Analyst conclusions are free text and are often what an investigator actually wants to retrieve. |
| Analysis notes | No (v1) | Overlaps with findings; adds noise and indexing work. Can be added later. |
| Cases, users, sources, custody, audit | No | Structured data. Exact SQL filtering is better than similarity for it. These are the filters in the hybrid step. |
| Binary files / disk images | No | Out of scope; only synthetic extracted text is used. |

Two kinds of point are enough to test the research question (keyword vs vector vs hybrid) without the cost of embedding everything.

### 5.2 Embedding model

**Choice: `BAAI/bge-small-en-v1.5`** (384 dimensions, cosine distance), run locally.

| Reason | Detail |
|---|---|
| Local and free | No API, runs on an ordinary laptop CPU. |
| Quality for retrieval | Designed for retrieval; generally reported as stronger than `all-MiniLM-L6-v2` on retrieval benchmarks (MTEB). We will verify this on our own evaluation data, not assume it. |
| Longer input | 512-token limit, versus about 256 for MiniLM, so descriptions plus extracted text fit more often. |
| Same size | 384 dimensions, so storage and speed match MiniLM. |
| JavaScript-friendly | Loadable in Node through Transformers.js (ONNX), so the worker can stay in JavaScript like the rest of the stack. **To verify at Phase 4 setup** (exact package name and model id). Fallback: a small Python script using your venv with `sentence-transformers`. |

Usage notes: for **queries**, bge expects the prefix `Represent this sentence for searching relevant passages: `; documents get no prefix. Embeddings are normalized so cosine distance is meaningful. The 512-token limit means text beyond it is truncated; for v1, one vector per record, with the truncation limit recorded in the report. Chunking is future work.

### 5.3 Collection design

| Item | Value |
|---|---|
| Collection | `tracex_records` |
| Vector | size 384, distance Cosine |
| Point ID | UUIDv5 of `evidence:{evidence_id}` or `finding:{finding_id}` (deterministic, so re-indexing overwrites instead of duplicating) |
| Payload | `kind` (`evidence` or `finding`), `record_id`, `evidence_id`, `case_id`, `content_version`; **no raw text** |
| Payload indexes | `case_id` (integer), `kind` (keyword) |
| Retrieval | Embed query, top-k from Qdrant filtered by `case_id IN (user's cases)` and optional `kind`; MySQL then re-checks access, drops withdrawn and stale hits (`content_version` mismatch), and loads the authoritative rows and provenance |
| Update | Text change makes MySQL bump `content_version` and enqueue an `upsert` job; the worker re-embeds and overwrites the same point ID |
| Delete | Withdrawal enqueues a `delete` job |
| Stale or missing detection | Evidence or findings with `indexed_version IS NULL` or `<> content_version`; points in Qdrant with no matching active MySQL row |

Qdrant's `case_id` filter is an optimization only. MySQL decides what a user may see.

---

## 6. Normalization (short note; full write-up comes later)

Representative dependencies: `evidence_id -> case_id, source_id, type_id, title, ..., registered_by`; `source_id -> case_id, label, source_kind, serial_no`; `type_id -> name`; `(evidence_id, seq_no) -> from_user_id, to_user_id, transferred_at`. A flat table with evidence, case title, device label and type name together would contain transitive dependencies such as `evidence_id -> source_id -> label` (3NF violation). That is why those attributes live in their own tables. The schema is in 3NF; the composite FK on `evidence(case_id, source_id)` stores no extra attributes.

## 7. Decisions settled

The team delegated these three choices, so they are fixed unless the course requirements say otherwise:

1. **Deletion model:** evidence is withdrawn (hidden from search, Qdrant point deleted), never hard-deleted.
2. **Vector scope:** evidence and findings are embedded; analysis notes are not (v1).
3. **Notation and file names:** Chen notation with double lines for total participation; file names as in this folder. Revisit only if the course prescribes a different variant or naming.

Next step (not started): Phase 3, MySQL DDL, constraints, indexes, views, procedures, triggers and seed data.
