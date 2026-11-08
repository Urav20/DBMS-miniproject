# TRACE-X demo data (step 3)

Everything here is fictional. It gives the app 5 cases and 60 evidence items to work with.

## Layout
- `templates/common.json`: users (with bcrypt hashes), analysis tools, evidence types.
- `templates/case1..5_*.json`: one hand-written storyline per case.
- `generator/generate.py`: reads the templates, checks every constraint in Python, writes `out/seed_demo.sql`.
- `generator/test_seed_sqlite.py`: optional smoke test in SQLite (no MySQL needed).
- `out/seed_demo.sql`: the file you load. Deterministic (fixed seed); commit it.

## Load it (MySQL command line, from the repo folder)
```
mysql -u root -p -h 127.0.0.1 -P 3306
source database/01_schema.sql
source database/02_access.sql
source database/03_routines.sql
source data/out/seed_demo.sql
```
Re-running 01 first wipes the database, so this is also the reset procedure.

## Demo logins (all users share one password: `TraceX#Demo1`)
Admins: dana.whitfield, ravi.menon. Investigators: isha.kapoor, tomas.brandt, lena.hoffmann, arjun.desai, sofia.marquez, kofi.mensah.

## Expected row counts
app_user 8, investigation_case 5, case_assignment 13, evidence_source 14, evidence_type 10, analysis_tool 6,
evidence 60 (3 withdrawn), collection_event 60, custody_event 83, analysis 50, finding 73,
evidence_relationship 33, audit_log 368. `index_job` gets one pending upsert per active evidence (57) and per finding (73) when the seed is loaded after `03_routines.sql`.

## Regenerate after editing a template
```
python3 data/generator/generate.py
python3 data/generator/test_seed_sqlite.py
```
The generator stops with a DATA ERROR message if a rule is broken (for example someone acting before access was granted).

## Story notes
Case 1 contains a deliberate loop in the evidence links (for the recursive query cycle protection demo).
Case 4 is closed and has one revoked team member. Cases 2, 3 and 5 each have a withdrawn item.
