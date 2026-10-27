// Seeds a test account with 24 months of realistic activity, so every screen
// has something to show: the dashboard, the analytics ranges, the category
// catalogue order, the budget progress bars (both under and over the limit) and the
// transaction list with its filters and search, and the recurring screen with
// daily/weekly/monthly/yearly rules, tags and next-only exceptions.
//
//   npm run db:seed            # skips (exit 0) when the account already exists
//   npm run db:seed -- --reset # wipes that account's data first
//   npm run db:reset           # recreates ALL Porkex tables, then seeds
//   npm run db:seed -- --fresh # equivalent explicit development reset
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
// SEED_EMAIL is ever touched except when --fresh recreates every Porkex table.
const { PrismaClient } = require('@prisma/client')
const { createPrismaAdapter } = require('./lib/prisma-adapter')
const { randomUUID } = require('node:crypto')
const { loadEnvironment, databaseConfig, createClient, safeError } = require('./lib/database')
const { initializeDatabase, checkDatabaseSchema } = require('./lib/schema')
const bcrypt = require('bcryptjs')

loadEnvironment()

const RESET = process.argv.includes('--reset')
const FRESH = process.argv.includes('--fresh')

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
  { name: 'Salary', type: 'Income', color: '#34A853' },
  { name: 'Freelance', type: 'Income', color: '#4285F4' },
  { name: 'Sales', type: 'Income', color: '#A8C7FA' },
  { name: 'Food', type: 'Expense', color: '#EA4335' },
  { name: 'Transport', type: 'Expense', color: '#FBBC04' },
  { name: 'Entertainment', type: 'Expense', color: '#A142F4' },
  { name: 'Housing', type: 'Expense', color: '#5F6368' },
  { name: 'Shopping', type: 'Expense', color: '#E8710A' },
  { name: 'Others', type: 'Expense', color: '#78909C' }
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
  await prisma.favorite.deleteMany({ where: { userId } })
  const rules = await prisma.recurringRule.deleteMany({ where: { userId } })
  const budgets = await prisma.budget.deleteMany({ where: { userId } })
  const transactions = await prisma.transaction.deleteMany({ where: { userId } })
  const tags = await prisma.tag.deleteMany({ where: { userId } })
  const categories = await prisma.category.deleteMany({ where: { userId } })
  await prisma.transfer.deleteMany({ where: { userId } })
  await prisma.financialEdit.deleteMany({ where: { userId } })
  await prisma.balanceAdjustment.deleteMany({ where: { userId } })
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
        type: 'Expense',
        amount: 450 + offset * 25,
        description: 'Morning coffee'
      })
  }
  // Always have recent data, including both optional-comment cases and tags
  // at their five-selection limit, even when today is the first of the month.
  rows.push({
    date: day,
    categoryId: categoriesByName.Food.id,
    type: 'Expense',
    amount: 1876,
    description: ''
  })
  rows.push({
    date: day,
    categoryId: categoriesByName.Sales.id,
    type: 'Income',
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
    { name: 'Transport', period: 'WEEK', amount: 35 },
    { name: 'Food', period: 'YEAR', amount: 5000 },
    { name: 'Transport', period: 'YEAR', amount: 1800 }
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
      clientId: 'seed-category-' + index,
      position: index
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
    type: 'Expense',
    amount: toCents(amount),
    description,
    frequency: 'WEEK',
    interval: 1,
    startDate: date,
    nextDate: date
  })
  const lunch = await db.recurringRule.create({
    data: {
      ...weekly('Food', 35, 'Weekly lunch', addDays(day, 2)),
      tags: { create: tagIds(['Daily']).map(tagId => ({ tagId })) }
    }
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
  const main = await db.account.create({
    data: { id: `main-${user.id}`, userId: user.id, name: 'Main', isMain: true }
  })
  await db.budget.createMany({
    data: buildBudgets(byName).map((b, index) => ({
      ...b,
      userId: user.id,
      clientId: 'seed-budget-' + index,
      accountId: main.id
    }))
  })
  const goal = await db.account.create({
    data: {
      id: `seed-goal-${user.id}`,
      userId: user.id,
      name: 'Vacation',
      isGoal: true,
      targetAmount: 80000
    }
  })
  await db.transfer.create({
    data: {
      id: `seed-goal-transfer-${user.id}`,
      userId: user.id,
      sourceId: main.id,
      destinationId: goal.id,
      amount: 20000,
      date: day,
      comment: 'Vacation savings'
    }
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
  await db.favorite.create({
    data: {
      id: `seed-favorite-${user.id}`,
      userId: user.id,
      name: 'Lunch',
      type: 'Expense',
      amount: 1200,
      comment: 'Lunch',
      categoryId: byName.Food.id,
      accountId: main.id
    }
  })
  // Account states, corrections and multiple account filters.
  const savings = await db.account.create({
    data: {
      id: `seed-savings-${user.id}`,
      userId: user.id,
      name: 'Savings',
      openingBalance: 100000,
      excludeFromTotalBalance: true
    }
  })
  const archived = await db.account.create({
    data: {
      id: `seed-archived-${user.id}`,
      userId: user.id,
      name: 'Old Wallet',
      openingBalance: 5000,
      archived: true
    }
  })
  const laptop = await db.account.create({
    data: {
      id: `seed-laptop-${user.id}`,
      userId: user.id,
      name: 'New Laptop',
      isGoal: true,
      targetAmount: 60000
    }
  })
  await db.account.create({
    data: {
      id: `seed-emergency-${user.id}`,
      userId: user.id,
      name: 'Emergency Fund',
      isGoal: true,
      targetAmount: 200000
    }
  })
  await db.transfer.createMany({
    data: [
      {
        id: `seed-laptop-funds-${user.id}`,
        userId: user.id,
        sourceId: main.id,
        destinationId: laptop.id,
        amount: 60000,
        date: day,
        comment: 'Laptop goal completed'
      },
      {
        id: `seed-goal-withdrawal-${user.id}`,
        userId: user.id,
        sourceId: goal.id,
        destinationId: main.id,
        amount: 5000,
        date: day,
        comment: 'Travel booking refund'
      }
    ]
  })
  for (const account of [cash, savings, archived])
    await db.balanceAdjustment.create({
      data: {
        userId: user.id,
        id: `seed-opening-${account.id}`,
        accountId: account.id,
        accountName: account.name,
        kind: 'opening-balance',
        previousBalance: 0,
        balance: account.openingBalance,
        effectiveDate: startDate,
        createdAt: startDate
      }
    })
  await db.account.update({
    where: { id: cash.id },
    data: { openingBalance: cash.openingBalance + 5000 }
  })
  await db.balanceAdjustment.create({
    data: {
      userId: user.id,
      id: `seed-correction-${user.id}`,
      accountId: cash.id,
      accountName: cash.name,
      kind: 'balance-adjustment',
      previousBalance: 20000,
      balance: 25000,
      effectiveDate: day,
      createdAt: new Date()
    }
  })
  const examples = [
    {
      clientId: 'seed-cash-expense',
      accountId: cash.id,
      categoryId: byName.Food.id,
      type: 'Expense',
      amount: 1250,
      description: 'Lunch and groceries for the weekend with friends',
      date: day
    },
    {
      clientId: 'seed-cash-income',
      accountId: cash.id,
      categoryId: byName.Sales.id,
      type: 'Income',
      amount: 1500,
      description: 'Marketplace sale',
      date: day
    },
    {
      clientId: 'seed-archived-expense',
      accountId: archived.id,
      categoryId: byName.Transport.id,
      type: 'Expense',
      amount: 800,
      description: 'Last bus card top up',
      date: startDate
    }
  ]
  for (const [index, row] of examples.entries()) {
    const movement = await db.transaction.create({
      data: {
        ...row,
        userId: user.id,
        createdAt: row.date,
        editedAt: row.date,
        lastEditId: 'seed-example-' + index
      }
    })
    await db.transactionTag.create({
      data: {
        transactionId: movement.id,
        tagId: tagIds([row.type === 'Income' ? 'One-off' : 'Daily'])[0]
      }
    })
  }
  await db.budget.createMany({
    data: [
      { period: 'WEEK', amount: 3000 },
      { period: 'MONTH', amount: 12000 },
      { period: 'YEAR', amount: 100000 }
    ].map(row => ({
      ...row,
      userId: user.id,
      accountId: cash.id,
      categoryId: byName.Food.id,
      clientId: 'seed-cash-budget-' + row.period
    }))
  })
  await db.tagReference.create({
    data: { id: `seed-essential-alias-${user.id}`, tagId: tagIds(['Essential'])[0] }
  })
  await db.favorite.update({
    where: { id: `seed-favorite-${user.id}` },
    data: { tagIds: JSON.stringify(tagIds(['Daily', 'Essential'])) }
  })
  await db.favorite.create({
    data: {
      id: `seed-income-favorite-${user.id}`,
      userId: user.id,
      name: 'Marketplace sale',
      type: 'Income',
      amount: 1500,
      comment: '',
      categoryId: byName.Sales.id,
      accountId: cash.id,
      tagIds: JSON.stringify(tagIds(['One-off']))
    }
  })
  await db.recurringRule.update({ where: { id: lunch.id }, data: { accountId: cash.id } })
  await db.recurringRule.update({ where: { id: commute.id }, data: { active: false } })
  const annualDate = new Date(
    Date.UTC(
      day.getUTCFullYear() + (day >= new Date(Date.UTC(day.getUTCFullYear(), 0, 15)) ? 1 : 0),
      0,
      15
    )
  )
  await db.recurringRule.createMany({
    data: [
      {
        categoryId: byName.Food.id,
        accountId: cash.id,
        type: 'Expense',
        amount: 450,
        description: 'Daily coffee',
        frequency: 'DAY',
        startDate: addDays(day, 1),
        nextDate: addDays(day, 1),
        endDate: addDays(day, 30)
      },
      {
        categoryId: byName.Housing.id,
        accountId: main.id,
        type: 'Expense',
        amount: 24000,
        description: 'Annual insurance',
        frequency: 'YEAR',
        startDate: annualDate,
        nextDate: annualDate,
        endDate: null
      },
      {
        categoryId: byName.Sales.id,
        accountId: cash.id,
        type: 'Income',
        amount: 2500,
        description: 'Weekly market sales',
        frequency: 'WEEK',
        startDate: addDays(day, 4),
        nextDate: addDays(day, 4),
        endDate: null
      }
    ].map((row, index) => ({
      ...row,
      userId: user.id,
      interval: 1,
      active: true,
      clientId: 'seed-extra-rule-' + index
    }))
  })
  const activity = await db.transaction.groupBy({
    by: ['type'],
    where: { userId: user.id },
    _sum: { amount: true }
  })
  return {
    transactions: await db.transaction.count({ where: { userId: user.id } }),
    tags: tags.length,
    links: await db.transactionTag.count({ where: { transaction: { userId: user.id } } }),
    rules: await db.recurringRule.count({ where: { userId: user.id } }),
    budgets: await db.budget.count({ where: { userId: user.id } }),
    earned: activity.find(row => row.type === 'Income')?._sum.amount ?? 0,
    spent: activity.find(row => row.type === 'Expense')?._sum.amount ?? 0
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
      await initializeDatabase(client, { reset: true })
    }
    if (!FRESH) await checkDatabaseSchema(client)
    prisma = new PrismaClient({ adapter: createPrismaAdapter(client) })
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
    console.log(
      `  ${result.rules} rules: all frequencies, both types, paused and next-only edits/skips`
    )
    console.log(
      `  ${result.budgets} budgets across Main and Cash, with weekly/monthly/yearly cycles`
    )
    console.log(
      '  Main, Cash, excluded Savings, archived Old Wallet; empty, funded and completed goals'
    )
    console.log(
      '  Transfers, goal withdrawals, balance corrections, tag aliases and income/expense favorites'
    )
    console.log(
      `  net activity ${((result.earned - result.spent) / 100).toFixed(2)} ${CONFIG.currency}`
    )
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
