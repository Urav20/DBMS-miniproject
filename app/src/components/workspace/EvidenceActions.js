"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function EvidenceActions({ item, canWithdraw }) {
  const router = useRouter();
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function save(event) {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      const res = await fetch(`/api/workspace/evidence/${item.evidence_id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description, extracted_text: item.extracted_text ?? null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message || "The evidence could not be updated.");
      setMessage("Saved. A new indexing job has been queued; the worker will refresh its vector.");
      router.refresh();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function withdraw() {
    if (!reason.trim()) { setMessage("Enter a reason before withdrawing this record."); return; }
    if (!window.confirm("Withdraw this evidence? It will remain in the provenance record but be removed from semantic search after the worker processes the queue.")) return;
    setBusy(true); setMessage("");
    try {
      const res = await fetch(`/api/workspace/evidence/${item.evidence_id}`, {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message || "The evidence could not be withdrawn.");
      setMessage("Withdrawn. A vector-delete job has been queued for the indexing worker.");
      router.refresh();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  if (item.status !== "active" || item.case_status === "closed") return <span className="text-xs text-ink-soft">No changes available</span>;
  return (
    <details className="min-w-52">
      <summary className="cursor-pointer text-sm font-medium text-accent">Manage vector text</summary>
      <div className="mt-3 flex flex-col gap-3 rounded-sm border border-line bg-paper p-3">
        <form onSubmit={save} className="flex flex-col gap-2">
          <label className="text-xs font-medium" htmlFor={`title-${item.evidence_id}`}>Title</label>
          <input id={`title-${item.evidence_id}`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required className="rounded-sm border border-line bg-panel px-2 py-2 text-sm" />
          <label className="text-xs font-medium" htmlFor={`desc-${item.evidence_id}`}>Description</label>
          <textarea id={`desc-${item.evidence_id}`} value={description} onChange={(e) => setDescription(e.target.value)} rows={3} required className="rounded-sm border border-line bg-panel px-2 py-2 text-sm" />
          <button disabled={busy} className="rounded-sm bg-night px-3 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? "Saving…" : "Save and re-index"}</button>
        </form>
        {canWithdraw ? <div className="border-t border-line pt-3">
          <label className="text-xs font-medium" htmlFor={`reason-${item.evidence_id}`}>Withdrawal reason</label>
          <input id={`reason-${item.evidence_id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={255} placeholder="Required reason" className="mt-1 w-full rounded-sm border border-line bg-panel px-2 py-2 text-sm" />
          <button type="button" disabled={busy} onClick={withdraw} className="mt-2 rounded-sm border border-rose-300 px-3 py-2 text-sm font-medium text-rose-700 disabled:opacity-50">Withdraw and remove vector</button>
        </div> : null}
        {message ? <p role="status" className="text-xs text-ink-soft">{message}</p> : null}
      </div>
    </details>
  );
}
