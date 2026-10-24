# Porkex — Backend

REST API for Porkex, a personal finance tracker with transactions, categories, budgets, recurring payments and analytics. Built with Express, TypeScript and Prisma, using local SQLite or hosted Turso.

The interface is maintained in [porkex-web-app](https://github.com/adrixryz/porkex-web-app).

## Run locally

Use Node 24+. Copy [.env.example](.env.example) to `.env`, keep the local database URL and replace `JWT_SECRET` with a long random secret.

```bash
npm ci
npm run db:apply
npm run dev
```

The API runs on [localhost:3000](http://localhost:3000); [GET /health](http://localhost:3000/health) checks its database connection. Sign Up is enabled by default.

## Fresh demo data

For a disposable database, recreate the schema and seed a demo account with 24 months of sample data. **This deletes all Porkex accounts and data in the configured database.** No separate `db:apply` step is needed.

```bash
npm run db:seed -- --fresh
```

Default demo login: `seed@porkex.test` / `porkex123`. Override these with `SEED_EMAIL` and `SEED_PASSWORD`.

## Production build

```bash
npm run build
npm start
```

Configure the database and allowed frontend origins using the variables documented in `.env.example`. Before updating an existing installation, create and verify a backup, then run `npm run db:apply`. Startup validates schema compatibility and refuses pending or incompatible migrations without changing the database.
