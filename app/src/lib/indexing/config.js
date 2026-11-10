// Worker settings from environment variables (same style as lib/vector/config.js and
// lib/db/config.js: nothing read at import time, messages name the variable but never
// print a value). MySQL and Qdrant settings are NOT repeated here: they come from the
// existing DB_* and QDRANT_* / EMBEDDING_* variables.

import { IndexingError, FAILURE } from "./errors.js";

export const WORKER_DEFAULTS = Object.freeze({
  batchSize: 10, // api-contract.md section 5: claim up to 10 jobs
  pollIntervalMs: 2000,
  maxAttempts: 5, // api-contract.md section 5: retry up to 5 attempts
  backoffBaseMs: 1000,
  backoffMaxMs: 60000,
  recoverOnStart: true,
});

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

function fail(message) {
  return new IndexingError("INDEX_CONFIG", `Worker configuration error: ${message}`, {
    failure: FAILURE.PERMANENT,
  });
}

function readInt(env, name, fallback, min, max) {
  if (isBlank(env[name])) return fallback;
  const n = Number(env[name]);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw fail(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

function readBool(env, name, fallback) {
  if (isBlank(env[name])) return fallback;
  const v = String(env[name]).trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw fail(`${name} must be true or false.`);
}

export function loadWorkerConfig(env = process.env) {
  const cfg = {
    // index_job.attempts is TINYINT UNSIGNED (max 255); 20 is a sane upper bound.
    batchSize: readInt(env, "WORKER_BATCH_SIZE", WORKER_DEFAULTS.batchSize, 1, 100),
    pollIntervalMs: readInt(env, "WORKER_POLL_INTERVAL_MS", WORKER_DEFAULTS.pollIntervalMs, 100, 600000),
    maxAttempts: readInt(env, "WORKER_MAX_ATTEMPTS", WORKER_DEFAULTS.maxAttempts, 1, 20),
    backoffBaseMs: readInt(env, "WORKER_BACKOFF_BASE_MS", WORKER_DEFAULTS.backoffBaseMs, 100, 600000),
    backoffMaxMs: readInt(env, "WORKER_BACKOFF_MAX_MS", WORKER_DEFAULTS.backoffMaxMs, 100, 3600000),
    recoverOnStart: readBool(env, "WORKER_RECOVER_ON_START", WORKER_DEFAULTS.recoverOnStart),
  };
  if (cfg.backoffMaxMs < cfg.backoffBaseMs) {
    throw fail("WORKER_BACKOFF_MAX_MS must not be smaller than WORKER_BACKOFF_BASE_MS.");
  }
  return Object.freeze(cfg);
}
