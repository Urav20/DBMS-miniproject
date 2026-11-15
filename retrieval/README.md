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
    "verification": { "authority": "mysql", "access_path": "investigator_views", "stale_version_check": true },
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

## Existing modules reused

The retrieval service uses the existing `lib/db` request-scoped pools, `lib/vector` embedder/Qdrant store, deterministic `pointId`/payload validation, and `lib/auth/access.js` session authorization helpers. It does not create a second DB pool, embedder or Qdrant client.

## SQL findings (read from the supplied `database/*.sql`)

- **Investigator content versions:** `v_my_evidence` and `v_my_findings` now expose `content_version` in `database/02_access.sql`. The repository selects those columns through the filtered views and compares them with Qdrant payload versions, so stale candidates are discarded for investigators as well as administrators.
- **Withdrawn rows:** the views intentionally do not filter withdrawn evidence or findings tied to withdrawn evidence. The retrieval reconciliation step checks the evidence status from MySQL and discards those candidates.
- **Administrator path:** `tracex_admin_app` does not use investigator-filtered views. The repository reads granted base tables and re-checks in MySQL that the session user remains an active Administrator.
- **Worker finding lookup:** `database/02_access.sql` grants `SELECT` on `tracex.analysis` to `tracex_worker`, allowing the worker to resolve `finding -> analysis -> evidence -> case` and populate finding payload case IDs.
- The relevant grants/views are covered by `retrieval-sql-contract.unit.test.mjs`; live MySQL verification is still an environment-specific task.

## Limitations

- **Stale-vector validation runs for both roles** when candidate rows are loaded. A candidate whose Qdrant `content_version` does not match the authoritative MySQL row is discarded before results are returned. The metadata flag is false when no authoritative candidate rows needed checking (for example, an empty scope or no valid hits), and true when the version check was performed.
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

**Automated verification:** the current main-branch CI workflow runs the retrieval unit and SQL-contract tests together with the DB, authentication, vector, indexing and workspace test suites, the Phase 4 evaluation tests, and the Next.js production build. Check the latest green workflow run rather than relying on historical test counts from the original Phase 3 handoff.

**Still requires the team's live environment:** run `npm run test:retrieval:live` against the configured MySQL/Qdrant services and perform an authenticated browser search using the real BGE model. The CI tests use fakes for the DB/vector-dependent retrieval paths; a green CI run does not prove that the local MySQL grants, Qdrant collection or embedding-model download are configured correctly.
