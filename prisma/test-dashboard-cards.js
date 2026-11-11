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

    console.log('allCategories sample:', body.allCategories.slice(0, 5), `(${body.allCategories.length} total)`);
    for (const c of body.cards) {
      console.log(`${c.id}: count=${c.count} catFilterApplicable=${c.categoryFilterApplicable}${c.byConfidence ? ' byConfidence=' + JSON.stringify(c.byConfidence) : ''} (items shown: ${c.items.length}, truncated=${c.truncated})`);
      if (c.items.length) console.log('  sample:', JSON.stringify(c.items[0]));
    }

    // bucket breakdown check for card 1
    const card1 = body.cards.find(c => c.id === 'import-no-cert');
    const buckets = {};
    for (const it of card1.items) buckets[it.bucket] = (buckets[it.bucket] || 0) + 1;
    console.log('card1 bucket breakdown:', buckets);

    // category filter check: pick the first real category and confirm it narrows card1/card7
    const cat = body.allCategories[0];
    const resF = await fetch(BASE + '/api/dashboard/cards?categories=' + encodeURIComponent(cat), { headers: AUTH_HEADER });
    const bodyF = await resF.json();
    const card1F = bodyF.cards.find(c => c.id === 'import-no-cert');
    const card4F = bodyF.cards.find(c => c.id === 'pending-requests');
    console.log(`category filter "${cat}": card1 count ${card1.count} -> ${card1F.count} (should be <=), card4 (not applicable) count ${card4F.count} unchanged? ${card4F.count === body.cards.find(c=>c.id==='pending-requests').count}`);
    console.log('card1F all items match category?', card1F.items.every(it => it.categoryName === cat));

    // export check
    const resExport = await fetch(BASE + '/api/dashboard/cards/import-no-cert/export', { headers: AUTH_HEADER });
    console.log('export status:', resExport.status, 'content-type:', resExport.headers.get('content-type'), 'bytes:', (await resExport.arrayBuffer()).byteLength);
  } finally {
    await prisma.user.delete({ where: { id: testUser.id } });
    await prisma.$disconnect();
  }
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
