import { BUDGET_PERIODS } from './budgetPeriods'
import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { FinanceError } from './finance'
import { isValidCurrency } from './currencies'
import { catalogNameKey } from './catalogNames'

// Parent tables precede their dependants, including processed recurring exceptions.
export const BACKUP_TABLES = [
  'Account',
  'Category',
  'Tag',
  'TagReference',
  'RecurringRule',
  'OccurrenceOverride',
  'Transaction',
  'TransactionTag',
  'OccurrenceTag',
  'Budget',
  'Transfer',
  'Favorite',
  'BalanceAdjustment'
] as const
type Table = (typeof BACKUP_TABLES)[number]
type Scalar = string | number | boolean | null
type Row = Record<string, Scalar>
type Profile = {
  name: string
  currency: string
  defaultPeriod: string
  firstDayOfWeek: string
  decimalSeparator: string
}
export interface FullBackup {
  format: 'porkex-full-backup'
  version: 1
  moneyUnit: 'cents'
  profile: Profile
  tables: Record<Table, Row[]>
}
const profileSelect = {
  name: true,
  currency: true,
  defaultPeriod: true,
  firstDayOfWeek: true,
  decimalSeparator: true
} as const
const model = (table: Table) => Prisma.dmmf.datamodel.models.find(item => item.name === table)!
const fields = (table: Table) =>
  model(table).fields.filter(field => field.kind === 'scalar' && field.name !== 'userId')
// Prisma 7's runtime DMMF omits primary keys, nullability and unique indexes.
const primaryKey = (table: Table) =>
  table === 'TransactionTag'
    ? ['transactionId', 'tagId']
    : table === 'OccurrenceOverride'
      ? ['ruleId', 'date']
      : table === 'OccurrenceTag'
        ? ['ruleId', 'date', 'tagId']
        : ['id']
const nullable = new Set([
  'Account.targetAmount',
  'Category.clientId',
  'Category.color',
  'Budget.accountId',
  'Budget.clientId',
  'RecurringRule.accountId',
  'RecurringRule.endDate',
  'RecurringRule.lastProcessedDate',
  'RecurringRule.clientId',
  'Transaction.accountId',
  'Transaction.editedAt',
  'Transaction.lastEditId',
  'Transaction.clientId',
  'Transaction.recurringId',
  'OccurrenceOverride.amount',
  'OccurrenceOverride.comment',
  'OccurrenceOverride.categoryId',
  'OccurrenceOverride.processedAt'
])
const uniqueFields: Partial<Record<Table, string[][]>> = {
  Category: [['name'], ['clientId']],
  Budget: [['accountId', 'categoryId', 'period'], ['clientId']],
  RecurringRule: [['clientId']],
  Transaction: [['clientId'], ['recurringId', 'date']],
  Tag: [['normalizedName']]
}
const scope = (table: Table) => {
  if (table === 'TagReference') return '"tagId" IN (SELECT "id" FROM "Tag" WHERE "userId" = ?)'
  if (table === 'TransactionTag')
    return '"transactionId" IN (SELECT "id" FROM "Transaction" WHERE "userId" = ?)'
  if (table === 'OccurrenceOverride' || table === 'OccurrenceTag')
    return '"ruleId" IN (SELECT "id" FROM "RecurringRule" WHERE "userId" = ?)'
  return '"userId" = ?'
}
const invalid = (
  message = 'The full backup is invalid or incompatible. No data was changed.'
): never => {
  throw new FinanceError(message, 400)
}
export const backupHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const backupCounts = (backup: FullBackup) =>
  Object.fromEntries(BACKUP_TABLES.map(table => [table, backup.tables[table].length]))

export async function accountSnapshot(
  db: Prisma.TransactionClient,
  userId: number
): Promise<FullBackup> {
  const profile = await db.user.findUniqueOrThrow({ where: { id: userId }, select: profileSelect })
  const tables = {} as FullBackup['tables']
  for (const table of BACKUP_TABLES) {
    const columns = fields(table)
    const order = primaryKey(table)
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${columns.map(field => `"${field.name}"`).join(',')} FROM "${table}" WHERE ${scope(table)} ORDER BY ${order.map(name => `"${name}"`).join(',')}`,
      userId
    )
    tables[table] = rows.map(
      row =>
        Object.fromEntries(
          columns.map(field => {
            const value = row[field.name]
            return [
              field.name,
              value === null
                ? null
                : field.type === 'DateTime'
                  ? new Date(value as string).toISOString()
                  : field.type === 'Boolean'
                    ? Boolean(value)
                    : typeof value === 'bigint'
                      ? Number(value)
                      : value
            ]
          })
        ) as Row
    )
  }
  return { format: 'porkex-full-backup', version: 1, moneyUnit: 'cents', profile, tables }
}

export function validateFullBackup(value: unknown): FullBackup {
  if (!value || typeof value !== 'object') return invalid()
  const file = value as FullBackup
  if (
    file.format !== 'porkex-full-backup' ||
    file.version !== 1 ||
    file.moneyUnit !== 'cents' ||
    !file.profile ||
    !file.tables
  )
    return invalid()
  const p = file.profile
  if (
    typeof p.name !== 'string' ||
    !p.name.trim() ||
    p.name.length > 120 ||
    !isValidCurrency(p.currency) ||
    !['day', 'week', 'month', 'year'].includes(p.defaultPeriod) ||
    !['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].includes(
      p.firstDayOfWeek
    ) ||
    !['.', ','].includes(p.decimalSeparator)
  )
    return invalid()
  const tables = {} as FullBackup['tables']
  for (const table of BACKUP_TABLES) {
    const rows = file.tables[table]
    if (!Array.isArray(rows)) return invalid()
    const columns = fields(table)
    const keys = new Set<string>()
    tables[table] = rows.map(row => {
      // Older version 1 files predate the account exclusion preference.
      if (
        table === 'Account' &&
        row &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        !Object.hasOwn(row, 'excludeFromTotalBalance')
      )
        row = { ...row, excludeFromTotalBalance: false }
      if (
        table === 'Category' &&
        row &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        !Object.hasOwn(row, 'position')
      )
        row = { ...row, position: 0 }
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        Object.keys(row).length !== columns.length
      )
        return invalid()
      for (const field of columns) {
        const item = row[field.name]
        if (item === null && nullable.has(`${table}.${field.name}`)) continue
        if (
          field.type === 'Int' &&
          (typeof item !== 'number' ||
            !Number.isSafeInteger(item) ||
            item < -2147483648 ||
            item > 2147483647)
        )
          return invalid()
        if (field.type === 'String' && typeof item !== 'string') return invalid()
        if (field.type === 'Boolean' && typeof item !== 'boolean') return invalid()
        if (
          field.type === 'DateTime' &&
          (typeof item !== 'string' ||
            !/^\d{4}-\d{2}-\d{2}T/.test(item) ||
            !Number.isFinite(Date.parse(item)))
        )
          return invalid()
      }
      if (Object.keys(row).some(key => !columns.some(field => field.name === key))) return invalid()
      const primary = primaryKey(table)
      const key = JSON.stringify(primary.map(name => row[name]))
      if (keys.has(key))
        return invalid('The backup contains duplicate records. No data was changed.')
      keys.add(key)
      return { ...row }
    })
  }
  const lookups = new Map(
    BACKUP_TABLES.map(table => [table, new Set(tables[table].map(row => row.id))])
  )
  const lookup = (table: Table) => lookups.get(table)!
  for (const table of BACKUP_TABLES) {
    for (const unique of uniqueFields[table] ?? []) {
      const columns = unique.filter(name => name !== 'userId')
      const seen = new Set<string>()
      for (const row of tables[table]) {
        if (columns.some(name => row[name] === null)) continue
        const key = JSON.stringify(columns.map(name => row[name]))
        if (seen.has(key))
          return invalid('The backup contains duplicate catalogue entries. No data was changed.')
        seen.add(key)
      }
    }
  }
  for (const table of ['Account', 'Category', 'Tag', 'Favorite'] as const) {
    const names = tables[table].map(row => catalogNameKey(String(row.name)))
    if (new Set(names).size !== names.length)
      return invalid(`${table} names in the backup must be unique.`)
  }
  if (tables.Tag.some(row => row.normalizedName !== catalogNameKey(String(row.name))))
    return invalid('Tag names in the backup do not match their canonical keys.')
  const references: [Table, string, Table][] = [
    ['TagReference', 'tagId', 'Tag'],
    ['RecurringRule', 'accountId', 'Account'],
    ['RecurringRule', 'categoryId', 'Category'],
    ['OccurrenceOverride', 'ruleId', 'RecurringRule'],
    ['OccurrenceOverride', 'categoryId', 'Category'],
    ['Transaction', 'accountId', 'Account'],
    ['Transaction', 'categoryId', 'Category'],
    ['Transaction', 'recurringId', 'RecurringRule'],
    ['TransactionTag', 'transactionId', 'Transaction'],
    ['TransactionTag', 'tagId', 'Tag'],
    ['OccurrenceTag', 'ruleId', 'RecurringRule'],
    ['OccurrenceTag', 'tagId', 'Tag'],
    ['Budget', 'accountId', 'Account'],
    ['Budget', 'categoryId', 'Category'],
    ['Transfer', 'sourceId', 'Account'],
    ['Transfer', 'destinationId', 'Account'],
    ['Favorite', 'accountId', 'Account'],
    ['Favorite', 'categoryId', 'Category']
  ]
  for (const [table, field, parent] of references)
    for (const row of tables[table])
      if (row[field] !== null && !lookup(parent).has(row[field]))
        return invalid('The backup contains broken references. No data was changed.')
  const occurrences = new Set(tables.OccurrenceOverride.map(row => `${row.ruleId}:${row.date}`))
  for (const row of tables.OccurrenceTag)
    if (!occurrences.has(`${row.ruleId}:${row.date}`)) return invalid()
  const main = tables.Account.filter(row => row.isMain)
  if (main.length !== 1 || main[0].isGoal || main[0].archived || main[0].name !== 'Main')
    return invalid()
  for (const row of tables.Account)
    if (row.isGoal && (typeof row.targetAmount !== 'number' || row.targetAmount <= 0))
      return invalid()
  for (const table of ['Category', 'RecurringRule', 'Transaction', 'Favorite'] as const)
    for (const row of tables[table])
      if (!['Income', 'Expense'].includes(String(row.type))) return invalid()
  for (const table of ['RecurringRule', 'Transaction', 'Transfer', 'Favorite', 'Budget'] as const)
    for (const row of tables[table])
      if (typeof row.amount !== 'number' || row.amount <= 0) return invalid()
  for (const row of tables.RecurringRule)
    if (
      !['DAY', 'WEEK', 'MONTH', 'YEAR'].includes(String(row.frequency)) ||
      Number(row.interval) < 1 ||
      Number(row.interval) > 24
    )
      return invalid()
  for (const row of tables.Budget)
    if (!BUDGET_PERIODS.some(period => period === row.period)) return invalid()
  for (const row of tables.OccurrenceOverride)
    if (!['SKIP', 'EDIT'].includes(String(row.kind))) return invalid()
  for (const row of tables.Favorite) {
    let tags: unknown
    try {
      tags = JSON.parse(String(row.tagIds))
    } catch {
      return invalid()
    }
    if (!Array.isArray(tags) || tags.some(tag => !lookup('Tag').has(tag))) return invalid()
  }
  // Credentials, user IDs and operational receipts never come from the file.
  return {
    format: file.format,
    version: 1,
    moneyUnit: 'cents',
    profile: {
      name: p.name,
      currency: p.currency,
      defaultPeriod: p.defaultPeriod,
      firstDayOfWeek: p.firstDayOfWeek,
      decimalSeparator: p.decimalSeparator
    },
    tables
  }
}

export async function replaceAccountData(
  db: Prisma.TransactionClient,
  userId: number,
  backup: FullBackup
) {
  const maps = new Map<Table, Map<Scalar, Scalar>>()
  for (const table of BACKUP_TABLES) {
    if (!fields(table).some(field => field.name === 'id')) continue
    const ids = new Map<Scalar, Scalar>()
    const numeric = fields(table).find(field => field.name === 'id')?.type === 'Int'
    let nextId = 0
    if (numeric) {
      const max = await db.$queryRawUnsafe<{ maximum: number | bigint | null }[]>(
        `SELECT MAX("id") AS maximum FROM "${table}"`
      )
      nextId = Number(max[0].maximum ?? 0)
    }
    for (const row of backup.tables[table])
      ids.set(
        row.id,
        numeric
          ? ++nextId
          : table === 'Account' && row.isMain
            ? `main-${userId}`
            : table === 'BalanceAdjustment'
              ? `account:edit:${randomUUID()}`
              : randomUUID()
      )
    maps.set(table, ids)
  }
  for (const table of [...BACKUP_TABLES].reverse())
    await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${scope(table)}`, userId)
  await db.financialEdit.deleteMany({ where: { userId } })
  await db.financialReceipt.deleteMany({
    where: { userId, NOT: { key: { startsWith: 'backup:restore:' } } }
  })
  const historicalAccounts = new Map<Scalar, string>()
  const referenceMap: Record<string, Table> = {
    accountId: 'Account',
    sourceId: 'Account',
    destinationId: 'Account',
    categoryId: 'Category',
    tagId: 'Tag',
    recurringId: 'RecurringRule',
    ruleId: 'RecurringRule',
    transactionId: 'Transaction'
  }
  for (const table of BACKUP_TABLES) {
    const columns = fields(table).map(field => field.name)
    if (model(table).fields.some(field => field.name === 'userId')) columns.push('userId')
    const rows = backup.tables[table].map(original => {
      const row = { ...original, userId } as Row
      if (maps.has(table)) row.id = maps.get(table)!.get(row.id)!
      for (const [field, parent] of Object.entries(referenceMap)) {
        if (row[field] !== undefined && row[field] !== null) {
          const mapped = maps.get(parent)?.get(row[field])
          // Historical adjustments can refer to an already deleted account.
          if (mapped !== undefined) row[field] = mapped
          else if (table === 'BalanceAdjustment') {
            if (!historicalAccounts.has(row[field]))
              historicalAccounts.set(row[field], `history-${randomUUID()}`)
            row[field] = historicalAccounts.get(row[field])!
          }
        }
      }
      if (table === 'Favorite')
        row.tagIds = JSON.stringify(
          JSON.parse(String(row.tagIds)).map((id: string) => maps.get('Tag')!.get(id))
        )
      return row
    })
    for (let offset = 0; offset < rows.length; offset += 40) {
      const batch = rows.slice(offset, offset + 40)
      const values = batch.flatMap(row =>
        columns.map(column => {
          const value = row[column]
          const field = fields(table).find(item => item.name === column)
          return field?.type === 'DateTime' && typeof value === 'string'
            ? new Date(value).toISOString().replace('.000Z', '+00:00').replace('Z', '+00:00')
            : typeof value === 'boolean'
              ? Number(value)
              : value
        })
      )
      await db.$executeRawUnsafe(
        `INSERT INTO "${table}" (${columns.map(name => `"${name}"`).join(',')}) VALUES ${batch.map(() => `(${columns.map(() => '?').join(',')})`).join(',')}`,
        ...values
      )
    }
  }
  const restoredAt = new Date()
  await db.financialEdit.createMany({
    data: [
      { userId, key: 'categories:order', editedAt: restoredAt, mutationId: randomUUID() },
      ...[...maps.get('Account')!.values()].map(id => ({
        userId,
        key: `account:${id}`,
        editedAt: restoredAt,
        mutationId: randomUUID()
      })),
      ...Object.keys(backup.profile).map(field => ({
        userId,
        key: `profile:${field}`,
        editedAt: restoredAt,
        mutationId: randomUUID()
      }))
    ]
  })
  return db.user.update({
    where: { id: userId },
    data: { ...backup.profile, sessionVersion: { increment: 1 } }
  })
}
