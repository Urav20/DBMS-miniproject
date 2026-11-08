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
Show `error.sqlMessage` to the user for 45xxx errors; show a generic message for the rest.

## 3. Reads (investigator account: views only)
| Screen | Query |
|---|---|
| Case list | `SELECT * FROM v_my_cases ORDER BY opened_at DESC` |
| Case evidence | `SELECT e.*, c.current_custodian_name FROM v_my_evidence e JOIN v_my_current_custody c USING (evidence_id) WHERE e.case_id = ?` |
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
| `v_my_users` | `user_id, username, full_name` | Distinct users who appear as sender or receiver in custody history for visible evidence. Historical names remain available. |
| `v_my_teammates` | `case_id, user_id, username, full_name` | Other active users with non-revoked assignments to a case visible to the current investigator. The current user is excluded because self-transfer is not allowed. |

The unrestricted `v_current_custody` view is granted only to `tracex_admin`; investigators must use `v_my_current_custody`. The worker does not need either view because it reads the evidence/finding base tables and the indexing outbox under its own restricted grants.

## 4. Writes (procedures; the actor is always `@tracex_user_id`)
| UI action | Call | Returns |
|---|---|---|
| Register evidence | `CALL sp_register_evidence(case_id, source_id|NULL, type_id, title, description, extracted_text|NULL, sha256|NULL, size|NULL, collected_at, method, location|NULL, notes|NULL)` | `evidence_id, evidence_no` |
| Transfer custody | `CALL sp_transfer_custody(evidence_id, to_user_id, reason)` | `evidence_id, seq_no` |
| Edit text (re-embeds) | `CALL sp_update_evidence_text(evidence_id, title, description, extracted_text|NULL)` | `evidence_id, content_version` |
| Withdraw (removes vectors) | `CALL sp_withdraw_evidence(evidence_id, reason)` | `evidence_id, status` |
| Start analysis | `CALL sp_record_analysis(evidence_id, tool_id, notes|NULL)` | `analysis_id` |
| Complete analysis | `CALL sp_complete_analysis(analysis_id)` | `analysis_id` |
| Add finding | `CALL sp_add_finding(analysis_id, title, description, severity)` | `finding_id` |
| Link evidence | `CALL sp_link_evidence(a_id, b_id, rel_type, rationale)` | `rel_id` |
Edit sends all three text fields (current values for the unchanged ones).

Administrator only: `sp_create_case(case_number, title, description)`, `sp_grant_access(case_id, user_id)`,
`sp_revoke_access(case_id, user_id)`, `sp_set_case_status(case_id, 'open'|'under_review'|'closed')`,
`sp_backfill_index_jobs()` ("re-index everything"). User creation/deactivation is a plain INSERT/UPDATE on `app_user` by the admin account (audit it with an `audit_log` INSERT).

## 5. Worker (account `tracex_worker_app`)
Triggers fill `index_job` automatically (new/changed evidence and findings = `upsert`, withdrawn = `delete`).
Worker loop:
1. Claim: `UPDATE index_job SET status='processing', attempts=attempts+1 WHERE status='pending' ORDER BY job_id LIMIT 10;` then `SELECT` the rows it claimed (or claim one at a time with `SELECT ... FOR UPDATE SKIP LOCKED`).
2. For `upsert`: read the text from `evidence` / `finding`; skip the job if `job.content_version` is lower than the row's current `content_version` (a newer job exists); embed; upsert the point (UUIDv5 from kind + id).
3. After success: `UPDATE evidence SET indexed_version = ?, indexed_at = NOW() WHERE evidence_id = ?` (or `finding`) and `UPDATE index_job SET status='done', processed_at=NOW()`.
4. On failure: `status='failed'`, `last_error=...`; retry up to 5 attempts.
5. For `delete`: delete the point, then mark the job done.
Permission re-check for search results: Qdrant returns candidate ids; the app then runs `SELECT ... FROM v_my_evidence WHERE evidence_id IN (...)` so a user never sees a hit from a case they cannot access.

## 6. Demo logins
Password `TraceX#Demo1` for all: admins `dana.whitfield`, `ravi.menon`; investigators `isha.kapoor`, `tomas.brandt`, `lena.hoffmann`, `arjun.desai`, `sofia.marquez`, `kofi.mensah`.
