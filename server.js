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
db.defaults({ users: [], documents: [], nextDocId: 1, nextUserId: 1 }).write();

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

function isAdminReq(req) {
  try {
    const h = req.headers.authorization || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (t) { jwt.verify(t, JWT_SECRET); return true; }
  } catch {}
  return false;
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  return bytes > 1048576 ? (bytes/1048576).toFixed(1)+' MB' : Math.round(bytes/1024)+' KB';
}
function docOut(d) {
  return { ...d, size_label: fmtSize(d.size_bytes) };
}

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

app.patch('/api/auth/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!bcrypt.compareSync(currentPassword, user.password))
    return res.status(400).json({ error: 'סיסמה נוכחית שגויה' });
  db.get('users').find({ id: req.user.id }).assign({ password: bcrypt.hashSync(newPassword, 10) }).write();
  res.json({ ok: true });
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
      (d.doctype||'').includes(lq)
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
  const { name, description, tags, doctype, hidden } = req.body;
  const docName    = name || req.file.originalname.replace(/\.[^.]+$/,'');
  const ext        = path.extname(req.file.originalname).replace('.','').toLowerCase();
  const parsedTags = tags ? JSON.parse(tags).map(t=>t.trim()).filter(Boolean) : ['כללי'];
  const id         = db.get('nextDocId').value();
  const doc = {
    id, name: docName, description: description||'',
    filename: req.file.filename, original_name: req.file.originalname,
    ext, size_bytes: req.file.size,
    tags: parsedTags,
    doctype: doctype || '',
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
  const { name, description, tags, doctype, hidden } = req.body;
  const updates = {};
  if (name        !== undefined) updates.name        = name;
  if (description !== undefined) updates.description = description;
  if (tags        !== undefined) updates.tags        = tags.map(t=>t.trim()).filter(Boolean);
  if (doctype     !== undefined) updates.doctype     = doctype;
  if (hidden      !== undefined) updates.hidden      = hidden;
  db.get('documents').find({ id }).assign(updates).write();
  res.json(docOut(db.get('documents').find({ id }).value()));
});

/* ── DELETE ── */
app.delete('/api/docs/:id', requireAuth, (req, res) => {
  const id  = parseInt(req.params.id);
  const doc = db.get('documents').find({ id }).value();
  if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
  const fp = path.join(UPLOADS_DIR, doc.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.get('documents').remove({ id }).write();
  res.json({ ok: true });
});

/* ── DOWNLOAD ── */
app.get('/api/docs/:id/download', (req, res) => {
  const doc = db.get('documents').find({ id: parseInt(req.params.id) }).value();
  if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
  if (doc.hidden && !isAdminReq(req)) return res.status(403).json({ error: 'אין גישה' });
  const fp = path.join(UPLOADS_DIR, doc.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'הקובץ לא נמצא' });
  res.download(fp, doc.original_name);
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => {
  console.log(`\n מאגר מסמכים פועל על http://localhost:${PORT}`);
  console.log(`  כניסת מנהל: admin / 1234\n`);
});
