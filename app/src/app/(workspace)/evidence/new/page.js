import Link from "next/link";
import { requireSession } from "@/lib/auth/server";
import { listCases, listEvidenceTypes } from "@/lib/workspace/repository.js";
import EvidenceRegistrationForm from "@/components/workspace/EvidenceRegistrationForm";

export const metadata = { title: "Register evidence" };

export default async function RegisterEvidencePage({ searchParams }) {
  const session = await requireSession();
  const params = await searchParams;
  const initial = params?.case_id ? Number(params.case_id) : "";
  const validInitial = Number.isSafeInteger(initial) && initial > 0 ? String(initial) : "";
  let cases = [], types = [], failed = false;
  try {
    const dbSession = { role: session.role, userId: session.userId };
    [cases, types] = await Promise.all([listCases(dbSession), listEvidenceTypes(dbSession)]);
  } catch { failed = true; }
  return (
    <div className="flex flex-col gap-6">
      <Link href="/evidence" className="text-sm font-medium text-accent">← Evidence workspace</Link>
      <header><h1 className="text-3xl font-semibold tracking-tight">Register evidence</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-ink-soft">Create the MySQL evidence record, collection event and initial custody entry. The database outbox queues the text for vector indexing.</p></header>
      {failed ? <p role="alert" className="rounded-sm border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">Cases and evidence types could not be loaded. Check the database connection.</p> : <EvidenceRegistrationForm cases={cases} types={types} initialCaseId={validInitial} />}
    </div>
  );
}
