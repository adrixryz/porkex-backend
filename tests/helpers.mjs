// Shared harness for the API tests: spins up a real server against a throwaway
// SQLite database, exposes a small fetch helper and cleans up afterwards.
//
// Each test file uses:  await withServer(async (ctx) => { ... })
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
export const BACKEND_DIR = resolve(HERE, '..')

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

async function waitForServer(base, server, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (server.exitCode !== null || server.signalCode !== null || !server.pid) return false
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
 * The returned ctx has { call, results, check, state, base, dbFile } — dbFile
 * is the throwaway SQLite path, for suites that need to poke at rows directly
 * (the recurring suite ages a rule's nextDate to simulate elapsed days).
 * `extraEnv` overrides any environment variable for this server (e.g. a lower
 * rate limit so the 429 path can be tested without 30 requests).
 */
export async function withServer(name, run, extraEnv = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), `porkex-${name}-`))
  const dbFile = join(tempDir, 'test.db')
  const databaseUrl = `file:${dbFile.replace(/\\/g, '/')}`
  const env = {
    ...process.env,
    ALLOW_REGISTRATION: 'true',
    // Calendar fixtures edit rows directly outside the API's invalidation path.
    // Cache-specific API tests override this to exercise the production TTL.
    RECURRING_CACHE_TTL_MS: '0',
    ...extraEnv,
    // A suite may change rate limits, never redirect tests to a real database.
    DATABASE_URL: databaseUrl,
    TURSO_AUTH_TOKEN: '',
    JWT_SECRET: 'test-secret'
  }

  let server
  const logs = []
  const state = { token: '' }
  const results = []
  let base
  const call = async (method, route, body, headers = {}) => {
    if (
      method === 'PUT' &&
      /^\/api\/transactions\/\d+$/.test(route) &&
      body &&
      body.mutationId === undefined
    ) {
      body = { ...body, mutationId: randomUUID(), editedAt: new Date().toISOString() }
    }
    const res = await fetch(base + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // Seed/backup checks run synchronous children between calls. Avoid
        // reusing an idle socket closed while this process was blocked.
        Connection: 'close',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        // Existing suites use UTC calendar fixtures; timezone regressions pass
        // an explicit device zone through this fourth argument.
        'X-Porkex-Time-Zone': 'UTC',
        ...headers
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    let data = null
    try {
      data = await res.json()
    } catch {
      /* empty or non-JSON body */
    }
    return {
      status: res.status,
      data,
      contentType: res.headers.get('content-type'),
      headers: res.headers
    }
  }

  const check = (label, ok, extra = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` :: ${extra}` : ''}`)
  }

  const stopServer = () =>
    new Promise(resolveStop => {
      if (!server?.pid || server.exitCode !== null || server.signalCode !== null)
        return resolveStop()
      const timer = setTimeout(() => server.kill('SIGKILL'), 2000)
      server.once('close', () => {
        clearTimeout(timer)
        resolveStop()
      })
      server.kill()
      // Windows keeps the SQLite file locked until the process is really gone.
    })

  const cleanup = async () => {
    await stopServer()
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      rmSync(dbFile + suffix, { force: true })
    }
    rmSync(tempDir, { recursive: true, force: true })
  }

  try {
    const apply = spawnSync(process.execPath, ['scripts/apply-schema.js'], {
      cwd: BACKEND_DIR,
      env,
      encoding: 'utf8'
    })
    if (apply.error || apply.status !== 0) {
      throw new Error(
        `Database preparation failed (status ${apply.status}): ${apply.error?.message ?? ''}\n${apply.stdout}\n${apply.stderr}`
      )
    }
    const port = await freePort()
    base = `http://localhost:${port}`
    server = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', 'src/index.ts'], {
      cwd: BACKEND_DIR,
      env: { ...env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    server.stdout.on('data', data => logs.push(String(data)))
    server.stderr.on('data', data => logs.push(String(data)))
    server.on('error', error => logs.push(error.message))
    if (!(await waitForServer(base, server))) {
      throw new Error(`Server did not start on port ${port}.\n${logs.join('')}`)
    }
    await run({ call, check, results, state, base, dbFile })
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
  if (res.status !== 201)
    throw new Error(`Could not create the test user: ${JSON.stringify(res.data)}`)
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
