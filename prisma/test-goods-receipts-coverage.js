/* S2 coverage-check smoke test. Creates throwaway TEST- data (an IMPORT sku
 * with an APPROVED Rabbinate-cert link valid on the receipt date, an IMPORT
 * sku with no link at all, and a LOCAL sku to confirm it's skipped), runs
 * the real /preview endpoint against a synthetic receipt file covering all
 * three, then deletes every row it created. Never writes a GoodsReceipt row
 * (preview only) and never touches the 60 kashrut conflicts or 115 new SKUs
 * from S1 -- this only creates its own disposable TEST- SKU codes. */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

function csvField(v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function csvRow(fields) { return fields.map(csvField).join(','); }
const HEADER = ['פריט', 'תיאור פריט', 'קליטה', 'תאריך קליטה', 'פג תוקף', 'כמות', 'אצווה', 'תאריך יצור'];

(async () => {
  const testEmail = `test-admin-${Date.now()}@test.local`;
  const testPassword = `test-${Date.now()}`;
  const testUser = await prisma.user.create({
    data: { email: testEmail, passwordHash: bcrypt.hashSync(testPassword, 10), role: 'ADMIN' },
  });

  const skuCovered = await prisma.sku.create({ data: { code: 'TEST-GRI-COVERED-1', name: 'TEST מק"ט מכוסה', source: 'IMPORT', active: true } });
  const skuUncovered = await prisma.sku.create({ data: { code: 'TEST-GRI-UNCOVERED-1', name: 'TEST מק"ט לא מכוסה', source: 'IMPORT', active: true } });
  const skuLocal = await prisma.sku.create({ data: { code: 'TEST-GRI-LOCAL-1', name: 'TEST מק"ט מקומי', source: 'LOCAL', active: true } });
  const cert = await prisma.rabbinateCert.create({ data: { refNumber: 'TEST-CERT-1', status: 'תקף', expiryDate: new Date('2027-01-01') } });
  const link = await prisma.skuLink.create({ data: { skuId: skuCovered.id, docType: 'RABBINATE', rabbinateCertId: cert.id, approvalStatus: 'APPROVED' } });

  const rows = [
    [skuCovered.code, skuCovered.name, 'R-COV-1', '01/01/2026', '01/06/2027', '10', 'B1', ''],
    [skuUncovered.code, skuUncovered.name, 'R-UNCOV-1', '01/01/2026', '01/06/2027', '10', 'B2', ''],
    [skuLocal.code, skuLocal.name, 'R-LOCAL-1', '01/01/2026', '01/06/2027', '10', 'B3', ''],
  ];
  const csvText = [csvRow(HEADER), ...rows.map(csvRow)].join('\r\n') + '\r\n';
  const fileBuf = Buffer.from(csvText, 'utf8');

  const setting = await prisma.syncState.findUnique({ where: { key: 'assistant_code' } });
  try {
    const login = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testEmail, password: testPassword }),
    });
    const loginBody = await login.json();
    if (login.status !== 200 || !loginBody.token) throw new Error('login failed: ' + JSON.stringify(loginBody));
    const AUTH_HEADER = { 'x-assistant-code': setting ? setting.value : '5678', Authorization: `Bearer ${loginBody.token}` };

    const fd = new FormData();
    fd.append('files', new Blob([fileBuf]), 'TEST-coverage.csv');
    const res = await fetch(BASE + '/api/goods-receipts/preview', { method: 'POST', headers: AUTH_HEADER, body: fd });
    const body = await res.json();
    if (res.status !== 200) throw new Error('preview failed: ' + JSON.stringify(body));

    console.log(JSON.stringify(body.bySku, null, 2));

    let pass = 0, fail = 0;
    function check(label, cond) { if (cond) { pass++; console.log('  OK  ' + label); } else { fail++; console.log('  FAIL ' + label); } }

    const sCov = body.bySku.find(s => s.skuCode === 'TEST-GRI-COVERED-1');
    check('covered IMPORT sku -> covered=true via RABBINATE/VALID_ON_RECEIPT_DATE',
      sCov && sCov.receipts[0].covered === true && sCov.receipts[0].coverageVia === 'RABBINATE' && sCov.receipts[0].coverageMatchedBy === 'VALID_ON_RECEIPT_DATE');

    const sUncov = body.bySku.find(s => s.skuCode === 'TEST-GRI-UNCOVERED-1');
    check('uncovered IMPORT sku (no link) -> covered=false', sUncov && sUncov.receipts[0].covered === false && sUncov.receipts[0].coverageApplicable === true);

    const sLocal = body.bySku.find(s => s.skuCode === 'TEST-GRI-LOCAL-1');
    check('LOCAL sku -> coverage not applicable (null)', sLocal && sLocal.receipts[0].coverageApplicable === false && sLocal.receipts[0].covered === null);

    check('uncoveredCount === 1 (only the uncovered IMPORT sku)', body.uncoveredCount === 1);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  } finally {
    await prisma.skuLink.delete({ where: { id: link.id } }).catch(() => {});
    await prisma.rabbinateCert.delete({ where: { id: cert.id } }).catch(() => {});
    await prisma.sku.delete({ where: { id: skuCovered.id } }).catch(() => {});
    await prisma.sku.delete({ where: { id: skuUncovered.id } }).catch(() => {});
    await prisma.sku.delete({ where: { id: skuLocal.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    await prisma.$disconnect();
  }
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
