import Link from "next/link";
import { requireSession } from "@/lib/auth/server";
import { listEvidence } from "@/lib/workspace/repository.js";
import EvidenceActions from "@/components/workspace/EvidenceActions";

export const metadata = { title: "Evidence" };

export default async function EvidencePage({ searchParams }) {
  const session = await requireSession();
  const params = await searchParams;
  const parsed = params?.case_id ? Number(params.case_id) : null;
  const caseId = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  let records = [];
  let failed = false;
  try { records = await listEvidence({ role: session.role, userId: session.userId }, caseId); } catch { failed = true; }
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3"><div><h1 className="text-3xl font-semibold tracking-tight">Evidence</h1><p className="mt-2 text-sm text-ink-soft">MySQL is authoritative for each record and its provenance. Text changes queue vector refreshes through the outbox.</p></div><Link href={caseId ? `/evidence/new?case_id=${caseId}` : "/evidence/new"} className="rounded-sm bg-night px-4 py-2.5 text-sm font-semibold text-white">Register evidence</Link></header>
      {caseId ? <p className="text-sm text-ink-soft">Filtered to case ID {caseId}.</p> : null}
      {failed ? <p role="alert" className="rounded-sm border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">Evidence could not be loaded. Check MySQL connectivity and the investigator view grants.</p> : null}
      {!failed && records.length === 0 ? <p className="rounded-sm border border-line bg-panel p-5 text-sm text-ink-soft">No evidence records are visible for this selection.</p> : null}
      {records.length ? <div className="overflow-x-auto rounded-sm border border-line bg-panel"><table className="w-full min-w-[1100px] text-left text-sm">
        <thead className="bg-paper text-xs uppercase tracking-wide text-ink-soft"><tr><th className="px-4 py-3">Evidence</th><th className="px-4 py-3">Case</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Vector version</th><th className="px-4 py-3">Custodian</th><th className="px-4 py-3">Details / actions</th></tr></thead>
        <tbody className="divide-y divide-line">{records.map((item) => {
          const indexed = session.role !== "admin" ? "Index version is admin-only" : item.status === "withdrawn" ? "Removal queued / verify worker" : item.indexed_version === item.content_version ? `Current · v${item.indexed_version}` : item.indexed_version == null ? "Pending index" : `Stale · v${item.indexed_version} → v${item.content_version}`;
          return <tr key={item.evidence_id} className="align-top hover:bg-paper/60"><td className="px-4 py-4"><p className="font-semibold">{item.evidence_no}</p><p className="mt-1 max-w-xs text-ink-soft">{item.title}</p></td><td className="px-4 py-4 font-mono text-xs">{item.case_number}</td><td className="px-4 py-4">{item.type_name}</td><td className="px-4 py-4"><span className={item.status === "active" ? "rounded-full bg-emerald-50 px-2 py-1 text-xs text-emerald-700" : "rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600"}>{item.status}</span></td><td className="px-4 py-4 text-xs text-ink-soft">{indexed}</td><td className="px-4 py-4">{item.current_custodian_name || "—"}</td><td className="px-4 py-4"><div className="flex flex-col items-start gap-2"><Link href={`/evidence/${item.evidence_id}`} className="text-xs font-semibold text-accent underline">Open details & workflow</Link><EvidenceActions item={item} canWithdraw={session.role === "admin" || Number(item.registered_by) === Number(session.userId)} /></div></td></tr>;
        })}</tbody>
      </table></div> : null}
    </div>
  );
}
