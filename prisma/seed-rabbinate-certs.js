/**
 * Match Rabbinate ref numbers already captured on Sku (from the master
 * xlsx, via consolidate_skus.py) to actual approval PDFs sitting in
 * G:\...\אישורי כשרות מהרבנות\אישורים, named אישור_<refnumber>_<name>.pdf
 * Upload matched files to R2, create one RabbinateCert per unique ref
 * number (a ref can cover several SKUs), link every SKU that references
 * it. visibleToCustomer = true: these are final government approvals.
 * Safe to re-run: skips refs that already have a RabbinateCert.
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const { uploadFile } = require('../lib/r2');

const prisma = new PrismaClient();
const SCRATCH = 'C:\\Users\\mordechai\\AppData\\Local\\Temp\\claude\\C--Users-mordechai-OneDrive-----------------------------\\6421ad82-0054-4689-955c-d5702af696d6\\scratchpad';
const APPROVALS_DIR = 'G:\\האחסון שלי\\אישורי כשרות מהרבנות\\אישורים';

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

function parseExpiry(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`);
}

async function main() {
  const consolidated = loadJson(SCRATCH + '\\consolidated_skus.json');

  // build ref -> [filenames] index from the approvals folder
  const files = fs.readdirSync(APPROVALS_DIR);
  const refToFiles = new Map();
  for (const f of files) {
    const m = f.match(/^אישור_(\d+)_/);
    if (m) {
      const ref = m[1];
      if (!refToFiles.has(ref)) refToFiles.set(ref, []);
      refToFiles.get(ref).push(f);
    }
  }
  console.log('files on disk:', files.length, 'unique ref numbers found in filenames:', refToFiles.size);

  // build ref -> {skuCodes[], expiry, matchedProduct} from consolidated data
  const refInfo = new Map();
  for (const [code, s] of Object.entries(consolidated)) {
    if (!s.rabbinate_refs) continue;
    const refs = String(s.rabbinate_refs).split(';').map(r => r.trim()).filter(Boolean);
    for (const ref of refs) {
      if (!refInfo.has(ref)) refInfo.set(ref, { skuCodes: [], expiry: s.rabbinate_expiry, matchedProduct: s.rabbinate_matched_product, kashrutBody: s.kashrutBodyRef });
      refInfo.get(ref).skuCodes.push(code);
    }
  }

  let createdCerts = 0, linked = 0, noFileMatch = 0, alreadyExists = 0;
  for (const [ref, info] of refInfo.entries()) {
    const existing = await prisma.rabbinateCert.findFirst({ where: { refNumber: ref } });
    if (existing) { alreadyExists++; continue; }

    const filenames = refToFiles.get(ref);
    if (!filenames || filenames.length === 0) {
      noFileMatch++;
      continue;
    }
    // if multiple files share a ref (revisions), take all but store the first as primary
    const primary = filenames[0];
    const localPath = path.join(APPROVALS_DIR, primary);
    const key = `rabbinate/${ref}_${primary}`;
    await uploadFile(localPath, key, 'application/pdf');

    const cert = await prisma.rabbinateCert.create({
      data: {
        refNumber: ref,
        matchedProductText: info.matchedProduct || null,
        status: 'יש תעודה',
        kashrutBody: info.kashrutBody || null,
        expiryDate: parseExpiry(info.expiry),
        fileUrl: key,
      },
    });
    createdCerts++;

    for (const code of info.skuCodes) {
      const sku = await prisma.sku.findUnique({ where: { code } });
      if (!sku) continue;
      await prisma.skuLink.create({
        data: {
          skuId: sku.id,
          docType: 'RABBINATE',
          rabbinateCertId: cert.id,
          approvalStatus: 'APPROVED',
          visibleToCustomer: true,
        },
      });
      linked++;
    }
  }

  console.log('DONE. certs created:', createdCerts, 'sku links created:', linked,
    'refs already had a cert (skipped):', alreadyExists, 'refs with no matching file:', noFileMatch);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
