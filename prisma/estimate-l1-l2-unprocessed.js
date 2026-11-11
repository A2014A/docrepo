/* Dry-run cost estimate for running L1 (free-extraction + Haiku) on the
 * dashboard's "מסמכים חדשים לא מעובדים" documents only (archived:false,
 * hidden:false, identification:null). Mirrors run-l1-identification.js's
 * exact free-vs-Haiku decision (isFreeComplete) to classify each document
 * for real, WITHOUT ever calling Haiku -- zero Claude API cost incurred by
 * this script. Writes nothing to DocIdentification. L2 (run-l2-suggestions.js)
 * is a pure-JS rules engine with no API cost, so only L1/Haiku needs an
 * estimate; L2's run time for ~120 extra documents is negligible. */
const { PrismaClient } = require('@prisma/client');
const { getObjectStream, headObject } = require('../lib/r2');
const { PDFParse } = require('pdf-parse');
const { freeExtract } = require('./_free-extract-lib');
const prisma = new PrismaClient();

function isFreeComplete(f) {
  const hasProduct = !!f.certNo || !!f.requestNo || f.freeSkuCodes.length > 0;
  const hasDate = !!f.validUntil || !!f.productionDate;
  return !!f.docKind && hasProduct && hasDate;
}

const HAIKU_PRICE_IN_PER_M = 1.00;  // Haiku 4.5, $/1M input tokens
const HAIKU_PRICE_OUT_PER_M = 5.00; // Haiku 4.5, $/1M output tokens

(async () => {
  // Real empirical average tokens/call from the 623 documents already
  // processed by Haiku in the original full L1 run -- more accurate than a
  // guessed estimate.
  const haikuRows = await prisma.docIdentification.findMany({
    where: { source: 'HAIKU', costInputTokens: { not: null }, costOutputTokens: { not: null } },
    select: { costInputTokens: true, costOutputTokens: true },
  });
  const avgIn = haikuRows.length ? haikuRows.reduce((s, r) => s + r.costInputTokens, 0) / haikuRows.length : null;
  const avgOut = haikuRows.length ? haikuRows.reduce((s, r) => s + r.costOutputTokens, 0) / haikuRows.length : null;
  console.log(`Empirical Haiku average from ${haikuRows.length} already-processed documents: ${avgIn?.toFixed(0)} in / ${avgOut?.toFixed(0)} out tokens/call`);

  const docs = await prisma.document.findMany({
    where: { archived: false, hidden: false, identification: null },
    select: { id: true, title: true, docExt: true, fileUrl: true },
  });
  console.log(`Target documents: ${docs.length}\n`);

  const skus = await prisma.sku.findMany({ select: { code: true } });
  const skuCodeSet = new Set(skus.map(s => s.code));

  const counters = { free: 0, haiku: 0, unsupported: 0, downloadFailed: 0 };
  const byExt = {};
  for (const doc of docs) {
    const ext = (doc.docExt || '').toLowerCase();
    byExt[ext] = (byExt[ext] || 0) + 1;
    const supported = ext === 'pdf' || ext === 'png' || ext === 'jpg' || ext === 'jpeg';
    if (!supported) { counters.unsupported++; continue; }

    let buf;
    try {
      const { stream } = await getObjectStream(doc.fileUrl);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      buf = Buffer.concat(chunks);
    } catch (e) { counters.downloadFailed++; continue; }

    let text = '';
    if (ext === 'pdf') {
      let parser;
      try {
        parser = new PDFParse({ data: buf });
        const textResult = await parser.getText();
        text = (textResult.text || '').trim();
      } catch (e) { /* scanned/unparsable -- stays empty, will need Haiku */ }
      finally { if (parser) { try { await parser.destroy(); } catch (_) {} } }
    }

    const free = freeExtract(text, skuCodeSet);
    if (isFreeComplete(free)) counters.free++;
    else counters.haiku++;
  }

  console.log('By file extension:', JSON.stringify(byExt));
  console.log('\n=== Classification (no Haiku called, nothing written) ===');
  console.log('Resolved by FREE extraction (no API call):', counters.free);
  console.log('Would need a HAIKU call:', counters.haiku);
  console.log('Unsupported file type (no text/image to send):', counters.unsupported);
  console.log('R2 download failed:', counters.downloadFailed);

  if (avgIn != null && counters.haiku > 0) {
    const totalIn = avgIn * counters.haiku;
    const totalOut = avgOut * counters.haiku;
    const cost = (totalIn / 1e6) * HAIKU_PRICE_IN_PER_M + (totalOut / 1e6) * HAIKU_PRICE_OUT_PER_M;
    console.log(`\nEstimated Haiku API calls: ${counters.haiku}`);
    console.log(`Estimated tokens: ~${Math.round(totalIn).toLocaleString()} in / ~${Math.round(totalOut).toLocaleString()} out`);
    console.log(`Estimated cost: $${cost.toFixed(3)} (at Haiku 4.5 rates: $1/1M in, $5/1M out)`);
  }
  console.log('\nL2 (run-l2-suggestions.js) has no API cost -- pure rules engine, runs over all documents again (a few seconds).');

  await prisma.$disconnect();
})().catch(async (e) => { console.error('FAILED:', e.message); await prisma.$disconnect(); process.exit(1); });
