"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CaseAdminControls({ item, users, assignments }) {
  const router = useRouter();
  const [status, setStatus] = useState(item.status);
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  async function send(url, method, body) {
    setBusy(true); setMessage(""); setError(false);
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "The change was rejected.");
      setMessage(payload.message || "Saved."); router.refresh();
    } catch (err) { setError(true); setMessage(err.message); }
    finally { setBusy(false); }
  }
  return (
    <details className="mt-4 rounded-sm border border-line bg-paper p-4">
      <summary className="cursor-pointer text-sm font-semibold">Administrator case controls</summary>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <form onSubmit={(e) => { e.preventDefault(); send(`/api/workspace/cases/${item.case_id}`, "PATCH", { status }); }} className="flex flex-col items-start gap-2">
          <label className="w-full text-xs font-medium text-ink-soft">Case status<select value={status} onChange={(e) => setStatus(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink"><option value="open">Open</option><option value="under_review">Under review</option><option value="closed">Closed</option></select></label>
          <button disabled={busy || status === item.status} className="rounded-sm border border-line bg-panel px-3 py-2 text-sm font-medium disabled:opacity-50">Update status</button>
        </form>
        <form onSubmit={(e) => { e.preventDefault(); send(`/api/workspace/cases/${item.case_id}/access`, "POST", { action: "grant", user_id: Number(userId) }); }} className="flex flex-col items-start gap-2">
          <label className="w-full text-xs font-medium text-ink-soft">Grant case access<select required value={userId} onChange={(e) => setUserId(e.target.value)} className="mt-1 block w-full rounded-sm border border-line bg-white px-3 py-2 text-sm text-ink"><option value="">Choose an active user…</option>{users.map((u) => <option key={u.user_id} value={u.user_id}>{u.full_name} ({u.username}) · {u.role_name}</option>)}</select></label>
          <button disabled={busy || !userId} className="rounded-sm border border-line bg-panel px-3 py-2 text-sm font-medium disabled:opacity-50">Grant access</button>
        </form>
      </div>
      <div className="mt-4 border-t border-line pt-3"><p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Current and historical assignments</p>
        {assignments.length ? <ul className="mt-2 divide-y divide-line">{assignments.map((a) => <li key={a.user_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><span>{a.full_name} ({a.username}) · {a.revoked_at ? "Revoked" : "Active"}</span>{!a.revoked_at ? <button type="button" disabled={busy} onClick={() => send(`/api/workspace/cases/${item.case_id}/access`, "POST", { action: "revoke", user_id: Number(a.user_id) })} className="rounded-sm border border-rose-200 px-2 py-1 text-xs font-medium text-rose-700 disabled:opacity-50">Revoke</button> : null}</li>)}</ul> : <p className="mt-2 text-sm text-ink-soft">No assignments recorded.</p>}
      </div>
      {message ? <p role="status" className={`mt-3 text-sm ${error ? "text-rose-700" : "text-emerald-700"}`}>{message}</p> : null}
    </details>
  );
}
