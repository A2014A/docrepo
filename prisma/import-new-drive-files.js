/**
 * Import files from the Drive "אישורי כשרות מהרבנות" tree that are NOT yet in
 * docrepo. Dedup is by document title (filename without extension) against
 * every document already in the live app -- bulk-import-drive.js's old
 * basename check compared against random R2 keys, so it can't be re-run safely.
 *
 * Usage: node prisma/import-new-drive-files.js [--apply]
 * Without --apply it only prints what WOULD be imported (dry run).
 */
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://docrepo-vdgc.onrender.com';
const ROOT = 'G:\\האחסון שלי\\אישורי כשרות מהרבנות';
const APPLY = process.argv.includes('--apply');

// root files: Rabbinate attachments saved automatically by the Apps Script
const SKIP_PATTERNS = [/^\/?image\d+\./i, /^Name$/,/police\.gov\.il/i, /ברכת שנה טובה/, /\.gsheet$/i];
const UPLOADABLE = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.jpg', '.jpeg', '.png', '.txt']);

function mimeFor(ext) {
  return {
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain',
  }[ext] || 'application/octet-stream';
}

async function login() {
  const r = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '1234' }),
  });
  return (await r.json()).token;
}

// folders to scan, with the default doctype/hidden for files that land there
const SOURCES = [
  { dir: 'תעודות ודוחות גופי כשרות/קבצים נכנסים לעיבוד (זמני)', recursive: false, doctype: 'בד״ץ (טרם מסווג)', hidden: true },
  { dir: '', recursive: false, doctype: 'בד״ץ (טרם מסווג)', hidden: true },
];

function listFiles(dir, recursive) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) { if (recursive) out.push(...listFiles(full, true)); continue; }
    out.push({ full, name, size: st.size });
  }
  return out;
}

async function main() {
  const token = await login();
  const headers = { Authorization: `Bearer ${token}` };
  const docs = await (await fetch(`${BASE_URL}/api/docs`, { headers })).json();
  const known = new Set(docs.map(d => (d.name || '').replace(/[\u200e\u200f\u2066-\u2069]/g, '').trim()));
  const knownSizes = new Set(docs.map(d => d.size_bytes).filter(Boolean)); // names differ by stray spaces/marks; exact byte size is a strong duplicate signal
  console.log('documents already in app:', docs.length);

  const todo = [];
  for (const src of SOURCES) {
    const dir = path.join(ROOT, src.dir);
    for (const f of listFiles(dir, src.recursive)) {
      const ext = path.extname(f.name).toLowerCase();
      const title = f.name.replace(/^\//, '').replace(/\.[^.]+$/, '');
      if (!UPLOADABLE.has(ext)) { console.log('  skip (type):', f.name); continue; }
      if (SKIP_PATTERNS.some(re => re.test(f.name))) { console.log('  skip (unrelated):', f.name); continue; }
      if (known.has(title)) continue;
      if (knownSizes.has(f.size)) { console.log('  skip (same size as existing doc):', f.name); continue; }
      if (f.size > 50 * 1024 * 1024) { console.log('  skip (>50MB):', f.name); continue; }
      todo.push({ ...f, ext, title, doctype: src.doctype, hidden: src.hidden });
    }
  }
  console.log(`\nnew files to import: ${todo.length}`);
  todo.forEach(f => console.log('  +', f.title + f.ext, `(${Math.round(f.size / 1024)}KB)`));
  if (!APPLY) { console.log('\n(dry run -- pass --apply to upload)'); return; }

  let ok = 0, fail = 0;
  const createdIds = [];
  for (const f of todo) {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([fs.readFileSync(f.full)], { type: mimeFor(f.ext) }), f.name.replace(/^\//, ''));
      fd.append('name', f.title);
      fd.append('doctype', f.doctype);
      fd.append('hidden', String(f.hidden));
      fd.append('tags', JSON.stringify(['ייבוא-דרייב']));
      const r = await fetch(`${BASE_URL}/api/docs`, { method: 'POST', headers, body: fd });
      if (!r.ok) throw new Error(await r.text());
      createdIds.push((await r.json()).id);
      ok++;
    } catch (e) { fail++; console.log('  FAILED', f.name, e.message); }
  }
  console.log(`\nDONE. uploaded: ${ok}, failed: ${fail}`);
  fs.writeFileSync(path.join(__dirname, '_last-import-ids.json'), JSON.stringify(createdIds));
}

main().catch(e => { console.error(e); process.exit(1); });
