/**
 * Bulk-import every file sitting in the Drive kosher-cert folders (not just
 * the ones already cross-referenced by the master xlsx -- that's the
 * smaller, already-done seed-rabbinate-certs.js / seed-badatz-docs.js
 * pass). These land as generic Document rows with NO SkuLink yet -- they
 * show up in the document library for manual/automatic linking later
 * (Phase 2/3), rather than guessing a SKU match here.
 *
 * Per-folder defaults (docType, hidden):
 *  - אישורים            -> "אישורי רבנות", hidden=false (final Rabbinate
 *                          approvals -- per the user's visibility rule,
 *                          these ARE the final certificate)
 *  - בקשות              -> "בקשות", hidden=true (never a final cert)
 *  - תעודות ודוחות גופי כשרות -> "בד"ץ (טרם מסווג)", hidden=true (this
 *                          folder mixes תעודת הכשר and דוח ייצור -- can't
 *                          tell which without opening the file, so default
 *                          to hidden until a human reclassifies via the
 *                          existing edit UI, never guess visible)
 *  - הודעות אחרות        -> "אחר", hidden=true
 *
 * .msg files: extract the first PDF attachment (extract_msg_pdf.py); if
 * none found, upload the raw .msg itself so nothing is silently dropped.
 *
 * Safe to re-run: skips any Drive file whose basename already appears in
 * an existing Document/RabbinateCert/BadatzDoc fileUrl.
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { uploadFile } = require('../lib/r2');

const prisma = new PrismaClient();
const PYTHON = 'C:\\Users\\mordechai\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const BASE = 'G:\\האחסון שלי\\אישורי כשרות מהרבנות';

const FOLDERS = [
  { dir: 'אישורים', docType: 'אישורי רבנות', hidden: false },
  { dir: 'בקשות', docType: 'בקשות', hidden: true },
  { dir: 'תעודות ודוחות גופי כשרות', docType: 'בד"ץ (טרם מסווג)', hidden: true },
  { dir: 'הודעות אחרות', docType: 'אחר', hidden: true },
];

async function loadKnownBasenames() {
  const [docs, rcerts, bdocs] = await Promise.all([
    prisma.document.findMany({ select: { fileUrl: true } }),
    prisma.rabbinateCert.findMany({ select: { fileUrl: true } }),
    prisma.badatzDoc.findMany({ select: { fileUrl: true } }),
  ]);
  const set = new Set();
  for (const r of [...docs, ...rcerts, ...bdocs]) {
    if (r.fileUrl) set.add(path.basename(r.fileUrl).replace(/^\d+[_-]/, '').replace(/^[a-z]+_\d+_/, ''));
  }
  return set;
}

function extractMsgPdf(msgPath) {
  const outPdf = path.join(os.tmpdir(), `bulk_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
  try {
    execFileSync(PYTHON, [path.join(__dirname, 'extract_msg_pdf.py'), msgPath, outPdf], { stdio: 'pipe' });
    return outPdf;
  } catch (e) {
    return null;
  }
}

async function main() {
  const known = await loadKnownBasenames();
  console.log('known basenames already in DB:', known.size);

  let created = 0, skipped = 0, msgExtracted = 0, msgRawFallback = 0, errors = 0;

  for (const folder of FOLDERS) {
    const dirPath = path.join(BASE, folder.dir);
    const files = fs.readdirSync(dirPath).filter(f => {
      const full = path.join(dirPath, f);
      return fs.statSync(full).isFile();
    });
    console.log(`\n=== ${folder.dir}: ${files.length} files ===`);

    let i = 0;
    for (const filename of files) {
      i++;
      if (known.has(filename)) { skipped++; continue; }

      const fullPath = path.join(dirPath, filename);
      const isMsg = filename.toLowerCase().endsWith('.msg');
      let uploadPath = fullPath;
      let ext = path.extname(filename).replace('.', '').toLowerCase();
      let title = filename.replace(/\.[^.]+$/, '');

      if (isMsg) {
        const pdf = extractMsgPdf(fullPath);
        if (pdf) {
          uploadPath = pdf;
          ext = 'pdf';
          msgExtracted++;
        } else {
          msgRawFallback++;
        }
      }

      try {
        const stat = fs.statSync(uploadPath);
        const key = `drive-bulk/${folder.dir.replace(/[^\w\u0590-\u05FF]/g, '_')}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        await uploadFile(uploadPath, key, ext === 'pdf' ? 'application/pdf' : undefined);
        await prisma.document.create({
          data: {
            title, docType: folder.docType, docExt: ext, sizeBytes: stat.size,
            tags: ['ייבוא-דרייב'], fileUrl: key, hidden: folder.hidden,
          },
        });
        created++;
        if (uploadPath !== fullPath) fs.unlinkSync(uploadPath); // clean up extracted temp pdf
      } catch (e) {
        errors++;
        console.log('  ERROR on', filename, ':', e.message);
      }

      if (i % 50 === 0) console.log(`  ${i}/${files.length} in this folder (created so far: ${created})`);
    }
  }

  console.log('\nDONE.');
  console.log('created:', created, 'skipped (already known):', skipped,
    'msg->pdf extracted:', msgExtracted, 'msg raw fallback (skipped, no pdf found):', msgRawFallback,
    'errors:', errors);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
