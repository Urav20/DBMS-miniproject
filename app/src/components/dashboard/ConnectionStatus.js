"use client";

import { useEffect, useState } from "react";

const initial = { loading: true, mysql: "checking", qdrant: "checking", collection: "checking", embedding: "lazy" };

export default function ConnectionStatus() {
  const [state, setState] = useState(initial);
  useEffect(() => {
    let active = true;
    fetch("/api/system/health", { cache: "no-store" }).then(async (response) => {
      const body = await response.json();
      if (!active) return;
      setState({ loading: false, mysql: body.mysql?.status || "error", qdrant: body.qdrant?.status || "error", collection: body.collection?.status || "error", embedding: body.embedding?.status || "lazy", message: body.collection?.message || body.qdrant?.message || "" });
    }).catch(() => { if (active) setState({ loading: false, mysql: "error", qdrant: "error", collection: "error", embedding: "lazy", message: "Health endpoint could not be reached." }); });
    return () => { active = false; };
  }, []);
  const rows = [
    ["MySQL", "Role-specific database connection", state.mysql],
    ["Qdrant", "Vector database reachability", state.qdrant],
    ["Vector collection", "Collection schema and payload indexes", state.collection],
    ["Embedding model", "BGE-small · loaded on first search or indexing request", state.embedding],
  ];
  const label = (s) => state.loading ? "Checking…" : s === "ok" ? "Connected" : s === "lazy" ? "Lazy load" : "Unavailable";
  const good = (s) => s === "ok" || s === "lazy";
  return (
    <section className="rounded-sm border border-line bg-panel">
      <h2 className="border-b border-line px-5 py-4 text-base font-semibold">Live system connections</h2>
      <ul className="divide-y divide-line">{rows.map(([name, detail, status]) => <li key={name} className="flex items-start justify-between gap-4 px-5 py-4"><div><p className="text-sm font-medium">{name}</p><p className="mt-0.5 text-sm text-ink-soft">{detail}</p></div><p className={`flex shrink-0 items-center gap-2 text-sm ${good(status) ? "text-emerald-700" : "text-rose-700"}`}><span aria-hidden="true" className={`size-2 rounded-full ${good(status) ? "bg-emerald-500" : "bg-rose-500"}`} />{label(status)}</p></li>)}</ul>
      {!state.loading && state.message ? <p className="px-5 py-3 text-xs text-ink-soft">{state.message}</p> : null}
    </section>
  );
}
