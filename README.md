# Porkex — Backend

REST API v1.0.0 for Porkex, a personal finance tracker with accounts, savings goals, transactions, categories, weekly/monthly/yearly budgets, recurring payments and analytics. Built with Express, TypeScript and Prisma, using local SQLite or hosted Turso. Supports transaction CSV imports/exports and atomic full account-data JSON backups/restores.

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

The current `prisma/schema.prisma` is the definitive v1.0.0 baseline; retain this release revision for future migrations. Version 1.0.0 starts with this model and no migration history because the previous development data is disposable. `npm run db:apply` only initializes an empty database or preserves one that is already current; startup never resets or updates the schema. `npm run db:reset` remains an explicit destructive tool for disposable development data. After the first deployment, preserve real data: future schema updates require incremental migrations and a verified backup, not a reset.
