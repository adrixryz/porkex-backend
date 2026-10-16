import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

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
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' })
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as { userId: number }
    req.userId = decoded.userId
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' })
  }
}

// No expiresIn: the token never expires, so the session only ends on logout.
export function generateToken(userId: number): string {
  return jwt.sign({ userId }, getJwtSecret())
}
