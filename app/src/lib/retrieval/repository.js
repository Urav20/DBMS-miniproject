// The ONLY file in the retrieval API that contains SQL. All statements go through the
// existing access layer (lib/db): withSession(session, work) picks the pool for the signed-in
// role, acquires a connection, runs SET @tracex_user_id = <the user's id>, and releases the
// connection. This file never opens a connection itself.
//
// WHAT MYSQL DECIDES HERE (Qdrant decides nothing):
//   investigator  Reads ONLY the filtered views v_my_cases, v_my_evidence, v_my_findings and
//                 v_my_analyses (granted to tracex_investigator in 02_access.sql). The views
//                 return rows only for cases the user is CURRENTLY assigned to (assignment not
//                 revoked, user active), so a revoked or never-granted case yields no row.
//   admin         tracex_admin_app has NO grant on any v_my_* view (02_access.sql grants it
//                 base tables plus v_current_custody), and the fn_* functions are not granted
//                 to it either. The admin path therefore reads the base tables evidence,
//                 finding, analysis and investigation_case (all granted), and first proves
//                 in MySQL that @tracex_user_id is an ACTIVE user whose role is
//                 'Administrator' (mirrors fn_is_admin in 03_routines.sql). The session cookie
//                 is stateless and cannot be revoked, so this check is what makes a
//                 deactivated or demoted administrator lose access immediately.
//
// Both investigator views expose content_version (database/02_access.sql), so stale-vector
// checks run for investigators and administrators. Investigator reads remain restricted to
// filtered v_my_* views; no base-table access is introduced.
//
// Withdrawn evidence is NOT filtered by the views (v_my_evidence shows it, and v_my_findings
// shows findings of withdrawn evidence). This file returns the status and the service
// discards withdrawn rows explicitly.

import { RetrievalError } from "./errors.js";

export const ADMIN_ROLE_NAME = "Administrator"; // role.role_name, as in fn_is_admin and the seed data

const MAX_ID = 4294967295;

function idList(ids, label) {
  if (!Array.isArray(ids) || ids.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 1 || id > MAX_ID) {
      throw new TypeError(`${label} must be positive whole numbers`);
    }
  }
  return ids.map(() => "?").join(", ");
}

const toNumber = (v) => (v === null || v === undefined ? null : Number(v));

function normalizeEvidence(r, withVersion) {
  return {
    kind: "evidence",
    recordId: Number(r.evidence_id),
    evidenceId: Number(r.evidence_id),
    evidenceNo: String(r.evidence_no),
    caseId: Number(r.case_id),
    typeId: toNumber(r.type_id),
    title: String(r.title),
    status: String(r.status),
    registeredAt: r.registered_at ?? null,
    contentVersion: withVersion ? toNumber(r.content_version) : null,
  };
}

function normalizeFinding(r, withVersion) {
  return {
    kind: "finding",
    recordId: Number(r.finding_id),
    evidenceId: Number(r.evidence_id),
    evidenceNo: String(r.evidence_no),
    caseId: Number(r.case_id),
    analysisId: Number(r.analysis_id),
    title: String(r.title),
    severity: String(r.severity),
    createdAt: r.created_at ?? null,
    status: String(r.evidence_status), // status of the finding's EVIDENCE
    contentVersion: withVersion ? toNumber(r.content_version) : null,
  };
}

export function createRetrievalRepository({ db } = {}) {
  if (!db?.withSession) throw new Error("createRetrievalRepository requires the db access layer.");

  const roleOf = (session) => {
    if (session?.role === "admin" || session?.role === "investigator") return session.role;
    // The route only admits these two roles; anything else (including the worker pool) is refused.
    throw new RetrievalError("AUTH_FORBIDDEN", "Your role is not allowed to do this.", { status: 403 });
  };

  // Admin only. Runs inside the request's own connection, after SET @tracex_user_id.
  async function assertActiveAdministrator(q) {
    const rows = await q.query(
      `SELECT u.user_id
         FROM app_user u
         JOIN \`role\` r ON r.role_id = u.role_id
        WHERE u.user_id = @tracex_user_id
          AND u.is_active = 1
          AND r.role_name = ?
        LIMIT 1`,
      [ADMIN_ROLE_NAME],
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new RetrievalError(
        "AUTH_FORBIDDEN",
        "Your account is no longer authorized for administrator access.",
        { status: 403 },
      );
    }
  }

  return {
    // The case ids this search may cover, decided by MySQL.
    //   requested = null  -> every case the user may access now
    //   requested = [..]  -> exactly those, and ALL must be accessible, otherwise 403.
    // "Does not exist" and "not yours" give the same answer, so ids cannot be probed.
    // Returns an ascending array of case ids (possibly empty when requested is null).
    async resolveCaseScope(session, requested) {
      const role = roleOf(session);
      const hasFilter = Array.isArray(requested);
      const marks = hasFilter ? idList(requested, "case ids") : "";

      const rows = await db.withSession(session, async (q) => {
        if (role === "admin") {
          await assertActiveAdministrator(q);
          return q.query(
            `SELECT c.case_id FROM investigation_case c${hasFilter ? ` WHERE c.case_id IN (${marks})` : ""} ORDER BY c.case_id`,
            hasFilter ? requested : [],
          );
        }
        return q.query(
          `SELECT c.case_id FROM v_my_cases c${hasFilter ? ` WHERE c.case_id IN (${marks})` : ""} ORDER BY c.case_id`,
          hasFilter ? requested : [],
        );
      });

      const allowed = rows.map((r) => Number(r.case_id)).sort((a, b) => a - b);
      if (hasFilter && allowed.length !== new Set(requested).size) {
        throw new RetrievalError(
          "CASE_ACCESS_DENIED",
          "One or more requested cases are not available to you.",
          { status: 403 },
        );
      }
      return allowed;
    },

    // The authoritative rows for Qdrant's candidates, read AFTER the search so that a
    // revocation or withdrawal that happened while embedding/searching is seen.
    // Candidates with no row here are inaccessible, missing or outside `caseIds`.
    // Returns { evidence: [...], findings: [...], accessPath, versionsAvailable }.
    async loadAuthoritativeRows(session, { evidenceIds = [], findingIds = [], caseIds }) {
      const role = roleOf(session);
      const caseMarks = idList(caseIds, "case ids");
      const evMarks = evidenceIds.length ? idList(evidenceIds, "evidence ids") : null;
      const fiMarks = findingIds.length ? idList(findingIds, "finding ids") : null;
      const withVersion = true;

      return db.withSession(session, async (q) => {
        if (role === "admin") await assertActiveAdministrator(q);

        let evidence = [];
        if (evMarks) {
          const sql =
            role === "admin"
              ? `SELECT e.evidence_id, e.evidence_no, e.case_id, e.type_id, e.title, e.status,
                        e.registered_at, e.content_version
                   FROM evidence e
                  WHERE e.evidence_id IN (${evMarks}) AND e.case_id IN (${caseMarks})`
              : `SELECT e.evidence_id, e.evidence_no, e.case_id, e.type_id, e.title, e.status,
                        e.registered_at, e.content_version
                   FROM v_my_evidence e
                  WHERE e.evidence_id IN (${evMarks}) AND e.case_id IN (${caseMarks})`;
          const rows = await q.query(sql, [...evidenceIds, ...caseIds]);
          evidence = rows.map((r) => normalizeEvidence(r, withVersion));
        }

        let findings = [];
        if (fiMarks) {
          const sql =
            role === "admin"
              ? `SELECT f.finding_id, f.analysis_id, f.title, f.severity, f.created_at,
                        f.content_version, a.evidence_id, e.evidence_no, e.case_id,
                        e.status AS evidence_status
                   FROM finding f
                   JOIN analysis a ON a.analysis_id = f.analysis_id
                   JOIN evidence e ON e.evidence_id = a.evidence_id
                  WHERE f.finding_id IN (${fiMarks}) AND e.case_id IN (${caseMarks})`
              : `SELECT f.finding_id, f.analysis_id, f.title, f.severity, f.created_at,
                        f.content_version, a.evidence_id, e.evidence_no, e.case_id, e.status AS evidence_status
                   FROM v_my_findings f
                   JOIN v_my_analyses a ON a.analysis_id = f.analysis_id
                   JOIN v_my_evidence e ON e.evidence_id = a.evidence_id
                  WHERE f.finding_id IN (${fiMarks}) AND e.case_id IN (${caseMarks})`;
          const rows = await q.query(sql, [...findingIds, ...caseIds]);
          findings = rows.map((r) => normalizeFinding(r, withVersion));
        }

        return {
          evidence,
          findings,
          accessPath: role === "admin" ? "admin_base_tables" : "investigator_views",
          versionsAvailable: withVersion,
        };
      });
    },
  };
}
