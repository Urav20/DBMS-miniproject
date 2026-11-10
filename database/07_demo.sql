-- =====================================================================
-- TRACE-X | 07_demo.sql
-- Read-only classroom walkthrough for the MySQL portion of TRACE-X.
--
-- Prerequisites: run 01_schema.sql, 02_access.sql, 03_routines.sql,
-- then load data/out/seed_demo.sql. Run this as an administrator/root
-- connection. This file does not modify application data.
--
-- For INSERT/UPDATE/DELETE and rejected-operation demonstrations, run
-- database/04_dml.sql separately; it intentionally changes demo data.
-- For the full query showcase (joins, subqueries, window functions,
-- recursive CTEs and FULLTEXT), run database/05_queries.sql separately.
-- =====================================================================

USE tracex;

-- 1. Relational structure: tables, primary keys, foreign keys.
SHOW TABLES;

SELECT TABLE_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE()
  AND REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY TABLE_NAME, CONSTRAINT_NAME;

-- 2. Demonstrate joined relational data: case, evidence, type, source
--    and current custodian.
SELECT e.evidence_no, c.case_number, e.title, et.name AS evidence_type,
       es.label AS source, cc.current_custodian_name
FROM evidence e
JOIN investigation_case c ON c.case_id = e.case_id
JOIN evidence_type et ON et.type_id = e.type_id
LEFT JOIN evidence_source es ON es.source_id = e.source_id
LEFT JOIN v_current_custody cc ON cc.evidence_id = e.evidence_id
WHERE c.case_number = 'TX-2026-005'
ORDER BY e.evidence_no
LIMIT 10;

-- 3. Demonstrate provenance: complete custody chain for one evidence item.
SELECT e.evidence_no, ce.seq_no,
       fu.username AS from_user, tu.username AS to_user,
       ce.transferred_at, ce.reason
FROM evidence e
JOIN custody_event ce ON ce.evidence_id = e.evidence_id
LEFT JOIN app_user fu ON fu.user_id = ce.from_user_id
JOIN app_user tu ON tu.user_id = ce.to_user_id
WHERE e.evidence_id = 49
ORDER BY ce.seq_no;

-- 4. Demonstrate analysis and findings.
SELECT e.evidence_no, a.analysis_id, a.started_at, a.completed_at,
       f.finding_id, f.title AS finding, f.severity
FROM evidence e
JOIN analysis a ON a.evidence_id = e.evidence_id
LEFT JOIN finding f ON f.analysis_id = a.analysis_id
WHERE e.case_id = 5
ORDER BY e.evidence_no, a.analysis_id, f.finding_id
LIMIT 20;

-- 5. Demonstrate the audit trail.
SELECT audit_id, actor_id, action, entity_type, entity_id, occurred_at
FROM audit_log
ORDER BY audit_id DESC
LIMIT 15;

-- 6. Demonstrate the MySQL-to-Qdrant outbox state.
SELECT status, operation, COUNT(*) AS jobs
FROM index_job
GROUP BY status, operation
ORDER BY status, operation;

-- 7. Demonstrate stored-program inventory.
SELECT ROUTINE_TYPE, ROUTINE_NAME
FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = DATABASE()
ORDER BY ROUTINE_TYPE, ROUTINE_NAME;

SELECT TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_TIMING
FROM information_schema.TRIGGERS
WHERE TRIGGER_SCHEMA = DATABASE()
ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME;

-- 8. Demonstrate investigator row filtering in this session.
--    User 3 is Isha in the committed demo data. This only changes a
--    session variable; it does not change stored database records.
SET @tracex_user_id = 3;

SELECT case_id, case_number, title, status
FROM v_my_cases
ORDER BY case_number;

SELECT evidence_id, evidence_no, title, status, content_version
FROM v_my_evidence
ORDER BY evidence_no
LIMIT 15;

-- 9. Run database/05_queries.sql for the dedicated query examples.
--    Run database/04_dml.sql only when you want the state-changing DML demo.
