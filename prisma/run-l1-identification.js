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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';

const FIELD_INSTRUCTIONS = `אתה מסייע לארכיון מסמכי כשרות של חברת יבוא מזון ישראלית.

קרא את המסמך המצורף בקפידה וענה בדיוק בפורמט JSON הבא בלבד, ללא הסברים נוספים:
{
  "docKind": "סוג המסמך -- אחד מ: תעודת רבנות / תעודת בד\\"ץ / בקשה לרבנות / דוח ייצור / תווית / מכתב / חשבונית / אחר",
  "certNo": "מספר תעודה אם מופיע, אחרת null",
  "requestNo": "מספר בקשה אם מופיע, אחרת null",
  "products": ["שמות המוצרים המופיעים במסמך, כפי שכתובים"],
  "manufacturer": "שם היצרן אם מופיע, אחרת null",
  "kashrutBody": "גוף הכשרות המנפיק (למשל בד\\"ץ עדה חרדית, הרבנות הראשית וכו') אם מופיע, אחרת null",
  "track": "ימות השנה / פסח / פסח-קטניות -- רק אם מצוין במסמך, אחרת null",
  "validUntil": "תאריך תוקף בפורמט YYYY-MM-DD, אחרת null",
  "productionDate": "תאריך יצור/הנפקה בפורמט YYYY-MM-DD, אחרת null",
  "lots": ["מספרי אצווה/LOT אם מופיעים"]
}
הנחיות: המר תאריכים מ-DD/MM/YYYY או MM/DD/YYYY לפורמט YYYY-MM-DD. אם שדה אינו גלוי במסמך -- ערכו null. אל תנחש לעולם.
חשוב לתקינות ה-JSON: בתוך מחרוזות (למשל שמות רבנים/גופי כשרות), אם יש קיצור עברי עם גרש או גרשיים (כגון שליט"א, בד"ץ, אב"ד) -- השתמש בתו הגרשיים העברי ״ (Unicode U+05F4) ולא במירכאות ASCII רגילות ("), כדי שהמחרוזת תישאר תקינה כ-JSON.
ענה רק ב-JSON.`;

// ---------- free-extraction heuristics ----------

const DATE_RE = /\b(\d{1,2})[./](\d{1,2})[./](\d{2,4})\b/g;
const VALID_UNTIL_KEYWORDS = /(תוקף|בתוקף עד|valid until|valid through|expiry)/i;
const PRODUCTION_KEYWORDS = /(תאריך הנפקה|תאריך ייצור|production date|date of issue|manufactured)/i;
// \b on every \d{5,6} -- without it the engine can carve a 6-digit substring
// out of the middle of a longer run (e.g. a 9-digit company ID), which is
// exactly the bug that produced a bogus 237-doc "duplicate requestNo" cluster
// on the first run (matched inside "...ח.פ. 512404104...").
const CERT_KEYWORD_RE = /(?:תעודה|מס['׳]?\s*תעודה)[^\d]{0,15}\b(\d{5,6})\b|\b(\d{5,6})\b[^\d]{0,15}(?:תעודה)/;
const REQUEST_KEYWORD_RE = /(?:בקשה|מס['׳]?\s*בקשה|בסימוכין)[^\d]{0,15}\b(\d{5,6})\b|\b(\d{5,6})\b[^\d]{0,15}(?:בקשה|בסימוכין)/;

const DOC_KIND_RULES = [
  [/בד["׳]?ץ/, 'תעודת בד"ץ'],
  [/תעודת\s*רבנות|הרבנות\s*הראשית.*תעודה/, 'תעודת רבנות'],
  [/אישור קבלת הבקשה|בקשתך מתאריך|בקשה לרבנות/, 'בקשה לרבנות'],
  [/דוח\s*ייצור|production report/i, 'דוח ייצור'],
  [/תווית|label/i, 'תווית'],
  [/חשבונית|invoice/i, 'חשבונית'],
];

function toIsoDate(d, m, y) {
  if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
  const day = d.padStart(2, '0'), month = m.padStart(2, '0');
  if (+month > 12 || +day > 31) return null;
  return `${y}-${month}-${day}`;
}

function extractDateNear(text, keywordRe) {
  const idx = text.search(keywordRe);
  if (idx === -1) return null;
  const window = text.slice(Math.max(0, idx - 60), idx + 60);
  const m = DATE_RE.exec(window);
  DATE_RE.lastIndex = 0;
  if (!m) return null;
  return toIsoDate(m[1], m[2], m[3]);
}

function freeExtract(text, skuCodeSet) {
  const result = { docKind: null, certNo: null, requestNo: null, validUntil: null, productionDate: null, freeSkuCodes: [], freeCertCandidate: null };
  if (!text || text.length < 20) return result;

  for (const [re, kind] of DOC_KIND_RULES) {
    if (re.test(text)) { result.docKind = kind; break; }
  }

  const certM = CERT_KEYWORD_RE.exec(text);
  if (certM) result.certNo = certM[1] || certM[2] || null;
  const reqM = REQUEST_KEYWORD_RE.exec(text);
  if (reqM) result.requestNo = reqM[1] || reqM[2] || null;
  if (!result.certNo && !result.requestNo) {
    const anyNum = text.match(/\b\d{5,6}\b/);
    if (anyNum) result.freeCertCandidate = anyNum[0];
  }

  result.validUntil = extractDateNear(text, VALID_UNTIL_KEYWORDS);
  result.productionDate = extractDateNear(text, PRODUCTION_KEYWORDS);

  const numbersInText = text.match(/\b\d{5,6}\b/g) || [];
  result.freeSkuCodes = [...new Set(numbersInText.filter(n => skuCodeSet.has(n)))];

  return result;
}

function isFreeComplete(f) {
  const hasProduct = !!f.certNo || !!f.requestNo || f.freeSkuCodes.length > 0;
  const hasDate = !!f.validUntil || !!f.productionDate;
  return !!f.docKind && hasProduct && hasDate;
}

// Safety net: a stray literal " inside a string value (e.g. Hebrew שליט"א)
// breaks JSON.parse even though the prompt asks the model to use ״ instead.
// Single-pass state machine: track whether we're inside a string; a `"`
// closes the string only if, after skipping whitespace, the next char is
// a real JSON structural character (: , } ] or end of text) -- otherwise
// it's a stray content quote, replaced with the Hebrew gershayim ״.
function repairStrayQuotes(text) {
  let inString = false;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '"') { out += ch; continue; }
    if (!inString) { inString = true; out += '"'; continue; }
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    const next = text[j];
    if (next === ':' || next === ',' || next === '}' || next === ']' || j === text.length) {
      inString = false;
      out += '"';
    } else {
      out += '״';
    }
  }
  return out;
}

// ---------- Haiku call ----------

async function callHaiku(contentBlock) {
  const body = {
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: 'text', text: FIELD_INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [contentBlock] }],
  };
  const headers = { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };
  if (contentBlock.type === 'document') headers['anthropic-beta'] = 'pdfs-2024-09-25';
  const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
  const text = (data.content?.find(c => c.type === 'text')?.text || '').replace(/```json|```/g, '').trim();
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    try {
      parsed = JSON.parse(repairStrayQuotes(text));
    } catch (e2) {
      throw new Error(`JSON parse failed (stop_reason=${data.stop_reason}, text length=${text.length}): ${text.slice(0, 1500)}`);
    }
  }
  return { parsed, usage: data.usage || {} };
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
