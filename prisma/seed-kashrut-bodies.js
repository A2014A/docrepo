/* Seeds the fixed KashrutBody list from docrepo-raw-materials-spec.md Phase 1,
 * including a shortName (Phase 4 Step 4.1's status-dot legend) and, as of
 * 2026-11-03: active (אגודה/OU/הרבנות הראשית set inactive -- hidden from
 * dots/legend/filters/approvals table, but kept in the table, reactivatable
 * by flipping this flag back), handlesPassover (which bodies get the
 * separate Pesach-approval fields on RawMaterialApproval), and sortOrder
 * (בית יוסף and חתם סופר ב"ב ordered first in the legend; default 100 for
 * everyone else, tie-broken by name).
 * Idempotent (upsert by unique name) -- safe to re-run; re-running after an
 * update to this file backfills the new values onto already-seeded rows.
 * NOTE: requires the KashrutBody table to exist, i.e. run this only after
 * the Phase 1 migration has been applied. Not run automatically. */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BODIES = [
  { name: 'בית יוסף',           shortName: 'בית יוסף',  active: true,  handlesPassover: true,  sortOrder: 1 },
  { name: 'חתם סופר ב"ב',       shortName: 'חתם סופר',  active: true,  handlesPassover: true,  sortOrder: 2 },
  { name: 'הרב לנדא',            shortName: 'לנדא',       active: true,  handlesPassover: false, sortOrder: 100 },
  { name: 'בד"ץ העדה החרדית',   shortName: 'עדה חרדית',  active: true,  handlesPassover: false, sortOrder: 100 },
  { name: 'בד"ץ קהילות',         shortName: 'קהילות',     active: true,  handlesPassover: false, sortOrder: 100 },
  { name: 'הרב רובין',           shortName: 'רובין',      active: true,  handlesPassover: false, sortOrder: 100 },
  { name: 'הרב מחפוד',           shortName: 'מחפוד',      active: true,  handlesPassover: true,  sortOrder: 100 },
  { name: 'מחזיקי הדת בעלז',     shortName: 'בעלז',       active: true,  handlesPassover: true,  sortOrder: 100 },
  { name: 'אגודה',                shortName: 'אגודה',      active: false, handlesPassover: false, sortOrder: 100 },
  { name: 'OU',                   shortName: 'OU',         active: false, handlesPassover: false, sortOrder: 100 },
  { name: 'הרבנות הראשית',       shortName: 'רבנות',      active: false, handlesPassover: false, sortOrder: 100 },
];

(async () => {
  for (const { name, ...rest } of BODIES) {
    await prisma.kashrutBody.upsert({ where: { name }, update: rest, create: { name, ...rest } });
  }
  const all = await prisma.kashrutBody.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  console.log(`Seeded ${all.length} kashrut bodies (ordered as the legend will show them):`);
  all.forEach(b => console.log(' -', b.id, b.name, '| short:', b.shortName, '| active:', b.active, '| passover:', b.handlesPassover, '| sortOrder:', b.sortOrder));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('SEED FAILED:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
