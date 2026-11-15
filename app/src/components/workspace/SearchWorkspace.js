"use client";

import { useState } from "react";

export default function SearchWorkspace({ cases }) {
  const [query, setQuery] = useState("");
  const [caseId, setCaseId] = useState("");
  const [kind, setKind] = useState("all");
  const [limit, setLimit] = useState("10");
  const [results, setResults] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function search(event) {
    event.preventDefault(); setBusy(true); setError(""); setResults([]); setMeta(null);
    try {
      const body = { query, kind, limit: Number(limit) };
      if (caseId) body.case_id = Number(caseId);
      const response = await fetch("/api/search/semantic", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "Search could not be completed.");
      setResults(payload.results ?? []); setMeta(payload.meta ?? null);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={search} className="rounded-sm border border-line bg-panel p-5">
        <label htmlFor="semantic-query" className="block text-sm font-semibold">What are you looking for?</label>
        <textarea id="semantic-query" value={query} onChange={(e) => setQuery(e.target.value)} required maxLength={2000} rows={3} placeholder="Describe an event, activity or evidence pattern in ordinary language…" className="mt-2 w-full rounded-sm border border-line bg-white px-3 py-3 text-sm outline-none focus:border-accent" />
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-medium text-ink-soft">Case scope
            <select value={caseId} onChange={(e) => setCaseId(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink"><option value="">All cases I can access</option>{cases.map((item) => <option key={item.case_id} value={item.case_id}>{item.case_number}</option>)}</select>
          </label>
          <label className="text-xs font-medium text-ink-soft">Record type
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink"><option value="all">Evidence and findings</option><option value="evidence">Evidence only</option><option value="finding">Findings only</option></select>
          </label>
          <label className="text-xs font-medium text-ink-soft">Maximum results
            <select value={limit} onChange={(e) => setLimit(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink"><option value="5">5</option><option value="10">10</option><option value="20">20</option><option value="50">50</option></select>
          </label>
        </div>
        <button disabled={busy || query.trim().length === 0} className="mt-4 rounded-sm bg-night px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Searching…" : "Search evidence"}</button>
      </form>
      {error ? <p role="alert" className="rounded-sm border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}</p> : null}
      {meta ? <p className="text-xs text-ink-soft">{meta.candidates_examined} vector candidates examined · {meta.returned} results passed MySQL authorization and version checks. {meta.notice}</p> : null}
      {meta && results.length === 0 ? <p className="rounded-sm border border-line bg-panel p-5 text-sm text-ink-soft">No accessible, current matches were returned. Try different wording or a broader case scope.</p> : null}
      {results.map((item) => <article key={`${item.record_type}-${item.record_id}`} className="rounded-sm border border-line bg-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-mono text-xs text-ink-soft">{item.evidence_no} · {item.record_type} · case {item.case_id}</p><span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-800">Similarity {item.similarity_score.toFixed(4)}</span></div>
        <h2 className="mt-2 text-base font-semibold">{item.title}</h2>
        <p className="mt-1 text-xs text-ink-soft">Rank {item.rank}{item.severity ? ` · ${item.severity} severity` : ""}</p>
      </article>)}
      <p className="text-xs leading-5 text-ink-soft">A similarity match is a lead, not proof. MySQL re-checks case access, evidence status and content version before a result is displayed. Only an analyst can record a relationship and provide a written rationale.</p>
    </div>
  );
}
