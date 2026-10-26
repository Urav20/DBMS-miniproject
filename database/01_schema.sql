-- =====================================================================
-- TRACE-X  |  01_schema.sql
-- Creates the `tracex` database: 15 tables, constraints and indexes.
-- Target: MySQL 8.0.16 or newer (CHECK constraints are enforced from 8.0.16).
-- Design source: docs/design/TRACE-X_Phase2_Design.md (section 4).
--
-- Run:   mysql -u root -p < database/01_schema.sql
-- Then:  mysql -u root -p < database/02_access.sql
--
-- WARNING: the next line deletes the whole tracex database so the script
-- is repeatable during development. Remove it before using real data.
-- =====================================================================
DROP DATABASE IF EXISTS tracex;
CREATE DATABASE tracex
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
USE tracex;

-- Referential actions: every foreign key uses ON DELETE RESTRICT ON UPDATE
-- RESTRICT (evidence and history must never disappear by accident).
-- Exception: foreign-key columns that also appear in a CHECK constraint
-- (custody_event.from_user_id/to_user_id, evidence_relationship.evidence_a_id/
-- evidence_b_id, index_job.evidence_id/finding_id) omit the ON clauses.
-- MySQL forbids explicit referential actions on such columns (error 3823);
-- the default, NO ACTION, behaves the same as RESTRICT in InnoDB.

-- ---------------------------------------------------------------------
-- 1. role: the two application roles
-- ---------------------------------------------------------------------
CREATE TABLE `role` (
  role_id    TINYINT UNSIGNED NOT NULL AUTO_INCREMENT,
  role_name  VARCHAR(30)      NOT NULL,
  CONSTRAINT pk_role      PRIMARY KEY (role_id),
  CONSTRAINT uq_role_name UNIQUE (role_name)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 2. app_user: accounts (deactivated, never deleted)
-- ---------------------------------------------------------------------
CREATE TABLE app_user (
  user_id        INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  role_id        TINYINT UNSIGNED NOT NULL,
  username       VARCHAR(50)      NOT NULL,
  email          VARCHAR(120)     NOT NULL,
  full_name      VARCHAR(100)     NOT NULL,
  password_hash  VARCHAR(255)     NOT NULL,
  is_active      TINYINT(1)       NOT NULL DEFAULT 1,
  created_at     DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_app_user          PRIMARY KEY (user_id),
  CONSTRAINT uq_app_user_username UNIQUE (username),
  CONSTRAINT uq_app_user_email    UNIQUE (email),
  CONSTRAINT ck_app_user_email    CHECK (email LIKE '%_@_%._%'),
  CONSTRAINT ck_app_user_active   CHECK (is_active IN (0, 1)),
  CONSTRAINT fk_app_user_role FOREIGN KEY (role_id) REFERENCES `role` (role_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 3. investigation_case: the unit of access control
-- ---------------------------------------------------------------------
CREATE TABLE investigation_case (
  case_id      INT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_number  VARCHAR(30)  NOT NULL,
  title        VARCHAR(200) NOT NULL,
  description  TEXT         NULL,
  status       ENUM('open','under_review','closed') NOT NULL DEFAULT 'open',
  opened_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at    DATETIME     NULL,
  created_by   INT UNSIGNED NOT NULL,
  CONSTRAINT pk_case        PRIMARY KEY (case_id),
  CONSTRAINT uq_case_number UNIQUE (case_number),
  CONSTRAINT ck_case_closed_after_open
    CHECK (closed_at IS NULL OR closed_at >= opened_at),
  CONSTRAINT ck_case_closed_matches_status
    CHECK ((status = 'closed' AND closed_at IS NOT NULL)
        OR (status <> 'closed' AND closed_at IS NULL)),
  CONSTRAINT fk_case_created_by FOREIGN KEY (created_by) REFERENCES app_user (user_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 4. case_assignment: user <-> case (many-to-many with history)
-- ---------------------------------------------------------------------
CREATE TABLE case_assignment (
  case_id     INT UNSIGNED NOT NULL,
  user_id     INT UNSIGNED NOT NULL,
  granted_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at  DATETIME     NULL,
  CONSTRAINT pk_case_assignment PRIMARY KEY (case_id, user_id),
  CONSTRAINT ck_assignment_revoked_after_granted
    CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  CONSTRAINT fk_assignment_case FOREIGN KEY (case_id) REFERENCES investigation_case (case_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_assignment_user FOREIGN KEY (user_id) REFERENCES app_user (user_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 5. evidence_source: device or origin, belongs to one case
-- ---------------------------------------------------------------------
CREATE TABLE evidence_source (
  source_id    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  case_id      INT UNSIGNED NOT NULL,
  label        VARCHAR(120) NOT NULL,
  source_kind  ENUM('computer','mobile','server','storage_media',
                    'cloud_account','network_capture','other') NOT NULL,
  serial_no    VARCHAR(80)  NULL,
  description  TEXT         NULL,
  CONSTRAINT pk_evidence_source PRIMARY KEY (source_id),
  CONSTRAINT uq_source_case_label UNIQUE (case_id, label),
  -- Target of the composite foreign key from `evidence` (same-case rule).
  CONSTRAINT uq_source_case_source UNIQUE (case_id, source_id),
  CONSTRAINT fk_source_case FOREIGN KEY (case_id) REFERENCES investigation_case (case_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 6. evidence_type: lookup
-- ---------------------------------------------------------------------
CREATE TABLE evidence_type (
  type_id      TINYINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(60)      NOT NULL,
  description  VARCHAR(255)     NULL,
  CONSTRAINT pk_evidence_type PRIMARY KEY (type_id),
  CONSTRAINT uq_evidence_type_name UNIQUE (name)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 7. evidence: the central record (its text feeds semantic search)
-- ---------------------------------------------------------------------
CREATE TABLE evidence (
  evidence_id      INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  evidence_no      VARCHAR(30)      NOT NULL,
  case_id          INT UNSIGNED     NOT NULL,
  source_id        INT UNSIGNED     NULL,
  type_id          TINYINT UNSIGNED NOT NULL,
  title            VARCHAR(200)     NOT NULL,
  description      TEXT             NOT NULL,
  extracted_text   MEDIUMTEXT       NULL,
  sha256           CHAR(64)         NULL,
  file_size_bytes  BIGINT UNSIGNED  NULL,
  status           ENUM('active','withdrawn') NOT NULL DEFAULT 'active',
  registered_by    INT UNSIGNED     NOT NULL,
  registered_at    DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  content_version  INT UNSIGNED     NOT NULL DEFAULT 1,
  indexed_version  INT UNSIGNED     NULL,
  indexed_at       DATETIME         NULL,
  CONSTRAINT pk_evidence PRIMARY KEY (evidence_id),
  CONSTRAINT uq_evidence_no UNIQUE (evidence_no),
  -- The same file (hash) cannot be registered twice in one case.
  -- NULL hashes are allowed and never collide.
  CONSTRAINT uq_evidence_case_sha256 UNIQUE (case_id, sha256),
  CONSTRAINT ck_evidence_sha256
    CHECK (sha256 IS NULL OR REGEXP_LIKE(sha256, '^[0-9a-f]{64}$', 'c')),
  CONSTRAINT ck_evidence_indexed_version
    CHECK (indexed_version IS NULL OR indexed_version <= content_version),
  CONSTRAINT fk_evidence_case FOREIGN KEY (case_id) REFERENCES investigation_case (case_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Composite FK: the source must belong to the SAME case as the evidence.
  -- With source_id NULL the constraint is not checked (MATCH SIMPLE).
  CONSTRAINT fk_evidence_source_same_case FOREIGN KEY (case_id, source_id)
    REFERENCES evidence_source (case_id, source_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_evidence_type FOREIGN KEY (type_id) REFERENCES evidence_type (type_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_evidence_registered_by FOREIGN KEY (registered_by) REFERENCES app_user (user_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 8. collection_event: how and when evidence was collected (1:1)
-- ---------------------------------------------------------------------
CREATE TABLE collection_event (
  collection_id  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  evidence_id    INT UNSIGNED NOT NULL,
  collected_by   INT UNSIGNED NOT NULL,
  collected_at   DATETIME     NOT NULL,
  method         VARCHAR(100) NOT NULL,
  location       VARCHAR(150) NULL,
  notes          TEXT         NULL,
  CONSTRAINT pk_collection_event PRIMARY KEY (collection_id),
  CONSTRAINT uq_collection_evidence UNIQUE (evidence_id),   -- makes it one-to-one
  CONSTRAINT fk_collection_evidence FOREIGN KEY (evidence_id) REFERENCES evidence (evidence_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_collection_collected_by FOREIGN KEY (collected_by) REFERENCES app_user (user_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 9. custody_event: chain of custody (weak entity of evidence, append-only)
-- ---------------------------------------------------------------------
CREATE TABLE custody_event (
  evidence_id     INT UNSIGNED NOT NULL,
  seq_no          INT UNSIGNED NOT NULL,
  from_user_id    INT UNSIGNED NULL,
  to_user_id      INT UNSIGNED NOT NULL,
  transferred_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason          VARCHAR(255) NULL,
  CONSTRAINT pk_custody_event PRIMARY KEY (evidence_id, seq_no),
  CONSTRAINT ck_custody_no_self_transfer
    CHECK (from_user_id IS NULL OR from_user_id <> to_user_id),
  -- Event 1 is the intake (no sender); every later event has a sender.
  CONSTRAINT ck_custody_first_event
    CHECK ((seq_no = 1 AND from_user_id IS NULL)
        OR (seq_no > 1 AND from_user_id IS NOT NULL)),
  CONSTRAINT fk_custody_evidence FOREIGN KEY (evidence_id) REFERENCES evidence (evidence_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_custody_from_user FOREIGN KEY (from_user_id) REFERENCES app_user (user_id),
  CONSTRAINT fk_custody_to_user   FOREIGN KEY (to_user_id)   REFERENCES app_user (user_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 10. analysis_tool: lookup
-- ---------------------------------------------------------------------
CREATE TABLE analysis_tool (
  tool_id      INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(80)  NOT NULL,
  version      VARCHAR(30)  NOT NULL,
  description  VARCHAR(255) NULL,
  CONSTRAINT pk_analysis_tool PRIMARY KEY (tool_id),
  CONSTRAINT uq_analysis_tool_name_version UNIQUE (name, version)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 11. analysis: one analysis session on one evidence item
-- ---------------------------------------------------------------------
CREATE TABLE analysis (
  analysis_id   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  evidence_id   INT UNSIGNED NOT NULL,
  tool_id       INT UNSIGNED NOT NULL,
  analyst_id    INT UNSIGNED NOT NULL,
  started_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at  DATETIME     NULL,
  notes         TEXT         NULL,
  CONSTRAINT pk_analysis PRIMARY KEY (analysis_id),
  CONSTRAINT ck_analysis_completed_after_started
    CHECK (completed_at IS NULL OR completed_at >= started_at),
  CONSTRAINT fk_analysis_evidence FOREIGN KEY (evidence_id) REFERENCES evidence (evidence_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_analysis_tool FOREIGN KEY (tool_id) REFERENCES analysis_tool (tool_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_analysis_analyst FOREIGN KEY (analyst_id) REFERENCES app_user (user_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 12. finding: result of an analysis (its text feeds semantic search)
-- ---------------------------------------------------------------------
CREATE TABLE finding (
  finding_id       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  analysis_id      INT UNSIGNED NOT NULL,
  title            VARCHAR(200) NOT NULL,
  description      TEXT         NOT NULL,
  severity         ENUM('info','low','medium','high','critical') NOT NULL DEFAULT 'info',
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  content_version  INT UNSIGNED NOT NULL DEFAULT 1,
  indexed_version  INT UNSIGNED NULL,
  indexed_at       DATETIME     NULL,
  CONSTRAINT pk_finding PRIMARY KEY (finding_id),
  CONSTRAINT ck_finding_indexed_version
    CHECK (indexed_version IS NULL OR indexed_version <= content_version),
  CONSTRAINT fk_finding_analysis FOREIGN KEY (analysis_id) REFERENCES analysis (analysis_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 13. evidence_relationship: human-recorded link between two evidence items
--     (recursive many-to-many resolved with an associative entity).
--     "Both ends in the same case" is enforced by a trigger (step 4).
-- ---------------------------------------------------------------------
CREATE TABLE evidence_relationship (
  rel_id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  evidence_a_id  INT UNSIGNED NOT NULL,
  evidence_b_id  INT UNSIGNED NOT NULL,
  rel_type       ENUM('derived_from','corroborates','contradicts',
                      'related_activity','other') NOT NULL,
  rationale      TEXT         NOT NULL,
  recorded_by    INT UNSIGNED NOT NULL,
  recorded_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_evidence_relationship PRIMARY KEY (rel_id),
  CONSTRAINT uq_relationship_pair_type UNIQUE (evidence_a_id, evidence_b_id, rel_type),
  CONSTRAINT ck_relationship_distinct CHECK (evidence_a_id <> evidence_b_id),
  CONSTRAINT fk_relationship_a FOREIGN KEY (evidence_a_id) REFERENCES evidence (evidence_id),
  CONSTRAINT fk_relationship_b FOREIGN KEY (evidence_b_id) REFERENCES evidence (evidence_id),
  CONSTRAINT fk_relationship_recorded_by FOREIGN KEY (recorded_by) REFERENCES app_user (user_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 14. audit_log: who did what (append-only).
--     entity_type + entity_id are deliberately NOT a foreign key, so the
--     log can describe a row in any table and outlive it.
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  audit_id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      INT UNSIGNED    NULL,          -- NULL = system action
  case_id      INT UNSIGNED    NULL,          -- NULL = not tied to a case
  action       VARCHAR(50)     NOT NULL,
  entity_type  VARCHAR(30)     NULL,
  entity_id    BIGINT UNSIGNED NULL,
  details      JSON            NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_audit_log PRIMARY KEY (audit_id),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES app_user (user_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_audit_case FOREIGN KEY (case_id) REFERENCES investigation_case (case_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 15. index_job: outbox for MySQL -> Qdrant synchronisation.
--     Exactly one of evidence_id / finding_id is set (exclusive arc).
-- ---------------------------------------------------------------------
CREATE TABLE index_job (
  job_id           BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  evidence_id      INT UNSIGNED     NULL,
  finding_id       INT UNSIGNED     NULL,
  operation        ENUM('upsert','delete') NOT NULL,
  content_version  INT UNSIGNED     NOT NULL,
  status           ENUM('pending','processing','done','failed') NOT NULL DEFAULT 'pending',
  attempts         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  last_error       VARCHAR(500)     NULL,
  created_at       DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at     DATETIME         NULL,
  CONSTRAINT pk_index_job PRIMARY KEY (job_id),
  CONSTRAINT ck_index_job_one_target
    CHECK ((evidence_id IS NULL) <> (finding_id IS NULL)),
  CONSTRAINT fk_index_job_evidence FOREIGN KEY (evidence_id) REFERENCES evidence (evidence_id),
  CONSTRAINT fk_index_job_finding  FOREIGN KEY (finding_id)  REFERENCES finding (finding_id)
) ENGINE=InnoDB;

-- =====================================================================
-- Indexes (beyond primary keys, unique keys and foreign-key indexes)
-- =====================================================================
CREATE INDEX idx_case_assignment_user_active ON case_assignment (user_id, revoked_at);
CREATE INDEX idx_evidence_case_status        ON evidence (case_id, status);
CREATE INDEX idx_analysis_evidence_started   ON analysis (evidence_id, started_at);
CREATE INDEX idx_audit_case_time             ON audit_log (case_id, created_at);
CREATE INDEX idx_audit_user_time             ON audit_log (user_id, created_at);
CREATE INDEX idx_audit_entity                ON audit_log (entity_type, entity_id);
CREATE INDEX idx_index_job_status_time       ON index_job (status, created_at);

-- Full-text indexes: the keyword baseline for the retrieval comparison.
CREATE FULLTEXT INDEX ft_evidence_text ON evidence (title, description, extracted_text);
CREATE FULLTEXT INDEX ft_finding_text  ON finding (title, description);
