// Populates an EMPTY evaluation database through Person A's stored procedures
// (sp_create_case, sp_register_evidence) as the evaluation administrator. The existing triggers
// queue the index_job rows, so indexing later goes through the normal Phase 2 outbox.
import { CASES, MAX_RECORDS_PER_CASE } from "../config.mjs";
import { assertConnectedToEvalDb, assertEvalDb, EvalSafetyError } from "./safety.mjs";
import { tierRecords } from "./dataset.mjs";
import { evalCaseNumber } from "./eval-env.mjs";

const COLLECTED_AT = "2026-01-15 09:00:00"; // fixed and safely in the past
const REGISTER_METHOD = "Synthetic evaluation load";
export const LOADER_CONSTANTS = Object.freeze({ COLLECTED_AT, REGISTER_METHOD });
const first = (resultSets, name) => {
  const row = resultSets?.[0]?.[0];
  const v = row?.[name] ?? (row ? Object.values(row)[0] : undefined);
  if (v === undefined) throw new Error(`Stored procedure did not return ${name}.`);
  return Number(v);
};

export async function populateEvalDatabase({ db, session, dataset, size, log = () => {} }) {
  const dbName = assertEvalDb(await assertConnectedToEvalDb(db, session));
  const records = tierRecords(dataset, size);

  const perCase = {};
  for (const r of records) perCase[r.case_index] = (perCase[r.case_index] ?? 0) + 1;
  if (Math.max(...Object.values(perCase)) > MAX_RECORDS_PER_CASE) {
    throw new EvalSafetyError(`A case would hold more than ${MAX_RECORDS_PER_CASE} records; sp_register_evidence numbers evidence with LPAD(n, 2) and would create duplicate evidence_no values.`);
  }

  const [{ n: existing }] = await db.withSession(session, (q) =>
    q.query("SELECT (SELECT COUNT(*) FROM evidence) + (SELECT COUNT(*) FROM investigation_case) AS n"),
  );
  if (Number(existing) !== 0) {
    throw new EvalSafetyError(`${dbName} is not empty. Rebuild it (README, step 2) instead of loading twice.`);
  }

  const types = await db.withSession(session, (q) => q.query("SELECT type_id, name FROM evidence_type"));
  const typeId = new Map(types.map((t) => [t.name, Number(t.type_id)]));
  for (const t of new Set(records.map((r) => r.type))) {
    if (!typeId.has(t)) throw new EvalSafetyError(`Evidence type "${t}" is missing from the evaluation seed.`);
  }

  const caseIds = [];
  for (let i = 0; i < CASES; i += 1) {
    const res = await db.callProcedure(session, "sp_create_case", caseArgs(size, i));
    caseIds.push(first(res.resultSets, "case_id"));
  }

  let done = 0;
  for (let c = 0; c < CASES; c += 1) {
    const mine = records.filter((r) => r.case_index === c);
    await db.withSession(session, async (conn) => {
      for (const r of mine) {
        const res = await conn.call("sp_register_evidence", registerArgs(caseIds[c], typeId.get(r.type), r));
        first(res.resultSets, "evidence_id");
        done += 1;
        if (done % 100 === 0) log(`  registered ${done}/${records.length}`);
      }
    });
  }

  const [{ ev }] = await db.withSession(session, (q) => q.query("SELECT COUNT(*) AS ev FROM evidence"));
  const [{ jobs }] = await db.withSession(session, (q) => q.query("SELECT COUNT(*) AS jobs FROM index_job WHERE status = 'pending'"));
  if (Number(ev) !== records.length) throw new Error(`Expected ${records.length} evidence rows, found ${ev}.`);
  return { database: dbName, cases: caseIds.length, evidence: Number(ev), pending_index_jobs: Number(jobs) };
}

// Positional arguments of sp_register_evidence (12), in the order the procedure declares them.
export function registerArgs(caseId, typeId, r) {
  return [caseId, null, typeId, r.title, r.description, r.extracted_text, r.sha256, r.extracted_text.length, COLLECTED_AT, REGISTER_METHOD, null, null];
}

// Positional arguments of sp_create_case (3).
export function caseArgs(size, i) {
  return [evalCaseNumber(size, i), `Evaluation case ${i + 1} (synthetic data)`, "Synthetic evidence for the TRACE-X Phase 4 retrieval evaluation."];
}
