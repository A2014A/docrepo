/* Seeds the fixed KashrutBody list from docrepo-raw-materials-spec.md Phase 1,
 * including a shortName for each (added for Phase 4 Step 4.1's status-dot
 * legend -- a short label that fits a narrow column, full name stays in the
 * tooltip). Idempotent (upsert by unique name) -- safe to re-run; re-running
 * after this update also backfills shortName onto the already-seeded rows.
 * NOTE: requires the KashrutBody table to exist, i.e. run this only after
 * the Phase 1 migration has been applied. Not run automatically. */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BODIES = [
  { name: 'הרב לנדא', shortName: 'לנדא' },
  { name: 'בד"ץ העדה החרדית', shortName: 'עדה חרדית' },
  { name: 'חתם סופר ב"ב', shortName: 'חתם סופר' },
  { name: 'בד"ץ קהילות', shortName: 'קהילות' },
  { name: 'הרב רובין', shortName: 'רובין' },
  { name: 'הרב מחפוד', shortName: 'מחפוד' },
  { name: 'בית יוסף', shortName: 'בית יוסף' },
  { name: 'מחזיקי הדת בעלז', shortName: 'בעלז' },
  { name: 'אגודה', shortName: 'אגודה' },
  { name: 'OU', shortName: 'OU' },
  { name: 'הרבנות הראשית', shortName: 'רבנות' },
];

(async () => {
  for (const { name, shortName } of BODIES) {
    await prisma.kashrutBody.upsert({ where: { name }, update: { shortName }, create: { name, shortName } });
  }
  const all = await prisma.kashrutBody.findMany({ orderBy: { id: 'asc' } });
  console.log(`Seeded ${all.length} kashrut bodies:`);
  all.forEach(b => console.log(' -', b.id, b.name, '|', b.shortName));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('SEED FAILED:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
