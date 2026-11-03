/* Full logical backup of every table, used before additive schema migrations.
 * Not a pg_dump (no DDL/indexes), but sufficient to restore row data since
 * this migration only adds tables/columns and never drops/renames anything. */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const TABLES = [
  'user', 'customer', 'category', 'sku', 'rabbinateCert', 'badatzDoc',
  'document', 'skuLink', 'certRequest', 'syncState', 'contact',
];

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'backups', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const counts = {};
  for (const table of TABLES) {
    const rows = await prisma[table].findMany();
    fs.writeFileSync(path.join(outDir, `${table}.json`), JSON.stringify(rows, null, 2));
    counts[table] = rows.length;
  }

  fs.writeFileSync(path.join(outDir, '_manifest.json'), JSON.stringify({
    takenAt: new Date().toISOString(),
    reason: 'pre-migration backup before raw-material registry schema change',
    counts,
  }, null, 2));

  console.log('Backup written to:', outDir);
  console.log('Row counts:', counts);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('BACKUP FAILED:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
