/**
 * One-time migration: consolidated SKU dataset (live docrepo + git-only
 * backfill + master kosher-matching xlsx, already merged into
 * consolidated_skus.json by scripts/consolidate_skus.py) + the public
 * cohenb.com catalog scrape (category + kashrut/weight/import-origin per
 * SKU where available) -> Postgres via Prisma.
 *
 * Safe to re-run: upserts by Sku.code / Category.name, never duplicates.
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');

const prisma = new PrismaClient();
const SCRATCH = 'C:\\Users\\mordechai\\AppData\\Local\\Temp\\claude\\C--Users-mordechai-OneDrive-----------------------------\\6421ad82-0054-4689-955c-d5702af696d6\\scratchpad';

function loadJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf-8'));
}

async function main() {
  const consolidated = loadJson(SCRATCH + '\\consolidated_skus.json');
  const catalogProducts = loadJson(SCRATCH + '\\catalog_scrape.json').results;
  let catalogCategories = {};
  try {
    catalogCategories = loadJson(SCRATCH + '\\catalog_categories.json');
  } catch (e) {
    console.log('catalog_categories.json not ready yet, skipping category enrichment this run');
  }

  // sku -> catalog product info
  const bySku = new Map();
  for (const p of catalogProducts) {
    if (p.sku) bySku.set(p.sku, p);
  }

  // sku -> category name
  const skuToCategory = new Map();
  for (const [catName, rows] of Object.entries(catalogCategories)) {
    for (const [, sku] of rows) {
      if (sku) skuToCategory.set(sku, catName);
    }
  }

  // 1. create categories
  const categoryNames = [...new Set(skuToCategory.values())].filter(Boolean);
  const categoryIdByName = {};
  for (const name of categoryNames) {
    const cat = await prisma.category.upsert({
      where: { name }, update: {}, create: { name },
    });
    categoryIdByName[name] = cat.id;
  }
  console.log('categories ready:', categoryNames.length);

  // 2. upsert SKUs
  let created = 0, updated = 0, enrichedFromCatalog = 0;
  const codes = Object.keys(consolidated);
  for (const code of codes) {
    const s = consolidated[code];
    const catalogInfo = bySku.get(code);
    const catName = skuToCategory.get(code);

    let kashrutBodyRef = s.kashrutBodyRef || '';
    if (!kashrutBodyRef && catalogInfo && catalogInfo.kashrut) {
      kashrutBodyRef = catalogInfo.kashrut;
      enrichedFromCatalog++;
    }

    const data = {
      name: s.name || (catalogInfo ? catalogInfo.title : code),
      supplier: s.supplier || null,
      tipus: s.tipus || null,
      sourceFlag: s.source_flag || null,
      responsible: s.responsible || null,
      kashrutBodyRef: kashrutBodyRef || null,
      pesachStatusRef: s.pesachStatusRef || null,
      notes: s.notes || null,
      origin: s.origin || [],
      categoryId: catName ? categoryIdByName[catName] : null,
      reviewedAt: s.needs_review ? null : new Date(),
    };

    const existing = await prisma.sku.findUnique({ where: { code } });
    if (existing) {
      await prisma.sku.update({ where: { code }, data });
      updated++;
    } else {
      await prisma.sku.create({ data: { code, ...data } });
      created++;
    }
  }

  console.log('SKUs created:', created, 'updated:', updated, 'enriched kashrut from catalog:', enrichedFromCatalog);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
