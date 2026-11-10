/* Local smoke test for the raw-material-registry endpoints, covering Phase 3
 * plus the 3.11.2026 two-track revision (docrepo-phase4-v2-tracks.md R1+R2)
 * and the approvalSource/no-file addition made the same day.
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
  console.log('=== Raw-material registry API smoke test (live Neon DB, self-cleaning) ===\n');
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
  check('seeded bodies include הרב לנדא and OU (OU inactive since 2026-11-03, still exists)', !!bodyLandau && !!bodyOU && bodyOU.active === false);
  const activeBodies = bodies.body.filter(b => b.active);
  const passoverBodies = activeBodies.filter(b => b.handlesPassover);
  // distinct active bodies for the various send/patch/reply cases below
  const bodySecond = activeBodies.find(b => b.name !== bodyLandau.name && !b.handlesPassover) || activeBodies.find(b => b.name !== bodyLandau.name);
  const bodyPassover = passoverBodies[0];
  const bodyThird = activeBodies.find(b => b.id !== bodyLandau.id && b.id !== bodySecond.id && b.id !== (bodyPassover && bodyPassover.id));
  check('found distinct active bodies for the test cases (landau/second/passover/third)', !!bodyLandau && !!bodySecond && !!bodyPassover && !!bodyThird, { bodyLandau, bodySecond, bodyPassover, bodyThird });

  // create
  const name = `TEST-RawMaterial-${Date.now()}`;
  const created = await api('POST', '/api/raw-material-registry', { name, supplier: 'TEST-ספק' });
  check('POST /api/raw-material-registry creates a record', created.status === 201 && created.body.id, created);
  const id = created.body && created.body.id;

  // list + filter
  const list = await api('GET', '/api/raw-material-registry?q=' + encodeURIComponent(name));
  check('GET /api/raw-material-registry list finds it via q filter', list.status === 200 && list.body.some(r => r.id === id));
  check('list item exposes origin-kashrut fields (empty for a fresh record)', list.body[0] && 'originKashrutText' in list.body[0] && 'originHasCert' in list.body[0]);

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

  // ── approvals matrix (two-track): one row per active body for YEAR_ROUND,
  // plus one row per handlesPassover body for PASSOVER ──
  const expectedMatrixRows = activeBodies.length + passoverBodies.length;
  const matrix0 = await api('GET', `/api/raw-materials/${id}/approvals`);
  check('matrix row count = active bodies + passover-handling active bodies', matrix0.status === 200 && matrix0.body.length === expectedMatrixRows, { got: matrix0.body.length, expected: expectedMatrixRows });
  check('matrix rows all NOT_SENT with a track, no approvalSource yet', matrix0.body.every(a => a.status === 'NOT_SENT' && ['YEAR_ROUND', 'PASSOVER'].includes(a.track) && a.approvalSource == null));
  check('matrix includes a PASSOVER row only for handlesPassover bodies', matrix0.body.filter(a => a.track === 'PASSOVER').length === passoverBodies.length);
  check('matrix rows start with viaOrigin:false (no origin set yet)', matrix0.body.every(a => a.viaOrigin === false));

  // ── R1 follow-up: origin-kashrut fields + computed-origin-approval
  // (bodyPassover chosen as the origin body since it handlesPassover --
  // untouched by any send up to this point, so its computed rows are
  // visible before being overridden by a real send further down) ──
  const originPatch = await api('PATCH', `/api/raw-material-registry/${id}`, {
    originKashrutBodyId: bodyPassover.id, originKashrutText: 'TEST-OU', originHasCert: false,
    originPassoverStatus: 'PASSOVER_KITNIYOT', originPassoverText: 'TEST-OU-P',
  });
  check('PATCH sets origin-kashrut + origin-Passover fields', originPatch.status === 200 && originPatch.body.originKashrutBodyId === bodyPassover.id && originPatch.body.originPassoverStatus === 'PASSOVER_KITNIYOT' && originPatch.body.originPassoverText === 'TEST-OU-P', originPatch.body);

  const matrixOrigin = await api('GET', `/api/raw-materials/${id}/approvals`);
  const originYearRow = matrixOrigin.body.find(a => a.kashrutBodyId === bodyPassover.id && a.track === 'YEAR_ROUND');
  const originPassoverRow = matrixOrigin.body.find(a => a.kashrutBodyId === bodyPassover.id && a.track === 'PASSOVER');
  check('origin body YEAR_ROUND row computed as APPROVED/viaOrigin (no real row yet)', originYearRow && originYearRow.status === 'APPROVED' && originYearRow.viaOrigin === true, originYearRow);
  check('origin body PASSOVER row computed as APPROVED_KITNIYOT/viaOrigin (origin status was PASSOVER_KITNIYOT)', originPassoverRow && originPassoverRow.status === 'APPROVED_KITNIYOT' && originPassoverRow.viaOrigin === true, originPassoverRow);
  check('other bodies are unaffected by the origin computation (still real NOT_SENT)', matrixOrigin.body.filter(a => a.kashrutBodyId !== bodyPassover.id).every(a => a.status === 'NOT_SENT' && a.viaOrigin === false));

  // old single-body send shape still works (kashrutBodyId + contactId) --
  // defaults to track=YEAR_ROUND
  const sendEmail = await api('POST', `/api/raw-materials/${id}/send`, {
    kashrutBodyId: bodyLandau.id, docIds: [anyDoc.id], via: 'EMAIL', recordOnly: true, message: 'TEST-בדיקה אוטומטית',
  });
  check('POST send EMAIL (review-first rule) records SENT_FOR_REVIEW, sentAt unset -- never SENT_PENDING directly', sendEmail.status === 200 && sendEmail.body.status === 'SENT_FOR_REVIEW' && sendEmail.body.sentAt === null && sendEmail.body.sentVia === 'EMAIL' && sendEmail.body.track === 'YEAR_ROUND', sendEmail.body);
  const approvalId = sendEmail.body && sendEmail.body.id;

  const matrixAfterReviewSend = await api('GET', `/api/raw-materials/${id}/approvals`);
  check('exactly 1 SENT_FOR_REVIEW row right after the email send', matrixAfterReviewSend.body.filter(a => a.status === 'SENT_FOR_REVIEW').length === 1, matrixAfterReviewSend.body.map(a => [a.kashrutBodyName, a.status]));

  // confirm-forward: the user checked the review email and forwarded it himself
  const customSentAt = '2026-01-15T10:00:00.000Z';
  const confirmForward = await api('POST', `/api/approvals/${approvalId}/confirm-forward`, { sentAt: customSentAt });
  check('POST confirm-forward moves SENT_FOR_REVIEW -> SENT_PENDING with the given sentAt (editable)', confirmForward.status === 200 && confirmForward.body.status === 'SENT_PENDING' && new Date(confirmForward.body.sentAt).getTime() === new Date(customSentAt).getTime(), confirmForward.body);
  const confirmForwardEvents = await prisma.rawMaterialApprovalEvent.count({ where: { approvalId, type: 'SENT', toStatus: 'SENT_PENDING' } });
  check('confirm-forward wrote its own SENT event', confirmForwardEvents >= 1, confirmForwardEvents);
  const confirmForwardAgain = await api('POST', `/api/approvals/${approvalId}/confirm-forward`, {});
  check('confirm-forward again (already SENT_PENDING, not SENT_FOR_REVIEW) is rejected (400)', confirmForwardAgain.status === 400, confirmForwardAgain);

  const sendWhatsapp = await api('POST', `/api/raw-materials/${id}/send`, {
    kashrutBodyId: bodySecond.id, docIds: [anyDoc.id], via: 'WHATSAPP', recordOnly: true,
  });
  check('POST send WHATSAPP recordOnly=true records SENT_PENDING', sendWhatsapp.status === 200 && sendWhatsapp.body.sentVia === 'WHATSAPP');

  const sendWhatsappNoRecord = await api('POST', `/api/raw-materials/${id}/send`, {
    kashrutBodyId: bodySecond.id, docIds: [anyDoc.id], via: 'WHATSAPP',
  });
  check('POST send WHATSAPP without recordOnly is rejected (400)', sendWhatsappNoRecord.status === 400);

  // ── new multi-body x multi-track send shape ──
  const multiSend = await api('POST', `/api/raw-materials/${id}/send`, {
    kashrutBodyIds: [bodyThird.id, bodyPassover.id], tracks: ['YEAR_ROUND', 'PASSOVER'],
    docIds: [anyDoc.id], via: 'WHATSAPP', recordOnly: true,
  });
  check('POST multi-body/multi-track send returns an array of 4 (2 bodies x 2 tracks)', multiSend.status === 200 && Array.isArray(multiSend.body) && multiSend.body.length === 4, multiSend.body);
  check('multi-send results cover both tracks for both bodies', multiSend.status === 200 && ['YEAR_ROUND', 'PASSOVER'].every(t => multiSend.body.filter(a => a.track === t).length === 2));

  const matrix1 = await api('GET', `/api/raw-materials/${id}/approvals`);
  const sentCount = matrix1.body.filter(a => a.status === 'SENT_PENDING').length;
  check('matrix reflects 6 SENT_PENDING after single-sends (2) + multi-send (4)', sentCount === 6, matrix1.body.map(a => [a.kashrutBodyName, a.track, a.status]));
  const bodyPassoverRowsNow = matrix1.body.filter(a => a.kashrutBodyId === bodyPassover.id);
  check('a real send on the origin body replaces the computed-origin row (no longer viaOrigin)', bodyPassoverRowsNow.every(a => a.status === 'SENT_PENDING' && a.viaOrigin === false), bodyPassoverRowsNow);

  // ── track-specific status validation (R1: CONDITIONAL only YEAR_ROUND,
  // APPROVED_KITNIYOT only PASSOVER) ──
  const yearRoundApproval = multiSend.body.find(a => a.kashrutBodyId === bodyThird.id && a.track === 'YEAR_ROUND');
  const passoverApproval = multiSend.body.find(a => a.kashrutBodyId === bodyPassover.id && a.track === 'PASSOVER');
  const badKitniyot = await api('PATCH', `/api/approvals/${yearRoundApproval.id}`, { status: 'APPROVED_KITNIYOT', approvalSource: 'OTHER' });
  check('PATCH rejects APPROVED_KITNIYOT on a YEAR_ROUND approval (400)', badKitniyot.status === 400, badKitniyot);
  const badConditional = await api('PATCH', `/api/approvals/${passoverApproval.id}`, { status: 'CONDITIONAL', approvalSource: 'OTHER' });
  check('PATCH rejects CONDITIONAL on a PASSOVER approval (400)', badConditional.status === 400, badConditional);
  const goodKitniyot = await api('PATCH', `/api/approvals/${passoverApproval.id}`, { status: 'APPROVED_KITNIYOT', approvalSource: 'OTHER' });
  check('PATCH accepts APPROVED_KITNIYOT on a PASSOVER approval', goodKitniyot.status === 200 && goodKitniyot.body.status === 'APPROVED_KITNIYOT', goodKitniyot.body);

  // patch the landau approval directly (level + condition + status -> CONDITIONAL)
  // -- no file yet on this approval, so approvalSource is now required
  const patchNoSource = await api('PATCH', `/api/approvals/${approvalId}`, { status: 'CONDITIONAL' });
  check('PATCH status change with no reply file and no approvalSource is rejected (400)', patchNoSource.status === 400, patchNoSource);
  const patchApproval = await api('PATCH', `/api/approvals/${approvalId}`, {
    status: 'CONDITIONAL', kashrutLevel: 'מהדרין', conditionText: 'TEST: בתנאי שיצרפו ניתוח מעבדה', notes: 'TEST',
    approvalSource: 'OTHER', approvalSourceDetail: 'TEST: צוין בטופס הבדיקה',
  });
  check('PATCH approval sets CONDITIONAL + conditionText + approvalSource', patchApproval.status === 200 && patchApproval.body.status === 'CONDITIONAL' && patchApproval.body.conditionText === 'TEST: בתנאי שיצרפו ניתוח מעבדה' && patchApproval.body.approvalSource === 'OTHER', patchApproval.body);

  // ── get-or-create an approval row + manual approve from NOT_SENT, no file,
  // source=PHONE (the addition made 3.11.2026) ──
  const getOrCreate = await api('POST', `/api/raw-material-registry/${id}/approvals`, { kashrutBodyId: bodySecond.id, track: 'PASSOVER' });
  check('POST .../approvals get-or-creates a NOT_SENT row (never sent)', getOrCreate.status === 201 && getOrCreate.body.status === 'NOT_SENT' && getOrCreate.body.track === 'PASSOVER', getOrCreate.body);
  const getOrCreateAgain = await api('POST', `/api/raw-material-registry/${id}/approvals`, { kashrutBodyId: bodySecond.id, track: 'PASSOVER' });
  check('calling it again returns the same row (idempotent get-or-create)', getOrCreateAgain.body.id === getOrCreate.body.id);

  const phonePatchNoSource = await api('PATCH', `/api/approvals/${getOrCreate.body.id}`, { status: 'APPROVED_KITNIYOT' });
  check('manual approve from NOT_SENT with no approvalSource is rejected (400)', phonePatchNoSource.status === 400, phonePatchNoSource);
  const phonePatch = await api('PATCH', `/api/approvals/${getOrCreate.body.id}`, {
    status: 'APPROVED_KITNIYOT', approvalSource: 'PHONE', approvalSourceDetail: 'TEST: שיחת טלפון עם הרב',
  });
  check('manual approve from NOT_SENT with source=PHONE, no file, succeeds', phonePatch.status === 200 && phonePatch.body.status === 'APPROVED_KITNIYOT' && phonePatch.body.approvalSource === 'PHONE' && !phonePatch.body.replyDocId, phonePatch.body);

  // ── reply: upload a reply file, close out as APPROVED. Also exercises
  // alsoApprovalId closing both tracks of the same body with one letter ──
  const alsoRow = await api('POST', `/api/raw-material-registry/${id}/approvals`, { kashrutBodyId: bodyLandau.id, track: 'PASSOVER' });
  check('get-or-create a PASSOVER row for bodyLandau to pair with its YEAR_ROUND approval', alsoRow.status === 201);

  const fd2 = new FormData();
  fd2.append('file', new Blob(['dummy reply pdf content'], { type: 'application/pdf' }), 'reply-test.pdf');
  fd2.append('name', 'TEST-reply-doc');
  fd2.append('status', 'APPROVED');
  fd2.append('notes', 'TEST: אושר בבדיקה');
  fd2.append('alsoApprovalId', String(alsoRow.body.id));
  fd2.append('alsoStatus', 'APPROVED_KITNIYOT');
  fd2.append('alsoSeasonYear', 'תשפ"ז');
  const reply = await api('POST', `/api/approvals/${approvalId}/reply`, fd2, true);
  check('POST reply sets status=APPROVED with a replyDocId', reply.status === 200 && Array.isArray(reply.body) && reply.body[0].status === 'APPROVED' && !!reply.body[0].replyDocId, reply.body);
  check('POST reply also closes the alsoApprovalId track (PASSOVER/APPROVED_KITNIYOT) with the same file', Array.isArray(reply.body) && reply.body[1].status === 'APPROVED_KITNIYOT' && reply.body[1].seasonYear === 'תשפ"ז' && reply.body[1].replyDocId === reply.body[0].replyDocId, reply.body);
  check('shared notes landed on the also-track too (R6 symmetry fix)', Array.isArray(reply.body) && reply.body[1].notes === 'TEST: אושר בבדיקה', reply.body[1]);
  const replyDocId = reply.body && reply.body[0] && reply.body[0].replyDocId;

  const events = await prisma.rawMaterialApprovalEvent.count({ where: { approvalId } });
  check('RawMaterialApprovalEvent rows were written for the landau approval (>=3)', events >= 3, events);

  const eventsRead = await api('GET', `/api/approvals/${approvalId}/events`);
  check('GET .../events returns the full history, newest first', eventsRead.status === 200 && eventsRead.body.length === events && new Date(eventsRead.body[0].at) >= new Date(eventsRead.body[eventsRead.body.length - 1].at), eventsRead.body);
  check('event rows carry type/at/byUserName', eventsRead.body.every(e => e.type && e.at && 'byUserName' in e));

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

  // R10: Excel export -- scoped to just this test record (ids filter), two
  // sheets, matching the live matrix endpoint's status computation exactly.
  const exportRes = await fetch(`${BASE}/api/raw-material-registry/export`, {
    method: 'POST', headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [id] }),
  });
  check('R10: export returns 200', exportRes.status === 200);
  check('R10: export content-type is xlsx', (exportRes.headers.get('content-type') || '').includes('spreadsheetml'));
  const exportBuf = Buffer.from(await exportRes.arrayBuffer());
  const ExcelJS = require('exceljs');
  const exportWb = new ExcelJS.Workbook();
  await exportWb.xlsx.load(exportBuf);
  const ws1 = exportWb.getWorksheet('סטטוס');
  const ws2 = exportWb.getWorksheet('פירוט');
  check('R10: sheet 1 "סטטוס" exists with a data row for the test material', ws1 && ws1.getCell('A2').value && ws1.getCell('A2').value.includes('TEST-'));
  check('R10: sheet 2 "פירוט" exists with at least one approval row', ws2 && ws2.rowCount >= 2);
  check('R10: sheet 1 is frozen (xSplit/ySplit)', ws1.views[0] && ws1.views[0].state === 'frozen' && ws1.views[0].xSplit === 1 && ws1.views[0].ySplit === 1);
  // the body we sent to -> should show a colored, non-empty status cell for its year-round column
  const bodyColHeader = ws1.getRow(1).values.find(v => typeof v === 'string' && v.includes('– שנה'));
  check('R10: at least one body status column has a header', !!bodyColHeader);
  let foundColoredStatusCell = false;
  for (let c = 8; c <= ws1.columnCount; c++) {
    const cell = ws1.getRow(2).getCell(c);
    if (cell.value && cell.fill && cell.fill.fgColor) { foundColoredStatusCell = true; break; }
  }
  check('R10: at least one status cell in the test row has both a label and a fill color', foundColoredStatusCell);

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
