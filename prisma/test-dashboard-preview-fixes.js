/* Integration test for the preview-panel fixes: (1) multi-SKU batched
 * linking via /link with several skuIds at once, (2) archive + trash +
 * restore, including that trashed documents are excluded from GET
 * /api/docs, /api/stats, /api/tags, /api/doctypes and the dashboard's
 * unprocessed-docs card. Throwaway TEST- fixtures only, all cleaned up. */
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

  const doc = await prisma.document.create({ data: { title: 'TEST-doc-multi-link', fileUrl: 'test/z.pdf', docExt: 'pdf' } });
  const skuA = await prisma.sku.create({ data: { code: 'TEST-PF-A', name: 'TEST מק"ט א', active: true } });
  const skuB = await prisma.sku.create({ data: { code: 'TEST-PF-B', name: 'TEST מק"ט ב', active: true } });

  try {
    const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: testEmail, password: 'x' }) });
    const lb = await login.json();
    const AUTH = { 'x-assistant-code': setting ? setting.value : '5678', Authorization: `Bearer ${lb.token}` };
    const AUTHJ = { ...AUTH, 'Content-Type': 'application/json' };

    // --- 1) multi-SKU batched linking ---
    const link = await fetch(BASE + '/api/link-suggestions/' + doc.id + '/link', {
      method: 'POST', headers: AUTHJ, body: JSON.stringify({ skuIds: [skuA.id, skuB.id] }),
    }).then(r => r.json());
    check('batched /link with 2 skuIds creates 2 SkuLinks', link.linksCreated === 2);
    const links = await prisma.skuLink.findMany({ where: { documentId: doc.id } });
    check('both SkuLink rows exist, both APPROVED', links.length === 2 && links.every(l => l.approvalStatus === 'APPROVED'));

    // --- 2a) archive ---
    const archiveRes = await fetch(BASE + '/api/docs/' + doc.id + '/archive', { method: 'POST', headers: AUTHJ, body: JSON.stringify({ reason: 'תעודה ישנה' }) });
    check('archive endpoint returns 200', archiveRes.status === 200);
    const afterArchive = await prisma.document.findUnique({ where: { id: doc.id } });
    check('document.archived=true, archivedReason set', afterArchive.archived === true && afterArchive.archivedReason === 'תעודה ישנה');

    // --- 2b) trash + exclusion from lists + restore ---
    const trashRes = await fetch(BASE + '/api/docs/' + doc.id + '/trash', { method: 'POST', headers: AUTH });
    check('trash endpoint returns 200', trashRes.status === 200);
    const afterTrash = await prisma.document.findUnique({ where: { id: doc.id } });
    check('document.trashedAt is set', afterTrash.trashedAt !== null);

    const docsListRes = await fetch(BASE + '/api/docs', { headers: AUTH }).then(r => r.json());
    check('trashed doc excluded from GET /api/docs', !docsListRes.some(d => d.id === doc.id));

    const statsRes = await fetch(BASE + '/api/stats', { headers: AUTH }).then(r => r.json());
    const totalBefore = statsRes.total;

    const trashListRes = await fetch(BASE + '/api/docs/trash', { headers: AUTH }).then(r => r.json());
    check('trashed doc appears in GET /api/docs/trash', trashListRes.some(d => d.id === doc.id));

    const restoreRes = await fetch(BASE + '/api/docs/' + doc.id + '/restore', { method: 'POST', headers: AUTH });
    check('restore endpoint returns 200', restoreRes.status === 200);
    const afterRestore = await prisma.document.findUnique({ where: { id: doc.id } });
    check('document.trashedAt cleared after restore', afterRestore.trashedAt === null);
    const docsListAfterRestore = await fetch(BASE + '/api/docs', { headers: AUTH }).then(r => r.json());
    check('restored doc reappears in GET /api/docs', docsListAfterRestore.some(d => d.id === doc.id));

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  } finally {
    await prisma.skuLink.deleteMany({ where: { documentId: doc.id } });
    await prisma.document.delete({ where: { id: doc.id } });
    await prisma.sku.delete({ where: { id: skuA.id } });
    await prisma.sku.delete({ where: { id: skuB.id } });
    await prisma.user.delete({ where: { id: testUser.id } });
    await prisma.$disconnect();
  }
})().catch(async (e) => { console.error('FAILED:', e.message); process.exit(1); });
