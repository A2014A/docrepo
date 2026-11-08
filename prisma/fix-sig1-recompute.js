// Targeted correction (5.11 item 2): recompute ONLY the free-extraction
// fields with the fixed quantity-word-exclusion regex, for every already-
// processed document. Does NOT call Haiku -- for HAIKU-sourced rows, only
// freeSkuCodes/freeCertCandidate/pageCount/r2Etag/rawText are touched
// (docKind/certNo/requestNo/dates/manufacturer/kashrutBody/products/track/lots
// stay as Haiku determined them). For FREE-sourced rows, all free fields are
// safely overwritten (nothing Haiku-derived exists there to protect).
const { PrismaClient } = require('@prisma/client');
const { getObjectStream, headObject } = require('../lib/r2');
const { PDFParse } = require('pdf-parse');
const path = require('path');
const { freeExtract } = require('./_free-extract-lib');
const prisma = new PrismaClient();

function parseDateOrNull(s) { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; }

async function pool(items, concurrency, fn) {
  let next = 0, done = 0;
  async function worker() { while (true) { const i = next++; if (i >= items.length) return; await fn(items[i]); done++; if (done % 25 === 0 || done === items.length) console.log(`[${done}/${items.length}]`); } }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function main() {
  const allSkus = await prisma.sku.findMany({ select: { code: true } });
  const skuCodeSet = new Set(allSkus.map(s => s.code));

  const rows = await prisma.docIdentification.findMany({
    where: { source: { in: ['FREE', 'HAIKU'] } },
    include: { document: { select: { fileUrl: true, docExt: true } } },
  });
  console.log('Recomputing free-extraction for', rows.length, 'documents (FREE + HAIKU, no Haiku calls)...');

  let sig1Changed = 0, certChanged = 0;
  await pool(rows, 10, async (r) => {
    if (r.document.docExt !== 'pdf') return; // images have no text layer to re-scan
    let buf;
    try {
      const { stream } = await getObjectStream(r.document.fileUrl);
      const chunks = []; for await (const c of stream) chunks.push(c);
      buf = Buffer.concat(chunks);
    } catch (e) { return; }

    let text = '', pageCount = null;
    let parser;
    try {
      parser = new PDFParse({ data: buf });
      const info = await parser.getInfo();
      pageCount = info.total || null;
      const textResult = await parser.getText();
      text = (textResult.text || '').trim();
    } catch (e) { return; } finally { if (parser) { try { await parser.destroy(); } catch (_) {} } }

    let etag = null;
    try { const head = await headObject(r.document.fileUrl); etag = (head.ETag || '').replace(/"/g, '') || null; } catch (e) {}

    const free = freeExtract(text, skuCodeSet);
    const rawText = text.slice(0, 2000) || null;

    const oldCodes = new Set(Array.isArray(r.freeSkuCodes) ? r.freeSkuCodes : []);
    const newCodes = new Set(free.freeSkuCodes);
    if (oldCodes.size !== newCodes.size || [...oldCodes].some(c => !newCodes.has(c))) sig1Changed++;
    if ((r.certNo || '') !== (free.certNo || '') || (r.requestNo || '') !== (free.requestNo || '')) certChanged++;

    if (r.source === 'FREE') {
      await prisma.docIdentification.update({
        where: { id: r.id },
        data: {
          docKind: free.docKind, certNo: free.certNo, requestNo: free.requestNo,
          validUntil: parseDateOrNull(free.validUntil), productionDate: parseDateOrNull(free.productionDate),
          freeSkuCodes: free.freeSkuCodes, freeCertCandidate: free.freeCertCandidate,
          pageCount, r2Etag: etag, rawText,
        },
      });
    } else {
      // HAIKU-sourced: only touch free-step-only fields, never the merged/Haiku fields.
      await prisma.docIdentification.update({
        where: { id: r.id },
        data: { freeSkuCodes: free.freeSkuCodes, freeCertCandidate: free.freeCertCandidate, pageCount, r2Etag: etag, rawText },
      });
    }
  });

  console.log('\nDone.');
  console.log('Documents whose freeSkuCodes changed:', sig1Changed);
  console.log('Documents whose FREE-row certNo/requestNo changed (FREE rows only):', certChanged);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
