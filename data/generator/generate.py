#!/usr/bin/env python3
"""TRACE-X demo data generator (step 3).

Reads the hand-written storyline templates in data/templates/ and produces
data/out/seed_demo.sql.  The output is deterministic: the same templates and
the same SEED always give the same file.  Before writing, every business rule
and every constraint of database/01_schema.sql is checked in Python, so the
SQL file should load without a single constraint error.

Usage (from the repo root):
    python3 data/generator/generate.py

Only the Python standard library is used.  Passwords are NOT hashed here:
the bcrypt hashes are stored in data/templates/common.json.
"""
import glob
import hashlib
import json
import os
import random
import sys
from datetime import datetime, timedelta

SEED = 20260507
LATEST = datetime(2026, 11, 7, 23, 59, 59)   # nothing may happen after this

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
TEMPLATES = os.path.join(ROOT, "data", "templates")
OUT = os.path.join(ROOT, "data", "out", "seed_demo.sql")

FMT = "%Y-%m-%d %H:%M:%S"


def fmt(dt):
    return dt.strftime(FMT)


def parse(s):
    return datetime.strptime(s, FMT)


class DataError(Exception):
    pass


def check(cond, msg):
    if not cond:
        raise DataError(msg)


# --------------------------------------------------------------------------
# SQL helpers
# --------------------------------------------------------------------------
def q(v):
    """SQL literal for a Python value (MySQL string escaping)."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, datetime):
        return "'" + fmt(v) + "'"
    s = str(v).replace("\\", "\\\\").replace("'", "''")
    s = s.replace("\n", "\\n")
    return "'" + s + "'"


def insert(table, cols, rows):
    if not rows:
        return ""
    out = ["INSERT INTO %s (%s) VALUES" % (table, ", ".join(cols))]
    lines = ["  (" + ", ".join(q(v) for v in r) + ")" for r in rows]
    out.append(",\n".join(lines) + ";\n")
    return "\n".join(out)


# --------------------------------------------------------------------------
# Build the in-memory model
# --------------------------------------------------------------------------
def load():
    with open(os.path.join(TEMPLATES, "common.json"), encoding="utf-8") as f:
        common = json.load(f)
    cases = []
    for path in sorted(glob.glob(os.path.join(TEMPLATES, "case*.json"))):
        with open(path, encoding="utf-8") as f:
            cases.append(json.load(f))
    return common, cases


def build(common, cases):
    rng = random.Random(SEED)

    role_id = {r: i + 1 for i, r in enumerate(common["roles"])}
    users = {}
    user_rows = []
    for i, u in enumerate(common["users"], start=1):
        users[u["username"]] = i
        user_rows.append([i, role_id[u["role"]], u["username"], u["email"],
                          u["full_name"], u["password_hash"], 1,
                          datetime(2026, 4, 1, 9, 0, 0) + timedelta(minutes=5 * i)])
    type_id = {t["name"]: i + 1 for i, t in enumerate(common["evidence_types"])}
    tool_id = {t["key"]: i + 1 for i, t in enumerate(common["tools"])}

    m = dict(roles=[[i, r] for r, i in role_id.items()], users=user_rows,
             types=[[i + 1, t["name"], t["description"]] for i, t in enumerate(common["evidence_types"])],
             tools=[[i + 1, t["name"], t["version"], t["description"]] for i, t in enumerate(common["tools"])],
             cases=[], assignments=[], sources=[], evidence=[], collections=[],
             custody=[], analyses=[], findings=[], links=[], audit=[])
    audit = []   # (time, user_id, case_id, action, etype, eid, details)

    next_src = next_ev = next_an = next_fi = 0
    next_src = next_ev = next_an = next_fi = next_rel = 1

    for ci, c in enumerate(cases, start=1):
        opened = parse(c["opened"])
        closed = parse(c["closed"]) if c["closed"] else None
        creator = users[c["created_by"]]
        m["cases"].append([ci, c["case_number"], c["title"], c["description"],
                           c["status"], opened, closed, creator])
        audit.append((opened, creator, ci, "case.create", "investigation_case", ci,
                      {"case_number": c["case_number"]}))

        # --- team -------------------------------------------------------
        window = {}   # user_id -> (granted, revoked)
        for t in c["team"]:
            uid = users[t["user"]]
            granted = opened + timedelta(days=t["granted_day"], minutes=30)
            revoked = None
            if t["revoked_day"] is not None:
                revoked = opened + timedelta(days=t["revoked_day"], minutes=30)
            window[uid] = (granted, revoked)
            m["assignments"].append([ci, uid, granted, revoked])
            audit.append((granted, creator, ci, "access.grant", "case_assignment", uid,
                          {"user": t["user"]}))
            if revoked:
                audit.append((revoked, creator, ci, "access.revoke", "case_assignment", uid,
                              {"user": t["user"]}))

        def active(uid, when, what):
            check(uid in window, "%s: user %s is not on the team of %s" % (what, uid, c["case_number"]))
            g, r = window[uid]
            check(g <= when, "%s: %s acts before access was granted (%s < %s)" % (what, uid, when, g))
            check(r is None or when < r, "%s: %s acts after access was revoked" % (what, uid))

        def in_case_time(when, what):
            check(when >= opened, "%s before case opened" % what)
            check(closed is None or when <= closed, "%s after case closed" % what)
            check(when <= LATEST, "%s is in the future (%s)" % (what, when))

        # --- sources ----------------------------------------------------
        src_id = {}
        for s in c["sources"]:
            src_id[s["key"]] = next_src
            m["sources"].append([next_src, ci, s["label"], s["kind"], s["serial"], s["description"]])
            next_src += 1

        # --- evidence ---------------------------------------------------
        ev_id = {}
        reg_time = {}
        for n, e in enumerate(c["evidence"], start=1):
            key = "E%d" % n
            eid = next_ev
            next_ev += 1
            ev_id[key] = eid
            who = users[e["by"]]
            collected = (opened + timedelta(days=e["day"])).replace(
                hour=rng.randint(10, 17), minute=rng.randint(0, 59), second=rng.randint(0, 59))
            if who in window and collected < window[who][0]:
                collected = window[who][0] + timedelta(minutes=rng.randint(30, 120))
            registered = collected + timedelta(minutes=rng.randint(90, 240), seconds=rng.randint(0, 59))
            what = "%s %s" % (c["case_number"], key)
            active(who, collected, what + " collection")
            active(who, registered, what + " registration")
            in_case_time(collected, what + " collection")
            in_case_time(registered, what + " registration")
            reg_time[key] = registered

            sha = None
            if e["hash"]:
                sha = hashlib.sha256(("tracex-demo|%s|%s|%s" % (c["case_number"], key, e["title"])).encode()).hexdigest()
            status = "withdrawn" if e.get("withdrawn") else "active"
            m["evidence"].append([eid, "EV-%s-%02d" % (c["case_number"][-3:], n), ci,
                                  src_id[e["source"]] if e["source"] else None,
                                  type_id[e["type"]], e["title"], e["description"], e["text"],
                                  sha, e["size"], status, who, registered, 1, None, None])
            m["collections"].append([eid, eid, who, collected, e["method"], e["location"], e["notes"]])
            audit.append((registered, who, ci, "evidence.register", "evidence", eid,
                          {"evidence_no": "EV-%s-%02d" % (c["case_number"][-3:], n)}))

            # custody chain: seq 1 = intake by the collector
            holder = who
            when = registered
            m["custody"].append([eid, 1, None, who, registered, "Initial intake after collection"])
            audit.append((registered, who, ci, "custody.intake", "custody_event", eid, {"seq": 1}))
            seq = 1
            for to_user, reason in e["custody"]:
                to = users[to_user]
                seq += 1
                when = when + timedelta(days=rng.randint(1, 3), hours=rng.randint(0, 4),
                                        minutes=rng.randint(0, 59))
                active(holder, when, what + " custody sender")
                active(to, when, what + " custody receiver")
                in_case_time(when, what + " custody transfer")
                check(holder != to, what + ": custody transfer to the same person")
                m["custody"].append([eid, seq, holder, to, when, reason])
                audit.append((when, holder, ci, "custody.transfer", "custody_event", eid,
                              {"seq": seq, "to": to_user}))
                holder = to
            e["_last_custody"] = when
            e["_id"] = eid
            e["_reg"] = registered

            # analyses
            for a in e["analyses"]:
                analyst = users[a["by"]]
                check(status == "active", what + ": analysis on withdrawn evidence")
                start = max(registered + timedelta(days=rng.randint(1, 6), hours=rng.randint(0, 5)),
                            when + timedelta(hours=rng.randint(1, 4)))
                done = None
                if a["state"] == "done":
                    done = start + timedelta(hours=rng.randint(4, 48), minutes=rng.randint(0, 59))
                end = done if done else start + timedelta(hours=rng.randint(6, 20))
                active(analyst, start, what + " analysis start")
                in_case_time(start, what + " analysis start")
                if done:
                    active(analyst, done, what + " analysis completion")
                    in_case_time(done, what + " analysis completion")
                aid = next_an
                next_an += 1
                m["analyses"].append([aid, eid, tool_id[a["tool"]], analyst, start, done, a["notes"]])
                audit.append((start, analyst, ci, "analysis.record", "analysis", aid,
                              {"tool": a["tool"]}))
                if done:
                    audit.append((done, analyst, ci, "analysis.complete", "analysis", aid, {}))
                for ftitle, fdesc, sev in a["findings"]:
                    span = max(int((end - start).total_seconds()), 3600)
                    created = start + timedelta(seconds=rng.randint(1800, span))
                    created = min(created, end) if done else created
                    created = max(created, start)
                    in_case_time(created, what + " finding")
                    fid = next_fi
                    next_fi += 1
                    m["findings"].append([fid, aid, ftitle, fdesc, sev, created, 1, None, None])
                    audit.append((created, analyst, ci, "finding.add", "finding", fid,
                                  {"severity": sev}))

            # withdrawal
            w = e.get("withdrawn")
            if w:
                by = users[w["by"]]
                wt = registered + timedelta(days=w["day_after"], hours=rng.randint(1, 5),
                                            minutes=rng.randint(0, 59))
                active(by, wt, what + " withdrawal")
                in_case_time(wt, what + " withdrawal")
                audit.append((wt, by, ci, "evidence.withdraw", "evidence", eid,
                              {"reason": w["reason"]}))

        # --- links ------------------------------------------------------
        for a_key, b_key, rtype, why, by_name, day in c["links"]:
            check(a_key in ev_id and b_key in ev_id, "%s: unknown evidence key in link %s-%s" % (c["case_number"], a_key, b_key))
            check(a_key != b_key, "link to itself")
            by = users[by_name]
            when = (opened + timedelta(days=day)).replace(hour=rng.randint(10, 17), minute=rng.randint(0, 59),
                                                         second=rng.randint(0, 59))
            floor = max(reg_time[a_key], reg_time[b_key]) + timedelta(hours=rng.randint(1, 3))
            when = max(when, floor)
            active(by, when, "%s link %s-%s" % (c["case_number"], a_key, b_key))
            in_case_time(when, "link")
            m["links"].append([next_rel, ev_id[a_key], ev_id[b_key], rtype, why, by, when])
            audit.append((when, by, ci, "evidence.link", "evidence_relationship", next_rel,
                          {"type": rtype}))
            next_rel += 1

    audit.sort(key=lambda r: (r[0], r[3], r[5] or 0))
    for i, (t, uid, cid, act, et, eid, det) in enumerate(audit, start=1):
        m["audit"].append([i, uid, cid, act, et, eid, json.dumps(det, sort_keys=True), t])
    return m


# --------------------------------------------------------------------------
# Validation: every constraint of 01_schema.sql, checked in Python
# --------------------------------------------------------------------------
def validate(m):
    import re

    def unique(rows, idx, name):
        seen = set()
        for r in rows:
            k = tuple(r[i] for i in idx)
            if None in k:
                continue          # NULLs never collide in a UNIQUE index
            check(k not in seen, "duplicate %s: %s" % (name, k))
            seen.add(k)

    ids = lambda rows, i=0: {r[i] for r in rows}
    unique(m["roles"], [0], "role pk"); unique(m["roles"], [1], "role name")
    unique(m["users"], [0], "user pk"); unique(m["users"], [2], "username"); unique(m["users"], [3], "email")
    for u in m["users"]:
        check(re.match(r"^.+@.+\..+$", u[3]), "email format " + u[3])
        check(re.match(r"^\$2[aby]\$\d\d\$.{53}$", u[5]), "password hash shape for " + u[2])
        check(u[1] in ids(m["roles"]), "user role fk")
    unique(m["cases"], [0], "case pk"); unique(m["cases"], [1], "case number")
    for c in m["cases"]:
        check(c[4] in ("open", "under_review", "closed"), "case status")
        check(c[7] in ids(m["users"]), "case creator fk")
        check(c[6] is None or c[6] >= c[5], "closed before opened")
        check((c[4] == "closed") == (c[6] is not None), "closed_at must match status for " + c[1])
    unique(m["assignments"], [0, 1], "assignment pk")
    for a in m["assignments"]:
        check(a[0] in ids(m["cases"]) and a[1] in ids(m["users"]), "assignment fk")
        check(a[3] is None or a[3] >= a[2], "revoked before granted")
    unique(m["sources"], [0], "source pk"); unique(m["sources"], [1, 2], "source label per case")
    kinds = {"computer", "mobile", "server", "storage_media", "cloud_account", "network_capture", "other"}
    src_case = {s[0]: s[1] for s in m["sources"]}
    for s in m["sources"]:
        check(s[3] in kinds, "source_kind " + str(s[3]))
        check(len(s[2]) <= 120, "source label length")
    unique(m["types"], [0], "type pk"); unique(m["types"], [1], "type name")
    unique(m["tools"], [0], "tool pk"); unique(m["tools"], [1, 2], "tool name+version")
    unique(m["evidence"], [0], "evidence pk"); unique(m["evidence"], [1], "evidence_no")
    unique(m["evidence"], [2, 8], "sha256 per case")
    for e in m["evidence"]:
        check(len(e[1]) <= 30 and len(e[5]) <= 200, "evidence length")
        check(e[2] in ids(m["cases"]) and e[4] in ids(m["types"]) and e[11] in ids(m["users"]), "evidence fk")
        check(e[3] is None or src_case[e[3]] == e[2], "source must belong to same case: " + e[1])
        check(e[8] is None or re.match(r"^[0-9a-f]{64}$", e[8]), "sha256 format")
        check(e[10] in ("active", "withdrawn"), "evidence status")
        check(e[14] is None or e[14] <= e[13], "indexed_version")
    ev_case = {e[0]: e[2] for e in m["evidence"]}
    unique(m["collections"], [0], "collection pk"); unique(m["collections"], [1], "one collection per evidence")
    check(ids(m["collections"], 1) == ids(m["evidence"]), "every evidence needs exactly one collection event")
    for r in m["collections"]:
        check(len(r[4]) <= 100 and (r[5] is None or len(r[5]) <= 150), "collection length")
        check(r[2] in ids(m["users"]), "collected_by fk")
    unique(m["custody"], [0, 1], "custody pk")
    by_ev = {}
    for r in sorted(m["custody"], key=lambda r: (r[0], r[1])):
        by_ev.setdefault(r[0], []).append(r)
    check(set(by_ev) == ids(m["evidence"]), "every evidence needs a custody chain")
    for eid, chain in by_ev.items():
        prev = None
        for i, r in enumerate(chain, start=1):
            check(r[1] == i, "custody seq gap for evidence %s" % eid)
            if i == 1:
                check(r[2] is None, "first custody event must have no sender")
            else:
                check(r[2] is not None and r[2] == prev[3], "custody chain broken at evidence %s seq %s" % (eid, i))
                check(r[2] != r[3], "self transfer")
                check(r[4] >= prev[4], "custody goes back in time")
            check(r[3] in ids(m["users"]) and (r[2] is None or r[2] in ids(m["users"])), "custody fk")
            check(r[5] is None or len(r[5]) <= 255, "custody reason length")
            prev = r
    unique(m["analyses"], [0], "analysis pk")
    for a in m["analyses"]:
        check(a[1] in ids(m["evidence"]) and a[2] in ids(m["tools"]) and a[3] in ids(m["users"]), "analysis fk")
        check(a[5] is None or a[5] >= a[4], "analysis completed before started")
    unique(m["findings"], [0], "finding pk")
    for f in m["findings"]:
        check(f[1] in ids(m["analyses"]), "finding fk")
        check(f[4] in ("info", "low", "medium", "high", "critical"), "severity")
        check(len(f[2]) <= 200, "finding title length")
        check(f[7] is None or f[7] <= f[6], "finding indexed_version")
    unique(m["links"], [0], "relationship pk"); unique(m["links"], [1, 2, 3], "relationship pair+type")
    for r in m["links"]:
        check(r[1] != r[2], "relationship to itself")
        check(r[1] in ev_case and r[2] in ev_case and ev_case[r[1]] == ev_case[r[2]], "relationship must stay inside one case")
        check(r[3] in ("derived_from", "corroborates", "contradicts", "related_activity", "other"), "rel_type")
        check(r[5] in ids(m["users"]), "recorded_by fk")
    unique(m["audit"], [0], "audit pk")
    for a in m["audit"]:
        check(a[1] is None or a[1] in ids(m["users"]), "audit user fk")
        check(a[2] is None or a[2] in ids(m["cases"]), "audit case fk")
        json.loads(a[6])
    # data hygiene for the SQLite test and for portability
    for name in ("cases", "sources", "evidence", "collections", "custody", "analyses", "findings", "links"):
        for row in m[name]:
            for v in row:
                if isinstance(v, str):
                    check("\\" not in v, "backslash in data (%s): %r" % (name, v[:60]))
                    v.encode("ascii") if name != "users" else None


# --------------------------------------------------------------------------
# SQL output
# --------------------------------------------------------------------------
HEADER = """-- =====================================================================
-- TRACE-X demo data (generated by data/generator/generate.py, seed %d)
-- 8 users, 5 cases, %d evidence items, all fictional.
-- Load AFTER database/01_schema.sql and database/02_access.sql.
-- Demo password for every user: see data/README.md
-- Do not edit by hand: change the templates and re-run the generator.
-- =====================================================================
USE tracex;
SET NAMES utf8mb4;
START TRANSACTION;

"""


def render(m):
    p = [HEADER % (SEED, len(m["evidence"]))]
    p.append("-- roles\n" + insert("`role`", ["role_id", "role_name"], m["roles"]))
    p.append("-- users\n" + insert("app_user", ["user_id", "role_id", "username", "email", "full_name",
                                               "password_hash", "is_active", "created_at"], m["users"]))
    p.append("-- evidence types\n" + insert("evidence_type", ["type_id", "name", "description"], m["types"]))
    p.append("-- analysis tools\n" + insert("analysis_tool", ["tool_id", "name", "version", "description"], m["tools"]))
    p.append("-- cases\n" + insert("investigation_case", ["case_id", "case_number", "title", "description",
                                                         "status", "opened_at", "closed_at", "created_by"], m["cases"]))
    p.append("-- case team\n" + insert("case_assignment", ["case_id", "user_id", "granted_at", "revoked_at"], m["assignments"]))
    p.append("-- evidence sources\n" + insert("evidence_source", ["source_id", "case_id", "label", "source_kind",
                                                                 "serial_no", "description"], m["sources"]))
    p.append("-- evidence\n" + insert("evidence", ["evidence_id", "evidence_no", "case_id", "source_id", "type_id",
                                                  "title", "description", "extracted_text", "sha256",
                                                  "file_size_bytes", "status", "registered_by", "registered_at",
                                                  "content_version", "indexed_version", "indexed_at"], m["evidence"]))
    p.append("-- collection events\n" + insert("collection_event", ["collection_id", "evidence_id", "collected_by",
                                                                   "collected_at", "method", "location", "notes"], m["collections"]))
    p.append("-- chain of custody\n" + insert("custody_event", ["evidence_id", "seq_no", "from_user_id", "to_user_id",
                                                               "transferred_at", "reason"], m["custody"]))
    p.append("-- analyses\n" + insert("analysis", ["analysis_id", "evidence_id", "tool_id", "analyst_id",
                                                  "started_at", "completed_at", "notes"], m["analyses"]))
    p.append("-- findings\n" + insert("finding", ["finding_id", "analysis_id", "title", "description", "severity",
                                                 "created_at", "content_version", "indexed_version", "indexed_at"], m["findings"]))
    p.append("-- evidence links\n" + insert("evidence_relationship", ["rel_id", "evidence_a_id", "evidence_b_id",
                                                                     "rel_type", "rationale", "recorded_by",
                                                                     "recorded_at"], m["links"]))
    p.append("-- audit log\n" + insert("audit_log", ["audit_id", "user_id", "case_id", "action", "entity_type",
                                                    "entity_id", "details", "created_at"], m["audit"]))
    p.append("COMMIT;\n")
    return "\n".join(p)


def main():
    common, cases = load()
    m = build(common, cases)
    validate(m)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(render(m))
    print("Wrote", os.path.relpath(OUT, ROOT))
    for k in ("users", "cases", "assignments", "sources", "types", "tools", "evidence", "collections",
              "custody", "analyses", "findings", "links", "audit"):
        print("  %-12s %d" % (k, len(m[k])))
    print("  withdrawn    %d" % sum(1 for e in m["evidence"] if e[10] == "withdrawn"))


if __name__ == "__main__":
    try:
        main()
    except DataError as err:
        print("DATA ERROR:", err, file=sys.stderr)
        sys.exit(1)
