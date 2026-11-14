// Checks that run against the evaluation database before anything is measured or written.
import { ADMIN_USERNAME, CASES } from "../config.mjs";
import { EvalSafetyError, assertConnectedToEvalDb } from "./safety.mjs";
import { tierRecords } from "./dataset.mjs";

// The session user id only opens the connection for a read-only lookup (admin accounts hold
// SELECT on the base tables regardless of it). It carries no authority and is not assumed to be
// the admin: the real administrator is looked up by username and verified below.
const LOOKUP_ONLY_SESSION = Object.freeze({ role: "admin", userId: 1 });

export const evalCaseNumber = (size, caseIndex) => `EVAL-${size}-${101 + caseIndex}`;

export async function resolveEvalAdmin({ db, username = ADMIN_USERNAME, expectedId = null }) {
  await assertConnectedToEvalDb(db, LOOKUP_ONLY_SESSION);
  const rows = await db.withSession(LOOKUP_ONLY_SESSION, (q) =>
    q.query(
      "SELECT u.user_id, u.is_active, r.role_name FROM app_user u JOIN `role` r ON r.role_id = u.role_id WHERE u.username = ?",
      [username],
    ),
  );
  if (rows.length !== 1) {
    throw new EvalSafetyError(`Evaluation admin "${username}" was not found. Rebuild the evaluation database (see README, step 2).`);
  }
  const u = rows[0];
  if (Number(u.is_active) !== 1 || u.role_name !== "Administrator") {
    throw new EvalSafetyError(`User "${username}" must be an active Administrator (found role ${u.role_name}, active=${u.is_active}).`);
  }
  const userId = Number(u.user_id);
  if (expectedId !== null && Number(expectedId) !== userId) {
    throw new EvalSafetyError(`EVAL_ADMIN_USER_ID=${expectedId} does not match the administrator "${username}" (id ${userId}).`);
  }
  return { role: "admin", userId };
}

// The database must hold ONLY this tier's evaluation cases (and, after loading, only its records).
export async function readEvalCases({ db, session, size }) {
  const rows = await db.withSession(session, (q) => q.query("SELECT case_id, case_number FROM investigation_case ORDER BY case_id"));
  return rows.map((r) => ({ case_id: Number(r.case_id), case_number: String(r.case_number) }));
}

export function assertOnlyEvalCases(cases, size) {
  const expected = new Set(Array.from({ length: CASES }, (_, i) => evalCaseNumber(size, i)));
  const foreign = cases.filter((c) => !expected.has(c.case_number));
  if (foreign.length) throw new EvalSafetyError(`The database contains ${foreign.length} case(s) that are not evaluation cases.`);
  return cases;
}

// evidence_id -> record key, via evidence.sha256 = sha256("tracex-eval:" + key).
export async function buildIdMap({ db, session, dataset, size }) {
  const rows = await db.withSession(session, (q) => q.query("SELECT evidence_id, sha256, status FROM evidence"));
  const bySha = new Map(tierRecords(dataset, size).map((r) => [r.sha256, r.key]));
  const idToKey = new Map();
  const seen = new Set();
  for (const r of rows) {
    const key = bySha.get(r.sha256);
    if (!key) throw new EvalSafetyError("The database holds an evidence row that is not in the evaluation dataset.");
    if (seen.has(key)) throw new EvalSafetyError(`Record ${key} appears more than once.`);
    seen.add(key);
    if (r.status !== "active") throw new EvalSafetyError(`Record ${key} is not active.`);
    idToKey.set(Number(r.evidence_id), key);
  }
  if (idToKey.size !== bySha.size) {
    throw new EvalSafetyError(`Expected ${bySha.size} evaluation records, found ${idToKey.size}. Load the dataset first (README, step 3).`);
  }
  return idToKey;
}

export async function readMysqlMeta({ db, session }) {
  try {
    const [r] = await db.withSession(session, (q) =>
      q.query("SELECT VERSION() AS version, @@innodb_ft_min_token_size AS ft_min_token_size, @@innodb_ft_enable_stopword AS ft_stopwords_enabled"),
    );
    return { version: r.version, innodb_ft_min_token_size: Number(r.ft_min_token_size), innodb_ft_enable_stopword: Number(r.ft_stopwords_enabled) };
  } catch (err) {
    return { unavailable: String(err?.name ?? "error") };
  }
}
