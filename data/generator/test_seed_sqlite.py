#!/usr/bin/env python3
"""Sanity test: load seed_demo.sql into SQLite using a converted copy of the
MySQL schema (tables only). Checks keys, FKs, CHECKs and row counts.
SQLite is stricter or looser than MySQL in places, so this is a smoke test,
not a replacement for loading into MySQL."""
import os, re, sqlite3, sys
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
schema = open(os.path.join(ROOT, "database", "01_schema.sql"), encoding="utf-8").read()
seed = open(os.path.join(ROOT, "data", "out", "seed_demo.sql"), encoding="utf-8").read()

tables = re.findall(r"CREATE TABLE .*?\) ENGINE=InnoDB;", schema, re.S)
ddl = []
for t in tables:
    t = re.sub(r"--[^\n]*", "", t)
    t = t.replace("`", "").replace(" ENGINE=InnoDB", "")
    t = re.sub(r"\b(?:TINYINT|INT|BIGINT)(?:\(\d+\))?\s+UNSIGNED", "INTEGER", t)
    t = re.sub(r"\bTINYINT\(1\)", "INTEGER", t)
    t = re.sub(r"ENUM\([^)]*\)", "TEXT", t)
    t = re.sub(r"\b(?:MEDIUMTEXT|LONGTEXT)\b", "TEXT", t)
    t = re.sub(r"\bCHAR\(\d+\)", "TEXT", t)
    t = re.sub(r"\bVARCHAR\(\d+\)", "TEXT", t)
    t = re.sub(r"\bDATETIME\b", "TEXT", t)
    t = re.sub(r"\bJSON\b", "TEXT", t)
    t = re.sub(r"AUTO_INCREMENT", "", t)
    t = re.sub(r"DEFAULT CURRENT_TIMESTAMP", "DEFAULT CURRENT_TIMESTAMP", t)
    t = re.sub(r"ON (DELETE|UPDATE) (RESTRICT|CASCADE|NO ACTION|SET NULL)", "", t)
    t = re.sub(r"CHECK \(email LIKE[^\n]*\)", "CHECK (email LIKE '%_@_%._%')", t)
    t = re.sub(r"REGEXP_LIKE\(sha256, '[^']*', 'c'\)", "length(sha256) = 64", t)
    t = re.sub(r"CREATE TABLE role\b", 'CREATE TABLE "role"', t)
    t = re.sub(r"REFERENCES role \(", 'REFERENCES "role" (', t)
    ddl.append(t)
db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
for t in ddl:
    db.execute(t)
body = re.sub(r"^(USE|SET NAMES|START TRANSACTION|COMMIT)[^\n]*;", "", seed, flags=re.M)
body = body.replace("\\n", "\n")   # MySQL-style \n escape -> real newline
db.executescript(body)
bad = db.execute("PRAGMA foreign_key_check").fetchall()
assert not bad, bad
exp = {"app_user": 8, "investigation_case": 5, "evidence": 60, "collection_event": 60,
       "custody_event": 83, "analysis": 50, "finding": 73, "evidence_relationship": 33}
for t, n in exp.items():
    got = db.execute("SELECT COUNT(*) FROM %s" % t).fetchone()[0]
    assert got == n, (t, got, n)
dup = db.execute("SELECT COUNT(*) FROM (SELECT case_id, sha256 FROM evidence WHERE sha256 IS NOT NULL GROUP BY 1,2 HAVING COUNT(*)>1)").fetchone()[0]
assert dup == 0
# negative checks: the constraints really bite
for sql in ["INSERT INTO custody_event VALUES (1,99,NULL,1,'2026-01-01 00:00:00','x')",
            "UPDATE investigation_case SET status='closed', closed_at=NULL WHERE case_id=1",
            "INSERT INTO evidence_relationship (evidence_a_id,evidence_b_id,rel_type,rationale,recorded_by) VALUES (1,1,'other','x',1)"]:
    try:
        db.execute(sql); print("NOT REJECTED:", sql); sys.exit(1)
    except sqlite3.IntegrityError:
        pass
print("SQLite smoke test passed: FKs clean, counts match, 3 bad inserts rejected.")
