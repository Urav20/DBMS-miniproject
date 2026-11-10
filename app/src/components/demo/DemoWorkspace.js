"use client";

import { useMemo, useState } from "react";

// Deliberately local mock data. This preview does not call or modify the API,
// MySQL, Qdrant, or Person B's retrieval/indexing modules.
const cases = [
  { id: "TX-2026-001", title: "Unauthorized access to internal systems", status: "Under review", team: "Isha Kapoor, Tomas Brandt", evidence: 12, findings: 18 },
  { id: "TX-2026-002", title: "Misuse of customer information", status: "Open", team: "Lena Hoffmann, Arjun Desai", evidence: 12, findings: 14 },
  { id: "TX-2026-003", title: "Unapproved data transfer", status: "Open", team: "Isha Kapoor", evidence: 12, findings: 9 },
  { id: "TX-2026-004", title: "Policy and access-control violation", status: "Closed", team: "Tomas Brandt, Kofi Mensah", evidence: 12, findings: 11 },
  { id: "TX-2026-005", title: "Altered financial documents", status: "Under review", team: "Sofia Marquez, Kofi Mensah, Arjun Desai", evidence: 12, findings: 21 },
];

const evidence = [
  { id: "EV-005-01", title: "Supplier invoice — Northgate Components", type: "PDF document", status: "Active", version: 2, custodian: "Sofia Marquez", caseId: "TX-2026-005" },
  { id: "EV-005-02", title: "Payment reconciliation spreadsheet", type: "Spreadsheet", status: "Active", version: 1, custodian: "Arjun Desai", caseId: "TX-2026-005" },
  { id: "EV-005-03", title: "Finance mailbox export", type: "Email archive", status: "Active", version: 3, custodian: "Kofi Mensah", caseId: "TX-2026-005" },
  { id: "EV-005-04", title: "Bank statement — June 2026", type: "PDF document", status: "Withdrawn", version: 2, custodian: "Sofia Marquez", caseId: "TX-2026-005" },
  { id: "EV-001-07", title: "Authentication event export", type: "Log file", status: "Active", version: 1, custodian: "Isha Kapoor", caseId: "TX-2026-001" },
];

const custody = [
  { evidence: "EV-005-01", person: "Sofia Marquez", action: "Evidence registered", time: "10 Nov 2026 · 09:14", note: "Collected from finance office" },
  { evidence: "EV-005-01", person: "Arjun Desai", action: "Custody transferred", time: "10 Nov 2026 · 10:32", note: "Handed over for invoice reconciliation" },
  { evidence: "EV-005-02", person: "Arjun Desai", action: "Evidence registered", time: "09 Nov 2026 · 16:48", note: "Export received from case investigator" },
  { evidence: "EV-005-03", person: "Kofi Mensah", action: "Analysis completed", time: "09 Nov 2026 · 14:06", note: "Mailbox metadata and sender headers reviewed" },
];

const audit = [
  { action: "Evidence text updated", entity: "EV-005-01", actor: "Arjun Desai", time: "10 Nov 2026 · 10:35" },
  { action: "Custody transferred", entity: "EV-005-01", actor: "Sofia Marquez", time: "10 Nov 2026 · 10:32" },
  { action: "Finding recorded", entity: "FN-005-21", actor: "Kofi Mensah", time: "09 Nov 2026 · 14:06" },
  { action: "Evidence registered", entity: "EV-005-03", actor: "Kofi Mensah", time: "09 Nov 2026 · 11:20" },
];

const tabs = ["Cases", "Evidence", "Custody", "Audit"];

function Pill({ children, tone = "neutral" }) {
  const styles = {
    neutral: "bg-slate-100 text-slate-700",
    green: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-800",
    red: "bg-rose-50 text-rose-700",
    blue: "bg-sky-50 text-sky-700",
  };
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${styles[tone]}`}>{children}</span>;
}

function Table({ headers, children }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-left text-sm">
        <thead className="border-b border-line bg-paper text-xs uppercase tracking-wide text-ink-soft">
          <tr>{headers.map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

function Cell({ children, className = "" }) {
  return <td className={`px-4 py-4 align-top ${className}`}>{children}</td>;
}

export default function DemoWorkspace() {
  const [tab, setTab] = useState("Cases");
  const [query, setQuery] = useState("");
  const [caseFilter, setCaseFilter] = useState("All");
  const filteredCases = useMemo(() => cases.filter((item) => {
    const matchesText = `${item.id} ${item.title} ${item.team}`.toLowerCase().includes(query.toLowerCase());
    const matchesStatus = caseFilter === "All" || item.status === caseFilter;
    return matchesText && matchesStatus;
  }), [query, caseFilter]);
  const filteredEvidence = useMemo(() => evidence.filter((item) =>
    `${item.id} ${item.title} ${item.type} ${item.custodian}`.toLowerCase().includes(query.toLowerCase())
  ), [query]);

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">Person A · UI preview</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Investigation workspace</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-soft">A standalone interface prototype for case records, evidence, custody history and audit activity.</p>
        </div>
        <Pill tone="amber">Mock data · Not connected to databases</Pill>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Active cases", "3", "Across assigned investigations"],
          ["Evidence records", "60", "Including withdrawn records"],
          ["Analysis findings", "73", "Recorded in the demo dataset"],
          ["Custody events", "83", "Append-only provenance history"],
        ].map(([label, value, hint]) => (
          <div key={label} className="rounded-sm border border-line bg-panel p-5">
            <p className="text-sm text-ink-soft">{label}</p>
            <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
            <p className="mt-1 text-xs text-ink-soft">{hint}</p>
          </div>
        ))}
      </section>

      <section className="overflow-hidden rounded-sm border border-line bg-panel">
        <div className="flex flex-col gap-4 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Workspace sections">
            {tabs.map((item) => (
              <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => { setTab(item); setQuery(""); }}
                className={`rounded-sm px-3 py-2 text-sm font-medium transition-colors ${tab === item ? "bg-night text-white" : "text-ink-soft hover:bg-paper hover:text-ink"}`}>
                {item}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            {tab === "Cases" && (
              <select value={caseFilter} onChange={(event) => setCaseFilter(event.target.value)} className="rounded-sm border border-line bg-panel px-3 py-2 text-sm">
                <option>All</option><option>Open</option><option>Under review</option><option>Closed</option>
              </select>
            )}
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${tab.toLowerCase()}…`} aria-label={`Search ${tab}`} className="w-full rounded-sm border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-accent sm:w-64" />
          </div>
        </div>

        {tab === "Cases" && (
          <Table headers={["Case", "Status", "Evidence", "Findings", "Assigned team"]}>
            {filteredCases.map((item) => <tr key={item.id} className="hover:bg-paper/70">
              <Cell><p className="font-semibold">{item.id}</p><p className="mt-1 text-ink-soft">{item.title}</p></Cell>
              <Cell><Pill tone={item.status === "Closed" ? "neutral" : item.status === "Open" ? "green" : "amber"}>{item.status}</Pill></Cell>
              <Cell className="tabular-nums">{item.evidence}</Cell><Cell className="tabular-nums">{item.findings}</Cell>
              <Cell className="max-w-xs text-ink-soft">{item.team}</Cell>
            </tr>)}
          </Table>
        )}

        {tab === "Evidence" && (
          <Table headers={["Evidence", "Type", "Status", "Content version", "Current custodian"]}>
            {filteredEvidence.map((item) => <tr key={item.id} className="hover:bg-paper/70">
              <Cell><p className="font-semibold">{item.id}</p><p className="mt-1 text-ink-soft">{item.title}</p><p className="mt-1 text-xs text-ink-soft">{item.caseId}</p></Cell>
              <Cell>{item.type}</Cell><Cell><Pill tone={item.status === "Active" ? "green" : "red"}>{item.status}</Pill></Cell>
              <Cell><span className="font-mono">v{item.version}</span></Cell><Cell>{item.custodian}</Cell>
            </tr>)}
          </Table>
        )}

        {tab === "Custody" && (
          <Table headers={["Evidence", "Event", "Person", "Timestamp", "Notes"]}>
            {custody.filter((item) => `${item.evidence} ${item.person} ${item.action}`.toLowerCase().includes(query.toLowerCase())).map((item, index) => <tr key={index}>
              <Cell className="font-semibold">{item.evidence}</Cell><Cell><Pill tone="blue">{item.action}</Pill></Cell>
              <Cell>{item.person}</Cell><Cell className="whitespace-nowrap text-ink-soft">{item.time}</Cell><Cell className="text-ink-soft">{item.note}</Cell>
            </tr>)}
          </Table>
        )}

        {tab === "Audit" && (
          <Table headers={["Action", "Record", "Performed by", "Timestamp"]}>
            {audit.filter((item) => `${item.action} ${item.entity} ${item.actor}`.toLowerCase().includes(query.toLowerCase())).map((item, index) => <tr key={index}>
              <Cell className="font-medium">{item.action}</Cell><Cell className="font-mono">{item.entity}</Cell><Cell>{item.actor}</Cell><Cell className="whitespace-nowrap text-ink-soft">{item.time}</Cell>
            </tr>)}
          </Table>
        )}
        <div className="border-t border-line bg-paper/60 px-4 py-3 text-xs text-ink-soft">
          Preview only. All displayed records are illustrative and are not live database results.
        </div>
      </section>

      <aside className="rounded-sm border border-amber-200 bg-marker-wash p-4 text-sm leading-6 text-marker-ink">
        <strong>Provenance reminder:</strong> semantic similarity can suggest records worth investigating, but it is not proof that two evidence items are factually related. Verify every result against authoritative MySQL records and the custody history.
      </aside>
    </div>
  );
}
