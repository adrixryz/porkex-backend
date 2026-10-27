# Porkex — Backend

REST API v1.1.0 for Porkex, a personal finance tracker with accounts, savings goals, transactions, categories, weekly/monthly/yearly budgets, recurring payments and analytics. Built with Express, TypeScript and Prisma, using local SQLite or hosted Turso. Supports account language preferences, transaction CSV imports/exports and atomic full account-data JSON backups/restores.

The interface is maintained in [porkex-web-app](https://github.com/adrixryz/porkex-web-app).

## Run locally

Use Node 26.12.1 (see `.node-version`), or a compatible patched Node 24.22.1+. Copy [.env.example](.env.example) to `.env`, keep the local database URL and replace `JWT_SECRET` with a long random secret.

```bash
npm ci
npm run db:apply
npm run dev
```

The API runs on [localhost:3000](http://localhost:3000); [GET /health](http://localhost:3000/health) checks its database connection. Sign Up is enabled by default.

## Fresh demo data

For a disposable database, recreate the schema and seed a demo account with 24 months of sample data. **This deletes all Porkex accounts and data in the configured database.** No separate `db:apply` step is needed.

```bash
npm run db:reset
```

Default demo login: `seed@porkex.test` / `porkex123`. Override these with `SEED_EMAIL` and `SEED_PASSWORD`. The demo includes active, archived and excluded accounts; empty, funded and completed goals; transfers and balance corrections; ordered categories and tags; income/expense favorites; all budget cycles across two accounts; and daily/weekly/monthly/yearly recurring rules with paused, skipped and edited occurrences.

## Production build

```bash
npm run build
npm start
```

Configure `DATABASE_URL`, `TURSO_AUTH_TOKEN` when using Turso, a private stable `JWT_SECRET` and the allowed frontend `CORS_ORIGINS` using `.env.example`. Install with `npm ci` before building. Initialize an empty database once with `npm run db:apply`, separately from startup, then run the matching frontend/backend revisions. `/health` must return `{"status":"ok","db":"up"}`. Never seed demo credentials or run `db:reset` as an automatic deployment step.

Existing v1.0.0 databases use the preserved `prisma/baselines/1.0.0.prisma` baseline and immutable incremental migrations. Stop the API and other writers before upgrading. The following command creates and independently verifies a new backup before applying pending migrations in a transaction; keep a separate secure copy of the backup.

```bash
npm run db:migrate -- --backup prisma/backups/before-upgrade.db
```

The backup path must not exist. Check the selected `DATABASE_URL` before running the command, especially for Turso. A schema mismatch, invalid migration history, failed integrity check or backup failure aborts the upgrade. `npm run db:apply` initializes an empty database or preserves an already current one; application startup never migrates or resets. `npm run db:reset` is destructive and is only for disposable development data.
