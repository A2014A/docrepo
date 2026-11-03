/* Phase 2 DRY RUN per docrepo-raw-materials-spec.md, updated with decisions
 * from the 2026-11-02 review:
 *  1) SKU 11267: conflicting APPROVED/PENDING links collapse to one
 *     RawMaterialApproval row -- APPROVED wins, using that link's kashrutLevel.
 *  2) Alias table for Sku.kashrutBodyRef -> seeded KashrutBody.name, instead
 *     of exact-match-or-fallback.
 *  3) SKUs with an empty kashrutBodyRef (no fallback): create the RawMaterial
 *     + its documents, but no RawMaterialApproval row at all -- flagged
 *     "לבדוק" instead of silently assigning a body.
 * Read-only: prints the planned mapping. Writes nothing to the DB. */
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

// old approvalStatus -> new RawMaterialApprovalStatus when a group has no
// conflict (all links agree). The old schema never recorded whether a send
// actually happened, so a lone PENDING is mapped to NOT_SENT, not
// SENT_PENDING -- we have no evidence anything was ever sent. Flagged as an
// assumption below so it's visible in the review, not just asserted.
const SIMPLE_STATUS_MAP = { PENDING: 'NOT_SENT', APPROVED: 'APPROVED', REJECTED: 'REJECTED' };

// precedence when a group's links disagree: a decided outcome always beats
// an undecided one.
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
    if (!l.sku || !l.document) continue; // orphaned link, nothing to migrate
    if (!bySku.has(l.skuId)) bySku.set(l.skuId, []);
    bySku.get(l.skuId).push(l);
  }

  const plan = [];
  const flags = [];

  for (const [skuId, group] of bySku) {
    const sku = group[0].sku;
    const ref = (sku.kashrutBodyRef || '').trim();

    // --- kashrut body resolution: exact match -> alias -> no-fallback-flag
    let resolvedBody = null;
    let bodyNote = null;
    if (ref) {
      resolvedBody = bodyByName.get(ref) || null;
      if (!resolvedBody && ALIASES[ref]) {
        resolvedBody = bodyByName.get(ALIASES[ref]) || null;
        bodyNote = `alias "${ref}" -> "${ALIASES[ref]}"`;
      }
      if (!resolvedBody) {
        bodyNote = `UNRESOLVED: כשרות="${ref}" matches no body and no alias -- needs a decision, no fallback applied`;
        flags.push(`SKU ${sku.code}: ${bodyNote}`);
      }
    } else {
      bodyNote = 'לבדוק -- no כשרות value on SKU, no approval row created';
      flags.push(`SKU ${sku.code}: ${bodyNote}`);
    }

    // --- status resolution (only matters if resolvedBody is set)
    const statuses = [...new Set(group.map(l => l.approvalStatus))];
    let winningLink = group[0];
    let conflictNote = null;
    if (statuses.length > 1) {
      for (const s of CONFLICT_PRECEDENCE) {
        const match = group.find(l => l.approvalStatus === s);
        if (match) { winningLink = match; break; }
      }
      conflictNote = `conflict ${statuses.join('/')} -- resolved to ${winningLink.approvalStatus} (linkId ${winningLink.id}), per reviewed decision`;
      flags.push(`SKU ${sku.code}: ${conflictNote}`);
    }
    const approvalStatus = SIMPLE_STATUS_MAP[winningLink.approvalStatus];
    const approvalKashrutLevel = winningLink.kashrutLevel || null;

    plan.push({
      skuCode: sku.code,
      skuName: sku.name,
      proposedRawMaterialName: sku.name,
      kashrutBodyRefOnSku: ref || null,
      resolvedKashrutBody: resolvedBody ? resolvedBody.name : null,
      bodyNote,
      createsApproval: !!resolvedBody,
      approvalStatus: resolvedBody ? approvalStatus : null,
      approvalKashrutLevel: resolvedBody ? approvalKashrutLevel : null,
      documentsToAttach: group.map(l => ({
        linkId: l.id, docId: l.document.id, title: l.document.title,
        approvalStatus: l.approvalStatus, kashrutLevel: l.kashrutLevel || null,
        createdAt: l.createdAt,
      })),
      conflictNote,
    });
  }

  console.log(`\n=== PHASE 2 DRY RUN (v2, post-decisions) -- ${plan.length} proposed RawMaterial records from ${links.length} SkuLink rows ===\n`);
  for (const p of plan) {
    console.log(`SKU ${p.skuCode} — ${p.skuName}`);
    console.log(`  -> RawMaterial.name = "${p.proposedRawMaterialName}"`);
    console.log(`  -> ${p.documentsToAttach.length} document(s) to attach as RawMaterialDocument:`);
    for (const d of p.documentsToAttach) {
      console.log(`       linkId=${d.linkId} docId=${d.docId} "${d.title}" status=${d.approvalStatus} level=${d.kashrutLevel || '-'} created=${d.createdAt.toISOString().slice(0,10)}`);
    }
    if (p.createsApproval) {
      console.log(`  -> RawMaterialApproval: kashrutBody="${p.resolvedKashrutBody}"${p.bodyNote ? '  (' + p.bodyNote + ')' : ''}, status=${p.approvalStatus}, kashrutLevel=${p.approvalKashrutLevel || '-'}`);
    } else {
      console.log(`  -> NO RawMaterialApproval row created -- ${p.bodyNote}`);
    }
    if (p.conflictNote) console.log(`  !! ${p.conflictNote}`);
    console.log('');
  }

  console.log('=== FLAGS / NOTES ===');
  if (!flags.length) console.log('(none)');
  flags.forEach(f => console.log(' - ' + f));

  const approvalCount = plan.filter(p => p.createsApproval).length;
  console.log(`\nNo writes performed. On a real run: ${plan.length} RawMaterial, ${links.length} RawMaterialDocument, ${plan.length} SkuRawMaterial, ${approvalCount} RawMaterialApproval rows would be created (${plan.length - approvalCount} SKU(s) get no approval row, flagged לבדוק).`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('DRY RUN FAILED:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
