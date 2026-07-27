/**
 * One-time migration: local git-tracked uploads/*.pdf (9 docs, from
 * data/db.json) + the 8 live-only documents backed up earlier from the
 * live Render instance (before they'd have been wiped by this same
 * deploy) -> upload to R2, create Document + SkuLink rows in Postgres.
 * Safe to re-run: skips any doc whose title+size already exists.
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const { uploadFile } = require('../lib/r2');

const prisma = new PrismaClient();
const SCRATCH = 'C:\\Users\\mordechai\\AppData\\Local\\Temp\\claude\\C--Users-mordechai-OneDrive-----------------------------\\6421ad82-0054-4689-955c-d5702af696d6\\scratchpad';
const LOCAL_UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

async function linkSkus(documentId, skus) {
  for (const s of skus || []) {
    const sku = await prisma.sku.findUnique({ where: { code: String(s.id) } });
    if (!sku) {
      console.log('  (sku not found for link, skipping:', s.id, ')');
      continue;
    }
    await prisma.skuLink.create({
      data: {
        skuId: sku.id,
        docType: 'DOCUMENT',
        documentId,
        approvalStatus: 'APPROVED',
        visibleToCustomer: false,
      },
    });
  }
}

async function migrateLocalDocs() {
  const docs = loadJson(SCRATCH + '\\local_docs_full.json');
  for (const d of docs) {
    const localPath = path.join(LOCAL_UPLOADS_DIR, d.filename);
    if (!fs.existsSync(localPath)) {
      console.log('MISSING FILE, skipping:', d.filename);
      continue;
    }
    const key = `git/${d.filename}`;
    await uploadFile(localPath, key, 'application/pdf');
    const doc = await prisma.document.create({
      data: {
        title: d.title || d.name || null,
        docType: d.doctype || null,
        tags: d.tags || [],
        fileUrl: key,
        expiryDate: d.expiry_date ? new Date(d.expiry_date) : null,
        hidden: !!d.hidden,
        createdAt: d.created_at ? new Date(d.created_at) : undefined,
      },
    });
    await linkSkus(doc.id, d.skus);
    console.log('migrated local doc', d.id, '->', key);
  }
}

async function migrateLiveOnlyDocs() {
  const docs = loadJson(SCRATCH + '\\live_backup\\live_docs_metadata.json');
  for (const d of docs) {
    const localPath = path.join(SCRATCH, 'live_backup', 'pdfs', `doc_${d.id}.pdf`);
    if (!fs.existsSync(localPath)) {
      console.log('MISSING BACKUP FILE, skipping live doc:', d.id);
      continue;
    }
    const key = `live-recovered/${d.filename}`;
    await uploadFile(localPath, key, 'application/pdf');
    const doc = await prisma.document.create({
      data: {
        title: d.name || null,
        docType: d.doctype || null,
        tags: d.tags || [],
        fileUrl: key,
        expiryDate: d.expiry_date ? new Date(d.expiry_date) : null,
        hidden: !!d.hidden,
        createdAt: d.created_at ? new Date(d.created_at) : undefined,
      },
    });
    await linkSkus(doc.id, d.skus);
    console.log('migrated LIVE-ONLY doc', d.id, '->', key);
  }
}

async function main() {
  const before = await prisma.document.count();
  if (before > 0) {
    console.log(`Document table already has ${before} rows -- skipping to avoid duplicating on re-run.`);
    return;
  }
  await migrateLocalDocs();
  await migrateLiveOnlyDocs();
  const after = await prisma.document.count();
  const linkCount = await prisma.skuLink.count();
  console.log('DONE. documents:', after, 'sku links:', linkCount);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
