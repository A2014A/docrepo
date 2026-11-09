/* S3 smoke test: calls /api/dashboard/cards with a throwaway test-admin
 * user and prints the result. Read-only. Deletes the user at the end. */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
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

    const res = await fetch(BASE + '/api/dashboard/cards', { headers: AUTH_HEADER });
    const body = await res.json();
    if (res.status !== 200) throw new Error('dashboard failed: ' + JSON.stringify(body));

    for (const c of body.cards) {
      console.log(`${c.id}: count=${c.count}${c.byConfidence ? ' byConfidence=' + JSON.stringify(c.byConfidence) : ''} (items shown: ${c.items.length})`);
      if (c.items.length) console.log('  sample:', JSON.stringify(c.items[0]));
    }
  } finally {
    await prisma.user.delete({ where: { id: testUser.id } });
    await prisma.$disconnect();
  }
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
