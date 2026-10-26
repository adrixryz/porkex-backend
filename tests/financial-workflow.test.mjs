import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withServer, createTestUser } from './helpers.mjs'
import schemaApi from '../scripts/lib/schema.js'

const output = mkdtempSync(join(tmpdir(), 'porkex-financial-backup-'))
try {
  await withServer('financial-workflow', async ctx => {
    const { expense } = await createTestUser(ctx)
    const request = async (method, path, body, status = 200) => {
      const result = await ctx.call(method, '/api' + path, body)
      assert.equal(result.status, status, JSON.stringify(result.data))
      return result.data
    }
    await request('POST', '/tags', { id: 'workflow-tag', name: 'Personal' }, 201)
    await request('POST', '/tags', { id: 'workflow-alias', name: 'PERSONAL' }, 201)
    const row = await request(
      'POST',
      '/transactions',
      {
        clientId: 'workflow-movement',
        categoryId: expense.id,
        amount: '12.34',
        type: 'Expense',
        tagIds: ['workflow-alias']
      },
      201
    )
    assert.equal(row.comment, '')
    const rule = await request(
      'POST',
      '/recurring',
      {
        clientId: 'workflow-rule',
        type: 'Expense',
        categoryId: expense.id,
        amount: 10,
        frequency: 'MONTH',
        interval: 1,
        startDate: '2090-01-31'
      },
      201
    )
    await request('PUT', `/recurring/${rule.id}/occurrences/2090-01-31`, {
      kind: 'EDIT',
      amount: 40,
      comment: 'Once',
      categoryId: expense.id,
      tagIds: ['workflow-alias']
    })
    await request('PUT', '/tags/workflow-tag', { name: 'Renamed' })
    const overview = await request('GET', '/analytics/comparison?mode=year')
    assert.equal(overview.current.expense, 12.34)
    const backup = join(output, 'snapshot.db')
    const env = {
      ...process.env,
      DATABASE_URL: `file:${ctx.dbFile.replace(/\\/g, '/')}`,
      TURSO_AUTH_TOKEN: '',
      JWT_SECRET: 'test-secret'
    }
    for (const args of [
      ['scripts/backup-db.js', '--output', backup],
      ['scripts/verify-backup.js', backup]
    ]) {
      const child = spawnSync(process.execPath, args, { env, encoding: 'utf8' })
      assert.equal(child.status, 0, child.stderr)
    }
    const restored = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const {PrismaClient}=require('@prisma/client'); const {createPrismaAdapter}=require('./scripts/lib/prisma-adapter'); const {createClient}=require('@libsql/client');
      const db=new PrismaClient({adapter:createPrismaAdapter(createClient({url:process.env.DATABASE_URL}))});
      (async()=>{const row=await db.transaction.findFirst({include:{tags:{include:{tag:true}}}}); const next=await db.occurrenceOverride.findFirst({include:{tags:true}}); console.log(JSON.stringify({comment:row.description,amount:row.amount,tag:row.tags[0].tag.name,overrideAmount:next.amount,overrideTags:next.tags.length,aliases:await db.tagReference.count(),schema:await db.$queryRawUnsafe('SELECT fingerprint FROM _PorkexDevelopmentSchema WHERE id=1')},(_,v)=>typeof v==='bigint'?Number(v):v)); await db.$disconnect()})().catch(e=>{console.error(e);process.exitCode=1});
    `
      ],
      { env: { ...env, DATABASE_URL: `file:${backup.replace(/\\/g, '/')}` }, encoding: 'utf8' }
    )
    assert.equal(restored.status, 0, restored.stderr)
    const saved = JSON.parse(restored.stdout)
    assert.deepEqual(
      {
        comment: saved.comment,
        amount: saved.amount,
        tag: saved.tag,
        overrideAmount: saved.overrideAmount,
        overrideTags: saved.overrideTags,
        aliases: saved.aliases
      },
      {
        comment: '',
        amount: 1234,
        tag: 'Renamed',
        overrideAmount: 4000,
        overrideTags: 1,
        aliases: 2
      }
    )
    assert.equal(saved.schema[0].fingerprint, schemaApi.schemaFingerprint())
    await request('DELETE', '/tags/workflow-tag')
    assert.equal((await request('GET', '/recurring'))[0].nextException.tags.length, 0)
    assert.equal((await request('GET', '/transactions')).items.length, 1)
    console.log(
      'PASS financial workflow: optional comment, tag aliases, exception, comparison and complete recoverable SQLite backup'
    )
  })
} finally {
  rmSync(output, { recursive: true, force: true })
}
