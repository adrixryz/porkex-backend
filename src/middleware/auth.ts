import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../lib/prisma'

// Read lazily so dotenv.config() (called in index.ts) has already run by the time
// the first request arrives, even though this module is imported earlier.
//
// There is deliberately NO fallback value here. A hardcoded default would keep
// the server running while signing every token with a key that is public in the
// source, so a missing secret must stop the process instead.
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set. Copy .env.example to .env and set JWT_SECRET to a random value, ' +
        "e.g. node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
    )
  }
  return secret
}

// Called once at boot so a missing secret fails immediately with a clear message,
// instead of surfacing as a confusing 401/500 on the first login attempt.
export function assertJwtSecretIsConfigured(): void {
  getJwtSecret()
}

export interface AuthRequest extends Request {
  userId?: number
  sessionVersion?: number
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' })
  }

  const token = authHeader.split(' ')[1]

  let decoded: { userId: number; sessionVersion?: number }
  try {
    decoded = jwt.verify(token, getJwtSecret()) as typeof decoded
    if (
      !Number.isInteger(decoded.userId) ||
      decoded.userId <= 0 ||
      !Number.isInteger(decoded.sessionVersion ?? 0) ||
      (decoded.sessionVersion ?? 0) < 0
    )
      throw new Error('Invalid claims')
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' })
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { sessionVersion: true }
    })
    if (!user || user.sessionVersion !== (decoded.sessionVersion ?? 0))
      return res.status(401).json({ error: 'This session was revoked. Sign in again.' })
    req.userId = decoded.userId
    req.sessionVersion = user.sessionVersion
  } catch {
    return res.status(503).json({ error: 'Could not verify the session. Please retry.' })
  }
  next()
}

// Long-lived sessions remain valid until their account version is revoked.
export function generateToken(userId: number, sessionVersion = 0): string {
  return jwt.sign({ userId, sessionVersion }, getJwtSecret())
}
