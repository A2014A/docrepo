// 5.11 item 4: FREE-sourced rows structurally never get manufacturer/
// kashrutBody/products (those are Haiku-only fields) -- isFreeComplete()
// only requires docKind + a cert/request/SKU-code + a date, not product info.
// This backfills every document (FREE or HAIKU) left with manufacturer AND
// kashrutBody AND products all empty, by calling Haiku's field-extraction
// prompt. Only fills gaps -- never overwrites a non-null value a document
// already has (docKind/certNo/requestNo/dates stay as originally determined).
const { PrismaClient } = require('@prisma/client');
const { getObjectStream } = require('../lib/r2');
const { callHaiku, ANTHROPIC_API_KEY, MODEL } = require('./_haiku-identify-lib');
const prisma = new PrismaClient();

function parseDateOrNull(s) { if (!s || typeof s !== 'string') return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; }

async function pool(items, concurrency, fn) {
  let next = 0, done = 0;
  async function worker() { while (true) { const i = next++; if (i >= items.length) return; await fn(items[i]); done++; console.log(`[${done}/${items.length}]`); } }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function main() {
  if (!ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1); }

  const all = await prisma.docIdentification.findMany({
    where: { source: { in: ['FREE', 'HAIKU'] } },
    include: { document: { select: { fileUrl: true, docExt: true } } },
  });
  let targets = all.filter(r => !r.manufacturer && !r.kashrutBody && (!r.products || (Array.isArray(r.products) && r.products.length === 0)));
  const limit = parseInt(process.env.BACKFILL_LIMIT || '0', 10);
  if (limit > 0) targets = targets.slice(0, limit);
  console.log(`Backfilling ${targets.length} documents (manufacturer+kashrutBody+products all empty) out of ${all.length} identified.${limit ? ' (BACKFILL_LIMIT=' + limit + ')' : ''}`);

  let done = 0, failed = 0, inputTokens = 0, outputTokens = 0;
  await pool(targets, 2, async (r) => {
    const ext = (r.document.docExt || '').toLowerCase();
    if (!['pdf', 'png', 'jpg', 'jpeg'].includes(ext)) return;
    let buf;
    try {
      const { stream } = await getObjectStream(r.document.fileUrl);
      const chunks = []; for await (const c of stream) chunks.push(c);
      buf = Buffer.concat(chunks);
    } catch (e) { failed++; return; }

    let mediaType = 'application/pdf';
    if (ext === 'png') mediaType = 'image/png'; else if (ext === 'jpg' || ext === 'jpeg') mediaType = 'image/jpeg';
    const contentBlock = ext === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } };

    try {
      const { parsed, usage } = await callHaiku(contentBlock);
      await prisma.docIdentification.update({
        where: { id: r.id },
        data: {
          // fill gaps only -- never overwrite a value this row already has
          docKind: r.docKind || parsed.docKind || null,
          certNo: r.certNo || parsed.certNo || null,
          requestNo: r.requestNo || parsed.requestNo || null,
          products: Array.isArray(parsed.products) && parsed.products.length ? parsed.products : undefined,
          manufacturer: parsed.manufacturer || null,
          kashrutBody: parsed.kashrutBody || null,
          track: r.track || parsed.track || null,
          validUntil: r.validUntil || parseDateOrNull(parsed.validUntil),
          productionDate: r.productionDate || parseDateOrNull(parsed.productionDate),
          lots: Array.isArray(parsed.lots) && parsed.lots.length ? parsed.lots : undefined,
          model: MODEL,
          costInputTokens: (r.costInputTokens || 0) + (usage.input_tokens || 0),
          costOutputTokens: (r.costOutputTokens || 0) + (usage.output_tokens || 0),
        },
      });
      inputTokens += usage.input_tokens || 0;
      outputTokens += usage.output_tokens || 0;
      done++;
    } catch (e) {
      failed++;
      console.error('  failed doc', r.documentId, e.message.slice(0, 150));
    }
  });

  console.log('\n=== Backfill summary ===');
  console.log('Succeeded:', done, '| Failed:', failed);
  console.log('Tokens: in=', inputTokens, 'out=', outputTokens);
  console.log('Cost: $' + ((inputTokens / 1e6) * 1.0 + (outputTokens / 1e6) * 5.0).toFixed(4));

  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
