-- =====================================================================
-- TRACE-X | 08_verify_database.sql
-- Read-only post-install verification. Run as a MySQL administrator
-- after 01_schema.sql, 02_access.sql, 03_routines.sql and seed_demo.sql.
-- This reports actual counts; it does not modify application data.
-- =====================================================================

USE tracex;

SELECT 'tables' AS check_name, COUNT(*) AS actual,
       15 AS expected, COUNT(*) = 15 AS passed
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE';

-- Count FK constraints, not referenced columns. The same-case evidence/source
-- relationship is composite (two column mappings but one FK constraint).
SELECT 'foreign_key_constraints' AS check_name,
       COUNT(DISTINCT TABLE_NAME, CONSTRAINT_NAME) AS actual,
       25 AS expected,
       COUNT(DISTINCT TABLE_NAME, CONSTRAINT_NAME) = 25 AS passed
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE()
  AND REFERENCED_TABLE_NAME IS NOT NULL;

SELECT 'views' AS check_name, COUNT(*) AS actual,
       12 AS expected, COUNT(*) = 12 AS passed
FROM information_schema.VIEWS
WHERE TABLE_SCHEMA = DATABASE();

-- Count the 15 TRACE-X procedures. The DML demo helper (demo_try) is
-- deliberately not part of the application routine count.
SELECT 'tracex_stored_procedures' AS check_name, COUNT(*) AS actual,
       15 AS expected, COUNT(*) = 15 AS passed
FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = DATABASE()
  AND ROUTINE_TYPE = 'PROCEDURE'
  AND LEFT(ROUTINE_NAME, 3) = 'sp_';

SELECT 'stored_functions' AS check_name, COUNT(*) AS actual,
       7 AS expected, COUNT(*) = 7 AS passed
FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_TYPE = 'FUNCTION';

SELECT 'triggers' AS check_name, COUNT(*) AS actual,
       12 AS expected, COUNT(*) = 12 AS passed
FROM information_schema.TRIGGERS
WHERE TRIGGER_SCHEMA = DATABASE();

-- The seed-only baseline is 60 evidence / 50 analysis / 73 findings /
-- 130 index jobs. database/04_dml.sql intentionally adds one evidence row,
-- one analysis, one finding and five outbox jobs. Detect that completed demo
-- record so the verifier accepts either supported state without hiding other
-- count mismatches. The DML-added record is soft-withdrawn at the end.
SET @dml_demo_completed = EXISTS (
  SELECT 1
  FROM evidence e
  JOIN analysis a ON a.evidence_id = e.evidence_id
  JOIN finding f ON f.analysis_id = a.analysis_id
  WHERE e.evidence_no = 'EV-005-13'
    AND e.status = 'withdrawn'
    AND f.title = 'Statement payments match the supplier amounts'
);

SELECT 'app_user' AS table_name, COUNT(*) AS actual, 8 AS expected,
       COUNT(*) = 8 AS passed FROM app_user
UNION ALL
SELECT 'investigation_case', COUNT(*), 5, COUNT(*) = 5 FROM investigation_case
UNION ALL
SELECT 'evidence', COUNT(*), IF(@dml_demo_completed, 61, 60),
       COUNT(*) = IF(@dml_demo_completed, 61, 60) FROM evidence
UNION ALL
SELECT 'analysis', COUNT(*), IF(@dml_demo_completed, 51, 50),
       COUNT(*) = IF(@dml_demo_completed, 51, 50) FROM analysis
UNION ALL
SELECT 'finding', COUNT(*), IF(@dml_demo_completed, 74, 73),
       COUNT(*) = IF(@dml_demo_completed, 74, 73) FROM finding
UNION ALL
SELECT 'index_job', COUNT(*), IF(@dml_demo_completed, 135, 130),
       COUNT(*) = IF(@dml_demo_completed, 135, 130) FROM index_job;

-- Investigator-facing contract: the content versions required by stale
-- vector verification must be exposed by both filtered views.
SELECT 'v_my_evidence.content_version' AS check_name,
       COUNT(*) AS actual,
       1 AS expected,
       COUNT(*) = 1 AS passed
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'v_my_evidence'
  AND COLUMN_NAME = 'content_version'
UNION ALL
SELECT 'v_my_findings.content_version', COUNT(*), 1, COUNT(*) = 1
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'v_my_findings'
  AND COLUMN_NAME = 'content_version';

-- Outbox breakdown: 57 active evidence + 73 findings should be queued
-- by the committed demo seed when loaded after 03_routines.sql.
SELECT operation, status, COUNT(*) AS jobs
FROM index_job
GROUP BY operation, status
ORDER BY operation, status;

-- This checks the grants attached to the investigator role. For the
-- actual account-level test, reconnect as tracex_investigator_app and
-- attempt SELECT * FROM app_user; it must be denied.
SHOW GRANTS FOR 'tracex_investigator'@'%';
