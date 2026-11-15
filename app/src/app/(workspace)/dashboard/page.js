import { requireSession } from "@/lib/auth/server";
import { listCases, listEvidence, listRecentCustody } from "@/lib/workspace/repository.js";
import ConnectionStatus from "@/components/dashboard/ConnectionStatus";
import Link from "next/link";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const session = await requireSession();
  let cases = [], evidence = [], custody = [], failed = false;
  try {
    const dbSession = { role: session.role, userId: session.userId };
    [cases, evidence, custody] = await Promise.all([listCases(dbSession), listEvidence(dbSession), listRecentCustody(dbSession, 6)]);
  } catch { failed = true; }
  const activeCases = cases.filter((c) => c.status !== "closed").length;
  const activeEvidence = evidence.filter((e) => e.status === "active").length;
  const stale = evidence.filter((e) => e.status === "active" && e.indexed_version !== null && Number(e.indexed_version) < Number(e.content_version)).length;
  return (
    <div className="flex flex-col gap-8">
      <header><h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1><p className="mt-2 max-w-3xl text-sm text-ink-soft">Live investigation data visible to your account. MySQL remains the authority for access, evidence status and provenance.</p></header>
      {failed ? <p role="alert" className="rounded-sm border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">The dashboard could not load its MySQL data. Check the database connection and the permissions for your role.</p> : null}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[["Accessible cases", cases.length], ["Active cases", activeCases], ["Visible evidence", evidence.length], ["Active evidence", activeEvidence]].map(([label, value]) => <article key={label} className="rounded-sm border border-line bg-panel p-5"><p className="text-sm text-ink-soft">{label}</p><p className="mt-2 text-3xl font-semibold tabular-nums">{failed ? "—" : value}</p></article>)}
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-sm border border-line bg-panel">
          <div className="flex items-center justify-between border-b border-line px-5 py-4"><h2 className="font-semibold">Your cases</h2><Link href="/cases" className="text-sm font-medium text-accent">View all</Link></div>
          <ul className="divide-y divide-line">{cases.slice(0, 5).map((item) => <li key={item.case_id} className="px-5 py-4"><p className="font-mono text-xs text-ink-soft">{item.case_number} · {String(item.status).replace("_", " ")}</p><p className="mt-1 text-sm font-medium">{item.title}</p><p className="mt-1 text-xs text-ink-soft">{item.evidence_count} evidence · {item.finding_count} findings</p></li>)}{cases.length === 0 && !failed ? <li className="px-5 py-5 text-sm text-ink-soft">No cases assigned.</li> : null}</ul>
        </section>
        <section className="rounded-sm border border-line bg-panel">
          <div className="border-b border-line px-5 py-4"><h2 className="font-semibold">Recent custody activity</h2></div>
          <ul className="divide-y divide-line">{custody.map((item, i) => <li key={`${item.evidence_id}-${item.seq_no}-${i}`} className="px-5 py-4"><p className="text-sm font-medium">{item.evidence_no} · {item.from_user || "Initial intake"} → {item.to_user}</p><p className="mt-1 text-xs text-ink-soft">{new Date(item.transferred_at).toLocaleString()} · {item.reason || "No reason recorded"}</p></li>)}{custody.length === 0 && !failed ? <li className="px-5 py-5 text-sm text-ink-soft">No custody events are visible.</li> : null}</ul>
        </section>
      </div>
      <ConnectionStatus />
      <aside className="border-l-4 border-marker bg-amber-50 p-5 text-sm leading-6 text-amber-950"><strong>A match is a lead, not proof.</strong><p>Semantic similarity ranks evidence by meaning. Similar wording does not prove that two records are related. An analyst must record any relationship and provide a written rationale.</p>{stale > 0 ? <p className="mt-2">{stale} active record(s) have stale vectors; ask an administrator to run the index repair.</p> : null}</aside>
    </div>
  );
}
