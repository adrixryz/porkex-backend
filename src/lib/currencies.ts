// Currency codes the app knows how to display. The symbol is stored on the
// client and only used for formatting: there is no conversion between them.
// Keep in sync with CURRENCIES in porkex-frontend/src/utils/currency.ts.
export const CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'JPY', 'BRL', 'MXN', 'PEN'] as const

export const DEFAULT_CURRENCY = 'USD'

export function isValidCurrency(value: unknown): value is string {
  return typeof value === 'string' && (CURRENCY_CODES as readonly string[]).includes(value)
}
