# TRACE-X local setup and runbook

This guide targets macOS/Linux first. The SQL commands use a local MySQL CLI; the same commands work in a shell on Windows when MySQL is on PATH (PowerShell users can also use the equivalent invocation from the evaluation guide).

## 1. Prerequisites

- Node.js 22 or newer and npm
- MySQL 8.0.16 or newer
- Docker Desktop or Docker Engine
- Python 3 (only needed if regenerating the fictional seed data)
- Git

## 2. Clone and configure

From your preferred project directory:

```bash
git clone https://github.com/Urav20/DBMS-miniproject.git
cd DBMS-miniproject
cp .env.example app/.env.local
```

Edit `app/.env.local`. Replace all three MySQL password placeholders and set a long random session secret, for example:

```bash
openssl rand -hex 32
```

Keep `.env.local` local and private. Never commit it. The database account passwords in `app/.env.local` must match the passwords configured for the three accounts created in `database/02_access.sql`. If the accounts already exist with changed passwords, use those existing values rather than blindly re-running account-creation SQL.

## 3. Initialize the MySQL database (fresh disposable database only)

**Warning:** `database/01_schema.sql` starts with `DROP DATABASE IF EXISTS tracex`. It destroys the existing `tracex` database. Do not run it where you need to preserve data.

For a fresh local database, from the repository root:

```bash
mysql -u root -p < database/01_schema.sql
mysql -u root -p < database/02_access.sql
mysql -u root -p < database/03_routines.sql
mysql -u root -p < data/out/seed_demo.sql
```

The committed fictional seed creates demo users, cases and evidence. If you intentionally change the JSON templates, regenerate it with:

```bash
python3 data/generator/generate.py
python3 data/generator/test_seed_sqlite.py
```

Then load the regenerated `data/out/seed_demo.sql` into the fresh schema.

Run the read-only post-install checks:

```sql
source database/08_verify_database.sql
source database/07_demo.sql
```

For the broader query demonstration, run `source database/05_queries.sql`. For state-changing DML and rejected-operation examples, run `source database/04_dml.sql` separately; it intentionally changes demonstration data.

The expected demo row counts are documented in [data/README.md](../data/README.md). The verification SQL reports any mismatch; retain actual terminal output rather than claiming a check passed based only on the file existing.

## 4. Start Qdrant

```bash
docker run -d \
  --name tracex-qdrant \
  -p 6333:6333 \
  -v tracex_qdrant_storage:/qdrant/storage \
  --restart unless-stopped \
  qdrant/qdrant
```

If a container named `tracex-qdrant` already exists, do not create another one; check it with `docker ps`.

## 5. Install and check the app/vector collection

```bash
cd app
npm ci
npm run vector:setup
npm run vector:health
```

The first real embedding request downloads the ONNX model used by Transformers.js; allow internet access for that first load.

## 6. Run the worker and web app

Keep two terminals open, both in the `app/` directory.

Terminal 1 — continuous indexing worker:

```bash
npm run worker
```

Terminal 2 — Next.js development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Sign in with one of the demo accounts in [data/README.md](../data/README.md). Keep the worker running while testing evidence edits, withdrawals and vector re-indexing.

## 7. Useful checks

From `app/`:

```bash
npm run test:db
npm run test:auth
npm run test:vector
npm run test:indexing
npm run test:retrieval
npm run build
```

The `*:live` test scripts require reachable MySQL and Qdrant services plus a loaded demo schema. They are distinct from the unit tests.

## 8. Safe database reset

Only reset a disposable local database. Re-running `database/01_schema.sql` drops and recreates `tracex`. Back up anything important before doing so.
