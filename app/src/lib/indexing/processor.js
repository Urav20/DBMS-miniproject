// Processes one claimed batch of index_job rows.
//
// Principle: MySQL is the source of truth, so a job is a *hint to reconcile one record*,
// not a command. The decision is made from the record's CURRENT state:
//
//   evidence active    -> its vector must exist at the current content_version
//   evidence withdrawn -> its vector must not exist
//   finding            -> same, and also gone while its evidence is withdrawn
//
// That makes every job idempotent: the Qdrant point ID is deterministic (UUIDv5 of
// kind + id) so re-running overwrites the same point, and deleting a missing point is a
// no-op. Duplicate or out-of-order jobs therefore cannot corrupt the index.
//
// Qdrant payload = kind, record_id, evidence_id, case_id, content_version only (built by
// lib/vector/ids.js). No text, titles or names are ever sent to Qdrant.

import { pointId, buildPayload } from "../vector/ids.js";
import { buildEvidenceText, buildFindingText } from "../vector/text.js";
import {
  FAILURE,
  IndexingError,
  classifyError,
  formatLastError,
} from "./errors.js";

const permanent = (code, message) =>
  new IndexingError(code, message, { failure: FAILURE.PERMANENT });

// { kind, recordId } or null when the job does not name exactly one target.
export function targetOf(job) {
  const hasE = job.evidence_id !== null && job.evidence_id !== undefined;
  const hasF = job.finding_id !== null && job.finding_id !== undefined;
  if (hasE === hasF) return null; // none or both: violates the table's CHECK
  const recordId = Number(hasE ? job.evidence_id : job.finding_id);
  if (!Number.isSafeInteger(recordId) || recordId < 1) return null;
  return { kind: hasE ? "evidence" : "finding", recordId };
}

export function createProcessor({ repo, embedder, store, config, logger = console }) {
  const { maxAttempts } = config;

  // ---- outcomes ------------------------------------------------------------
  // Each helper swallows its own repository errors: if MySQL is down while we record a
  // result, the job simply stays 'processing' and is requeued by crash recovery.
  // `summary.needsRecovery` tells the runner to do that before the next claim.

  async function safely(summary, jobId, fn) {
    try {
      await fn();
      return true;
    } catch (err) {
      summary.needsRecovery = true;
      logger.error("[tracex:worker] could not record job result", {
        jobId,
        code: classifyError(err).code,
      });
      return false;
    }
  }

  // Returns true when the job really was closed in MySQL.
  async function done(summary, job, note = null) {
    const ok = await safely(summary, job.job_id, () => repo.markJobDone(job.job_id, note));
    if (ok && note) summary.skipped += 1;
    return ok;
  }

  async function handleFailure(summary, job, err) {
    const c = classifyError(err);
    const lastError = formatLastError(c);
    logger.warn("[tracex:worker] job failed", {
      jobId: job.job_id,
      failure: c.failure,
      code: c.code,
      attempts: job.attempts,
    });

    if (c.failure === FAILURE.OUTAGE) {
      summary.outage = true;
      await safely(summary, job.job_id, () =>
        repo.releaseJob(job.job_id, lastError, { countAttempt: false }),
      );
      return;
    }
    if (c.failure === FAILURE.PERMANENT || job.attempts >= maxAttempts) {
      summary.failed += 1;
      await safely(summary, job.job_id, () => repo.markJobFailed(job.job_id, lastError));
      return;
    }
    summary.retried += 1;
    summary.retryAttempts = Math.max(summary.retryAttempts, Number(job.attempts) || 1);
    await safely(summary, job.job_id, () => repo.releaseJob(job.job_id, lastError));
  }

  async function releaseUntouched(summary, jobs) {
    for (const job of jobs) {
      await safely(summary, job.job_id, () =>
        repo.releaseJob(job.job_id, "[INDEX_DEFERRED] Waiting for a dependency to recover.", {
          countAttempt: false,
        }),
      );
    }
  }

  // ---- decision ------------------------------------------------------------
  // Returns { action: "upsert", text, payload } | { action: "delete" } | { action: "skip", note }
  // or throws a permanent IndexingError.
  function decide(job, target, evidenceRows, findingRows) {
    const { kind, recordId } = target;

    if (kind === "evidence") {
      const row = evidenceRows.get(recordId);
      if (job.operation === "delete") {
        if (row && row.status === "active") {
          return { action: "skip", note: "delete ignored, evidence is active in MySQL" };
        }
        return { action: "delete" };
      }
      if (!row) throw permanent("INDEX_SOURCE_NOT_FOUND", "The evidence row was not found.");
      if (row.status === "withdrawn") return { action: "delete" };
      return upsertDecision(job, row, {
        kind,
        recordId,
        evidenceId: recordId,
        caseId: Number(row.case_id),
        text: buildEvidenceText(row),
      });
    }

    // finding
    if (job.operation === "delete") return { action: "delete" };
    const row = findingRows.get(recordId);
    if (!row) throw permanent("INDEX_SOURCE_NOT_FOUND", "The finding row was not found.");
    if (row.evidence_status === "withdrawn") return { action: "delete" };
    return upsertDecision(job, row, {
      kind,
      recordId,
      evidenceId: Number(row.evidence_id),
      caseId: Number(row.case_id),
      text: buildFindingText(row),
    });
  }

  function upsertDecision(job, row, { kind, recordId, evidenceId, caseId, text }) {
    const rowVersion = Number(row.content_version);
    const jobVersion = Number(job.content_version);
    if (jobVersion < rowVersion) {
      return { action: "skip", note: `superseded, record is at version ${rowVersion}` };
    }
    if (jobVersion > rowVersion) {
      throw permanent(
        "INDEX_VERSION_MISMATCH",
        "The job is for a newer content version than MySQL holds.",
      );
    }
    if (text.trim() === "") {
      throw permanent("INDEX_EMPTY_TEXT", "The record has no text to embed.");
    }
    return {
      action: "upsert",
      text,
      payload: buildPayload({ kind, recordId, evidenceId, caseId, contentVersion: rowVersion }),
    };
  }

  // ---- embedding with failure isolation ------------------------------------
  // One batched call is fast. If it fails for a non-outage reason, retry item by item so a
  // single bad text cannot fail its neighbours. Returns Array<{ vector } | { error }>.
  async function embedAll(items) {
    try {
      const vectors = await embedder.embedDocuments(items.map((i) => i.text));
      return vectors.map((vector) => ({ vector }));
    } catch (err) {
      if (classifyError(err).failure === FAILURE.OUTAGE || items.length === 1) {
        return items.map(() => ({ error: err }));
      }
    }
    const out = [];
    for (const item of items) {
      try {
        const [vector] = await embedder.embedDocuments([item.text]);
        out.push({ vector });
      } catch (error) {
        out.push({ error });
        if (classifyError(error).failure === FAILURE.OUTAGE) {
          // Dependency is down: the rest would fail the same way.
          while (out.length < items.length) out.push({ error });
        }
      }
    }
    return out;
  }

  // ---- the batch -----------------------------------------------------------
  async function processBatch(jobs) {
    const summary = {
      claimed: jobs.length,
      upserted: 0,
      deleted: 0,
      skipped: 0,
      retried: 0,
      failed: 0,
      outage: false,
      needsRecovery: false,
      retryAttempts: 0, // highest attempt count among jobs sent back for a retry (back-off hint)
    };
    if (jobs.length === 0) return summary;

    // 1. Group by target. Only the newest job per target does the work; older ones are
    //    duplicates (or superseded). The outcome depends on MySQL state, not on which job
    //    ran, so nothing is lost. Duplicates are closed only AFTER the newest job of their
    //    record succeeded (see closeDuplicates), so no job is marked done without success.
    const groups = new Map();
    for (const job of jobs) {
      const target = targetOf(job);
      if (!target) {
        summary.failed += 1;
        await safely(summary, job.job_id, () =>
          repo.markJobFailed(
            job.job_id,
            formatLastError({
              code: "INDEX_BAD_JOB",
              message: "The job does not name exactly one evidence or finding.",
            }),
          ),
        );
        continue;
      }
      const key = `${target.kind}:${target.recordId}`;
      if (!groups.has(key)) groups.set(key, { target, jobs: [] });
      groups.get(key).jobs.push(job);
    }

    const primaries = [];
    const duplicates = [];
    for (const { target, jobs: list } of groups.values()) {
      list.sort((a, b) => Number(a.job_id) - Number(b.job_id));
      const primary = list[list.length - 1];
      for (const older of list.slice(0, -1)) duplicates.push({ job: older, primary });
      primaries.push({ job: primary, target });
    }

    const succeeded = new Set(); // job_ids of primaries closed as done
    try {
      await processPrimaries(summary, primaries, succeeded);
    } finally {
      await closeDuplicates(summary, duplicates, succeeded);
    }
    return summary;
  }

  // Older jobs of a record: closed as duplicates only if the job that covers them is done;
  // otherwise handed back untouched (no attempt used) so they are not lost.
  async function closeDuplicates(summary, duplicates, succeeded) {
    for (const { job, primary } of duplicates) {
      if (succeeded.has(primary.job_id)) {
        await done(summary, job, `duplicate, job ${primary.job_id} covers this record`);
      } else {
        await safely(summary, job.job_id, () =>
          repo.releaseJob(job.job_id, `[INDEX_DEFERRED] Waiting for job ${primary.job_id}.`, {
            countAttempt: false,
          }),
        );
      }
    }
  }

  async function processPrimaries(summary, primaries, succeeded) {
    if (primaries.length === 0) return;
    const finish = async (job, note = null) => {
      if (await done(summary, job, note)) succeeded.add(job.job_id);
    };

    // 2. Read the authoritative rows from MySQL. Evidence and findings are read separately
    //    and a failure only affects the jobs that needed that read: one unreadable finding
    //    must not fail or stall evidence jobs in the same batch.
    const evidenceJobs = primaries.filter((p) => p.target.kind === "evidence");
    const findingUpserts = primaries.filter(
      (p) => p.target.kind === "finding" && p.job.operation === "upsert",
    );
    let evidenceRows = new Map();
    let findingRows = new Map();
    const unreadable = new Set(); // job_ids already handled by a failed read

    async function read(group, fetch, assign) {
      if (group.length === 0) return;
      try {
        assign(await fetch(group.map((p) => p.target.recordId)));
      } catch (err) {
        for (const { job } of group) {
          unreadable.add(job.job_id);
          await handleFailure(summary, job, err);
        }
      }
    }
    await read(evidenceJobs, (ids) => repo.fetchEvidence(ids), (m) => { evidenceRows = m; });
    if (!summary.outage) {
      await read(findingUpserts, (ids) => repo.fetchFindings(ids), (m) => { findingRows = m; });
    }
    if (summary.outage) {
      // MySQL itself is unavailable: hand everything not yet handled back untouched.
      await releaseUntouched(
        summary,
        primaries.filter((p) => !unreadable.has(p.job.job_id)).map((p) => p.job),
      );
      return;
    }

    // 3. Decide per job.
    const deletes = [];
    const upserts = [];
    for (const { job, target } of primaries) {
      if (unreadable.has(job.job_id)) continue;
      let decision;
      try {
        decision = decide(job, target, evidenceRows, findingRows);
      } catch (err) {
        await handleFailure(summary, job, err);
        continue;
      }
      if (decision.action === "skip") await finish(job, decision.note);
      else if (decision.action === "delete") deletes.push({ job, target });
      else upserts.push({ job, target, ...decision });
    }

    // 4. Deletes (withdrawal). Deleting a missing point is not an error.
    let stopped = false;
    for (let i = 0; i < deletes.length; i += 1) {
      if (stopped) {
        await releaseUntouched(summary, deletes.slice(i).map((d) => d.job));
        break;
      }
      const { job, target } = deletes[i];
      try {
        await store.deletePoints([pointId(target.kind, target.recordId)]);
      } catch (err) {
        await handleFailure(summary, job, err);
        stopped = summary.outage;
        continue;
      }
      summary.deleted += 1;
      await finish(job);
    }
    if (stopped) {
      await releaseUntouched(summary, upserts.map((u) => u.job));
      return;
    }

    // 5. Upserts: embed, write the point, then record indexed_version, then close the job.
    //    The job is closed only after BOTH the Qdrant write and the MySQL bookkeeping worked.
    if (upserts.length === 0) return;
    const embedded = await embedAll(upserts);
    for (let i = 0; i < upserts.length; i += 1) {
      const item = upserts[i];
      if (stopped) {
        await releaseUntouched(summary, [item.job]);
        continue;
      }
      const result = embedded[i];
      try {
        if (result.error) throw result.error;
        await store.upsertPoints([
          {
            id: pointId(item.target.kind, item.target.recordId),
            vector: result.vector,
            payload: item.payload,
          },
        ]);
      } catch (err) {
        await handleFailure(summary, item.job, err);
        stopped = summary.outage;
        continue;
      }
      try {
        await repo.markIndexed(item.target.kind, item.target.recordId, item.payload.content_version);
      } catch (err) {
        // The point is already in Qdrant; only the bookkeeping failed. Retry the job: the
        // repeat upsert is identical.
        await handleFailure(summary, item.job, err);
        stopped = summary.outage;
        continue;
      }
      summary.upserted += 1;
      await finish(item.job);
    }
  }

  return { processBatch };
}
