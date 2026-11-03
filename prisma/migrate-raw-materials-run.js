/* Phase 2 REAL RUN -- same rules as migrate-raw-materials-dryrun.js (v2),
 * executed inside one transaction. Never touches SkuLink/isRawMaterial/
 * approvalStatus/Contact -- those keep working untouched for the old screens.
 * Decisions applied (2026-11-02 review):
 *  1) SKU 11267: APPROVED/PENDING conflict -> APPROVED wins (that link's kashrutLevel).
 *  2) Alias table for Sku.kashrutBodyRef -> KashrutBody.name.
 *  3) No כשרות value on SKU -> no RawMaterialApproval row, flagged לבדוק (not written to DB, just logged here).
 *  4) Old PENDING (no conflict) -> NOT_SENT (no evidence anything was ever sent). */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ALIASES = {
  'עדה חרדית': 'בד"ץ העדה החרדית',
  'רבנות': 'הרבנות הראשית',
  'לנדא': 'הרב לנדא',
  'הרב לנדא ב"ב': 'הרב לנדא',
  'חתם סופר': 'חתם סופר ב"ב',
  'קהילות': 'בד"ץ קהילות',
};
const SIMPLE_STATUS_MAP = { PENDING: 'NOT_SENT', APPROVED: 'APPROVED', REJECTED: 'REJECTED' };
const CONFLICT_PRECEDENCE = ['APPROVED', 'REJECTED', 'PENDING'];

(async () => {
  const links = await prisma.skuLink.findMany({
    where: { isRawMaterial: true },
    include: { sku: true, document: true },
    orderBy: [{ skuId: 'asc' }, { createdAt: 'asc' }],
  });

  const bodies = await prisma.kashrutBody.findMany();
  const bodyByName = new Map(bodies.map(b => [b.name.trim(), b]));

  const bySku = new Map();
  for (const l of links) {
    if (!l.sku || !l.document) continue;
    if (!bySku.has(l.skuId)) bySku.set(l.skuId, []);
    bySku.get(l.skuId).push(l);
  }

  const noApprovalSkus = [];
  const createdSummary = [];

  await prisma.$transaction(async (tx) => {
    for (const [skuId, group] of bySku) {
      const sku = group[0].sku;
      const ref = (sku.kashrutBodyRef || '').trim();

      let resolvedBody = null;
      if (ref) resolvedBody = bodyByName.get(ref) || (ALIASES[ref] ? bodyByName.get(ALIASES[ref]) : null) || null;
      if (!resolvedBody) noApprovalSkus.push(sku.code);

      const rawMaterial = await tx.rawMaterial.create({
        data: { name: sku.name, supplier: sku.supplier || null },
      });

      for (const l of group) {
        await tx.rawMaterialDocument.create({
          data: { rawMaterialId: rawMaterial.id, documentId: l.document.id, docRole: 'OTHER', uploadedAt: l.document.createdAt },
        });
      }

      await tx.skuRawMaterial.create({ data: { skuId: sku.id, rawMaterialId: rawMaterial.id } });

      let approval = null;
      if (resolvedBody) {
        const statuses = [...new Set(group.map(l => l.approvalStatus))];
        let winningLink = group[0];
        if (statuses.length > 1) {
          for (const s of CONFLICT_PRECEDENCE) {
            const match = group.find(l => l.approvalStatus === s);
            if (match) { winningLink = match; break; }
          }
        }
        const status = SIMPLE_STATUS_MAP[winningLink.approvalStatus];
        approval = await tx.rawMaterialApproval.create({
          data: {
            rawMaterialId: rawMaterial.id,
            kashrutBodyId: resolvedBody.id,
            status,
            kashrutLevel: winningLink.kashrutLevel || null,
          },
        });
        await tx.rawMaterialApprovalEvent.create({
          data: {
            approvalId: approval.id,
            type: 'STATUS_CHANGE',
            fromStatus: null,
            toStatus: status,
            payload: { migratedFromSkuLinkIds: group.map(l => l.id), note: 'Phase 2 migration from legacy SkuLink rows' },
          },
        });
      }

      createdSummary.push({
        skuCode: sku.code, rawMaterialId: rawMaterial.id,
        documents: group.length,
        approval: approval ? { kashrutBody: resolvedBody.name, status: approval.status } : null,
      });
    }
  }, { timeout: 30000, maxWait: 10000 });

  console.log(`=== MIGRATION COMPLETE ===`);
  for (const s of createdSummary) {
    console.log(`SKU ${s.skuCode} -> RawMaterial #${s.rawMaterialId}, ${s.documents} document(s), approval: ${s.approval ? `${s.approval.kashrutBody} = ${s.approval.status}` : 'NONE (לבדוק)'}`);
  }
  console.log(`\nCreated: ${createdSummary.length} RawMaterial, ${links.length} RawMaterialDocument, ${createdSummary.length} SkuRawMaterial, ${createdSummary.filter(s=>s.approval).length} RawMaterialApproval (+ matching events).`);
  console.log(`No approval row (לבדוק): ${noApprovalSkus.join(', ') || '(none)'}`);
  console.log(`\nLegacy SkuLink rows were NOT modified -- old screens keep working unchanged.`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('MIGRATION FAILED, transaction rolled back:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
