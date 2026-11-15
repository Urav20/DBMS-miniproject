import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth/server";
import { listCases, listEvidence, listCaseCustody } from "@/lib/workspace/repository.js";

export const metadata = { title: "Case details" };

export default async function CaseDetailPage({ params }) {
  const session = await requireSession();
  const route = await params;
  const caseId = Number(route?.id);
  if (!Number.isSafeInteger(caseId) || caseId < 1) notFound();
  const dbSession = { role: session.role, userId: session.userId };
  let caseRow, evidence, custody;
  try {
    const cases = await listCases(dbSession);
    caseRow = cases.find((item) => Number(item.case_id) === caseId);
    if (!caseRow) notFound();
    [evidence, custody] = await Promise.all([listEvidence(dbSession, caseId), listCaseCustody(dbSession, caseId)]);
  } catch (error) {
    if (error?.digest?.startsWith("NEXT_HTTP_ERROR_FALLBACK")) throw error;
    return <p role="alert" className="rounded-sm border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">Case details could not be loaded. Check the MySQL connection and your case access.</p>;
  }
  const byEvidence = new Map();
  for (const event of custody) {
    if (!byEvidence.has(event.evidence_id)) byEvidence.set(event.evidence_id, []);
    byEvidence.get(event.evidence_id).push(event);
  }
  return (
    <div className="flex flex-col gap-6">
      <Link href="/cases" className="text-sm font-medium text-accent">← All cases</Link>
      <header><div className="flex flex-wrap items-center gap-3"><p className="font-mono text-sm text-ink-soft">{caseRow.case_number}</p><span className="rounded-full bg-paper px-3 py-1 text-xs capitalize text-ink-soft">{String(caseRow.status).replace("_", " ")}</span></div><h1 className="mt-2 text-3xl font-semibold tracking-tight">{caseRow.title}</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-ink-soft">{caseRow.description || "No case description provided."}</p></header>
      <div className="flex flex-wrap gap-4 text-sm text-ink-soft"><span><strong className="text-ink">{evidence.length}</strong> evidence records</span><span><strong className="text-ink">{custody.length}</strong> custody events</span></div>
      <section className="rounded-sm border border-line bg-panel p-5"><h2 className="font-semibold">Evidence in this case</h2>{evidence.length ? <div className="mt-3 divide-y divide-line">{evidence.map((item) => <div key={item.evidence_id} className="py-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-mono text-xs text-ink-soft">{item.evidence_no} · {item.type_name}</p><p className="mt-1 text-sm font-medium">{item.title}</p><p className="mt-1 text-xs text-ink-soft">{item.current_custodian_name || "Custodian not available"} · {item.status}</p></div><Link href="/evidence" className="text-xs font-semibold text-accent">Evidence workspace</Link></div>{item.description ? <p className="mt-2 text-sm leading-6 text-ink-soft">{item.description}</p> : null}</div>)}</div> : <p className="mt-3 text-sm text-ink-soft">No evidence is currently visible.</p>}</section>
      <section className="rounded-sm border border-line bg-panel p-5"><h2 className="font-semibold">Chain of custody</h2><p className="mt-1 text-xs text-ink-soft">Events are displayed in sequence for each evidence record. MySQL keeps this history append-only.</p>
        {evidence.map((item) => {
          const events = byEvidence.get(item.evidence_id) ?? [];
          return <div key={item.evidence_id} className="mt-5"><h3 className="text-sm font-semibold">{item.evidence_no} · {item.title}</h3>{events.length ? <ol className="mt-3 border-l-2 border-line pl-4">{events.map((event) => <li key={event.seq_no} className="relative pb-4 last:pb-0"><span aria-hidden="true" className="absolute -left-[1.33rem] top-1 size-2.5 rounded-full bg-accent" /><p className="text-sm font-medium">{event.from_user || "Initial intake"} → {event.to_user}</p><p className="mt-1 text-xs text-ink-soft">Step {event.seq_no} · {new Date(event.transferred_at).toLocaleString()}</p>{event.reason ? <p className="mt-1 text-xs text-ink-soft">{event.reason}</p> : null}</li>)}</ol> : <p className="mt-2 text-xs text-ink-soft">No custody events available.</p>}</div>;
        })}
      </section>
    </div>
  );
}
