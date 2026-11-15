// Read-only workspace queries. Investigators are restricted to v_my_* views;
// administrators use the base tables. All statements run through the role-specific DB layer.
import { query } from "../db/index.js";

export async function listCases(session) {
  const admin = session.role === "admin";
  const from = admin ? "investigation_case" : "v_my_cases";
  const evidenceView = admin ? "evidence" : "v_my_evidence";
  const analysesView = admin ? "analysis" : "v_my_analyses";
  const findingsView = admin ? "finding" : "v_my_findings";
  const sql = admin
    ? `SELECT c.case_id, c.case_number, c.title, c.description, c.status, c.opened_at,
              COALESCE(ev.total, 0) AS evidence_count, COALESCE(fi.total, 0) AS finding_count
         FROM ${from} c
         LEFT JOIN (SELECT case_id, COUNT(*) AS total FROM ${evidenceView} GROUP BY case_id) ev ON ev.case_id = c.case_id
         LEFT JOIN (SELECT e.case_id, COUNT(*) AS total FROM ${findingsView} f JOIN ${analysesView} a ON a.analysis_id = f.analysis_id JOIN evidence e ON e.evidence_id = a.evidence_id GROUP BY e.case_id) fi ON fi.case_id = c.case_id
        ORDER BY c.opened_at DESC, c.case_id DESC`
    : `SELECT c.case_id, c.case_number, c.title, c.description, c.status, c.opened_at,
              (SELECT COUNT(*) FROM v_my_evidence e WHERE e.case_id = c.case_id) AS evidence_count,
              (SELECT COUNT(*) FROM v_my_findings f JOIN v_my_analyses a ON a.analysis_id = f.analysis_id JOIN v_my_evidence e ON e.evidence_id = a.evidence_id WHERE e.case_id = c.case_id) AS finding_count
         FROM ${from} c ORDER BY c.opened_at DESC, c.case_id DESC`;
  return query(session, sql);
}

export async function listEvidence(session, caseId = null) {
  const admin = session.role === "admin";
  const source = admin ? "evidence" : "v_my_evidence";
  const cases = admin ? "investigation_case" : "v_my_cases";
  const custody = admin ? "v_current_custody" : "v_my_current_custody";
  const sql = `SELECT e.evidence_id, e.evidence_no, e.case_id, c.case_number, e.title,
                      e.description, e.extracted_text, e.status, e.content_version, e.indexed_version,
                      e.registered_by, e.registered_at, et.name AS type_name,
                      cc.current_custodian_name
                 FROM ${source} e
                 JOIN ${cases} c ON c.case_id = e.case_id
                 JOIN evidence_type et ON et.type_id = e.type_id
                 LEFT JOIN ${custody} cc ON cc.evidence_id = e.evidence_id
                ${caseId ? "WHERE e.case_id = ?" : ""}
                ORDER BY e.registered_at DESC, e.evidence_id DESC LIMIT 250`;
  return query(session, sql, caseId ? [caseId] : []);
}

export async function listRecentCustody(session, limit = 8) {
  const admin = session.role === "admin";
  const eventView = admin ? "custody_event" : "v_my_custody";
  const evidenceView = admin ? "evidence" : "v_my_evidence";
  const people = admin ? "app_user" : "v_my_users";
  return query(session,
    `SELECT ce.evidence_id, e.evidence_no, ce.seq_no, ce.transferred_at, ce.reason,
            fu.full_name AS from_user, tu.full_name AS to_user
       FROM ${eventView} ce
       JOIN ${evidenceView} e ON e.evidence_id = ce.evidence_id
       LEFT JOIN ${people} fu ON fu.user_id = ce.from_user_id
       JOIN ${people} tu ON tu.user_id = ce.to_user_id
      ORDER BY ce.transferred_at DESC, ce.evidence_id DESC LIMIT ?`, [limit]);
}

export async function listAudit(session, limit = 100) {
  if (session.role !== "admin") throw new Error("Administrator access required.");
  return query(session,
    `SELECT al.audit_id, al.action, al.entity_type, al.entity_id, al.case_id,
            al.occurred_at, al.details, u.username, u.full_name
       FROM audit_log al LEFT JOIN app_user u ON u.user_id = al.user_id
      ORDER BY al.occurred_at DESC, al.audit_id DESC LIMIT ?`, [limit]);
}
