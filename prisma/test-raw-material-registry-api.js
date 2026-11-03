/* Local smoke test for every Phase 3 raw-material-registry endpoint.
 * Run against a locally-running `node server.js` (default http://localhost:3000).
 * IMPORTANT: this hits the LIVE Neon DB (no separate local DB exists). All
 * test records are prefixed "TEST-" and deleted at the end; row counts for
 * every touched table are snapshotted before and after and compared, so any
 * leftover test data is caught rather than silently left in production data.
 * Never sends a real email: all /send calls use recordOnly=true.
 * Never prints the assistant code -- only uses it as a header value. */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
let AUTH_HEADER = {};

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  OK  ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ' -- ' + JSON.stringify(extra) : ''}`); }
}

async function api(method, path, body, isMultipart) {
  const opts = { method, headers: { ...AUTH_HEADER } };
  if (isMultipart) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

const SNAPSHOT_TABLES = ['document', 'rawMaterial', 'rawMaterialDocument', 'rawMaterialApproval', 'rawMaterialApprovalEvent', 'skuRawMaterial', 'user'];
async function snapshot() {
  const out = {};
  for (const t of SNAPSHOT_TABLES) out[t] = await prisma[t].count();
  return out;
}

(async () => {
  console.log('=== Phase 3 API smoke test (live Neon DB, self-cleaning) ===\n');
  const before = await snapshot(); // captured before the throwaway test-admin user exists too

  const setting = await prisma.syncState.findUnique({ where: { key: 'assistant_code' } });

  // DELETE /api/raw-material-registry/:id requires requireAuth+requireAdmin
  // (a real JWT with role=ADMIN), not just the assistant-code header -- same
  // as the existing DELETE /api/docs/:id. A throwaway test-only admin user is
  // created here (never touches the real admin account) so the delete path
  // is genuinely exercised, then removed in cleanup.
  const testEmail = `test-admin-${Date.now()}@test.local`;
  const testPassword = `test-${Date.now()}`;
  const testUser = await prisma.user.create({
    data: { email: testEmail, passwordHash: bcrypt.hashSync(testPassword, 10), role: 'ADMIN' },
  });
  const login = await api('POST', '/api/auth/login', { username: testEmail, password: testPassword });
  if (login.status !== 200 || !login.body.token) throw new Error('could not log in as throwaway test admin: ' + JSON.stringify(login));

  AUTH_HEADER = { 'x-assistant-code': setting ? setting.value : '5678', Authorization: `Bearer ${login.body.token}` };

  // sanity: a pre-existing legacy route must still work unchanged
  const legacy = await api('GET', '/api/raw-materials');
  check('legacy GET /api/raw-materials (SkuLink-based) still works', legacy.status === 200 && Array.isArray(legacy.body));

  // kashrut bodies
  const bodies = await api('GET', '/api/kashrut-bodies');
  check('GET /api/kashrut-bodies returns the 11 seeded bodies', bodies.status === 200 && bodies.body.length === 11, bodies.body);
  const bodyLandau = bodies.body.find(b => b.name === 'הרב לנדא');
  const bodyOU = bodies.body.find(b => b.name === 'OU');
  check('seeded bodies include הרב לנדא and OU', !!bodyLandau && !!bodyOU);

  // create
  const name = `TEST-RawMaterial-${Date.now()}`;
  const created = await api('POST', '/api/raw-material-registry', { name, supplier: 'TEST-ספק' });
  check('POST /api/raw-material-registry creates a record', created.status === 201 && created.body.id, created);
  const id = created.body && created.body.id;

  // list + filter
  const list = await api('GET', '/api/raw-material-registry?q=' + encodeURIComponent(name));
  check('GET /api/raw-material-registry list finds it via q filter', list.status === 200 && list.body.some(r => r.id === id));

  // detail
  const detail = await api('GET', `/api/raw-material-registry/${id}`);
  check('GET detail returns empty documents/approvals for a fresh record', detail.status === 200 && detail.body.documents.length === 0 && detail.body.approvals.length === 0);

  // update
  const patched = await api('PATCH', `/api/raw-material-registry/${id}`, { notes: 'TEST-הערה', manufacturer: 'TEST-יצרן' });
  check('PATCH updates notes/manufacturer', patched.status === 200 && patched.body.notes === 'TEST-הערה' && patched.body.manufacturer === 'TEST-יצרן', patched.body);

  // link an existing real document by id (not a test artifact -- just a link, nothing created/deleted)
  const anyDoc = await prisma.document.findFirst({ orderBy: { id: 'asc' } });
  const linkedDoc = await api('POST', `/api/raw-material-registry/${id}/documents`, { docId: anyDoc.id, docRole: 'LABEL' });
  check('POST .../documents links an existing document with a role', linkedDoc.status === 201 && linkedDoc.body.docRole === 'LABEL', linkedDoc.body);

  // upload a brand-new file (multipart), exercising the R2 upload branch --
  // this DOES create a new Document row, captured for explicit cleanup below
  const fd = new FormData();
  fd.append('file', new Blob(['dummy content for API test'], { type: 'text/plain' }), 'test-label.txt');
  fd.append('name', 'TEST-uploaded-label');
  fd.append('docRole', 'ANALYSIS');
  const uploadedDoc = await api('POST', `/api/raw-material-registry/${id}/documents`, fd, true);
  check('POST .../documents uploads a new file and links it (ANALYSIS role)', uploadedDoc.status === 201 && uploadedDoc.body.docRole === 'ANALYSIS', uploadedDoc.body);
  const uploadedDocId = uploadedDoc.body && uploadedDoc.body.docId;

  // approvals matrix before any send -- every active body, all NOT_SENT
  const matrix0 = await api('GET', `/api/raw-materials/${id}/approvals`);
  check('GET approvals matrix returns one row per active body, all NOT_SENT', matrix0.status === 200 && matrix0.body.length === bodies.body.filter(b=>b.active).length && matrix0.body.every(a => a.status === 'NOT_SENT'));

  // send via EMAIL with recordOnly=true -- must NOT send a real email, just record
  const sendEmail = await api('POST', `/api/raw-materials/${id}/send`, {
    kashrutBodyId: bodyLandau.id, docIds: [anyDoc.id], via: 'EMAIL', recordOnly: true, message: 'TEST-בדיקה אוטומטית',
  });
  check('POST send EMAIL recordOnly=true records SENT_PENDING without emailing', sendEmail.status === 200 && sendEmail.body.status === 'SENT_PENDING' && sendEmail.body.sentVia === 'EMAIL', sendEmail.body);
  const approvalId = sendEmail.body && sendEmail.body.id;

  // send via WHATSAPP with recordOnly=true (the only mode allowed for WhatsApp)
  const sendWhatsapp = await api('POST', `/api/raw-materials/${id}/send`, {
    kashrutBodyId: bodyOU.id, docIds: [anyDoc.id], via: 'WHATSAPP', recordOnly: true,
  });
  check('POST send WHATSAPP recordOnly=true records SENT_PENDING', sendWhatsapp.status === 200 && sendWhatsapp.body.sentVia === 'WHATSAPP');

  // guard: WHATSAPP without recordOnly must be rejected (no server-side WhatsApp API exists)
  const sendWhatsappNoRecord = await api('POST', `/api/raw-materials/${id}/send`, {
    kashrutBodyId: bodyOU.id, docIds: [anyDoc.id], via: 'WHATSAPP',
  });
  check('POST send WHATSAPP without recordOnly is rejected (400)', sendWhatsappNoRecord.status === 400);

  // matrix after sending -- the two bodies sent to should now be SENT_PENDING, rest still NOT_SENT
  const matrix1 = await api('GET', `/api/raw-materials/${id}/approvals`);
  const sentCount = matrix1.body.filter(a => a.status === 'SENT_PENDING').length;
  check('matrix reflects exactly 2 SENT_PENDING after the two sends', sentCount === 2, matrix1.body.map(a=>[a.kashrutBodyName,a.status]));

  // patch the approval directly (level + condition + status -> CONDITIONAL)
  const patchApproval = await api('PATCH', `/api/approvals/${approvalId}`, {
    status: 'CONDITIONAL', kashrutLevel: 'מהדרין', conditionText: 'TEST: בתנאי שיצרפו ניתוח מעבדה', notes: 'TEST',
  });
  check('PATCH approval sets CONDITIONAL + conditionText', patchApproval.status === 200 && patchApproval.body.status === 'CONDITIONAL' && patchApproval.body.conditionText === 'TEST: בתנאי שיצרפו ניתוח מעבדה', patchApproval.body);

  // reply: upload a reply file, close out as APPROVED -- also creates a new
  // Document row, captured for explicit cleanup below
  const fd2 = new FormData();
  fd2.append('file', new Blob(['dummy reply pdf content'], { type: 'application/pdf' }), 'reply-test.pdf');
  fd2.append('name', 'TEST-reply-doc');
  fd2.append('status', 'APPROVED');
  fd2.append('notes', 'TEST: אושר בבדיקה');
  const reply = await api('POST', `/api/approvals/${approvalId}/reply`, fd2, true);
  check('POST reply sets status=APPROVED with a replyDocId', reply.status === 200 && reply.body.status === 'APPROVED' && !!reply.body.replyDocId, reply.body);
  const replyDocId = reply.body && reply.body.replyDocId;

  // event log actually grew (patch + 2 sends + reply all write events)
  const events = await prisma.rawMaterialApprovalEvent.count({ where: { approvalId } });
  check('RawMaterialApprovalEvent rows were written for this approval (>=3)', events >= 3, events);

  // link to a SKU (real SKU, not a test artifact -- just a link), then verify both read views
  const anySku = await prisma.sku.findFirst({ orderBy: { id: 'asc' } });
  const linkSku = await api('POST', `/api/raw-material-registry/${id}/skus`, { skuCode: anySku.code });
  check('POST .../skus links the raw material to a SKU', linkSku.status === 201, linkSku.body);

  const impact = await api('GET', `/api/raw-materials/${id}/skus`);
  check('GET impact view (raw material -> SKUs) shows the linked SKU', impact.status === 200 && impact.body.some(s => s.id === anySku.code));

  const skuView = await api('GET', `/api/skus/${anySku.code}/raw-materials`);
  check('GET SKU view (SKU -> raw materials) shows this raw material', skuView.status === 200 && skuView.body.some(r => r.rawMaterialId === id));

  // export endpoint: must reject without a key -- EXPORT_API_KEY isn't set in
  // .env yet, so this also confirms it fails closed rather than open
  const exportNoKey = await api('GET', '/api/export/raw-materials');
  check('GET export without API key is rejected (401) -- fail-closed since EXPORT_API_KEY is unset', exportNoKey.status === 401);

  // ── cleanup ──
  // capture R2 keys before deleting the Document rows, so the objects
  // themselves can be removed too, not just the DB rows
  const r2KeysToDelete = [];
  for (const docId of [uploadedDocId, replyDocId]) {
    if (!docId) continue;
    const d = await prisma.document.findUnique({ where: { id: docId } });
    if (d) r2KeysToDelete.push(d.fileUrl);
  }

  const del = await api('DELETE', `/api/raw-material-registry/${id}`);
  check('DELETE removes the test record (cascades RawMaterialDocument/Approval/Event/SkuRawMaterial)', del.status === 200, del);
  const afterDelete = await api('GET', `/api/raw-material-registry/${id}`);
  check('record is gone after delete (404)', afterDelete.status === 404);

  // the DELETE above only unlinks documents (same convention as the existing
  // DELETE /api/docs/:id -- never reaps the Document row itself), so the two
  // Document rows created by the multipart uploads need their own cleanup
  if (uploadedDocId) await prisma.document.delete({ where: { id: uploadedDocId } }).catch(() => {});
  if (replyDocId) await prisma.document.delete({ where: { id: replyDocId } }).catch(() => {});
  await prisma.skuRawMaterial.deleteMany({ where: { rawMaterialId: id } }).catch(() => {}); // safety net, should already be gone

  // remove the R2 objects for those same two test uploads
  if (r2KeysToDelete.length) {
    const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: 'auto', endpoint: process.env.R2_ENDPOINT,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
    for (const key of r2KeysToDelete) {
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key })).catch((e) => {
        console.log('  WARN could not delete R2 object', key, e.message);
      });
    }
    console.log(`  (deleted ${r2KeysToDelete.length} R2 object(s) created by this test run)`);
  }

  // remove the throwaway test-admin user
  await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});

  const after = await snapshot();
  let countsOk = true;
  for (const t of SNAPSHOT_TABLES) {
    if (before[t] !== after[t]) { countsOk = false; console.log(`  DIFF ${t}: before=${before[t]} after=${after[t]}`); }
  }
  check('all touched table row counts returned to their pre-test values', countsOk, { before, after });

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('TEST SCRIPT CRASHED:', e);
  await prisma.$disconnect();
  process.exit(1);
});
