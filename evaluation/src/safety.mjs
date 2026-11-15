// Hard guards. Every script that can write (MySQL rows, Qdrant points, collection deletes)
// calls these first. They fail closed: anything that is not clearly an evaluation target is refused.

import { EVAL_PREFIX, SIZES } from "../config.mjs";

const EVAL_NAME = /^tracex_eval[A-Za-z0-9_]{0,40}$/;

export class EvalSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "EvalSafetyError";
  }
}

export function assertEvalDb(name) {
  if (typeof name !== "string" || !EVAL_NAME.test(name)) {
    throw new EvalSafetyError(
      `Refusing to use database ${JSON.stringify(name)}: evaluation databases must be named ${EVAL_PREFIX}* (e.g. ${EVAL_PREFIX}_500).`,
    );
  }
  return name;
}

export function assertEvalCollection(name) {
  if (typeof name !== "string" || !EVAL_NAME.test(name)) {
    throw new EvalSafetyError(
      `Refusing to use Qdrant collection ${JSON.stringify(name)}: evaluation collections must be named ${EVAL_PREFIX}*.`,
    );
  }
  return name;
}

export function assertSize(size) {
  if (!SIZES.includes(size)) throw new EvalSafetyError(`size must be one of ${SIZES.join(", ")}.`);
  return size;
}

export const evalDbName = (size) => assertEvalDb(`${EVAL_PREFIX}_${assertSize(size)}`);
export const evalCollectionName = (size) => assertEvalCollection(`${EVAL_PREFIX}_${assertSize(size)}`);

// Points this process at the evaluation targets. Call BEFORE the db or vector layers are used:
// they read DB_NAME / QDRANT_COLLECTION from the environment when they first connect.
// The values in .env.local (your development database and collection) are overwritten in this
// process only; nothing is written back to any file.
export function applyEvalEnv(size, env = process.env) {
  const dbName = evalDbName(size);
  const collection = evalCollectionName(size);
  env.DB_NAME = dbName;
  env.QDRANT_COLLECTION = collection;
  assertEvalEnv(env);
  return { size, dbName, collection };
}

// Defence in depth: re-check the environment the libraries will actually read.
export function assertEvalEnv(env = process.env) {
  assertEvalDb(env.DB_NAME);
  assertEvalCollection(env.QDRANT_COLLECTION);
}

// Asks MySQL which database the connection really uses (not what we think we configured).
export async function assertConnectedToEvalDb(db, session) {
  const rows = await db.withSession(session, (q) => q.query("SELECT DATABASE() AS db"));
  return assertEvalDb(rows?.[0]?.db ?? null);
}

// The only place that may delete a Qdrant collection.
export async function deleteEvalCollection(client, name) {
  assertEvalCollection(name);
  const { exists } = await client.collectionExists(name);
  if (!exists) return false;
  await client.deleteCollection(name);
  return true;
}
