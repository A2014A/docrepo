// Shared free-extraction heuristics (pdf-parse text layer + regex, no AI
// call). Used by run-l1-identification.js (main pipeline) and
// fix-sig1-recompute.js (targeted correction re-run) -- kept in one module
// so both always apply the exact same rules.

const DATE_RE = /\b(\d{1,2})[./](\d{1,2})[./](\d{2,4})\b/g;
const VALID_UNTIL_KEYWORDS = /(תוקף|בתוקף עד|valid until|valid through|expiry)/i;
const PRODUCTION_KEYWORDS = /(תאריך הנפקה|תאריך ייצור|production date|date of issue|manufactured)/i;
// \b on every \d{5,6} -- without it the engine can carve a 6-digit substring
// out of the middle of a longer run (e.g. a 9-digit company ID), which is
// exactly the bug that produced a bogus 237-doc "duplicate requestNo" cluster
// on the first run (matched inside "...ח.פ. 512404104...").
const CERT_KEYWORD_RE = /(?:תעודה|מס['׳]?\s*תעודה)[^\d]{0,15}\b(\d{5,6})\b|\b(\d{5,6})\b[^\d]{0,15}(?:תעודה)/;
const REQUEST_KEYWORD_RE = /(?:בקשה|מס['׳]?\s*בקשה|בסימוכין)[^\d]{0,15}\b(\d{5,6})\b|\b(\d{5,6})\b[^\d]{0,15}(?:בקשה|בסימוכין)/;

// 5.11 correction: a 5-6 digit number next to a quantity/unit word is a
// measurement (carton count, weight, size), not a SKU-code reference, even
// though it passes the \b...\b boundary check -- e.g. "משקל כולל 11080.80
// ק"ג" (total weight 11080.80 kg) on a tortilla production report was
// wrongly read as SKU 11080 (turmeric).
const QUANTITY_UNIT_RE = /(קרטונים|קרטון|יח['׳]|יחיד(?:ה|ות)|ק["׳]?ג|קילו|גרם|ס["׳]?מ|מ["׳]?מ|מ["׳]?ל|ליטר|מטר|חבילות|חבילה|אריזות|אריזה|בקבוק(?:ים)?|שק(?:ים)?)/;
function isNearQuantityWord(text, index, matchLength) {
  const before = text.slice(Math.max(0, index - 20), index);
  const after = text.slice(index + matchLength, index + matchLength + 20);
  return QUANTITY_UNIT_RE.test(before) || QUANTITY_UNIT_RE.test(after);
}

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
    for (const m of text.matchAll(/\b\d{5,6}\b/g)) {
      if (!isNearQuantityWord(text, m.index, m[0].length)) { result.freeCertCandidate = m[0]; break; }
    }
  }

  result.validUntil = extractDateNear(text, VALID_UNTIL_KEYWORDS);
  result.productionDate = extractDateNear(text, PRODUCTION_KEYWORDS);

  const skuCodeMatches = [];
  for (const m of text.matchAll(/\b\d{5,6}\b/g)) {
    if (skuCodeSet.has(m[0]) && !isNearQuantityWord(text, m.index, m[0].length)) skuCodeMatches.push(m[0]);
  }
  result.freeSkuCodes = [...new Set(skuCodeMatches)];

  return result;
}

module.exports = { freeExtract, isNearQuantityWord, QUANTITY_UNIT_RE, DOC_KIND_RULES };
