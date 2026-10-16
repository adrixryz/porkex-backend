// Guards against the currency list drifting apart between the two projects.
// The backend validates the code stored on the user profile; the frontend owns
// the symbols and names. If they diverge, saving a currency in Settings fails.
// Run with: npm run check:currencies
const fs = require('node:fs')
const path = require('node:path')

// The two projects live in sibling directories: porkex-backend and porkex-web-app.
const frontendFile = path.resolve(
  __dirname,
  '..',
  '..',
  'porkex-web-app',
  'src',
  'utils',
  'currency.ts'
)
const backendFile = path.resolve(__dirname, '..', 'src', 'lib', 'currencies.ts')

if (!fs.existsSync(frontendFile)) {
  // The two projects are separate checkouts (CI only has this one), so a
  // missing sibling means there is nothing to compare — not a failure.
  console.log(`Skipping: frontend checkout not found at ${frontendFile}`)
  process.exit(0)
}

const frontend = fs.readFileSync(frontendFile, 'utf8')
const backend = fs.readFileSync(backendFile, 'utf8')

// Only the CURRENCIES array counts on the frontend: the file also mentions USD
// in the localStorage fallback, which is not a second entry.
const currenciesBlock = frontend.match(/export const CURRENCIES = \[[\s\S]*?\]/)
if (!currenciesBlock) {
  console.error('Could not find the CURRENCIES array in the frontend.')
  process.exit(1)
}

const frontendCodes = [...currenciesBlock[0].matchAll(/code:\s*'([A-Z]{3})'/g)].map(m => m[1])

// Only the CURRENCY_CODES array counts on the backend: DEFAULT_CURRENCY repeats
// USD and is not a second entry.
const backendBlock = backend.match(/export const CURRENCY_CODES = \[[\s\S]*?\]/)
if (!backendBlock) {
  console.error('Could not find the CURRENCY_CODES array in the backend.')
  process.exit(1)
}
const backendCodes = [...backendBlock[0].matchAll(/'([A-Z]{3})'/g)].map(m => m[1])

const onlyFrontend = frontendCodes.filter(c => !backendCodes.includes(c))
const onlyBackend = backendCodes.filter(c => !frontendCodes.includes(c))
const duplicates = frontendCodes.filter((c, i) => frontendCodes.indexOf(c) !== i)

if (!frontendCodes.length || !backendCodes.length) {
  console.error('Could not read the currency lists from either file.')
  process.exit(1)
}

if (onlyFrontend.length || onlyBackend.length || duplicates.length) {
  console.error('Currency lists are out of sync:')
  if (onlyFrontend.length) console.error(`  only in frontend: ${onlyFrontend.join(', ')}`)
  if (onlyBackend.length) console.error(`  only in backend:  ${onlyBackend.join(', ')}`)
  if (duplicates.length)
    console.error(`  duplicated in frontend: ${[...new Set(duplicates)].join(', ')}`)
  process.exit(1)
}

console.log(`Currency lists match (${frontendCodes.length}): ${backendCodes.join(', ')}`)
