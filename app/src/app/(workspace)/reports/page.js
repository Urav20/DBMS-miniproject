import { requireRole } from "@/lib/auth/server";
import { listAudit } from "@/lib/workspace/repository.js";

export const metadata = { title: "Reports and audit" };

export default async function ReportsPage() {
  const session = await requireRole(["admin"]);
  let rows = [];
  let failed = false;
  try { rows = await listAudit({ role: session.role, userId: session.userId }, 100); } catch { failed = true; }
  return (
    <div className="flex flex-col gap-6">
      <header><h1 className="text-3xl font-semibold tracking-tight">Reports and audit</h1><p className="mt-2 text-sm text-ink-soft">Administrator-only audit history from MySQL. The audit log is append-only.</p></header>
      <section className="rounded-sm border border-line bg-panel p-5"><h2 className="font-semibold">Retrieval evaluation</h2><p className="mt-2 text-sm text-ink-soft">The Phase 4 report compares keyword, vector-only and hybrid retrieval on synthetic 500- and 2,000-record datasets. In those runs, vector-only led on Precision@10, Recall@10, F1@10, MAP and NDCG@10. These findings do not establish performance on real forensic evidence.</p><a href="https://github.com/Urav20/DBMS-miniproject/blob/main/evaluation/results/REPORT.md" target="_blank" rel="noreferrer" className="mt-3 inline-flex text-sm font-semibold text-accent underline">Open Phase 4 benchmark report</a></section>
      {failed ? <p role="alert" className="rounded-sm border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">The audit log could not be read. Check the administrator database connection.</p> : null}
      <section className="overflow-x-auto rounded-sm border border-line bg-panel">
        <div className="border-b border-line px-5 py-4"><h2 className="font-semibold">Recent audit events</h2><p className="mt-1 text-xs text-ink-soft">Latest {rows.length} events</p></div>
        {rows.length ? <table className="w-full min-w-[800px] text-left text-sm"><thead className="bg-paper text-xs uppercase tracking-wide text-ink-soft"><tr><th className="px-4 py-3">Time</th><th className="px-4 py-3">Action</th><th className="px-4 py-3">Entity</th><th className="px-4 py-3">Case</th><th className="px-4 py-3">Actor</th><th className="px-4 py-3">Details</th></tr></thead><tbody className="divide-y divide-line">{rows.map((item) => <tr key={item.audit_id}><td className="whitespace-nowrap px-4 py-3 text-xs text-ink-soft">{new Date(item.created_at).toLocaleString()}</td><td className="px-4 py-3 font-medium">{item.action}</td><td className="px-4 py-3">{item.entity_type} #{item.entity_id}</td><td className="px-4 py-3">{item.case_id ?? "—"}</td><td className="px-4 py-3">{item.full_name || item.username || "System"}</td><td className="max-w-sm truncate px-4 py-3 text-xs text-ink-soft">{typeof item.details === "string" ? item.details : JSON.stringify(item.details ?? {})}</td></tr>)}</tbody></table> : !failed ? <p className="p-5 text-sm text-ink-soft">No audit events are available.</p> : null}
      </section>
    </div>
  );
}
