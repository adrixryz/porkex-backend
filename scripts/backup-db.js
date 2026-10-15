// Timestamped copy of the SQLite database into prisma/backups/.
// Run with: npm run db:backup
const fs = require('node:fs');
const path = require('node:path');

const prismaDir = path.join(__dirname, '..', 'prisma');
const dbPath = process.env.DATABASE_URL?.replace(/^file:/, '') || './dev.db';
const source = path.resolve(prismaDir, dbPath);

if (!fs.existsSync(source)) {
  console.error(`Database not found at ${source}`);
  process.exit(1);
}

const backupsDir = path.join(prismaDir, 'backups');
fs.mkdirSync(backupsDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(backupsDir, `dev-${stamp}.db`);

fs.copyFileSync(source, target);
console.log(`Backup created: ${path.relative(process.cwd(), target)}`);