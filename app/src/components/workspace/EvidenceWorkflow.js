"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

function StatusMessage({ value, error }) {
  return value ? <p role="status" className={error ? "text-sm text-rose-700" : "text-sm text-emerald-700"}>{value}</p> : null;
}

export default function EvidenceWorkflow({ evidence, collection, analyses, relationships, teammates, tools, relatedEvidence, currentUserId }) {
  const router = useRouter();
  const [toUserId, setToUserId] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [analysisToolId, setAnalysisToolId] = useState("");
  const [analysisNotes, setAnalysisNotes] = useState("");
  const [relationshipTarget, setRelationshipTarget] = useState("");
  const [relationshipType, setRelationshipType] = useState("related_activity");
  const [relationshipRationale, setRelationshipRationale] = useState("");
  const [findingDrafts, setFindingDrafts] = useState({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  const mutable = evidence.status === "active" && evidence.case_status !== "closed";
  const isCurrentCustodian = Number(evidence.current_custodian_id) === Number(currentUserId);
  const activeRelated = relatedEvidence.filter((r) => Number(r.evidence_id) !== Number(evidence.evidence_id) && r.status === "active");

  async function send(key, url, method, body) {
    setBusy(key); setMessage(""); setError(false);
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "The request was rejected.");
      setMessage(payload.message || "Saved.");
      router.refresh();
      return true;
    } catch (err) { setError(true); setMessage(err.message); return false; }
    finally { setBusy(""); }
  }

  async function transfer(event) {
    event.preventDefault();
    const ok = await send("transfer", `/api/workspace/evidence/${evidence.evidence_id}/custody`, "POST", { to_user_id: Number(toUserId), reason: transferReason });
    if (ok) { setToUserId(""); setTransferReason(""); }
  }

  async function startAnalysis(event) {
    event.preventDefault();
    const ok = await send("analysis", `/api/workspace/evidence/${evidence.evidence_id}/analysis`, "POST", { tool_id: Number(analysisToolId), notes: analysisNotes || null });
    if (ok) { setAnalysisToolId(""); setAnalysisNotes(""); }
  }

  async function completeAnalysis(analysisId) {
    await send(`complete-${analysisId}`, `/api/workspace/analysis/${analysisId}/complete`, "POST");
  }

  async function addFinding(event, analysisId) {
    event.preventDefault();
    const draft = findingDrafts[analysisId] ?? { title: "", description: "", severity: "medium" };
    const ok = await send(`finding-${analysisId}`, `/api/workspace/analysis/${analysisId}/findings`, "POST", draft);
    if (ok) setFindingDrafts((old) => ({ ...old, [analysisId]: { title: "", description: "", severity: "medium" } }));
  }

  async function linkEvidence(event) {
    event.preventDefault();
    const ok = await send("relationship", "/api/workspace/relationships", "POST", {
      evidence_a_id: Number(evidence.evidence_id), evidence_b_id: Number(relationshipTarget),
      rel_type: relationshipType, rationale: relationshipRationale,
    });
    if (ok) { setRelationshipTarget(""); setRelationshipRationale(""); }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-sm border border-line bg-panel p-5">
        <h2 className="font-semibold">Collection record</h2>
        {collection.length ? <div className="mt-3 divide-y divide-line">{collection.map((item) => <div key={item.collection_id} className="py-3 text-sm"><p className="font-medium">{item.method} · {item.collector_name}</p><p className="mt-1 text-xs text-ink-soft">{new Date(item.collected_at).toLocaleString()}{item.location ? ` · ${item.location}` : ""}</p>{item.notes ? <p className="mt-1 text-sm text-ink-soft">{item.notes}</p> : null}</div>)}</div> : <p className="mt-2 text-sm text-ink-soft">No collection event was returned.</p>}
        <div className="mt-4 grid gap-2 border-t border-line pt-4 text-xs text-ink-soft sm:grid-cols-2"><p><strong className="text-ink">SHA-256:</strong> <span className="break-all font-mono">{evidence.sha256 || "Not recorded"}</span></p><p><strong className="text-ink">File size:</strong> {evidence.file_size_bytes == null ? "Not recorded" : `${Number(evidence.file_size_bytes).toLocaleString()} bytes`}</p><p><strong className="text-ink">Registered:</strong> {new Date(evidence.registered_at).toLocaleString()}</p><p><strong className="text-ink">Content version:</strong> v{evidence.content_version}</p></div>
      </section>

      {mutable && isCurrentCustodian ? <section className="rounded-sm border border-line bg-panel p-5"><h2 className="font-semibold">Transfer chain of custody</h2><p className="mt-1 text-sm text-ink-soft">Only the current custodian can hand over active evidence to another active member of this case.</p>
        <form onSubmit={transfer} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-ink-soft">Receiving teammate<select required value={toUserId} onChange={(e) => setToUserId(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink"><option value="">Choose a teammate…</option>{teammates.map((u) => <option key={u.user_id} value={u.user_id}>{u.full_name} ({u.username})</option>)}</select></label>
          <label className="text-xs font-medium text-ink-soft">Reason<input required maxLength={255} value={transferReason} onChange={(e) => setTransferReason(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" /></label>
          <div className="sm:col-span-2"><button disabled={busy === "transfer" || !teammates.length} className="rounded-sm bg-night px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy === "transfer" ? "Recording…" : "Record custody transfer"}</button></div>
        </form>
      </section> : null}

      {mutable && !isCurrentCustodian ? <p className="rounded-sm border border-line bg-paper p-4 text-sm text-ink-soft">Custody transfer controls are available only to the current custodian.</p> : null}

      {mutable ? <section className="rounded-sm border border-line bg-panel p-5"><h2 className="font-semibold">Start an analysis</h2>
        <form onSubmit={startAnalysis} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-ink-soft">Analysis tool<select required value={analysisToolId} onChange={(e) => setAnalysisToolId(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink"><option value="">Choose a tool…</option>{tools.map((tool) => <option key={tool.tool_id} value={tool.tool_id}>{tool.name} · {tool.version}</option>)}</select></label>
          <label className="text-xs font-medium text-ink-soft">Notes (optional)<input maxLength={60000} value={analysisNotes} onChange={(e) => setAnalysisNotes(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" /></label>
          <div className="sm:col-span-2"><button disabled={busy === "analysis" || !tools.length} className="rounded-sm bg-night px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy === "analysis" ? "Starting…" : "Start analysis"}</button></div>
        </form>
      </section> : null}

      <section className="rounded-sm border border-line bg-panel p-5"><h2 className="font-semibold">Analyses and findings</h2>
        {analyses.length ? <div className="mt-3 space-y-4">{analyses.map((analysis) => {
          const own = Number(analysis.analyst_id) === Number(currentUserId);
          const draft = findingDrafts[analysis.analysis_id] ?? { title: "", description: "", severity: "medium" };
          return <article key={analysis.analysis_id} className="rounded-sm border border-line p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold">Analysis #{analysis.analysis_id} · {analysis.tool_name} {analysis.tool_version}</p><p className="mt-1 text-xs text-ink-soft">Analyst: {analysis.analyst_name} · Started {new Date(analysis.started_at).toLocaleString()}</p><p className="mt-1 text-xs text-ink-soft">{analysis.completed_at ? `Completed ${new Date(analysis.completed_at).toLocaleString()}` : "In progress"}</p>{analysis.notes ? <p className="mt-2 text-sm text-ink-soft">{analysis.notes}</p> : null}</div>
              {!analysis.completed_at && own && mutable ? <button type="button" disabled={busy === `complete-${analysis.analysis_id}`} onClick={() => completeAnalysis(analysis.analysis_id)} className="rounded-sm border border-line px-3 py-2 text-xs font-semibold disabled:opacity-50">{busy === `complete-${analysis.analysis_id}` ? "Saving…" : "Mark complete"}</button> : null}
            </div>
            <div className="mt-3 border-t border-line pt-3"><p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Findings</p>
              {analysis.findings.length ? <ul className="mt-2 space-y-2">{analysis.findings.map((finding) => <li key={finding.finding_id} className="rounded-sm bg-paper p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">{finding.title}</p><span className="rounded-full bg-white px-2 py-1 text-xs capitalize text-ink-soft">{finding.severity}</span></div><p className="mt-1 text-sm leading-6 text-ink-soft">{finding.description}</p><p className="mt-1 text-xs text-ink-soft">Recorded {new Date(finding.created_at).toLocaleString()}</p></li>)}</ul> : <p className="mt-2 text-sm text-ink-soft">No findings recorded for this analysis.</p>}
              {mutable ? <form onSubmit={(e) => addFinding(e, analysis.analysis_id)} className="mt-3 grid gap-2 rounded-sm border border-line p-3">
                <p className="text-xs font-semibold">Add a finding</p>
                <input required maxLength={200} placeholder="Finding title" value={draft.title} onChange={(e) => setFindingDrafts((old) => ({ ...old, [analysis.analysis_id]: { ...draft, title: e.target.value } }))} className="rounded-sm border border-line bg-white px-3 py-2 text-sm" />
                <textarea required rows={3} maxLength={60000} placeholder="Explain what the analysis found" value={draft.description} onChange={(e) => setFindingDrafts((old) => ({ ...old, [analysis.analysis_id]: { ...draft, description: e.target.value } }))} className="rounded-sm border border-line bg-white px-3 py-2 text-sm" />
                <div className="flex flex-wrap items-center gap-3"><select value={draft.severity} onChange={(e) => setFindingDrafts((old) => ({ ...old, [analysis.analysis_id]: { ...draft, severity: e.target.value } }))} className="rounded-sm border border-line bg-white px-3 py-2 text-sm"><option value="info">Info</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select><button disabled={busy === `finding-${analysis.analysis_id}`} className="rounded-sm bg-night px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy === `finding-${analysis.analysis_id}` ? "Saving…" : "Record finding"}</button></div>
              </form> : null}
            </div>
          </article>;
        })}</div> : <p className="mt-2 text-sm text-ink-soft">No analysis has been started for this evidence.</p>}
      </section>

      {mutable && activeRelated.length ? <section className="rounded-sm border border-line bg-panel p-5"><h2 className="font-semibold">Record a relationship</h2><p className="mt-1 text-sm text-ink-soft">Similarity is never converted into a relationship automatically. Choose another item and explain the basis for the link.</p>
        <form onSubmit={linkEvidence} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-ink-soft">Related evidence<select required value={relationshipTarget} onChange={(e) => setRelationshipTarget(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink"><option value="">Choose evidence…</option>{activeRelated.map((item) => <option key={item.evidence_id} value={item.evidence_id}>{item.evidence_no} · {item.title}</option>)}</select></label>
          <label className="text-xs font-medium text-ink-soft">Relationship type<select value={relationshipType} onChange={(e) => setRelationshipType(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink"><option value="related_activity">Related activity</option><option value="derived_from">Derived from</option><option value="corroborates">Corroborates</option><option value="contradicts">Contradicts</option><option value="other">Other</option></select></label>
          <label className="text-xs font-medium text-ink-soft sm:col-span-2">Written rationale<textarea required rows={3} maxLength={60000} value={relationshipRationale} onChange={(e) => setRelationshipRationale(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink" /></label>
          <div className="sm:col-span-2"><button disabled={busy === "relationship" || !relationshipTarget} className="rounded-sm bg-night px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy === "relationship" ? "Recording…" : "Record relationship"}</button></div>
        </form>
      </section> : null}

      <section className="rounded-sm border border-line bg-panel p-5"><h2 className="font-semibold">Recorded evidence relationships</h2>
        {relationships.length ? <div className="mt-3 space-y-3">{relationships.map((r) => <article key={r.rel_id} className="rounded-sm bg-paper p-3"><p className="text-sm font-semibold">{r.evidence_a_no} · {r.evidence_a_title} <span className="font-normal text-ink-soft">↔</span> {r.evidence_b_no} · {r.evidence_b_title}</p><p className="mt-1 text-xs capitalize text-ink-soft">{r.rel_type.replaceAll("_", " ")} · Recorded by {r.recorder_name} · {new Date(r.recorded_at).toLocaleString()}</p><p className="mt-2 text-sm leading-6">{r.rationale}</p></article>)}</div> : <p className="mt-2 text-sm text-ink-soft">No human-recorded relationships are linked to this evidence item.</p>}
      </section>

      <StatusMessage value={message} error={error} />
      {!mutable ? <p className="text-xs text-ink-soft">This evidence is withdrawn or its case is closed. Editing, transfer and new analysis workflows are disabled.</p> : null}
    </div>
  );
}
