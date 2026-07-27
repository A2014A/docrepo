/**
 * The 23 SKU rows in the master xlsx that carry a בד"ץ cert/report Google
 * Drive hyperlink -> resolved to local files in
 * G:\...\אישורי כשרות מהרבנות\תעודות ודוחות גופי כשרות (same Drive folder,
 * mounted locally) by filename match on the Drive file's title (avoids
 * pulling large PDFs through the Drive API into context). .msg files get
 * their PDF attachment extracted first (extract_msg_pdf.py), matching the
 * documented pattern in kosher-sku-cert-matching: a combined cert+report
 * email is fine to link from both fields pointing at the same file.
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { uploadFile } = require('../lib/r2');

const prisma = new PrismaClient();
const SCRATCH = 'C:\\Users\\mordechai\\AppData\\Local\\Temp\\claude\\C--Users-mordechai-OneDrive-----------------------------\\6421ad82-0054-4689-955c-d5702af696d6\\scratchpad';
const BADATZ_DIR = 'G:\\האחסון שלי\\אישורי כשרות מהרבנות\\תעודות ודוחות גופי כשרות';
const PYTHON = 'C:\\Users\\mordechai\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';

// Drive file id -> local filename in BADATZ_DIR (resolved manually by title match)
const FILE_MAP = {
  '1HfZKGQaM01uSwjLrFi3yaTAIG2tCgZZd': 'אחים כהן - ת. כשרות ~ מלפפון קורנישון  ייצור 22-07-25.pdf',
  '1xHB6YFyaTbVZiyzZX_k2JfthFefgDaZA': '\u200e\u2068דוח ייצור עבור עגבניות פולפה\u2069.pdf',
  '1Yv3_zcoyk_KxqFKvN2ZI-Hgjb-uD0ZmG': 'דוח לרבנות הראשית לישראל-אחים כהן-חלפינוי ומלפפון חמוץ-הודו ייצור 07.25.pdf',
  '1dIzg_fVVRTkskafEEpnEUu5IdBbHb-sh': 'הרבנות הראשית לישראל - אחים כהן-פטריות שלמות וחתוכות אוקוצאמפ דצמבר 2025.pdf',
  '1Anhnm4giipFLzLSmlKDxEvPWn72HwHlM': 'SKM_C28725102017560.pdf',
  '1oj3aJrvEPNkNXEjj70ZOl7llMLMhkOur': 'תעודת כשרות -אחים כהן-פרנסס און טורקיה - ייצור 2.26 -.pdf',
  '1eornf8NxZWBb-zhl29DRqONFWHg4pCTX': 'דוח לרבנות הראשית - אחים כהן טורטיות פרנסס און תורכיה - ייצור 02-26 (1).pdf',
  '199CnAVuJhgr8T4jJnSnLp3lPq_O85zHQ': 'תעודת הכשר + דו_ח רבנות טונה מפעל נינגבו טו דיי סין פסח 07_25.msg',
  '16hMY17INxZrcWGYOuYHDaLBLSV0xcfNE': 'תעודת הכשר + דו_ח רבנות טונה מפעל ריטרונקס סין פסח 10_24.msg',
  '1HJgXsHXc9tywtwDZSSTZkySf8tZskW4v': 'תעודה בזיליקום.msg',
};

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

function resolveLocalPdf(fileId) {
  const filename = FILE_MAP[fileId];
  if (!filename) return null;
  const fullPath = path.join(BADATZ_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    console.log('  NOT FOUND ON DISK:', filename);
    return null;
  }
  if (filename.toLowerCase().endsWith('.msg')) {
    const outPdf = path.join(os.tmpdir(), `badatz_${fileId}.pdf`);
    try {
      execFileSync(PYTHON, [path.join(__dirname, 'extract_msg_pdf.py'), fullPath, outPdf]);
      return outPdf;
    } catch (e) {
      console.log('  MSG EXTRACT FAILED:', filename, e.message);
      return null;
    }
  }
  return fullPath;
}

function parseExpiry(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`);
}

async function upsertBadatzDoc(fileId, docType, info) {
  const cacheKey = `${fileId}:${docType}`;
  const key = `badatz/${docType.toLowerCase()}_${fileId}.pdf`;
  const existing = await prisma.badatzDoc.findFirst({ where: { fileUrl: key } });
  if (existing) return existing;

  const localPdf = resolveLocalPdf(fileId);
  if (!localPdf) return null;
  await uploadFile(localPdf, key, 'application/pdf');

  return prisma.badatzDoc.create({
    data: {
      docType,
      kashrutBody: info.body || null,
      manufacturer: info.manufacturer || null,
      productsText: info.products || null,
      expiryDate: parseExpiry(info.expiry),
      fileUrl: key,
    },
  });
}

async function main() {
  const rows = loadJson(SCRATCH + '\\badatz_links.json');
  let certsCreated = 0, reportsCreated = 0, linksCreated = 0, skuNotFound = 0;

  for (const row of rows) {
    const sku = await prisma.sku.findUnique({ where: { code: row.mkt } });
    if (!sku) { skuNotFound++; continue; }

    if (row.cert_link) {
      const m = row.cert_link.match(/\/d\/([^/]+)\//);
      const fileId = m && m[1];
      if (fileId) {
        const doc = await upsertBadatzDoc(fileId, 'CERT', row);
        if (doc) {
          certsCreated++;
          await prisma.skuLink.create({
            data: { skuId: sku.id, docType: 'BADATZ_CERT', badatzDocId: doc.id, approvalStatus: 'APPROVED', visibleToCustomer: true },
          });
          linksCreated++;
        }
      }
    }
    if (row.report_link) {
      const m = row.report_link.match(/\/d\/([^/]+)\//);
      const fileId = m && m[1];
      if (fileId) {
        const doc = await upsertBadatzDoc(fileId, 'PRODUCTION_REPORT', row);
        if (doc) {
          reportsCreated++;
          await prisma.skuLink.create({
            data: { skuId: sku.id, docType: 'BADATZ_REPORT', badatzDocId: doc.id, approvalStatus: 'APPROVED', visibleToCustomer: false },
          });
          linksCreated++;
        }
      }
    }
  }

  console.log('DONE. cert docs (created-or-existing refs used):', certsCreated,
    'report docs:', reportsCreated, 'sku links:', linksCreated, 'sku not found:', skuNotFound);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
