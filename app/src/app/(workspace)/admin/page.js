import { requireRole } from "@/lib/auth/server";
import { getVectorServices } from "@/lib/vector/index.js";
import { query } from "@/lib/db/index.js";
import { toDbSession } from "@/lib/auth/access.js";
import ReindexButton from "@/components/admin/ReindexButton";

export const metadata = { title: "Administration" };

export default async function AdministrationPage() {
  const session = await requireRole(["admin"]);
  let collection = null, jobs = [], error = "";
  try {
    const { store } = getVectorServices();
    [collection, jobs] = await Promise.all([
      store.inspectCollection(),
      query(toDbSession(session), "SELECT status, operation, COUNT(*) AS total FROM index_job GROUP BY status, operation ORDER BY status, operation"),
    ]);
  } catch { error = "Vector status could not be read. Check Qdrant, the configured collection and the administrator database account."; }
  const queued = jobs.reduce((n, row) => n + (["pending", "processing", "failed"].includes(row.status) ? Number(row.total) : 0), 0);
  return (
    <div className="flex flex-col gap-6">
      <header><h1 className="text-3xl font-semibold tracking-tight">Administration</h1><p className="mt-2 text-sm text-ink-soft">Administrator controls for the Qdrant index and MySQL indexing outbox.</p></header>
      {error ? <p role="alert" className="rounded-sm border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</p> : null}
      <section className="rounded-sm border border-line bg-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Qdrant collection</h2><p className="mt-1 font-mono text-xs text-ink-soft">{collection?.name || "tracex_records"}</p></div><span className={collection?.exists && collection.problems.length === 0 ? "rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700" : "rounded-full bg-rose-50 px-3 py-1 text-xs font-medium text-rose-700"}>{collection?.exists && collection.problems.length === 0 ? "Healthy" : "Needs attention"}</span></div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-sm bg-paper p-4"><p className="text-xs text-ink-soft">Vector points</p><p className="mt-1 text-2xl font-semibold tabular-nums">{collection?.points ?? "—"}</p></div><div className="rounded-sm bg-paper p-4"><p className="text-xs text-ink-soft">Queued / failed jobs</p><p className="mt-1 text-2xl font-semibold tabular-nums">{queued}</p></div><div className="rounded-sm bg-paper p-4"><p className="text-xs text-ink-soft">Collection status</p><p className="mt-1 text-sm font-semibold">{collection?.status || "Unavailable"}</p></div></div>
        {collection?.problems?.length ? <ul className="mt-4 list-disc pl-5 text-sm text-rose-700">{collection.problems.map((item) => <li key={item}>{item}</li>)}</ul> : null}
      </section>
      <section className="rounded-sm border border-line bg-panel p-5"><h2 className="font-semibold">Repair and synchronize the index</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-ink-soft">This calls the database backfill procedure to queue active evidence and findings whose vectors are missing or stale, then drains the worker. It does not delete or recreate the project's collection. Keep the standalone worker running for continuous processing during normal use.</p><div className="mt-4"><ReindexButton /></div></section>
      <section className="rounded-sm border border-line bg-panel p-5"><h2 className="font-semibold">Indexing outbox</h2>{jobs.length ? <table className="mt-3 w-full text-left text-sm"><thead className="text-xs uppercase text-ink-soft"><tr><th className="py-2">Status</th><th className="py-2">Operation</th><th className="py-2 text-right">Jobs</th></tr></thead><tbody className="divide-y divide-line">{jobs.map((j) => <tr key={`${j.status}-${j.operation}`}><td className="py-2 capitalize">{j.status}</td><td className="py-2">{j.operation}</td><td className="py-2 text-right tabular-nums">{j.total}</td></tr>)}</tbody></table> : <p className="mt-3 text-sm text-ink-soft">No indexing jobs were returned.</p>}</section>
    </div>
  );
}
