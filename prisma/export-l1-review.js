// Read-only export for human review of L1/L0 results. Writes an .xlsx with
// 4 sheets. Does NOT create SkuLinks, archive, or mark duplicates -- it only
// proposes, for the user to review in Excel.
const { PrismaClient } = require('@prisma/client');
const XLSX = require('xlsx');
const prisma = new PrismaClient();

const TWO_YEARS_AGO = new Date();
TWO_YEARS_AGO.setFullYear(TWO_YEARS_AGO.getFullYear() - 2);

function productKey(manufacturer, products) {
  const m = (manufacturer || '').trim();
  const p = Array.isArray(products) && products.length ? [...products].sort().join('|') : '';
  if (!m && !p) return null;
  return `${m}::${p}`;
}
function normKind(k) { return (k || '').replace(/[״"]/g, '"'); } // merge the gershayim/ASCII-quote variant
function fmtDate(d) { return d ? new Date(d).toISOString().slice(0, 10) : ''; }
function productsStr(p) { return Array.isArray(p) ? p.join(', ') : ''; }

async function main() {
  const idents = await prisma.docIdentification.findMany();
  const docIds = idents.map(r => r.documentId);
  const docs = await prisma.document.findMany({ where: { id: { in: docIds } }, select: { id: true, title: true, docExt: true, fileUrl: true } });
  const docById = new Map(docs.map(d => [d.id, d]));

  const rows = idents.map(r => ({ ...r, docKind: normKind(r.docKind), title: docById.get(r.documentId)?.title || '', docExt: docById.get(r.documentId)?.docExt || '' }));

  // ---------- Sheet 1: ארכיון מוצע ----------
  const requestGroups = {}, certGroups = {};
  const CERT_KINDS = new Set(['תעודת רבנות', 'תעודת בד"ץ']);
  for (const r of rows) {
    const ownDate = r.validUntil || r.productionDate;
    const key = productKey(r.manufacturer, r.products);
    if (!key) continue;
    if (r.docKind === 'בקשה לרבנות') (requestGroups[key] = requestGroups[key] || []).push({ documentId: r.documentId, date: ownDate });
    else if (CERT_KINDS.has(r.docKind)) (certGroups[key] = certGroups[key] || []).push({ documentId: r.documentId, date: ownDate });
  }
  const keepIds = new Set();
  for (const groups of [requestGroups, certGroups]) {
    for (const key of Object.keys(groups)) {
      const list = groups[key].filter(g => g.date);
      if (!list.length) continue;
      list.sort((a, b) => b.date - a.date);
      keepIds.add(list[0].documentId);
    }
  }

  const archiveRows = [];
  for (const r of rows) {
    const ownDate = r.validUntil || r.productionDate;
    if (!ownDate) continue;
    if (ownDate >= TWO_YEARS_AGO) continue;
    if (r.docKind === 'תווית') continue;
    if (keepIds.has(r.documentId)) continue;
    const dateSrc = r.validUntil ? 'תוקף' : 'יצור/הנפקה';
    archiveRows.push({
      'מזהה מסמך': r.documentId,
      'כותרת': r.title,
      'סוג מסמך': r.docKind || '',
      'מספר תעודה': r.certNo || '',
      'מספר בקשה': r.requestNo || '',
      'מוצר': productsStr(r.products),
      'יצרן': r.manufacturer || '',
      'גוף כשרות': r.kashrutBody || '',
      'תאריך עצמי': fmtDate(ownDate),
      'סיבה': `תאריך ${dateSrc} (${fmtDate(ownDate)}) ישן מ-2 שנים; אינו תווית; אינו הבקשה/התעודה העדכנית ביותר עבור היצרן/המוצר הזה`,
    });
  }

  // ---------- Sheet 2: כפילויות ----------
  // Corrections from 5.11 review:
  //  1. ETag (identical-file) groups: keep the copy already linked to a SKU
  //     anywhere in the DB; if none, keep the most descriptive title (not a
  //     generic scan/email filename pattern).
  //  2. certNo/requestNo groups are NOT duplicates -- same case (cert +
  //     production report + request letter). No keep/duplicateOf recommendation;
  //     listed here for transparency only. They feed L2 as a propagation signal.
  const GENERIC_TITLE_RE = /^(re[_\s-]|צרופה|ללא[-\s]?מספר|לא[-\s]?ידוע|skm_)/i;
  function titleScore(title) {
    const t = (title || '').trim();
    if (!t) return -2000;
    return (GENERIC_TITLE_RE.test(t) ? -1000 : 0) + t.length;
  }

  const allEtagsRaw = require('fs').readFileSync(require('path').join(__dirname, '..', 'exports', 'all-doc-etags.json'), 'utf8');
  const { etagById: allEtagById, linkedIds } = JSON.parse(allEtagsRaw);
  const linkedIdSet = new Set(linkedIds);
  const allDocs = await prisma.document.findMany({ select: { id: true, title: true } });
  const titleById = new Map(allDocs.map(d => [d.id, d.title || '']));
  const allLinks = await prisma.skuLink.findMany({ where: { documentId: { not: null } }, select: { documentId: true, skuId: true } });
  const skuIdsByDoc = new Map();
  for (const l of allLinks) { if (!skuIdsByDoc.has(l.documentId)) skuIdsByDoc.set(l.documentId, new Set()); skuIdsByDoc.get(l.documentId).add(l.skuId); }
  // Group by ETag across ALL documents (not just unlinked), so an already-
  // linked copy of the same file content is visible as the keep candidate.
  const byEtagAll = {};
  for (const [docId, etag] of Object.entries(allEtagById)) { if (etag) (byEtagAll[etag] = byEtagAll[etag] || []).push(+docId); }
  const unlinkedIdsInThisBatch = new Set(rows.map(r => r.documentId));
  const etagGroupsAll = Object.entries(byEtagAll).filter(([, ids]) => ids.length > 1 && ids.some(id => unlinkedIdsInThisBatch.has(id)));

  const dupRows = [];
  dupRows.push({ 'קבוצה': '— קובץ זהה (ETag) —', 'מזהה מסמך': '', 'כותרת': '', 'המלצה': '', 'פרטים': `${etagGroupsAll.length} קבוצות` });
  let gi = 0;
  for (const [etag, ids] of etagGroupsAll) {
    gi++;
    const linkedMembers = ids.filter(id => linkedIdSet.has(id));
    const allSkuIds = new Set();
    for (const id of linkedMembers) for (const s of (skuIdsByDoc.get(id) || [])) allSkuIds.add(s);
    const multiSkuConflict = linkedMembers.length > 1 && allSkuIds.size > 1;
    let keepId = null;
    if (multiSkuConflict) {
      keepId = null; // no single "keep" -- same file content serves multiple distinct SKU links
    } else if (linkedMembers.length >= 1) {
      keepId = linkedMembers[0];
    } else {
      keepId = [...ids].sort((a, b) => titleScore(titleById.get(b)) - titleScore(titleById.get(a)) || a - b)[0];
    }
    for (const id of [...ids].sort((a, b) => a - b)) {
      const title = titleById.get(id) || '';
      const isLinkedElsewhere = linkedIdSet.has(id) && !unlinkedIdsInThisBatch.has(id);
      let recommendation;
      if (multiSkuConflict) {
        recommendation = linkedIdSet.has(id) ? `לא לאחד -- מקושר למק"ט ${[...(skuIdsByDoc.get(id) || [])].join(',')}` : 'לא לאחד -- קובץ זה משמש כמה מק"טים שונים';
      } else {
        recommendation = id === keepId ? (linkedMembers.length ? 'להשאיר (מקושר כבר למק"ט)' : 'להשאיר (כותרת מתאימה ביותר)') : `כפול של ${keepId}`;
      }
      dupRows.push({
        'קבוצה': `ETag #${gi}`,
        'מזהה מסמך': id,
        'כותרת': title,
        'המלצה': recommendation,
        'פרטים': multiSkuConflict ? 'קובץ זהה משמש כמה מק"טים -- לא כפילות, אל תמחק/תאחד' : (isLinkedElsewhere ? '[מסמך זה מקושר כבר -- לא בקבוצת המסמכים הלא-מקושרים]' : (etag.slice(0, 16) + '...')),
      });
    }
  }

  dupRows.push({ 'קבוצה': '', 'מזהה מסמך': '', 'כותרת': '', 'המלצה': '', 'פרטים': '' });
  const byCert = {};
  for (const r of rows) if (r.certNo) (byCert[r.certNo] = byCert[r.certNo] || []).push(r);
  const certGroups2 = Object.entries(byCert).filter(([, g]) => g.length > 1);
  dupRows.push({ 'קבוצה': '— מספר תעודה זהה (לא כפילות!) —', 'מזהה מסמך': '', 'כותרת': '', 'המלצה': '', 'פרטים': `${certGroups2.length} קבוצות -- אותו מקרה (תעודה/דוח/בקשה), משמש ב-L2` });
  for (const [cert, group] of certGroups2) {
    const sorted = [...group].sort((a, b) => a.documentId - b.documentId);
    for (const r of sorted) {
      dupRows.push({ 'קבוצה': `תעודה ${cert}`, 'מזהה מסמך': r.documentId, 'כותרת': r.title, 'המלצה': '(אין -- לא כפילות)', 'פרטים': r.docKind || '' });
    }
  }

  dupRows.push({ 'קבוצה': '', 'מזהה מסמך': '', 'כותרת': '', 'המלצה': '', 'פרטים': '' });
  const byReq = {};
  for (const r of rows) if (r.requestNo) (byReq[r.requestNo] = byReq[r.requestNo] || []).push(r);
  const reqGroups2 = Object.entries(byReq).filter(([, g]) => g.length > 1);
  dupRows.push({ 'קבוצה': '— מספר בקשה זהה (לא כפילות!) —', 'מזהה מסמך': '', 'כותרת': '', 'המלצה': '', 'פרטים': `${reqGroups2.length} קבוצות -- אותו מקרה (תעודה/דוח/בקשה), משמש ב-L2` });
  for (const [req, group] of reqGroups2) {
    const sorted = [...group].sort((a, b) => a.documentId - b.documentId);
    for (const r of sorted) {
      dupRows.push({ 'קבוצה': `בקשה ${req}`, 'מזהה מסמך': r.documentId, 'כותרת': r.title, 'המלצה': '(אין -- לא כפילות)', 'פרטים': r.docKind || '' });
    }
  }

  // ---------- Sheet 3: ללא תאריך ----------
  const noDateRows = rows
    .filter(r => !r.validUntil && !r.productionDate && r.source !== 'UNSUPPORTED')
    .map(r => ({
      'מזהה מסמך': r.documentId, 'כותרת': r.title, 'סוג מסמך': r.docKind || '',
      'מוצר': productsStr(r.products), 'יצרן': r.manufacturer || '',
    }));

  // ---------- Sheet 4: ללא זיהוי ----------
  const unsupportedRows = rows
    .filter(r => r.source === 'UNSUPPORTED')
    .map(r => ({ 'מזהה מסמך': r.documentId, 'כותרת': r.title, 'סוג קובץ': r.docExt || '' }));

  // ---------- Build workbook ----------
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };

  const addSheet = (name, data) => {
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = Object.keys(data[0] || { x: 1 }).map(() => ({ wch: 24 }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };

  addSheet('ארכיון מוצע', archiveRows.length ? archiveRows : [{ 'הודעה': 'אין מועמדים לארכיון כרגע' }]);
  addSheet('כפילויות', dupRows);
  addSheet('ללא תאריך', noDateRows.length ? noDateRows : [{ 'הודעה': 'אין' }]);
  addSheet('ללא זיהוי', unsupportedRows.length ? unsupportedRows : [{ 'הודעה': 'אין' }]);

  const outPath = require('path').join(__dirname, '..', 'exports', 'l1-review.xlsx');
  XLSX.writeFile(wb, outPath);
  console.log('Written:', outPath);
  console.log('ארכיון מוצע:', archiveRows.length, 'rows');
  console.log('כפילויות:', dupRows.length, 'rows (', etagGroupsAll.length, 'ETag groups +', certGroups2.length, 'cert groups +', reqGroups2.length, 'request groups )');
  console.log('ללא תאריך:', noDateRows.length, 'rows');
  console.log('ללא זיהוי:', unsupportedRows.length, 'rows');

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
