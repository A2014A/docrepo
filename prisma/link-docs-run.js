/* REAL RUN: creates regular document-SKU links (SkuLink, docType=DOCUMENT,
 * isRawMaterial=false) from exports/link-strict.csv -- the exact same row
 * shape the app itself creates via POST/PATCH /api/docs when a user adds
 * SKUs to a document. Additive only: re-resolves everything fresh (not
 * trusting the earlier dry-run's saved JSON, in case anything changed),
 * skips anything that already exists or doesn't resolve, never deletes or
 * modifies an existing link. */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; } }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || r[0] !== '');
}

(async () => {
  const csvPath = path.join(__dirname, '..', 'exports', 'link-strict.csv');
  const allRows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = allRows[0].map(h => h.trim());
  const docIdx = header.indexOf('documentId');
  const skuIdx = header.indexOf('skuCode');
  const dataRows = allRows.slice(1).map(r => ({ documentId: parseInt(r[docIdx]), skuCode: String(r[skuIdx]).trim() }));

  const distinctDocIds = [...new Set(dataRows.map(r => r.documentId))];
  const distinctSkuCodes = [...new Set(dataRows.map(r => r.skuCode))];
  const docs = await prisma.document.findMany({ where: { id: { in: distinctDocIds } } });
  const docById = new Map(docs.map(d => [d.id, d]));
  const skus = await prisma.sku.findMany({ where: { code: { in: distinctSkuCodes } } });
  const skuByCode = new Map(skus.map(s => [s.code, s]));
  const notFoundDocIds = distinctDocIds.filter(id => !docById.has(id));
  const notFoundSkuCodes = distinctSkuCodes.filter(c => !skuByCode.has(c));

  const existingLinks = await prisma.skuLink.findMany({
    where: { docType: 'DOCUMENT', documentId: { in: distinctDocIds } },
    select: { skuId: true, documentId: true },
  });
  const existingSet = new Set(existingLinks.map(l => l.skuId + '|' + l.documentId));

  let created = 0, skippedExisting = 0, skippedNotFound = 0;
  const seenThisRun = new Set();
  const createdList = [];

  for (const r of dataRows) {
    const doc = docById.get(r.documentId);
    const sku = skuByCode.get(r.skuCode);
    if (!doc || !sku) { skippedNotFound++; continue; }
    const key = sku.id + '|' + doc.id;
    if (existingSet.has(key) || seenThisRun.has(key)) { skippedExisting++; continue; }
    seenThisRun.add(key);

    const link = await prisma.skuLink.create({
      data: {
        skuId: sku.id, docType: 'DOCUMENT', documentId: doc.id, visibleToCustomer: false,
        approvalStatus: 'APPROVED', kashrutLevel: null, isRawMaterial: false,
      },
    });
    created++;
    createdList.push({ linkId: link.id, documentId: doc.id, docTitle: doc.title, skuCode: sku.code, skuName: sku.name });
  }

  console.log('=== REAL RUN COMPLETE ===');
  console.log('Created:', created);
  console.log('Skipped (already existed):', skippedExisting);
  console.log('Skipped (doc or SKU not found):', skippedNotFound);
  console.log('Not-found documentIds:', notFoundDocIds.length ? notFoundDocIds.join(', ') : '(none)');
  console.log('Not-found skuCodes:', notFoundSkuCodes.length ? notFoundSkuCodes.join(', ') : '(none)');

  fs.writeFileSync(path.join(__dirname, '..', 'exports', 'link-strict-run-result.json'), JSON.stringify({ created, skippedExisting, skippedNotFound, createdList }, null, 2));
  console.log('\nFull result written to exports/link-strict-run-result.json');

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('RUN FAILED:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
