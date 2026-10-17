import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = mkdtempSync(join(tmpdir(), 'porkex-backup-test-'))
const source = join(directory, 'source.db')
const target = join(directory, 'backup.db')
const url = `file:${source.replace(/\\/g, '/')}`
const env = { ...process.env, DATABASE_URL: url, TURSO_AUTH_TOKEN: '' }

function node(args, options = {}) {
  return spawnSync(process.execPath, args, { cwd: backend, env, encoding: 'utf8', ...options })
}

function checked(result) {
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return result.stdout
}

try {
  checked(
    node([
      '-e',
      `
    const {createClient}=require('@libsql/client');
    (async()=>{
      const c=createClient({url:process.env.DATABASE_URL,intMode:'bigint'});
      await c.executeMultiple(\`
        CREATE TABLE Parent(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
        CREATE TABLE Child(id INTEGER PRIMARY KEY, parentId INTEGER REFERENCES Parent(id), payload BLOB, amount BIGINT, stamp DATETIME, note TEXT);
        CREATE INDEX child_parent ON Child(parentId);
        CREATE VIEW Names AS SELECT name FROM Parent;
        CREATE TRIGGER child_note AFTER UPDATE ON Parent BEGIN UPDATE Child SET note=new.name WHERE parentId=new.id; END;
        INSERT INTO Parent(id,name) VALUES(1,'O''Brien 🐷'),(99,'removed');
        DELETE FROM Parent WHERE id=99;
      \`);
      await c.execute({sql:"INSERT INTO Child VALUES(?,?,?,?,?,CAST(X'610062' AS TEXT))",args:[1,1,Buffer.from([0,255,1]),9223372036854775806n,new Date('2026-10-17T03:25:26.123Z')]});
      c.close();
    })().catch(e=>{console.error(e);process.exitCode=1});
  `
    ])
  )
  checked(node(['scripts/backup-db.js', '--output', target]))
  const original = readFileSync(target)
  checked(node(['scripts/verify-backup.js', target]))
  const checkedRows = checked(
    node([
      '-e',
      `
    const assert=require('node:assert/strict');
    const {createClient}=require('@libsql/client');
    (async()=>{
      const c=createClient({url:'file:'+process.argv[1].replace(/\\\\/g,'/'),intMode:'bigint'});
      const row=(await c.execute('SELECT * FROM Child')).rows[0];
      assert.equal(row.amount,9223372036854775806n);
      assert.equal(row.stamp,BigInt(new Date('2026-10-17T03:25:26.123Z').getTime()));
      assert.equal(Buffer.from(row.payload).toString('hex'),'00ff01');
      assert.equal((await c.execute('SELECT hex(note) AS value FROM Child')).rows[0].value,'610062');
      assert.equal((await c.execute("SELECT seq FROM sqlite_sequence WHERE name='Parent'")).rows[0].seq,99n);
      assert.equal((await c.execute('SELECT name FROM Names')).rows[0].name,"O'Brien 🐷");
      await c.execute("UPDATE Parent SET name='changed' WHERE id=1");
      assert.equal((await c.execute('SELECT note FROM Child')).rows[0].note,'changed');
      await c.execute('PRAGMA foreign_keys=ON');
      await assert.rejects(c.execute('INSERT INTO Child(id,parentId) VALUES(2,500)'));
      c.close();console.log('types, sequence, schema and constraints preserved');
    })().catch(e=>{console.error(e);process.exitCode=1});
  `,
      target
    ])
  )
  assert.match(checkedRows, /preserved/)
  const replaced = node(['scripts/backup-db.js', '--output', target])
  assert.notEqual(replaced.status, 0)
  assert.match(replaced.stderr, /already exists/)
  // The attempted overwrite did not change our edited restored copy.
  assert.notDeepEqual(readFileSync(target), original)
  const unchanged = readFileSync(target)
  node(['scripts/backup-db.js', '--output', target])
  assert.deepEqual(readFileSync(target), unchanged)
  const missing = node(['scripts/backup-db.js', '--output', join(directory, 'missing.db')], {
    env: {
      ...env,
      DATABASE_URL: `file:${join(directory, 'does-not-exist.db').replace(/\\/g, '/')}`
    }
  })
  assert.notEqual(missing.status, 0)
  assert.equal(
    readdirSync(directory).some(name => name.includes('.partial')),
    false
  )
  assert.equal(readdirSync(directory).includes('missing.db'), false)
  const unset = node(['scripts/backup-db.js'], { env: { ...env, DATABASE_URL: '' } })
  assert.notEqual(unset.status, 0)
  assert.match(unset.stderr, /DATABASE_URL/)
  const corrupt = join(directory, 'corrupt.db')
  writeFileSync(corrupt, 'invalid sqlite')
  assert.notEqual(node(['scripts/verify-backup.js', corrupt]).status, 0)
  const relative = join(directory, 'relative.db')
  checked(node([join(backend, 'scripts/backup-db.js'), '--output', relative], { cwd: tmpdir() }))
  checked(node(['scripts/verify-backup.js', relative]))
  console.log(
    'PASS backup snapshots, exact SQL types, restored schema, exclusive output and failures'
  )
} finally {
  rmSync(directory, { recursive: true, force: true })
}
