SHA: 2dd83ef8b1b0acb07eadf5334122f75fc7c8941b
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const low      = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'docrepo_secret_change_in_prod';
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DATA_DIR    = path.join(__dirname, 'data');

[UPLOADS_DIR, DATA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const db = low(new FileSync(path.join(DATA_DIR, 'db.json')));
db.defaults({ users: [], documents: [], skus: [], nextDocId: 1, nextUserId: 1, view_code: '1234', assistant_code: '5678', viewer_code: '0000' }).write();

if (!db.get('users').find({ username: 'admin' }).value()) {
  const id = db.get('nextUserId').value();
  db.get('users').push({ id, username: 'admin', password: bcrypt.hashSync('1234', 10), role: 'admin' }).write();
  db.set('nextUserId', id + 1).write();
  console.log('Default admin created: admin / 1234');
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.jpg','.jpeg','.png','.gif','.txt'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'לא מחובר' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'פג תוקף ההתחברות' }); }
}

function getReqRole(req) {
  try {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (t) {
      const decoded = jwt.verify(t, JWT_SECRET);
      return decoded.role || 'admin';
    }
  } catch {}
  return null;
}
function isAdminReq(req)     { return getReqRole(req) === 'admin'; }
function isAssistantReq(req) { const r = getReqRole(req); return r === 'admin' || r === 'assistant'; }

/* middleware: רק מנהל */
function requireAdmin(req, res, next) {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'נדרשת הרשאת מנהל' });
  next();
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  return bytes > 1048576 ? (bytes/1048576).toFixed(1)+' MB' : Math.round(bytes/1024)+' KB';
}
function docOut(d) {
  return { ...d, size_label: fmtSize(d.size_bytes) };
}


/* ── TEMP RESET (להסרה אחרי שימוש) ── */
app.get('/api/reset-admin-password', (req, res) => {
  const bcrypt = require('bcryptjs');
  const user = db.get('users').find({ username: 'admin' }).value();
  if (user) {
    db.get('users').find({ username: 'admin' }).assign({ password: bcrypt.hashSync('1234', 10) }).write();
    res.json({ ok: true, message: 'סיסמת מנהל אופסה ל-1234' });
  } else {
    res.json({ ok: false, message: 'משתמש admin לא נמצא' });
  }
});

/* ── AUTH ── */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'חסרים פרטים' });
  const user = db.get('users').find({ username }).value();
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, username: user.username, role: user.role });
});

app.patch('/api/auth/password', requireAuth, requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!bcrypt.compareSync(currentPassword, user.password))
    return res.status(400).json({ error: 'סיסמה נוכחית שגויה' });
  db.get('users').find({ id: req.user.id }).assign({ password: bcrypt.hashSync(newPassword, 10) }).write();
  res.json({ ok: true });
});

/* ── SKUS ── */
app.get('/api/skus', (req, res) => {
  const { q, all } = req.query;
  let skus = db.get('skus').value();
  if (q) {
    const lq = q.toLowerCase();
    skus = skus.filter(s =>
      s.id.includes(q) ||
      s.name.toLowerCase().includes(lq) ||
      (s.supplier||'').toLowerCase().includes(lq)
    );
  }
  res.json(all ? skus : skus.slice(0, 50));
});

app.post('/api/skus', requireAuth, (req, res) => {
  const { id, name, supplier, tipus, source, responsible, kashrus, pesach, notes } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'חסרים מספר ושם' });
  if (db.get('skus').find({ id: String(id) }).value())
    return res.status(400).json({ error: 'מקט כבר קיים' });
  const sku = { id: String(id), name, supplier: supplier||'', tipus: tipus||'', source: source||'', responsible: responsible||'', kashrus: kashrus||'', pesach: pesach||'', notes: notes||'' };
  db.get('skus').push(sku).write();
  res.status(201).json(sku);
});

app.patch('/api/skus/:id', requireAuth, (req, res) => {
  const sku = db.get('skus').find({ id: req.params.id }).value();
  if (!sku) return res.status(404).json({ error: 'מקט לא נמצא' });
  const { name, supplier, tipus, source, responsible, kashrus, pesach, notes } = req.body;
  const updates = {};
  if (name        !== undefined) updates.name        = name;
  if (supplier    !== undefined) updates.supplier    = supplier;
  if (tipus       !== undefined) updates.tipus       = tipus;
  if (source      !== undefined) updates.source      = source;
  if (responsible !== undefined) updates.responsible = responsible;
  if (kashrus     !== undefined) updates.kashrus     = kashrus;
  if (pesach      !== undefined) updates.pesach      = pesach;
  if (notes       !== undefined) updates.notes       = notes;
  db.get('skus').find({ id: req.params.id }).assign(updates).write();
  res.json(db.get('skus').find({ id: req.params.id }).value());
});

app.delete('/api/skus/:id', requireAuth, requireAdmin, (req, res) => {
  if (!db.get('skus').find({ id: req.params.id }).value())
    return res.status(404).json({ error: 'מקט לא נמצא' });
  db.get('skus').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

app.post('/api/skus/import', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    let added = 0, updated = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const id       = row[0] ? String(row[0]).trim() : '';
      const name     = row[1] ? String(row[1]).trim() : '';
      const supplier = row[3] ? String(row[3]).trim() : '';
      const tipusRaw = row[4] ? String(row[4]).trim() : '';
      const tipus    = tipusRaw === 'P' ? 'יצור' : tipusRaw === 'R' ? 'רכש' : tipusRaw;
      const sourceRaw = row[5] ? String(row[5]).trim() : '';
      const source   = sourceRaw;
      const responsible = row[6] ? String(row[6]).trim() : '';
      const kashrus  = row[7] ? String(row[7]).trim() : '';
      const pesach   = row[8] && row[8] !== '#N/A' ? String(row[8]).trim() : '';
      if (!id || !name || id === 'undefined') continue;
      const existing = db.get('skus').find({ id }).value();
      const data = { id, name, supplier, tipus, source, responsible, kashrus, pesach };
      if (existing) {
        db.get('skus').find({ id }).assign(data).write();
        updated++;
      } else {
        db.get('skus').push({ ...data, source: '', notes: '' }).write();
        added++;
      }
    }
    const fp = path.join(UPLOADS_DIR, req.file.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    res.json({ ok: true, added, updated, total: db.get('skus').value().length });
  } catch(e) {
    res.status(500).json({ error: 'שגיאה בקריאת הקובץ: ' + e.message });
  }
});

app.get('/api/skus/report', requireAuth, (req, res) => {
  const skus = db.get('skus').value();
  const docs = db.get('documents').value();
  const report = skus.map(s => {
    const linked = docs.filter(d => (d.skus||[]).some(ds => ds.id === s.id));
    return { ...s, doc_count: linked.length, docs: linked.map(d => ({ id: d.id, name: d.name, doctype: d.doctype||'', expiry_date: d.expiry_date||'', production_date: d.production_date||'', size_label: d.size_label||'', ext: d.ext||'' })) };
  });
  res.json(report);
});

/* ── STATS ── */
app.get('/api/stats', (req, res) => {
  const admin = isAdminReq(req);
  let docs = db.get('documents').value();
  if (!admin) docs = docs.filter(d => !d.hidden);
  const tags  = new Set(docs.flatMap(d => d.tags || []));
  const types = new Set(docs.map(d => d.ext));
  res.json({ total: docs.length, tags: tags.size, types: types.size });
});

/* ── TAGS ── */
app.get('/api/tags', (req, res) => {
  const admin = isAdminReq(req);
  let docs = db.get('documents').value();
  if (!admin) docs = docs.filter(d => !d.hidden);
  const map = {};
  docs.forEach(d => (d.tags||[]).forEach(t => { map[t] = (map[t]||0)+1; }));
  res.json(Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([tag,count])=>({ tag, count })));
});

/* ── DOCTYPES ── */
app.get('/api/doctypes', (req, res) => {
  const admin = isAdminReq(req);
  let docs = db.get('documents').value();
  if (!admin) docs = docs.filter(d => !d.hidden);
  const map = {};
  docs.forEach(d => { if (d.doctype) map[d.doctype] = (map[d.doctype]||0)+1; });
  res.json(Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([doctype,count])=>({ doctype, count })));
});

/* ── GET DOCS ── */
app.get('/api/docs', (req, res) => {
  const { q, tag, doctype, sort = 'date-desc' } = req.query;
  const admin = isAdminReq(req);
  let docs = db.get('documents').value();

  if (!admin) docs = docs.filter(d => !d.hidden);
  if (tag && tag !== 'הכל') docs = docs.filter(d => (d.tags||[]).includes(tag));
  if (doctype && doctype !== 'הכל') docs = docs.filter(d => d.doctype === doctype);
  if (q) {
    const lq = q.toLowerCase();
    docs = docs.filter(d =>
      d.name.toLowerCase().includes(lq) ||
      (d.description||'').toLowerCase().includes(lq) ||
      (d.tags||[]).some(t => t.toLowerCase().includes(lq)) ||
      (d.doctype||'').includes(lq) ||
      (d.skus||[]).some(s => s.id === q || s.name.toLowerCase().includes(lq))
    );
  }
  const sortFns = {
    'date-desc': (a,b) => new Date(b.created_at)-new Date(a.created_at),
    'date-asc':  (a,b) => new Date(a.created_at)-new Date(b.created_at),
    'name-asc':  (a,b) => a.name.localeCompare(b.name,'he'),
    'name-desc': (a,b) => b.name.localeCompare(a.name,'he'),
  };
  docs.sort(sortFns[sort] || sortFns['date-desc']);
  res.json(docs.map(docOut));
});

/* ── POST single ── */
app.post('/api/docs', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  const { name, description, tags, doctype, hidden, skus, expiry_date, production_date } = req.body;
  const docName    = name || req.file.originalname.replace(/\.[^.]+$/,'');
  const ext        = path.extname(req.file.originalname).replace('.','').toLowerCase();
  const parsedTags = tags ? JSON.parse(tags).map(t=>t.trim()).filter(Boolean) : ['כללי'];
  const parsedSkus = skus ? JSON.parse(skus) : [];
  const id         = db.get('nextDocId').value();
  const doc = {
    id, name: docName, description: description||'',
    filename: req.file.filename, original_name: req.file.originalname,
    ext, size_bytes: req.file.size,
    tags: parsedTags,
    doctype: doctype || '',
    skus: parsedSkus,
    expiry_date: expiry_date || '',
    production_date: production_date || '',
    hidden: hidden === 'true',
    uploader: req.user.username,
    created_at: new Date().toISOString()
  };
  db.get('documents').unshift(doc).write();
  db.set('nextDocId', id+1).write();
  res.status(201).json(docOut(doc));
});

/* ── POST multi ── */
app.post('/api/docs/multi', requireAuth, upload.array('files', 50), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'לא נבחרו קבצים' });
  const tags        = req.body.tags ? JSON.parse(req.body.tags).map(t=>t.trim()).filter(Boolean) : ['כללי'];
  const description = req.body.description || '';
  const doctype     = req.body.doctype || '';
  const hidden      = req.body.hidden === 'true';
  const created     = [];
  req.files.forEach(file => {
    const id  = db.get('nextDocId').value();
    const ext = path.extname(file.originalname).replace('.','').toLowerCase();
    const doc = {
      id, name: file.originalname.replace(/\.[^.]+$/,''), description,
      filename: file.filename, original_name: file.originalname,
      ext, size_bytes: file.size,
      tags: [...tags], doctype, hidden,
      uploader: req.user.username,
      created_at: new Date().toISOString()
    };
    db.get('documents').unshift(doc).write();
    db.set('nextDocId', id+1).write();
    created.push(docOut(doc));
  });
  res.status(201).json(created);
});

/* ── PATCH ── */
app.patch('/api/docs/:id', requireAuth, (req, res) => {
  const id  = parseInt(req.params.id);
  const doc = db.get('documents').find({ id }).value();
  if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
  const { name, description, tags, doctype, hidden, skus, expiry_date, production_date } = req.body;
  const updates = {};
  if (name        !== undefined) updates.name        = name;
  if (description !== undefined) updates.description = description;
  if (tags        !== undefined) updates.tags        = tags.map(t=>t.trim()).filter(Boolean);
  if (doctype     !== undefined) updates.doctype     = doctype;
  if (hidden      !== undefined) updates.hidden      = hidden;
  if (skus        !== undefined) updates.skus        = skus;
  if (expiry_date       !== undefined) updates.expiry_date       = expiry_date;
  if (production_date   !== undefined) updates.production_date   = production_date;
  db.get('documents').find({ id }).assign(updates).write();
  res.json(docOut(db.get('documents').find({ id }).value()));
});

/* ── DELETE ── */
app.delete('/api/docs/:id', requireAuth, requireAdmin, (req, res) => {
  const id  = parseInt(req.params.id);
  const doc = db.get('documents').find({ id }).value();
  if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
  const fp = path.join(UPLOADS_DIR, doc.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.get('documents').remove({ id }).write();
  res.json({ ok: true });
});

/* ── DOWNLOAD ── */


/* ── ROLE CODES ── */
app.get('/api/role-code/check', (req, res) => {
  const { code } = req.query;
  const ac = db.get('assistant_code').value();
  const vc = db.get('viewer_code').value();
  if (code === ac) return res.json({ ok: true, role: 'assistant' });
  if (code === vc) return res.json({ ok: true, role: 'viewer' });
  res.json({ ok: false });
});

app.patch('/api/role-codes', requireAuth, requireAdmin, (req, res) => {
  const { assistant_code, viewer_code } = req.body;
  if (assistant_code !== undefined) db.set('assistant_code', assistant_code).write();
  if (viewer_code    !== undefined) db.set('viewer_code',    viewer_code).write();
  res.json({ ok: true });
});

/* ── VIEW CODE ── */
app.get('/api/view-code/check', (req, res) => {
  const { code } = req.query;
  const stored = db.get('view_code').value();
  res.json({ ok: code === stored });
});

app.patch('/api/view-code', requireAuth, requireAdmin, (req, res) => {
  const { code } = req.body;
  if (!code || code.length < 2) return res.status(400).json({ error: 'קוד קצר מדי' });
  db.set('view_code', code).write();
  res.json({ ok: true });
});

app.get('/api/docs/:id/download', (req, res) => {
  const doc = db.get('documents').find({ id: parseInt(req.params.id) }).value();
  if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
  if (doc.hidden && !isAssistantReq(req)) return res.status(403).json({ error: 'אין גישה' });
  const fp = path.join(UPLOADS_DIR, doc.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'הקובץ לא נמצא' });
  const ext = doc.ext ? '.'+doc.ext : path.extname(doc.filename);
  const safeName = doc.name ? doc.name + ext : doc.original_name;
  const encoded = encodeURIComponent(safeName);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
  res.sendFile(fp);
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => {
  console.log(`\n מאגר מסמכים פועל על http://localhost:${PORT}`);
  console.log(`  כניסת מנהל: admin / 1234\n`);
});

/* ── AI IDENTIFY ── */
app.post('/api/identify', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY לא מוגדר' });
  try {
    const fs2 = require('fs');
    const fp = path.join(UPLOADS_DIR, req.file.filename);
    const fileData = fs2.readFileSync(fp).toString('base64');
    const ext = path.extname(req.file.originalname).toLowerCase();
    // קבל רשימת שמות מקטים לחיפוש
    const skus = db.get('skus').value().slice(0, 800);
    const skuList = skus.map(s => `${s.id}: ${s.name}`).join('\n');
    const prompt = `אתה מסייע לארכיון מסמכי כשרות של חברת יבוא מזון ישראלית.

קרא את המסמך המצורף וענה בדיוק בפורמט JSON הבא בלבד:
{
  "doctype": "סוג המסמך — אחד מ: תעודות כשרות / אישורי רבנות / דוחות יצור / בקשות / אחר",
  "name": "שם קצר ומתאר של המסמך בעברית",
  "expiry_date": "תאריך תוקף בפורמט YYYY-MM-DD אם מופיע, אחרת null",
  "description": "תיאור קצר של המסמך בעברית",
  "suggested_skus": ["מספרי מקטים מהרשימה שתואמים למוצרים במסמך — עד 5 מקטים"]
}

רשימת המקטים האפשריים:
${skuList}

ענה רק ב-JSON, ללא הסברים נוספים.`;
    const body = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } },
          { type: 'text', text: prompt }
        ]
      }]
    };
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'pdfs-2024-09-25' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'שגיאת API');
    const text = data.content[0].text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(text);
    // הוסף פרטי מקטים מלאים
    result.suggested_skus = (result.suggested_skus || []).map(id => {
      const sku = db.get('skus').find({ id: String(id) }).value();
      return sku || { id: String(id), name: '', supplier: '' };
    }).filter(s => s.name);
    // נקה קובץ זמני
    if (fs2.existsSync(fp)) fs2.unlinkSync(fp);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

