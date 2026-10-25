import { createHash, randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from './prisma'
import { catalogName, catalogNameKey } from './catalogNames'
import { assertCategoryNamesAvailable } from './categories'
import { dayKey, isDayString, parseDay } from './dates'
import { FinanceError, balance, mainAccount } from './finance'
import { toCents, fromCents } from './money'
import { tagInclude } from './tags'

export const CSV_HEADER = ['Date', 'Type', 'Account', 'Category', 'Tags', 'Comment', 'Amount']
const BATCH_SIZE = 100
export const CSV_TRANSACTION_TIMEOUT_MS = 300000
async function eachBatch<T>(items: T[], save: (batch: T[]) => Promise<unknown>) {
  for (let index = 0; index < items.length; index += BATCH_SIZE)
    await save(items.slice(index, index + BATCH_SIZE))
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const keyOf = catalogNameKey

/** Strict semicolon CSV with doubled quotes, UTF-8 BOM and quoted multiline cells. */
export function parseCsv(value: unknown) {
  if (typeof value !== 'string') throw new FinanceError('Choose a UTF-8 CSV file.')
  const text = value.replace(/^\uFEFF/, '')
  const records: { line: number; cells: string[] }[] = []
  let cells: string[] = [],
    cell = '',
    quoted = false,
    closed = false,
    line = 1,
    start = 1
  const finishCell = () => {
    cells.push(cell)
    cell = ''
    closed = false
  }
  const finishRow = () => {
    finishCell()
    if (cells.length !== 1 || cells[0] !== '') records.push({ line: start, cells })
    cells = []
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
          closed = true
        }
      } else {
        cell += char
        if (char === '\n' || (char === '\r' && text[i + 1] !== '\n')) line++
      }
    } else if (char === ';') finishCell()
    else if (char === '\n' || char === '\r') {
      finishRow()
      if (char === '\r' && text[i + 1] === '\n') i++
      line++
      start = line
    } else if (char === '"' && cell === '' && !closed) quoted = true
    else {
      if (closed || char === '"') throw new FinanceError(`Invalid CSV quoting on line ${line}.`)
      cell += char
    }
  }
  if (quoted) throw new FinanceError(`Unclosed CSV quote on line ${start}.`)
  if (cell || cells.length || closed) finishRow()
  if (JSON.stringify(records.shift()?.cells) !== JSON.stringify(CSV_HEADER))
    throw new FinanceError(`The header must be ${CSV_HEADER.join(';')}.`)
  if (!records.length) throw new FinanceError('The CSV contains no movements.')
  return records
}

export function csvCell(value: string) {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export interface CsvRow {
  line: number
  date: string
  type: string
  account: string
  category: string
  tags: string[]
  comment: string
  amount: number
  errors: string[]
  duplicate: { existing: boolean; file: boolean }
  accountId: string | null
  categoryId: number | null
  importable: boolean
}

function signature(
  row: Pick<CsvRow, 'date' | 'type' | 'account' | 'category' | 'tags' | 'comment' | 'amount'>
) {
  return JSON.stringify([
    row.date,
    row.type,
    keyOf(row.account),
    keyOf(row.category),
    [...row.tags].map(keyOf).sort(),
    row.comment,
    row.amount
  ])
}

export async function previewCsv(
  userId: number,
  csv: unknown,
  today: Date,
  db: Prisma.TransactionClient = prisma
) {
  const records = parseCsv(csv)
  const [accounts, categories, tags] = await Promise.all([
    db.account.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    db.category.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    db.tag.findMany({ where: { userId }, orderBy: [{ position: 'asc' }, { id: 'asc' }] })
  ])
  const main = accounts.find(account => account.isMain)
  const accountNames = new Map<string, typeof accounts>()
  for (const account of accounts) {
    const key = keyOf(account.name)
    accountNames.set(key, [...(accountNames.get(key) ?? []), account])
  }
  const categoryNames = new Map(categories.map(category => [keyOf(category.name), category]))
  const tagNames = new Map(tags.map(tag => [tag.normalizedName, tag]))
  const proposedTypes = new Map<string, Set<string>>()
  const rows: CsvRow[] = records.map(record => {
    const [
      date = '',
      type = '',
      account = '',
      category = '',
      tagCell = '',
      comment = '',
      rawAmount = ''
    ] = record.cells.map(cell => cell.trim().normalize('NFC'))
    const rowTags = tagCell ? tagCell.split(',').map(tag => tag.trim()) : []
    const cents = toCents(rawAmount)
    const errors: string[] = []
    if (record.cells.length !== 7) errors.push('Expected seven columns.')
    if (!isDayString(date) || date > dayKey(today))
      errors.push('Date must be YYYY-MM-DD, on or before today.')
    if (type !== 'Income' && type !== 'Expense') errors.push('Type must be Income or Expense.')
    if (!catalogName(account, 60))
      errors.push('Account must contain 1–60 letters, numbers, spaces or hyphens.')
    if (!catalogName(category, 60))
      errors.push('Category must contain 1–60 letters, numbers, spaces or hyphens.')
    if (
      rowTags.length > 5 ||
      rowTags.some(tag => !catalogName(tag, 20)) ||
      new Set(rowTags.map(keyOf)).size !== rowTags.length
    )
      errors.push('Use at most five unique tags of 1–20 letters, numbers, spaces or hyphens.')
    if (comment.length > 200 || comment.includes('\0'))
      errors.push('Comment must contain at most 200 characters.')
    if (cents === null)
      errors.push(
        'Amount must be positive, at most 10,000,000, with up to two decimal places and a decimal point.'
      )
    const matches =
      keyOf(account) === 'main' ? (main ? [main] : []) : (accountNames.get(keyOf(account)) ?? [])
    if (matches.length > 1)
      errors.push('More than one account has this name. Rename the accounts before importing.')
    const match = matches.length === 1 ? matches[0] : undefined
    if (match?.isGoal) errors.push('Choose a regular account, not a savings goal.')
    const cat = categoryNames.get(keyOf(category))
    if (cat && cat.type !== type)
      errors.push(`Category "${cat.name}" already belongs to ${cat.type}.`)
    if (!cat && catalogName(category, 60)) {
      const types = proposedTypes.get(keyOf(category)) ?? new Set<string>()
      types.add(type)
      proposedTypes.set(keyOf(category), types)
    }
    return {
      line: record.line,
      date,
      type,
      account: match?.isMain ? 'Main' : (match?.name ?? account),
      category: cat?.name ?? category,
      tags: rowTags.map(tag => tagNames.get(keyOf(tag))?.name ?? tag),
      comment,
      amount: fromCents(cents),
      errors,
      duplicate: { existing: false, file: false },
      accountId: match?.id ?? (keyOf(account) === 'main' ? `main-${userId}` : null),
      categoryId: cat?.id ?? null,
      importable: !match?.archived && !match?.isGoal
    }
  })
  for (const row of rows)
    if ((proposedTypes.get(keyOf(row.category))?.size ?? 0) > 1)
      row.errors.push('The same new category cannot belong to both Income and Expense.')

  const dates = rows
    .filter(row => !row.errors.length)
    .map(row => row.date)
    .sort()
  const existing = dates.length
    ? await db.transaction.findMany({
        where: {
          userId,
          date: { gte: parseDay(dates[0])!, lte: parseDay(dates[dates.length - 1])! }
        },
        include: { category: true, account: true, ...tagInclude }
      })
    : []
  const saved = new Set(
    existing.map(tx =>
      signature({
        date: dayKey(tx.date),
        type: tx.type,
        account: tx.account?.isMain || !tx.account ? 'Main' : tx.account.name,
        category: tx.category.name,
        tags: tx.tags.map(link => link.tag.name),
        comment: tx.description.trim().normalize('NFC'),
        amount: fromCents(tx.amount)
      })
    )
  )
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.errors.length) continue
    const key = signature(row)
    row.duplicate = { existing: saved.has(key), file: seen.has(key) }
    seen.add(key)
    if (!row.importable && !row.duplicate.existing)
      row.errors.push('Restore the archived account before importing new transactions into it.')
  }
  const usedAccounts = new Map<string, { name: string; balance: number; isNew: boolean }>()
  for (const row of rows) {
    const key = keyOf(row.account)
    if (usedAccounts.has(key)) continue
    const account = accounts.find(item => item.id === row.accountId)
    usedAccounts.set(key, {
      name: row.account,
      balance: account ? fromCents(await balance(userId, account.id, db)) : 0,
      isNew: !account
    })
  }
  const result = {
    rows,
    accounts: [...usedAccounts.values()],
    newCategories: [
      ...new Map(
        rows
          .filter(row => row.categoryId === null)
          .map(row => [keyOf(row.category), { name: row.category, type: row.type }])
      ).values()
    ],
    newTags: [
      ...new Map(
        rows
          .flatMap(row => row.tags)
          .filter(tag => !tagNames.has(keyOf(tag)))
          .map(tag => [keyOf(tag), tag])
      ).values()
    ]
  }
  return { ...result, version: digest(JSON.stringify({ ...result, accounts, categories, tags })) }
}

export async function importCsv(userId: number, body: Record<string, unknown>, today: Date) {
  const { csv, importId, version, selectedLines } = body
  if (
    typeof importId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(importId) ||
    typeof version !== 'string'
  )
    throw new FinanceError('Preview the file before importing.')
  if (
    !Array.isArray(selectedLines) ||
    !selectedLines.length ||
    !selectedLines.every(line => Number.isSafeInteger(line) && line > 1) ||
    new Set(selectedLines).size !== selectedLines.length
  )
    throw new FinanceError('Select unique movement rows to import.')
  parseCsv(csv)
  const requestHash = digest(JSON.stringify([csv, [...selectedLines].sort((a, b) => a - b)]))
  return prisma.$transaction(
    async db => {
      const key = `csv:import:${importId}`
      const receipt = await db.financialReceipt.findUnique({
        where: { userId_key: { userId, key } }
      })
      if (receipt) {
        const original = JSON.parse(receipt.response)
        if (original.requestHash !== requestHash)
          throw new FinanceError(
            'This import was already confirmed with a different selection. Preview the file again.',
            409
          )
        return original
      }
      const preview = await previewCsv(userId, csv, today, db)
      if (preview.rows.some(row => row.errors.length))
        throw new FinanceError('Correct all CSV errors before importing.')
      if (preview.version !== version)
        throw new FinanceError(
          'Your data changed after the preview. Refresh the preview before importing.',
          409
        )
      const selected = new Set<number>(selectedLines)
      const rows = preview.rows
        .filter(row => selected.has(row.line))
        .sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line)
      if (rows.length !== selected.size)
        throw new FinanceError('The selection contains unknown CSV rows.')
      if (rows.some(row => !row.importable))
        throw new FinanceError(
          'Transactions in archived accounts are already saved. Restore the account before importing them again.'
        )
      const accounts = new Map<string, string>()
      const categories = new Map<string, number>()
      const existingTags = await db.tag.findMany({ where: { userId } })
      const tags = new Map(existingTags.map(tag => [tag.normalizedName, tag.id]))
      let position = existingTags.reduce((max, tag) => Math.max(max, tag.position), -1)
      const newAccounts: Prisma.AccountCreateManyInput[] = []
      const newCategories = new Map<string, Prisma.CategoryCreateManyInput>()
      const newTags: Prisma.TagCreateManyInput[] = []
      for (const row of rows) {
        const accountKey = keyOf(row.account)
        const categoryKey = keyOf(row.category)
        if (!accounts.has(accountKey)) {
          if (accountKey === 'main') accounts.set(accountKey, (await mainAccount(userId, db)).id)
          else if (row.accountId) accounts.set(accountKey, row.accountId)
          else {
            const id = randomUUID()
            accounts.set(accountKey, id)
            newAccounts.push({ id, userId, name: row.account, openingBalance: 0 })
          }
        }
        if (row.categoryId !== null) categories.set(categoryKey, row.categoryId)
        else if (!newCategories.has(categoryKey))
          newCategories.set(categoryKey, {
            userId,
            name: row.category,
            type: row.type,
            color: '#9E9E9E'
          })
        for (const name of row.tags) {
          const normalizedName = keyOf(name)
          if (tags.has(normalizedName)) continue
          const id = randomUUID()
          tags.set(normalizedName, id)
          newTags.push({ id, userId, name, normalizedName, position: ++position })
        }
      }
      await eachBatch(newAccounts, data => db.account.createMany({ data }))
      if (newCategories.size)
        await assertCategoryNamesAvailable(
          userId,
          [...newCategories.values()].map(category => category.name),
          db
        )
      await eachBatch([...newCategories.values()], async data => {
        await db.category.createMany({ data })
        const created = await db.category.findMany({
          where: { userId, name: { in: data.map(category => category.name) } },
          select: { id: true, name: true }
        })
        for (const category of created) categories.set(keyOf(category.name), category.id)
      })
      await eachBatch(newTags, async data => {
        await db.tag.createMany({ data })
        await db.tagReference.createMany({ data: data.map(tag => ({ id: tag.id, tagId: tag.id })) })
      })
      const editedAt = new Date()
      await eachBatch(rows, async batch => {
        const data = batch.map(row => ({
          userId,
          accountId: accounts.get(keyOf(row.account))!,
          categoryId: categories.get(keyOf(row.category))!,
          date: parseDay(row.date)!,
          type: row.type,
          amount: toCents(row.amount)!,
          description: row.comment,
          clientId: `csv-${importId}-${row.line}`,
          editedAt
        }))
        // Multi-row inserts preserve CSV order while avoiding one remote round trip per movement.
        await db.transaction.createMany({ data })
        if (!batch.some(row => row.tags.length)) return
        const inserted = await db.transaction.findMany({
          where: { userId, clientId: { in: data.map(row => row.clientId) } },
          select: { id: true, clientId: true }
        })
        const ids = new Map(inserted.map(row => [row.clientId, row.id]))
        const links = batch.flatMap(row =>
          row.tags.map(name => ({
            transactionId: ids.get(`csv-${importId}-${row.line}`)!,
            tagId: tags.get(keyOf(name))!
          }))
        )
        await eachBatch(links, data => db.transactionTag.createMany({ data }))
      })
      const result = {
        requestHash,
        imported: rows.length,
        createdAccounts: newAccounts.length,
        createdCategories: newCategories.size,
        createdTags: newTags.length
      }
      await db.financialReceipt.create({ data: { userId, key, response: JSON.stringify(result) } })
      return result
    },
    { maxWait: 120000, timeout: CSV_TRANSACTION_TIMEOUT_MS }
  )
}
