#!/usr/bin/env python3
"""
TRACE-X: Chen-notation ER diagram generator (Graphviz).

Usage:  python3 chen_er.py [output_dir]
Needs:  Graphviz (`dot`) on PATH.
Output: <name>.dot, <name>.svg, <name>.png for each diagram.

Edit the ENTITIES / RELATIONSHIPS tables below, re-run, and all diagrams update.

Chen notation used
  rectangle            entity            double rectangle   weak entity
  diamond              relationship      double diamond     identifying relationship
  ellipse              attribute         underlined         primary key
  italic + underlined  partial key       dashed ellipse     derived attribute (not stored)
  double line          total participation, single line = partial participation
  1 / N / M            cardinality ratio
"""
import subprocess
import sys
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else ".")

# ----------------------------------------------------------------------------
# Entities
# ----------------------------------------------------------------------------
ENTITIES = {
    "ROLE": dict(key=["role_id"], attrs=["role_name"]),
    "USER": dict(key=["user_id"],
                 attrs=["username", "email", "full_name", "password_hash",
                        "is_active", "created_at"]),
    "CASE": dict(key=["case_id"],
                 attrs=["case_number", "title", "description", "status",
                        "opened_at", "closed_at"]),
    "EVIDENCE_SOURCE": dict(key=["source_id"],
                            attrs=["label", "source_kind", "serial_no", "description"]),
    "EVIDENCE_TYPE": dict(key=["type_id"], attrs=["name", "description"]),
    "EVIDENCE": dict(key=["evidence_id"],
                     attrs=["evidence_no", "title", "description", "extracted_text",
                            "sha256", "file_size_bytes", "status", "registered_at",
                            "content_version", "indexed_version", "indexed_at"],
                     derived=["current_custodian"]),
    "COLLECTION_EVENT": dict(key=["collection_id"],
                             attrs=["collected_at", "method", "location", "notes"]),
    "CUSTODY_EVENT": dict(weak=True, partial=["seq_no"],
                          attrs=["transferred_at", "reason"]),
    "ANALYSIS_TOOL": dict(key=["tool_id"], attrs=["name", "version", "description"]),
    "ANALYSIS": dict(key=["analysis_id"],
                     attrs=["started_at", "completed_at", "notes"]),
    "FINDING": dict(key=["finding_id"],
                    attrs=["title", "description", "severity", "created_at",
                           "content_version", "indexed_version", "indexed_at"]),
    "EVIDENCE_RELATIONSHIP": dict(key=["rel_id"],
                                  attrs=["rel_type", "rationale", "recorded_at"]),
    "AUDIT_LOG": dict(key=["audit_id"],
                      attrs=["action", "entity_type", "entity_id", "details",
                             "created_at"]),
    "INDEX_JOB": dict(key=["job_id"],
                      attrs=["operation", "content_version", "status", "attempts",
                             "last_error", "created_at", "processed_at"]),
}

# ----------------------------------------------------------------------------
# Relationships: (id, a, card_a, total_a, b, card_b, total_b, options)
#   card_x   = how many instances of x may take part per instance of the other side
#   total_x  = True -> every instance of x must participate (double line)
# ----------------------------------------------------------------------------
R = []


def rel(name, a, ca, ta, b, cb, tb, attrs=(), identifying=False):
    R.append(dict(name=name, a=a, ca=ca, ta=ta, b=b, cb=cb, tb=tb,
                  attrs=list(attrs), identifying=identifying))


rel("HAS_ROLE",        "ROLE", "1", False, "USER", "N", True)
rel("ASSIGNED_TO",     "USER", "M", False, "CASE", "N", False,
    attrs=["granted_at", "revoked_at"])
rel("OPENS",           "USER", "1", False, "CASE", "N", True)
rel("CONTAINS_SOURCE", "CASE", "1", False, "EVIDENCE_SOURCE", "N", True)
rel("BELONGS_TO",      "CASE", "1", False, "EVIDENCE", "N", True)
rel("ORIGINATES_FROM", "EVIDENCE_SOURCE", "1", False, "EVIDENCE", "N", False)
rel("CLASSIFIED_AS",   "EVIDENCE_TYPE", "1", False, "EVIDENCE", "N", True)
rel("REGISTERS",       "USER", "1", False, "EVIDENCE", "N", True)
rel("COLLECTED_VIA",   "EVIDENCE", "1", False, "COLLECTION_EVENT", "1", True)
rel("COLLECTS",        "USER", "1", False, "COLLECTION_EVENT", "N", True)
rel("HAS_CUSTODY",     "EVIDENCE", "1", True, "CUSTODY_EVENT", "N", True, identifying=True)
rel("TRANSFERS_FROM",  "USER", "1", False, "CUSTODY_EVENT", "N", False)
rel("TRANSFERS_TO",    "USER", "1", False, "CUSTODY_EVENT", "N", True)
rel("ANALYSED_IN",     "EVIDENCE", "1", False, "ANALYSIS", "N", True)
rel("USES",            "ANALYSIS_TOOL", "1", False, "ANALYSIS", "N", True)
rel("PERFORMS",        "USER", "1", False, "ANALYSIS", "N", True)
rel("PRODUCES",        "ANALYSIS", "1", False, "FINDING", "N", True)
rel("SOURCE_OF",       "EVIDENCE", "1", False, "EVIDENCE_RELATIONSHIP", "N", True)
rel("TARGET_OF",       "EVIDENCE", "1", False, "EVIDENCE_RELATIONSHIP", "N", True)
rel("RECORDS",         "USER", "1", False, "EVIDENCE_RELATIONSHIP", "N", True)
rel("ACTS_IN",         "USER", "1", False, "AUDIT_LOG", "N", False)
rel("LOGGED_FOR",      "CASE", "1", False, "AUDIT_LOG", "N", False)
rel("QUEUES_EVIDENCE", "EVIDENCE", "1", False, "INDEX_JOB", "N", False)
rel("QUEUES_FINDING",  "FINDING", "1", False, "INDEX_JOB", "N", False)

# ----------------------------------------------------------------------------
# Diagrams: name -> (title, entities shown, relationships shown, entities drawn with attributes)
# ----------------------------------------------------------------------------
DIAGRAMS = {
    "chen_0_overview": (
        "TRACE-X  |  Chen ER overview (entities and relationships only)",
        list(ENTITIES), [r["name"] for r in R], [], "neato"),
    "chen_1_access_cases": (
        "TRACE-X  |  Chen ER 1: users, roles, cases, audit",
        ["ROLE", "USER", "CASE", "EVIDENCE_SOURCE", "AUDIT_LOG"],
        ["HAS_ROLE", "ASSIGNED_TO", "OPENS", "CONTAINS_SOURCE", "ACTS_IN", "LOGGED_FOR"],
        ["ROLE", "USER", "CASE", "EVIDENCE_SOURCE", "AUDIT_LOG"], "neato"),
    "chen_2_evidence_provenance": (
        "TRACE-X  |  Chen ER 2: evidence, collection, chain of custody",
        ["CASE", "USER", "EVIDENCE_SOURCE", "EVIDENCE_TYPE", "EVIDENCE",
         "COLLECTION_EVENT", "CUSTODY_EVENT"],
        ["BELONGS_TO", "ORIGINATES_FROM", "CLASSIFIED_AS", "REGISTERS",
         "COLLECTED_VIA", "COLLECTS", "HAS_CUSTODY", "TRANSFERS_FROM",
         "TRANSFERS_TO"],
        ["EVIDENCE", "EVIDENCE_TYPE", "COLLECTION_EVENT", "CUSTODY_EVENT"], "neato"),
    "chen_3_analysis_indexing": (
        "TRACE-X  |  Chen ER 3: analysis, findings, relationships, indexing outbox",
        ["USER", "EVIDENCE", "ANALYSIS_TOOL", "ANALYSIS", "FINDING",
         "EVIDENCE_RELATIONSHIP", "INDEX_JOB"],
        ["ANALYSED_IN", "USES", "PERFORMS", "PRODUCES", "SOURCE_OF", "TARGET_OF",
         "RECORDS", "QUEUES_EVIDENCE", "QUEUES_FINDING"],
        ["ANALYSIS_TOOL", "ANALYSIS", "FINDING", "EVIDENCE_RELATIONSHIP", "INDEX_JOB"],
        "neato"),
}

FONT = "Helvetica"
ENT_FILL, REL_FILL, ATTR_FILL = "#DCE6F5", "#FFF1CC", "#FFFFFF"


def q(s):
    return '"' + s + '"'


def build(title, ents, rels, attr_ents, engine):
    L = []
    L.append("graph G {")
    if engine == "neato":
        L.append('  layout=neato; overlap=false; splines=true; sep="+14"; '
                 'mode=KK; maxiter=20000; K=1.1; epsilon=0.0001;')
    else:
        L.append("  layout=dot; rankdir=LR; nodesep=0.35; ranksep=0.9; splines=true;")
    L.append(f'  labelloc=t; fontsize=20; fontname="{FONT}-Bold"; label={q(title)};')
    L.append(f'  node [fontname={q(FONT)}, fontsize=11]; edge [fontname={q(FONT)}, '
             'fontsize=13, fontcolor="#B00020"];')
    L.append('  bgcolor="white"; pad=0.4;')

    for name in ents:
        e = ENTITIES[name]
        per = 3 if e.get("weak") else 1
        L.append(f'  {q("E_"+name)} [shape=box, style=filled, fillcolor={q(ENT_FILL)}, '
                 f'peripheries={per}, penwidth=1.6, fontsize=13, margin="0.22,0.12", '
                 f'label=<<B>{name}</B>>];')
        if name in attr_ents:
            for k in e.get("key", []):
                aid = q(f"A_{name}_{k}")
                L.append(f'  {aid} [shape=ellipse, style=filled, fillcolor={q(ATTR_FILL)}, '
                         f'label=<<U>{k}</U>>];')
                L.append(f'  {aid} -- {q("E_"+name)} [len=1.1];')
            for k in e.get("partial", []):
                aid = q(f"A_{name}_{k}")
                L.append(f'  {aid} [shape=ellipse, style=filled, fillcolor={q(ATTR_FILL)}, '
                         f'label=<<I><U>{k}</U></I>>];')
                L.append(f'  {aid} -- {q("E_"+name)} [len=1.1];')
            for k in e.get("attrs", []):
                aid = q(f"A_{name}_{k}")
                L.append(f'  {aid} [shape=ellipse, style=filled, fillcolor={q(ATTR_FILL)}, '
                         f'label={q(k)}];')
                L.append(f'  {aid} -- {q("E_"+name)} [len=1.1];')
            for k in e.get("derived", []):
                aid = q(f"A_{name}_{k}")
                L.append(f'  {aid} [shape=ellipse, style="dashed,filled", '
                         f'fillcolor={q(ATTR_FILL)}, label={q(k)}];')
                L.append(f'  {aid} -- {q("E_"+name)} [len=1.1];')

    for r in R:
        if r["name"] not in rels:
            continue
        rid = q("R_" + r["name"])
        per = 2 if r["identifying"] else 1
        L.append(f'  {rid} [shape=diamond, style=filled, fillcolor={q(REL_FILL)}, '
                 f'peripheries={per}, fontsize=10, margin="0.02,0.02", label={q(r["name"])}];')
        for side, card, tot in (("a", "ca", "ta"), ("b", "cb", "tb")):
            col = '"black:black"' if r[tot] else "black"
            L.append(f'  {q("E_"+r[side])} -- {rid} [label={q(r[card])}, color={col}, '
                     f'len=2.0, penwidth=1.0];')
        if any(n in attr_ents for n in (r["a"], r["b"])) or not attr_ents:
            pass
        for k in r["attrs"]:
            if not attr_ents:
                continue
            aid = q(f"A_{r['name']}_{k}")
            L.append(f'  {aid} [shape=ellipse, style=filled, fillcolor={q(ATTR_FILL)}, '
                     f'label={q(k)}];')
            L.append(f'  {aid} -- {rid} [len=1.1];')
    L.append("}")
    return "\n".join(L)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (title, ents, rels, attr_ents, engine) in DIAGRAMS.items():
        dot = build(title, ents, rels, attr_ents, engine)
        p = OUT / f"{name}.dot"
        p.write_text(dot)
        for fmt in ("svg", "png"):
            extra = ["-Gdpi=170"] if fmt == "png" else []
            subprocess.run(["dot", f"-T{fmt}", *extra, str(p), "-o",
                            str(OUT / f"{name}.{fmt}")], check=True)
        print("wrote", name)


if __name__ == "__main__":
    main()
