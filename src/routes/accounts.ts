import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import type { AuthRequest } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import {
  accountList,
  balance,
  totalBalance,
  financialWrite,
  FinanceError,
  requireFunds,
  captureFunds,
  assertAccountNameAvailable
} from '../lib/finance'
import { fromCents, toCents, toCentsNonNegative } from '../lib/money'
import { parseDay, todayInZone } from '../lib/dates'
import { acceptFinancialEdit } from '../lib/financialEdits'
import { accountHistory } from '../lib/accountHistory'
import { catalogName, catalogNameError } from '../lib/catalogNames'
import { invalidateRecurring } from '../lib/recurring'

export const accountsRouter = Router()

accountsRouter.get('/dashboard/summary', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!,
      accountId = req.query.accountId
    if (accountId !== undefined && !validId(accountId))
      throw new FinanceError('Invalid account ID.')
    const result = await prisma.$transaction(async db => {
      const account = accountId
        ? await db.account.findFirst({
            where: { id: String(accountId), userId, archived: false, isGoal: false }
          })
        : null
      if (accountId && !account) throw new FinanceError('Choose an active account.', 404)
      const where = {
        userId,
        ...(account
          ? account.isMain
            ? { OR: [{ accountId: account.id }, { accountId: null }] }
            : { accountId: account.id }
          : {})
      }
      const [income, expense, count] = await Promise.all([
        db.transaction.aggregate({ where: { ...where, type: 'Income' }, _sum: { amount: true } }),
        db.transaction.aggregate({ where: { ...where, type: 'Expense' }, _sum: { amount: true } }),
        db.transaction.count({ where })
      ])
      const totalIncome = income._sum.amount || 0,
        totalExpense = expense._sum.amount || 0
      const funds = account ? await balance(userId, account.id, db) : await totalBalance(userId, db)
      return {
        globalBalance: fromCents(funds),
        totalIncome: fromCents(totalIncome),
        totalExpense: fromCents(totalExpense),
        transactionCount: count
      }
    })
    res.json(result)
  } catch (e) {
    failure(res, e)
  }
})
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
const failure = (res: import('express').Response, error: unknown) => {
  if (!(error instanceof FinanceError)) console.error('Financial operation failed.', error)
  return res.status(error instanceof FinanceError ? error.status : 500).json({
    error: error instanceof FinanceError ? error.message : 'Could not save the financial operation.'
  })
}

accountsRouter.get('/accounts', async (req: AuthRequest, res) => {
  try {
    res.json(
      (await accountList(req.userId!)).filter(a => req.query.includeGoals === 'true' || !a.isGoal)
    )
  } catch (e) {
    failure(res, e)
  }
})
accountsRouter.post('/accounts', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!,
      body = req.body ?? {},
      id = body.id ?? body.clientId ?? randomUUID()
    if (!validId(id)) throw new FinanceError('Invalid account ID.')
    if (
      body.excludeFromTotalBalance !== undefined &&
      typeof body.excludeFromTotalBalance !== 'boolean'
    )
      throw new FinanceError('Choose a valid total balance setting.')
    const result = await financialWrite(userId, `account:create:${id}`, async db => {
      const name = catalogName(body.name, 60),
        openingBalance = toCentsNonNegative(body.openingBalance ?? 0)
      if (!name)
        throw new FinanceError(`Account name must contain 1–60 characters. ${catalogNameError}`)
      if (openingBalance === null) throw new FinanceError('Enter a nonnegative opening balance.')
      await assertAccountNameAvailable(userId, name, db)
      const row = await db.account.create({
        data: {
          id,
          name,
          openingBalance,
          userId,
          excludeFromTotalBalance: body.excludeFromTotalBalance ?? false
        }
      })
      if (openingBalance > 0)
        await db.balanceAdjustment.create({
          data: {
            userId,
            id: `account:create:${id}`,
            accountId: id,
            accountName: name,
            kind: 'opening-balance',
            previousBalance: 0,
            balance: openingBalance,
            effectiveDate: res.locals.today,
            createdAt: new Date()
          }
        })
      return {
        ...row,
        openingBalance: fromCents(openingBalance),
        balance: fromCents(openingBalance),
        ...(openingBalance > 0
          ? {
              balanceAdjustment: {
                kind: 'opening-balance',
                accountId: id,
                accountName: name,
                previousBalance: 0,
                balance: fromCents(openingBalance),
                date: new Date().toISOString()
              }
            }
          : {})
      }
    })
    invalidateRecurring(userId)
    res.status(201).json(result)
  } catch (e) {
    failure(res, e)
  }
})
accountsRouter.put('/accounts/:id', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!,
      id = String(req.params.id),
      body = req.body ?? {}
    if (
      body.excludeFromTotalBalance !== undefined &&
      typeof body.excludeFromTotalBalance !== 'boolean'
    )
      throw new FinanceError('Choose a valid total balance setting.')
    const result = await financialWrite(
      userId,
      `account:edit:${validId(body.mutationId) ? body.mutationId : randomUUID()}`,
      async db => {
        const row = await db.account.findFirst({ where: { id, userId } })
        if (!row || row.isGoal) throw new FinanceError('Account not found.', 404)
        const editedAt = await acceptFinancialEdit(db, userId, `account:${id}`, body)
        const name = catalogName(body.name ?? row.name, 60)
        if (!name)
          throw new FinanceError(`Account name must contain 1–60 characters. ${catalogNameError}`)
        await assertAccountNameAvailable(userId, name, db, id)
        const previousBalance = await balance(userId, id, db)
        let openingBalance = row.openingBalance
        if (body.balance !== undefined) {
          const desiredBalance = toCentsNonNegative(body.balance)
          if (desiredBalance === null || body.openingBalance !== undefined)
            throw new FinanceError('Enter a valid current balance with up to two decimals.')
          openingBalance += desiredBalance - previousBalance
        } else if (body.openingBalance !== undefined) {
          const parsed = toCentsNonNegative(body.openingBalance)
          if (parsed === null) throw new FinanceError('Enter a valid opening balance.')
          openingBalance = parsed
        }
        // Balance corrections can require a negative baseline, but never negative funds.
        if (!Number.isSafeInteger(openingBalance) || Math.abs(openingBalance) > 2_147_483_647)
          throw new FinanceError('This balance adjustment exceeds the supported range.')
        if (!name || openingBalance === null || (row.isMain && (name !== 'Main' || body.archived)))
          throw new FinanceError('Main must remain available. Enter valid account details.')
        await db.account.update({
          where: { id },
          data: {
            name,
            openingBalance,
            excludeFromTotalBalance: body.excludeFromTotalBalance ?? row.excludeFromTotalBalance,
            archived: typeof body.archived === 'boolean' ? body.archived : row.archived
          }
        })
        if (
          (typeof body.archived === 'boolean' ? body.archived : row.archived) &&
          ((await balance(userId, id, db)) !== 0 ||
            (await db.recurringRule.count({ where: { userId, accountId: id, active: true } })))
        )
          throw new FinanceError(
            'Empty the account and pause its recurring rules before archiving.',
            409
          )
        await requireFunds(userId, [id], db, new Map([[id, previousBalance]]))
        const currentBalance = await balance(userId, id, db)
        if (currentBalance !== previousBalance)
          await db.balanceAdjustment.create({
            data: {
              userId,
              id: `account:edit:${body.mutationId}`,
              accountId: id,
              accountName: name!,
              kind: 'balance-adjustment',
              previousBalance,
              balance: currentBalance,
              effectiveDate: todayInZone(res.locals.timeZone, editedAt),
              createdAt: editedAt
            }
          })
        return {
          success: true,
          ...(currentBalance !== previousBalance
            ? {
                balanceAdjustment: {
                  accountId: id,
                  accountName: name,
                  previousBalance: fromCents(previousBalance),
                  balance: fromCents(currentBalance),
                  date: new Date().toISOString()
                }
              }
            : {})
        }
      }
    )
    invalidateRecurring(userId)
    res.json(result)
  } catch (e) {
    failure(res, e)
  }
})
accountsRouter.delete('/accounts/:id', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!
    const id = String(req.params.id)
    if (!validId(id)) throw new FinanceError('Invalid account ID.')
    const result = await financialWrite(userId, `account:delete:${id}`, async db => {
      const row = await db.account.findFirst({ where: { id, userId, isGoal: false } })
      if (!row) throw new FinanceError('Account not found.', 404)
      if (row.isMain) throw new FinanceError('Main must remain available.')
      if (!row.archived || (await balance(userId, id, db)) !== 0)
        throw new FinanceError('Archive the account with a zero balance before deleting it.', 409)
      const references = await Promise.all([
        db.transaction.count({ where: { userId, accountId: id } }),
        db.transfer.count({ where: { userId, OR: [{ sourceId: id }, { destinationId: id }] } }),
        db.budget.count({ where: { userId, accountId: id } }),
        db.recurringRule.count({ where: { userId, accountId: id } }),
        db.favorite.count({ where: { userId, accountId: id } })
      ])
      if (references.some(count => count > 0))
        throw new FinanceError(
          'This account still has financial history or linked records. Keep it archived to preserve them.',
          409
        )
      await db.account.delete({ where: { id } })
      return { success: true }
    })
    invalidateRecurring(userId)
    res.json(result)
  } catch (e) {
    failure(res, e)
  }
})
accountsRouter.get('/accounts/balance-adjustments', async (req: AuthRequest, res) => {
  try {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined
    res.json(
      await prisma.$transaction(db =>
        accountHistory(db, req.userId!, accountId, req.query.page, false)
      )
    )
  } catch (e) {
    failure(res, e)
  }
})
for (const method of ['put', 'delete'] as const)
  accountsRouter[method]('/accounts/balance-adjustments/:id', async (req: AuthRequest, res) => {
    try {
      const userId = req.userId!
      const id = String(req.params.id)
      const body = req.body ?? {}
      if (
        !/^account:(create|edit):[A-Za-z0-9_-]{1,64}$/.test(id) ||
        (method === 'put' && !validId(body.mutationId))
      )
        throw new FinanceError('A valid adjustment and stable operation ID are required.')
      const result = await financialWrite(
        userId,
        `adjustment:${method}:${method === 'put' ? body.mutationId : id}`,
        async db => {
          const entry = await db.balanceAdjustment.findUnique({
            where: { userId_id: { userId, id } }
          })
          if (!entry) throw new FinanceError('Balance adjustment not found.', 404)
          if (method === 'put') await acceptFinancialEdit(db, userId, `adjustment:${id}`, body)
          const account = await db.account.findFirst({
            where: { userId, id: entry.accountId, isGoal: false }
          })
          if (method === 'put' && !account)
            throw new FinanceError('The account no longer exists.', 404)
          const desired = method === 'put' ? toCentsNonNegative(body.balance) : null
          if (method === 'put' && desired === null)
            throw new FinanceError('Enter a valid nonnegative balance.')
          const oldBalance = entry.balance
          const previousBalance = entry.previousBalance
          const delta = method === 'put' ? desired! - oldBalance : previousBalance - oldBalance
          if (account) {
            const previousFunds = await captureFunds(userId, [account.id], db)
            const openingBalance = account.openingBalance + delta
            if (!Number.isSafeInteger(openingBalance) || Math.abs(openingBalance) > 2_147_483_647)
              throw new FinanceError('This adjustment exceeds the supported range.')
            await db.account.update({ where: { id: account.id }, data: { openingBalance } })
            await requireFunds(userId, [account.id], db, previousFunds)
          }
          if (method === 'delete')
            await db.balanceAdjustment.delete({ where: { userId_id: { userId, id } } })
          else
            await db.balanceAdjustment.update({
              where: { userId_id: { userId, id } },
              data: { balance: desired! }
            })
          return { success: true }
        }
      )
      invalidateRecurring(userId)
      res.json(result)
    } catch (e) {
      failure(res, e)
    }
  })
accountsRouter.get('/accounts/movements', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined
    res.json(
      await prisma.$transaction(db => accountHistory(db, userId, accountId, req.query.page, true))
    )
  } catch (e) {
    failure(res, e)
  }
})
accountsRouter.get('/transfers', async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!,
      accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined
    const where = {
      userId,
      ...(accountId ? { OR: [{ sourceId: accountId }, { destinationId: accountId }] } : {})
    }
    const perPage = 15,
      total = await prisma.transfer.count({ where }),
      totalPages = Math.max(1, Math.ceil(total / perPage))
    const page = Math.min(totalPages, Math.max(1, Math.floor(Number(req.query.page) || 1)))
    const rows = await prisma.transfer.findMany({
      where,
      include: { source: true, destination: true },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * perPage,
      take: perPage
    })
    res.json({
      items: rows.map(row => ({ ...row, amount: fromCents(row.amount) })),
      total,
      page,
      totalPages,
      perPage
    })
  } catch (e) {
    failure(res, e)
  }
})
for (const method of ['post', 'put', 'delete'] as const)
  accountsRouter[method](
    method === 'post' ? '/transfers' : '/transfers/:id',
    async (req: AuthRequest, res) => {
      try {
        const userId = req.userId!,
          body = req.body ?? {},
          id = method === 'post' ? (body.id ?? body.clientId) : String(req.params.id)
        if (!validId(id)) throw new FinanceError('Invalid transfer ID.')
        if (method === 'put' && !validId(body.mutationId))
          throw new FinanceError('A stable mutation ID is required.')
        const key = `transfer:${method}:${method === 'put' ? body.mutationId : id}`
        const result = await financialWrite(
          userId,
          key,
          async db => {
            const old = await db.transfer.findFirst({ where: { id, userId } })
            if (method !== 'post' && !old) throw new FinanceError('Transfer not found.', 404)
            if (method === 'put') await acceptFinancialEdit(db, userId, `transfer:${id}`, body)
            const affectedGoals = await db.account.findMany({
              where: {
                userId,
                isGoal: true,
                id: {
                  in: [old?.sourceId, old?.destinationId, body.sourceId, body.destinationId].filter(
                    (value): value is string => typeof value === 'string'
                  )
                }
              }
            })
            const previousFunds = new Map(
              await Promise.all(
                affectedGoals.map(
                  async goal => [goal.id, await balance(userId, goal.id, db)] as const
                )
              )
            )
            const checkGoalTargets = async () => {
              for (const goal of affectedGoals) {
                const current = await balance(userId, goal.id, db)
                if (current > (goal.targetAmount ?? 0) && current > previousFunds.get(goal.id)!)
                  throw new FinanceError('This transfer would exceed the savings goal target.', 409)
              }
            }
            if (method === 'delete') {
              const before = await captureFunds(userId, [old!.sourceId, old!.destinationId], db)
              await db.transfer.delete({ where: { id } })
              await requireFunds(userId, [old!.sourceId, old!.destinationId], db, before)
              await checkGoalTargets()
              return { success: true }
            }
            const sourceId = String(body.sourceId ?? ''),
              destinationId = String(body.destinationId ?? ''),
              amount = toCents(body.amount),
              date = parseDay(body.date)
            if (
              sourceId === destinationId ||
              amount === null ||
              !date ||
              date > res.locals.today ||
              typeof body.comment !== 'string' ||
              body.comment.length > 200
            )
              throw new FinanceError(
                'Choose different accounts, a positive amount, a valid date and a comment of at most 200 characters.'
              )
            const accounts = await db.account.findMany({
              where: { userId, archived: false, id: { in: [sourceId, destinationId] } }
            })
            if (accounts.length === 2 && accounts.every(a => a.isGoal))
              throw new FinanceError('Transfer savings through a normal account.')
            if (accounts.length !== 2) throw new FinanceError('Choose two active accounts.')
            const data = {
              userId,
              sourceId,
              destinationId,
              amount,
              date,
              comment: body.comment.trim()
            }
            const before = await captureFunds(
              userId,
              [sourceId, destinationId, ...(old ? [old.sourceId, old.destinationId] : [])],
              db
            )
            const row =
              method === 'post'
                ? await db.transfer.create({ data: { id, ...data } })
                : await db.transfer.update({ where: { id }, data })
            await requireFunds(
              userId,
              [sourceId, destinationId, ...(old ? [old.sourceId, old.destinationId] : [])],
              db,
              before
            )
            await checkGoalTargets()
            return { ...row, amount: fromCents(row.amount) }
          },
          async (db, original) => {
            if (method === 'delete') return original
            const current = await db.transfer.findFirst({ where: { id, userId } })
            return current ? { ...current, amount: fromCents(current.amount) } : original
          }
        )
        invalidateRecurring(userId)
        res.status(method === 'post' ? 201 : 200).json(result)
      } catch (e) {
        failure(res, e)
      }
    }
  )

accountsRouter.get('/goals', async (req: AuthRequest, res) => {
  try {
    res.json((await accountList(req.userId!)).filter(a => a.isGoal && !a.archived))
  } catch (e) {
    failure(res, e)
  }
})
for (const method of ['post', 'put', 'delete'] as const)
  accountsRouter[method](
    method === 'post' ? '/goals' : '/goals/:id',
    async (req: AuthRequest, res) => {
      try {
        const userId = req.userId!,
          body = req.body ?? {},
          id = method === 'post' ? body.id : String(req.params.id)
        if (!validId(id) || (method === 'put' && !validId(body.mutationId)))
          throw new FinanceError('A stable operation ID is required.')
        const result = await financialWrite(
          userId,
          `goal:${method}:${method === 'put' ? body.mutationId : id}`,
          async db => {
            const old = await db.account.findFirst({ where: { id, userId, isGoal: true } })
            if (method !== 'post' && !old) throw new FinanceError('Goal not found.', 404)
            if (method === 'put') await acceptFinancialEdit(db, userId, `goal:${id}`, body)
            if (method === 'delete') {
              if ((await balance(userId, id, db)) !== 0)
                throw new FinanceError(
                  'Withdraw the remaining funds before removing the goal.',
                  409
                )
              await db.account.update({ where: { id }, data: { archived: true } })
              return { success: true }
            }
            if (old?.archived) throw new FinanceError('The goal is archived.', 409)
            const name = catalogName(body.name, 60),
              targetAmount = toCents(body.targetAmount)
            if (!name)
              throw new FinanceError(`Goal name must contain 1–60 characters. ${catalogNameError}`)
            if (targetAmount === null)
              throw new FinanceError(
                'Enter a goal name and positive target with up to two decimals.'
              )
            if (old && targetAmount < (await balance(userId, id, db)))
              throw new FinanceError(
                'The target cannot be lower than the amount already saved.',
                409
              )
            await assertAccountNameAvailable(userId, name, db, old?.id)
            const row =
              method === 'post'
                ? await db.account.create({
                    data: { id, userId, name, targetAmount, isGoal: true }
                  })
                : await db.account.update({ where: { id }, data: { name, targetAmount } })
            return {
              ...row,
              targetAmount: fromCents(targetAmount),
              openingBalance: 0,
              balance: fromCents(await balance(userId, id, db))
            }
          }
        )
        res.status(method === 'post' ? 201 : 200).json(result)
      } catch (e) {
        failure(res, e)
      }
    }
  )
