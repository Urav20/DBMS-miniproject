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
  const indexedVersion = admin ? "e.indexed_version" : "NULL AS indexed_version";
  const sql = `SELECT e.evidence_id, e.evidence_no, e.case_id, c.case_number, c.status AS case_status, e.title,
                      e.description, e.extracted_text, e.status, e.content_version, ${indexedVersion},
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
            al.created_at, al.details, u.username, u.full_name
       FROM audit_log al LEFT JOIN app_user u ON u.user_id = al.user_id
      ORDER BY al.created_at DESC, al.audit_id DESC LIMIT ?`, [limit]);
}

export async function listCaseCustody(session, caseId) {
  const admin = session.role === "admin";
  const events = admin ? "custody_event" : "v_my_custody";
  const evidence = admin ? "evidence" : "v_my_evidence";
  const people = admin ? "app_user" : "v_my_users";
  const cases = admin ? "investigation_case" : "v_my_cases";
  return query(session,
    `SELECT ce.evidence_id, e.evidence_no, e.title, ce.seq_no, ce.from_user_id,
            ce.to_user_id, ce.transferred_at, ce.reason,
            fu.full_name AS from_user, tu.full_name AS to_user
       FROM ${events} ce
       JOIN ${evidence} e ON e.evidence_id = ce.evidence_id
       JOIN ${cases} c ON c.case_id = e.case_id
       LEFT JOIN ${people} fu ON fu.user_id = ce.from_user_id
       JOIN ${people} tu ON tu.user_id = ce.to_user_id
      WHERE e.case_id = ?
      ORDER BY e.evidence_no, ce.seq_no`, [caseId]);
}


export async function listCaseTeammates(session, caseId) {
  const admin = session.role === "admin";
  const sql = admin
    ? `SELECT u.user_id, u.username, u.full_name
         FROM case_assignment ca
         JOIN app_user u ON u.user_id = ca.user_id
        WHERE ca.case_id = ? AND ca.revoked_at IS NULL AND u.is_active = 1
          AND u.user_id <> ?
        ORDER BY u.full_name`
    : `SELECT user_id, username, full_name
         FROM v_my_teammates
        WHERE case_id = ?
        ORDER BY full_name`;
  return query(session, sql, admin ? [caseId, session.userId] : [caseId]);
}

export async function listActiveUsers(session) {
  if (session.role !== "admin") throw new Error("Administrator access required.");
  return query(session,
    `SELECT u.user_id, u.username, u.full_name, r.role_name
       FROM app_user u JOIN `role` r ON r.role_id = u.role_id
      WHERE u.is_active = 1
      ORDER BY u.full_name`);
}

export async function listEvidenceTypes(session) {
  return query(session, "SELECT type_id, name FROM evidence_type ORDER BY name");
}

export async function listAnalysisTools(session) {
  return query(session, "SELECT tool_id, name, version, description FROM analysis_tool ORDER BY name, version");
}

export async function getEvidenceDetail(session, evidenceId) {
  const admin = session.role === "admin";
  const base = admin ? "evidence" : "v_my_evidence";
  const visibleCases = admin ? "investigation_case" : "v_my_cases";
  const people = admin ? "app_user" : "v_my_users";
  const collection = admin ? "collection_event" : "v_my_collection";
  const analyses = admin ? "analysis" : "v_my_analyses";
  const findings = admin ? "finding" : "v_my_findings";
  const relationships = admin ? "evidence_relationship" : "v_my_relationships";

  const evidenceRows = await query(session,
    `SELECT e.evidence_id, e.evidence_no, e.case_id, c.case_number, c.title AS case_title,
            c.status AS case_status, e.source_id, e.type_id, et.name AS type_name,
            e.title, e.description, e.extracted_text, e.sha256, e.file_size_bytes,
            e.status, e.registered_by, e.registered_at, e.content_version,
            ${admin ? "e.indexed_version" : "NULL AS indexed_version"}
       FROM ${base} e
       JOIN ${visibleCases} c ON c.case_id = e.case_id
       JOIN evidence_type et ON et.type_id = e.type_id
      WHERE e.evidence_id = ?
      LIMIT 1`, [evidenceId]);
  const evidenceRow = evidenceRows[0];
  if (!evidenceRow) return null;

  const [collectionRows, analysisRows, relationshipRows] = await Promise.all([
    query(session,
      `SELECT co.collection_id, co.collected_at, co.method, co.location, co.notes,
              u.user_id AS collector_id, u.full_name AS collector_name
         FROM ${collection} co
         JOIN ${people} u ON u.user_id = co.collected_by
        WHERE co.evidence_id = ?
        ORDER BY co.collected_at, co.collection_id`, [evidenceId]),
    query(session,
      `SELECT a.analysis_id, a.tool_id, t.name AS tool_name, t.version AS tool_version,
              a.analyst_id, u.full_name AS analyst_name, a.started_at, a.completed_at, a.notes
         FROM ${analyses} a
         JOIN analysis_tool t ON t.tool_id = a.tool_id
         JOIN ${people} u ON u.user_id = a.analyst_id
        WHERE a.evidence_id = ?
        ORDER BY a.started_at DESC, a.analysis_id DESC`, [evidenceId]),
    query(session,
      `SELECT r.rel_id, r.evidence_a_id, r.evidence_b_id, r.rel_type, r.rationale,
              r.recorded_at, r.recorded_by, u.full_name AS recorder_name,
              ea.evidence_no AS evidence_a_no, ea.title AS evidence_a_title,
              eb.evidence_no AS evidence_b_no, eb.title AS evidence_b_title
         FROM ${relationships} r
         JOIN ${base} ea ON ea.evidence_id = r.evidence_a_id
         JOIN ${base} eb ON eb.evidence_id = r.evidence_b_id
         JOIN ${people} u ON u.user_id = r.recorded_by
        WHERE r.evidence_a_id = ? OR r.evidence_b_id = ?
        ORDER BY r.recorded_at DESC, r.rel_id DESC`, [evidenceId, evidenceId]),
  ]);

  const analysisIds = analysisRows.map((a) => Number(a.analysis_id));
  let findingRows = [];
  if (analysisIds.length) {
    const marks = analysisIds.map(() => "?").join(", ");
    findingRows = await query(session,
      `SELECT f.finding_id, f.analysis_id, f.title, f.description, f.severity, f.created_at,
              ${admin ? "f.indexed_version" : "NULL AS indexed_version"}
         FROM ${findings} f
        WHERE f.analysis_id IN (${marks})
        ORDER BY f.created_at DESC, f.finding_id DESC`, analysisIds);
  }
  const findingsByAnalysis = new Map();
  for (const finding of findingRows) {
    const key = Number(finding.analysis_id);
    if (!findingsByAnalysis.has(key)) findingsByAnalysis.set(key, []);
    findingsByAnalysis.get(key).push(finding);
  }
  return {
    evidence: evidenceRow,
    collection: collectionRows,
    analyses: analysisRows.map((a) => ({
      ...a,
      findings: findingsByAnalysis.get(Number(a.analysis_id)) ?? [],
    })),
    relationships: relationshipRows,
  };
}
