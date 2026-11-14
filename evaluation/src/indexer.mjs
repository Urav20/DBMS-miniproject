// Indexes the evaluation records with the EXISTING Phase 2 worker (outbox -> embedder -> Qdrant).
// Only evaluation targets are accepted: the collection name, the MySQL database seen by the
// admin connection AND the database seen by the worker connection must all be tracex_eval*.
// The worker connects with DB_NAME from this process's environment, which applyEvalEnv() has
// pointed at the evaluation database, so it cannot claim a job from your development database.
import { assertConnectedToEvalDb, assertEvalCollection, deleteEvalCollection, EvalSafetyError } from "./safety.mjs";

export async function indexEvalCollection({ db, adminSession, workerSession, worker, store, expectedRecords, now = () => performance.now(), log = () => {} }) {
  const collection = assertEvalCollection(store.name);
  const adminDb = await assertConnectedToEvalDb(db, adminSession);
  const workerDb = await assertConnectedToEvalDb(db, workerSession);
  if (adminDb !== workerDb) throw new EvalSafetyError("The admin and worker connections point at different databases.");

  const [{ pending }] = await db.withSession(adminSession, (q) =>
    q.query("SELECT COUNT(*) AS pending FROM index_job WHERE status = 'pending'"),
  );
  if (Number(pending) !== expectedRecords) {
    throw new EvalSafetyError(`Expected ${expectedRecords} pending index jobs in ${adminDb}, found ${pending}. Rebuild and reload the evaluation database.`);
  }

  // A fresh collection every time: stale points from an earlier run can never leak into this one.
  const deleted = await deleteEvalCollection(store.client, collection);
  log(`${deleted ? "deleted and recreating" : "creating"} Qdrant collection ${collection}`);
  await store.ensureCollection();

  const t0 = now();
  const summary = await worker.drain();
  const seconds = (now() - t0) / 1000;
  if (summary.outage || summary.failed > 0) {
    throw new Error(`Indexing did not complete cleanly: ${JSON.stringify(summary)}`);
  }

  const [{ left_over: left }] = await db.withSession(adminSession, (q) =>
    q.query("SELECT COUNT(*) AS left_over FROM index_job WHERE status <> 'done'"),
  );
  const [{ unindexed }] = await db.withSession(adminSession, (q) =>
    q.query("SELECT COUNT(*) AS unindexed FROM evidence WHERE status = 'active' AND indexed_version IS NULL"),
  );
  const points = await store.countPoints();
  if (Number(left) !== 0 || Number(unindexed) !== 0 || points !== expectedRecords) {
    throw new Error(`Index verification failed: jobs not done=${left}, evidence not indexed=${unindexed}, points=${points}, expected=${expectedRecords}.`);
  }
  return { database: adminDb, collection, records: expectedRecords, points, seconds, records_per_second: expectedRecords / seconds, worker: summary };
}
