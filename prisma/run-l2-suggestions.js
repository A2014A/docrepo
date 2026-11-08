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
//   7 pack size (gram/ק"ג/מ"ל/ליטר/ס"מ) does not contradict between document and
//     Sku.name -- dimension-aware (weight/volume/length never cross-compared),
//     and checks every size mentioned in the text, not just the first
//   9 tracking sheet (TrackingSheetMap, item 9): human-curated requests.csv /
//     rabbinate-certs.csv rows map request/cert numbers straight to SKUs.
//     Unconditional CERTAIN when it fires -- not subject to the sig5-mismatch
//     cap, since this is ground-truth data, not a heuristic. Reported
//     separately from the other signals (see the run's final summary).

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
// 5.11 item 3 fix: Hebrew plene/defective spelling (e.g. "טורטייה" vs
// "טורטיה") is extremely common between a free-text document and a terse
// SKU name, and an exact-token Set comparison misses it completely.
// Collapse doubled י/ו (the two matres lectionis prone to this variation)
// to a single letter so both spellings normalize to the same token.
function collapseMatres(w) { return w.replace(/יי+/g, 'י').replace(/וו+/g, 'ו'); }
function normalizeProductTokens(s) {
  if (!s) return [];
  const cleaned = s.replace(/[.,'"״׳()\/\-]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.split(' ').filter(w => w.length >= 2 && !HEB_STOPWORDS.has(w) && !/^\d+$/.test(w)).map(collapseMatres);
}
// wordFreq: Map<token, number of distinct SKU names containing it> -- a
// single shared word only counts as a match on its own when it's RARE
// across the catalog (a real product-identity word like "טורטיה"), not
// when it's common (a generic descriptor shared by many unrelated SKUs).
// The first attempt allowed any word >=4 chars, which exploded candidate
// counts catalog-wide (18,163 vs 2,720 propagated flags) because many
// ordinary 4-5 char Hebrew words are common across unrelated products.
function productSimilarity(productText, skuName, wordFreq) {
  const a = new Set(normalizeProductTokens(productText));
  const b = new Set(normalizeProductTokens(skuName));
  if (!a.size || !b.size) return { match: false, shared: [] };
  const shared = [...a].filter(w => b.has(w));
  const RARE_MAX = 15;
  const threshold = shared.some(w => w.length >= 5 && (wordFreq.get(w) || 0) <= RARE_MAX)
    ? 1 : Math.max(2, Math.ceil(Math.min(a.size, b.size) / 2));
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

// 5.11 item 3: pack size must be dimension-aware -- weight (g), volume (ml),
// and length (mm, e.g. tortilla diameter in ס"מ) are different physical
// dimensions and must never be compared to one another. A document can also
// state several sizes of the same dimension (e.g. a production report
// covering both the 20cm and 30cm tortilla) -- every occurrence is scanned,
// not just the first, so each candidate SKU is checked against the specific
// size(s) actually present for its own dimension.
// Quote class includes ״ (gershayim, U+05F4) -- the L1 Haiku prompt tells the
// model to write Hebrew abbreviations with gershayim instead of ASCII "
// (JSON-safety fix from item 2), so units like ס״מ now arrive that way.
// Missing it here silently broke every size extraction on Haiku-sourced text.
const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(ק["׳״]?ג|קג|קילו|גרם|ג['׳]|מ["׳״]?ל|מל|ליטר|ל['׳]|ס["׳״]?מ|מ["׳״]?מ|מטר)/g;
function classifySize(valueStr, unitRaw) {
  const val = parseFloat(valueStr.replace(',', '.'));
  const unit = unitRaw.replace(/["׳״]/g, '');
  if (/^ק\.?ג$|^קג$|קילו/.test(unit)) return { dim: 'weight', norm: val * 1000 }; // normalized to grams
  if (/^גרם$|^ג['׳]?$/.test(unit)) return { dim: 'weight', norm: val };
  if (/^ליטר$|^ל['׳]?$/.test(unit)) return { dim: 'volume', norm: val * 1000 }; // normalized to ml
  if (/^מ\.?ל$|^מל$/.test(unit)) return { dim: 'volume', norm: val };
  if (/^ס\.?מ$/.test(unit)) return { dim: 'length', norm: val * 10 }; // normalized to mm
  if (/^מ\.?מ$/.test(unit)) return { dim: 'length', norm: val };
  if (/^מטר$/.test(unit)) return { dim: 'length', norm: val * 1000 };
  return null;
}
function extractAllSizes(text) {
  if (!text) return [];
  const out = [];
  for (const m of text.matchAll(SIZE_RE)) {
    const c = classifySize(m[1], m[2]);
    if (c) out.push(c);
  }
  return out;
}
function sizeContradicts(productText, skuName) {
  const skuSizes = extractAllSizes(skuName);
  if (!skuSizes.length) return false; // SKU name states no size -> nothing to contradict
  const skuSize = skuSizes[0]; // SKU names have one defining size
  const docSizesSameDim = extractAllSizes(productText).filter(s => s.dim === skuSize.dim);
  if (!docSizesSameDim.length) return false; // document never mentions this dimension -> no info, neutral
  // Contradiction only if the document DOES enumerate sizes of this dimension
  // and NONE of them match this SKU's size (e.g. doc lists 20cm+30cm, SKU is 15cm).
  return !docSizesSameDim.some(d => Math.abs(d.norm - skuSize.norm) / Math.max(d.norm, skuSize.norm) <= 0.1);
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
    if (!m.has(skuId)) m.set(skuId, { sig1: false, sig2: false, sig3: false, sig4: false, sig5: 'UNKNOWN', sig6: null, sig7: true, sharedWords: [], groupPropagatedFrom: null, sig9TrackingSheet: null, sig9TrackingPossible: null });
    return m.get(skuId);
  }

  const skuByCode = new Map(skus.map(s => [s.code, s]));
  const productText = (r) => (Array.isArray(r.products) && r.products.length ? r.products.join(' ') : (r.docKind || ''));

  const wordFreq = new Map();
  for (const sku of skus) {
    if (!sku.name) continue;
    for (const w of new Set(normalizeProductTokens(sku.name))) wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
  }

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
        const { match, shared } = productSimilarity(pText, sku.name, wordFreq);
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

  // ---------- 5.11 item 9: tracking-sheet signal (human-curated, strongest) ----------
  // requests.csv (סימוכין) and rabbinate-certs.csv (מס' תעודה) map request/cert
  // numbers straight to SKUs. A request row's "מספר תעודת רבנות" links it to the
  // cert it produced -- both share the same SKUs, so their candidate sets merge.
  const sheetRows = await prisma.trackingSheetMap.findMany();
  const certainByRequestRef = new Map(); // refNumber -> Set<skuCode>
  const certainByCertRef = new Map();
  const possibleByCertRef = new Map();
  for (const row of sheetRows) {
    const codes = Array.isArray(row.certainSkuCodes) ? row.certainSkuCodes : [];
    const target = row.kind === 'REQUEST' ? certainByRequestRef : certainByCertRef;
    if (codes.length) { if (!target.has(row.refNumber)) target.set(row.refNumber, new Set()); for (const c of codes) target.get(row.refNumber).add(c); }
    if (row.kind === 'CERT' && Array.isArray(row.possibleSkuCodes) && row.possibleSkuCodes.length) {
      if (!possibleByCertRef.has(row.refNumber)) possibleByCertRef.set(row.refNumber, new Set());
      for (const c of row.possibleSkuCodes) possibleByCertRef.get(row.refNumber).add(c);
    }
  }
  // request <-> linked cert: merge each pair's CERTAIN sets both ways.
  for (const row of sheetRows) {
    if (row.kind !== 'REQUEST' || !row.linkedCertNo) continue;
    const reqSet = certainByRequestRef.get(row.refNumber);
    const certSet = certainByCertRef.get(row.linkedCertNo);
    if (reqSet && certSet) { for (const c of certSet) reqSet.add(c); for (const c of reqSet) certSet.add(c); }
    else if (certSet && !reqSet) certainByRequestRef.set(row.refNumber, new Set(certSet));
    else if (reqSet && !certSet) certainByCertRef.set(row.linkedCertNo, new Set(reqSet));
  }
  console.log(`Tracking sheet loaded: ${sheetRows.length} rows (${certainByRequestRef.size} request refs, ${certainByCertRef.size} cert refs with CERTAIN SKUs, ${possibleByCertRef.size} cert refs with POSSIBLE SKUs).`);

  let trackingCertainCount = 0, trackingPossibleCount = 0;
  const trackingCertainDocs = new Set();
  for (const r of idents) {
    const grants = []; // {codes, reason}
    if (r.requestNo && certainByRequestRef.has(r.requestNo)) grants.push({ codes: certainByRequestRef.get(r.requestNo), reason: 'גיליון המעקב – בקשה', level: 'CERTAIN' });
    if (r.certNo && certainByCertRef.has(r.certNo)) grants.push({ codes: certainByCertRef.get(r.certNo), reason: 'גיליון המעקב – תעודה', level: 'CERTAIN' });
    if (r.certNo && possibleByCertRef.has(r.certNo)) grants.push({ codes: possibleByCertRef.get(r.certNo), reason: 'גיליון המעקב – מועמד לבדיקה', level: 'POSSIBLE' });
    for (const g of grants) {
      for (const code of g.codes) {
        const sku = skuByCode.get(code);
        if (!sku) continue;
        const c = getCand(r.documentId, sku.id);
        if (g.level === 'CERTAIN') {
          if (!c.sig9TrackingSheet) trackingCertainCount++;
          c.sig9TrackingSheet = g.reason;
          trackingCertainDocs.add(r.documentId);
        } else if (!c.sig9TrackingSheet) {
          c.sig9TrackingPossible = g.reason;
          trackingPossibleCount++;
        }
      }
    }
  }
  console.log(`Tracking-sheet signal: ${trackingCertainCount} CERTAIN candidate-flags across ${trackingCertainDocs.size} documents (+ ${trackingPossibleCount} POSSIBLE-only candidate-flags).`);

  // Confidence + persist (batched -- one-by-one upserts took 10+ minutes and
  // got killed at this candidate volume; batch into $transaction chunks)
  const counts = { CERTAIN: 0, LIKELY: 0, POSSIBLE: 0, none: 0 };
  let written = 0;
  const docsWithAnyCandidate = new Set();
  const pendingOps = [];

  for (const [docId, skuMap] of candidates) {
    for (const [skuId, c] of skuMap) {
      docsWithAnyCandidate.add(docId);
      let confidence;
      const bodyMismatch = c.sig5 === 'MISMATCH';
      const bodyMatch = c.sig5 === 'MATCH';
      // sig7===false means a real detected contradiction (sizeContradicts()
      // already treats "no size info" as no-contradiction/true) -- per item 3,
      // a document that states specific sizes and excludes this SKU's size
      // (e.g. doc mentions 20cm+30cm tortillas, SKU is 15cm) should be capped
      // the same way a kashrut-body mismatch is, not just blocked from CERTAIN.
      const sizeMismatch = c.sig7 === false;
      const certain = c.sig1 || (c.sig2 && bodyMatch) || (c.sig3 && c.sig4 && bodyMatch && c.sig7);
      const likely = !certain && c.sig3 && bodyMatch;
      if (c.sig9TrackingSheet) confidence = 'CERTAIN'; // human-curated tracking sheet -- unconditional, not subject to any cap
      else if (bodyMismatch || sizeMismatch) confidence = 'POSSIBLE'; // hard cap, overrides everything else
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
        sig9_tracking_sheet: c.sig9TrackingSheet,
        sig9_tracking_sheet_possible: c.sig9TrackingPossible,
      };
      pendingOps.push(prisma.linkSuggestion.upsert({
        where: { documentId_skuId: { documentId: docId, skuId } },
        create: { documentId: docId, skuId, confidence, reasons },
        update: { confidence, reasons },
      }));
      written++;
    }
  }
  const BATCH_SIZE = 200;
  for (let i = 0; i < pendingOps.length; i += BATCH_SIZE) {
    await prisma.$transaction(pendingOps.slice(i, i + BATCH_SIZE), { timeout: 30000, maxWait: 10000 });
    console.log(`  persisted ${Math.min(i + BATCH_SIZE, pendingOps.length)}/${pendingOps.length}`);
  }
  counts.none = idents.length - docsWithAnyCandidate.size;

  // Stale-row cleanup: a (document, sku) pair that qualified as a candidate
  // in an earlier run but no longer does (e.g. a signal fix removed it, like
  // the sig1 quantity-word exclusion) stays in the table forever unless
  // explicitly deleted here -- upsert only touches CURRENT candidates. Only
  // PENDING rows are removed; a human APPROVED/REJECTED decision is never
  // silently erased by a re-run.
  const evaluatedDocIds = idents.map(r => r.documentId);
  const existingPending = await prisma.linkSuggestion.findMany({
    where: { documentId: { in: evaluatedDocIds }, status: 'PENDING' },
    select: { id: true, documentId: true, skuId: true },
  });
  const staleIds = existingPending
    .filter(row => !(candidates.get(row.documentId) && candidates.get(row.documentId).has(row.skuId)))
    .map(row => row.id);
  if (staleIds.length) {
    await prisma.linkSuggestion.deleteMany({ where: { id: { in: staleIds } } });
  }
  console.log(`Stale PENDING suggestions removed (no longer qualify as a candidate): ${staleIds.length}`);

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
      const conf = c.sig9TrackingSheet ? 'CERTAIN' : (c.sig5 === 'MISMATCH' || c.sig7 === false) ? 'POSSIBLE' : (c.sig1 || (c.sig2 && c.sig5 === 'MATCH') || (c.sig3 && c.sig4 && c.sig5 === 'MATCH' && c.sig7)) ? 'CERTAIN' : (c.sig3 && c.sig5 === 'MATCH') ? 'LIKELY' : 'POSSIBLE';
      if (!best || rank(conf) > rank(best)) best = conf;
    }
    if (best) bestPerDoc[best]++;
  }
  function rank(x) { return { CERTAIN: 3, LIKELY: 2, POSSIBLE: 1 }[x] || 0; }
  console.log(`\nPer-document best confidence: CERTAIN=${bestPerDoc.CERTAIN} LIKELY=${bestPerDoc.LIKELY} POSSIBLE=${bestPerDoc.POSSIBLE} none=${counts.none}`);

  // How many documents reached CERTAIN via the tracking sheet specifically,
  // vs. how many would have been CERTAIN anyway from the other signals --
  // reported separately per item 9's request.
  let certainOnlyViaTrackingSheet = 0, certainViaTrackingSheetAndOther = 0;
  for (const docId of trackingCertainDocs) {
    const skuMap = candidates.get(docId);
    let hasTrackingCertain = false, hasOtherCertain = false;
    for (const [, c] of skuMap) {
      if (c.sig9TrackingSheet) hasTrackingCertain = true;
      const bodyMatch = c.sig5 === 'MATCH';
      if (c.sig1 || (c.sig2 && bodyMatch) || (c.sig3 && c.sig4 && bodyMatch && c.sig7)) hasOtherCertain = true;
    }
    if (hasTrackingCertain && hasOtherCertain) certainViaTrackingSheetAndOther++;
    else if (hasTrackingCertain) certainOnlyViaTrackingSheet++;
  }
  console.log(`\nTracking-sheet signal (item 9), reported separately:`);
  console.log(`  Documents with >=1 CERTAIN suggestion from the tracking sheet: ${trackingCertainDocs.size}`);
  console.log(`    - of which CERTAIN ONLY because of the tracking sheet (no other signal would have reached CERTAIN): ${certainOnlyViaTrackingSheet}`);
  console.log(`    - of which ALSO CERTAIN via another signal independently: ${certainViaTrackingSheetAndOther}`);

  // Item 6: per-document CERTAIN-vs-lower breakdown; top 10 by CERTAIN count.
  const perDocBreakdown = [];
  for (const [docId, skuMap] of candidates) {
    let cCertain = 0, cLower = 0;
    for (const [, c] of skuMap) {
      const conf = c.sig9TrackingSheet ? 'CERTAIN' : (c.sig5 === 'MISMATCH' || c.sig7 === false) ? 'POSSIBLE' : (c.sig1 || (c.sig2 && c.sig5 === 'MATCH') || (c.sig3 && c.sig4 && c.sig5 === 'MATCH' && c.sig7)) ? 'CERTAIN' : (c.sig3 && c.sig5 === 'MATCH') ? 'LIKELY' : 'POSSIBLE';
      if (conf === 'CERTAIN') cCertain++; else cLower++;
    }
    perDocBreakdown.push({ documentId: docId, certain: cCertain, lower: cLower, total: cCertain + cLower });
  }
  perDocBreakdown.sort((a, b) => b.certain - a.certain);
  console.log(`\n=== Item 6: top 10 documents by CERTAIN suggestion count ===`);
  const top10 = perDocBreakdown.slice(0, 10);
  const top10Docs = await prisma.document.findMany({ where: { id: { in: top10.map(t => t.documentId) } }, select: { id: true, title: true } });
  const titleById6 = new Map(top10Docs.map(d => [d.id, d.title || '']));
  for (const t of top10) console.log(`  doc ${t.documentId} "${(titleById6.get(t.documentId) || '').slice(0, 60)}": CERTAIN=${t.certain}, lower=${t.lower}, total=${t.total}`);

  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
