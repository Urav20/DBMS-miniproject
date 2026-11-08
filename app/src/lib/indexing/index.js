// Public entry point for the indexing worker library (server-side only).
//
//   import { createDefaultWorker } from "@/lib/indexing";   // or a relative path in scripts
//   const { worker, config, vector } = createDefaultWorker();
//   await worker.start();
//
// Uses the existing db layer (role "worker") and the existing vector services.

import * as dbLayer from "../db/index.js";
import { getVectorServices } from "../vector/index.js";
import { loadWorkerConfig } from "./config.js";
import { createIndexRepository } from "./repository.js";
import { createProcessor } from "./processor.js";
import { createWorker } from "./runner.js";

export function createDefaultWorker(env = process.env, logger = console) {
  const config = loadWorkerConfig(env);
  const vector = getVectorServices(env);
  const repo = createIndexRepository({ db: dbLayer });
  const processor = createProcessor({
    repo,
    embedder: vector.embedder,
    store: vector.store,
    config,
    logger,
  });
  const worker = createWorker({ repo, processor, config, logger });
  return { worker, repo, processor, config, vector };
}

export { loadWorkerConfig, WORKER_DEFAULTS } from "./config.js";
export { createIndexRepository, WORKER_SESSION } from "./repository.js";
export { createProcessor, targetOf } from "./processor.js";
export { createWorker } from "./runner.js";
export { IndexingError, FAILURE, classifyError } from "./errors.js";
