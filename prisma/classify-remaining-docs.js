/**
 * Batch-classify the ~440 documents left as "בד״ץ (טרם מסווג)" / "אחר" after
 * the manual reclassification pass, using the already-deployed
 * /api/identify-by-id/:id endpoint (same AI call the "🤖 זהה אוטומטית"
 * button in the UI uses -- reused rather than re-implemented). For each:
 * ask AI for a doctype, validate it's one of the 6 real categories, PATCH
 * the document's docType and set hidden per VISIBLE_DOCTYPES.
 *
 * Real ANTHROPIC_API_KEY cost -- ~440 calls. Run once, confirmed by user.
 */
const BASE = 'https://docrepo-vdgc.onrender.com';
const VALID_TYPES = ['תעודות בדצים','תעודות רבנות','בקשות לרבנות','דוחות בדצים ואישורי תויות','תויות','מכתבים אחרים'];
const VISIBLE_TYPES = ['תעודות בדצים','תעודות רבנות'];
const PENDING_TYPES = ['בד״ץ (טרם מסווג)', 'אחר'];

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '1234' }),
  });
  const data = await res.json();
  return data.token;
}

async function main() {
  const token = await login();
  const headers = { Authorization: `Bearer ${token}` };

  const allDocs = await (await fetch(`${BASE}/api/docs`, { headers })).json();
  const pending = allDocs.filter(d => PENDING_TYPES.includes(d.doctype));
  console.log('documents to classify:', pending.length);

  let classified = 0, unchanged = 0, invalid = 0, errors = 0;
  for (let i = 0; i < pending.length; i++) {
    const doc = pending[i];
    try {
      const idRes = await fetch(`${BASE}/api/identify-by-id/${doc.id}`, { method: 'POST', headers });
      const idData = await idRes.json();
      if (!idRes.ok || !idData.doctype) { errors++; continue; }

      const newType = VALID_TYPES.includes(idData.doctype) ? idData.doctype : null;
      if (!newType) { invalid++; console.log('  invalid doctype suggested for', doc.id, ':', idData.doctype); continue; }

      const hidden = !VISIBLE_TYPES.includes(newType);
      const patchRes = await fetch(`${BASE}/api/docs/${doc.id}`, {
        method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ doctype: newType, hidden }),
      });
      if (!patchRes.ok) { errors++; continue; }
      classified++;
    } catch (e) {
      errors++;
      console.log('  error on doc', doc.id, ':', e.message);
    }
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${pending.length} (classified: ${classified}, invalid: ${invalid}, errors: ${errors})`);
  }

  console.log('DONE. classified:', classified, 'invalid suggestion:', invalid, 'errors:', errors);
}

main().catch(e => { console.error(e); process.exit(1); });
