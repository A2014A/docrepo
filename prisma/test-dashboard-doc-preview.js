/* Integration test for the dashboard document-preview panel's backend
 * calls (task A). Verifies the exact sequence dashboard.js makes against
 * the EXISTING link-suggestions routes -- no new write route is involved.
 * Covers both cases: (1) a document with pending suggestions (card 1's
 * scenario), (2) a document with no identification at all (card 8's
 * scenario -- the 404 fallback path). Uses only throwaway TEST- fixtures,
 * all deleted at the end. */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

(async () => {
  const testEmail = `test-admin-${Date.now()}@test.local`;
  const testUser = await prisma.user.create({ data: { email: testEmail, passwordHash: bcrypt.hashSync('x', 10), role: 'ADMIN' } });
  const setting = await prisma.syncState.findUnique({ where: { key: 'assistant_code' } });
  let pass = 0, fail = 0;
  function check(label, cond) { if (cond) { pass++; console.log('  OK  ' + label); } else { fail++; console.log('  FAIL ' + label); } }

  // Fixtures
  const docWithId = await prisma.document.create({ data: { title: 'TEST-doc-with-identification', fileUrl: 'test/x.pdf', docExt: 'pdf' } });
  const docNoId = await prisma.document.create({ data: { title: 'TEST-doc-no-identification', fileUrl: 'test/y.pdf', docExt: 'pdf' } });
  const skuA = await prisma.sku.create({ data: { code: 'TEST-DP-A', name: 'TEST מק"ט א', active: true } });
  const skuB = await prisma.sku.create({ data: { code: 'TEST-DP-B', name: 'TEST מק"ט ב', active: true } });
  const ident = await prisma.docIdentification.create({ data: { documentId: docWithId.id, source: 'FREE', docKind: 'CERT', manufacturer: 'TEST-MFR' } });
  const sugCertain = await prisma.linkSuggestion.create({ data: { documentId: docWithId.id, skuId: skuA.id, confidence: 'CERTAIN', reasons: {}, status: 'PENDING' } });
  const sugPossible = await prisma.linkSuggestion.create({ data: { documentId: docWithId.id, skuId: skuB.id, confidence: 'POSSIBLE', reasons: {}, status: 'PENDING' } });

  try {
    const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: testEmail, password: 'x' }) });
    const lb = await login.json();
    const AUTH = { 'x-assistant-code': setting ? setting.value : '5678', Authorization: `Bearer ${lb.token}` };

    // --- Scenario 1: document WITH identification + pending suggestions (card 1) ---
    const r1 = await fetch(BASE + '/api/link-suggestions/' + docWithId.id, { headers: AUTH });
    check('scenario 1: GET /link-suggestions/:id returns 200', r1.status === 200);
    const body1 = await r1.json();
    check('scenario 1: CERTAIN candidate is preChecked', body1.candidates.find(c => c.skuId === skuA.id)?.preChecked === true);
    check('scenario 1: POSSIBLE candidate is NOT preChecked', body1.candidates.find(c => c.skuId === skuB.id)?.preChecked === false);

    // dashPreviewAccept(skuA.id): submit skuIds=[skuA.id]
    const link1 = await fetch(BASE + '/api/link-suggestions/' + docWithId.id + '/link', {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ skuIds: [skuA.id] }),
    }).then(r => r.json());
    check('scenario 1: /link creates exactly 1 SkuLink', link1.linksCreated === 1);
    const sugAfter = await prisma.linkSuggestion.findMany({ where: { documentId: docWithId.id } });
    check('scenario 1: accepted candidate -> APPROVED', sugAfter.find(s => s.skuId === skuA.id).status === 'APPROVED');
    check('scenario 1: non-accepted candidate -> REJECTED (the ✘ דחה local-only semantics become real here)', sugAfter.find(s => s.skuId === skuB.id).status === 'REJECTED');
    const skuLinkRow = await prisma.skuLink.findFirst({ where: { documentId: docWithId.id, skuId: skuA.id } });
    check('scenario 1: SkuLink row has docType DOCUMENT, approvalStatus APPROVED', skuLinkRow && skuLinkRow.docType === 'DOCUMENT' && skuLinkRow.approvalStatus === 'APPROVED');

    // --- Scenario 2: document with NO identification (card 8's 404 fallback) ---
    const r2 = await fetch(BASE + '/api/link-suggestions/' + docNoId.id, { headers: AUTH });
    check('scenario 2: GET /link-suggestions/:id returns 404 for an unprocessed doc', r2.status === 404);
    const lookup = await fetch(BASE + '/api/link-suggestions/doc-lookup/' + docNoId.id, { headers: AUTH }).then(r => r.json());
    check('scenario 2: doc-lookup fallback returns title+docExt', lookup.title === 'TEST-doc-no-identification' && lookup.docExt === 'pdf');

    // manual pick via sku-search then dashPreviewAccept -> /link with just that one id (no suggestions existed at all)
    const search2 = await fetch(BASE + '/api/skus/search?q=' + encodeURIComponent('TEST מק"ט ב'), { headers: AUTH }).then(r => r.json());
    check('scenario 2: sku-search finds the manually-typed SKU', search2.some(s => s.skuId === skuB.id));
    const link2 = await fetch(BASE + '/api/link-suggestions/' + docNoId.id + '/link', {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ skuIds: [skuB.id] }),
    }).then(r => r.json());
    check('scenario 2: manual link on an unprocessed doc still works via the same /link route', link2.linksCreated === 1);
    const skuLinkRow2 = await prisma.skuLink.findFirst({ where: { documentId: docNoId.id, skuId: skuB.id } });
    check('scenario 2: SkuLink created for the manually-picked SKU', !!skuLinkRow2);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  } finally {
    await prisma.skuLink.deleteMany({ where: { documentId: { in: [docWithId.id, docNoId.id] } } });
    await prisma.linkSuggestion.deleteMany({ where: { documentId: docWithId.id } });
    await prisma.docIdentification.delete({ where: { id: ident.id } });
    await prisma.document.delete({ where: { id: docWithId.id } });
    await prisma.document.delete({ where: { id: docNoId.id } });
    await prisma.sku.delete({ where: { id: skuA.id } });
    await prisma.sku.delete({ where: { id: skuB.id } });
    await prisma.user.delete({ where: { id: testUser.id } });
    await prisma.$disconnect();
  }
})().catch(async (e) => { console.error('FAILED:', e.message); process.exit(1); });
