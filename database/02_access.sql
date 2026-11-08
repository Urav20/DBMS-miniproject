-- =====================================================================
-- TRACE-X  |  02_access.sql
-- Database-level role-based access control (rubric item 12).
-- Run AFTER 01_schema.sql:   mysql -u root -p < database/02_access.sql
--
-- HOW IT WORKS
--  * The app has three MySQL accounts, one per role:
--      tracex_admin_app         (Administrator users)
--      tracex_investigator_app  (Investigator users)
--      tracex_worker_app        (background indexing worker)
--  * The investigator account has NO access to the base tables. It can only
--    read the v_my_* views, which show rows from cases the logged-in user is
--    actively assigned to. Writes will go through stored procedures (step 4).
--  * After login, the app sets  SET @tracex_user_id = <user_id>;  on the
--    connection before each request. fn_current_user_id() reads it and the
--    views filter on it. If it is not set, the views return no rows.
--  * custody_event and audit_log are append-only for everyone: nobody is
--    granted UPDATE or DELETE on them.
--
-- LIMITATION (state it in the report): this protects against mistakes in
-- application queries and against direct table access with the investigator
-- account. It does not protect against a compromised app server, which could
-- set @tracex_user_id to any value.
--
-- CHANGE THE PASSWORDS below before any real use, and keep the real values
-- only in your local .env file, never in Git.
-- =====================================================================
USE tracex;

-- ---------------------------------------------------------------------
-- Session helper: who is the logged-in application user?
-- NO SQL is declared so the function can be created even when binary
-- logging is on.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_current_user_id;
DELIMITER $$
CREATE FUNCTION fn_current_user_id() RETURNS INT UNSIGNED
NO SQL
BEGIN
  RETURN @tracex_user_id;
END$$
DELIMITER ;

-- ---------------------------------------------------------------------
-- Views. They run with the privileges of the account that creates them
-- (SQL SECURITY DEFINER), which is what lets investigators read through
-- them without any right on the base tables.
-- ---------------------------------------------------------------------

-- Active access: assignment not revoked and user still active.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_user_case_access AS
SELECT ca.case_id, ca.user_id, ca.granted_at
FROM case_assignment ca
JOIN app_user u ON u.user_id = ca.user_id
WHERE ca.revoked_at IS NULL
  AND u.is_active = 1;

-- Cases the current user can see.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_my_cases AS
SELECT c.case_id, c.case_number, c.title, c.description, c.status,
       c.opened_at, c.closed_at, c.created_by
FROM investigation_case c
JOIN v_user_case_access a ON a.case_id = c.case_id
WHERE a.user_id = fn_current_user_id();

-- Evidence in those cases.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_my_evidence AS
SELECT e.evidence_id, e.evidence_no, e.case_id, e.source_id, e.type_id,
       e.title, e.description, e.extracted_text, e.sha256, e.file_size_bytes,
       e.status, e.registered_by, e.registered_at
FROM evidence e
JOIN v_user_case_access a ON a.case_id = e.case_id
WHERE a.user_id = fn_current_user_id();

-- Custody history of that evidence.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_my_custody AS
SELECT ce.evidence_id, ce.seq_no, ce.from_user_id, ce.to_user_id,
       ce.transferred_at, ce.reason
FROM custody_event ce
JOIN v_my_evidence me ON me.evidence_id = ce.evidence_id;

-- Collection details of that evidence.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_my_collection AS
SELECT co.collection_id, co.evidence_id, co.collected_by, co.collected_at,
       co.method, co.location, co.notes
FROM collection_event co
JOIN v_my_evidence me ON me.evidence_id = co.evidence_id;

-- Analyses and findings of that evidence.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_my_analyses AS
SELECT an.analysis_id, an.evidence_id, an.tool_id, an.analyst_id,
       an.started_at, an.completed_at, an.notes
FROM analysis an
JOIN v_my_evidence me ON me.evidence_id = an.evidence_id;

CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_my_findings AS
SELECT f.finding_id, f.analysis_id, f.title, f.description,
       f.severity, f.created_at
FROM finding f
JOIN v_my_analyses ma ON ma.analysis_id = f.analysis_id;

-- Recorded relationships where BOTH ends are visible to the user.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_my_relationships AS
SELECT r.rel_id, r.evidence_a_id, r.evidence_b_id, r.rel_type,
       r.rationale, r.recorded_by, r.recorded_at
FROM evidence_relationship r
JOIN v_my_evidence ea ON ea.evidence_id = r.evidence_a_id
JOIN v_my_evidence eb ON eb.evidence_id = r.evidence_b_id;

-- Current custodian per evidence item (the derived attribute from the ER
-- diagram). Not filtered by user: for administrators and the worker only.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_current_custody AS
SELECT ce.evidence_id, ce.seq_no, ce.to_user_id AS current_custodian_id,
       u.full_name AS current_custodian_name, ce.transferred_at
FROM custody_event ce
JOIN (SELECT evidence_id, MAX(seq_no) AS last_seq
      FROM custody_event
      GROUP BY evidence_id) latest
  ON latest.evidence_id = ce.evidence_id AND latest.last_seq = ce.seq_no
JOIN app_user u ON u.user_id = ce.to_user_id;

-- ---------------------------------------------------------------------
-- Roles (privilege bundles) and the accounts that use them
-- ---------------------------------------------------------------------
CREATE ROLE IF NOT EXISTS 'tracex_admin', 'tracex_investigator', 'tracex_worker';

-- Administrator: manages everything, but custody_event and audit_log are
-- append-only (SELECT and INSERT only). DELETE only on two lookup tables.
GRANT SELECT, INSERT, UPDATE ON tracex.`role`                  TO 'tracex_admin';
GRANT SELECT, INSERT, UPDATE ON tracex.app_user                TO 'tracex_admin';
GRANT SELECT, INSERT, UPDATE ON tracex.investigation_case      TO 'tracex_admin';
GRANT SELECT, INSERT, UPDATE ON tracex.case_assignment         TO 'tracex_admin';
GRANT SELECT, INSERT, UPDATE ON tracex.evidence_source         TO 'tracex_admin';
GRANT SELECT, INSERT, UPDATE, DELETE ON tracex.evidence_type   TO 'tracex_admin';
GRANT SELECT, INSERT, UPDATE ON tracex.evidence                TO 'tracex_admin';
GRANT SELECT, INSERT, UPDATE ON tracex.collection_event        TO 'tracex_admin';
GRANT SELECT, INSERT         ON tracex.custody_event           TO 'tracex_admin';
GRANT SELECT, INSERT, UPDATE, DELETE ON tracex.analysis_tool   TO 'tracex_admin';
GRANT SELECT, INSERT, UPDATE ON tracex.analysis                TO 'tracex_admin';
GRANT SELECT, INSERT, UPDATE ON tracex.finding                 TO 'tracex_admin';
GRANT SELECT, INSERT, UPDATE ON tracex.evidence_relationship   TO 'tracex_admin';
GRANT SELECT, INSERT         ON tracex.audit_log               TO 'tracex_admin';
GRANT SELECT, INSERT, UPDATE ON tracex.index_job               TO 'tracex_admin';
GRANT SELECT ON tracex.v_current_custody                       TO 'tracex_admin';

-- Investigator: only the filtered views plus two read-only lookup tables.
-- (EXECUTE on the write procedures is granted in step 4.)
GRANT SELECT ON tracex.v_my_cases          TO 'tracex_investigator';
GRANT SELECT ON tracex.v_my_evidence       TO 'tracex_investigator';
GRANT SELECT ON tracex.v_my_custody        TO 'tracex_investigator';
GRANT SELECT ON tracex.v_my_collection     TO 'tracex_investigator';
GRANT SELECT ON tracex.v_my_analyses       TO 'tracex_investigator';
GRANT SELECT ON tracex.v_my_findings       TO 'tracex_investigator';
GRANT SELECT ON tracex.v_my_relationships  TO 'tracex_investigator';
GRANT SELECT ON tracex.evidence_type       TO 'tracex_investigator';
GRANT SELECT ON tracex.analysis_tool       TO 'tracex_investigator';

-- Worker: reads the text to embed, updates only the indexing bookkeeping.
GRANT SELECT ON tracex.evidence TO 'tracex_worker';
GRANT SELECT ON tracex.finding  TO 'tracex_worker';
GRANT SELECT, INSERT, UPDATE ON tracex.index_job TO 'tracex_worker';
GRANT UPDATE (indexed_version, indexed_at) ON tracex.evidence TO 'tracex_worker';
GRANT UPDATE (indexed_version, indexed_at) ON tracex.finding  TO 'tracex_worker';
GRANT INSERT ON tracex.audit_log TO 'tracex_worker';

-- Accounts (placeholder passwords: CHANGE THEM).
CREATE USER IF NOT EXISTS 'tracex_admin_app'@'localhost'        IDENTIFIED BY 'change_me_admin';
CREATE USER IF NOT EXISTS 'tracex_investigator_app'@'localhost' IDENTIFIED BY 'change_me_investigator';
CREATE USER IF NOT EXISTS 'tracex_worker_app'@'localhost'       IDENTIFIED BY 'change_me_worker';

GRANT 'tracex_admin'        TO 'tracex_admin_app'@'localhost';
GRANT 'tracex_investigator' TO 'tracex_investigator_app'@'localhost';
GRANT 'tracex_worker'       TO 'tracex_worker_app'@'localhost';

SET DEFAULT ROLE 'tracex_admin'        TO 'tracex_admin_app'@'localhost';
SET DEFAULT ROLE 'tracex_investigator' TO 'tracex_investigator_app'@'localhost';
SET DEFAULT ROLE 'tracex_worker'       TO 'tracex_worker_app'@'localhost';
