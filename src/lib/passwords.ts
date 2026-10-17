// Password policy, shared by registration and password changes so the two
// cannot drift apart.

export const MIN_PASSWORD_LENGTH = 6

// bcrypt hashes at most 72 bytes and silently ignores the rest; accepting a
// longer password would mean two different passwords open the same account.
export const MAX_PASSWORD_BYTES = 72

/** Error message for a user-supplied password, or null when it is acceptable. */
export function passwordError(password: unknown, label = 'Password'): string | null {
  if (typeof password !== 'string' || !password) return `${label} is required.`
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `${label} must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `${label} must be at most ${MAX_PASSWORD_BYTES} bytes.`
  }
  return null
}
