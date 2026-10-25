/** Names shared by categories, tags and the CSV catalogue resolver. */
export function catalogName(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim().normalize('NFC')
  return name.length > 0 && Array.from(name).length <= maxLength && /^[\p{L}\p{N} -]+$/u.test(name)
    ? name
    : null
}

export const catalogNameError = 'Use letters, numbers, spaces and hyphens only.'

export const catalogNameKey = (name: string) => name.trim().normalize('NFC').toLowerCase()
