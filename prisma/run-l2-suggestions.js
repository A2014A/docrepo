// L2 (docrepo-link-suggestions-spec.md): rules-only candidate-SKU suggestion
// engine. Reads DocIdentification + Sku + SupplierAlias; writes ONLY to
// LinkSuggestion. Never creates/touches SkuLink. No Claude API calls.
//
// Confidence (per spec):
//   CERTAIN: sig1, or (sig2 AND sig5=MATCH), or (sig3 AND sig4 AND sig5=MATCH AND sig7)
//            -- UNLESS sig5=MISMATCH (known kashrut-body conflict), which hard-caps at POSSIBLE
//            regardless of any other signal (spec: "a Landau cert never auto-matches an עדה חרדית SKU").
//   LIKELY:  sig3 AND sig5=MATCH (and not already CERTAIN, and not sig5=MISMATCH)
//   POSSIBLE: any candidate that doesn't reach the above.
//
// Signals:
//   1 SKU code found verbatim in the free text-layer scan (DocIdentification.freeSkuCodes)
//   2 certNo/requestNo case-group propagation: this document shares a certNo or
//     requestNo with another document, and that sibling independently matched this SKU
//     (per user correction 5.11: cert/production-report/request of the same case,
//     not duplicates -- a strong same-SKU signal, not a dedupe target)
//   3 product-name similarity (normalized Hebrew word overlap) vs Sku.name
//   4 manufacturer matches Sku.supplier/supplier2, directly or via SupplierAlias
//     (loose: case-insensitive, ignore legal prefixes/suffixes)
//   5 kashrut body: DocIdentification.kashrutBody (or track-aware pesachStatusRef)
//     vs Sku.kashrutBodyRef/pesachStatusRef
//   6 track (ימות השנה/פסח/פסח-קטניות) -- disambiguates which of several
//     product-matched SKU variants to prefer; annotated in `reasons`, does not
//     gate confidence on its own
//   7 pack size (gram/ל"ג/מ"ל/ליטר) does not contradict between document and Sku.name

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ---------- normalization helpers ----------

const LEGAL_SUFFIXES = /\b(LTD|LIMITED|CO|CORP|INC|PVT|PRIVATE|PLC|GMBH|AG|SRL|S\.?R\.?L|SPA|S\.?P\.?A|SA|S\.?A|BV|B\.?V|LLC|CO\.?,?\s*LTD)\.?\b/gi;
const LEGAL_PREFIXES = /^(EUR|USD|ILS)\s*-\s*/i;
function normalizeCompany(s) {
  if (!s) return '';
  let t = s.toUpperCase();
  t = t.replace(LEGAL_PREFIXES, '');
  t = t.replace(LEGAL_SUFFIXES, '');
  t = t.replace(/[.,'"״׳()-]/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}
function companiesMatch(a, b) {
  const na = normalizeCompany(a), nb = normalizeCompany(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  return false;
}

const HEB_STOPWORDS = new Set(['כהן', 'בע"מ', 'בעמ', 'חברת', 'מוצרי', 'מוצר', 'של', 'עם', 'ללא', 'וכן', 'חדש']);
function normalizeProductTokens(s) {
  if (!s) return [];
  const cleaned = s.replace(/[.,'"״׳()\/\-]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.split(' ').filter(w => w.length >= 2 && !HEB_STOPWORDS.has(w) && !/^\d+$/.test(w));
}
function productSimilarity(productText, skuName) {
  const a = new Set(normalizeProductTokens(productText));
  const b = new Set(normalizeProductTokens(skuName));
  if (!a.size || !b.size) return { match: false, shared: [] };
  const shared = [...a].filter(w => b.has(w));
  const threshold = Math.max(2, Math.ceil(Math.min(a.size, b.size) / 2));
  return { match: shared.length >= threshold, shared };
}

function decodeEntities(s) {
  return (s || '').replace(/&quot;/g, '"').replace(/&#8211;/g, '-').replace(/&amp;/g, '&');
}
const KASHRUT_HONORIFICS = /(הרב|שליט"?א|שליט״א|רב אב"?ד|רב אב״ד|רב מוכר|גוף כשרות\/?)/g;
function normalizeKashrutBody(s) {
  if (!s) return '';
  let t = decodeEntities(s);
  t = t.replace(KASHRUT_HONORIFICS, ' ');
  t = t.replace(/[.,'"״׳()]/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}
// returns 'MATCH' | 'MISMATCH' | 'UNKNOWN'
function kashrutBodyStatus(docBody, docTrack, skuBodyRef, skuPesachRef) {
  const isPassoverDoc = /פסח/.test(docTrack || '');
  const refs = [skuBodyRef, skuPesachRef].filter(Boolean);
  // If the doc is explicitly a Passover doc and the SKU has a pesach-specific body, prefer that.
  const relevantRefs = isPassoverDoc && skuPesachRef ? [skuPesachRef] : (skuBodyRef ? [skuBodyRef] : refs);
  const nb = normalizeKashrutBody(docBody);
  if (!nb || !relevantRefs.length) return 'UNKNOWN';
  for (const ref of relevantRefs) {
    const nr = normalizeKashrutBody(ref);
    if (!nr) continue;
    if (nb === nr) return 'MATCH';
    if (nb.length >= 3 && nr.length >= 3 && (nb.includes(nr) || nr.includes(nb))) return 'MATCH';
  }
  return 'MISMATCH';
}

const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(ק"?ג|קג|קילו|גרם|ג'|מ"?ל|מל|ליטר|ל'|ל\b)/;
function extractSizeGrams(text) {
  if (!text) return null;
  const m = SIZE_RE.exec(text);
  if (!m) return null;
  const val = parseFloat(m[1].replace(',', '.'));
  const unit = m[2].replace(/"/g, '');
  if (/ק.?ג|קילו/.test(unit)) return val * 1000;
  if (/גרם|ג'/.test(unit)) return val;
  if (/ל.?ט.?ר|ל'|^ל$/.test(unit)) return val * 1000; // ml-equivalent
  if (/מ.?ל/.test(unit)) return val;
  return null;
}
function sizeContradicts(productText, skuName) {
  const a = extractSizeGrams(productText);
  const b = extractSizeGrams(skuName);
  if (a == null || b == null) return false; // no info -> no contradiction
  return Math.abs(a - b) / Math.max(a, b) > 0.15; // >15% off -> contradiction
}

// ---------- main ----------

async function main() {
  const idents = await prisma.docIdentification.findMany({ where: { source: { not: 'UNSUPPORTED' } } });
  const skus = await prisma.sku.findMany({ where: { active: true } });
  const aliases = await prisma.supplierAlias.findMany();
  console.log(`Identified documents to evaluate: ${idents.length}. Active SKUs: ${skus.length}. Supplier aliases: ${aliases.length}.`);

  function manufacturerMatchesSku(manufacturer, sku) {
    if (!manufacturer) return false;
    if (companiesMatch(manufacturer, sku.supplier) || companiesMatch(manufacturer, sku.supplier2)) return true;
    for (const alias of aliases) {
      if (companiesMatch(manufacturer, alias.manufacturerName)) {
        if (companiesMatch(alias.supplierName, sku.supplier) || companiesMatch(alias.supplierName, sku.supplier2)) return true;
      }
    }
    return false;
  }

  // candidates: Map<documentId, Map<skuId, {sig1,sig2,sig3,sig4,sig5,sig6,sig7, sharedWords, groupPropagatedFrom}>>
  const candidates = new Map();
  function getCand(docId, skuId) {
    if (!candidates.has(docId)) candidates.set(docId, new Map());
    const m = candidates.get(docId);
    if (!m.has(skuId)) m.set(skuId, { sig1: false, sig2: false, sig3: false, sig4: false, sig5: 'UNKNOWN', sig6: null, sig7: true, sharedWords: [], groupPropagatedFrom: null });
    return m.get(skuId);
  }

  const skuByCode = new Map(skus.map(s => [s.code, s]));
  const productText = (r) => (Array.isArray(r.products) && r.products.length ? r.products.join(' ') : (r.docKind || ''));

  // Pass 1: direct signals (1, 3) generate candidates; then evaluate 4,5,6,7 for each.
  for (const r of idents) {
    const pText = productText(r);

    // signal 1: exact SKU code found in free text
    for (const code of (Array.isArray(r.freeSkuCodes) ? r.freeSkuCodes : [])) {
      const sku = skuByCode.get(code);
      if (sku) getCand(r.documentId, sku.id).sig1 = true;
    }

    // signal 3: product-name similarity against all active SKUs
    if (pText) {
      for (const sku of skus) {
        if (!sku.name) continue;
        const { match, shared } = productSimilarity(pText, sku.name);
        if (match) {
          const c = getCand(r.documentId, sku.id);
          c.sig3 = true;
          c.sharedWords = shared;
        }
      }
    }
  }

  // Evaluate 4, 5, 6, 7 for every candidate found so far.
  function evaluateModifiers(r, skuId, c) {
    const sku = skus.find(s => s.id === skuId);
    if (!sku) return;
    const pText = productText(r);
    c.sig4 = manufacturerMatchesSku(r.manufacturer, sku);
    c.sig5 = kashrutBodyStatus(r.kashrutBody, r.track, sku.kashrutBodyRef, sku.pesachStatusRef);
    c.sig6 = /פסח/.test(r.track || '') ? (sku.pesachStatusRef ? 'aligned (track=פסח, sku has pesach body)' : 'sku has no pesach-specific body')
           : (sku.pesachStatusRef ? 'sku is a pesach variant, doc looks year-round' : null);
    c.sig7 = !sizeContradicts(pText, sku.name);
  }
  for (const [docId, skuMap] of candidates) {
    const r = idents.find(x => x.documentId === docId);
    for (const [skuId, c] of skuMap) evaluateModifiers(r, skuId, c);
  }

  // Pass 2: certNo/requestNo group propagation (signal 2). Per 5.11 correction:
  // same certNo/requestNo = same case (cert + production report + request), NOT
  // duplicates -- propagate any candidate SKU found for one member to all members.
  function buildGroups(field) {
    const byKey = {};
    for (const r of idents) { const v = r[field]; if (v) (byKey[v] = byKey[v] || []).push(r); }
    return Object.values(byKey).filter(g => g.length > 1);
  }
  const groups = [...buildGroups('certNo'), ...buildGroups('requestNo')];
  let propagated = 0;
  for (const group of groups) {
    const unionSkuIds = new Set();
    for (const r of group) { const m = candidates.get(r.documentId); if (m) for (const skuId of m.keys()) unionSkuIds.add(skuId); }
    for (const r of group) {
      for (const skuId of unionSkuIds) {
        const existed = candidates.has(r.documentId) && candidates.get(r.documentId).has(skuId);
        const c = getCand(r.documentId, skuId);
        if (!c.sig2) propagated++;
        c.sig2 = true;
        if (!existed) { c.groupPropagatedFrom = group.find(g => g.documentId !== r.documentId && candidates.get(g.documentId)?.has(skuId))?.documentId || null; evaluateModifiers(r, skuId, c); }
      }
    }
  }
  console.log(`Case-group propagation (certNo/requestNo): ${groups.length} groups, ${propagated} new sig2 candidate-flags set.`);

  // Confidence + persist
  const counts = { CERTAIN: 0, LIKELY: 0, POSSIBLE: 0, none: 0 };
  let written = 0;
  const docsWithAnyCandidate = new Set();

  for (const [docId, skuMap] of candidates) {
    for (const [skuId, c] of skuMap) {
      docsWithAnyCandidate.add(docId);
      let confidence;
      const bodyMismatch = c.sig5 === 'MISMATCH';
      const bodyMatch = c.sig5 === 'MATCH';
      const certain = c.sig1 || (c.sig2 && bodyMatch) || (c.sig3 && c.sig4 && bodyMatch && c.sig7);
      const likely = !certain && c.sig3 && bodyMatch;
      if (bodyMismatch) confidence = 'POSSIBLE'; // hard cap, overrides everything else
      else if (certain) confidence = 'CERTAIN';
      else if (likely) confidence = 'LIKELY';
      else confidence = 'POSSIBLE';

      counts[confidence]++;
      const reasons = {
        sig1_sku_code_in_text: c.sig1,
        sig2_same_case_group: c.sig2,
        sig2_propagated_from_doc: c.groupPropagatedFrom,
        sig3_product_similarity: c.sig3,
        sig3_shared_words: c.sharedWords,
        sig4_manufacturer_match: c.sig4,
        sig5_kashrut_body: c.sig5,
        sig6_track_note: c.sig6,
        sig7_pack_size_ok: c.sig7,
      };
      await prisma.linkSuggestion.upsert({
        where: { documentId_skuId: { documentId: docId, skuId } },
        create: { documentId: docId, skuId, confidence, reasons },
        update: { confidence, reasons },
      });
      written++;
    }
  }
  counts.none = idents.length - docsWithAnyCandidate.size;

  console.log('\n=== L2 run summary ===');
  console.log(`LinkSuggestion rows written: ${written}`);
  console.log(`Documents with >=1 candidate: ${docsWithAnyCandidate.size} / ${idents.length}`);
  console.log(`Documents with NO candidate at all: ${counts.none}`);
  console.log(`By confidence (counts are SUGGESTION rows, a document can have several): CERTAIN=${counts.CERTAIN} LIKELY=${counts.LIKELY} POSSIBLE=${counts.POSSIBLE}`);

  // Per-document best confidence (useful summary: how many documents have at least one CERTAIN, etc.)
  const bestPerDoc = { CERTAIN: 0, LIKELY: 0, POSSIBLE: 0 };
  for (const [docId, skuMap] of candidates) {
    let best = null;
    for (const [, c] of skuMap) {
      const conf = c.sig5 === 'MISMATCH' ? 'POSSIBLE' : (c.sig1 || (c.sig2 && c.sig5 === 'MATCH') || (c.sig3 && c.sig4 && c.sig5 === 'MATCH' && c.sig7)) ? 'CERTAIN' : (c.sig3 && c.sig5 === 'MATCH') ? 'LIKELY' : 'POSSIBLE';
      if (!best || rank(conf) > rank(best)) best = conf;
    }
    if (best) bestPerDoc[best]++;
  }
  function rank(x) { return { CERTAIN: 3, LIKELY: 2, POSSIBLE: 1 }[x] || 0; }
  console.log(`\nPer-document best confidence: CERTAIN=${bestPerDoc.CERTAIN} LIKELY=${bestPerDoc.LIKELY} POSSIBLE=${bestPerDoc.POSSIBLE} none=${counts.none}`);

  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
