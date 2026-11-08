/* S1: apply the master-SKU-list import's fill-empty changes + safe kashrut
 * replacements only. Does NOT create the 115 new SKUs (explicitly excluded).
 * DB backup must be taken before running this (see backups/ directory).
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
    fd.append('applyFillEmpty', '1');
    fd.append('applySafeKashrutReplacements', '1');
    fd.append('createNewSkus', '0');

    const res = await fetch(BASE + '/api/sku-master-import/apply', { method: 'POST', headers: AUTH_HEADER, body: fd });
    const body = await res.json();
    if (res.status !== 200) throw new Error('apply failed: ' + JSON.stringify(body));

    console.log('=== Write applied ===');
    console.log('SKUs updated:', body.counts.skusUpdated);
    console.log('New SKUs created:', body.counts.newSkusCreated, '(must be 0)');
    console.log('Fill-empty field writes:', body.counts.fillApplied);
    console.log('Safe kashrut replacements applied:', body.counts.safeReplaceApplied);
    console.log('Unsafe kashrut replacements skipped:', body.counts.unsafeReplaceSkipped);
    console.log('By field:', JSON.stringify(body.counts.byField, null, 2));
  } finally {
    await prisma.user.delete({ where: { id: testUser.id } });
    await prisma.$disconnect();
  }
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
