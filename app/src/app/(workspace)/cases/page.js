import Link from "next/link";
import { requireSession } from "@/lib/auth/server";
import { listCases } from "@/lib/workspace/repository.js";

export const metadata = { title: "Cases" };

export default async function CasesPage() {
  const session = await requireSession();
  let cases = [];
  let failed = false;
  try { cases = await listCases({ role: session.role, userId: session.userId }); } catch { failed = true; }
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Cases</h1>
        <p className="mt-2 text-sm text-ink-soft">Investigations available to your signed-in account. Access is checked by MySQL on every request.</p>
      </header>
      {failed ? <p role="alert" className="rounded-sm border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">Cases could not be loaded. Check the MySQL connection and your database account permissions.</p> : null}
      {!failed && cases.length === 0 ? <p className="rounded-sm border border-line bg-panel p-5 text-sm text-ink-soft">No cases are currently available to this account.</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {cases.map((item) => (
          <article key={item.case_id} className="rounded-sm border border-line bg-panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-mono text-sm font-semibold">{item.case_number}</p>
              <span className="rounded-full bg-paper px-3 py-1 text-xs font-medium capitalize text-ink-soft">{String(item.status).replace("_", " ")}</span>
            </div>
            <h2 className="mt-3 text-lg font-semibold">{item.title}</h2>
            <p className="mt-2 line-clamp-3 text-sm leading-6 text-ink-soft">{item.description || "No case description provided."}</p>
            <div className="mt-5 flex flex-wrap gap-4 text-sm text-ink-soft">
              <span><strong className="text-ink">{item.evidence_count}</strong> evidence records</span>
              <span><strong className="text-ink">{item.finding_count}</strong> findings</span>
            </div>
            <Link href={`/evidence?case_id=${item.case_id}`} className="mt-5 inline-flex rounded-sm border border-line px-3 py-2 text-sm font-medium hover:bg-paper focus-visible:outline-accent">View evidence</Link>
          </article>
        ))}
      </div>
    </div>
  );
}
