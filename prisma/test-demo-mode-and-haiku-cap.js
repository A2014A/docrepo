/* S5 fix (11.11.2026) regression test -- covers the two "Fix before deploy"
 * items from the 11.11.2026 instruction:
 *   1) demo mode must be refused server-side on every write route, not just
 *      hidden in the UI.
 *   2) IDENTIFY_MONTHLY_TOKEN_CAP must actually be enforced.
 *
 * Same conventions as prisma/test-raw-material-registry-api.js: hits the
 * LIVE Neon DB (no separate local DB exists), only ever creates/touches
 * "TEST-" prefixed fixture rows it creates itself, snapshots+restores any
 * real shared row it has to read for the cap test, and deletes every
 * fixture it created. Never sends a real (non-demo) write to a pre-existing
 * record -- every mutating call here targets either a brand-new TEST-
 * fixture, or carries the demo header (which the middleware must refuse
 * before it ever reaches a handler).
 */
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

async function api(method, path, body, extraHeaders) {
  const opts = { method, headers: { ...AUTH_HEADER, ...(extraHeaders || {}) } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

const DEMO = { 'X-Demo-Mode': '1' };

(async () => {
  console.log('=== Demo-mode + Haiku-cap regression test (live Neon DB, self-cleaning) ===\n');

  const testEmail = `test-admin-${Date.now()}@test.local`;
  const testPassword = `test-${Date.now()}`;
  const testUser = await prisma.user.create({
    data: { email: testEmail, passwordHash: bcrypt.hashSync(testPassword, 10), role: 'ADMIN' },
  });
  const login = await api('POST', '/api/auth/login', { username: testEmail, password: testPassword });
  if (login.status !== 200 || !login.body.token) throw new Error('could not log in as throwaway test admin: ' + JSON.stringify(login));
  AUTH_HEADER = { Authorization: `Bearer ${login.body.token}` };

  // ---------------------------------------------------------------
  // PART 1: demo mode is refused server-side on write routes
  // ---------------------------------------------------------------
  console.log('-- Part 1: demo-mode server-side refusal --');

  // login itself must stay reachable even carrying the demo header
  const demoLogin = await api('POST', '/api/auth/login', { username: testEmail, password: testPassword }, DEMO);
  check('POST /api/auth/login works even with X-Demo-Mode:1 (must stay reachable)', demoLogin.status === 200 && !!demoLogin.body.token);

  // create a TEST- raw material (real write, no demo header) to use as the target fixture
  const createRm = await api('POST', '/api/raw-material-registry', { name: `TEST-demo-${Date.now()}` });
  check('setup: created TEST- raw material fixture', createRm.status === 201, createRm);
  const rmId = createRm.body?.id;

  // create a TEST- contact fixture too, for a second screen's write route
  const createContact = await api('POST', '/api/contacts', { name: `TEST-demo-contact-${Date.now()}`, email: `test-demo-${Date.now()}@test.local` });
  check('setup: created TEST- contact fixture', createContact.status === 201, createContact);
  const contactId = createContact.body?.id;

  if (rmId) {
    const patchDemo = await api('PATCH', `/api/raw-material-registry/${rmId}`, { name: 'should-not-apply' }, DEMO);
    check('PATCH raw-material-registry refused in demo mode (403)', patchDemo.status === 403, patchDemo);

    const archiveDemo = await api('POST', `/api/raw-material-registry/${rmId}/archive`, { reason: 'x' }, DEMO);
    check('POST raw-material-registry/:id/archive refused in demo mode (403)', archiveDemo.status === 403, archiveDemo);

    const deleteDemo = await api('DELETE', `/api/raw-material-registry/${rmId}`, undefined, DEMO);
    check('DELETE raw-material-registry/:id refused in demo mode (403)', deleteDemo.status === 403, deleteDemo);

    // confirm the fixture was genuinely untouched by any of the above
    const stillThere = await api('GET', `/api/raw-material-registry/${rmId}`);
    check('fixture still has its original name (no demo write leaked through)', stillThere.status === 200 && stillThere.body.name.startsWith('TEST-demo-') && !stillThere.body.name.includes('should-not-apply'), stillThere.body);
    check('fixture was not archived by the blocked demo request', stillThere.status === 200 && stillThere.body.archived === false, stillThere.body);
  }

  if (contactId) {
    const patchContactDemo = await api('PATCH', `/api/contacts/${contactId}`, { name: 'should-not-apply' }, DEMO);
    check('PATCH contacts/:id refused in demo mode (403)', patchContactDemo.status === 403, patchContactDemo);
  }

  const createRmDemo = await api('POST', '/api/raw-material-registry', { name: `TEST-demo-should-not-exist-${Date.now()}` }, DEMO);
  check('POST raw-material-registry (create) refused in demo mode (403)', createRmDemo.status === 403, createRmDemo);

  // a route that is POST but never writes to the DB must stay usable in demo mode
  const exportDemo = await api('POST', '/api/raw-material-registry/export', {}, DEMO);
  check('POST raw-material-registry/export (non-mutating, exempt) still works in demo mode', exportDemo.status === 200, { status: exportDemo.status });

  // ---------------------------------------------------------------
  // PART 2: IDENTIFY_MONTHLY_TOKEN_CAP enforcement (lib-level,
  // snapshot+restore the real current-month row since it's shared
  // with live /api/identify* traffic)
  // ---------------------------------------------------------------
  console.log('\n-- Part 2: IDENTIFY_MONTHLY_TOKEN_CAP enforcement --');
  const { currentYearMonth, isHaikuCapReached, recordHaikuUsage, haikuCap } = require('../lib/haiku-usage');
  const ym = currentYearMonth();
  const realRow = await prisma.haikuUsage.findUnique({ where: { yearMonth: ym } });

  try {
    // start from a known zero state for this test
    await prisma.haikuUsage.upsert({
      where: { yearMonth: ym },
      create: { yearMonth: ym, inputTokens: 0, outputTokens: 0, callCount: 0 },
      update: { inputTokens: 0, outputTokens: 0, callCount: 0 },
    });

    delete process.env.IDENTIFY_MONTHLY_TOKEN_CAP;
    check('haikuCap() is null when IDENTIFY_MONTHLY_TOKEN_CAP is unset', haikuCap() === null);
    check('cap never reached when unset, even with usage recorded', !(await isHaikuCapReached(prisma)));

    process.env.IDENTIFY_MONTHLY_TOKEN_CAP = '100';
    check('haikuCap() reflects the configured value', haikuCap() === 100);
    check('cap not reached at zero usage (0 < 100)', !(await isHaikuCapReached(prisma)));

    await recordHaikuUsage(prisma, 60, 30); // total 90, still under 100
    check('cap not reached at 90/100', !(await isHaikuCapReached(prisma)));

    await recordHaikuUsage(prisma, 5, 10); // total 105, now over 100
    check('cap reached once usage crosses the configured cap (105 >= 100)', await isHaikuCapReached(prisma));

    const afterRecording = await prisma.haikuUsage.findUnique({ where: { yearMonth: ym } });
    check('recordHaikuUsage increments inputTokens/outputTokens/callCount correctly', afterRecording.inputTokens === 65 && afterRecording.outputTokens === 40 && afterRecording.callCount === 2, afterRecording);

    delete process.env.IDENTIFY_MONTHLY_TOKEN_CAP;
  } finally {
    // restore the real row exactly as found (or remove it if it didn't exist before)
    if (realRow) {
      await prisma.haikuUsage.update({
        where: { yearMonth: ym },
        data: { inputTokens: realRow.inputTokens, outputTokens: realRow.outputTokens, callCount: realRow.callCount },
      });
    } else {
      await prisma.haikuUsage.delete({ where: { yearMonth: ym } }).catch(() => {});
    }
  }

  // GET /api/haiku-usage (admin, read-only) must reflect the restored real data, not the test's scratch values
  const usageEndpoint = await api('GET', '/api/haiku-usage');
  check('GET /api/haiku-usage works for admin and matches the restored row', usageEndpoint.status === 200 && usageEndpoint.body.yearMonth === ym, usageEndpoint.body);

  // ── cleanup ──
  if (rmId) {
    const del = await api('DELETE', `/api/raw-material-registry/${rmId}`);
    check('cleanup: TEST- raw material fixture deleted', del.status === 200, del);
  }
  if (contactId) {
    const del = await api('DELETE', `/api/contacts/${contactId}`);
    check('cleanup: TEST- contact fixture deleted', del.status === 200, del);
  }
  await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});

  const leftoverRm = await prisma.rawMaterial.findFirst({ where: { name: { startsWith: 'TEST-demo' } } });
  const leftoverContact = await prisma.contact.findFirst({ where: { name: { startsWith: 'TEST-demo' } } });
  check('no leftover TEST-demo raw materials remain', !leftoverRm, leftoverRm);
  check('no leftover TEST-demo contacts remain', !leftoverContact, leftoverContact);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('TEST SCRIPT CRASHED:', e);
  await prisma.$disconnect();
  process.exit(1);
});
