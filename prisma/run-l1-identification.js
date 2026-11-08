// L1 (docrepo-link-suggestions-spec.md, with the L0 revision): populate
// DocIdentification for every unlinked document.
//
//   (a) FREE: pdf-parse text layer + regex-based cert/request-number, date,
//       and docKind detection, plus an exact SKU-code match. No Claude call.
//   (b) HAIKU: only when (a) did not yield docKind + (certNo/requestNo/a SKU
//       code) + a date. Field-extraction only -- NO SKU list in the prompt.
//
// Resumable: documents with a terminal DocIdentification row (FREE / HAIKU /
// UNSUPPORTED) are skipped on re-run. HAIKU_FAILED rows are retried.
// Concurrency 2. Does NOT create SkuLinks, archive, or mark duplicates.
//
// Ctrl+C finishes in-flight work for the two workers and exits -- safe to
// stop and re-run later (pause/resume).

const { PrismaClient } = require('@prisma/client');
const { getObjectStream, headObject } = require('../lib/r2');
const { PDFParse } = require('pdf-parse');
const prisma = new PrismaClient();

const CONCURRENCY = 2;

// ---------- free-extraction + Haiku call (shared modules) ----------
const { freeExtract } = require('./_free-extract-lib');
const { callHaiku, ANTHROPIC_API_KEY, MODEL } = require('./_haiku-identify-lib');

function isFreeComplete(f) {
  const hasProduct = !!f.certNo || !!f.requestNo || f.freeSkuCodes.length > 0;
  const hasDate = !!f.validUntil || !!f.productionDate;
  return !!f.docKind && hasProduct && hasDate;
}

function parseDateOrNull(s) {
  if (!s || typeof s !== 'string') return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ---------- per-document pipeline ----------

async function processDocument(doc, skuCodeSet, counters) {
  const ext = (doc.docExt || '').toLowerCase();
  const supported = ext === 'pdf' || ext === 'png' || ext === 'jpg' || ext === 'jpeg';

  if (!supported) {
    await prisma.docIdentification.upsert({
      where: { documentId: doc.id },
      create: { documentId: doc.id, source: 'UNSUPPORTED' },
      update: { source: 'UNSUPPORTED' },
    });
    counters.unsupported++;
    return;
  }

  let buf;
  try {
    const { stream } = await getObjectStream(doc.fileUrl);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    buf = Buffer.concat(chunks);
  } catch (e) {
    await prisma.docIdentification.upsert({
      where: { documentId: doc.id },
      create: { documentId: doc.id, source: 'HAIKU_FAILED', errorMessage: 'R2 download failed: ' + e.message },
      update: { source: 'HAIKU_FAILED', errorMessage: 'R2 download failed: ' + e.message },
    });
    counters.failed++;
    return;
  }

  let etag = null;
  try {
    const head = await headObject(doc.fileUrl);
    etag = (head.ETag || '').replace(/"/g, '') || null;
  } catch (e) { /* best effort */ }

  let text = '', pageCount = null, hasTextLayer = false;
  if (ext === 'pdf') {
    let parser;
    try {
      parser = new PDFParse({ data: buf });
      const info = await parser.getInfo();
      pageCount = info.total || null;
      const textResult = await parser.getText();
      text = (textResult.text || '').trim();
      hasTextLayer = text.length > 20;
    } catch (e) { /* scanned/unparsable -- stays empty */ }
    finally { if (parser) { try { await parser.destroy(); } catch (_) {} } }
  }

  const free = freeExtract(text, skuCodeSet);
  const rawText = text.slice(0, 2000) || null;

  if (!isFreeComplete(free) && !ANTHROPIC_API_KEY) {
    await prisma.docIdentification.upsert({
      where: { documentId: doc.id },
      create: {
        documentId: doc.id, source: 'PENDING_HAIKU',
        docKind: free.docKind, certNo: free.certNo, requestNo: free.requestNo,
        validUntil: parseDateOrNull(free.validUntil), productionDate: parseDateOrNull(free.productionDate),
        freeSkuCodes: free.freeSkuCodes, freeCertCandidate: free.freeCertCandidate,
        hasTextLayer, pageCount, r2Etag: etag, rawText,
      },
      update: {
        source: 'PENDING_HAIKU',
        docKind: free.docKind, certNo: free.certNo, requestNo: free.requestNo,
        validUntil: parseDateOrNull(free.validUntil), productionDate: parseDateOrNull(free.productionDate),
        freeSkuCodes: free.freeSkuCodes, freeCertCandidate: free.freeCertCandidate,
        hasTextLayer, pageCount, r2Etag: etag, rawText,
      },
    });
    counters.pendingHaiku++;
    return;
  }

  if (isFreeComplete(free)) {
    await prisma.docIdentification.upsert({
      where: { documentId: doc.id },
      create: {
        documentId: doc.id, source: 'FREE',
        docKind: free.docKind, certNo: free.certNo, requestNo: free.requestNo,
        validUntil: parseDateOrNull(free.validUntil), productionDate: parseDateOrNull(free.productionDate),
        freeSkuCodes: free.freeSkuCodes, freeCertCandidate: free.freeCertCandidate,
        hasTextLayer, pageCount, r2Etag: etag, rawText,
      },
      update: {
        source: 'FREE',
        docKind: free.docKind, certNo: free.certNo, requestNo: free.requestNo,
        validUntil: parseDateOrNull(free.validUntil), productionDate: parseDateOrNull(free.productionDate),
        freeSkuCodes: free.freeSkuCodes, freeCertCandidate: free.freeCertCandidate,
        hasTextLayer, pageCount, r2Etag: etag, rawText,
      },
    });
    counters.free++;
    return;
  }

  // (b) Haiku fallback
  let mediaType = 'application/pdf';
  if (ext === 'png') mediaType = 'image/png';
  else if (ext === 'jpg' || ext === 'jpeg') mediaType = 'image/jpeg';
  const contentBlock = ext === 'pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } };

  try {
    const { parsed, usage } = await callHaiku(contentBlock);
    await prisma.docIdentification.upsert({
      where: { documentId: doc.id },
      create: {
        documentId: doc.id, source: 'HAIKU', model: MODEL,
        docKind: parsed.docKind || free.docKind || null,
        certNo: parsed.certNo || free.certNo || null,
        requestNo: parsed.requestNo || free.requestNo || null,
        products: Array.isArray(parsed.products) ? parsed.products : undefined,
        manufacturer: parsed.manufacturer || null,
        kashrutBody: parsed.kashrutBody || null,
        track: parsed.track || null,
        validUntil: parseDateOrNull(parsed.validUntil) || parseDateOrNull(free.validUntil),
        productionDate: parseDateOrNull(parsed.productionDate) || parseDateOrNull(free.productionDate),
        lots: Array.isArray(parsed.lots) ? parsed.lots : undefined,
        freeSkuCodes: free.freeSkuCodes, freeCertCandidate: free.freeCertCandidate,
        hasTextLayer, pageCount, r2Etag: etag, rawText,
        costInputTokens: usage.input_tokens || null, costOutputTokens: usage.output_tokens || null,
      },
      update: {
        source: 'HAIKU', model: MODEL,
        docKind: parsed.docKind || free.docKind || null,
        certNo: parsed.certNo || free.certNo || null,
        requestNo: parsed.requestNo || free.requestNo || null,
        products: Array.isArray(parsed.products) ? parsed.products : undefined,
        manufacturer: parsed.manufacturer || null,
        kashrutBody: parsed.kashrutBody || null,
        track: parsed.track || null,
        validUntil: parseDateOrNull(parsed.validUntil) || parseDateOrNull(free.validUntil),
        productionDate: parseDateOrNull(parsed.productionDate) || parseDateOrNull(free.productionDate),
        lots: Array.isArray(parsed.lots) ? parsed.lots : undefined,
        freeSkuCodes: free.freeSkuCodes, freeCertCandidate: free.freeCertCandidate,
        hasTextLayer, pageCount, r2Etag: etag, rawText,
        costInputTokens: usage.input_tokens || null, costOutputTokens: usage.output_tokens || null,
        errorMessage: null,
      },
    });
    counters.haiku++;
    counters.inputTokens += usage.input_tokens || 0;
    counters.outputTokens += usage.output_tokens || 0;
  } catch (e) {
    await prisma.docIdentification.upsert({
      where: { documentId: doc.id },
      create: { documentId: doc.id, source: 'HAIKU_FAILED', errorMessage: e.message, hasTextLayer, pageCount, r2Etag: etag, rawText },
      update: { source: 'HAIKU_FAILED', errorMessage: e.message, hasTextLayer, pageCount, r2Etag: etag, rawText },
    });
    counters.failed++;
  }
}

// ---------- pool runner ----------

async function pool(items, concurrency, fn) {
  let next = 0, done = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
      done++;
      if (done % 5 === 0 || done === items.length) {
        console.log(`[${done}/${items.length}] processed`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function main() {
  const allSkus = await prisma.sku.findMany({ select: { code: true } });
  const skuCodeSet = new Set(allSkus.map(s => s.code));

  const unlinked = await prisma.document.findMany({
    where: { links: { none: {} } },
    select: { id: true, fileUrl: true, docExt: true },
  });

  const FORCE = process.env.L1_FORCE === '1';
  const existing = FORCE ? [] : await prisma.docIdentification.findMany({
    where: { documentId: { in: unlinked.map(d => d.id) }, source: { in: ['FREE', 'HAIKU', 'UNSUPPORTED'] } },
    select: { documentId: true },
  });
  const doneSet = new Set(existing.map(e => e.documentId));
  const todo = unlinked.filter(d => !doneSet.has(d.id));

  const limit = parseInt(process.env.L1_LIMIT || '0', 10);
  const todoFinal = limit > 0 ? todo.slice(0, limit) : todo;

  console.log(`Total unlinked documents: ${unlinked.length}. Already done (resumed, skipped): ${doneSet.size}. To process now: ${todoFinal.length}${limit ? ' (L1_LIMIT=' + limit + ')' : ''}.`);

  if (!ANTHROPIC_API_KEY) console.log('No ANTHROPIC_API_KEY -- running FREE step only; incomplete docs will be stored as PENDING_HAIKU and retried once a key is available.');
  const counters = { free: 0, haiku: 0, failed: 0, unsupported: 0, pendingHaiku: 0, inputTokens: 0, outputTokens: 0 };

  let stopping = false;
  process.on('SIGINT', () => { if (!stopping) { stopping = true; console.log('\nSIGINT received -- finishing in-flight documents, then exiting. Re-run the script to resume.'); } });
  process.on('SIGTERM', () => { if (!stopping) { stopping = true; console.log('\nSIGTERM received -- finishing in-flight documents, then exiting. Re-run the script to resume.'); } });

  const items = [];
  for (const doc of todoFinal) {
    if (stopping) break;
    items.push(doc);
  }

  // Simple cooperative pool that also checks `stopping` between items.
  let next = 0, doneCount = 0;
  async function worker() {
    while (true) {
      if (stopping) return;
      const i = next++;
      if (i >= items.length) return;
      await processDocument(items[i], skuCodeSet, counters);
      doneCount++;
      if (doneCount % 5 === 0 || doneCount === items.length) {
        console.log(`[${doneCount}/${items.length}] FREE=${counters.free} HAIKU=${counters.haiku} PENDING=${counters.pendingHaiku} FAILED=${counters.failed} UNSUPPORTED=${counters.unsupported} | tokens in=${counters.inputTokens} out=${counters.outputTokens}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log('\n=== Run summary ===');
  console.log(counters);
  const estCost = (counters.inputTokens / 1e6) * 1.0 + (counters.outputTokens / 1e6) * 5.0;
  console.log(`Estimated Haiku spend this run: $${estCost.toFixed(4)}`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
