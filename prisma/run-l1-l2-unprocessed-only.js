/* Runs L1 (free-extraction + Haiku) on EXACTLY the dashboard's "מסמכים
 * חדשים לא מעובדים" documents (archived:false, hidden:false,
 * identification:null) -- approved scope, ~$0.53 estimated (see
 * prisma/estimate-l1-l2-unprocessed.js). Deliberately NOT the generic
 * run-l1-identification.js default scope (documents with zero SkuLink):
 * all 120 target documents already have a SkuLink (linked via some other
 * path, e.g. the dashboard preview panel or an older flow) but were never
 * run through L1, so the default script would skip them entirely. Reuses
 * the exact same processDocument() function -- no duplicated pipeline
 * logic. Then runs L2 (full recompute, as always). */
const { PrismaClient } = require('@prisma/client');
const { processDocument } = require('./run-l1-identification');
const prisma = new PrismaClient();

const CONCURRENCY = 2;

async function main() {
  const allSkus = await prisma.sku.findMany({ select: { code: true } });
  const skuCodeSet = new Set(allSkus.map(s => s.code));

  const docs = await prisma.document.findMany({
    where: { archived: false, hidden: false, identification: null },
    select: { id: true, fileUrl: true, docExt: true },
  });
  console.log(`Target documents (approved scope): ${docs.length}`);

  const counters = { free: 0, haiku: 0, failed: 0, unsupported: 0, pendingHaiku: 0, inputTokens: 0, outputTokens: 0 };
  let next = 0, done = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= docs.length) return;
      await processDocument(docs[i], skuCodeSet, counters);
      done++;
      if (done % 5 === 0 || done === docs.length) {
        console.log(`[${done}/${docs.length}] FREE=${counters.free} HAIKU=${counters.haiku} PENDING=${counters.pendingHaiku} FAILED=${counters.failed} UNSUPPORTED=${counters.unsupported} | tokens in=${counters.inputTokens} out=${counters.outputTokens}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log('\n=== L1 run summary ===');
  console.log(counters);
  const estCost = (counters.inputTokens / 1e6) * 1.0 + (counters.outputTokens / 1e6) * 5.0;
  console.log(`Actual Haiku spend this run: $${estCost.toFixed(4)}`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
