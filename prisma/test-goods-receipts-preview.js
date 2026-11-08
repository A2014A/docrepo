/* S2 smoke test: builds a synthetic WMS-style CSV (UTF-16LE with BOM,
 * ="..." wrapper, RFC4180 quoting) mixing real SKUs (to test per-SKU and
 * per-category shelf-life defaults, and the "unrealistic shelf life" flag)
 * with a fake TEST- SKU code (to test new-SKU detection). Calls /preview
 * only -- never writes anything. Creates a throwaway test-admin user,
 * deleted at the end. */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

function csvField(v) {
  v = String(v);
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
function csvRow(fields) { return fields.map(csvField).join(','); }

const HEADER = ['קוד מאחסן', 'פריט', 'תיאור פריט', 'קליטה', 'תאריך קליטה', 'פג תוקף', 'כמות', 'אצווה', 'תאריך יצור', 'קבוצת פריט'];

const rows = [
  // 13459: per-SKU override 24mo. Two location rows, same receipt+expiry -> quantity must sum to 80.
  ['A1', '="13459"', 'זית טבעות ירוק יווני וואקום 5 ק"ג מסונן - כהן', '="R-TEST-1001"', '01/01/2026', '01/06/2027', '50', 'B100', '', 'שימורים'],
  ['A2', '="13459"', 'זית טבעות ירוק יווני וואקום 5 ק"ג מסונן - כהן', '="R-TEST-1001"', '01/01/2026', '01/06/2027', '30', 'B100', '', 'שימורים'],
  // 13461: per-SKU override 24mo, but expiry is 36mo after receipt (> assumed 24mo) -> must flag חיי מדף שגויים.
  ['B1', '="13461"', 'זית פתיתים ירוק וואקום יווני 5 ק"ג', '="R-TEST-3001"', '01/01/2026', '01/01/2029', '12', 'B200', '', 'שימורים'],
  // 13004: category-default 36mo (no per-SKU override), explicit production date given -> no estimate should be computed.
  ['C1', '="13004"', 'אננס חתוך A/10 תאילנדי - ע.חרדית', '="R-TEST-4001"', '01/06/2026', '01/01/2028', '20', 'B300', '01/01/2024', 'שימורים'],
  // Fake new SKU, not in DB -> must appear in newSkus / isNew.
  ['D1', '="TEST-GRI-9001"', 'TEST פריט בדיקה לא קיים', '="R-TEST-5001"', '05/01/2026', '05/01/2027', '10', 'B400', '', 'בדיקה'],
];

const csvText = [csvRow(HEADER), ...rows.map(csvRow)].join('\r\n') + '\r\n';
// Encode as UTF-16LE with BOM to exercise the WMS-typical encoding path.
const body = Buffer.from(csvText, 'utf16le');
const bom = Buffer.from([0xFF, 0xFE]);
const fileBuf = Buffer.concat([bom, body]);

(async () => {
  const testEmail = `test-admin-${Date.now()}@test.local`;
  const testPassword = `test-${Date.now()}`;
  const testUser = await prisma.user.create({
    data: { email: testEmail, passwordHash: bcrypt.hashSync(testPassword, 10), role: 'ADMIN' },
  });
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
    fd.append('files', new Blob([fileBuf]), 'TEST-goods-receipt.csv');

    const res = await fetch(BASE + '/api/goods-receipts/preview', { method: 'POST', headers: AUTH_HEADER, body: fd });
    const body2 = await res.json();
    if (res.status !== 200) throw new Error('preview failed: ' + JSON.stringify(body2));

    console.log('=== Preview response ===');
    console.log(JSON.stringify(body2, null, 2));

    let pass = 0, fail = 0;
    function check(label, cond) { if (cond) { pass++; console.log('  OK  ' + label); } else { fail++; console.log('  FAIL ' + label); } }

    const sku13459 = body2.bySku.find(s => s.skuCode === '13459');
    check('UTF-16LE + ="..." decode worked (13459 found)', !!sku13459);
    check('13459 quantity summed across 2 location rows (50+30=80)', sku13459 && sku13459.receipts[0].quantity === 80);
    check('13459 not flagged as new', sku13459 && sku13459.isNew === false);

    const sku13461 = body2.bySku.find(s => s.skuCode === '13461');
    check('13461 found and per-SKU override (24mo) used', sku13461 && sku13461.receipts[0].shelfLifeMonthsUsed === 24);
    check('13461 flagged חיי מדף שגויים (expiry 36mo > assumed 24mo)', sku13461 && sku13461.receipts[0].flag === 'חיי מדף שגויים');

    const sku13004 = body2.bySku.find(s => s.skuCode === '13004');
    check('13004 found, explicit production date present -> no estimate computed', sku13004 && sku13004.receipts[0].estimatedProductionDate === null && sku13004.receipts[0].productionDate === '01/01/2024');

    const newSku = body2.newSkus.find(s => s.code === 'TEST-GRI-9001');
    check('fake TEST-GRI-9001 detected as a new SKU', !!newSku);
    check('newSkuCount === 1', body2.newSkuCount === 1);
    check('receiptGroups === 4 (5 rows, 2 merged into 1 group)', body2.receiptGroups === 4);

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  } finally {
    await prisma.user.delete({ where: { id: testUser.id } });
    await prisma.$disconnect();
  }
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
