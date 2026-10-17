# Porkex — backend

REST API for Porkex, a personal finance tracker: Express + TypeScript, Prisma ORM and SQLite.

The frontend lives in `../porkex-web-app` and talks to this server through the
`/auth` and `/api` endpoints.

## Requirements

- Node 24+
- A `.env` file (see below)

## Getting started

```bash
cp .env.example .env      # then set JWT_SECRET
npm install               # postinstall runs `prisma generate`
npm run db:apply          # creates prisma/dev.db using versioned migrations
npm run dev               # http://localhost:3000
```

`JWT_SECRET` has no default value. The process refuses to start without it,
because a fallback would silently sign every token with a key that is published
in the source. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Registration is closed by default. To prepare a new personal account, temporarily
set `ALLOW_REGISTRATION=true`, restart the API and register through the frontend.
Then set it back to `false` and restart. Existing accounts can still sign in.

This API runs against a hosted [Turso](https://turso.tech) database (libSQL) in
production and a local SQLite file in development, with no code change: put the
`libsql://` URL and the auth token in `DATABASE_URL` and `TURSO_AUTH_TOKEN`. The
Turso database for this project is **`porkex-db`**; the name only ever appears
inside the URL, never in the code or the schema.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with Node's built-in watch mode + ts-node |
| `npm run build` | Compiles TypeScript to `dist/` |
| `npm start` | Builds, then runs `dist/index.js` |
| `npm test` | Integration tests (`tests/run.mjs`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run db:push` | Prisma CLI for disposable local experiments; bypasses migration history |
| `npm run db:apply` | Applies checksummed SQL migrations to local SQLite or Turso |
| `npm run db:check` | Checks migrations against `schema.prisma` offline; never connects to the configured database |
| `npm run db:seed` | Fills a test account with six months of realistic data |
| `npm run db:studio` | Prisma Studio |
| `npm run db:backup` | Verified SQLite snapshot of the configured local database or Turso, in `prisma/backups/` |
| `npm run db:verify-backup -- path.db` | Restores a backup to a temporary local copy and verifies it |
| `npm run check:currencies` | Fails if the currency list drifts from the frontend |

## Structure

```
src/
  index.ts          App wiring, /health probe, JSON 404 and error handlers
  lib/
    prisma.ts       Client singleton
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
  migrations/       Immutable, ordered SQL migrations
scripts/            Maintenance scripts
tests/              Integration tests
```

## Endpoints

Public:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/auth/config` | Returns `{ registrationEnabled }` so the frontend can hide registration |
| POST | `/auth/register` | When enabled, creates the user, seeds 9 default categories and returns a JWT; otherwise `403` |
| POST | `/auth/login` | Returns a JWT and the user |
| GET | `/health` | Pings the database: `200 { status: "ok", db: "up" }` or `503 { status: "degraded", db: "down" }` |

Protected (Bearer token required):

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/dashboard` | Balance, totals, 10 recent transactions, pie data |
| GET | `/api/analytics` | `?months=3..12` `&days=7..120` `&today=YYYY-MM-DD`; buckets, trends, insights |
| GET | `/api/transactions` | Filter by date range (`from`/`to` as `YYYY-MM-DD` or ISO), type, category, min, max, search; sort; paginate |
| POST/PUT/DELETE | `/api/transactions[/:id]` | Future dates are rejected |
| GET | `/api/categories` | Optional `?from` `&to`; per-period totals plus `allTimeCount` |
| POST/PUT/DELETE | `/api/categories[/:id]` | Deleting with movements requires `?reassignTo=<id>` |
| GET | `/api/budgets` | `?period=WEEK\|MONTH` `&today=YYYY-MM-DD` `&weekStart=MONDAY..SUNDAY` (defaults to MONDAY); omit period for both |
| POST/PUT/DELETE | `/api/budgets[/:id]` | Unique per category and period |
| GET | `/api/recurring` | Rules with their next occurrence; active first, due first within each group |
| POST/PUT/DELETE | `/api/recurring[/:id]` | `frequency` (DAY/WEEK/MONTH/YEAR) × `interval` (1–24), optional `endDate`; `PUT` also takes `active` to pause/resume; `POST` accepts `clientId` like transactions |
| GET/PUT | `/api/profile` | Name, currency and display preferences (`defaultPeriod` day/week/month/year, `firstDayOfWeek` day name, `decimalSeparator` `.` or `,`) |
| PUT | `/api/password` | Change the password; verifies the current one (400, never 401, on mismatch) |
| POST | `/api/transactions` | Accepts an optional `clientId`; a replay returns `200` with the stored row instead of creating a second one |

## Testing

`npm test` boots the real server against a throwaway SQLite database in the
system temp directory, applies the real migration chain, runs every `*.test.mjs`
suite, then tears it down. API tests use real HTTP requests; focused suites also
check calendar math, backups, migrations and harness failure cleanup. Database
URLs, Turso tokens and the test JWT secret are forced to isolated values even
when a local `.env` points at production. CI runs build, schema checks and tests
on Node 24, on Linux and Windows.

## Backups and migrations

`npm run db:backup` loads the backend's `.env` and reads the configured database
in one consistent read transaction. It works with both `file:` and `libsql://`
URLs. Relative file paths resolve from the backend root, just like the app when
started there. A missing local source fails instead of creating an empty file.

The output is a standalone SQLite database, preserving table definitions,
indexes, views, triggers, IDs, autoincrement sequences and raw SQL values. The
script checks copied rows, foreign keys and SQLite integrity before publishing
the final filename. Interrupted or failed copies are never published as backups.
An existing destination is never overwritten. For a chosen path:

```bash
npm run db:backup -- --output prisma/backups/before-migration.db
npm run db:verify-backup -- prisma/backups/before-migration.db
```

Verification restores the file into a temporary local directory, checks its
integrity and relationships, and reads every table. It never changes the source
backup or contacts Turso. Backups contain private account data and password
hashes; the backup directory is ignored by Git. Keep a verified copy on separate
storage as well.

For local recovery, stop the server, copy the verified backup to a **new** path
such as `prisma/restored.db`, point `DATABASE_URL` at `file:./prisma/restored.db`,
and run `npm run db:apply` before starting the API. Check the recovered data before
replacing the original file. Production recovery is a separate operation: import
the verified SQLite snapshot into a replacement Turso database, validate it and
then update the service configuration. These scripts never upload or restore
over the hosted database.

`npm run db:apply` is the supported schema workflow for both environments:

- SQL files in `prisma/migrations/` are ordered and checksummed. Applied IDs,
  checksums and UTC timestamps live in `_PorkexMigration`. Never edit an applied
  migration; add a new directory and SQL file instead.
- An existing installation can adopt the original canonical schema or the known
  historical variant lacking the `Transaction.recurringId` foreign key. That
  variant is rebuilt transactionally, preserving rows, IDs and sequences.
- Unknown drift in columns, defaults, constraints, indexes or migration history
  stops the operation without changes. A failing migration rolls back the whole
  invocation, including the ledger and any baseline adoption.
- `npm run db:check` compares the full migration chain with `schema.prisma`
  entirely offline. Run it after changing either. The same check runs before
  applying migrations; a model change without a migration is rejected.

Create and verify a backup before applying migrations to your hosted database.
`prisma db push` is reserved for disposable local experiments; it does not update
the migration ledger and can leave a database the runner will refuse to adopt.

## Test data

`npm run db:seed` creates an account with six months of history, so the
dashboard, analytics, category totals and budget bars all have something to show.

```
seed@porkex.test / porkex123
```

It generates a monthly salary, the odd freelance invoice, rent and utilities,
and variable Food / Transport / Entertainment / Shopping spending, plus three
monthly and two weekly budgets (which land both under and over their limit) and
the two recurring rules behind the salary and the rent.
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
  - The frontend sends its IANA timezone in `X-Porkex-Time-Zone`, for example
    `America/Lima`. The backend uses it only to choose the user's current
    calendar day for recurrent operations and date checks; internal dates and
    arithmetic stay in UTC. If absent, the zone defaults to `America/Lima`;
    an invalid zone is rejected with `400`.
  - `from`/`to` accept either `YYYY-MM-DD` (the whole day, `00:00:00.000` to
    `23:59:59.999` UTC) or a full ISO timestamp.
  - The frontend sends `today=YYYY-MM-DD` on `/analytics` and `/budgets`: the
    windows that depend on "now" are anchored to the user's own calendar day
    instead of the server's. `/budgets` also takes `weekStart=<DAY>` so the
    weekly window opens on the configured first day of the week (Monday when
    absent). Real instants (`createdAt`) are still returned as full timestamps
    and displayed in local time.
- **Rate limiting.** `/auth` counts only failed attempts (30 per 15 min per IP,
  `AUTH_RATE_LIMIT_MAX` to override) so logging in never consumes the budget;
  the rest of the API allows 600 requests per minute per IP
  (`API_RATE_LIMIT_MAX`). Both answer `429` with a JSON `error`. The app sets
  `trust proxy` to 1 hop for the hosting reverse proxy.
- **Money is stored as whole cents** in an `Int` column, not as a float. SQLite
  has no exact decimal type — a Prisma `Decimal` is stored as `REAL`, which is
  the same lossy double. Handlers accumulate in cents and convert only when
  writing the JSON response (`src/lib/money.ts`).
  Inputs must be numbers or decimal strings with at most two decimal places;
  booleans, arrays, objects and excess precision are rejected.
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
- **Recurring rules materialize into normal transactions.** A rule (every 1–24
  days/weeks/months/years) becomes real `Transaction` rows, so the dashboard,
  analytics, budgets and the transactions list keep reading plain rows. There is
  no scheduler: every authenticated request first runs a catch-up of whatever
  came due — one small active-rule read when nothing is — which also covers days
  the free-tier server spent asleep. `@@unique([recurringId, date])` makes the
  pass idempotent, so a replay or a race cannot materialize a date twice.
  - `X-Porkex-Recurring-State` reports `ready`, `pending` (catch-up has more work)
    or `failed` (the response may be missing due movements). The frontend can
    report incomplete totals and retry. CORS exposes this response header.
  - A UTC watermark preserves processed occurrences even if the generated
    movement is deleted. Non-schedule edits preserve the cursor, so changing a
    description cannot recreate a deleted expense. The initial migration
    backfills the watermark from existing linked movements only.
  - Migration 003 converts known epoch-millisecond/UTC text DateTime storage to
    the UTC format used by the adapter so SQL ranges include legacy records.
    It preserves instants and stops with a full rollback for unknown or invalid
    date encodings; take a verified backup before applying migrations.
  - A rule created, edited or resumed today starts at the next occurrence that
    has not passed (today itself counts) — nothing is backfilled, and a pause is
    never filled in afterwards.
  - The rule's start day is the anchor: month occurrences that land on a date
    the target month does not have clamp to its last day (the 31st → Feb 28/29)
    and return to the anchor day afterwards, instead of drifting earlier.
  - Deleting a rule keeps the movements it already created as plain history;
    their `recurringId` becomes null.
- Access tokens have no `expiresIn`: a session ends when the user logs out.
  This is deliberate for a single-user app — being asked to log in again on the
  phone is worse than the (small, personal) window a leaked token would open.
  If the threat model changes, add `expiresIn` in `src/routes/auth.ts` and a
  refresh flow before shortening it.
- Weeks start on Monday, matching the frontend.
- Currency is a display preference. There is no conversion between currencies.

## Tags and comments

Comments are optional (200 characters); legacy description payloads remain supported. Tags have account-scoped names of 1–20 Unicode code points, a persisted manual order and stable client references. GET/POST /api/tags, PUT /api/tags/:id, PUT /api/tags/order and DELETE /api/tags/:id manage the catalog. Movements accept 0–5 tagIds; omitted tagIds preserve associations on older PUT requests. Deleting a tag removes links, never movements. Migration 004 adds the catalog without changing existing rows.
