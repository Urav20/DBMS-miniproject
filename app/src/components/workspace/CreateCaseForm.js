"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CreateCaseForm() {
  const router = useRouter();
  const [caseNumber, setCaseNumber] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setMessage(""); setError(false);
    try {
      const response = await fetch("/api/workspace/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case_number: caseNumber, title, description: description || null }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || "The case could not be created.");
      setMessage("Case created."); setCaseNumber(""); setTitle(""); setDescription("");
      router.refresh();
      if (body.case_id) router.push(`/cases/${body.case_id}`);
    } catch (err) { setError(true); setMessage(err.message); }
    finally { setBusy(false); }
  }
  return (
    <details className="rounded-sm border border-line bg-panel p-5">
      <summary className="cursor-pointer font-semibold">Create a new investigation case</summary>
      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-ink-soft">Case number<input value={caseNumber} onChange={(e) => setCaseNumber(e.target.value)} maxLength={30} required placeholder="TX-2026-006" className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" /></label>
        <label className="text-xs font-medium text-ink-soft">Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" /></label>
        <label className="text-xs font-medium text-ink-soft sm:col-span-2">Description<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={10000} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" /></label>
        <div className="sm:col-span-2 flex flex-wrap items-center gap-3"><button disabled={busy} className="rounded-sm bg-night px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Creating…" : "Create case"}</button>{message ? <p role="status" className={error ? "text-sm text-rose-700" : "text-sm text-emerald-700"}>{message}</p> : null}</div>
      </form>
    </details>
  );
}
