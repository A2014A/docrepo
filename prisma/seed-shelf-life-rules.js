/* S2: seed the confirmed ShelfLifeRule overrides from docrepo-sprint-8.11.md
 * (per-SKU 13460=36, 13459=24, 13461=24; category שימורים=36 as a DB-editable
 * row rather than only a code default). Idempotent -- safe to re-run. */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const perSku = { '13460': 36, '13459': 24, '13461': 24 };
  for (const [code, months] of Object.entries(perSku)) {
    const sku = await prisma.sku.findUnique({ where: { code } });
    if (!sku) { console.log(`SKIP ${code}: not found`); continue; }
    await prisma.shelfLifeRule.upsert({
      where: { skuId: sku.id },
      update: { months },
      create: { skuId: sku.id, months },
    });
    console.log(`OK per-SKU ${code} -> ${months}mo`);
  }

  const existingCategoryRule = await prisma.shelfLifeRule.findFirst({ where: { categoryName: 'שימורים' } });
  if (existingCategoryRule) {
    await prisma.shelfLifeRule.update({ where: { id: existingCategoryRule.id }, data: { months: 36 } });
    console.log('OK category שימורים -> 36mo (updated)');
  } else {
    await prisma.shelfLifeRule.create({ data: { categoryName: 'שימורים', months: 36 } });
    console.log('OK category שימורים -> 36mo (created)');
  }

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
