/* S1 follow-up: read-only report of (a) the 60 skipped (unsafe) kashrut
 * replacements and (b) the 115 new SKUs not yet created. Calls /preview only
 * -- never writes anything. Also saves both as sheets in one xlsx file.
 * Creates a throwaway test-admin user to authenticate, deleted at the end. */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const prisma = new PrismaClient();

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

function fmt(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v === true) return 'כן';
  if (v === false) return 'לא';
  return String(v);
}

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

    const csvPath = path.join(__dirname, '..', 'imports', 'master-skus.csv');
    const fileBuf = fs.readFileSync(csvPath);
    const fd = new FormData();
    fd.append('file', new Blob([fileBuf]), 'master-skus.csv');

    const res = await fetch(BASE + '/api/sku-master-import/preview', { method: 'POST', headers: AUTH_HEADER, body: fd });
    const body = await res.json();
    if (res.status !== 200) throw new Error('preview failed: ' + JSON.stringify(body));

    // (a) the 60 unsafe kashrut replacements
    const unsafeRows = [];
    for (const row of body.changed) {
      for (const c of row.changes) {
        if (c.field !== 'kashrutBodyRef' || c.changeType !== 'replace') continue;
        if (c.safety && c.safety.safe) continue;
        const pesach = row.changes.find(x => x.field === 'pesachStatusRef');
        let why;
        if (!c.safety.oldBase && !c.safety.oldInner) why = 'לא ניתן לנתח את הטקסט הישן';
        else {
          const baseOk = c.safety.oldBase ? undefined : true;
          why = [];
          if (c.safety.oldInner && !(pesach && pesach.newValue)) why.push('הערת הפסח הישנה אין לה מקביל בעמודת "כשרות פסח" החדשה (אובדן מידע)');
          if (!why.length) why.push('הגוף המוסמך עצמו השתנה (לא ניסוח חדש לאותו מידע)');
          why = why.join('; ');
        }
        unsafeRows.push({
          'מק"ט': row.code,
          'תיאור': row.name,
          'ישן (קודד)': c.oldValue,
          'חדש (כשרות ימות השנה)': c.newValue,
          'חדש (כשרות פסח)': pesach ? fmt(pesach.newValue) : '',
          'מדוע לא בטוח': why,
        });
      }
    }

    // (b) the 115 new SKUs
    const newRows = body.newSkus.map(s => ({
      'מק"ט': s.code,
      'תיאור': s.name,
      'קטגוריה': fmt(s.categoryName),
      'ספק': fmt(s.supplier),
      'כשרות': fmt(s.kashrutBodyRef),
      'סוג פריט': s.itemType,
    }));

    console.log(`=== (a) ${unsafeRows.length} unsafe kashrut replacements (skipped) ===`);
    for (const r of unsafeRows) {
      console.log(`${r['מק"ט']} | ${r['תיאור']} | old: ${r['ישן (קודד)']} | new body: ${r['חדש (כשרות ימות השנה)']} | new pesach: ${r['חדש (כשרות פסח)']} | ${r['מדוע לא בטוח']}`);
    }
    console.log(`\n=== (b) ${newRows.length} new SKUs (not created) ===`);
    for (const r of newRows) {
      console.log(`${r['מק"ט']} | ${r['תיאור']} | ${r['קטגוריה']} | ${r['ספק']} | ${r['כשרות']} | ${r['סוג פריט']}`);
    }

    const wb = XLSX.utils.book_new();
    const wsUnsafe = XLSX.utils.json_to_sheet(unsafeRows);
    const wsNew = XLSX.utils.json_to_sheet(newRows);
    XLSX.utils.book_append_sheet(wb, wsUnsafe, 'קשרות לא בטוחות');
    XLSX.utils.book_append_sheet(wb, wsNew, 'מקטים חדשים');
    const outDir = path.join(__dirname, '..', 'exports');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'sku-master-import-review.xlsx');
    XLSX.writeFile(wb, outPath);
    console.log('\nSaved:', outPath);
  } finally {
    await prisma.user.delete({ where: { id: testUser.id } });
    await prisma.$disconnect();
  }
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
