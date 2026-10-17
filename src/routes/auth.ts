import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { generateToken } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { isUniqueViolation } from '../lib/errors'
import { passwordError } from '../lib/passwords'

const router = Router()

const MAX_NAME_LENGTH = 80
const MAX_EMAIL_LENGTH = 254

// Default categories seeded per user
const DEFAULT_CATEGORIES = [
  { name: 'Salary', type: 'INCOME', color: '#34A853' },
  { name: 'Freelance', type: 'INCOME', color: '#4285F4' },
  { name: 'Sales', type: 'INCOME', color: '#A8C7FA' },
  { name: 'Food', type: 'EXPENSE', color: '#EA4335' },
  { name: 'Transport', type: 'EXPENSE', color: '#FBBC04' },
  { name: 'Entertainment', type: 'EXPENSE', color: '#A142F4' },
  { name: 'Housing', type: 'EXPENSE', color: '#5F6368' },
  { name: 'Shopping', type: 'EXPENSE', color: '#E8710A' },
  { name: 'Others', type: 'EXPENSE', color: '#78909C' }
]

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

async function seedCategoriesForUser(userId: number) {
  const count = await prisma.category.count({ where: { userId } })
  if (count === 0) {
    await prisma.category.createMany({
      data: DEFAULT_CATEGORIES.map(c => ({ ...c, userId }))
    })
  }
}

// ── REGISTER ───────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body

  const cleanName = typeof name === 'string' ? name.trim() : ''
  const cleanEmail = normalizeEmail(email)

  if (!cleanName || !cleanEmail || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Name, email and password are required.' })
  }

  if (cleanName.length > MAX_NAME_LENGTH) {
    return res.status(400).json({ error: `Name must be at most ${MAX_NAME_LENGTH} characters.` })
  }

  if (cleanEmail.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(cleanEmail)) {
    return res.status(400).json({ error: 'Invalid email format.' })
  }

  const pwError = passwordError(password)
  if (pwError) return res.status(400).json({ error: pwError })

  try {
    const existing = await prisma.user.findUnique({ where: { email: cleanEmail } })
    if (existing) {
      return res.status(409).json({ error: 'Email already registered.' })
    }

    const hashedPassword = await bcrypt.hash(password, 10)
    const user = await prisma.user.create({
      data: { name: cleanName, email: cleanEmail, password: hashedPassword }
    })

    // A failing seed must not block registration (avoids orphaned users without a token).
    try {
      await seedCategoriesForUser(user.id)
    } catch (seedError) {
      console.error('Category seeding failed for user', user.id, seedError)
    }

    const token = generateToken(user.id)
    res.status(201).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        currency: user.currency,
        defaultPeriod: user.defaultPeriod,
        firstDayOfWeek: user.firstDayOfWeek,
        decimalSeparator: user.decimalSeparator
      }
    })
  } catch (error) {
    // The findUnique above loses the race when two registrations with the same
    // email arrive together; the unique index catches the loser here.
    if (isUniqueViolation(error)) {
      return res.status(409).json({ error: 'Email already registered.' })
    }
    console.error('Registration failed.', error)
    res.status(500).json({ error: 'Registration failed.' })
  }
})

// ── LOGIN ──────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body

  const cleanEmail = normalizeEmail(email)

  if (!cleanEmail || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Email and password are required.' })
  }

  try {
    const user = await prisma.user.findUnique({ where: { email: cleanEmail } })
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' })
    }

    const validPassword = await bcrypt.compare(password, user.password)
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password.' })
    }

    const token = generateToken(user.id)
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        currency: user.currency,
        defaultPeriod: user.defaultPeriod,
        firstDayOfWeek: user.firstDayOfWeek,
        decimalSeparator: user.decimalSeparator
      }
    })
  } catch (error) {
    console.error('Login failed.', error)
    res.status(500).json({ error: 'Login failed.' })
  }
})

export default router
