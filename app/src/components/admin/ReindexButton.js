"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ReindexButton() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const router = useRouter();
  async function run() {
    if (!window.confirm("Queue every missing or stale active vector and drain the indexing worker now?")) return;
    setBusy(true); setMessage(""); setIsError(false);
    try {
      const response = await fetch("/api/admin/vector/reindex", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || "Re-indexing failed.");
      const r = body.result;
      setMessage(`Worker finished: ${r.claimed} claimed, ${r.upserted} upserted, ${r.deleted} deleted, ${r.failed} failed.`);
      setIsError(r.failed > 0 || r.outage);
      router.refresh();
    } catch (error) { setMessage(error.message); setIsError(true); }
    finally { setBusy(false); }
  }
  return <div className="flex flex-col items-start gap-3"><button type="button" onClick={run} disabled={busy} className="rounded-sm bg-night px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Processing index queue…" : "Re-index missing or stale records"}</button>{message ? <p role="status" className={isError ? "text-sm text-rose-700" : "text-sm text-emerald-700"}>{message}</p> : null}</div>;
}
