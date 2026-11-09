# retrieval/ : semantic search API (Person B, Phase 3)

`POST /api/search/semantic` finds evidence and findings whose text is semantically close to a natural-language
query. **Qdrant only proposes candidates. MySQL decides what the signed-in user may see.** A similarity score is a
lead for a human analyst, never proof that records are related; nothing here records or infers relationships.

Code: `app/src/lib/retrieval/` (library), `app/src/app/api/search/semantic/route.js` (route),
`app/tests/retrieval/` (tests). Same layout as `vector/` and `worker/`.

## Flow

```
request -> session check -> validate input
  1 MySQL  which cases may this user search NOW?        (v_my_cases | investigation_case)
  2 embed  the query (existing embedder, bge query prefix)
  3 Qdrant top candidates filtered to those cases       (speed hint only; limit x3 over-fetch)
  4 MySQL  re-read every candidate as this user         (v_my_evidence/v_my_findings | base tables)
  5 discard withdrawn, stale, inaccessible, out-of-scope, forged candidates
  6 return survivors: MySQL fields + Qdrant similarity score
```
Each MySQL step is its own request-scoped connection (role pool, `SET @tracex_user_id`, parameterized SQL, reset, release),
via the existing `lib/db`. The DB connection is not held while the model embeds. Step 4 runs after Qdrant answers, so a
revocation or withdrawal that happened meanwhile is seen. **Fail closed:** if step 1, 2, 3 or 4 fails, nothing is returned.

## API

`POST /api/search/semantic`, JSON body, session cookie required (admin or investigator). POST so search text stays out of URLs and logs; it changes no data.

| Field | Type | Default | Notes |
|---|---|---|---|
| `query` | string | required | trimmed, 1 to 1000 chars, no control characters |
| `case_id` or `case_ids` | int / int[] | all my cases | not both; `[]` is rejected; max 50; every id must be accessible, else 403 |
| `kind` | `all`, `evidence`, `finding` | `all` | |
| `limit` | int 1 to 50 | 10 | |
| `min_score` | number 0 to 1 | none | cosine similarity floor, applied by Qdrant |

Unknown fields are rejected. Example (after signing in at `/api/auth/login`):
```
curl -s -X POST http://localhost:3000/api/search/semantic -H "content-type: application/json" \
  -b "tracex_session=<token>" -d '{"query":"deleted browser history before departure","case_id":1,"limit":5}'
```
Response (`200`):
```json
{ "results": [
    { "rank": 1, "record_type": "evidence", "record_id": 10, "evidence_id": 10, "evidence_no": "EV-0010",
      "case_id": 1, "title": "...", "similarity_score": 0.8123, "type_id": 1, "registered_at": "..." },
    { "rank": 2, "record_type": "finding", "record_id": 1000, "evidence_id": 10, "evidence_no": "EV-0010",
      "case_id": 1, "title": "...", "similarity_score": 0.7710, "analysis_id": 100, "severity": "high", "created_at": "..." } ],
  "meta": { "candidates_examined": 30, "discarded": 4, "returned": 2,
    "verification": { "authority": "mysql", "access_path": "investigator_views", "stale_version_check": false },
    "notice": "Similarity scores are leads ..." } }
```
Every field except `similarity_score` comes from MySQL. No description or extracted text is returned (the detail screens show those).
`discarded` is one aggregate count; reasons are only logged server-side (counts, never ids or query text).

| Status | Code | When |
|---|---|---|
| 400 / 413 | `SEARCH_BAD_REQUEST` / `SEARCH_TOO_LARGE` | invalid or oversized input (nothing else is touched) |
| 401 | `AUTH_REQUIRED` | no valid session |
| 403 | `CASE_ACCESS_DENIED` | a requested case is not accessible (same answer if it does not exist) |
| 403 | `AUTH_FORBIDDEN` | admin session whose user is no longer an active Administrator |
| 503 | `QDRANT_UNAVAILABLE`, `EMBEDDING_MODEL_UNAVAILABLE`, `DB_UNAVAILABLE`, ... | dependency down; no results |
| 500 | `EMBEDDING_FAILED`, `SEARCH_ERROR` | generic message; details only in server logs |

## Security checks (what each is for)

1. Session verified in the route itself (the proxy is only a first check); the user comes from the signed cookie, never the body.
2. Case scope comes from MySQL, not from the request; requested ids only narrow it. Qdrant is filtered with that list.
3. Every candidate is re-read from MySQL as this user. No MySQL row = no result. Qdrant metadata never authorizes anything.
4. Row must be in the validated case scope and `status = 'active'` (views do **not** hide withdrawn evidence or findings of withdrawn evidence).
5. Qdrant payload is only a consistency hint: wrong `case_id`/`evidence_id` -> discarded; point id must equal UUIDv5 of `kind:record_id`, so foreign or forged points are dropped.
6. Admin path: reads base tables and proves in MySQL that `@tracex_user_id` is an **active Administrator**, on both reads. The session cookie cannot be revoked, so this is what ends a deactivated admin's access immediately.
7. Parameterized SQL only (`?`), one statement, read-only; ids validated as integers before use; errors mapped to safe messages (no SQL, URLs, keys, query text).

## Existing modules reused (nothing duplicated or modified)

`lib/db` (`withSession`, pools, error mapping) · `lib/vector` (`getVectorServices()`: the one embedder and Qdrant store, `pointId`, `parsePayload`, `VectorError`) ·
`lib/auth/access.js` (`authorizeRequest`, `jsonResponse`, `toDbSession`). Only modified existing file: `app/package.json` (two scripts).

## SQL findings (read from the supplied `database/*.sql`)

- **View names:** every `v_*` name in `docs/api-contract.md` exists in the SQL. I found **no name mismatch** in the supplied files; if your contract is a different document, compare it against the list tested in `retrieval-sql-contract.unit.test.mjs`. The real mismatches are of another kind:
  - `v_my_evidence`/`v_my_findings` have no `content_version` -> stale check impossible for investigators (**Person A change 1**).
  - they do not filter withdrawn status; `v_my_findings` has no `evidence_id`/`case_id` (joined through `v_my_analyses`, `v_my_evidence`).
  - `tracex_admin_app` has no grant on `v_my_*` or `fn_*` (contract section 3 says admins use base tables; section 5's view query cannot run for admins).
  - `api-contract.md` section 5 covers evidence only.
- **Worker B1 is not assumed fixed.** Without `SELECT ON analysis` for the worker, finding upserts fail, findings are not indexed, and Qdrant's `case_id` filter would exclude any finding point lacking `case_id`. Search therefore returns evidence only until it is fixed; the API does not check or claim otherwise.
- Full list: `PERSON_A_CHANGES.md`.

## Limitations

- **Stale check is admin-only today** (see above). For investigators a record edited but not yet re-indexed can still be returned; its title/ids are current MySQL values, only the score may reflect old text. `meta.verification.stale_version_check` says which case applied.
- Fewer than `limit` results can be returned (discards); no paging (Qdrant fetch is `max(3 x limit, limit + 10)`, capped at 200).
- Withdrawn-evidence delete jobs that fail (worker B3) leave vectors behind; they are filtered here by the MySQL status check, as designed.
- Closed cases remain searchable (read access is unchanged by closing).
- One vector per record, truncated at 512 tokens. Scores are cosine values, not probabilities; no hybrid or keyword ranking.
- No search audit log and no rate limiting. Embedding is CPU-heavy; add limits before exposing widely.
- A deactivated investigator is indistinguishable from one with no cases (views just return nothing): empty results, or 403 if a case is named.
- `DATETIME` values are passed through as the db driver returns them (no timezone normalisation).

## Setup and tests

Same as the worker (`worker/README.md`): MySQL from `database/01..03` + seed, Qdrant, `.env.local`, `npm run vector:setup`, run the worker so points exist, then `npm run dev` and call the endpoint with a login cookie. First query downloads the model (~130 MB).

```
cd app
npm run test:retrieval        # unit + SQL-contract tests, no services needed
npm run test:retrieval:live   # real MySQL only; skipped when DB_* are missing
```

**What was actually run (Node 22, this build environment):**
`test:retrieval` 59 tests: 56 pass, 0 fail, 3 `todo` (the three Person A changes, failing by design). Existing suites unchanged: db 21/21, auth 39/39, vector 25/25, indexing 62 pass + 1 `todo`.
`next build` compiles and lists `/api/search/semantic`. A smoke test against the built server (no MySQL/Qdrant present) confirmed: 401 without cookie, 400 for empty/malformed input, 405 for GET, 503 `DB_UNAVAILABLE` with no results when MySQL is unreachable.
I mutation-tested the checks (removing withdrawn, scope, no-row, forged-id and admin-active checks, or the investigator view use, each made tests fail).

**Not verified:** nothing was run against a real MySQL, real Qdrant or the real BGE model (ONNX install was skipped here). `live.test.mjs` was written but never executed. The unit tests use a fake MySQL connection that mimics the grants and views from `02_access.sql`; that shows the code behaves correctly given that model of the database, not that the model is exact. Run `test:retrieval:live` and an end-to-end search on the real stack before relying on this.
