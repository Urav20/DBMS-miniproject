# TRACE-X Data Plan

Status: plan for review. No data has been generated, and no public dataset has been downloaded or inspected yet.

## 1. Why we need a data plan

The data has to do four jobs, and each job shapes what we generate:

| Job | What the data must contain | Rubric item |
|---|---|---|
| Demo the app and the SQL | Realistic cases, custody chains, findings, relationships | 6, 7, 8, 10, 14 |
| Show role-based access in the database | Several users, a revoked assignment, cases a user must not see | 12 |
| Show vector read/update/delete | Records with similar meaning but different wording | 9 |
| Run the keyword vs vector vs hybrid comparison | Known right answers, traps, cross-case look-alikes, stale vectors | 14 |

## 2. Approach: synthetic structure, public-inspired text

No public dataset contains cases, custody chains, assignments or analyst findings, so the structure is **generated**. The text is written in the style of public forensic and security material but is **original wording**.

| Layer | Source | Method |
|---|---|---|
| Users, roles, cases, assignments, sources, custody, analyses, relationships | Synthetic | Python generator with a fixed random seed |
| Evidence descriptions, extracted text, findings | Hand-written templates and paraphrase groups, informed by public scenarios and attack-log styles (NIST CFReDS, Digital Corpora scenarios, OTRF Security-Datasets, Splunk attack_data, MITRE ATT&CK wording) | Short original sentences. We do not copy large passages. |
| Hashes, sizes | Generated | Random SHA-256 values. They are not hashes of real files or malware. |

Rules for the data:
- **Everything is fictional.** Invented names. IP addresses only from the reserved documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24). Domains only `example.com`, `example.org` or `.test`.
- **No real malware, no real people, no real case.** No email corpora (they contain real people's messages).
- **Check each source's license and cite it** before we reuse any wording closely. This is a to-do for whoever writes the text templates (section 9).
- The report will say plainly that the dataset is synthetic and results apply to it only.

### 2.1 Public sources we will adapt

We adapt real public material by hand (sanitize, shorten, re-map to our storylines) instead of inventing every sentence from nothing. Where each source fits:

| Source | What we take | Fits | License status |
|---|---|---|---|
| Splunk attack_data (GitHub) | Short excerpts of attack log lines (organized by MITRE ATT&CK technique ID) and the YAML descriptions | Cases 1, 3, 4 (suspicious program, phishing, ransomware-style) | Its README states Apache License 2.0 (checked). Keep the copyright notice and say we modified it. |
| MITRE ATT&CK | Technique names and short descriptions, to word findings | Finding titles and descriptions in all cases | Reuse is allowed for research with this notice kept: "(c) The MITRE Corporation. This work is reproduced and distributed with the permission of The MITRE Corporation." (checked on its terms page; not legal advice) |
| OTRF Security-Datasets (Mordor) | Similar attack logs | Backup source for cases 1, 3, 4 | **Not verified.** Read its license in the repo before use. |
| NIST CFReDS and Digital Corpora scenarios | Scenario descriptions and ideas for evidence types | Cases 2 and 5, and the evidence-type list | **Not verified.** Read the terms on each dataset page before use. |

What the public data does **not** give us, so we write it ourselves:
- The analyst-written description and finding text, and especially the **paraphrase groups**. These are what make the search comparison fair, and they are your original contribution.
- Cases 2 and 5 (employee copying files, altered documents). The public attack logs cover those poorly.

How we adapt a log excerpt:
1. Pick 3 to 8 log lines from a dataset that matches a storyline.
2. Replace every hostname, username, IP address and domain with fictional values (documentation IP ranges, `example.com`).
3. Keep it short. Raw logs are machine format, which embeds poorly, so each evidence record gets a plain-English analyst description plus the short adapted excerpt as `extracted_text`.
4. Record the source file and license in `data/SOURCES.md`.

## 3. Dataset sizes

| Set | Purpose | Evidence | Findings | Used for |
|---|---|---|---|---|
| **Demo** | The app, screenshots, viva | about 60 | about 120 | Hand-checked, readable |
| **Eval-S** | First comparison run | 500 | about 1,000 | Quick iterations |
| **Eval-M** | Main comparison | 2,000 | about 4,000 | Reported results |

All three come from the same generator with the same seed, so the larger sets are reproducible. We stop at Eval-M (2,000 evidence). Embedding and indexing time at that size will be measured, not assumed.

## 4. Demo set: row counts per table

| Table | Rows (demo) | How |
|---|---|---|
| role | 2 | Administrator, Investigator |
| app_user | 8 | 2 administrators, 6 investigators, all fictional names. Passwords set to documented demo values, stored hashed. |
| investigation_case | 5 | One storyline per case (section 5). One case is closed. |
| case_assignment | about 14 | Each investigator on 1 to 3 cases. **One revoked assignment** (to demonstrate access removal). **One investigator with no access to a particular case** (to demonstrate hiding). |
| evidence_source | about 12 | Laptop, phone, server, cloud account, USB drive, network capture, and so on |
| evidence_type | about 10 | Disk image, system log, email, memory dump, network capture, document, chat export, screenshot, registry export, other |
| evidence | about 60 | About 12 per case. A few withdrawn. |
| collection_event | about 60 | One per evidence (1:1). |
| custody_event | about 150 | Chains of 1 to 5 events. Every chain starts at `seq_no = 1` with no sender. Chains are valid. |
| analysis_tool | 6 | Names of well-known open-source tools with plausible versions |
| analysis | about 70 | |
| finding | about 120 | Mixed severity. |
| evidence_relationship | about 25 | Links form chains up to depth 4 for the recursive query, and **one deliberate cycle** to test cycle protection. All inside one case each. |
| audit_log | about 300 | Created by the procedures and triggers during seeding, not typed by hand. |
| index_job | created by triggers | One per evidence and finding, processed by the worker. |

Invalid cases (custody transfer from the wrong person, duplicate hash, cross-case link, bad `seq_no`) are **not** seeded. They live in a separate test script (`tests/`) so the demo data stays clean.

## 5. Five storylines for the demo cases

| Case | Storyline | Typical evidence |
|---|---|---|
| 1 | Suspicious program contacting an outside server | Process logs, network capture, memory dump |
| 2 | Employee copying company files before leaving | USB device log, file access log, cloud upload record |
| 3 | Phishing email leading to a stolen password | Email export, login log, browser history |
| 4 | Ransomware-style file encryption on a server | File change log, ransom note screenshot, system event log |
| 5 | Altered financial documents | Document metadata, version history, chat export |

Cases 1 and 3 deliberately share some vocabulary (for example "remote server", "credential"), so cross-case look-alikes exist even in the demo.

## 6. Evaluation design (ground truth)

### 6.1 Event groups

The generator builds **event groups**. Each group is one real-world event (for example "program connects to an outside server after a download") written as **6 to 12 differently worded records** spread across several cases. The group label is the ground truth. This is how "similar meaning, different wording" gets a known right answer.

| Category | Built how | Tests |
|---|---|---|
| Paraphrase | Same event, different words, no shared key terms | Vector should beat keyword |
| Keyword trap | Different events sharing key words (for example "backup copied" in a harmless nightly job vs. data theft) | Keyword and vector may both retrieve wrong items |
| Cross-case look-alike | Same event wording in a case the user cannot access or is not searching | Hybrid should remove it |
| Unauthorized | Records in cases where the user has no active assignment | Must never appear for that user |
| Stale vector | Records whose text was edited after indexing, deliberately left unindexed | Hybrid should detect and drop or flag |
| Missing vector | Records whose vector was deleted | Detected by the reconciliation check |

### 6.2 Queries and labels

- About 40 natural-language queries, each with a stated **searching user** and an optional case filter.
- For each query, a label per record in `ground_truth.csv`: **2** = same event group, visible to the user, in scope; **1** = same event group but outside the case filter; **0** = trap or unrelated; and a flag `visible_to_user`.
- A result counts as **contextually correct** only if the record is visible to the user and within the filter. Precision@k, Recall@k, MRR, latency and a leak count (unauthorized results returned) are computed against this file.

### 6.3 What we will not claim

We run these experiments only after the system works. The report will list measured numbers only, with dataset size and hardware, and will state that the data is synthetic.

## 7. Reproducibility

- A single Python script (using your venv) generates everything from a **fixed seed**: `data/generate.py`, with templates in `data/templates/` and outputs in `data/out/` (SQL inserts or CSV, plus `ground_truth.csv`).
- Same seed and same templates give the same data on both team members' machines.
- Generated outputs for the demo set are committed, so anyone can load it without running the generator. The larger sets are generated on demand and git-ignored.
- Dataset version is recorded in the README and in the report.

## 8. How this maps to the rubric

| Rubric item | Data support |
|---|---|
| 3, 6 (DDL, DML) | Seed data exercises every table and constraint; invalid cases tested separately |
| 7 (nested, correlated, recursive) | Relationship chains with depth and a cycle for the recursive CTE |
| 8 (procedures, triggers, CTE) | Seeding goes through the real procedures so audit rows and index jobs appear naturally |
| 9 (vector RUD) | Paraphrase groups make search results obviously meaningful in the demo |
| 12 (roles in the database) | Revoked assignment and hidden case for a user |
| 14 (originality, viva) | Ground-truth design and honest evaluation |

## 9. Work split and to-dos

| Task | Suggested owner | Notes |
|---|---|---|
| Draft storyline texts and paraphrase groups (about 12 groups for demo, about 40 for eval), adapting public logs as in 2.1 | Claude drafts; Person B reviews and edits; both read everything before the viva | Each person should be able to explain any text they are asked about |
| Generator script and loader | Person A | Starts after the tables exist |
| Ground-truth file and query list | Person B | |
| Check licenses and citations for the sources used | Whoever writes the text | Keep a `data/SOURCES.md` |

## 10. Decisions made

1. Demo set stays at 60 evidence items and 5 cases.
2. Evaluation stops at 2,000 evidence items (Eval-M). The 10,000 set is dropped.
3. Claude drafts the storyline texts, adapting public sources where they fit (2.1). Person B reviews and edits. Licenses are tracked in `data/SOURCES.md`.
