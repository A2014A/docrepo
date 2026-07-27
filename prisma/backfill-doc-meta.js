/**
 * One-time backfill: populate docExt/sizeBytes (added to the schema after
 * the initial document migration) by inspecting each doc's R2 object.
 */
const { PrismaClient } = require('@prisma/client');
const path = require('path');
const { headObject } = require('../lib/r2');

const prisma = new PrismaClient();

async function main() {
  const docs = await prisma.document.findMany({ where: { docExt: null } });
  let updated = 0;
  for (const d of docs) {
    const ext = path.extname(d.fileUrl).replace('.', '');
    let sizeBytes = null;
    try {
      const meta = await headObject(d.fileUrl);
      sizeBytes = meta.ContentLength || null;
    } catch (e) {
      console.log('head failed for', d.fileUrl, e.message);
    }
    await prisma.document.update({ where: { id: d.id }, data: { docExt: ext, sizeBytes } });
    updated++;
  }
  console.log('DONE. backfilled', updated, 'documents');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
