/* Seeds the fixed KashrutBody list from docrepo-raw-materials-spec.md Phase 1.
 * Idempotent (upsert by unique name) -- safe to re-run.
 * NOTE: requires the KashrutBody table to exist, i.e. run this only after
 * the Phase 1 migration has been applied. Not run automatically. */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BODIES = [
  'הרב לנדא',
  'בד"ץ העדה החרדית',
  'חתם סופר ב"ב',
  'בד"ץ קהילות',
  'הרב רובין',
  'הרב מחפוד',
  'בית יוסף',
  'מחזיקי הדת בעלז',
  'אגודה',
  'OU',
  'הרבנות הראשית',
];

(async () => {
  for (const name of BODIES) {
    await prisma.kashrutBody.upsert({ where: { name }, update: {}, create: { name } });
  }
  const all = await prisma.kashrutBody.findMany({ orderBy: { id: 'asc' } });
  console.log(`Seeded ${all.length} kashrut bodies:`);
  all.forEach(b => console.log(' -', b.id, b.name));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('SEED FAILED:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
