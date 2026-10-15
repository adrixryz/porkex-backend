// Runs every *.test.mjs file in this folder and reports a combined summary.
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))

const files = readdirSync(HERE).filter(f => f.endsWith('.test.mjs')).sort()

if (files.length === 0) {
  console.error('No test files found.')
  process.exit(1)
}

let passed = 0
const failedFiles = []

for (const file of files) {
  console.log(`\n─── ${file} ${'─'.repeat(Math.max(0, 50 - file.length))}`)
  const code = await new Promise(resolveExit => {
    const child = spawn('node', [join(HERE, file)], { stdio: 'inherit' })
    child.on('close', resolveExit)
  })
  if (code === 0) passed++
  else failedFiles.push(file)
}

console.log(`\n${'═'.repeat(56)}`)
if (failedFiles.length === 0) {
  console.log(`ALL SUITES PASSED (${passed}/${files.length})`)
} else {
  console.log(`PASSED: ${passed}/${files.length}   FAILED: ${failedFiles.join(', ')}`)
}
process.exit(failedFiles.length ? 1 : 0)