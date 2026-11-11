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

const SNAPSHOT_TABLES = ['document', 'rawMaterial', 'rawMaterialDocument', 'rawMaterialApproval', 'rawMaterialApprovalEvent', 'skuRawMaterial', 'rawMaterialImport', 'user'];
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
  check('GET SKU view (SKU -> raw materials) shows this raw material', skuView.status === 200 && skuView.body.items.some(r => r.rawMaterialId === id));

  // R8 fix (11.11.2026): a dedicated test SKU whose required body
  // (bodyLandau, via the alias "לנדא") matches real approvals already set
  // on `id`'s raw material above -- YEAR_ROUND=APPROVED (from the reply),
  // PASSOVER=APPROVED_KITNIYOT (from the also-track close) -- to verify
  // the two tracks are actually split, not just "whichever came first".
  const r8Sku = await prisma.sku.create({ data: { code: 'TEST-R8-SKU', name: 'TEST-R8 מקט', kashrutBodyRef: 'לנדא', active: true } });
  const r8Link = await api('POST', `/api/raw-material-registry/${id}/skus`, { skuCode: r8Sku.code });
  check('R8: link the test SKU to the same raw material', r8Link.status === 201, r8Link.body);
  const r8View = await api('GET', `/api/skus/${r8Sku.code}/raw-materials`);
  const r8Item = r8View.body.items.find(r => r.rawMaterialId === id);
  check('R8: requiredKashrutBody resolves the alias to the real body name', r8View.body.requiredKashrutBody === bodyLandau.name, r8View.body);
  check('R8: YEAR_ROUND required-approval is the real APPROVED row (not PASSOVER\'s)', r8Item && r8Item.requiredApprovalYearRound && r8Item.requiredApprovalYearRound.status === 'APPROVED' && r8Item.requiredApprovalYearRound.track === 'YEAR_ROUND', r8Item);
  check('R8: PASSOVER required-approval is the real APPROVED_KITNIYOT row (both tracks present, not just one)', r8Item && r8Item.requiredApprovalPassover && r8Item.requiredApprovalPassover.status === 'APPROVED_KITNIYOT' && r8Item.requiredApprovalPassover.track === 'PASSOVER', r8Item);
  // per-item summaryYearRound/summaryPassover deliberately summarize this
  // raw material's status across ALL bodies for that track (general
  // health), not just the required body -- `id`'s material has other
  // bodies' approvals in non-APPROVED states from earlier in this test,
  // so MISSING here is correct; the required-body-specific status is
  // requiredApprovalYearRound/Passover above, already verified.
  check('R8: per-item summaryYearRound/summaryPassover reflect ALL bodies, not just the required one (MISSING here, since other bodies aren\'t all approved)', r8Item && r8Item.summaryYearRound === 'MISSING' && r8Item.summaryPassover === 'MISSING', r8Item);
  check('R8: top-level summary badges (one per track) both ALL_APPROVED', r8View.body.summaryBadgeYearRound === 'ALL_APPROVED' && r8View.body.summaryBadgePassover === 'ALL_APPROVED', r8View.body);

  await prisma.skuRawMaterial.deleteMany({ where: { skuId: r8Sku.id } });
  await prisma.sku.delete({ where: { id: r8Sku.id } });

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

  // R10 color-scheme fix (10.11.2026): לא נשלח blank/no-fill; everything
  // else from the new light-fill/dark-text palette, never the old solid
  // dot colors.
  const NEW_PALETTE_FILLS = new Set(['FFC6EFCE', 'FFFFC7CE', 'FFFFEB9C', 'FFFFE0B2']);
  let foundBlankNotSentCell = false, allFillsFromNewPalette = true, foundAnyFill = false;
  for (let c = 8; c <= ws1.columnCount; c++) {
    const cell = ws1.getRow(2).getCell(c);
    if (!cell.value && !(cell.fill && cell.fill.fgColor)) foundBlankNotSentCell = true;
    if (cell.fill && cell.fill.fgColor) {
      foundAnyFill = true;
      if (!NEW_PALETTE_FILLS.has(cell.fill.fgColor.argb)) allFillsFromNewPalette = false;
    }
  }
  check('R10: at least one NOT_SENT body column is blank with no fill at all', foundBlankNotSentCell);
  check('R10: every filled status cell uses the new light-fill palette (no old solid dot colors)', foundAnyFill && allFillsFromNewPalette);

  // R11: Excel/CSV import -- requireAuth gating, parse/preview/commit,
  // duplicate detection (supplierItemCode + normalized name+supplier),
  // unknown-SKU error rows, fill-empty-on-existing, importId filtering.
  const r11Name1 = 'TEST-R11-new-' + Date.now();
  const r11Name2 = 'TEST-R11-dup-' + Date.now(); // will collide by name+supplier with an existing record created below
  const r11Supplier = 'TEST-R11-SUP';
  const csvText = `שם,ספק,יצרן,כשרות מקור,מק"ט,הערות,קוד ספק\n`
    + `${r11Name1},${r11Supplier},TEST-MFR,TEST-OU,${anySku.code},TEST note,ITEMCODE-1\n`
    + `${r11Name2},${r11Supplier},TEST-MFR,TEST-OU,,TEST note 2,\n`
    + `,TEST-NO-NAME-SUP,,,,,\n` // ERROR: missing name
    + `TEST-R11-badsku,TEST-SUP,,,TEST-NONEXISTENT-SKU-CODE-XYZ,,\n`; // ERROR: unknown SKU
  const csvBuf = Buffer.from(csvText, 'utf8');

  // pre-existing record for the name+supplier duplicate match
  const preexisting = await prisma.rawMaterial.create({ data: { name: r11Name2, supplier: r11Supplier, manufacturer: null, notes: null } });

  // gating: requireAuth rejects the assistant-code-only pseudo-auth (no Bearer)
  const setting2 = await prisma.syncState.findUnique({ where: { key: 'assistant_code' } });
  const assistantOnlyHeader = { 'x-assistant-code': setting2 ? setting2.value : '5678' };
  const fdGate = new FormData();
  fdGate.append('file', new Blob([csvBuf]), 'test.csv');
  const gateRes = await fetch(`${BASE}/api/raw-material-registry/import/parse`, { method: 'POST', headers: assistantOnlyHeader, body: fdGate });
  check('R11: import/parse rejects assistant-code-only auth (401, not available for assistant role)', gateRes.status === 401);

  const fdParse = new FormData();
  fdParse.append('file', new Blob([csvBuf]), 'test.csv');
  const parseRes = await fetch(`${BASE}/api/raw-material-registry/import/parse`, { method: 'POST', headers: AUTH_HEADER, body: fdParse });
  const parseBody = await parseRes.json();
  check('R11: import/parse returns 200 with headers+rows+guessed mapping', parseRes.status === 200 && parseBody.rows.length === 4);
  check('R11: mapping auto-guessed name/supplier/skuCodes/supplierItemCode columns', parseBody.mapping.name != null && parseBody.mapping.supplier != null && parseBody.mapping.skuCodes != null && parseBody.mapping.supplierItemCode != null);

  const previewRes = await api('POST', '/api/raw-material-registry/import/preview', { rows: parseBody.rows, mapping: parseBody.mapping });
  check('R11: preview returns 200', previewRes.status === 200);
  const previewRows = previewRes.body.rows;
  const rowNew = previewRows.find(r => r.name === r11Name1);
  const rowDup = previewRows.find(r => r.name === r11Name2);
  const rowNoName = previewRows.find(r => !r.name);
  const rowBadSku = previewRows.find(r => r.name === 'TEST-R11-badsku');
  check('R11: row with a known SKU code and no existing match classified NEW', rowNew && rowNew.classification === 'NEW');
  check('R11: row matching an existing name+supplier classified EXISTING', rowDup && rowDup.classification === 'EXISTING' && rowDup.matchedExistingId === preexisting.id);
  check('R11: row with missing name classified ERROR', rowNoName && rowNoName.classification === 'ERROR');
  check('R11: row with an unknown SKU code classified ERROR', rowBadSku && rowBadSku.classification === 'ERROR');
  check('R11: counts match NEW=1, EXISTING=1, ERROR=2', previewRes.body.counts.NEW === 1 && previewRes.body.counts.EXISTING === 1 && previewRes.body.counts.ERROR === 2);

  // commit: select the NEW row and the EXISTING (duplicate) row, with fillEmptyOnExisting -- ERROR rows are never selectable
  const fdCommit = new FormData();
  fdCommit.append('file', new Blob([csvBuf]), 'test.csv');
  fdCommit.append('rows', JSON.stringify(parseBody.rows));
  fdCommit.append('mapping', JSON.stringify(parseBody.mapping));
  fdCommit.append('selectedIndexes', JSON.stringify([rowNew.rowIndex, rowDup.rowIndex]));
  fdCommit.append('fillEmptyOnExisting', '1');
  const commitRes = await fetch(`${BASE}/api/raw-material-registry/import/commit`, { method: 'POST', headers: AUTH_HEADER, body: fdCommit });
  const commitBody = await commitRes.json();
  check('R11: commit returns 200 with rowsCreated=1 (the duplicate is never created, only filled)', commitRes.status === 200 && commitBody.rowsCreated === 1);
  check('R11: rowsSkipped counts the duplicate + 2 errors', commitBody.rowsSkipped === 3);

  const createdR11 = await prisma.rawMaterial.findFirst({ where: { name: r11Name1 } });
  check('R11: the NEW row was actually created with supplierItemCode + importId set', createdR11 && createdR11.supplierItemCode === 'ITEMCODE-1' && createdR11.importId === commitBody.importId);
  const skuLinkR11 = await prisma.skuRawMaterial.findFirst({ where: { rawMaterialId: createdR11.id, skuId: anySku.id } });
  check('R11: the NEW row got linked to the SKU found in its skuCodes column', !!skuLinkR11);

  const preexistingAfter = await prisma.rawMaterial.findUnique({ where: { id: preexisting.id } });
  check('R11: the EXISTING (duplicate) row was never overwritten by name/supplier (unchanged)', preexistingAfter.name === r11Name2 && preexistingAfter.supplier === r11Supplier);
  check('R11: fillEmptyOnExisting filled the empty manufacturer/notes on the duplicate, without touching name/supplier', preexistingAfter.manufacturer === 'TEST-MFR' && preexistingAfter.notes === 'TEST note 2');

  const importBatch = await prisma.rawMaterialImport.findUnique({ where: { id: commitBody.importId } });
  check('R11: RawMaterialImport batch recorded rowsCreated/rowsSkipped and a linked fileDoc', importBatch && importBatch.rowsCreated === 1 && importBatch.rowsSkipped === 3 && importBatch.fileDocId != null);
  const importFileDoc = await prisma.document.findUnique({ where: { id: importBatch.fileDocId } });
  check('R11: the uploaded file was saved as a Document', !!importFileDoc);

  const listRes = await api('GET', '/api/raw-material-registry');
  const listCreatedR11 = listRes.body.find(r => r.id === createdR11.id);
  check('R11: list endpoint exposes importId/supplierItemCode on the new record (for the מייבוא אחרון filter)', listCreatedR11 && listCreatedR11.importId === commitBody.importId && listCreatedR11.supplierItemCode === 'ITEMCODE-1');

  // R11 cleanup (separate from the main record's cleanup below)
  await prisma.skuRawMaterial.deleteMany({ where: { rawMaterialId: createdR11.id } });
  await prisma.rawMaterial.delete({ where: { id: createdR11.id } });
  await prisma.rawMaterial.update({ where: { id: preexisting.id }, data: { manufacturer: null, notes: null } }); // undo the fill before deleting, harmless either way since the row is deleted next
  await prisma.rawMaterial.delete({ where: { id: preexisting.id } });
  await prisma.document.delete({ where: { id: importBatch.fileDocId } });
  await prisma.rawMaterialImport.delete({ where: { id: importBatch.id } });
  {
    const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({ region: 'auto', endpoint: process.env.R2_ENDPOINT, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: importFileDoc.fileUrl })).catch((e) => console.log('  WARN could not delete R2 object', importFileDoc.fileUrl, e.message));
  }

  // R12: bulk send -- 2 raw materials x 2 bodies x 2 tracks = 8 approval
  // rows. recordOnly=true even for EMAIL (same convention as the existing
  // single-send test above) -- never calls nodemailer, never sends a real
  // email, but still exercises the full review-first status/event logic.
  const bulkRm1 = await prisma.rawMaterial.create({ data: { name: 'TEST-R12-bulk-1', supplier: 'TEST-SUP', manufacturer: 'TEST-MFR-1' } });
  const bulkRm2 = await prisma.rawMaterial.create({ data: { name: 'TEST-R12-bulk-2', supplier: 'TEST-SUP', manufacturer: 'TEST-MFR-2' } });
  const bulkSend = await api('POST', '/api/raw-material-registry/bulk-send', {
    rawMaterialIds: [bulkRm1.id, bulkRm2.id], kashrutBodyIds: [bodyLandau.id, bodySecond.id],
    tracks: ['YEAR_ROUND', 'PASSOVER'], via: 'EMAIL', recordOnly: true, message: 'TEST-בדיקה מרוכזת',
  });
  check('R12: bulk-send returns 200 with approvalsCreated=8 (2 materials x 2 bodies x 2 tracks)', bulkSend.status === 200 && bulkSend.body.approvalsCreated === 8, bulkSend.body);

  const bulkApprovals = await prisma.rawMaterialApproval.findMany({ where: { rawMaterialId: { in: [bulkRm1.id, bulkRm2.id] } } });
  check('R12: exactly 8 RawMaterialApproval rows created', bulkApprovals.length === 8);
  check('R12: all 8 are SENT_FOR_REVIEW with sentAt unset (review-first rule, never SENT_PENDING directly)', bulkApprovals.every(a => a.status === 'SENT_FOR_REVIEW' && a.sentAt === null));
  check('R12: every (rawMaterial, body, track) combination is covered exactly once', new Set(bulkApprovals.map(a => `${a.rawMaterialId}|${a.kashrutBodyId}|${a.track}`)).size === 8);

  const bulkEvents = await prisma.rawMaterialApprovalEvent.findMany({ where: { approvalId: { in: bulkApprovals.map(a => a.id) } } });
  check('R12: a SENT event was written for each of the 8 approvals', bulkEvents.length === 8 && bulkEvents.every(e => e.type === 'SENT' && e.payload.bulk === true));

  // missing kashrutBodyIds / rawMaterialIds are rejected
  const bulkMissingBodies = await api('POST', '/api/raw-material-registry/bulk-send', { rawMaterialIds: [bulkRm1.id], via: 'EMAIL', recordOnly: true });
  check('R12: bulk-send without kashrutBodyIds is rejected (400)', bulkMissingBodies.status === 400);
  const bulkMissingMaterials = await api('POST', '/api/raw-material-registry/bulk-send', { kashrutBodyIds: [bodyLandau.id], via: 'EMAIL', recordOnly: true });
  check('R12: bulk-send without rawMaterialIds is rejected (400)', bulkMissingMaterials.status === 400);

  // R12 cleanup
  await prisma.rawMaterialApprovalEvent.deleteMany({ where: { approvalId: { in: bulkApprovals.map(a => a.id) } } });
  await prisma.rawMaterialApproval.deleteMany({ where: { rawMaterialId: { in: [bulkRm1.id, bulkRm2.id] } } });
  await prisma.rawMaterial.deleteMany({ where: { id: { in: [bulkRm1.id, bulkRm2.id] } } });

  // Archive/restore (10.11.2026, additive, same pattern as Document):
  // hidden from the list/export by default, rejected from bulk-send,
  // visible + restorable via includeArchived=1.
  const archiveRm = await prisma.rawMaterial.create({ data: { name: 'TEST-ARCHIVE-1', supplier: 'TEST-SUP' } });
  const archiveRes = await api('POST', `/api/raw-material-registry/${archiveRm.id}/archive`, { reason: 'TEST-לא רלוונטי' });
  check('archive endpoint sets archived=true + archivedReason', archiveRes.status === 200 && archiveRes.body.archived === true && archiveRes.body.archivedReason === 'TEST-לא רלוונטי', archiveRes.body);

  const listDefault = await api('GET', '/api/raw-material-registry');
  check('archived record hidden from the default list', !listDefault.body.some(r => r.id === archiveRm.id));
  const listIncluding = await api('GET', '/api/raw-material-registry?includeArchived=1');
  check('archived record visible with includeArchived=1', listIncluding.body.some(r => r.id === archiveRm.id));

  const exportDefault = await fetch(`${BASE}/api/raw-material-registry/export`, { method: 'POST', headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  const exportDefaultBuf = Buffer.from(await exportDefault.arrayBuffer());
  const exportDefaultWb = new ExcelJS.Workbook();
  await exportDefaultWb.xlsx.load(exportDefaultBuf);
  const exportDefaultWs1 = exportDefaultWb.getWorksheet('סטטוס');
  let foundArchivedInDefaultExport = false;
  for (let r = 2; r <= exportDefaultWs1.rowCount; r++) if (exportDefaultWs1.getCell(`A${r}`).value === 'TEST-ARCHIVE-1') foundArchivedInDefaultExport = true;
  check('archived record excluded from a no-ids (export-all) call', !foundArchivedInDefaultExport);

  const bulkSendArchived = await api('POST', '/api/raw-material-registry/bulk-send', {
    rawMaterialIds: [archiveRm.id], kashrutBodyIds: [bodyLandau.id], tracks: ['YEAR_ROUND'], via: 'EMAIL', recordOnly: true,
  });
  check('bulk-send rejects an archived raw material (400)', bulkSendArchived.status === 400 && bulkSendArchived.body.error.includes('TEST-ARCHIVE-1'), bulkSendArchived.body);

  const restoreRes = await api('POST', `/api/raw-material-registry/${archiveRm.id}/restore`);
  check('restore endpoint clears archived + archivedReason', restoreRes.status === 200 && restoreRes.body.archived === false && restoreRes.body.archivedReason === '', restoreRes.body);
  const listAfterRestore = await api('GET', '/api/raw-material-registry');
  check('restored record reappears in the default list', listAfterRestore.body.some(r => r.id === archiveRm.id));

  await prisma.rawMaterial.delete({ where: { id: archiveRm.id } });

  // R7: add raw material (create now also accepts originKashrutText +
  // allergens directly) and "🤖 זהה מהתווית" validation. The real Claude
  // call itself was verified manually against an existing label photo
  // (Document 984) rather than in this permanent suite, to avoid a
  // recurring API call/cost on every regression run -- same precedent as
  // the pre-existing /api/identify, which also isn't exercised here.
  const r7Create = await api('POST', '/api/raw-material-registry', {
    name: 'TEST-R7-new', supplier: 'TEST-SUP', manufacturer: 'TEST-MFR',
    originKashrutText: 'TEST-OU', allergens: 'TEST-מכיל גלוטן',
  });
  check('R7: create accepts originKashrutText + allergens directly', r7Create.status === 201 && r7Create.body.originKashrutText === 'TEST-OU' && r7Create.body.allergens === 'TEST-מכיל גלוטן', r7Create.body);

  const r7Patch = await api('PATCH', `/api/raw-material-registry/${r7Create.body.id}`, { allergens: 'TEST-מכיל אגוזים' });
  check('R7: PATCH updates allergens', r7Patch.status === 200 && r7Patch.body.allergens === 'TEST-מכיל אגוזים', r7Patch.body);

  const r7NoFile = await fetch(`${BASE}/api/raw-material-registry/identify-label`, { method: 'POST', headers: AUTH_HEADER, body: new FormData() });
  check('R7: identify-label without a file is rejected (400)', r7NoFile.status === 400);
  const fdBadExt = new FormData();
  fdBadExt.append('file', new Blob([Buffer.from('TEST')], { type: 'text/plain' }), 'test.txt');
  const r7BadExt = await fetch(`${BASE}/api/raw-material-registry/identify-label`, { method: 'POST', headers: AUTH_HEADER, body: fdBadExt });
  check('R7: identify-label rejects an unsupported file type (400)', r7BadExt.status === 400);

  await prisma.rawMaterial.delete({ where: { id: r7Create.body.id } });

  // R9: contacts (create/edit/assign to a body, never deleted by this
  // screen) + bodies settings (admin only).
  const r9Contact = await api('POST', '/api/contacts', {
    name: 'TEST-R9-Contact', email: 'test-r9@example.com', kashrutBodyId: bodyLandau.id, role: 'משגיח',
  });
  check('R9: create contact accepts kashrutBodyId + role', r9Contact.status === 201 && r9Contact.body.kashrutBodyId === bodyLandau.id && r9Contact.body.role === 'משגיח', r9Contact.body);

  const r9ContactPatch = await api('PATCH', `/api/contacts/${r9Contact.body.id}`, { kashrutBodyId: bodySecond.id, role: 'מזכירות' });
  check('R9: PATCH reassigns the contact to a different body + role', r9ContactPatch.status === 200 && r9ContactPatch.body.kashrutBodyId === bodySecond.id && r9ContactPatch.body.role === 'מזכירות', r9ContactPatch.body);

  const r9ContactNoChannel = await api('PATCH', `/api/contacts/${r9Contact.body.id}`, { email: '', phone: '' });
  check('R9: PATCH rejects clearing both email and phone (400)', r9ContactNoChannel.status === 400);

  const r9BodyPatch = await api('PATCH', `/api/kashrut-bodies/${bodySecond.id}`, {
    shortName: 'TEST-קצר', active: true, handlesPassover: true, sortOrder: 7, defaultContactId: r9Contact.body.id,
  });
  check('R9: admin PATCH updates all 5 body settings fields', r9BodyPatch.status === 200
    && r9BodyPatch.body.shortName === 'TEST-קצר' && r9BodyPatch.body.handlesPassover === true
    && r9BodyPatch.body.sortOrder === 7 && r9BodyPatch.body.defaultContactId === r9Contact.body.id, r9BodyPatch.body);

  const r9BodiesList = await api('GET', '/api/kashrut-bodies');
  const r9BodyInList = r9BodiesList.body.find(b => b.id === bodySecond.id);
  check('R9: GET /api/kashrut-bodies now exposes defaultContactId', r9BodyInList && r9BodyInList.defaultContactId === r9Contact.body.id, r9BodyInList);

  const r9BodyPatchNonAdmin = await fetch(`${BASE}/api/kashrut-bodies/${bodySecond.id}`, {
    method: 'PATCH', headers: { ...assistantOnlyHeader, 'Content-Type': 'application/json' }, body: JSON.stringify({ sortOrder: 99 }),
  });
  // requireAuth (used here, same as R11's import routes) only ever looks
  // at a real Bearer token -- the assistant-code-only header has none, so
  // it's rejected at the requireAuth stage itself (401), never even
  // reaching the requireAdmin check (which would be 403).
  check('R9: bodies settings PATCH is admin-only (401 for assistant-code-only auth, rejected before reaching the admin check)', r9BodyPatchNonAdmin.status === 401);

  // revert the body's settings change and clean up
  await prisma.kashrutBody.update({ where: { id: bodySecond.id }, data: { shortName: null, sortOrder: 100, handlesPassover: bodySecond.handlesPassover, defaultContactId: null } });
  await prisma.contact.delete({ where: { id: r9Contact.body.id } });

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
