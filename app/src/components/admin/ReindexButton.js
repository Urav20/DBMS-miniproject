"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ReindexButton() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const router = useRouter();
  async function run() {
    if (!window.confirm("Queue all active evidence and findings whose vectors are missing or stale? The single background worker will process them.")) return;
    setBusy(true); setMessage(""); setIsError(false);
    try {
      const response = await fetch("/api/admin/vector/reindex", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || "The index jobs could not be queued.");
      const r = body.result;
      setMessage(`Queued ${r.evidenceQueued} evidence record(s) and ${r.findingsQueued} finding(s). The background worker will process them.`);
      router.refresh();
    } catch (error) { setMessage(error.message); setIsError(true); }
    finally { setBusy(false); }
  }
  return <div className="flex flex-col items-start gap-3"><button type="button" onClick={run} disabled={busy} className="rounded-sm bg-night px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Queueing index jobs…" : "Queue missing or stale records"}</button>{message ? <p role="status" className={isError ? "text-sm text-rose-700" : "text-sm text-emerald-700"}>{message}</p> : null}</div>;
}
