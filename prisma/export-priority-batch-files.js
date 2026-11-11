/* Read-only (DB and otherwise -- no writes to DB or R2): for each row in
 * exports/priority-batch.csv, fetch that document's file from R2 and save
 * it locally under its exact priorityFileName (Hebrew-safe, UTF-8 path). */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { getObjectStream } = require('../lib/r2');
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

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

(async () => {
  const csvPath = path.join(__dirname, '..', 'exports', 'priority-batch.csv');
  const allRows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = allRows[0].map(h => h.trim());
  const docIdx = header.indexOf('documentId');
  const nameIdx = header.indexOf('priorityFileName');
  if (docIdx === -1 || nameIdx === -1) throw new Error('CSV missing documentId/priorityFileName columns. Header: ' + header.join(','));

  const rows = allRows.slice(1).map(r => ({ documentId: parseInt(r[docIdx]), priorityFileName: r[nameIdx] }));
  const outDir = path.join(__dirname, '..', 'exports', 'priority-batch-2026-11-03');
  fs.mkdirSync(outDir, { recursive: true });

  const distinctDocIds = [...new Set(rows.map(r => r.documentId))];
  const docs = await prisma.document.findMany({ where: { id: { in: distinctDocIds } } });
  const docById = new Map(docs.map(d => [d.id, d]));

  const written = [];
  const bufferCache = new Map();
  for (const row of rows) {
    const doc = docById.get(row.documentId);
    if (!doc) { console.error(`SKIP: documentId ${row.documentId} not found in DB`); continue; }
    try {
      let buf = bufferCache.get(doc.id);
      if (!buf) {
        const { stream } = await getObjectStream(doc.fileUrl);
        buf = await streamToBuffer(stream);
        bufferCache.set(doc.id, buf);
      }
      const outPath = path.join(outDir, row.priorityFileName);
      fs.writeFileSync(outPath, buf);
      written.push(outPath);
    } catch (e) {
      console.error(`SKIP: documentId ${row.documentId} -> "${row.priorityFileName}" failed: ${e.message}`);
    }
  }

  console.log(`\n=== ${written.length} file(s) written to exports/priority-batch-2026-11-03/ ===`);
  written.forEach(p => console.log(' -', path.basename(p)));

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
