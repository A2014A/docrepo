/* S1 follow-up: check all 155 kashrutBodyRef "replace" changes from the
 * master-SKU-list import for safety (does new kashrutBodyRef + new
 * pesachStatusRef together contain the same info as the decoded old value).
 * Read-only -- calls the /preview endpoint only, never /apply.
 * Creates a throwaway test-admin user to authenticate, deleted at the end. */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const prisma = new PrismaClient();

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

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

    let total = 0, safe = 0, unsafe = 0;
    const unsafeList = [];
    for (const row of body.changed) {
      for (const c of row.changes) {
        if (c.field !== 'kashrutBodyRef' || c.changeType !== 'replace') continue;
        total++;
        if (c.safety && c.safety.safe) safe++;
        else {
          unsafe++;
          unsafeList.push({ code: row.code, name: row.name, oldValue: c.oldValue, newKashrutBodyRef: c.newValue });
        }
      }
    }

    console.log(`Total kashrutBodyRef replacements: ${total}`);
    console.log(`  Safe: ${safe}`);
    console.log(`  NOT safe: ${unsafe}`);
    console.log('');
    if (unsafeList.length) {
      console.log('=== NOT-safe replacements ===');
      for (const u of unsafeList) {
        console.log(`SKU ${u.code} (${u.name})`);
        console.log(`  OLD: ${u.oldValue}`);
        console.log(`  NEW kashrutBodyRef: ${u.newKashrutBodyRef}`);
        console.log('');
      }
    }
  } finally {
    await prisma.user.delete({ where: { id: testUser.id } });
    await prisma.$disconnect();
  }
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
