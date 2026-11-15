import { requireSession } from "@/lib/auth/server";
import { listCases } from "@/lib/workspace/repository.js";
import SearchWorkspace from "@/components/workspace/SearchWorkspace";

export const metadata = { title: "Semantic search" };

export default async function SearchPage() {
  const session = await requireSession();
  let cases = [];
  try { cases = await listCases({ role: session.role, userId: session.userId }); } catch { /* The search API will report a database issue with a safe message. */ }
  return (
    <div className="flex flex-col gap-6">
      <header><h1 className="text-3xl font-semibold tracking-tight">Semantic search</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-ink-soft">Search by meaning rather than exact wording. Results are re-validated against MySQL before they are shown.</p></header>
      <SearchWorkspace cases={cases} />
    </div>
  );
}
