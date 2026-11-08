-- =====================================================================
-- TRACE-X  |  04_dml.sql
-- DML demonstration (rubric item 6): INSERT / UPDATE / DELETE on realistic
-- cases, through the stored procedures (the way the app does it), plus
-- direct DML as administrator, plus statements that MUST be rejected.
--
-- Run after 01, 02, 03 and the seed:   source database/04_dml.sql
-- It changes data (adds a new evidence item, etc.). To start over, re-run
-- 01_schema.sql, 02_access.sql, 03_routines.sql and the seed.
--
-- User ids in the demo data: 1 dana (admin), 2 ravi (admin), 3 isha,
-- 4 tomas, 5 lena, 6 arjun, 7 sofia, 8 kofi.
-- Case 5 (altered financial documents) team: sofia, kofi, arjun.
-- =====================================================================
USE tracex;

-- Helper: runs one statement and reports ACCEPTED or REJECTED with the
-- reason, so a script can show rejected statements without stopping.
DROP PROCEDURE IF EXISTS demo_try;
DELIMITER $$
CREATE PROCEDURE demo_try(IN p_sql TEXT)
BEGIN
  DECLARE v_code INT;
  DECLARE v_msg  TEXT;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    GET DIAGNOSTICS CONDITION 1 v_code = MYSQL_ERRNO, v_msg = MESSAGE_TEXT;
    SELECT 'REJECTED' AS outcome, v_code AS error_code, v_msg AS reason;
  END;
  SET @demo_sql = p_sql;
  PREPARE demo_stmt FROM @demo_sql;
  EXECUTE demo_stmt;
  DEALLOCATE PREPARE demo_stmt;
  SELECT 'ACCEPTED' AS outcome, NULL AS error_code, 'statement succeeded' AS reason;
END$$
DELIMITER ;

-- ---------------------------------------------------------------------
-- A. INSERT: Sofia registers a new evidence item in case 5
--    (evidence + collection event + custody event 1 + audit row, one
--     transaction; the trigger queues the Qdrant job)
-- ---------------------------------------------------------------------
SET @tracex_user_id = 7;
CALL sp_register_evidence(
  5, 12, 6,
  'Bank statement for the Northgate payments account',
  'Monthly bank statement listing the payments made to Northgate Components Ltd in the second quarter.',
  'Statement June 2026. 2026-06-30 payment NG-0630 14,900.00. 2026-07-15 payment NG-0715 6,250.00.',
  SHA2('demo-bank-statement-q2', 256), 61440,
  '2026-10-05 11:00:00', 'Download from the bank portal', 'Finance office', NULL);

SELECT evidence_id INTO @new_ev FROM evidence WHERE evidence_no = 'EV-005-13';
SELECT evidence_id, evidence_no, title, status, content_version, indexed_version
FROM evidence WHERE evidence_id = @new_ev;
SELECT * FROM custody_event WHERE evidence_id = @new_ev;
SELECT job_id, evidence_id, operation, content_version, status FROM index_job WHERE evidence_id = @new_ev;

-- ---------------------------------------------------------------------
-- B. INSERT: transfer custody Sofia -> Arjun (chain of custody grows)
-- ---------------------------------------------------------------------
CALL sp_transfer_custody(@new_ev, 6, 'Handed over for reconciliation against the payments register');
SELECT seq_no, from_user_id, to_user_id, reason FROM custody_event WHERE evidence_id = @new_ev ORDER BY seq_no;
SELECT * FROM v_current_custody WHERE evidence_id = @new_ev;

-- ---------------------------------------------------------------------
-- C. UPDATE: Arjun corrects the description. content_version goes from 1
--    to 2 and a new upsert job is queued (the vector will be re-embedded).
-- ---------------------------------------------------------------------
SET @tracex_user_id = 6;
CALL sp_update_evidence_text(@new_ev,
  'Bank statement for the Northgate payments account',
  'Monthly bank statement (second quarter) listing the three payments made to Northgate Components Ltd, used to check the amounts actually paid.',
  'Statement June 2026. 2026-06-30 payment NG-0630 14,900.00. 2026-07-15 payment NG-0715 6,250.00. 2026-08-04 payment NG-0804 11,000.00.');
SELECT evidence_id, content_version, indexed_version FROM evidence WHERE evidence_id = @new_ev;
SELECT job_id, operation, content_version, status FROM index_job WHERE evidence_id = @new_ev ORDER BY job_id;

-- ---------------------------------------------------------------------
-- D. INSERT + UPDATE: analysis session, finding, then completion
-- ---------------------------------------------------------------------
CALL sp_record_analysis(@new_ev, 6, 'Statement metadata and payment reference check.');
SELECT MAX(analysis_id) INTO @new_an FROM analysis WHERE evidence_id = @new_ev;
CALL sp_add_finding(@new_an,
  'Statement payments match the supplier amounts',
  'The three payments on the statement equal the amounts on the supplier original invoices, not the amounts in the altered stored copies.',
  'high');
CALL sp_complete_analysis(@new_an);
SELECT analysis_id, analyst_id, started_at, completed_at FROM analysis WHERE analysis_id = @new_an;
SELECT finding_id, title, severity, content_version FROM finding WHERE analysis_id = @new_an;

-- ---------------------------------------------------------------------
-- E. INSERT: link the new item to evidence 49 (stored invoice), then walk
--    the link graph from 49 with the recursive CTE procedure.
-- ---------------------------------------------------------------------
CALL sp_link_evidence(@new_ev, 49, 'contradicts',
  'The amount paid on the statement does not match the amount shown on the stored invoice.');
CALL sp_linked_evidence(49, 5);

-- ---------------------------------------------------------------------
-- F. UPDATE (soft delete): withdraw the item. The row stays for the
--    record; delete jobs are queued for its vector and its finding's vector.
-- ---------------------------------------------------------------------
SET @tracex_user_id = 7;
CALL sp_withdraw_evidence(@new_ev, 'Uploaded by mistake: the statement is already held as another item in the finance folder');
SELECT evidence_no, status FROM evidence WHERE evidence_id = @new_ev;
SELECT job_id, evidence_id, finding_id, operation, status FROM index_job
WHERE evidence_id = @new_ev OR finding_id IN (SELECT finding_id FROM finding WHERE analysis_id = @new_an)
ORDER BY job_id;

-- ---------------------------------------------------------------------
-- G. Administrator work: status, access, and direct DML on lookup tables
-- ---------------------------------------------------------------------
SET @tracex_user_id = 1;                       -- Dana, administrator
CALL sp_set_case_status(3, 'closed');          -- UPDATE with closed_at kept in step
SELECT case_number, status, closed_at FROM investigation_case WHERE case_id = 3;
CALL demo_try('CALL sp_register_evidence(3, NULL, 6, "Late item", "Should be refused: case is closed", NULL, NULL, NULL, "2026-10-01 10:00:00", "Copy", NULL, NULL)');
CALL sp_set_case_status(3, 'under_review');    -- reopen
SELECT case_number, status, closed_at FROM investigation_case WHERE case_id = 3;

CALL sp_grant_access(5, 5);                    -- Lena joins case 5
CALL sp_revoke_access(5, 5);                   -- and leaves again (history is kept)
SELECT case_id, user_id, granted_at, revoked_at FROM case_assignment WHERE case_id = 5 ORDER BY user_id;

-- Direct DML on lookup tables (administrator account may do this):
INSERT INTO evidence_type (name, description) VALUES ('Temporary type', 'Created by the DML demo');
UPDATE evidence_type SET description = 'Created and edited by the DML demo' WHERE name = 'Temporary type';
INSERT INTO analysis_tool (name, version, description) VALUES ('DemoTool', '0.0.1', 'Demo only');
UPDATE analysis_tool SET version = '0.0.2' WHERE name = 'DemoTool';
DELETE FROM evidence_type WHERE name = 'Temporary type';     -- allowed: nothing references it
DELETE FROM analysis_tool WHERE name = 'DemoTool';           -- allowed: nothing references it
SELECT COUNT(*) AS types_left, (SELECT COUNT(*) FROM analysis_tool) AS tools_left FROM evidence_type;

-- ---------------------------------------------------------------------
-- H. Statements that MUST be rejected (each prints REJECTED and why)
-- ---------------------------------------------------------------------
SET @tracex_user_id = 1;

-- 1. Chain of custody cannot be edited (append-only trigger)
CALL demo_try('UPDATE custody_event SET reason = "edited later" WHERE evidence_id = 1 AND seq_no = 1');
-- 2. The audit log cannot be deleted from
CALL demo_try('DELETE FROM audit_log WHERE audit_id = 1');
-- 3. Evidence with history cannot be deleted (foreign keys)
CALL demo_try('DELETE FROM evidence WHERE evidence_id = 1');
-- 4. The hash of registered evidence is immutable (trigger)
CALL demo_try('UPDATE evidence SET sha256 = REPEAT("a", 64) WHERE evidence_id = 1');
-- 5. A case cannot be marked closed without a closing time (CHECK)
CALL demo_try('UPDATE investigation_case SET status = "closed", closed_at = NULL WHERE case_id = 1');
-- 6. An analysis cannot finish before it started (CHECK)
CALL demo_try('UPDATE analysis SET completed_at = "2000-01-01 00:00:00" WHERE analysis_id = 1');
-- 7. Links must stay inside one case (trigger): evidence 1 is case 1, 49 is case 5
CALL demo_try('CALL sp_link_evidence(1, 49, "other", "cross-case link")');
-- 8. The same file (hash) cannot be registered twice in one case (UNIQUE)
SELECT sha256 INTO @dupsha FROM evidence WHERE evidence_id = 49;
SET @tracex_user_id = 7;
CALL demo_try(CONCAT('CALL sp_register_evidence(5, NULL, 6, "Duplicate", "Same file again", NULL, "', @dupsha, '", 100, "2026-10-01 10:00:00", "Copy", NULL, NULL)'));
-- 9. Only the current custodian can transfer (Kofi does not hold the new item)
SET @tracex_user_id = 8;
CALL demo_try('CALL sp_transfer_custody(@new_ev, 6, "not mine to give")');
-- 10. Isha is not on case 5, so she cannot add evidence to it
SET @tracex_user_id = 3;
CALL demo_try('CALL sp_register_evidence(5, NULL, 6, "Intruder", "Not allowed", NULL, NULL, NULL, "2026-10-01 10:00:00", "Copy", NULL, NULL)');
-- 11. Administrators can add evidence to a closed case? No: closed means closed (case 4)
SET @tracex_user_id = 1;
CALL demo_try('CALL sp_register_evidence(4, NULL, 6, "After closing", "Not allowed", NULL, NULL, NULL, "2026-10-01 10:00:00", "Copy", NULL, NULL)');
-- 12. Nobody logged in
SET @tracex_user_id = NULL;
CALL demo_try('CALL sp_register_evidence(5, NULL, 6, "Anonymous", "Not allowed", NULL, NULL, NULL, "2026-10-01 10:00:00", "Copy", NULL, NULL)');

-- ---------------------------------------------------------------------
-- I. What the demo left in the outbox (the worker will process these)
-- ---------------------------------------------------------------------
SELECT operation, status, COUNT(*) AS jobs FROM index_job GROUP BY operation, status;
SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC;
