"use client";

import { useState } from "react";

export default function VectorPointLookup() {
  const [kind, setKind] = useState("evidence");
  const [recordId, setRecordId] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function inspect(event) {
    event.preventDefault(); setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch(`/api/admin/vector/point?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(recordId)}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || body.message || "No point was returned.");
      setResult(body.point);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return (
    <section className="rounded-sm border border-line bg-panel p-5">
      <h2 className="font-semibold">Inspect a vector point</h2>
      <p className="mt-1 text-sm text-ink-soft">Look up the deterministic Qdrant point ID and payload for an evidence record or finding. Raw vectors and document text are not exposed here.</p>
      <form onSubmit={inspect} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="text-xs font-medium text-ink-soft">Record type<select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink"><option value="evidence">Evidence</option><option value="finding">Finding</option></select></label>
        <label className="text-xs font-medium text-ink-soft">Record ID<input value={recordId} onChange={(e) => setRecordId(e.target.value)} required inputMode="numeric" pattern="[0-9]+" className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" placeholder="e.g. 12" /></label>
        <button disabled={busy || !recordId} className="rounded-sm bg-night px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Looking up…" : "Inspect point"}</button>
      </form>
      {error ? <p role="alert" className="mt-3 text-sm text-rose-700">{error}</p> : null}
      {result ? <div className="mt-4 rounded-sm bg-paper p-4"><p className="font-mono text-xs break-all">{result.id}</p><p className="mt-2 text-xs font-semibold uppercase text-ink-soft">Payload</p><pre className="mt-1 overflow-x-auto text-xs">{JSON.stringify(result.payload, null, 2)}</pre></div> : null}
    </section>
  );
}
