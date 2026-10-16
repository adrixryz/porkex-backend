// Seeds a test account with six months of realistic activity, so every screen
// has something to show: the dashboard, the analytics ranges, the category
// totals, the budget progress bars (both under and over the limit) and the
// transaction list with its filters and search.
//
//   npm run db:seed            # skips (exit 0) when the account already has data
//   npm run db:seed -- --reset # wipes that account's data first
//
// Configuration, all optional:
//   SEED_EMAIL     default seed@porkex.test
//   SEED_PASSWORD  default porkex123
//   SEED_NAME      default Porkex Tester
//   SEED_MONTHS    default 6
//   SEED_CURRENCY  default USD
//
// It writes to whatever DATABASE_URL points at, so running it locally fills
// prisma/dev.db and running it on Render fills Turso. Only the account named by
// SEED_EMAIL is ever touched.
const { PrismaClient } = require('@prisma/client')
const { PrismaLibSQL } = require('@prisma/adapter-libsql')
const { createClient } = require('@libsql/client')
const bcrypt = require('bcryptjs')

require('dotenv').config()

const RESET = process.argv.includes('--reset')

const CONFIG = {
  email: (process.env.SEED_EMAIL || 'seed@porkex.test').toLowerCase(),
  password: process.env.SEED_PASSWORD || 'porkex123',
  name: process.env.SEED_NAME || 'Porkex Tester',
  months: Number(process.env.SEED_MONTHS || 6),
  currency: process.env.SEED_CURRENCY || 'USD'
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
  { name: 'Shopping', type: 'EXPENSE', color: '#E8710A' }
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

const day = new Date()
day.setHours(12, 0, 0, 0)
const atNoon = d => {
  const copy = new Date(d)
  copy.setHours(12, 0, 0, 0)
  return copy
}

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

function createClient_() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')
  const authToken = process.env.TURSO_AUTH_TOKEN
  return authToken ? createClient({ url, authToken }) : createClient({ url })
}

async function wipeUser(prisma, userId) {
  // Sequential, and in dependency order: budgets and transactions both point at
  // categories, and everything points at the user. Running these concurrently
  // let them interleave, which made the reported counts wrong.
  const budgets = await prisma.budget.deleteMany({ where: { userId } })
  const transactions = await prisma.transaction.deleteMany({ where: { userId } })
  const categories = await prisma.category.deleteMany({ where: { userId } })
  const user = await prisma.user.deleteMany({ where: { id: userId } })

  if (transactions.count === 0 && categories.count === 0) {
    throw new Error(
      `Tried to reset ${CONFIG.email} but deleted nothing, while the account still exists. ` +
        `Something else is holding the data.`
    )
  }

  console.log(
    `  removed ${transactions.count} transactions, ${budgets.count} budgets, ` +
      `${categories.count} categories, ${user.count} user(s)`
  )
}

function buildTransactions(categoriesByName, startDate) {
  const rows = []

  for (let m = 0; m < CONFIG.months; m++) {
    const monthStart = new Date(startDate.getFullYear(), startDate.getMonth() + m, 1)
    // Never past today: the API rejects future dates and the analytics window
    // ends now anyway.
    const isCurrentMonth =
      monthStart.getMonth() === day.getMonth() && monthStart.getFullYear() === day.getFullYear()
    const lastDay = isCurrentMonth
      ? day.getDate()
      : new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate()

    const add = (dateOfMonth, name, amount, description) => {
      if (dateOfMonth > lastDay) return
      rows.push({
        date: atNoon(new Date(monthStart.getFullYear(), monthStart.getMonth(), dateOfMonth)),
        categoryId: categoriesByName[name].id,
        type: categoriesByName[name].type,
        amount: toCents(amount),
        description: description || pick(DESCRIPTIONS[name])
      })
    }

    // ── income: salary on the 1st, the odd freelance invoice ──
    add(1, 'Salary', 3200, 'Monthly salary')
    for (let i = 0; i < intBetween(1, 2); i++) {
      add(intBetween(3, 26), 'Freelance', between(180, 850))
    }
    if (random() > 0.75) add(intBetween(8, 24), 'Sales', between(20, 140))

    // ── fixed housing, on slightly different days each month ──
    add(3, 'Housing', 950, 'Rent')
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

  return rows.sort((a, b) => a.date - b.date)
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

async function main() {
  const adapter = new PrismaLibSQL(createClient_())
  const prisma = new PrismaClient({ adapter })

  const startDate = new Date(day.getFullYear(), day.getMonth() - (CONFIG.months - 1), 1)

  console.log(`Seeding ${CONFIG.email} with ${CONFIG.months} months of data`)
  console.log(
    `  window: ${startDate.toISOString().slice(0, 10)} -> ${day.toISOString().slice(0, 10)}`
  )

  const existing = await prisma.user.findUnique({ where: { email: CONFIG.email } })
  if (existing) {
    const count = await prisma.transaction.count({ where: { userId: existing.id } })
    if (count > 0 && !RESET) {
      // Skipping (rather than failing) keeps the Render build green: its build
      // command runs this on every deploy, and an account with data is the
      // normal state there, not an error. Nothing is ever wiped without --reset.
      console.log(
        `  skipped: ${CONFIG.email} already has ${count} transactions ` +
          `(use --reset to wipe and regenerate)`
      )
      await prisma.$disconnect()
      return
    }
    await wipeUser(prisma, existing.id)
  }

  const user = await prisma.user.create({
    data: {
      name: CONFIG.name,
      email: CONFIG.email,
      password: bcrypt.hashSync(CONFIG.password, 10),
      currency: CONFIG.currency
    }
  })
  console.log(`  user: ${user.email}`)

  await prisma.category.createMany({ data: CATEGORIES.map(c => ({ ...c, userId: user.id })) })
  const categories = await prisma.category.findMany({ where: { userId: user.id } })
  const byName = Object.fromEntries(categories.map(c => [c.name, c]))

  const transactions = buildTransactions(byName, startDate)
  // Chunked so the statement stays small on libSQL.
  const CHUNK = 200
  for (let i = 0; i < transactions.length; i += CHUNK) {
    await prisma.transaction.createMany({
      data: transactions.slice(i, i + CHUNK).map(t => ({ ...t, userId: user.id }))
    })
  }
  console.log(`  ${transactions.length} transactions`)

  await prisma.budget.createMany({
    data: buildBudgets(byName).map(b => ({ ...b, userId: user.id }))
  })
  console.log('  5 budgets (3 monthly, 2 weekly)')

  const spent = transactions.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + t.amount, 0)
  const earned = transactions.filter(t => t.type === 'INCOME').reduce((s, t) => s + t.amount, 0)
  console.log(`\n  balance  ${((earned - spent) / 100).toFixed(2)} ${CONFIG.currency}`)
  console.log(`  income   ${(earned / 100).toFixed(2)}`)
  console.log(`  expenses ${(spent / 100).toFixed(2)}`)
  console.log(`\nLog in with  ${CONFIG.email}  /  ${CONFIG.password}`)

  await prisma.$disconnect()
}

main().catch(err => {
  console.error(`\nSeed failed: ${err.message}`)
  process.exit(1)
})
