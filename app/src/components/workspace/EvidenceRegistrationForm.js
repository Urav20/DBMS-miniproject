"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function EvidenceRegistrationForm({ cases, types, initialCaseId = "" }) {
  const router = useRouter();
  const [caseId, setCaseId] = useState(String(initialCaseId || ""));
  const [typeId, setTypeId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [extractedText, setExtractedText] = useState("");
  const [sha256, setSha256] = useState("");
  const [fileSize, setFileSize] = useState("");
  const [collectedAt, setCollectedAt] = useState("");
  const [method, setMethod] = useState("Digital acquisition");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  async function submit(event) {
    event.preventDefault(); setBusy(true); setMessage(""); setError(false);
    try {
      const response = await fetch("/api/workspace/evidence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        case_id: Number(caseId), type_id: Number(typeId), title, description,
        extracted_text: extractedText || null, sha256: sha256 || null,
        file_size_bytes: fileSize === "" ? null : Number(fileSize), collected_at: collectedAt,
        method, location: location || null, notes: notes || null,
      }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || "Evidence could not be registered.");
      setMessage(`Registered ${body.evidence_no || "evidence"}; indexing has been queued.`);
      router.refresh();
      if (body.evidence_id) router.push(`/evidence/${body.evidence_id}`);
    } catch (err) { setError(true); setMessage(err.message); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 rounded-sm border border-line bg-panel p-5 md:grid-cols-2">
      <div className="md:col-span-2"><h2 className="font-semibold">Register evidence metadata</h2><p className="mt-1 text-sm leading-6 text-ink-soft">This schema stores evidence metadata, hashes and extracted text; it does not upload or retain the original binary file.</p></div>
      <label className="text-xs font-medium text-ink-soft">Case<select required value={caseId} onChange={(e) => setCaseId(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink"><option value="">Choose a case…</option>{cases.filter((c) => c.status !== "closed").map((c) => <option key={c.case_id} value={c.case_id}>{c.case_number} · {c.title}</option>)}</select></label>
      <label className="text-xs font-medium text-ink-soft">Evidence type<select required value={typeId} onChange={(e) => setTypeId(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink"><option value="">Choose a type…</option>{types.map((t) => <option key={t.type_id} value={t.type_id}>{t.name}</option>)}</select></label>
      <label className="text-xs font-medium text-ink-soft md:col-span-2">Title<input required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" /></label>
      <label className="text-xs font-medium text-ink-soft md:col-span-2">Description<textarea required rows={3} maxLength={60000} value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" /></label>
      <label className="text-xs font-medium text-ink-soft md:col-span-2">Extracted text for semantic indexing<textarea rows={5} maxLength={500000} value={extractedText} onChange={(e) => setExtractedText(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" placeholder="Paste text extracted from the source file, if available." /></label>
      <label className="text-xs font-medium text-ink-soft">SHA-256 hash (optional)<input value={sha256} onChange={(e) => setSha256(e.target.value)} maxLength={64} pattern="[A-Fa-f0-9]{64}" placeholder="64 hexadecimal characters" className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 font-mono text-sm text-ink" /></label>
      <label className="text-xs font-medium text-ink-soft">File size in bytes (optional)<input type="number" min="0" step="1" value={fileSize} onChange={(e) => setFileSize(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" /></label>
      <label className="text-xs font-medium text-ink-soft">Collection date and time<input type="datetime-local" required value={collectedAt} onChange={(e) => setCollectedAt(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" /></label>
      <label className="text-xs font-medium text-ink-soft">Collection method<input required maxLength={100} value={method} onChange={(e) => setMethod(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" /></label>
      <label className="text-xs font-medium text-ink-soft">Collection location (optional)<input maxLength={150} value={location} onChange={(e) => setLocation(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" /></label>
      <label className="text-xs font-medium text-ink-soft">Collection notes (optional)<textarea rows={2} maxLength={60000} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" /></label>
      <div className="md:col-span-2 flex flex-wrap items-center gap-3"><button disabled={busy || !cases.some((c) => String(c.case_id) === caseId && c.status !== "closed") || types.length === 0} className="rounded-sm bg-night px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Registering…" : "Register evidence"}</button>{message ? <p role="status" className={error ? "text-sm text-rose-700" : "text-sm text-emerald-700"}>{message}</p> : null}</div>
    </form>
  );
}
