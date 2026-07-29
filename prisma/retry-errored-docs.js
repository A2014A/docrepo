/**
 * Retry pass for the 61 documents that errored (no valid AI response) during
 * classify-remaining-docs.js's first run. Diagnostic check on doc 611 showed
 * the AI endpoint works fine when called again -- the errors were transient
 * (likely rate-limiting / timeouts from sustained back-to-back calls), not
 * broken files. Same validate+PATCH logic as the original script.
 */
const BASE = 'https://docrepo-vdgc.onrender.com';
const VALID_TYPES = ['תעודות בדצים','תעודות רבנות','בקשות לרבנות','דוחות בדצים ואישורי תויות','תויות','מכתבים אחרים'];
const VISIBLE_TYPES = ['תעודות בדצים','תעודות רבנות'];

const ERROR_IDS = [897,738,731,725,713,686,683,664,656,651,611,608,603,602,601,598,597,596,595,592,591,590,587,583,581,580,576,574,572,571,568,567,564,563,560,559,557,556,555,554,552,549,547,546,545,544,541,539,538,535,534,531,529,528,526,524,522,520,519,518,516];

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '1234' }),
  });
  const data = await res.json();
  return data.token;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const token = await login();
  const headers = { Authorization: `Bearer ${token}` };

  let classified = 0, invalid = 0, stillErrors = 0;
  const stillFailedIds = [];
  const invalidList = [];

  for (let i = 0; i < ERROR_IDS.length; i++) {
    const id = ERROR_IDS[i];
    try {
      const idRes = await fetch(`${BASE}/api/identify-by-id/${id}`, { method: 'POST', headers });
      const idData = await idRes.json();
      if (!idRes.ok || !idData.doctype) { stillErrors++; stillFailedIds.push(id); await sleep(1000); continue; }

      const newType = VALID_TYPES.includes(idData.doctype) ? idData.doctype : null;
      if (!newType) { invalid++; invalidList.push({ id, suggested: idData.doctype }); console.log('  invalid doctype suggested for', id, ':', idData.doctype); continue; }

      const hidden = !VISIBLE_TYPES.includes(newType);
      const patchRes = await fetch(`${BASE}/api/docs/${id}`, {
        method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ doctype: newType, hidden }),
      });
      if (!patchRes.ok) { stillErrors++; stillFailedIds.push(id); continue; }
      classified++;
    } catch (e) {
      stillErrors++;
      stillFailedIds.push(id);
      console.log('  error on doc', id, ':', e.message);
    }
    await sleep(500);
    console.log(`  ${i + 1}/${ERROR_IDS.length} (classified: ${classified}, invalid: ${invalid}, stillErrors: ${stillErrors})`);
  }

  console.log('DONE. classified:', classified, 'invalid:', invalid, 'stillErrors:', stillErrors);
  console.log('stillFailedIds:', JSON.stringify(stillFailedIds));
  console.log('invalidList:', JSON.stringify(invalidList));
}

main().catch(e => { console.error(e); process.exit(1); });
