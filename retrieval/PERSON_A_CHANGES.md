# Required Person A SQL changes (proposals only, NOT applied)

Nothing in `database/` was modified. These are the changes retrieval (Phase 3) needs or would benefit from.
Each one is already covered by a `todo` test in `app/tests/retrieval/` that starts passing when it is done.

## Required

**1. Expose `content_version` in the investigator views** (stale-hit check).
`v_my_evidence` and `v_my_findings` (02_access.sql) do not select `content_version`, and investigators
have no base-table access, so retrieval cannot compare Qdrant's payload version with MySQL's. The design doc
(section 5.3) says retrieval "drops stale hits (`content_version` mismatch)". Until this is done the
investigator path cannot do that (the response says so: `meta.verification.stale_version_check: false`).
Proposal: add `e.content_version` to the SELECT list of `v_my_evidence` and `f.content_version` to `v_my_findings`
(append at the end; existing `SELECT *` users just get one more column). Tests: "PERSON A CHANGE 1 / 1b".

**2. `GRANT SELECT ON tracex.analysis TO 'tracex_worker';`** (worker blocker B1, already documented in `worker/README.md`).
Without it finding points are never indexed (finding upserts fail), so findings will not appear in search
results at all. Afterwards an administrator runs `sp_backfill_index_jobs()`. Test: "PERSON A CHANGE 2".

## Optional

**3. Audit of searches.** Investigators cannot INSERT into `audit_log`; only procedures write it. If searches
must be audited, a procedure such as `sp_log_search(case_ids, result_count)` (EXECUTE for both roles) would be needed.
Retrieval does not log search text anywhere.

**4. Convenience columns on `v_my_findings`** (`evidence_id`, `case_id`, evidence status). Retrieval currently
gets them with a three-view join, which works; this would only simplify the SQL.

## Not requested (documented behaviour, no change needed)

- `v_my_evidence` / `v_my_findings` do not hide withdrawn evidence. Do not change this: evidence detail screens need it. Retrieval filters on `status`.
- `tracex_admin_app` has no grant on `v_my_*` views or `fn_*` functions. Retrieval reads base tables for admins and checks "active Administrator" itself.
- `docs/api-contract.md` section 5 (`SELECT ... FROM v_my_evidence WHERE evidence_id IN (...)`) is incomplete for search: it covers evidence only, not findings, withdrawn status, or versions.
