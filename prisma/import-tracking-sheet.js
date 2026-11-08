// L2 item 9: read-only, re-runnable import of the two tracking-sheet CSVs
// (docrepo/imports/requests.csv, docrepo/imports/rabbinate-certs.csv) into
// TrackingSheetMap. No Google credentials -- plain local files. Re-running
// after replacing a CSV wipes that file's old rows and reinserts fresh ones.
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const IMPORTS_DIR = path.join(__dirname, '..', 'imports');

// RFC4180 CSV line parser: handles "" escaped quotes and commas inside quoted fields.
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

function toDate(s) {
  if (!s || !s.trim()) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
  return isNaN(d.getTime()) ? null : d;
}
function splitSkuList(s) {
  if (!s || !s.trim()) return null;
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

async function importCertsFile() {
  const filePath = path.join(IMPORTS_DIR, 'rabbinate-certs.csv');
  if (!fs.existsSync(filePath)) { console.log('rabbinate-certs.csv not found -- skipped.'); return 0; }
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  const header = rows[0];
  const col = (name) => header.indexOf(name);
  const iCert = col("מס' תעודה"), iProduct = col('מוצר'), iBody = col('גוף כשרות'),
    iMfr = col('יצרן (אנגלית)'), iTrack = col('לימות השנה / פסח'), iValid = col('תוקף'),
    iLots = col('קודי ייצור ותאריכים'), iCertain = col('מקטים מותאמים (ודאי)'), iPossible = col('מקטים מועמדים (לבדיקה)');

  await prisma.trackingSheetMap.deleteMany({ where: { sourceFile: 'rabbinate-certs.csv' } });
  let inserted = 0, skippedNoCert = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const refNumber = (r[iCert] || '').trim();
    if (!refNumber) { skippedNoCert++; continue; }
    await prisma.trackingSheetMap.create({ data: {
      kind: 'CERT', refNumber,
      product: r[iProduct] || null, kashrutBody: r[iBody] || null, manufacturer: r[iMfr] || null,
      track: r[iTrack] || null, validUntil: toDate(r[iValid]), lotCodes: r[iLots] || null,
      certainSkuCodes: splitSkuList(r[iCertain]), possibleSkuCodes: splitSkuList(r[iPossible]),
      sourceFile: 'rabbinate-certs.csv', rawRow: r,
    }});
    inserted++;
  }
  console.log(`rabbinate-certs.csv: ${inserted} rows imported, ${skippedNoCert} skipped (no cert number).`);
  return inserted;
}

async function importRequestsFile() {
  const filePath = path.join(IMPORTS_DIR, 'requests.csv');
  if (!fs.existsSync(filePath)) { console.log('requests.csv not found -- skipped (place it in docrepo/imports/ and re-run to import).'); return 0; }
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  const header = rows[0];
  const col = (name) => header.indexOf(name);
  const iRef = col('סימוכין'), iSubmitted = col('תאריך הגשה'), iStatus = col('סטטוס בקשה'),
    iType = col('סוג הבקשה'), iMfr = col('יצרן (אנגלית)'), iBody = col('גוף כשרות'),
    iProduct = col('מוצר (עברית)'), iBarcode = col('ברקוד'), iLot = col('קוד ייצור (LOT)'),
    iCertNo = col('מספר תעודת רבנות'), iCertValid = col('תוקף תעודת רבנות'), iSku = col('מק"ט');

  await prisma.trackingSheetMap.deleteMany({ where: { sourceFile: 'requests.csv' } });
  let inserted = 0, skippedNoRef = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const refNumber = (r[iRef] || '').trim();
    if (!refNumber) { skippedNoRef++; continue; }
    const sku = (r[iSku] || '').trim();
    await prisma.trackingSheetMap.create({ data: {
      kind: 'REQUEST', refNumber,
      product: r[iProduct] || null, kashrutBody: r[iBody] || null, manufacturer: r[iMfr] || null,
      track: r[iType] || null, validUntil: toDate(r[iCertValid]), lotCodes: r[iLot] || null,
      certainSkuCodes: sku ? [sku] : null,
      linkedCertNo: r[iCertNo] || null, barcode: r[iBarcode] || null,
      requestStatus: r[iStatus] || null, submittedDate: toDate(r[iSubmitted]),
      sourceFile: 'requests.csv', rawRow: r,
    }});
    inserted++;
  }
  console.log(`requests.csv: ${inserted} rows imported, ${skippedNoRef} skipped (no request number).`);
  return inserted;
}

async function main() {
  const certs = await importCertsFile();
  const requests = await importRequestsFile();
  const total = await prisma.trackingSheetMap.count();
  console.log(`\nTotal TrackingSheetMap rows now: ${total} (certs: ${certs}, requests: ${requests})`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
