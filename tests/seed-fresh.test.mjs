import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import migrationsApi from '../scripts/lib/migrations.js'

const directory = mkdtempSync(join(tmpdir(), 'porkex-seed-fresh-'))
function run(args, env, expected = 0) {
  const child = spawnSync(process.execPath, args, { env, encoding: 'utf8' })
  assert.equal(child.status, expected, child.stdout + child.stderr)
  return child.stdout
}
try {
  for (const existing of [false, true]) {
    const env = {
      ...process.env,
      DATABASE_URL: `file:${join(directory, existing ? 'old.db' : 'new.db').replace(/\\/g, '/')}`,
      TURSO_AUTH_TOKEN: '',
      SEED_EMAIL: 'fresh@example.test',
      SEED_PASSWORD: 'secret123',
      SEED_MONTHS: '2',
      SEED_TIME_ZONE: 'America/Lima'
    }
    if (existing)
      run(
        [
          '-e',
          `
      const {createClient}=require('@libsql/client');
      const {loadMigrations,runMigrations}=require('./scripts/lib/migrations');
      const db=createClient({url:process.env.DATABASE_URL});
      (async()=>{
        await runMigrations(db,loadMigrations().slice(0,5));
        await db.execute('ALTER TABLE "User" DROP COLUMN "sessionVersion"');
        await db.execute("INSERT INTO User(name,email,password) VALUES ('Disposable','old@example.test','hash')");
      })().then(()=>db.close()).catch(e=>{console.error(e);process.exitCode=1});
    `
        ],
        env
      )
    const output = run(['scripts/seed.js', '--fresh'], env)
    assert.match(output, /Recreating all Porkex tables/)
    const inspect = () =>
      JSON.parse(
        run(
          [
            '-e',
            `
      const {createClient}=require('@libsql/client');
      const db=createClient({url:process.env.DATABASE_URL});
      (async()=>{
        const rows=await db.execute('SELECT COUNT(*) n FROM "Transaction"');
        const invalid=await db.execute('SELECT COUNT(*) n FROM "Transaction" WHERE editedAt IS NULL OR editedAt != createdAt OR lastEditId IS NULL');
        const cats=await db.execute('SELECT COUNT(*) n FROM Category WHERE clientId IS NOT NULL');
        const budgets=await db.execute('SELECT COUNT(*) n FROM Budget WHERE clientId IS NOT NULL');
        const users=await db.execute('SELECT email, sessionVersion FROM User ORDER BY email');
        const history=await db.execute('SELECT COUNT(*) n FROM _PorkexMigration');
        const foreign=await db.execute('PRAGMA foreign_key_check');
        console.log(JSON.stringify({rows:rows.rows[0].n,invalid:invalid.rows[0].n,cats:cats.rows[0].n,budgets:budgets.rows[0].n,users:users.rows,history:history.rows[0].n,foreign:foreign.rows.length}));
      })().then(()=>db.close()).catch(e=>{console.error(e);process.exitCode=1});
    `
          ],
          env
        )
      )
    const snapshot = inspect()
    assert(snapshot.rows > 20)
    assert.equal(snapshot.invalid, 0)
    assert.equal(snapshot.cats, 9)
    assert.equal(snapshot.budgets, 5)
    assert.deepEqual(snapshot.users, [{ email: 'fresh@example.test', sessionVersion: 0 }])
    assert.equal(snapshot.history, migrationsApi.loadMigrations().length)
    assert.equal(snapshot.foreign, 0)
    assert.match(run(['scripts/apply-schema.js'], env), /0 new/)
    run(['scripts/seed.js', '--fresh'], env)
    assert.deepEqual(inspect(), snapshot)
  }
  console.log(
    'PASS fresh seed: new and old databases, current schema, sync metadata, repeatable reset and maintenance compatibility'
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}
