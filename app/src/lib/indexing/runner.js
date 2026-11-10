// The polling loop. One instance = one worker process (see worker/README.md).
//
//   start()  : optional crash recovery, then claim -> process -> repeat until stop()
//   runOnce(): one claim + process cycle (used by `--once` and by tests)
//
// Back-off: after an outage the loop waits base * 2^n ms (capped) before claiming again, so
// a down Qdrant or MySQL is not hammered and no job loses attempts while it is down.
// After a batch that sent jobs back for a retry (transient failure) it also waits
// base * 2^(attempts-1) ms (capped) so the attempts of one job are not used up within
// seconds. index_job has no "retry after" column, so the delay is per batch, in memory.

export function createWorker({
  repo,
  processor,
  config,
  logger = console,
  sleep = (ms, signal) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    }),
}) {
  let stopping = false;
  let needsRecovery = config.recoverOnStart;
  let outageStreak = 0;
  const abort = new AbortController();

  async function recover() {
    const res = await repo.recoverInterrupted(config.maxAttempts);
    needsRecovery = false;
    if (res.requeued || res.failed) {
      logger.warn("[tracex:worker] recovered interrupted jobs", res);
    }
  }

  async function runOnce() {
    if (needsRecovery) await recover();
    const jobs = await repo.claimPending(config.batchSize);
    const summary = await processor.processBatch(jobs);
    if (summary.needsRecovery || summary.outage) needsRecovery = true;
    return summary;
  }

  function retryDelayMs(attempts) {
    const n = Math.min(Math.max(attempts - 1, 0), 20);
    return Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** n);
  }

  function backoffMs() {
    return Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** Math.min(Math.max(outageStreak - 1, 0), 20));
  }

  async function start() {
    logger.info("[tracex:worker] started", {
      batchSize: config.batchSize,
      maxAttempts: config.maxAttempts,
    });
    while (!stopping) {
      let summary;
      try {
        summary = await runOnce();
      } catch (err) {
        // Claiming or recovery failed (usually MySQL unreachable).
        needsRecovery = true;
        outageStreak += 1;
        logger.error("[tracex:worker] cycle failed", { code: err?.code ?? "ERROR" });
        await sleep(backoffMs(), abort.signal);
        continue;
      }
      if (summary.outage) {
        outageStreak += 1;
        logger.warn("[tracex:worker] dependency unavailable, backing off", { ms: backoffMs() });
        await sleep(backoffMs(), abort.signal);
      } else {
        outageStreak = 0;
        if (summary.retried > 0) await sleep(retryDelayMs(summary.retryAttempts), abort.signal);
        if (summary.claimed > 0) {
          logger.info("[tracex:worker] batch done", {
            claimed: summary.claimed,
            upserted: summary.upserted,
            deleted: summary.deleted,
            skipped: summary.skipped,
            retried: summary.retried,
            failed: summary.failed,
          });
        } else {
          await sleep(config.pollIntervalMs, abort.signal);
        }
      }
    }
    logger.info("[tracex:worker] stopped");
  }

  // Finishes the current batch, then the loop ends.
  function stop() {
    stopping = true;
    abort.abort();
  }

  // Drains the queue once (until a cycle claims nothing, or a dependency is down).
  async function drain() {
    const total = { claimed: 0, upserted: 0, deleted: 0, skipped: 0, retried: 0, failed: 0, outage: false };
    for (;;) {
      const s = await runOnce();
      for (const k of ["claimed", "upserted", "deleted", "skipped", "retried", "failed"]) total[k] += s[k];
      if (s.outage) { total.outage = true; break; }
      if (s.claimed === 0) break;
      if (s.retried > 0) await sleep(retryDelayMs(s.retryAttempts), abort.signal);
    }
    return total;
  }

  return { start, stop, runOnce, drain };
}
