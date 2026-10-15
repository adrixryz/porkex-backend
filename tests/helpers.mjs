// Shared harness for the API tests: spins up a real server against a throwaway
// SQLite database, exposes a small fetch helper and cleans up afterwards.
//
// Each test file uses:  await withServer(async (ctx) => { ... })
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
export const BACKEND_DIR = resolve(HERE, '..')
const TMP_DIR = join(tmpdir(), 'porkex-tests')

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolvePort(port))
    })
  })
}

async function waitForServer(base, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(`${base}/api/dashboard`)
      return true
    } catch {
      await new Promise(r => setTimeout(r, 500))
    }
  }
  return false
}

/**
 * Boots the API on a free port with an isolated database.
 * The returned ctx has { call, results, check, state, base }.
 */
export async function withServer(name, run) {
  mkdirSync(TMP_DIR, { recursive: true })
  const stamp = `${name}-${process.pid}-${Date.now()}`
  const dbFile = join(TMP_DIR, `${stamp}.db`)
  rmSync(dbFile, { force: true })

  const databaseUrl = `file:${dbFile.replace(/\\/g, '/')}`
  const env = { ...process.env, DATABASE_URL: databaseUrl, JWT_SECRET: 'test-secret' }

  const push = spawnSync('npx', ['prisma', 'db', 'push', '--skip-generate'], {
    cwd: BACKEND_DIR,
    env,
    stdio: 'ignore',
    shell: true
  })
  if (push.status !== 0) {
    throw new Error(`prisma db push failed (status ${push.status}). Run it manually with DATABASE_URL=${databaseUrl}`)
  }

  const port = await freePort()
  const base = `http://localhost:${port}`
  const server = spawn('node', ['-r', 'ts-node/register/transpile-only', 'src/index.ts'], {
    cwd: BACKEND_DIR,
    env: { ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const logs = []
  server.stdout.on('data', d => logs.push(String(d)))
  server.stderr.on('data', d => logs.push(String(d)))

  const state = { token: '' }
  const results = []

  const call = async (method, route, body) => {
    const res = await fetch(base + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    let data = null
    try { data = await res.json() } catch { /* empty or non-JSON body */ }
    return { status: res.status, data, contentType: res.headers.get('content-type') }
  }

  const check = (label, ok, extra = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` :: ${extra}` : ''}`)
  }

  const stopServer = () => new Promise(resolveStop => {
    if (server.exitCode !== null) return resolveStop()
    server.once('close', () => resolveStop())
    server.kill()
    // Windows keeps the SQLite file locked until the process is really gone.
    setTimeout(() => {
      server.kill('SIGKILL')
      resolveStop()
    }, 2000)
  })

  const cleanup = async () => {
    await stopServer()
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      rmSync(dbFile + suffix, { force: true })
    }
  }

  const ready = await waitForServer(base)
  if (!ready) {
    await cleanup()
    throw new Error(`Server did not start on port ${port}.\n${logs.join('')}`)
  }

  try {
    await run({ call, check, results, state, base })
  } finally {
    await cleanup()
  }

  const failed = results.filter(r => r.startsWith('FAIL'))
  console.log(results.join('\n'))
  console.log(`\n${results.length - failed.length}/${results.length} OK`)
  if (failed.length) throw new Error(`${failed.length} check(s) failed`)
}

/** A throwaway user with the default categories seeded, ready to use. */
export async function createTestUser(ctx, email = 'test@example.com') {
  const res = await ctx.call('POST', '/auth/register', { name: 'Test', email, password: 'secret1' })
  if (res.status !== 201) throw new Error(`Could not create the test user: ${JSON.stringify(res.data)}`)
  ctx.state.token = res.data.token
  const cats = await ctx.call('GET', '/api/categories')
  return {
    user: res.data.user,
    categories: cats.data,
    expense: cats.data.find(c => c.type === 'EXPENSE'),
    income: cats.data.find(c => c.type === 'INCOME')
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))
export { existsSync }