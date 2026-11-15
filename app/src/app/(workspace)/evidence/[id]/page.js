import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth/server";
import { getEvidenceDetail, listCaseTeammates, listAnalysisTools, listEvidence } from "@/lib/workspace/repository.js";
import EvidenceWorkflow from "@/components/workspace/EvidenceWorkflow";

export const metadata = { title: "Evidence details" };

export default async function EvidenceDetailPage({ params }) {
  const session = await requireSession();
  const route = await params;
  const evidenceId = Number(route?.id);
  if (!Number.isSafeInteger(evidenceId) || evidenceId < 1) notFound();
  const dbSession = { role: session.role, userId: session.userId };
  let detail;
  let teammates = [], tools = [], relatedEvidence = [];
  try {
    detail = await getEvidenceDetail(dbSession, evidenceId);
    if (!detail) notFound();
    [teammates, tools, relatedEvidence] = await Promise.all([
      listCaseTeammates(dbSession, Number(detail.evidence.case_id)),
      listAnalysisTools(dbSession),
      listEvidence(dbSession, Number(detail.evidence.case_id)),
    ]);
  } catch (error) {
    if (error?.digest?.startsWith("NEXT_HTTP_ERROR_FALLBACK")) throw error;
    return <div role="alert" className="rounded-sm border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800">Evidence details could not be loaded. Check MySQL connectivity and your case permissions.</div>;
  }
  const item = detail.evidence;
  return <div className="flex flex-col gap-6">
    <Link href={`/evidence?case_id=${item.case_id}`} className="text-sm font-medium text-accent">← Evidence in {item.case_number}</Link>
    <header><div className="flex flex-wrap items-center gap-3"><p className="font-mono text-sm text-ink-soft">{item.evidence_no}</p><span className="rounded-full bg-paper px-3 py-1 text-xs capitalize text-ink-soft">{item.status}</span><span className="rounded-full bg-paper px-3 py-1 text-xs capitalize text-ink-soft">{String(item.case_status).replace("_", " ")}</span></div><h1 className="mt-2 text-3xl font-semibold tracking-tight">{item.title}</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-ink-soft">{item.description}</p><p className="mt-2 text-xs text-ink-soft">{item.case_number} · {item.case_title} · {item.type_name}</p></header>
    {item.extracted_text ? <details className="rounded-sm border border-line bg-panel p-4"><summary className="cursor-pointer text-sm font-semibold">View extracted text used for semantic indexing</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-xs leading-5 text-ink-soft">{item.extracted_text}</pre></details> : null}
    <EvidenceWorkflow evidence={item} collection={detail.collection} analyses={detail.analyses} relationships={detail.relationships} teammates={teammates} tools={tools} relatedEvidence={relatedEvidence} currentUserId={session.userId} />
  </div>;
}
