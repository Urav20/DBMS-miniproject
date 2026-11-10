// The ONLY file in the worker that contains SQL. Everything goes through the approved
// access layer (lib/db) with the "worker" role: { role: "worker", userId: null }.
//
// VERIFIED against the real database/01_schema.sql, 02_access.sql and 03_routines.sql
// (see worker/README.md, "SQL verification"). Summary of what the worker may do, taken
// from the `tracex_worker` grants in 02_access.sql:
//   index_job : SELECT, INSERT, UPDATE
//   evidence  : SELECT; UPDATE only on (indexed_version, indexed_at)
//   finding   : SELECT; UPDATE only on (indexed_version, indexed_at)
//   audit_log : INSERT (not used by the worker)
//   analysis  : NO PRIVILEGE. -> fetchFindings() needs it (finding -> analysis -> evidence)
//               and cannot succeed until Person A grants SELECT on analysis. See README B1.
// No view and no stored procedure is granted to the worker, so none is used.
//
// Why indexed_version updates are safe (03_routines.sql):
//   trg_evidence_bu / trg_finding_bu bump content_version ONLY when title, description or
//   extracted_text (finding: title, description) change; trg_evidence_au / trg_finding_au
//   queue a job ONLY when content_version changes. markIndexed() sets indexed_version and
//   indexed_at and nothing else, so it neither bumps the version nor queues a job.
//
// Concurrency: index_job has no claim token or lease column. claimPending() claims job by
// job with a compare-and-set UPDATE (WHERE status = 'pending'), so no job is ever returned
// to two claimers and only rows this call changed are returned. That fixes the claim race,
// but the worker is still explicitly SINGLE-PROCESS (crash recovery cannot tell whose
// 'processing' rows are stale, and two workers could embed different versions of the same
// record concurrently). See README B2.
// Transactions: the db layer runs prepared statements only, so no multi-statement
// transaction is used. Instead the ORDER of writes makes a crash harmless (Qdrant write,
// then indexed_version, then job 'done'; a re-run repeats the same idempotent upsert).

import { LAST_ERROR_MAX, IndexingError, FAILURE } from "./errors.js";

export const WORKER_SESSION = Object.freeze({ role: "worker", userId: null });

const JOB_COLUMNS =
  "job_id, evidence_id, finding_id, operation, content_version, status, attempts";

function assertLimit(n) {
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new TypeError("limit must be a whole number from 1 to 100");
  }
  return n;
}

function placeholders(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new TypeError("ids must be a non-empty array");
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError("ids must be positive whole numbers");
  }
  return ids.map(() => "?").join(", ");
}

const clip = (s) => String(s ?? "").slice(0, LAST_ERROR_MAX);

// MySQL privilege errors (1142 table, 1143 column, 1370 routine, 1044 database).
function isPrivilegeError(err) {
  const errno = err?.errno ?? err?.cause?.errno;
  return err?.code === "DB_PERMISSION_DENIED" || errno === 1142 || errno === 1143;
}

export function createIndexRepository({ db, session = WORKER_SESSION } = {}) {
  if (!db?.withSession) throw new Error("createIndexRepository requires the db access layer.");
  const run = (work) => db.withSession(session, work);

  return {
    // Crash recovery. Only valid when a single worker runs: any 'processing' row then
    // belongs to a previous run that died. Jobs already at the attempt limit are failed
    // (so a job that keeps crashing the process cannot loop forever); the rest go back
    // to 'pending'. Returns { requeued, failed }.
    async recoverInterrupted(maxAttempts) {
      return run(async (q) => {
        const failed = await q.query(
          `UPDATE index_job
              SET status = 'failed', processed_at = NOW(), last_error = ?
            WHERE status = 'processing' AND attempts >= ?`,
          [clip("[INDEX_INTERRUPTED] Worker stopped during the last allowed attempt."), maxAttempts],
        );
        const requeued = await q.query(
          `UPDATE index_job SET status = 'pending' WHERE status = 'processing'`,
        );
        return { requeued: requeued.affectedRows ?? 0, failed: failed.affectedRows ?? 0 };
      });
    },

    // Claims up to `limit` pending jobs, oldest first, and returns exactly those.
    //
    // The previous version ran one "UPDATE ... WHERE status='pending' ORDER BY job_id LIMIT n"
    // and then "SELECT ... WHERE status='processing'". That SELECT returned EVERY processing
    // row, not just the ones just claimed: leftovers of a crashed run (when recovery is off),
    // rows whose result could not be recorded, or another process's jobs. Those rows were
    // processed without a new attempt being counted, which defeats the attempt limit.
    //
    // Now: (1) list candidate ids, (2) claim each one with its own compare-and-set UPDATE
    // (affectedRows = 1 means "this call changed it", 0 means "someone else did"),
    // (3) read back only the rows this call claimed.
    // LIMIT cannot be a bound parameter reliably in prepared statements, so the (validated)
    // integer is written into the text; it never comes from outside the code.
    async claimPending(limit) {
      const n = assertLimit(limit);
      return run(async (q) => {
        const candidates = await q.query(
          `SELECT job_id FROM index_job WHERE status = 'pending' ORDER BY job_id LIMIT ${n}`,
        );
        const claimed = [];
        for (const row of candidates) {
          const res = await q.query(
            `UPDATE index_job
                SET status = 'processing', attempts = attempts + 1
              WHERE job_id = ? AND status = 'pending'`,
            [row.job_id],
          );
          // The compare-and-set only works if the db layer reports affectedRows for UPDATEs.
          // Fail loudly rather than silently claiming nothing (an idle, "healthy" worker).
          if (typeof res?.affectedRows !== "number") {
            throw new IndexingError(
              "INDEX_DB_RESULT",
              "The database layer did not report affectedRows for an UPDATE, so jobs cannot be claimed safely.",
              { failure: FAILURE.PERMANENT },
            );
          }
          if (res.affectedRows === 1) claimed.push(Number(row.job_id));
        }
        if (claimed.length === 0) return [];
        return q.query(
          `SELECT ${JOB_COLUMNS} FROM index_job
            WHERE job_id IN (${placeholders(claimed)}) AND status = 'processing'
            ORDER BY job_id`,
          claimed,
        );
      });
    },

    // Returns Map(evidence_id -> row). Authoritative text, case and status come from MySQL.
    async fetchEvidence(ids) {
      const marks = placeholders(ids); // validated before any connection is used
      const rows = await run((q) =>
        q.query(
          `SELECT evidence_id, case_id, title, description, extracted_text, status, content_version
             FROM evidence
            WHERE evidence_id IN (${marks})`,
          ids,
        ),
      );
      return new Map(rows.map((r) => [Number(r.evidence_id), r]));
    },

    // Returns Map(finding_id -> row). A finding reaches its evidence and case through its
    // analysis (finding.analysis_id -> analysis.evidence_id -> evidence.case_id).
    //
    // !! 02_access.sql gives tracex_worker NO privilege on `analysis`, so this statement is
    // refused by MySQL today. The query itself is correct against 01_schema.sql and starts
    // working as soon as Person A adds   GRANT SELECT ON tracex.analysis TO 'tracex_worker';
    // Until then the refusal is reported as a PERMANENT job failure of the finding upserts
    // only (INDEX_FINDING_ACCESS_MISSING), so it cannot block evidence jobs or back off the
    // whole worker. Finding DELETE jobs never call this and keep working.
    async fetchFindings(ids) {
      const marks = placeholders(ids);
      let rows;
      try {
        rows = await run((q) =>
          q.query(
            `SELECT f.finding_id, f.title, f.description, f.content_version,
                    a.evidence_id, e.case_id, e.status AS evidence_status
               FROM finding f
               JOIN analysis a ON a.analysis_id = f.analysis_id
               JOIN evidence e ON e.evidence_id = a.evidence_id
              WHERE f.finding_id IN (${marks})`,
            ids,
          ),
        );
      } catch (err) {
        if (isPrivilegeError(err)) {
          throw new IndexingError(
            "INDEX_FINDING_ACCESS_MISSING",
            "The worker account cannot read analysis, so a finding's evidence and case are unknown.",
            { failure: FAILURE.PERMANENT, cause: err },
          );
        }
        throw err;
      }
      return new Map(rows.map((r) => [Number(r.finding_id), r]));
    },

    // Startup check for run.mjs: can the worker resolve finding -> evidence? Reads no rows.
    async canResolveFindings() {
      try {
        await run((q) => q.query("SELECT analysis_id, evidence_id FROM analysis WHERE 1 = 0"));
        return true;
      } catch (err) {
        if (isPrivilegeError(err)) return false;
        throw err;
      }
    },

    // Step 3: record the version now in Qdrant. Never moves indexed_version backwards.
    // Sets ONLY indexed_version and indexed_at (the two columns the worker may update), which
    // the triggers treat as "not a content change".
    async markIndexed(kind, recordId, version) {
      if (kind !== "evidence" && kind !== "finding") throw new TypeError("unknown kind");
      const sql =
        kind === "evidence"
          ? `UPDATE evidence SET indexed_version = ?, indexed_at = NOW()
              WHERE evidence_id = ? AND (indexed_version IS NULL OR indexed_version <= ?)`
          : `UPDATE finding SET indexed_version = ?, indexed_at = NOW()
              WHERE finding_id = ? AND (indexed_version IS NULL OR indexed_version <= ?)`;
      await run((q) => q.query(sql, [version, recordId, version]));
    },

    // note (optional) explains a skipped job; stored in last_error, prefixed "skipped:".
    async markJobDone(jobId, note = null) {
      await run((q) =>
        q.query(
          `UPDATE index_job
              SET status = 'done', processed_at = NOW(), last_error = ?
            WHERE job_id = ? AND status = 'processing'`,
          [note ? clip(`skipped: ${note}`) : null, jobId],
        ),
      );
    },

    // Back to 'pending'. countAttempt=false gives the attempt back (used for outages, which
    // are not the job's fault).
    async releaseJob(jobId, lastError, { countAttempt = true } = {}) {
      await run((q) =>
        q.query(
          `UPDATE index_job
              SET status = 'pending', last_error = ?,
                  attempts = IF(?, attempts, GREATEST(attempts, 1) - 1)
            WHERE job_id = ? AND status = 'processing'`,
          [clip(lastError), countAttempt ? 1 : 0, jobId],
        ),
      );
    },

    async markJobFailed(jobId, lastError) {
      await run((q) =>
        q.query(
          `UPDATE index_job
              SET status = 'failed', processed_at = NOW(), last_error = ?
            WHERE job_id = ? AND status = 'processing'`,
          [clip(lastError), jobId],
        ),
      );
    },
  };
}
