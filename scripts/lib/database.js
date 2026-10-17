const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { createClient } = require('@libsql/client')

const BACKEND_DIR = path.resolve(__dirname, '..', '..')

function loadEnvironment() {
  require('dotenv').config({ path: path.join(BACKEND_DIR, '.env') })
}

function databaseConfig() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set.')
  if (url.startsWith('file:') && url !== 'file::memory:') {
    const file = /^file:(?:\/\/|\/[A-Za-z]:\/)/.test(url)
      ? fileURLToPath(url)
      : path.resolve(BACKEND_DIR, url.slice(5))
    if (!fs.existsSync(file)) throw new Error('The configured local database does not exist.')
    return { url: `file:${file.replace(/\\/g, '/')}`, intMode: 'bigint' }
  }
  return {
    url,
    intMode: 'bigint',
    ...(process.env.TURSO_AUTH_TOKEN ? { authToken: process.env.TURSO_AUTH_TOKEN } : {})
  }
}

function quoteIdentifier(name) {
  return `"${name.replace(/"/g, '""')}"`
}

function safeError(error) {
  let message = error?.message || String(error)
  for (const value of [process.env.TURSO_AUTH_TOKEN, process.env.DATABASE_URL]) {
    if (value) message = message.split(value).join('[database credential]')
  }
  return message
}

module.exports = {
  BACKEND_DIR,
  loadEnvironment,
  databaseConfig,
  quoteIdentifier,
  safeError,
  createClient
}
