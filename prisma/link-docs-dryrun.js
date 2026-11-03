/* DRY RUN ONLY -- no writes. Reads exports/link-strict.csv (columns
 * documentId, skuCode; other columns ignored) and reports what a real run
 * would do: which rows resolve to a real Document + Sku, which links
 * already exist (would skip), which would be newly created. */
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
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += c;
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
  const raw = fs.readFileSync(csvPath, 'utf8');
  const allRows = parseCsv(raw);
  const header = allRows[0].map(h => h.trim());
  const docIdx = header.indexOf('documentId');
  const skuIdx = header.indexOf('skuCode');
  if (docIdx === -1 || skuIdx === -1) throw new Error('CSV missing documentId/skuCode columns. Header: ' + header.join(','));

  const dataRows = allRows.slice(1).map(r => ({ documentId: parseInt(r[docIdx]), skuCode: String(r[skuIdx]).trim() }));
  console.log('Total data rows:', dataRows.length);

  const distinctDocIds = [...new Set(dataRows.map(r => r.documentId))];
  console.log('Distinct documentIds referenced:', distinctDocIds.length);
  const distinctSkuCodes = [...new Set(dataRows.map(r => r.skuCode))];
  console.log('Distinct skuCodes referenced:', distinctSkuCodes.length);

  const docs = await prisma.document.findMany({ where: { id: { in: distinctDocIds } } });
  const docById = new Map(docs.map(d => [d.id, d]));
  console.log('Documents found:', docs.length, '/', distinctDocIds.length);

  const skus = await prisma.sku.findMany({ where: { code: { in: distinctSkuCodes } } });
  const skuByCode = new Map(skus.map(s => [s.code, s]));
  console.log('SKUs found:', skus.length, '/', distinctSkuCodes.length);

  const notFoundDocIds = distinctDocIds.filter(id => !docById.has(id));
  const notFoundSkuCodes = distinctSkuCodes.filter(c => !skuByCode.has(c));

  // existing SkuLink rows (docType=DOCUMENT) for any of these documents, to detect skip-vs-create
  const existingLinks = await prisma.skuLink.findMany({
    where: { docType: 'DOCUMENT', documentId: { in: distinctDocIds } },
    select: { skuId: true, documentId: true },
  });
  const existingSet = new Set(existingLinks.map(l => l.skuId + '|' + l.documentId));

  let alreadyExists = 0, wouldCreate = 0, invalidPairs = 0;
  const createList = [];
  const dupPairsInCsv = new Set();
  for (const r of dataRows) {
    const doc = docById.get(r.documentId);
    const sku = skuByCode.get(r.skuCode);
    if (!doc || !sku) { invalidPairs++; continue; }
    const key = sku.id + '|' + doc.id;
    if (existingSet.has(key) || dupPairsInCsv.has(key)) { alreadyExists++; continue; }
    dupPairsInCsv.add(key);
    wouldCreate++;
    createList.push({ documentId: doc.id, docTitle: doc.title, skuCode: sku.code, skuName: sku.name });
  }

  console.log('\n=== DRY RUN SUMMARY ===');
  console.log('Links that already exist (will skip):', alreadyExists);
  console.log('Rows with a not-found doc or SKU (will skip):', invalidPairs);
  console.log('Links that would be newly created:', wouldCreate);

  console.log('\nNot-found documentIds:', notFoundDocIds.length ? notFoundDocIds.join(', ') : '(none)');
  console.log('Not-found skuCodes:', notFoundSkuCodes.length ? notFoundSkuCodes.join(', ') : '(none)');

  console.log('\nSample of links that would be created (first 10):');
  createList.slice(0, 10).forEach(c => console.log(`  doc ${c.documentId} "${c.docTitle}" -> SKU ${c.skuCode} "${c.skuName}"`));

  fs.writeFileSync(path.join(__dirname, '..', 'exports', 'link-strict-dryrun-plan.json'), JSON.stringify({ createList, notFoundDocIds, notFoundSkuCodes }, null, 2));
  console.log('\nFull plan written to exports/link-strict-dryrun-plan.json (for the real run to consume, no DB writes yet).');

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('DRY RUN FAILED:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
