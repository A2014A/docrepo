/* xlsx -> exceljs migration (11.11.2026) regression test for the two
 * spreadsheet-upload endpoints that used to use the `xlsx` package:
 * POST /api/skus/import and POST /api/skus/import-report.
 * Same conventions as prisma/test-raw-material-registry-api.js: hits the
 * LIVE Neon DB (no separate local DB exists), only ever creates "TEST-"
 * prefixed fixture rows, deletes everything it created, and snapshots
 * row counts before/after.
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const prisma = new PrismaClient();

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log(`  OK  ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? ' -- ' + JSON.stringify(extra) : ''}`); }
}

async function xlsxBuffer(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  rows.forEach(r => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

(async () => {
  console.log('=== xlsx -> exceljs migration regression test (live Neon DB, self-cleaning) ===\n');

  const adminEmail = `test-admin-${Date.now()}@test.local`;
  const adminPassword = `test-${Date.now()}`;
  const adminUser = await prisma.user.create({
    data: { email: adminEmail, passwordHash: bcrypt.hashSync(adminPassword, 10), role: 'ADMIN' },
  });
  const procEmail = `test-proc-${Date.now()}@test.local`;
  const procPassword = `test-${Date.now()}`;
  const procUser = await prisma.user.create({
    data: { email: procEmail, passwordHash: bcrypt.hashSync(procPassword, 10), role: 'PROCUREMENT' },
  });

  const adminLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: adminEmail, password: adminPassword }),
  }).then(r => r.json());
  const procLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: procEmail, password: procPassword }),
  }).then(r => r.json());
  const ADMIN_AUTH = { Authorization: `Bearer ${adminLogin.token}` };
  const PROC_AUTH = { Authorization: `Bearer ${procLogin.token}` };

  const code1 = `TEST-xl-${Date.now()}`;
  const code2 = `TEST-xl-${Date.now() + 1}`;

  // ---------------------------------------------------------------
  // POST /api/skus/import (positional columns, now admin-only + exceljs)
  // ---------------------------------------------------------------
  console.log('-- /api/skus/import --');

  const importBuf = await xlsxBuffer([
    ['מקט', 'תאור מוצר', 'טיפוס', 'מקור', 'איש רכש', 'ספק 2', 'ספק 1', 'כשרות', 'פסח', 'הערות', 'סוג תעודה'],
    [code1, 'TEST-xl product one', 'P', 'מקור א', 'דני', 'ספק ב', 'ספק א', 'הרב לנדא', '', 'הערת בדיקה', ''],
  ]);

  const fd1 = new FormData();
  fd1.append('file', new Blob([importBuf]), 'test-import.xlsx');
  const r1 = await fetch(`${BASE}/api/skus/import`, { method: 'POST', headers: ADMIN_AUTH, body: fd1 });
  const b1 = await r1.json();
  check('admin xlsx import succeeds (200)', r1.status === 200, b1);
  check('first import adds exactly 1 SKU', b1.added === 1 && b1.updated === 0, b1);

  const created = await prisma.sku.findUnique({ where: { code: code1 } });
  check('SKU row was actually created with the right fields', !!created && created.name === 'TEST-xl product one' && created.tipus === 'יצור' && created.supplier === 'ספק א', created);

  const fd1b = new FormData();
  fd1b.append('file', new Blob([importBuf]), 'test-import.xlsx');
  const r1b = await fetch(`${BASE}/api/skus/import`, { method: 'POST', headers: ADMIN_AUTH, body: fd1b });
  const b1b = await r1b.json();
  check('re-importing the same file updates instead of re-adding', r1b.status === 200 && b1b.added === 0 && b1b.updated === 1, b1b);

  // non-admin (requireAdmin now gates this route) must be refused
  const fdProc = new FormData();
  fdProc.append('file', new Blob([importBuf]), 'test-import.xlsx');
  const rProc = await fetch(`${BASE}/api/skus/import`, { method: 'POST', headers: PROC_AUTH, body: fdProc });
  check('non-admin (PROCUREMENT) is refused with 403', rProc.status === 403, { status: rProc.status });

  // .xls must be rejected with the Hebrew message, before any parse attempt
  const fdXls = new FormData();
  fdXls.append('file', new Blob([Buffer.from('does not matter, never parsed')]), 'old-file.xls');
  const rXls = await fetch(`${BASE}/api/skus/import`, { method: 'POST', headers: ADMIN_AUTH, body: fdXls });
  const bXls = await rXls.json();
  check('.xls is rejected with 400', rXls.status === 400, bXls);
  check('.xls rejection uses the exact Hebrew message', bXls.error === 'קובצי XLS הישנים אינם נתמכים יותר. פתחו את הקובץ באקסל ושמרו כ-XLSX (קובץ ← שמור בשם ← Excel Workbook‎ .xlsx), ואז העלו אותו.', bXls);

  // ---------------------------------------------------------------
  // POST /api/skus/import-report (header-name columns, exceljs, no UI caller)
  // ---------------------------------------------------------------
  console.log('\n-- /api/skus/import-report --');

  const reportBuf = await xlsxBuffer([
    ['מק"ט', 'תאור מוצר', 'שם ספק'],
    [code2, 'TEST-xl product two', 'ספק דוח'],
  ]);

  const fdDry = new FormData();
  fdDry.append('file', new Blob([reportBuf]), 'test-report.xlsx');
  const rDry = await fetch(`${BASE}/api/skus/import-report?dryRun=1`, { method: 'POST', headers: ADMIN_AUTH, body: fdDry });
  const bDry = await rDry.json();
  check('dry-run report parses the row without writing', rDry.status === 200 && bDry.dryRun === true && bDry.added === 1, bDry);
  const notYetCreated = await prisma.sku.findUnique({ where: { code: code2 } });
  check('dry-run really made no DB write', !notYetCreated);

  const fdReal = new FormData();
  fdReal.append('file', new Blob([reportBuf]), 'test-report.xlsx');
  const rReal = await fetch(`${BASE}/api/skus/import-report`, { method: 'POST', headers: ADMIN_AUTH, body: fdReal });
  const bReal = await rReal.json();
  check('real run reports added=1', rReal.status === 200 && bReal.added === 1, bReal);
  const reportCreated = await prisma.sku.findUnique({ where: { code: code2 } });
  check('SKU from the report was created with header-matched columns', !!reportCreated && reportCreated.name === 'TEST-xl product two' && reportCreated.supplier === 'ספק דוח', reportCreated);

  const fdXls2 = new FormData();
  fdXls2.append('file', new Blob([Buffer.from('does not matter, never parsed')]), 'old-report.xls');
  const rXls2 = await fetch(`${BASE}/api/skus/import-report`, { method: 'POST', headers: ADMIN_AUTH, body: fdXls2 });
  const bXls2 = await rXls2.json();
  check('.xls is rejected on import-report too (400, same message)', rXls2.status === 400 && bXls2.error === bXls.error, bXls2);

  // ── cleanup ──
  await prisma.sku.deleteMany({ where: { code: { in: [code1, code2] } } });
  await prisma.user.delete({ where: { id: adminUser.id } }).catch(() => {});
  await prisma.user.delete({ where: { id: procUser.id } }).catch(() => {});

  const leftover = await prisma.sku.findFirst({ where: { code: { startsWith: 'TEST-xl-' } } });
  check('no leftover TEST-xl SKUs remain', !leftover, leftover);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('TEST SCRIPT CRASHED:', e);
  await prisma.$disconnect();
  process.exit(1);
});
