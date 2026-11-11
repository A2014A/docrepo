/* Read-only export: every Document with no SkuLink pointing at it, to
 * exports/unlinked-docs.csv (UTF-8 with BOM for Excel/Hebrew). No DB writes.
 *
 * Note on columns: the app never stores the original upload filename
 * separately from the display title -- only the generated R2 storage key
 * (fileUrl). "originalFileName" below is that storage key's basename, not
 * the literal filename the user originally uploaded (that value was never
 * persisted). "notes" uses Document.description, the closest existing
 * field -- there is no separate "notes" column. */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

(async () => {
  const docs = await prisma.document.findMany({
    where: { links: { none: {} } },
    include: { uploadedBy: true },
    orderBy: { id: 'asc' },
  });

  const header = ['id', 'title', 'originalFileName', 'docType', 'uploadedAt', 'expiryDate', 'fileSizeBytes', 'uploadedBy', 'tags', 'notes'];
  const rows = docs.map(d => [
    d.id,
    d.title || '',
    path.basename(d.fileUrl),
    d.docType || '',
    d.createdAt ? d.createdAt.toISOString() : '',
    d.expiryDate ? d.expiryDate.toISOString().slice(0, 10) : '',
    d.sizeBytes ?? '',
    d.uploadedBy ? d.uploadedBy.email : '',
    (d.tags || []).join('; '),
    d.description || '',
  ]);

  const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
  const outDir = path.join(__dirname, '..', 'exports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'unlinked-docs.csv');
  fs.writeFileSync(outPath, '﻿' + csv, 'utf8');

  console.log(rows.length);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('EXPORT FAILED:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
