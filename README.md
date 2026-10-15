# Porkex — backend

REST API for Porkex, a personal finance tracker: Express + TypeScript, Prisma ORM and SQLite.

The frontend lives in `../porkex-frontend` and talks to this server through the
`/auth` and `/api` endpoints.

## Requirements

- Node 20+
- A `.env` file (see below)

## Getting started

```bash
cp .env.example .env      # then set JWT_SECRET
npm install               # postinstall runs `prisma generate`
npm run db:push           # creates prisma/dev.db from the schema
npm run dev               # http://localhost:3000
```

`JWT_SECRET` has no default value. The process refuses to start without it,
because a fallback would silently sign every token with a key that is published
in the source. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

This API runs against a hosted [Turso](https://turso.tech) database (libSQL) in
production and a local SQLite file in development, with no code change: put the
`libsql://` URL and the auth token in `DATABASE_URL` and `TURSO_AUTH_TOKEN`. The
Turso database for this project is **`porkex-db`**; the name only ever appears
inside the URL, never in the code or the schema.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with nodemon + ts-node |
| `npm run build` | Compiles TypeScript to `dist/` |
| `npm start` | Builds, then runs `dist/index.js` |
| `npm test` | Integration tests (`tests/run.mjs`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run db:push` | Applies `schema.prisma` with the Prisma CLI. **Local files only** |
| `npm run db:apply` | Applies the schema to whatever `DATABASE_URL` points at, including Turso |
| `npm run db:studio` | Prisma Studio |
| `npm run db:backup` | Timestamped copy of the database in `prisma/backups/` |
| `npm run check:currencies` | Fails if the currency list drifts from the frontend |

## Structure

```
src/
  index.ts          App wiring, JSON 404 and error handlers
  lib/
    prisma.ts       Client singleton (survives nodemon reloads)
    money.ts        Cents <-> amounts conversion
    currencies.ts   Supported currency codes
  middleware/
    auth.ts         Bearer token verification
  routes/
    auth.ts         POST /auth/register, POST /auth/login
    api.ts          Everything else, all behind auth
prisma/
  schema.prisma     User, Category, Budget, Transaction
scripts/            Maintenance scripts
tests/              Integration tests
```

## Endpoints

Public:

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/register` | Creates the user, seeds 8 default categories, returns a JWT |
| POST | `/auth/login` | Returns a JWT and the user |

Protected (Bearer token required):

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/dashboard` | Balance, totals, 10 recent transactions, pie data |
| GET | `/api/analytics` | `?months=3\|6\|12` `&days=30\|90`; buckets, trends, insights |
| GET | `/api/transactions` | Filter by date range, type, category, min, max, search; sort; paginate |
| POST/PUT/DELETE | `/api/transactions[/:id]` | Future dates are rejected |
| GET | `/api/categories` | Optional `?from` `&to`; per-period totals plus `allTimeCount` |
| POST/PUT/DELETE | `/api/categories[/:id]` | Deleting with movements requires `?reassignTo=<id>` |
| GET | `/api/budgets` | `?period=WEEK\|MONTH`; omit for both |
| POST/PUT/DELETE | `/api/budgets[/:id]` | Unique per category and period |
| GET/PUT | `/api/profile` | Name and currency |
| POST | `/api/transactions` | Accepts an optional `clientId`; a replay returns `200` with the stored row instead of creating a second one |

## Testing

`npm test` boots the real server against a throwaway SQLite database in the
system temp directory, runs every `*.test.mjs` suite, then tears it down. There
is no mocking: assertions go through actual HTTP requests.

## Notes

- **Money is stored as whole cents** in an `Int` column, not as a float. SQLite
  has no exact decimal type — a Prisma `Decimal` is stored as `REAL`, which is
  the same lossy double. Handlers accumulate in cents and convert only when
  writing the JSON response (`src/lib/money.ts`).
- **The database is reached through the libSQL driver adapter** (`src/lib/prisma.ts`),
  which is what lets the same schema talk to a local file and to a hosted Turso
  database. Switch by changing `DATABASE_URL` (and `TURSO_AUTH_TOKEN`) only.
  - `DATABASE_URL` for a local file **must include the `prisma/` prefix**.
    `@libsql/client` resolves a relative `file:` URL against the process working
    directory, while the Prisma CLI resolves it against the schema folder. With
    the shorter `file:./dev.db` the app silently opens a second, empty database.
  - `driverAdapters` is a preview feature in Prisma 5. The test suite runs
    through the adapter, so a regression there fails the build.
- **Creates are idempotent.** A transaction create may carry a `clientId`; a
  replay returns the stored row with `200` instead of writing a second one. The
  frontend attaches one before the first attempt so a lost response cannot
  duplicate a movement. `@@unique([userId, clientId])` is scoped by user, and a
  `P2002` from a lost race is turned back into the same `200`.
- There are no Prisma migrations. The schema is applied by pushing it, and
  `db push` is the intended local workflow.
- **`prisma db push` cannot target a hosted database.** The Prisma CLI reads
  the datasource URL itself and its SQLite connector only accepts `file:`, so
  it rejects a `libsql://` URL with *"the URL must start with the protocol
  file:"*. The CLI does not go through the driver adapter, so the adapter the
  app uses makes no difference. For a hosted database use `npm run db:apply`:
  it asks Prisma to diff the schema against an empty database (pure codegen, no
  connection needed) and runs the resulting SQL through `@libsql/client`, which
  does speak `libsql://`.
- **`db:apply` brings a database up to date with the schema, additively.**
  - Missing tables and indexes are created.
  - **Missing columns are added with `ALTER TABLE ... ADD COLUMN`**, so adding a
    field to a model and redeploying is enough.
  - Columns that exist in the database but not in the schema are reported and
    left alone. Nothing is ever dropped.
  - SQLite cannot add a `NOT NULL` column with no default to a table that
    already has rows, and it cannot drop or rename columns. When that happens
    the script stops with the exact statement and the reason, and the data has
    to be recreated. Give the new field a default (`@default("")`) if it has to
    be required, or make it optional.
- Access tokens have no `expiresIn`: a session ends when the user logs out.
- Weeks start on Monday, matching the frontend.
- Currency is a display preference. There is no conversion between currencies.