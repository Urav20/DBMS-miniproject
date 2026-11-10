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

SELECT 'foreign_keys' AS check_name, COUNT(*) AS actual,
       25 AS expected, COUNT(*) = 25 AS passed
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE()
  AND REFERENCED_TABLE_NAME IS NOT NULL;

SELECT 'views' AS check_name, COUNT(*) AS actual,
       12 AS expected, COUNT(*) = 12 AS passed
FROM information_schema.VIEWS
WHERE TABLE_SCHEMA = DATABASE();

SELECT 'stored_procedures' AS check_name, COUNT(*) AS actual,
       14 AS expected, COUNT(*) = 14 AS passed
FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_TYPE = 'PROCEDURE';

SELECT 'stored_functions' AS check_name, COUNT(*) AS actual,
       7 AS expected, COUNT(*) = 7 AS passed
FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_TYPE = 'FUNCTION';

SELECT 'triggers' AS check_name, COUNT(*) AS actual,
       12 AS expected, COUNT(*) = 12 AS passed
FROM information_schema.TRIGGERS
WHERE TRIGGER_SCHEMA = DATABASE();

-- Expected demo seed counts. A mismatch is reported, not hidden.
SELECT 'app_user' AS table_name, COUNT(*) AS actual, 8 AS expected,
       COUNT(*) = 8 AS passed FROM app_user
UNION ALL
SELECT 'investigation_case', COUNT(*), 5, COUNT(*) = 5 FROM investigation_case
UNION ALL
SELECT 'evidence', COUNT(*), 60, COUNT(*) = 60 FROM evidence
UNION ALL
SELECT 'analysis', COUNT(*), 50, COUNT(*) = 50 FROM analysis
UNION ALL
SELECT 'finding', COUNT(*), 73, COUNT(*) = 73 FROM finding
UNION ALL
SELECT 'index_job', COUNT(*), 130, COUNT(*) = 130 FROM index_job;

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
