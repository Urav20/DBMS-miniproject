// Shared test fakes for the retrieval tests. No MySQL, Qdrant or model is needed.
//
// FakeMysql sits at the CONNECTION level (the mysql2 `execute(sql, params)` call), underneath
// the REAL lib/db/client.js. So the tests exercise the real per-request pattern: pool chosen
// by role, SET @tracex_user_id first, release afterwards. The fake then behaves like the real
// database for the statements retrieval sends:
//   - the investigator pool may read only the v_my_* views; base tables raise error 1142
//   - the admin pool may read only base tables; v_my_* views raise error 1142 (no grant)
//   - v_my_* views return rows only for the connection's @tracex_user_id: active assignment,
//     active user, as in 02_access.sql. They include withdrawn evidence, as the real views do.
//   - v_my_evidence / v_my_findings expose content_version, as required by retrieval

import { createDb } from "../../src/lib/db/client.js";
import { pointId, buildPayload } from "../../src/lib/vector/ids.js";
import { VectorError } from "../../src/lib/vector/errors.js";

export const silentLogger = { info() {}, warn() {}, error() {} };

export function sampleData() {
  return {
    users: [
      { user_id: 1, role_name: "Administrator", is_active: 1 }, // Dana, admin
      { user_id: 2, role_name: "Administrator", is_active: 0 }, // deactivated admin
      { user_id: 3, role_name: "Investigator", is_active: 1 }, // Isha: cases 1 (and revoked from 3)
      { user_id: 4, role_name: "Investigator", is_active: 1 }, // Tomas: cases 1 and 2
      { user_id: 5, role_name: "Investigator", is_active: 0 }, // deactivated investigator, assigned to 2
      { user_id: 6, role_name: "Investigator", is_active: 1 }, // no assignments at all
      { user_id: 7, role_name: "Investigator", is_active: 1 }, // investigator demoted from admin? (see tests)
    ],
    cases: [{ case_id: 1 }, { case_id: 2 }, { case_id: 3 }],
    assignments: [
      { case_id: 1, user_id: 3, revoked_at: null },
      { case_id: 1, user_id: 4, revoked_at: null },
      { case_id: 2, user_id: 4, revoked_at: null },
      { case_id: 2, user_id: 5, revoked_at: null }, // user inactive
      { case_id: 3, user_id: 3, revoked_at: "2026-01-01" }, // revoked
    ],
    evidence: [
      { evidence_id: 10, evidence_no: "EV-0010", case_id: 1, type_id: 1, title: "Laptop image", status: "active", registered_at: "2026-03-01", content_version: 1 },
      { evidence_id: 11, evidence_no: "EV-0011", case_id: 1, type_id: 2, title: "Edited memo", status: "active", registered_at: "2026-03-02", content_version: 2 },
      { evidence_id: 12, evidence_no: "EV-0012", case_id: 1, type_id: 2, title: "Withdrawn chat log", status: "withdrawn", registered_at: "2026-03-03", content_version: 1 },
      { evidence_id: 20, evidence_no: "EV-0020", case_id: 2, type_id: 1, title: "Phone dump", status: "active", registered_at: "2026-03-04", content_version: 1 },
      { evidence_id: 30, evidence_no: "EV-0030", case_id: 3, type_id: 1, title: "Server log", status: "active", registered_at: "2026-03-05", content_version: 1 },
    ],
    analyses: [
      { analysis_id: 100, evidence_id: 10 },
      { analysis_id: 101, evidence_id: 12 }, // analysis of withdrawn evidence
      { analysis_id: 102, evidence_id: 20 },
      { analysis_id: 103, evidence_id: 30 },
    ],
    findings: [
      { finding_id: 1000, analysis_id: 100, title: "Deleted browser history", severity: "high", created_at: "2026-04-01", content_version: 1 },
      { finding_id: 1001, analysis_id: 101, title: "Finding on withdrawn item", severity: "low", created_at: "2026-04-02", content_version: 1 },
      { finding_id: 1002, analysis_id: 102, title: "Contacts exfiltrated", severity: "medium", created_at: "2026-04-03", content_version: 1 },
      { finding_id: 1003, analysis_id: 103, title: "Privilege escalation", severity: "critical", created_at: "2026-04-04", content_version: 1 },
      { finding_id: 1004, analysis_id: 100, title: "Stale test finding", severity: "low", created_at: "2026-04-05", content_version: 2 },
    ],
  };
}

function mysqlError(errno, code, message) {
  const e = new Error(message);
  e.errno = errno;
  e.code = code;
  e.sqlState = "42000";
  e.sqlMessage = message;
  return e;
}

const inCounts = (sql) => [...sql.matchAll(/IN \(([?,\s]+)\)/g)].map((m) => (m[1].match(/\?/g) ?? []).length);

export function createFakeMysql(data = sampleData(), { failOn } = {}) {
  const log = []; // { role, userVar, sql, params }
  const checkouts = []; // { role, released, destroyed, userVarAtRelease }

  function visibleCaseIds(userId) {
    const user = data.users.find((u) => u.user_id === userId);
    if (!user || !user.is_active) return new Set();
    return new Set(
      data.assignments.filter((a) => a.user_id === userId && a.revoked_at === null).map((a) => a.case_id),
    );
  }

  function makeConn(role) {
    const state = { userVar: undefined };
    const entry = { role, released: false, destroyed: false, userVarAtRelease: "unset" };
    checkouts.push(entry);
    const denied = (what) => mysqlError(1142, "ER_TABLEACCESS_DENIED_ERROR", `SELECT command denied to user for ${what}`);

    return {
      async execute(sql, params = []) {
        log.push({ role, userVar: state.userVar, sql, params });
        if (failOn?.(sql, role, params)) throw failOn.error ?? mysqlError(2003, "ECONNREFUSED", "connect ECONNREFUSED");

        if (/^SET @tracex_user_id = \?/.test(sql.trim())) {
          state.userVar = params[0];
          return [{ affectedRows: 0 }];
        }
        const usesView = /\bv_my_\w+/.test(sql);
        const usesBase = /\b(FROM|JOIN)\s+(app_user|investigation_case|evidence|finding|analysis)\b/.test(sql);
        if (role === "investigator" && usesBase) throw denied("a base table");
        if (role === "admin" && usesView) throw denied("a v_my_* view");

        // --- admin: active administrator check (reads @tracex_user_id) ---
        if (/FROM app_user u/.test(sql)) {
          const u = data.users.find((x) => x.user_id === state.userVar);
          const ok = u && u.is_active === 1 && u.role_name === params[0];
          return [ok ? [{ user_id: u.user_id }] : []];
        }

        // --- cases ---
        if (/FROM v_my_cases c/.test(sql)) {
          const mine = visibleCaseIds(state.userVar);
          let ids = data.cases.map((c) => c.case_id).filter((id) => mine.has(id));
          if (/IN \(/.test(sql)) ids = ids.filter((id) => params.includes(id));
          return [ids.sort((a, b) => a - b).map((case_id) => ({ case_id }))];
        }
        if (/FROM investigation_case c/.test(sql)) {
          let ids = data.cases.map((c) => c.case_id);
          if (/IN \(/.test(sql)) ids = ids.filter((id) => params.includes(id));
          return [ids.sort((a, b) => a - b).map((case_id) => ({ case_id }))];
        }

        // --- evidence ---
        const isViewEvidence = /FROM v_my_evidence e\b/.test(sql) && !/v_my_findings/.test(sql);
        const isBaseEvidence = /FROM evidence e\b/.test(sql);
        if (isViewEvidence || isBaseEvidence) {
          const [nIds] = inCounts(sql);
          const ids = params.slice(0, nIds);
          const cases = params.slice(nIds);
          const mine = visibleCaseIds(state.userVar);
          const rows = data.evidence
            .filter((e) => ids.includes(e.evidence_id) && cases.includes(e.case_id))
            .filter((e) => isBaseEvidence || mine.has(e.case_id));
          return [
            rows.map((e) => {
              const out = { ...e };
              return out;
            }),
          ];
        }

        // --- findings ---
        const isViewFinding = /FROM v_my_findings f/.test(sql);
        const isBaseFinding = /FROM finding f/.test(sql);
        if (isViewFinding || isBaseFinding) {
          const [nIds] = inCounts(sql);
          const ids = params.slice(0, nIds);
          const cases = params.slice(nIds);
          const mine = visibleCaseIds(state.userVar);
          const rows = [];
          for (const f of data.findings) {
            if (!ids.includes(f.finding_id)) continue;
            const a = data.analyses.find((x) => x.analysis_id === f.analysis_id);
            const e = a && data.evidence.find((x) => x.evidence_id === a.evidence_id);
            if (!e || !cases.includes(e.case_id)) continue;
            if (isViewFinding && !mine.has(e.case_id)) continue;
            const out = {
              finding_id: f.finding_id, analysis_id: f.analysis_id, title: f.title,
              severity: f.severity, created_at: f.created_at,
              evidence_id: e.evidence_id, evidence_no: e.evidence_no, case_id: e.case_id,
              evidence_status: e.status,
            };
            out.content_version = f.content_version;
            rows.push(out);
          }
          return [rows];
        }
        throw new Error(`FakeMysql: unrecognised statement: ${sql.slice(0, 80)}`);
      },
      release() { entry.released = true; entry.userVarAtRelease = state.userVar; },
      destroy() { entry.destroyed = true; },
    };
  }

  const registry = {
    get(role) {
      return {
        role,
        acquireTimeoutMs: 1000,
        pool: { getConnection: async () => makeConn(role) },
      };
    },
    async closeAll() {},
  };
  const db = createDb({ registry, logger: silentLogger });
  return { db, log, checkouts, data };
}

// ---- Qdrant / embedding fakes ----------------------------------------------------------
export const VEC = Object.freeze(new Array(384).fill(0).map((_, i) => (i === 0 ? 1 : 0)));

// A hit exactly as the Phase 1 store returns it: { id, score, payload }.
export function hit(kind, recordId, { caseId, evidenceId, version = 1, score = 0.8 } = {}) {
  return {
    id: pointId(kind, recordId),
    score,
    payload: buildPayload({
      kind,
      recordId,
      evidenceId: kind === "evidence" ? recordId : (evidenceId ?? null),
      caseId: caseId ?? null,
      contentVersion: version,
    }),
  };
}

export function fakeVector({ hits = [], embedError, searchError, onSearch } = {}) {
  const calls = { embed: [], search: [] };
  return {
    calls,
    getVector: () => ({
      embedder: {
        async embedQuery(text) {
          calls.embed.push(text);
          if (embedError) throw embedError;
          return VEC;
        },
      },
      store: {
        async search(args) {
          calls.search.push(args);
          if (searchError) throw searchError;
          if (onSearch) await onSearch(args);
          return typeof hits === "function" ? hits(args) : hits;
        },
      },
    }),
  };
}

export const qdrantDown = () =>
  new VectorError("QDRANT_UNAVAILABLE", "The vector database is not reachable right now.", { status: 503 });
