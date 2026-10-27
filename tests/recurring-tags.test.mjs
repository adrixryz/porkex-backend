import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { withServer, createTestUser } from './helpers.mjs'

const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10)
await withServer('recurring-tags', async ctx => {
  const { user, income } = await createTestUser(ctx)
  const request = async (method, path, body, status = 200) => {
    const response = await ctx.call(method, `/api${path}`, body)
    assert.equal(response.status, status, JSON.stringify(response.data))
    return response.data
  }
  await request('POST', '/tags', { id: 'base-tag', name: 'Base' }, 201)
  await request('POST', '/tags', { id: 'base-alias', name: 'BASE' }, 201)
  const input = {
    type: 'Income',
    amount: 12,
    categoryId: income.id,
    frequency: 'DAY',
    interval: 1,
    startDate: day(1),
    tagIds: ['base-alias']
  }
  const base = await request('POST', '/recurring', input, 201)
  const override = await request('POST', '/recurring', input, 201)
  assert.deepEqual(
    base.tags.map(tag => tag.id),
    ['base-tag']
  )
  await request('POST', '/recurring', { ...input, tagIds: ['missing'] }, 400)
  const path = `/recurring/${override.id}/occurrences/${day(1)}`
  const edit = { kind: 'EDIT', amount: 12, categoryId: income.id, tagIds: [] }
  await request('PUT', path, edit)
  assert.deepEqual(
    (await request('GET', '/recurring')).find(rule => rule.id === override.id).nextException.tags,
    []
  )
  await request('PUT', path, { ...edit, tagIds: ['base-tag'] })
  assert.equal(
    (await request('GET', '/recurring')).find(rule => rule.id === override.id).nextException,
    null
  )
  await request('PUT', path, edit)
  const script = `require('ts-node/register/transpile-only'); const {runDueRules}=require('./src/lib/recurring'); runDueRules(${user.id},new Date('${day(1)}T12:00:00Z'),'UTC').then(()=>require('./src/lib/prisma').prisma.$disconnect()).catch(e=>{console.error(e);process.exitCode=1})`
  const child = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: `file:${ctx.dbFile.replace(/\\/g, '/')}`,
      TURSO_AUTH_TOKEN: '',
      JWT_SECRET: 'test-secret'
    }
  })
  assert.equal(child.status, 0, child.stderr)
  const movements = (await request('GET', '/transactions')).items
  assert.deepEqual(
    movements.find(item => item.recurringId === base.id).tags.map(tag => tag.id),
    ['base-tag']
  )
  assert.deepEqual(movements.find(item => item.recurringId === override.id).tags, [])
  await request('PUT', `/recurring/${base.id}`, { ...input, tagIds: [] })
  assert.deepEqual(
    (await request('GET', '/transactions')).items
      .find(item => item.recurringId === base.id)
      .tags.map(tag => tag.id),
    ['base-tag']
  )
  await request('DELETE', '/tags/base-tag')
  assert.deepEqual(
    (await request('GET', '/transactions')).items.find(item => item.recurringId === base.id).tags,
    []
  )
  assert.deepEqual(
    (await request('GET', '/recurring')).find(item => item.id === override.id).tags,
    []
  )
  console.log(
    'PASS recurring tags: aliases, ownership validation, next-only edits, historical movements and deletion'
  )
})
