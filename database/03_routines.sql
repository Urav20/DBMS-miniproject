-- =====================================================================
-- TRACE-X  |  03_routines.sql
-- Step 4: functions, triggers, stored procedures, extra views, grants.
-- (rubric item 8: procedure/function, trigger, CTE; item 12: RBAC)
--
-- Run order:  01_schema.sql, 02_access.sql, 03_routines.sql, then the seed.
-- (If you load 03 AFTER the seed, call sp_backfill_index_jobs() once as
--  admin so that existing rows get their index jobs.)
--
-- HOW WRITES WORK
--  * Investigators have no right on the base tables. They change data only
--    by calling the procedures below, which run as DEFINER (the account that
--    created them) and check permissions themselves.
--  * The acting user is ALWAYS fn_actor(), i.e. @tracex_user_id. It is never
--    a procedure argument, so a caller cannot act as somebody else.
--  * Every procedure that changes data writes an audit_log row in the same
--    transaction and rolls everything back on any error.
--
-- ERROR CODES (SQLSTATE 45000 with these MYSQL_ERRNO values; the Next.js API
-- maps them to HTTP statuses):
--   45001 access denied / not found     -> 403 / 404
--   45002 case is closed                -> 409
--   45003 business rule violated        -> 422
--   45010 append-only table             -> 405
--   45011 no logged-in user             -> 401
-- =====================================================================
USE tracex;

-- ---------------------------------------------------------------------
-- 1. Functions
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_actor;
DROP FUNCTION IF EXISTS fn_is_admin;
DROP FUNCTION IF EXISTS fn_is_assigned;
DROP FUNCTION IF EXISTS fn_can_access_case;
DROP FUNCTION IF EXISTS fn_case_closed;
DROP FUNCTION IF EXISTS fn_current_custodian_id;

DELIMITER $$

-- The logged-in user; raises an error when nobody is logged in or the
-- account is deactivated.
CREATE FUNCTION fn_actor() RETURNS INT UNSIGNED
READS SQL DATA
BEGIN
  DECLARE v_id     INT UNSIGNED;
  DECLARE v_active TINYINT(1);
  SET v_id = @tracex_user_id;
  IF v_id IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45011,
      MESSAGE_TEXT = 'No logged-in user (@tracex_user_id is not set)';
  END IF;
  SELECT is_active INTO v_active FROM app_user WHERE user_id = v_id;
  IF v_active IS NULL OR v_active = 0 THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45011,
      MESSAGE_TEXT = 'Unknown or deactivated user';
  END IF;
  RETURN v_id;
END$$

CREATE FUNCTION fn_is_admin(p_user_id INT UNSIGNED) RETURNS TINYINT(1)
READS SQL DATA
BEGIN
  DECLARE v_n INT;
  SELECT COUNT(*) INTO v_n
  FROM app_user u JOIN `role` r ON r.role_id = u.role_id
  WHERE u.user_id = p_user_id AND u.is_active = 1 AND r.role_name = 'Administrator';
  RETURN v_n > 0;
END$$

-- Explicit, active team membership (no admin shortcut).
CREATE FUNCTION fn_is_assigned(p_user_id INT UNSIGNED, p_case_id INT UNSIGNED) RETURNS TINYINT(1)
READS SQL DATA
BEGIN
  DECLARE v_n INT;
  SELECT COUNT(*) INTO v_n
  FROM case_assignment ca JOIN app_user u ON u.user_id = ca.user_id
  WHERE ca.user_id = p_user_id AND ca.case_id = p_case_id
    AND ca.revoked_at IS NULL AND u.is_active = 1;
  RETURN v_n > 0;
END$$

-- Administrators may act on any case; investigators only on assigned cases.
CREATE FUNCTION fn_can_access_case(p_user_id INT UNSIGNED, p_case_id INT UNSIGNED) RETURNS TINYINT(1)
READS SQL DATA
BEGIN
  RETURN fn_is_admin(p_user_id) OR fn_is_assigned(p_user_id, p_case_id);
END$$

CREATE FUNCTION fn_case_closed(p_case_id INT UNSIGNED) RETURNS TINYINT(1)
READS SQL DATA
BEGIN
  DECLARE v_status VARCHAR(20);
  SELECT status INTO v_status FROM investigation_case WHERE case_id = p_case_id;
  RETURN v_status = 'closed';
END$$

-- Derived attribute from the ER diagram: who holds the evidence now.
CREATE FUNCTION fn_current_custodian_id(p_evidence_id INT UNSIGNED) RETURNS INT UNSIGNED
READS SQL DATA
BEGIN
  DECLARE v_user INT UNSIGNED;
  SELECT to_user_id INTO v_user FROM custody_event
  WHERE evidence_id = p_evidence_id ORDER BY seq_no DESC LIMIT 1;
  RETURN v_user;
END$$

DELIMITER ;

-- ---------------------------------------------------------------------
-- 2. Triggers
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_evidence_ai;
DROP TRIGGER IF EXISTS trg_evidence_bu;
DROP TRIGGER IF EXISTS trg_evidence_au;
DROP TRIGGER IF EXISTS trg_finding_ai;
DROP TRIGGER IF EXISTS trg_finding_bu;
DROP TRIGGER IF EXISTS trg_finding_au;
DROP TRIGGER IF EXISTS trg_relationship_bi;
DROP TRIGGER IF EXISTS trg_relationship_bu;
DROP TRIGGER IF EXISTS trg_custody_bu;
DROP TRIGGER IF EXISTS trg_custody_bd;
DROP TRIGGER IF EXISTS trg_audit_bu;
DROP TRIGGER IF EXISTS trg_audit_bd;

DELIMITER $$

-- New active evidence -> queue an upsert for Qdrant (outbox pattern).
CREATE TRIGGER trg_evidence_ai AFTER INSERT ON evidence
FOR EACH ROW
BEGIN
  IF NEW.status = 'active' THEN
    INSERT INTO index_job (evidence_id, operation, content_version)
    VALUES (NEW.evidence_id, 'upsert', NEW.content_version);
  END IF;
END$$

-- Integrity rules and the version bump when searchable text changes.
CREATE TRIGGER trg_evidence_bu BEFORE UPDATE ON evidence
FOR EACH ROW
BEGIN
  IF NOT (NEW.sha256 <=> OLD.sha256)
     OR NEW.case_id <> OLD.case_id
     OR NEW.evidence_no <> OLD.evidence_no THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003,
      MESSAGE_TEXT = 'Evidence number, case and SHA-256 are immutable';
  END IF;
  IF OLD.status = 'withdrawn' AND NEW.status = 'active' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003,
      MESSAGE_TEXT = 'Withdrawn evidence cannot be reactivated';
  END IF;
  IF NOT (NEW.title <=> OLD.title)
     OR NOT (NEW.description <=> OLD.description)
     OR NOT (NEW.extracted_text <=> OLD.extracted_text) THEN
    SET NEW.content_version = OLD.content_version + 1;
  END IF;
END$$

-- Text changed -> re-embed; withdrawn -> delete the vectors of the item
-- and of its findings.
CREATE TRIGGER trg_evidence_au AFTER UPDATE ON evidence
FOR EACH ROW
BEGIN
  IF OLD.status = 'active' AND NEW.status = 'withdrawn' THEN
    INSERT INTO index_job (evidence_id, operation, content_version)
    VALUES (NEW.evidence_id, 'delete', NEW.content_version);
    INSERT INTO index_job (finding_id, operation, content_version)
    SELECT f.finding_id, 'delete', f.content_version
    FROM finding f JOIN analysis a ON a.analysis_id = f.analysis_id
    WHERE a.evidence_id = NEW.evidence_id;
  ELSEIF NEW.status = 'active' AND NEW.content_version <> OLD.content_version THEN
    INSERT INTO index_job (evidence_id, operation, content_version)
    VALUES (NEW.evidence_id, 'upsert', NEW.content_version);
  END IF;
END$$

CREATE TRIGGER trg_finding_ai AFTER INSERT ON finding
FOR EACH ROW
BEGIN
  INSERT INTO index_job (finding_id, operation, content_version)
  VALUES (NEW.finding_id, 'upsert', NEW.content_version);
END$$

CREATE TRIGGER trg_finding_bu BEFORE UPDATE ON finding
FOR EACH ROW
BEGIN
  IF NEW.analysis_id <> OLD.analysis_id THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003,
      MESSAGE_TEXT = 'A finding cannot be moved to another analysis';
  END IF;
  IF NOT (NEW.title <=> OLD.title) OR NOT (NEW.description <=> OLD.description) THEN
    SET NEW.content_version = OLD.content_version + 1;
  END IF;
END$$

CREATE TRIGGER trg_finding_au AFTER UPDATE ON finding
FOR EACH ROW
BEGIN
  IF NEW.content_version <> OLD.content_version THEN
    INSERT INTO index_job (finding_id, operation, content_version)
    VALUES (NEW.finding_id, 'upsert', NEW.content_version);
  END IF;
END$$

-- Both ends of a link must be in the same case (kept out of the table
-- design to preserve 3NF, so a trigger enforces it).
CREATE TRIGGER trg_relationship_bi BEFORE INSERT ON evidence_relationship
FOR EACH ROW
BEGIN
  DECLARE v_case_a INT UNSIGNED;
  DECLARE v_case_b INT UNSIGNED;
  SELECT case_id INTO v_case_a FROM evidence WHERE evidence_id = NEW.evidence_a_id;
  SELECT case_id INTO v_case_b FROM evidence WHERE evidence_id = NEW.evidence_b_id;
  IF v_case_a IS NULL OR v_case_b IS NULL OR v_case_a <> v_case_b THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003,
      MESSAGE_TEXT = 'Linked evidence must belong to the same case';
  END IF;
END$$

CREATE TRIGGER trg_relationship_bu BEFORE UPDATE ON evidence_relationship
FOR EACH ROW
BEGIN
  DECLARE v_case_a INT UNSIGNED;
  DECLARE v_case_b INT UNSIGNED;
  SELECT case_id INTO v_case_a FROM evidence WHERE evidence_id = NEW.evidence_a_id;
  SELECT case_id INTO v_case_b FROM evidence WHERE evidence_id = NEW.evidence_b_id;
  IF v_case_a IS NULL OR v_case_b IS NULL OR v_case_a <> v_case_b THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003,
      MESSAGE_TEXT = 'Linked evidence must belong to the same case';
  END IF;
END$$

-- Append-only tables: even a privileged account cannot edit history.
CREATE TRIGGER trg_custody_bu BEFORE UPDATE ON custody_event
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45010,
    MESSAGE_TEXT = 'custody_event is append-only: updates are not allowed';
END$$

CREATE TRIGGER trg_custody_bd BEFORE DELETE ON custody_event
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45010,
    MESSAGE_TEXT = 'custody_event is append-only: deletes are not allowed';
END$$

CREATE TRIGGER trg_audit_bu BEFORE UPDATE ON audit_log
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45010,
    MESSAGE_TEXT = 'audit_log is append-only: updates are not allowed';
END$$

CREATE TRIGGER trg_audit_bd BEFORE DELETE ON audit_log
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45010,
    MESSAGE_TEXT = 'audit_log is append-only: deletes are not allowed';
END$$

DELIMITER ;

-- ---------------------------------------------------------------------
-- 3. Extra views for the investigator UI
-- ---------------------------------------------------------------------
-- People who share at least one active case with the current user
-- (for the "transfer custody to ..." picker).
CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_my_teammates AS
SELECT DISTINCT u.user_id, u.username, u.full_name, a2.case_id
FROM v_user_case_access a1
JOIN v_user_case_access a2 ON a2.case_id = a1.case_id
JOIN app_user u ON u.user_id = a2.user_id
WHERE a1.user_id = fn_current_user_id();

-- Visible evidence together with its current custodian.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_my_current_custody AS
SELECT me.evidence_id, cc.current_custodian_id, cc.current_custodian_name, cc.transferred_at
FROM v_my_evidence me
JOIN v_current_custody cc ON cc.evidence_id = me.evidence_id;

-- Names for every user id the investigator can see in custody/audit rows.
CREATE OR REPLACE SQL SECURITY DEFINER VIEW v_my_users AS
SELECT DISTINCT u.user_id, u.username, u.full_name
FROM app_user u
WHERE u.user_id IN (SELECT user_id FROM v_my_teammates)
   OR u.user_id IN (SELECT from_user_id FROM v_my_custody WHERE from_user_id IS NOT NULL)
   OR u.user_id IN (SELECT to_user_id   FROM v_my_custody)
   OR u.user_id IN (SELECT collected_by FROM v_my_collection)
   OR u.user_id IN (SELECT analyst_id   FROM v_my_analyses);

-- ---------------------------------------------------------------------
-- 4. Stored procedures: writes
-- ---------------------------------------------------------------------
DROP PROCEDURE IF EXISTS sp_register_evidence;
DROP PROCEDURE IF EXISTS sp_transfer_custody;
DROP PROCEDURE IF EXISTS sp_update_evidence_text;
DROP PROCEDURE IF EXISTS sp_withdraw_evidence;
DROP PROCEDURE IF EXISTS sp_record_analysis;
DROP PROCEDURE IF EXISTS sp_complete_analysis;
DROP PROCEDURE IF EXISTS sp_add_finding;
DROP PROCEDURE IF EXISTS sp_link_evidence;
DROP PROCEDURE IF EXISTS sp_create_case;
DROP PROCEDURE IF EXISTS sp_grant_access;
DROP PROCEDURE IF EXISTS sp_revoke_access;
DROP PROCEDURE IF EXISTS sp_set_case_status;
DROP PROCEDURE IF EXISTS sp_backfill_index_jobs;
DROP PROCEDURE IF EXISTS sp_linked_evidence;

DELIMITER $$

-- Register a new evidence item: evidence + collection event + custody
-- event 1 + audit row, atomically. The trigger queues the Qdrant job.
CREATE PROCEDURE sp_register_evidence(
  IN p_case_id        INT UNSIGNED,
  IN p_source_id      INT UNSIGNED,
  IN p_type_id        TINYINT UNSIGNED,
  IN p_title          VARCHAR(200),
  IN p_description    TEXT,
  IN p_extracted_text MEDIUMTEXT,
  IN p_sha256         VARCHAR(100),
  IN p_file_size      BIGINT UNSIGNED,
  IN p_collected_at   DATETIME,
  IN p_method         VARCHAR(100),
  IN p_location       VARCHAR(150),
  IN p_notes          TEXT)
SQL SECURITY DEFINER
BEGIN
  DECLARE v_actor INT UNSIGNED;
  DECLARE v_case_number VARCHAR(30);
  DECLARE v_n INT;
  DECLARE v_no VARCHAR(30);
  DECLARE v_id INT UNSIGNED;
  DECLARE v_sha VARCHAR(100);
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SET v_actor = fn_actor();
  IF NOT fn_can_access_case(v_actor, p_case_id) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45001, MESSAGE_TEXT = 'Case not found or access denied';
  END IF;
  IF fn_case_closed(p_case_id) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45002, MESSAGE_TEXT = 'Case is closed: no changes allowed';
  END IF;
  IF p_title IS NULL OR TRIM(p_title) = '' OR p_description IS NULL OR TRIM(p_description) = '' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Title and description are required';
  END IF;
  IF p_collected_at IS NULL OR p_collected_at > NOW() OR p_method IS NULL OR TRIM(p_method) = '' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003,
      MESSAGE_TEXT = 'Collection time (not in the future) and method are required';
  END IF;
  IF p_source_id IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM evidence_source WHERE source_id = p_source_id AND case_id = p_case_id) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Source does not belong to this case';
  END IF;
  SET v_sha = NULLIF(LOWER(TRIM(p_sha256)), '');

  START TRANSACTION;
  -- Lock the case row so two registrations cannot take the same number.
  SELECT case_number INTO v_case_number FROM investigation_case WHERE case_id = p_case_id FOR UPDATE;
  SELECT COUNT(*) + 1 INTO v_n FROM evidence WHERE case_id = p_case_id;
  SET v_no = CONCAT('EV-', RIGHT(v_case_number, 3), '-', LPAD(v_n, 2, '0'));

  INSERT INTO evidence (evidence_no, case_id, source_id, type_id, title, description,
                        extracted_text, sha256, file_size_bytes, registered_by)
  VALUES (v_no, p_case_id, p_source_id, p_type_id, TRIM(p_title), p_description,
          p_extracted_text, v_sha, p_file_size, v_actor);
  SET v_id = LAST_INSERT_ID();

  INSERT INTO collection_event (evidence_id, collected_by, collected_at, method, location, notes)
  VALUES (v_id, v_actor, p_collected_at, p_method, p_location, p_notes);

  INSERT INTO custody_event (evidence_id, seq_no, from_user_id, to_user_id, reason)
  VALUES (v_id, 1, NULL, v_actor, 'Initial intake after collection');

  INSERT INTO audit_log (user_id, case_id, action, entity_type, entity_id, details)
  VALUES (v_actor, p_case_id, 'evidence.register', 'evidence', v_id,
          JSON_OBJECT('evidence_no', v_no));
  COMMIT;

  SELECT v_id AS evidence_id, v_no AS evidence_no;
END$$

-- Hand evidence to a colleague. Only the current custodian may do this.
-- The row lock makes concurrent transfers of the same item queue up.
CREATE PROCEDURE sp_transfer_custody(
  IN p_evidence_id INT UNSIGNED,
  IN p_to_user_id  INT UNSIGNED,
  IN p_reason      VARCHAR(255))
SQL SECURITY DEFINER
BEGIN
  DECLARE v_actor  INT UNSIGNED;
  DECLARE v_case   INT UNSIGNED;
  DECLARE v_status VARCHAR(20);
  DECLARE v_seq    INT UNSIGNED;
  DECLARE v_holder INT UNSIGNED;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SET v_actor = fn_actor();
  START TRANSACTION;
  SELECT case_id, status INTO v_case, v_status
  FROM evidence WHERE evidence_id = p_evidence_id FOR UPDATE;
  IF v_case IS NULL OR NOT fn_can_access_case(v_actor, v_case) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45001, MESSAGE_TEXT = 'Evidence not found or access denied';
  END IF;
  IF fn_case_closed(v_case) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45002, MESSAGE_TEXT = 'Case is closed: no changes allowed';
  END IF;
  IF v_status <> 'active' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Withdrawn evidence cannot be transferred';
  END IF;

  SELECT seq_no, to_user_id INTO v_seq, v_holder
  FROM custody_event WHERE evidence_id = p_evidence_id ORDER BY seq_no DESC LIMIT 1;
  IF v_holder <> v_actor THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003,
      MESSAGE_TEXT = 'Only the current custodian can transfer this evidence';
  END IF;
  IF p_to_user_id = v_actor THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Cannot transfer evidence to yourself';
  END IF;
  IF NOT fn_is_assigned(p_to_user_id, v_case) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003,
      MESSAGE_TEXT = 'Receiver is not an active member of this case';
  END IF;

  INSERT INTO custody_event (evidence_id, seq_no, from_user_id, to_user_id, reason)
  VALUES (p_evidence_id, v_seq + 1, v_holder, p_to_user_id, p_reason);

  INSERT INTO audit_log (user_id, case_id, action, entity_type, entity_id, details)
  VALUES (v_actor, v_case, 'custody.transfer', 'custody_event', p_evidence_id,
          JSON_OBJECT('seq', v_seq + 1, 'to_user_id', p_to_user_id));
  COMMIT;

  SELECT p_evidence_id AS evidence_id, v_seq + 1 AS seq_no;
END$$

-- Edit the searchable text. The trigger bumps content_version and queues
-- the re-embedding job (the "Update" of vector CRUD).
CREATE PROCEDURE sp_update_evidence_text(
  IN p_evidence_id    INT UNSIGNED,
  IN p_title          VARCHAR(200),
  IN p_description    TEXT,
  IN p_extracted_text MEDIUMTEXT)
SQL SECURITY DEFINER
BEGIN
  DECLARE v_actor   INT UNSIGNED;
  DECLARE v_case    INT UNSIGNED;
  DECLARE v_status  VARCHAR(20);
  DECLARE v_version INT UNSIGNED;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SET v_actor = fn_actor();
  START TRANSACTION;
  SELECT case_id, status INTO v_case, v_status
  FROM evidence WHERE evidence_id = p_evidence_id FOR UPDATE;
  IF v_case IS NULL OR NOT fn_can_access_case(v_actor, v_case) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45001, MESSAGE_TEXT = 'Evidence not found or access denied';
  END IF;
  IF fn_case_closed(v_case) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45002, MESSAGE_TEXT = 'Case is closed: no changes allowed';
  END IF;
  IF v_status <> 'active' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Withdrawn evidence cannot be edited';
  END IF;
  IF p_title IS NULL OR TRIM(p_title) = '' OR p_description IS NULL OR TRIM(p_description) = '' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Title and description are required';
  END IF;

  UPDATE evidence
  SET title = TRIM(p_title), description = p_description, extracted_text = p_extracted_text
  WHERE evidence_id = p_evidence_id;

  SELECT content_version INTO v_version FROM evidence WHERE evidence_id = p_evidence_id;
  INSERT INTO audit_log (user_id, case_id, action, entity_type, entity_id, details)
  VALUES (v_actor, v_case, 'evidence.update', 'evidence', p_evidence_id,
          JSON_OBJECT('content_version', v_version));
  COMMIT;

  SELECT p_evidence_id AS evidence_id, v_version AS content_version;
END$$

-- Withdraw (soft-delete) evidence: the row stays for the record, its
-- vectors are removed by the queued delete jobs. Registrant or admin only.
CREATE PROCEDURE sp_withdraw_evidence(
  IN p_evidence_id INT UNSIGNED,
  IN p_reason      VARCHAR(255))
SQL SECURITY DEFINER
BEGIN
  DECLARE v_actor  INT UNSIGNED;
  DECLARE v_case   INT UNSIGNED;
  DECLARE v_status VARCHAR(20);
  DECLARE v_reg    INT UNSIGNED;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SET v_actor = fn_actor();
  START TRANSACTION;
  SELECT case_id, status, registered_by INTO v_case, v_status, v_reg
  FROM evidence WHERE evidence_id = p_evidence_id FOR UPDATE;
  IF v_case IS NULL OR NOT fn_can_access_case(v_actor, v_case) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45001, MESSAGE_TEXT = 'Evidence not found or access denied';
  END IF;
  IF fn_case_closed(v_case) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45002, MESSAGE_TEXT = 'Case is closed: no changes allowed';
  END IF;
  IF v_status = 'withdrawn' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Evidence is already withdrawn';
  END IF;
  IF v_reg <> v_actor AND NOT fn_is_admin(v_actor) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003,
      MESSAGE_TEXT = 'Only the registering user or an administrator can withdraw evidence';
  END IF;
  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'A reason is required';
  END IF;

  UPDATE evidence SET status = 'withdrawn' WHERE evidence_id = p_evidence_id;
  INSERT INTO audit_log (user_id, case_id, action, entity_type, entity_id, details)
  VALUES (v_actor, v_case, 'evidence.withdraw', 'evidence', p_evidence_id,
          JSON_OBJECT('reason', p_reason));
  COMMIT;

  SELECT p_evidence_id AS evidence_id, 'withdrawn' AS status;
END$$

-- Start an analysis session on an evidence item.
CREATE PROCEDURE sp_record_analysis(
  IN p_evidence_id INT UNSIGNED,
  IN p_tool_id     INT UNSIGNED,
  IN p_notes       TEXT)
SQL SECURITY DEFINER
BEGIN
  DECLARE v_actor  INT UNSIGNED;
  DECLARE v_case   INT UNSIGNED;
  DECLARE v_status VARCHAR(20);
  DECLARE v_id     INT UNSIGNED;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SET v_actor = fn_actor();
  START TRANSACTION;
  SELECT case_id, status INTO v_case, v_status
  FROM evidence WHERE evidence_id = p_evidence_id FOR UPDATE;
  IF v_case IS NULL OR NOT fn_can_access_case(v_actor, v_case) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45001, MESSAGE_TEXT = 'Evidence not found or access denied';
  END IF;
  IF fn_case_closed(v_case) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45002, MESSAGE_TEXT = 'Case is closed: no changes allowed';
  END IF;
  IF v_status <> 'active' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Cannot analyse withdrawn evidence';
  END IF;

  INSERT INTO analysis (evidence_id, tool_id, analyst_id, notes)
  VALUES (p_evidence_id, p_tool_id, v_actor, p_notes);
  SET v_id = LAST_INSERT_ID();
  INSERT INTO audit_log (user_id, case_id, action, entity_type, entity_id, details)
  VALUES (v_actor, v_case, 'analysis.record', 'analysis', v_id, JSON_OBJECT('tool_id', p_tool_id));
  COMMIT;

  SELECT v_id AS analysis_id;
END$$

-- Mark your own analysis as completed.
CREATE PROCEDURE sp_complete_analysis(IN p_analysis_id INT UNSIGNED)
SQL SECURITY DEFINER
BEGIN
  DECLARE v_actor   INT UNSIGNED;
  DECLARE v_case    INT UNSIGNED;
  DECLARE v_analyst INT UNSIGNED;
  DECLARE v_done    DATETIME;
  DECLARE v_found   INT UNSIGNED;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SET v_actor = fn_actor();
  START TRANSACTION;
  SELECT a.analysis_id, e.case_id, a.analyst_id, a.completed_at
    INTO v_found, v_case, v_analyst, v_done
  FROM analysis a JOIN evidence e ON e.evidence_id = a.evidence_id
  WHERE a.analysis_id = p_analysis_id FOR UPDATE;
  IF v_found IS NULL OR NOT fn_can_access_case(v_actor, v_case) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45001, MESSAGE_TEXT = 'Analysis not found or access denied';
  END IF;
  IF fn_case_closed(v_case) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45002, MESSAGE_TEXT = 'Case is closed: no changes allowed';
  END IF;
  IF v_analyst <> v_actor THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Only the analyst can complete this analysis';
  END IF;
  IF v_done IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Analysis is already completed';
  END IF;

  UPDATE analysis SET completed_at = NOW() WHERE analysis_id = p_analysis_id;
  INSERT INTO audit_log (user_id, case_id, action, entity_type, entity_id, details)
  VALUES (v_actor, v_case, 'analysis.complete', 'analysis', p_analysis_id, JSON_OBJECT());
  COMMIT;

  SELECT p_analysis_id AS analysis_id;
END$$

-- Record a finding of an analysis (queued for indexing by the trigger).
CREATE PROCEDURE sp_add_finding(
  IN p_analysis_id INT UNSIGNED,
  IN p_title       VARCHAR(200),
  IN p_description TEXT,
  IN p_severity    VARCHAR(10))
SQL SECURITY DEFINER
BEGIN
  DECLARE v_actor INT UNSIGNED;
  DECLARE v_case  INT UNSIGNED;
  DECLARE v_found INT UNSIGNED;
  DECLARE v_id    INT UNSIGNED;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SET v_actor = fn_actor();
  SELECT a.analysis_id, e.case_id INTO v_found, v_case
  FROM analysis a JOIN evidence e ON e.evidence_id = a.evidence_id
  WHERE a.analysis_id = p_analysis_id;
  IF v_found IS NULL OR NOT fn_can_access_case(v_actor, v_case) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45001, MESSAGE_TEXT = 'Analysis not found or access denied';
  END IF;
  IF fn_case_closed(v_case) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45002, MESSAGE_TEXT = 'Case is closed: no changes allowed';
  END IF;
  IF p_title IS NULL OR TRIM(p_title) = '' OR p_description IS NULL OR TRIM(p_description) = '' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Title and description are required';
  END IF;
  IF p_severity NOT IN ('info','low','medium','high','critical') THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003,
      MESSAGE_TEXT = 'Severity must be info, low, medium, high or critical';
  END IF;

  START TRANSACTION;
  INSERT INTO finding (analysis_id, title, description, severity)
  VALUES (p_analysis_id, TRIM(p_title), p_description, p_severity);
  SET v_id = LAST_INSERT_ID();
  INSERT INTO audit_log (user_id, case_id, action, entity_type, entity_id, details)
  VALUES (v_actor, v_case, 'finding.add', 'finding', v_id, JSON_OBJECT('severity', p_severity));
  COMMIT;

  SELECT v_id AS finding_id;
END$$

-- Record that two evidence items of the same case are related.
CREATE PROCEDURE sp_link_evidence(
  IN p_a_id      INT UNSIGNED,
  IN p_b_id      INT UNSIGNED,
  IN p_rel_type  VARCHAR(20),
  IN p_rationale TEXT)
SQL SECURITY DEFINER
BEGIN
  DECLARE v_actor  INT UNSIGNED;
  DECLARE v_case_a INT UNSIGNED;
  DECLARE v_case_b INT UNSIGNED;
  DECLARE v_id     INT UNSIGNED;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SET v_actor = fn_actor();
  SELECT case_id INTO v_case_a FROM evidence WHERE evidence_id = p_a_id;
  SELECT case_id INTO v_case_b FROM evidence WHERE evidence_id = p_b_id;
  IF v_case_a IS NULL OR v_case_b IS NULL
     OR NOT fn_can_access_case(v_actor, v_case_a)
     OR NOT fn_can_access_case(v_actor, v_case_b) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45001, MESSAGE_TEXT = 'Evidence not found or access denied';
  END IF;
  IF fn_case_closed(v_case_a) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45002, MESSAGE_TEXT = 'Case is closed: no changes allowed';
  END IF;
  IF p_rationale IS NULL OR TRIM(p_rationale) = '' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'A rationale is required';
  END IF;
  IF p_rel_type NOT IN ('derived_from','corroborates','contradicts','related_activity','other') THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Unknown relationship type';
  END IF;

  START TRANSACTION;
  INSERT INTO evidence_relationship (evidence_a_id, evidence_b_id, rel_type, rationale, recorded_by)
  VALUES (p_a_id, p_b_id, p_rel_type, p_rationale, v_actor);   -- trigger checks same case
  SET v_id = LAST_INSERT_ID();
  INSERT INTO audit_log (user_id, case_id, action, entity_type, entity_id, details)
  VALUES (v_actor, v_case_a, 'evidence.link', 'evidence_relationship', v_id,
          JSON_OBJECT('type', p_rel_type));
  COMMIT;

  SELECT v_id AS rel_id;
END$$

-- ---------------------------------------------------------------------
-- Administrator procedures
-- ---------------------------------------------------------------------
CREATE PROCEDURE sp_create_case(
  IN p_case_number VARCHAR(30),
  IN p_title       VARCHAR(200),
  IN p_description TEXT)
SQL SECURITY DEFINER
BEGIN
  DECLARE v_actor INT UNSIGNED;
  DECLARE v_id    INT UNSIGNED;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SET v_actor = fn_actor();
  IF NOT fn_is_admin(v_actor) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45001, MESSAGE_TEXT = 'Administrator rights required';
  END IF;
  IF p_case_number IS NULL OR TRIM(p_case_number) = '' OR p_title IS NULL OR TRIM(p_title) = '' THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Case number and title are required';
  END IF;

  START TRANSACTION;
  INSERT INTO investigation_case (case_number, title, description, created_by)
  VALUES (TRIM(p_case_number), TRIM(p_title), p_description, v_actor);
  SET v_id = LAST_INSERT_ID();
  INSERT INTO audit_log (user_id, case_id, action, entity_type, entity_id, details)
  VALUES (v_actor, v_id, 'case.create', 'investigation_case', v_id,
          JSON_OBJECT('case_number', TRIM(p_case_number)));
  COMMIT;

  SELECT v_id AS case_id;
END$$

-- Give a user access to a case (re-grants a revoked assignment).
CREATE PROCEDURE sp_grant_access(IN p_case_id INT UNSIGNED, IN p_user_id INT UNSIGNED)
SQL SECURITY DEFINER
BEGIN
  DECLARE v_actor INT UNSIGNED;
  DECLARE v_revoked DATETIME;
  DECLARE v_exists INT;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SET v_actor = fn_actor();
  IF NOT fn_is_admin(v_actor) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45001, MESSAGE_TEXT = 'Administrator rights required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM investigation_case WHERE case_id = p_case_id)
     OR NOT EXISTS (SELECT 1 FROM app_user WHERE user_id = p_user_id AND is_active = 1) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Unknown case or inactive user';
  END IF;

  START TRANSACTION;
  SELECT COUNT(*), MAX(revoked_at) INTO v_exists, v_revoked
  FROM case_assignment WHERE case_id = p_case_id AND user_id = p_user_id;
  IF v_exists = 0 THEN
    INSERT INTO case_assignment (case_id, user_id) VALUES (p_case_id, p_user_id);
  ELSEIF v_revoked IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'User already has access to this case';
  ELSE
    UPDATE case_assignment SET granted_at = NOW(), revoked_at = NULL
    WHERE case_id = p_case_id AND user_id = p_user_id;
  END IF;
  INSERT INTO audit_log (user_id, case_id, action, entity_type, entity_id, details)
  VALUES (v_actor, p_case_id, 'access.grant', 'case_assignment', p_user_id,
          JSON_OBJECT('user_id', p_user_id));
  COMMIT;

  SELECT p_case_id AS case_id, p_user_id AS user_id;
END$$

CREATE PROCEDURE sp_revoke_access(IN p_case_id INT UNSIGNED, IN p_user_id INT UNSIGNED)
SQL SECURITY DEFINER
BEGIN
  DECLARE v_actor INT UNSIGNED;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SET v_actor = fn_actor();
  IF NOT fn_is_admin(v_actor) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45001, MESSAGE_TEXT = 'Administrator rights required';
  END IF;

  START TRANSACTION;
  UPDATE case_assignment SET revoked_at = NOW()
  WHERE case_id = p_case_id AND user_id = p_user_id AND revoked_at IS NULL;
  IF ROW_COUNT() = 0 THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'No active access to revoke';
  END IF;
  INSERT INTO audit_log (user_id, case_id, action, entity_type, entity_id, details)
  VALUES (v_actor, p_case_id, 'access.revoke', 'case_assignment', p_user_id,
          JSON_OBJECT('user_id', p_user_id));
  COMMIT;

  SELECT p_case_id AS case_id, p_user_id AS user_id;
END$$

-- open / under_review / closed (closed_at is kept consistent with status).
CREATE PROCEDURE sp_set_case_status(IN p_case_id INT UNSIGNED, IN p_status VARCHAR(20))
SQL SECURITY DEFINER
BEGIN
  DECLARE v_actor INT UNSIGNED;
  DECLARE v_old   VARCHAR(20);
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SET v_actor = fn_actor();
  IF NOT fn_is_admin(v_actor) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45001, MESSAGE_TEXT = 'Administrator rights required';
  END IF;
  IF p_status NOT IN ('open','under_review','closed') THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Status must be open, under_review or closed';
  END IF;

  START TRANSACTION;
  SELECT status INTO v_old FROM investigation_case WHERE case_id = p_case_id FOR UPDATE;
  IF v_old IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Unknown case';
  END IF;
  IF v_old = p_status THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45003, MESSAGE_TEXT = 'Case already has this status';
  END IF;
  UPDATE investigation_case
  SET status = p_status,
      closed_at = IF(p_status = 'closed', NOW(), NULL)
  WHERE case_id = p_case_id;
  INSERT INTO audit_log (user_id, case_id, action, entity_type, entity_id, details)
  VALUES (v_actor, p_case_id, 'case.status', 'investigation_case', p_case_id,
          JSON_OBJECT('from', v_old, 'to', p_status));
  COMMIT;

  SELECT p_case_id AS case_id, p_status AS status;
END$$

-- Queue upsert jobs for every active record whose vector is missing or
-- stale ("Re-index everything" button; also fixes a seed loaded before 03).
CREATE PROCEDURE sp_backfill_index_jobs()
SQL SECURITY DEFINER
BEGIN
  DECLARE v_actor INT UNSIGNED;
  DECLARE v_ev    INT DEFAULT 0;
  DECLARE v_fi    INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SET v_actor = fn_actor();
  IF NOT fn_is_admin(v_actor) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45001, MESSAGE_TEXT = 'Administrator rights required';
  END IF;

  START TRANSACTION;
  INSERT INTO index_job (evidence_id, operation, content_version)
  SELECT e.evidence_id, 'upsert', e.content_version
  FROM evidence e
  WHERE e.status = 'active'
    AND (e.indexed_version IS NULL OR e.indexed_version < e.content_version)
    AND NOT EXISTS (SELECT 1 FROM index_job j
                    WHERE j.evidence_id = e.evidence_id AND j.operation = 'upsert'
                      AND j.content_version = e.content_version
                      AND j.status IN ('pending','processing'));
  SET v_ev = ROW_COUNT();

  INSERT INTO index_job (finding_id, operation, content_version)
  SELECT f.finding_id, 'upsert', f.content_version
  FROM finding f
  JOIN analysis a ON a.analysis_id = f.analysis_id
  JOIN evidence e ON e.evidence_id = a.evidence_id
  WHERE e.status = 'active'
    AND (f.indexed_version IS NULL OR f.indexed_version < f.content_version)
    AND NOT EXISTS (SELECT 1 FROM index_job j
                    WHERE j.finding_id = f.finding_id AND j.operation = 'upsert'
                      AND j.content_version = f.content_version
                      AND j.status IN ('pending','processing'));
  SET v_fi = ROW_COUNT();

  INSERT INTO audit_log (user_id, case_id, action, entity_type, entity_id, details)
  VALUES (v_actor, NULL, 'index.backfill', NULL, NULL,
          JSON_OBJECT('evidence_jobs', v_ev, 'finding_jobs', v_fi));
  COMMIT;

  SELECT v_ev AS evidence_jobs_queued, v_fi AS finding_jobs_queued;
END$$

-- ---------------------------------------------------------------------
-- 5. Stored procedure: read with a RECURSIVE CTE
--    All evidence reachable from one item through recorded links, with the
--    number of hops and the route. Links are followed in both directions.
--    Cycle protection: an item is never added twice to the same route.
--    Depth is capped (1..10) so a huge graph cannot run away.
-- ---------------------------------------------------------------------
CREATE PROCEDURE sp_linked_evidence(IN p_start_id INT UNSIGNED, IN p_max_depth INT)
SQL SECURITY DEFINER
BEGIN
  DECLARE v_actor INT UNSIGNED;
  DECLARE v_case  INT UNSIGNED;
  DECLARE v_depth INT;

  SET v_actor = fn_actor();
  SELECT case_id INTO v_case FROM evidence WHERE evidence_id = p_start_id;
  IF v_case IS NULL OR NOT fn_can_access_case(v_actor, v_case) THEN
    SIGNAL SQLSTATE '45000' SET MYSQL_ERRNO = 45001, MESSAGE_TEXT = 'Evidence not found or access denied';
  END IF;
  SET v_depth = LEAST(GREATEST(COALESCE(p_max_depth, 5), 1), 10);

  WITH RECURSIVE walk (evidence_id, depth, route) AS (
    SELECT e.evidence_id, 0, CAST(CONCAT(',', e.evidence_id, ',') AS CHAR(1000))
    FROM evidence e
    WHERE e.evidence_id = p_start_id
    UNION ALL
    SELECT x.evidence_id, w.depth + 1,
           CAST(CONCAT(w.route, x.evidence_id, ',') AS CHAR(1000))
    FROM walk w
    JOIN evidence_relationship r
      ON r.evidence_a_id = w.evidence_id OR r.evidence_b_id = w.evidence_id
    JOIN evidence x
      ON x.evidence_id = IF(r.evidence_a_id = w.evidence_id, r.evidence_b_id, r.evidence_a_id)
    WHERE w.depth < v_depth
      AND LOCATE(CONCAT(',', x.evidence_id, ','), w.route) = 0
  ),
  best AS (
    SELECT evidence_id, depth, route,
           ROW_NUMBER() OVER (PARTITION BY evidence_id ORDER BY depth, route) AS rn
    FROM walk
  )
  SELECT b.evidence_id, e.evidence_no, e.title, e.status, b.depth,
         TRIM(BOTH ',' FROM b.route) AS route
  FROM best b
  JOIN evidence e ON e.evidence_id = b.evidence_id
  WHERE b.rn = 1
  ORDER BY b.depth, e.evidence_no;
END$$

DELIMITER ;

-- ---------------------------------------------------------------------
-- 6. Grants (EXECUTE) to the application roles
-- ---------------------------------------------------------------------
GRANT SELECT ON tracex.v_my_teammates       TO 'tracex_investigator';
GRANT SELECT ON tracex.v_my_current_custody TO 'tracex_investigator';
GRANT SELECT ON tracex.v_my_users           TO 'tracex_investigator';

GRANT EXECUTE ON PROCEDURE tracex.sp_register_evidence    TO 'tracex_investigator', 'tracex_admin';
GRANT EXECUTE ON PROCEDURE tracex.sp_transfer_custody     TO 'tracex_investigator', 'tracex_admin';
GRANT EXECUTE ON PROCEDURE tracex.sp_update_evidence_text TO 'tracex_investigator', 'tracex_admin';
GRANT EXECUTE ON PROCEDURE tracex.sp_withdraw_evidence    TO 'tracex_investigator', 'tracex_admin';
GRANT EXECUTE ON PROCEDURE tracex.sp_record_analysis      TO 'tracex_investigator', 'tracex_admin';
GRANT EXECUTE ON PROCEDURE tracex.sp_complete_analysis    TO 'tracex_investigator', 'tracex_admin';
GRANT EXECUTE ON PROCEDURE tracex.sp_add_finding          TO 'tracex_investigator', 'tracex_admin';
GRANT EXECUTE ON PROCEDURE tracex.sp_link_evidence        TO 'tracex_investigator', 'tracex_admin';
GRANT EXECUTE ON PROCEDURE tracex.sp_linked_evidence      TO 'tracex_investigator', 'tracex_admin';
GRANT EXECUTE ON PROCEDURE tracex.sp_create_case          TO 'tracex_admin';
GRANT EXECUTE ON PROCEDURE tracex.sp_grant_access         TO 'tracex_admin';
GRANT EXECUTE ON PROCEDURE tracex.sp_revoke_access        TO 'tracex_admin';
GRANT EXECUTE ON PROCEDURE tracex.sp_set_case_status      TO 'tracex_admin';
GRANT EXECUTE ON PROCEDURE tracex.sp_backfill_index_jobs  TO 'tracex_admin';
