-- =====================================================================
-- TRACE-X | 06_verify_access.sql
-- Run after 01_schema.sql, 02_access.sql, 03_routines.sql and seed_demo.sql.
-- This script is read-only apart from the session variable assignment.
-- =====================================================================

USE tracex;

-- 1. The three investigator-facing views must exist.
SELECT TABLE_NAME
FROM information_schema.VIEWS
WHERE TABLE_SCHEMA = 'tracex'
  AND TABLE_NAME IN (
    'v_my_current_custody',
    'v_my_users',
    'v_my_teammates'
  )
ORDER BY TABLE_NAME;
-- Expected: exactly 3 rows.

-- 2. Confirm the exact public columns consumed by the API contract.
SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'tracex'
  AND TABLE_NAME IN (
    'v_my_current_custody',
    'v_my_users',
    'v_my_teammates'
  )
ORDER BY TABLE_NAME, ORDINAL_POSITION;

-- 3. Inspect role-level grants. Investigators should have SELECT on the
--    three filtered views, but no direct SELECT on app_user/custody_event.
SHOW GRANTS FOR 'tracex_investigator'@'%';

-- 4. Check the seed-trigger outbox total.
--    Expected: 130 = 57 active evidence upserts + 73 finding upserts.
SELECT COUNT(*) AS index_job_count,
       COUNT(*) = 130 AS is_expected_130
FROM index_job;

-- 5. Exercise the view filters as a representative investigator.
--    User 3 is Isha in the committed demo data. Run this section with the
--    same session variable behavior used by the application.
SET @tracex_user_id = 3;

SELECT COUNT(*) AS visible_evidence
FROM v_my_evidence;

SELECT COUNT(*) AS visible_current_custody
FROM v_my_current_custody;

SELECT user_id, username, full_name
FROM v_my_users
ORDER BY full_name;

SELECT case_id, user_id, username, full_name
FROM v_my_teammates
ORDER BY case_id, full_name;

-- For a full privilege test, reconnect as tracex_investigator_app and repeat
-- the SELECT statements above after SET @tracex_user_id = 3. The following
-- direct base-table reads must fail with an access-denied error:
--   SELECT * FROM app_user;
--   SELECT * FROM custody_event;
