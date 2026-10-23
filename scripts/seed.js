// Seeds a test account with 24 months of realistic activity, so every screen
// has something to show: the dashboard, the analytics ranges, the category
// totals, the budget progress bars (both under and over the limit) and the
// transaction list with its filters and search, and the recurring screen with
// four rules, tags and next-only exceptions.
//
//   npm run db:seed            # skips (exit 0) when the account already exists
//   npm run db:seed -- --reset # wipes that account's data first
//   npm run db:seed -- --fresh # recreates ALL Porkex tables, then seeds
//
// Configuration, all optional:
//   SEED_EMAIL     default seed@porkex.test
//   SEED_PASSWORD  default porkex123
//   SEED_NAME      default Porkex Tester
//   SEED_MONTHS    default 24 (1–120)
//   SEED_CURRENCY  default USD
//   SEED_TIME_ZONE default America/Lima (calendar day; dates are stored in UTC)
//
// It writes to whatever DATABASE_URL points at, so running it locally fills
// prisma/dev.db and running it on Render fills Turso. Only the account named by
// SEED_EMAIL is ever touched.
const { PrismaClient } = require('@prisma/client')
const { PrismaLibSQL } = require('@prisma/adapter-libsql')
const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { loadEnvironment, databaseConfig, createClient, safeError } = require('./lib/database')
const { loadMigrations, buildReference, describe, sameSchema } = require('./lib/migrations')
const bcrypt = require('bcryptjs')

loadEnvironment()

const RESET = process.argv.includes('--reset')
const FRESH = process.argv.includes('--fresh')

async function recreateSchema(client) {
  const schema = spawnSync(
    process.execPath,
    [
      require.resolve('prisma/build/index.js'),
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
      path.join(__dirname, '..', 'prisma', 'schema.prisma'),
      '--script'
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: 'file::memory:', TURSO_AUTH_TOKEN: '' }
    }
  )
  if (schema.error || schema.status !== 0)
    throw new Error(
      'Could not generate the current test schema: ' + (schema.error?.message || schema.stderr)
    )
  const migrations = loadMigrations()
  const reference = await buildReference(migrations)
  let tx
  try {
    tx = await client.transaction('write')
    // Children first, including aliases and next-only exceptions. Unrelated
    // tables are never dropped; unexpected references fail transactionally.
    for (const table of [
      'FinancialReceipt',
      'Transfer',
      'OccurrenceTag',
      'OccurrenceOverride',
      'TransactionTag',
      'TagReference',
      'Tag',
      'Transaction',
      'RecurringRule',
      'Budget',
      'Category',
      'Account',
      'User',
      '_PorkexMigration'
    ])
      await tx.execute(`DROP TABLE IF EXISTS "${table}"`)
    await tx.executeMultiple(schema.stdout)
    if (!sameSchema(await describe(tx), reference.versions.at(-1)))
      throw new Error('The current schema and migration history disagree.')
    // Register this fresh baseline for existing maintenance tools. No incremental
    // migrations or historical data conversions run against the configured DB.
    await tx.execute(
      'CREATE TABLE "_PorkexMigration" ("id" TEXT NOT NULL PRIMARY KEY, "checksum" TEXT NOT NULL, "appliedAt" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)'
    )
    for (const migration of migrations)
      await tx.execute({
        sql: 'INSERT INTO "_PorkexMigration" (id, checksum) VALUES (?, ?)',
        args: [migration.id, migration.checksum]
      })
    if ((await tx.execute('PRAGMA foreign_key_check')).rows.length)
      throw new Error('Fresh schema has foreign-key violations.')
    await tx.commit()
  } finally {
    tx?.close()
    reference.client.close()
  }
}

const CONFIG = {
  email: (process.env.SEED_EMAIL || 'seed@porkex.test').toLowerCase(),
  password: process.env.SEED_PASSWORD || 'porkex123',
  name: process.env.SEED_NAME || 'Porkex Tester',
  months: Number(process.env.SEED_MONTHS || 24),
  currency: process.env.SEED_CURRENCY || 'USD',
  timeZone: process.env.SEED_TIME_ZONE || 'America/Lima'
}

// Same categories the registration endpoint seeds, so the account looks like a
// real one rather than a fixture.
const CATEGORIES = [
  { name: 'Salary', type: 'INCOME', color: '#34A853' },
  { name: 'Freelance', type: 'INCOME', color: '#4285F4' },
  { name: 'Sales', type: 'INCOME', color: '#A8C7FA' },
  { name: 'Food', type: 'EXPENSE', color: '#EA4335' },
  { name: 'Transport', type: 'EXPENSE', color: '#FBBC04' },
  { name: 'Entertainment', type: 'EXPENSE', color: '#A142F4' },
  { name: 'Housing', type: 'EXPENSE', color: '#5F6368' },
  { name: 'Shopping', type: 'EXPENSE', color: '#E8710A' },
  { name: 'Others', type: 'EXPENSE', color: '#78909C' }
]

// A seeded generator, so the same command always produces the same data. That
// makes "the analytics look wrong" a real signal instead of noise.
function makeRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}
const random = makeRandom(20240615)
const between = (min, max) => min + random() * (max - min)
const intBetween = (min, max) => Math.floor(between(min, max + 1))
const pick = list => list[Math.floor(random() * list.length)]

// Amounts live in the database as whole cents.
const toCents = amount => Math.round(amount * 100)

function calendarToday(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now)
  const value = type => Number(parts.find(part => part.type === type).value)
  return new Date(Date.UTC(value('year'), value('month') - 1, value('day')))
}
const addDays = (date, count) => new Date(date.getTime() + count * 86400000)

// Repeating descriptions keep the search box in TransactionsView meaningful.
const DESCRIPTIONS = {
  Food: [
    'Supermarket',
    'Bakery',
    'Coffee',
    'Lunch out',
    'Groceries',
    'Dinner',
    'Farmers market',
    'Takeaway',
    'Breakfast',
    'Snacks'
  ],
  Transport: ['Bus fare', 'Metro card', 'Taxi', 'Fuel', 'Parking', 'Bike repair'],
  Entertainment: ['Cinema', 'Concert', 'Streaming', 'Books', 'Museum', 'Board game'],
  Shopping: ['Shoes', 'T-shirt', 'Headphones', 'Kitchenware', 'Gift', 'Jacket'],
  Housing: ['Rent', 'Electricity', 'Water', 'Internet', 'Gas', 'Phone plan'],
  Salary: ['Monthly salary'],
  Freelance: ['Client invoice', 'Consulting', 'Side project', 'Workshop'],
  Sales: ['Marketplace sale', 'Second hand sale']
}

async function wipeUser(prisma, userId) {
  // The caller wraps deletion and regeneration in one transaction. Cascades
  // remove occurrence/tag links and aliases before the owning records go away.
  const rules = await prisma.recurringRule.deleteMany({ where: { userId } })
  const budgets = await prisma.budget.deleteMany({ where: { userId } })
  const transactions = await prisma.transaction.deleteMany({ where: { userId } })
  const tags = await prisma.tag.deleteMany({ where: { userId } })
  const categories = await prisma.category.deleteMany({ where: { userId } })
  await prisma.transfer.deleteMany({ where: { userId } })
  await prisma.financialReceipt.deleteMany({ where: { userId } })
  await prisma.account.deleteMany({ where: { userId } })
  await prisma.user.delete({ where: { id: userId } })
  return {
    rules: rules.count,
    budgets: budgets.count,
    transactions: transactions.count,
    tags: tags.count,
    categories: categories.count
  }
}

function buildTransactions(categoriesByName, startDate, recurringIds, day) {
  const rows = []

  for (let m = 0; m < CONFIG.months; m++) {
    const monthStart = new Date(
      Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + m, 1)
    )
    // Never past today: the API rejects future dates and the analytics window
    // ends now anyway.
    const isCurrentMonth =
      monthStart.getUTCMonth() === day.getUTCMonth() &&
      monthStart.getUTCFullYear() === day.getUTCFullYear()
    const lastDay = isCurrentMonth
      ? day.getUTCDate()
      : new Date(
          Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)
        ).getUTCDate()

    const add = (dateOfMonth, name, amount, description) => {
      if (dateOfMonth > lastDay) return null
      const row = {
        date: new Date(
          Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), dateOfMonth)
        ),
        categoryId: categoriesByName[name].id,
        type: categoriesByName[name].type,
        amount: toCents(amount),
        description: description ?? pick(DESCRIPTIONS[name])
      }
      rows.push(row)
      return row
    }

    // ── income: salary on the 1st, the odd freelance invoice ──
    // The salary and the rent are the two seeded recurring rules' handiwork
    // (see buildRecurringRules): tag them so the transactions list shows the
    // repeat icon on the movements those rules produced.
    const salary = add(1, 'Salary', 3200, 'Monthly salary')
    if (salary) salary.recurringId = recurringIds.salary
    for (let i = 0; i < intBetween(1, 2); i++) {
      add(intBetween(3, 26), 'Freelance', between(180, 850))
    }
    if (random() > 0.75) add(intBetween(8, 24), 'Sales', between(20, 140))

    // ── fixed housing, on slightly different days each month ──
    const rent = add(3, 'Housing', 950, 'Rent')
    if (rent) rent.recurringId = recurringIds.rent
    add(10, 'Housing', between(55, 130))
    add(18, 'Housing', between(30, 45))

    // ── variable spending, spread over the month ──
    const groceries = intBetween(9, 14)
    for (let i = 0; i < groceries; i++) {
      add(intBetween(1, 28), 'Food', between(7, 62))
    }
    const rides = intBetween(7, 12)
    for (let i = 0; i < rides; i++) {
      add(intBetween(1, 28), 'Transport', between(2, 28))
    }
    const fun = intBetween(3, 6)
    for (let i = 0; i < fun; i++) {
      add(intBetween(1, 28), 'Entertainment', between(9, 48))
    }
    const shopping = intBetween(1, 3)
    for (let i = 0; i < shopping; i++) {
      add(intBetween(2, 27), 'Shopping', between(22, 190))
    }
  }

  // Daily recent receipts give both weeks data even at month/year boundaries.
  for (let offset = 1; offset <= 13; offset++) {
    const date = addDays(day, -offset)
    if (date >= startDate)
      rows.push({
        date,
        categoryId: categoriesByName.Food.id,
        type: 'EXPENSE',
        amount: 450 + offset * 25,
        description: 'Morning coffee'
      })
  }
  // Always have recent data, including both optional-comment cases and tags
  // at their five-selection limit, even when today is the first of the month.
  rows.push({
    date: day,
    categoryId: categoriesByName.Food.id,
    type: 'EXPENSE',
    amount: 1876,
    description: ''
  })
  rows.push({
    date: day,
    categoryId: categoriesByName.Sales.id,
    type: 'INCOME',
    amount: 3250,
    description: ''
  })
  return rows
    .sort((a, b) => a.date - b.date)
    .map((row, index) => ({
      ...row,
      clientId: 'seed-row-' + index,
      createdAt: row.date,
      editedAt: row.date,
      lastEditId: 'seed-edit-' + index,
      description: !row.recurringId && index % 6 === 0 ? '' : row.description
    }))
}

function buildBudgets(categoriesByName) {
  return [
    { name: 'Food', period: 'MONTH', amount: 420 },
    { name: 'Transport', period: 'MONTH', amount: 140 },
    { name: 'Entertainment', period: 'MONTH', amount: 120 },
    { name: 'Food', period: 'WEEK', amount: 90 },
    { name: 'Transport', period: 'WEEK', amount: 35 }
  ].map(b => ({
    categoryId: categoriesByName[b.name].id,
    period: b.period,
    amount: toCents(b.amount)
  }))
}

// The next upcoming occurrence of a monthly schedule, strictly after today
// (the configured local day represented in UTC): the month's movements are already
// seeded as history, so leaving a due date behind would make the API's
// catch-up pass materialize duplicates on the first login.
function nextAfterToday(anchor, day) {
  const anchorDay = anchor.getUTCDate()
  const today = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()))
  let next = anchor
  while (next <= today) {
    const total = next.getUTCMonth() + 1
    const year = next.getUTCFullYear() + Math.floor(total / 12)
    const month = total % 12
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    next = new Date(Date.UTC(year, month, Math.min(anchorDay, lastDay)))
  }
  return next
}

// Two rules, one per side of the ledger, mirroring the movements every month
// already carries: the salary on the 1st and the rent on the 3rd.
function buildRecurringRules(categoriesByName, startDate, day) {
  const rule = (name, dayOfMonth, amount, description) => {
    const start = new Date(
      Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), dayOfMonth)
    )
    return {
      categoryId: categoriesByName[name].id,
      type: categoriesByName[name].type,
      amount: toCents(amount),
      description,
      frequency: 'MONTH',
      interval: 1,
      startDate: start,
      endDate: null,
      nextDate: nextAfterToday(start, day),
      active: true
    }
  }

  return {
    salary: rule('Salary', 1, 3200, 'Monthly salary'),
    rent: rule('Housing', 3, 950, 'Rent')
  }
}

const TAG_NAMES = [
  'Essential',
  'Work',
  'Home',
  'Daily',
  'Leisure',
  'Transport',
  'Family',
  'One-off'
]

async function seedAccount(db, user, startDate, day) {
  await db.category.createMany({
    data: CATEGORIES.map((c, index) => ({
      ...c,
      userId: user.id,
      clientId: 'seed-category-' + index
    }))
  })
  const categories = await db.category.findMany({ where: { userId: user.id } })
  const byName = Object.fromEntries(categories.map(c => [c.name, c]))
  const tags = TAG_NAMES.map((name, position) => ({
    id: randomUUID(),
    userId: user.id,
    name,
    normalizedName: name.toLowerCase(),
    position
  }))
  await db.tag.createMany({ data: tags })
  await db.tagReference.createMany({ data: tags.map(tag => ({ id: tag.id, tagId: tag.id })) })
  const tagIds = names => names.map(name => tags.find(tag => tag.name === name).id)

  const templates = buildRecurringRules(byName, startDate, day)
  const salary = await db.recurringRule.create({ data: { ...templates.salary, userId: user.id } })
  const rent = await db.recurringRule.create({ data: { ...templates.rent, userId: user.id } })
  const transactions = buildTransactions(
    byName,
    startDate,
    { salary: salary.id, rent: rent.id },
    day
  )
  const chunkSize = 200
  for (let i = 0; i < transactions.length; i += chunkSize)
    await db.transaction.createMany({
      data: transactions.slice(i, i + chunkSize).map(row => ({ ...row, userId: user.id }))
    })
  const stored = await db.transaction.findMany({
    where: { userId: user.id },
    select: { id: true, clientId: true }
  })
  const ids = new Map(stored.map(row => [row.clientId, row.id]))
  const categoryTag = {
    Salary: 'Work',
    Freelance: 'Work',
    Sales: 'One-off',
    Food: 'Daily',
    Housing: 'Home',
    Transport: 'Transport',
    Entertainment: 'Leisure',
    Shopping: 'Family'
  }
  const links = transactions.flatMap((row, index) => {
    const category = categories.find(category => category.id === row.categoryId)
    const names =
      index === transactions.length - 2
        ? ['Essential', 'Daily', 'Home', 'Family', 'One-off']
        : index % 5 === 0
          ? []
          : [
              ...new Set([
                categoryTag[category.name] || 'Daily',
                ...(index % 3 === 0 ? ['Essential'] : [])
              ])
            ]
    return tagIds(names).map(tagId => ({ transactionId: ids.get(row.clientId), tagId }))
  })
  for (let i = 0; i < links.length; i += chunkSize)
    await db.transactionTag.createMany({ data: links.slice(i, i + chunkSize) })

  for (const rule of [salary, rent]) {
    const history = transactions.filter(row => row.recurringId === rule.id)
    if (history.length)
      await db.recurringRule.update({
        where: { id: rule.id },
        data: { lastProcessedDate: history[history.length - 1].date }
      })
  }
  const weekly = (category, amount, description, date) => ({
    userId: user.id,
    categoryId: byName[category].id,
    type: 'EXPENSE',
    amount: toCents(amount),
    description,
    frequency: 'WEEK',
    interval: 1,
    startDate: date,
    nextDate: date
  })
  const lunch = await db.recurringRule.create({
    data: weekly('Food', 35, 'Weekly lunch', addDays(day, 2))
  })
  await db.occurrenceOverride.create({
    data: {
      ruleId: lunch.id,
      date: lunch.nextDate,
      kind: 'EDIT',
      amount: toCents(60),
      comment: 'Next lunch with friends',
      categoryId: byName.Entertainment.id,
      tags: { create: tagIds(['Leisure', 'One-off']).map(tagId => ({ tagId })) }
    }
  })
  const commute = await db.recurringRule.create({
    data: weekly('Transport', 25, 'Weekly commute', addDays(day, 3))
  })
  await db.occurrenceOverride.create({
    data: {
      ruleId: commute.id,
      date: commute.nextDate,
      kind: 'SKIP',
      processedAt: new Date()
    }
  })
  // A future skip belongs to this exact date; it is not processed history.
  await db.recurringRule.update({
    where: { id: commute.id },
    data: {
      nextDate: addDays(commute.nextDate, 7)
    }
  })
  await db.budget.createMany({
    data: buildBudgets(byName).map((b, index) => ({
      ...b,
      userId: user.id,
      clientId: 'seed-budget-' + index
    }))
  })
  const main = await db.account.create({
    data: { id: `main-${user.id}`, userId: user.id, name: 'Main', isMain: true }
  })
  const cash = await db.account.create({
    data: { id: `seed-cash-${user.id}`, userId: user.id, name: 'Cash', openingBalance: 15000 }
  })
  await db.transaction.updateMany({ where: { userId: user.id }, data: { accountId: main.id } })
  await db.recurringRule.updateMany({ where: { userId: user.id }, data: { accountId: main.id } })
  await db.transfer.create({
    data: {
      id: `seed-transfer-${user.id}`,
      userId: user.id,
      sourceId: main.id,
      destinationId: cash.id,
      amount: 5000,
      date: day,
      comment: 'Cash withdrawal'
    }
  })
  return {
    transactions: transactions.length,
    tags: tags.length,
    links: links.length,
    earned: transactions
      .filter(row => row.type === 'INCOME')
      .reduce((sum, row) => sum + row.amount, 0),
    spent: transactions
      .filter(row => row.type === 'EXPENSE')
      .reduce((sum, row) => sum + row.amount, 0)
  }
}

async function main() {
  if (FRESH && RESET) throw new Error('Use either --reset or --fresh, not both.')
  if (process.argv.slice(2).some(arg => !['--reset', '--fresh'].includes(arg)))
    throw new Error('Usage: npm run db:seed -- [--reset | --fresh]')
  if (!Number.isInteger(CONFIG.months) || CONFIG.months < 1 || CONFIG.months > 120)
    throw new Error('SEED_MONTHS must be an integer between 1 and 120.')
  const day = calendarToday(CONFIG.timeZone)
  const startDate = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - CONFIG.months + 1, 1)
  )
  const client = createClient(databaseConfig({ mustExist: !FRESH }))
  let prisma
  try {
    if (FRESH) {
      console.log('Recreating all Porkex tables for disposable test data.')
      await recreateSchema(client)
    }
    prisma = new PrismaClient({ adapter: new PrismaLibSQL(client) })
    console.log(`Seeding ${CONFIG.email} with ${CONFIG.months} months of data (${CONFIG.timeZone})`)
    console.log(
      `  window: ${startDate.toISOString().slice(0, 10)} -> ${day.toISOString().slice(0, 10)}`
    )
    const password = bcrypt.hashSync(CONFIG.password, 10)
    const result = await prisma.$transaction(
      async db => {
        const existing = await db.user.findUnique({ where: { email: CONFIG.email } })
        if (existing && !RESET) return null
        const removed = existing ? await wipeUser(db, existing.id) : null
        const user = await db.user.create({
          data: {
            name: CONFIG.name,
            email: CONFIG.email,
            password,
            sessionVersion: 0,
            currency: CONFIG.currency
          }
        })
        return { removed, ...(await seedAccount(db, user, startDate, day)) }
      },
      { timeout: 60000, maxWait: 10000 }
    )
    if (!result) {
      console.log(`  skipped: ${CONFIG.email} already exists (use --reset to wipe and regenerate)`)
      return
    }
    if (result.removed) console.log('  removed previous account data:', result.removed)
    console.log(
      `  ${result.transactions} transactions, ${result.tags} tags, ${result.links} tag links`
    )
    console.log('  4 recurring rules: salary, rent, next-only lunch edit and skipped commute')
    console.log('  5 budgets (3 monthly, 2 weekly)')
    console.log(`  balance ${((result.earned - result.spent) / 100).toFixed(2)} ${CONFIG.currency}`)
    console.log(`Log in as ${CONFIG.email} with the configured SEED_PASSWORD.`)
  } finally {
    await prisma?.$disconnect()
    client.close()
  }
}

module.exports = { calendarToday, nextAfterToday }
if (require.main === module)
  main().catch(error => {
    console.error(`Seed failed: ${safeError(error)}`)
    process.exitCode = 1
  })
