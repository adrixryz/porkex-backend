# Porkex — backend

REST API for Porkex, a personal finance tracker: Express + TypeScript, Prisma ORM and SQLite.

The frontend lives in `../porkex-web-app` and talks to this server through the
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
| `npm run db:seed` | Fills a test account with six months of realistic data |
| `npm run db:studio` | Prisma Studio |
| `npm run db:backup` | Timestamped copy of the database in `prisma/backups/` |
| `npm run check:currencies` | Fails if the currency list drifts from the frontend |

## Structure

```
src/
  index.ts          App wiring, /health probe, JSON 404 and error handlers
  lib/
    prisma.ts       Client singleton (survives nodemon reloads)
    money.ts        Cents <-> amounts conversion
    dates.ts        Calendar-day helpers (all math in UTC)
    recurring.ts    Recurring-rule schedule and catch-up materialization
    errors.ts       Prisma error helpers (unique violation)
    currencies.ts   Supported currency codes
    passwords.ts    Password policy (shared by register and change)
  middleware/
    auth.ts         Bearer token verification
    rateLimit.ts    Auth and API rate limiters
  routes/
    auth.ts         POST /auth/register, POST /auth/login
    api.ts          Everything else, all behind auth
prisma/
  schema.prisma     User, Category, Budget, Transaction, RecurringRule
scripts/            Maintenance scripts
tests/              Integration tests
```

## Endpoints

Public:

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/register` | Creates the user, seeds 8 default categories, returns a JWT |
| POST | `/auth/login` | Returns a JWT and the user |
| GET | `/health` | Pings the database: `200 { status: "ok", db: "up" }` or `503 { status: "degraded", db: "down" }` |

Protected (Bearer token required):

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/dashboard` | Balance, totals, 10 recent transactions, pie data |
| GET | `/api/analytics` | `?months=3\|6\|12` `&days=30\|90` `&today=YYYY-MM-DD`; buckets, trends, insights |
| GET | `/api/transactions` | Filter by date range (`from`/`to` as `YYYY-MM-DD` or ISO), type, category, min, max, search; sort; paginate |
| POST/PUT/DELETE | `/api/transactions[/:id]` | Future dates are rejected |
| GET | `/api/categories` | Optional `?from` `&to`; per-period totals plus `allTimeCount` |
| POST/PUT/DELETE | `/api/categories[/:id]` | Deleting with movements requires `?reassignTo=<id>` |
| GET | `/api/budgets` | `?period=WEEK\|MONTH` `&today=YYYY-MM-DD`; omit period for both |
| POST/PUT/DELETE | `/api/budgets[/:id]` | Unique per category and period |
| GET | `/api/recurring` | Rules with their next occurrence; active first, due first within each group |
| POST/PUT/DELETE | `/api/recurring[/:id]` | `frequency` (WEEK/MONTH/YEAR) × `interval` (1–12), optional `endDate`; `PUT` also takes `active` to pause/resume; `POST` accepts `clientId` like transactions |
| GET/PUT | `/api/profile` | Name and currency |
| PUT | `/api/password` | Change the password; verifies the current one (400, never 401, on mismatch) |
| POST | `/api/transactions` | Accepts an optional `clientId`; a replay returns `200` with the stored row instead of creating a second one |

## Testing

`npm test` boots the real server against a throwaway SQLite database in the
system temp directory, runs every `*.test.mjs` suite, then tears it down. There
is no mocking: assertions go through actual HTTP requests.

## Test data

`npm run db:seed` creates an account with six months of history, so the
dashboard, analytics, category totals and budget bars all have something to show.

```
seed@porkex.test / porkex123
```

It generates a monthly salary, the odd freelance invoice, rent and utilities,
and variable Food / Transport / Entertainment / Shopping spending, plus three
monthly and two weekly budgets (which land both under and over their limit).
The random generator is seeded, so the same command always produces the same
data — "the analytics look wrong" is a real signal instead of noise.

| Variable | Default |
| --- | --- |
| `SEED_EMAIL` | `seed@porkex.test` |
| `SEED_PASSWORD` | `porkex123` |
| `SEED_NAME` | `Porkex Tester` |
| `SEED_MONTHS` | `6` |
| `SEED_CURRENCY` | `USD` |

It never touches an account that already has data: it skips it and exits 0, so
the same command can run in the Render build on every deploy without failing.
Regenerating requires the explicit flag:

```
npm run db:seed -- --reset   # wipes and regenerates that account
```

It writes to whatever `DATABASE_URL` points at, so to fill the hosted database
run it from your machine with Turso's values in the environment:

```bash
DATABASE_URL="libsql://porkex-db-xxx.turso.io" TURSO_AUTH_TOKEN="..." npm run db:seed
```

Only the account named by `SEED_EMAIL` is ever read or written.

## Notes

- **Dates are calendar days, stored as UTC midnight.** A transaction's `date` is
  the day the user picked, not an instant: it is written as `YYYY-MM-DDT00:00:00.000Z`
  and every computation (month/week buckets, ranges, budget windows) is done in
  UTC with `getUTC*`/`Date.UTC`, so a day can never shift because of the
  server's or the device's timezone.
  - `from`/`to` accept either `YYYY-MM-DD` (the whole day, `00:00:00.000` to
    `23:59:59.999` UTC) or a full ISO timestamp.
  - The frontend sends `today=YYYY-MM-DD` on `/analytics` and `/budgets`: the
    windows that depend on "now" are anchored to the user's own calendar day
    instead of the server's. Real instants (`createdAt`) are still returned as
    full timestamps and displayed in local time.
- **Rate limiting.** `/auth` counts only failed attempts (30 per 15 min per IP,
  `AUTH_RATE_LIMIT_MAX` to override) so logging in never consumes the budget;
  the rest of the API allows 600 requests per minute per IP
  (`API_RATE_LIMIT_MAX`). Both answer `429` with a JSON `error`. The app sets
  `trust proxy` to 1 hop for the hosting reverse proxy.
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
  `P2002` from a lost race is turned back into the same `200`. Recurring rules
  work the same way.
- **Recurring rules materialize into normal transactions.** A rule (every 1–12
  weeks/months/years) becomes real `Transaction` rows, so the dashboard,
  analytics, budgets and the transactions list keep reading plain rows. There is
  no scheduler: every authenticated request first runs a catch-up of whatever
  came due — a single indexed `SELECT` when nothing is — which also covers days
  the free-tier server spent asleep. `@@unique([recurringId, date])` makes the
  pass idempotent, so a replay or a race cannot materialize a date twice.
  - A rule created, edited or resumed today starts at the next occurrence that
    has not passed (today itself counts) — nothing is backfilled, and a pause is
    never filled in afterwards.
  - The rule's start day is the anchor: month occurrences that land on a date
    the target month does not have clamp to its last day (the 31st → Feb 28/29)
    and return to the anchor day afterwards, instead of drifting earlier.
  - Deleting a rule keeps the movements it already created, as plain history
    (`recurringId` is cleared in the delete route: the additive `db:apply` tool
    cannot add a foreign key to an existing production table).
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
  This is deliberate for a single-user app — being asked to log in again on the
  phone is worse than the (small, personal) window a leaked token would open.
  If the threat model changes, add `expiresIn` in `src/routes/auth.ts` and a
  refresh flow before shortening it.
- Weeks start on Monday, matching the frontend.
- Currency is a display preference. There is no conversion between currencies.