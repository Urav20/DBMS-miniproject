# TRACE-X API contract: database side (for the Next.js app)

Everything the MySQL command line can do is a stored procedure, a view or a plain query,
so every UI action maps to exactly one of the items below (CLI/UI parity).

## 1. Connection rules
- Three MySQL accounts (`02_access.sql`): `tracex_admin_app`, `tracex_investigator_app`, `tracex_worker_app`.
  Use the account that matches the logged-in user's role. Passwords come from `.env`, never from Git.
- Before EVERY request, on the same connection: `SET @tracex_user_id = <user_id>;`
  Use one pooled connection per request (get, SET, run, release), never a shared global connection.
- Passwords are checked in the app (bcrypt, `app_user.password_hash`). The admin account reads `app_user`; the login route runs as admin.
- Always call procedures with `?` placeholders (mysql2 prepared parameters). Never build SQL by string concatenation.

## 2. Error mapping (SQLSTATE 45000, `error.errno`)
| errno | Meaning | HTTP |
|---|---|---|
| 45011 | not logged in / deactivated | 401 |
| 45001 | access denied or not found | 403 (or 404) |
| 45002 | case is closed | 409 |
| 45003 | business rule violated (message is user-readable) | 422 |
| 45010 | append-only table | 405 |
| 1062 | duplicate (same SHA-256 in the case, duplicate case number) | 409 |
| 3819 / 4025 | CHECK constraint violated | 422 |
| 1451 / 1452 | foreign key violated | 409 / 422 |
Do not return raw `error.sqlMessage`, SQL or driver details to the browser. Route handlers map expected stored-procedure/business-rule rejections to a safe user-facing message and log only a safe error code/errno; unexpected failures return a generic message.

## 3. Reads (investigator account: views only)
| Screen | Query |
|---|---|
| Case list | `SELECT * FROM v_my_cases ORDER BY opened_at DESC` |
| Case evidence | `SELECT e.*, c.current_custodian_name FROM v_my_evidence e LEFT JOIN v_my_current_custody c USING (evidence_id) WHERE e.case_id = ?` |
| Evidence detail | `v_my_evidence` (one row) + `v_my_collection` + `v_my_analyses` + `v_my_findings` (join analyses by `analysis_id`) |
| Provenance timeline | `v_my_custody WHERE evidence_id = ? ORDER BY seq_no`; resolve `from_user_id` and `to_user_id` through `v_my_users` |
| Links | `v_my_relationships WHERE evidence_a_id = ? OR evidence_b_id = ?` |
| Link graph | `CALL sp_linked_evidence(?, ?)` (start id, max depth) |
| Transfer picker | `SELECT case_id, user_id, username, full_name FROM v_my_teammates WHERE case_id = ? ORDER BY full_name` |
| Lookups | `evidence_type`, `analysis_tool` (readable by investigators) |
Administrator account: same screens on base tables (no row filter), plus `app_user`, `case_assignment`, `audit_log`, `index_job`, and the unrestricted `v_current_custody` view.

### Investigator view contract

All views below are created in `03_routines.sql` with `SQL SECURITY DEFINER` and are granted `SELECT` to `tracex_investigator` there (after the base filtered views from `02_access.sql` exist). They return only records associated with cases currently assigned to the logged-in investigator, except that historical people shown in provenance remain resolvable after their case access is revoked.

| View | Columns | Row restriction / purpose |
|---|---|---|
| `v_my_current_custody` | `evidence_id, seq_no, current_custodian_id, current_custodian_name, transferred_at` | Current custodian only for evidence visible through `v_my_evidence`. |
| `v_my_users` | `user_id, username, full_name` | Active teammates plus users referenced as custody senders/receivers, collectors, or analysts for visible evidence. Historical names remain available after assignment revocation. |
| `v_my_teammates` | `case_id, user_id, username, full_name` | Other active users with non-revoked assignments to a case visible to the current investigator. The current user is excluded because self-transfer is not allowed. |

The unrestricted `v_current_custody` view is granted only to `tracex_admin`; investigators must use `v_my_current_custody`. The worker does not need either view because it reads the evidence/finding base tables and the indexing outbox under its own restricted grants.

## 4. Writes (procedures; the actor is always `@tracex_user_id`)
| UI action | Call | Returns |
|---|---|---|
| Register evidence | `CALL sp_register_evidence(case_id, source_id|NULL, type_id, title, description, extracted_text|NULL, sha256|NULL, size|NULL, collected_at, method, location|NULL, notes|NULL)` | `evidence_id, evidence_no` |
| Transfer custody | `CALL sp_transfer_custody(evidence_id, to_user_id, reason)` | `evidence_id, seq_no` |
| Edit evidence metadata (preserves existing extracted text) | `CALL sp_update_evidence_metadata(evidence_id, title, description)` | `evidence_id, content_version` |
| Edit all searchable text (including extracted text) | `CALL sp_update_evidence_text(evidence_id, title, description, extracted_text|NULL)` | `evidence_id, content_version` |
| Withdraw (removes vectors) | `CALL sp_withdraw_evidence(evidence_id, reason)` | `evidence_id, status` |
| Start analysis | `CALL sp_record_analysis(evidence_id, tool_id, notes|NULL)` | `analysis_id` |
| Complete analysis | `CALL sp_complete_analysis(analysis_id)` | `analysis_id` |
| Add finding | `CALL sp_add_finding(analysis_id, title, description, severity)` | `finding_id` |
| Link evidence | `CALL sp_link_evidence(a_id, b_id, rel_type, rationale)` | `rel_id` |
**Workspace behavior:** the evidence metadata form sends only title and description to `sp_update_evidence_metadata`; the procedure locks the row and preserves `extracted_text` inside MySQL. The separate `sp_update_evidence_text` procedure remains available when an authorized caller intentionally replaces the extracted text.

Administrator only: `sp_create_case(case_number, title, description)`, `sp_grant_access(case_id, user_id)`,
`sp_revoke_access(case_id, user_id)`, `sp_set_case_status(case_id, 'open'|'under_review'|'closed')`,
and `sp_backfill_index_jobs()` (queue missing/stale vectors). The case workspace exposes case creation, status changes and assignment grant/revoke controls. User creation/deactivation remains a database-admin operation (audit it with an `audit_log` INSERT); it is not a user-management screen in the current workspace.

## 5. Worker (account `tracex_worker_app`)
Triggers fill `index_job` automatically (new/changed evidence and findings = `upsert`, withdrawn = `delete`).
Worker loop (run exactly one worker process; the current schema has no lease/claim-token columns):
1. List the oldest pending job IDs up to the validated batch size. Claim each ID with a compare-and-set statement, `UPDATE index_job SET status='processing', attempts=attempts+1 WHERE job_id = ? AND status='pending'`. Only IDs for which `affectedRows = 1` are read back and processed. This avoids accidentally processing every row already marked `processing`.
2. For `upsert`: read the text from `evidence` / `finding`; skip the job if `job.content_version` is lower than the row's current `content_version` (a newer job exists); embed; upsert the point (UUIDv5 from kind + id).
3. After success: `UPDATE evidence SET indexed_version = ?, indexed_at = NOW() WHERE evidence_id = ?` (or `finding`) and `UPDATE index_job SET status='done', processed_at=NOW()`.
4. On failure: `status='failed'`, `last_error=...`; retry up to 5 attempts.
5. For `delete`: delete the point, then mark the job done.
Permission and version re-check for search results: Qdrant returns candidate IDs; the app re-reads each candidate through the investigator-filtered views (or granted base tables after re-checking an active administrator) and compares its `content_version` with the Qdrant payload. Withdrawn, inaccessible, missing and stale records are discarded. The Qdrant payload is never an authorization source.

## 6. Demo logins
Password `TraceX#Demo1` for all: admins `dana.whitfield`, `ravi.menon`; investigators `isha.kapoor`, `tomas.brandt`, `lena.hoffmann`, `arjun.desai`, `sofia.marquez`, `kofi.mensah`.
