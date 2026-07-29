require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const multer   = require('multer');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const nodemailer = require('nodemailer');
const { uploadBuffer, getObjectStream } = require('./lib/r2');

const prisma = new PrismaClient();

const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'docrepo_secret_change_in_prod';

function getMailer() {
  if (!process.env.EMAIL_FROM || !process.env.EMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_APP_PASSWORD },
  });
}

/* ── generic settings (was top-level db fields: view_code/assistant_code/viewer_code) ── */
const SETTINGS_DEFAULTS = { assistant_code: '5678', viewer_code: '0000', view_code: '1234' };
async function getSetting(key) {
  const row = await prisma.syncState.findUnique({ where: { key } });
  return row ? row.value : SETTINGS_DEFAULTS[key];
}
async function setSetting(key, value) {
  await prisma.syncState.upsert({ where: { key }, update: { value }, create: { key, value } });
}
async function ensureDefaults() {
  const userCount = await prisma.user.count();
  if (userCount === 0) {
    await prisma.user.create({
      data: { email: 'admin', passwordHash: bcrypt.hashSync('1234', 10), role: 'ADMIN' },
    });
    console.log('Default admin created: admin / 1234');
  }
  for (const [key, value] of Object.entries(SETTINGS_DEFAULTS)) {
    const existing = await prisma.syncState.findUnique({ where: { key } });
    if (!existing) await prisma.syncState.create({ data: { key, value } });
  }
}
ensureDefaults().catch(e => console.error('startup defaults failed', e));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.jpg','.jpeg','.png','.gif','.txt'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

function r2KeyFor(originalname) {
  const ext = path.extname(originalname);
  return `docs/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Express 4 does not catch rejected promises from async route handlers --
// an unhandled rejection there can crash the whole process. Wrap every
// async handler so an error becomes a normal 500 response instead.
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: e.message || 'שגיאת שרת' });
  });
}
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

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

/* middleware: מנהל או עוזר (JWT או קוד עוזר) */
async function requireAssistant(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      try { req.user = jwt.verify(token, JWT_SECRET); return next(); } catch {}
    }
    const code = req.headers['x-assistant-code'] || '';
    const ac = await getSetting('assistant_code');
    if (code && code === ac) {
      req.user = { username: 'assistant', role: 'assistant' };
      return next();
    }
    return res.status(401).json({ error: 'לא מחובר' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'שגיאת שרת' });
  }
}

function fmtSize(bytes) {
  if (!bytes) return '—';
  return bytes > 1048576 ? (bytes/1048576).toFixed(1)+' MB' : Math.round(bytes/1024)+' KB';
}

/* ── shape adapters: Prisma model <-> legacy JSON the frontend expects ── */
function skuOut(s) {
  return {
    id: s.code, name: s.name, supplier: s.supplier || '', supplier2: s.supplier2 || '',
    tipus: s.tipus || '', source: s.sourceFlag || '', responsible: s.responsible || '',
    kashrus: s.kashrutBodyRef || '', pesach: s.pesachStatusRef || '', notes: s.notes || '',
    certType: s.certType || '',
  };
}
const VALID_CERT_TYPES = ['ANNUAL', 'PER_PRODUCTION', 'ANNUAL_REGULAR_PER_PRODUCTION_PESACH'];
const CERT_TYPE_LABEL_TO_VALUE = {
  'תעודה שנתית': 'ANNUAL',
  'תעודה לפי יצור': 'PER_PRODUCTION',
  'לימות השנה שנתי, לפסח לפי יצור': 'ANNUAL_REGULAR_PER_PRODUCTION_PESACH',
};
function parseCertTypeCell(raw) {
  const v = raw ? String(raw).trim() : '';
  if (!v) return null;
  if (VALID_CERT_TYPES.includes(v)) return v; // allows re-importing our own export
  return CERT_TYPE_LABEL_TO_VALUE[v] || null;
}

// Batch-fetch context for docOut() -- calling prisma.skuLink.findMany() once
// per document (via Promise.all over a whole list) exhausted the connection
// pool once the document count grew past a few hundred (P2024). Fetch
// everything needed for a whole list in 2 queries instead of 2*N.
async function batchDocContext(docIds) {
  const [links, users] = await Promise.all([
    prisma.skuLink.findMany({
      where: { docType: 'DOCUMENT', documentId: { in: docIds } },
      include: { sku: true },
    }),
    prisma.user.findMany(),
  ]);
  const linksByDoc = new Map();
  for (const l of links) {
    if (!linksByDoc.has(l.documentId)) linksByDoc.set(l.documentId, []);
    linksByDoc.get(l.documentId).push(l);
  }
  const usersById = new Map(users.map(u => [u.id, u]));
  return { linksByDoc, usersById };
}

function docOut(d, ctx) {
  const links = ctx.linksByDoc.get(d.id) || [];
  const uploaderUser = d.uploadedById ? ctx.usersById.get(d.uploadedById) : null;
  return {
    id: d.id,
    name: d.title || '',
    description: d.description || '',
    filename: path.basename(d.fileUrl),
    original_name: d.title || path.basename(d.fileUrl),
    ext: (d.docExt || path.extname(d.fileUrl).replace('.', '')),
    size_bytes: d.sizeBytes || 0,
    size_label: fmtSize(d.sizeBytes || 0),
    tags: d.tags || [],
    doctype: d.docType || '',
    skus: links.map(l => skuOut(l.sku)),
    expiry_date: d.expiryDate ? d.expiryDate.toISOString().slice(0, 10) : '',
    production_date: d.productionDate ? d.productionDate.toISOString().slice(0, 10) : '',
    hidden: d.hidden,
    uploader: uploaderUser ? uploaderUser.email : '',
    created_at: d.createdAt.toISOString(),
  };
}

/* ── TEMP RESET (להסרה אחרי שימוש) ── */
app.get('/api/reset-admin-password', ah(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { email: 'admin' } });
  if (user) {
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: bcrypt.hashSync('1234', 10) } });
    res.json({ ok: true, message: 'סיסמת מנהל אופסה ל-1234' });
  } else {
    res.json({ ok: false, message: 'משתמש admin לא נמצא' });
  }
}));

/* ── AUTH ── */
app.post('/api/auth/login', ah(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'חסרים פרטים' });
  const user = await prisma.user.findUnique({ where: { email: username } });
  if (!user || !bcrypt.compareSync(password, user.passwordHash))
    return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
  const role = user.role.toLowerCase();
  const token = jwt.sign({ id: user.id, username: user.email, role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, username: user.email, role });
}));

app.patch('/api/auth/password', requireAuth, requireAdmin, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!bcrypt.compareSync(currentPassword, user.passwordHash))
    return res.status(400).json({ error: 'סיסמה נוכחית שגויה' });
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: bcrypt.hashSync(newPassword, 10) } });
  res.json({ ok: true });
}));

/* ── SKUS ── */
app.get('/api/skus', ah(async (req, res) => {
  const { q, all } = req.query;
  const where = q ? {
    OR: [
      { code: { contains: q } },
      { name: { contains: q, mode: 'insensitive' } },
      { supplier: { contains: q, mode: 'insensitive' } },
    ],
  } : {};
  const skus = await prisma.sku.findMany({ where, take: all ? undefined : 50 });
  res.json(skus.map(skuOut));
}));

app.post('/api/skus', requireAuth, ah(async (req, res) => {
  const { id, name, supplier, supplier2, tipus, source, responsible, kashrus, pesach, notes, certType } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'חסרים מספר ושם' });
  if (await prisma.sku.findUnique({ where: { code: String(id) } }))
    return res.status(400).json({ error: 'מקט כבר קיים' });
  if (certType && !VALID_CERT_TYPES.includes(certType)) return res.status(400).json({ error: 'סוג תעודה לא תקין' });
  const sku = await prisma.sku.create({
    data: {
      code: String(id), name, supplier: supplier||'', supplier2: supplier2||'', tipus: tipus||'',
      sourceFlag: source||'', responsible: responsible||'',
      kashrutBodyRef: kashrus||'', pesachStatusRef: pesach||'', notes: notes||'',
      certType: certType || null,
      reviewedAt: new Date(),
    },
  });
  res.status(201).json(skuOut(sku));
}));

app.patch('/api/skus/:id', requireAuth, ah(async (req, res) => {
  const sku = await prisma.sku.findUnique({ where: { code: req.params.id } });
  if (!sku) return res.status(404).json({ error: 'מקט לא נמצא' });
  const { name, supplier, supplier2, tipus, source, responsible, kashrus, pesach, notes, certType } = req.body;
  if (certType !== undefined && certType !== '' && !VALID_CERT_TYPES.includes(certType))
    return res.status(400).json({ error: 'סוג תעודה לא תקין' });
  const updates = {};
  if (name        !== undefined) updates.name           = name;
  if (supplier    !== undefined) updates.supplier       = supplier;
  if (supplier2   !== undefined) updates.supplier2      = supplier2;
  if (tipus       !== undefined) updates.tipus          = tipus;
  if (source      !== undefined) updates.sourceFlag     = source;
  if (responsible !== undefined) updates.responsible    = responsible;
  if (kashrus     !== undefined) updates.kashrutBodyRef = kashrus;
  if (pesach      !== undefined) updates.pesachStatusRef= pesach;
  if (notes       !== undefined) updates.notes          = notes;
  if (certType    !== undefined) updates.certType       = certType || null;
  updates.reviewedAt = new Date();
  const updated = await prisma.sku.update({ where: { code: req.params.id }, data: updates });
  res.json(skuOut(updated));
}));

app.delete('/api/skus/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  const sku = await prisma.sku.findUnique({ where: { code: req.params.id } });
  if (!sku) return res.status(404).json({ error: 'מקט לא נמצא' });
  await prisma.skuLink.deleteMany({ where: { skuId: sku.id } });
  await prisma.sku.delete({ where: { id: sku.id } });
  res.json({ ok: true });
}));

app.post('/api/skus/import', requireAuth, upload.single('file'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    let added = 0, updated = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const id           = row[0] ? String(row[0]).trim() : '';
      const name         = row[1] ? String(row[1]).trim() : '';
      const tipusRaw     = row[2] ? String(row[2]).trim() : '';
      const tipus        = tipusRaw === 'P' ? 'יצור' : tipusRaw === 'R' ? 'רכש' : tipusRaw;
      const source       = row[3] ? String(row[3]).trim() : '';
      const responsible  = row[4] ? String(row[4]).trim() : '';
      const supplier2    = row[5] ? String(row[5]).trim() : '';
      const supplier     = row[6] ? String(row[6]).trim() : '';
      const kashrus       = row[7] ? String(row[7]).trim() : '';
      const pesach        = row[8] && row[8] !== '#N/A' ? String(row[8]).trim() : '';
      const notes         = row[9] ? String(row[9]).trim() : '';
      const certType      = parseCertTypeCell(row[10]);
      if (!id || !name || id === 'undefined') continue;
      const existing = await prisma.sku.findUnique({ where: { code: id } });
      const data = { name, supplier, supplier2, tipus, sourceFlag: source, responsible, kashrutBodyRef: kashrus, pesachStatusRef: pesach, notes };
      if (certType) data.certType = certType; // don't blank out an existing value when the column is empty for this row
      if (existing) {
        await prisma.sku.update({ where: { code: id }, data });
        updated++;
      } else {
        await prisma.sku.create({ data: { code: id, ...data } });
        added++;
      }
    }
    const total = await prisma.sku.count();
    res.json({ ok: true, added, updated, total });
  } catch(e) {
    res.status(500).json({ error: 'שגיאה בקריאת הקובץ: ' + e.message });
  }
}));

app.get('/api/skus/report', requireAuth, ah(async (req, res) => {
  // one query for all SKUs' links instead of one query per SKU (was
  // exhausting the connection pool at real data volume -- see docOut/
  // batchDocContext above for the same fix on the documents side).
  const [skus, allLinks] = await Promise.all([
    prisma.sku.findMany(),
    prisma.skuLink.findMany({ include: { document: true } }),
  ]);
  const linksBySku = new Map();
  for (const l of allLinks) {
    if (!linksBySku.has(l.skuId)) linksBySku.set(l.skuId, []);
    linksBySku.get(l.skuId).push(l);
  }
  const report = skus.map(s => {
    const links = linksBySku.get(s.id) || [];
    const withDocs = links.filter(l => l.document);
    return {
      ...skuOut(s),
      doc_count: links.length,
      docs: withDocs.map(l => ({
        id: l.document.id, name: l.document.title, doctype: l.document.docType || '',
        expiry_date: l.document.expiryDate ? l.document.expiryDate.toISOString().slice(0,10) : '',
        production_date: l.document.productionDate ? l.document.productionDate.toISOString().slice(0,10) : '',
        size_label: fmtSize(l.document.sizeBytes || 0), ext: l.document.docExt || '',
      })),
    };
  });
  res.json(report);
}));

/* ── STATS ── */
app.get('/api/stats', ah(async (req, res) => {
  const admin = isAdminReq(req);
  const docs = await prisma.document.findMany({ where: admin ? {} : { hidden: false } });
  const tags  = new Set(docs.flatMap(d => d.tags || []));
  const types = new Set(docs.map(d => d.docExt).filter(Boolean));
  const linkedIds = new Set(
    (await prisma.skuLink.findMany({ where: { docType: 'DOCUMENT' }, select: { documentId: true } }))
      .map(l => l.documentId)
  );
  const unlinked = docs.filter(d => !linkedIds.has(d.id)).length;
  res.json({ total: docs.length, tags: tags.size, types: types.size, unlinked });
}));

/* ── TAGS ── */
app.get('/api/tags', ah(async (req, res) => {
  const admin = isAdminReq(req);
  const docs = await prisma.document.findMany({ where: admin ? {} : { hidden: false } });
  const map = {};
  docs.forEach(d => (d.tags||[]).forEach(t => { map[t] = (map[t]||0)+1; }));
  res.json(Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([tag,count])=>({ tag, count })));
}));

/* ── DOCTYPES ── */
app.get('/api/doctypes', ah(async (req, res) => {
  const admin = isAdminReq(req);
  const docs = await prisma.document.findMany({ where: admin ? {} : { hidden: false } });
  const map = {};
  docs.forEach(d => { if (d.docType) map[d.docType] = (map[d.docType]||0)+1; });
  res.json(Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([doctype,count])=>({ doctype, count })));
}));

/* ── GET DOCS ── */
app.get('/api/docs', ah(async (req, res) => {
  const { q, tag, doctype, sort = 'date-desc', unlinked } = req.query;
  const admin = isAdminReq(req);
  const where = {};
  if (!admin) where.hidden = false;
  if (tag && tag !== 'הכל') where.tags = { has: tag };
  if (doctype && doctype !== 'הכל') where.docType = doctype;

  const orderBy =
    sort === 'date-asc'  ? { createdAt: 'asc' } :
    sort === 'name-asc'  ? { title: 'asc' } :
    sort === 'name-desc' ? { title: 'desc' } :
    { createdAt: 'desc' };

  let docs = await prisma.document.findMany({ where, orderBy });
  const ctx = await batchDocContext(docs.map(d => d.id));
  let out = docs.map(d => docOut(d, ctx));

  if (unlinked === '1') out = out.filter(d => (d.skus||[]).length === 0);

  const filtered = q ? out.filter(d => {
    const lq = q.toLowerCase();
    return d.name.toLowerCase().includes(lq) ||
      (d.description||'').toLowerCase().includes(lq) ||
      (d.tags||[]).some(t => t.toLowerCase().includes(lq)) ||
      (d.doctype||'').includes(lq) ||
      (d.skus||[]).some(s => s.id.includes(q) || s.name.toLowerCase().includes(lq));
  }) : out;

  res.json(filtered);
}));

/* ── POST single ── */
app.post('/api/docs', requireAssistant, upload.single('file'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  const { name, description, tags, doctype, hidden, skus, expiry_date, production_date, approvalStatus, kashrutLevel, isRawMaterial } = req.body;
  const docName    = name || req.file.originalname.replace(/\.[^.]+$/,'');
  const ext        = path.extname(req.file.originalname).replace('.','').toLowerCase();
  const parsedTags = tags ? JSON.parse(tags).map(t=>t.trim()).filter(Boolean) : ['כללי'];
  const parsedSkus = skus ? JSON.parse(skus) : [];

  const key = r2KeyFor(req.file.originalname);
  await uploadBuffer(req.file.buffer, key, req.file.mimetype);

  const doc = await prisma.document.create({
    data: {
      title: docName, description: description||'', docType: doctype || '', docExt: ext, sizeBytes: req.file.size,
      tags: parsedTags, fileUrl: key,
      expiryDate: expiry_date ? new Date(expiry_date) : null,
      productionDate: production_date ? new Date(production_date) : null,
      hidden: hidden === 'true',
      uploadedById: req.user.id || null,
    },
  });
  for (const s of parsedSkus) {
    const sku = await prisma.sku.findUnique({ where: { code: String(s.id) } });
    if (sku) await prisma.skuLink.create({
      data: {
        skuId: sku.id, docType: 'DOCUMENT', documentId: doc.id, visibleToCustomer: false,
        approvalStatus: approvalStatus || 'APPROVED',
        kashrutLevel: kashrutLevel || null,
        isRawMaterial: isRawMaterial === 'true',
      },
    });
  }
  res.status(201).json(docOut(doc, await batchDocContext([doc.id])));
}));

/* ── POST multi ── */
app.post('/api/docs/multi', requireAuth, upload.array('files', 50), ah(async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'לא נבחרו קבצים' });
  const tags        = req.body.tags ? JSON.parse(req.body.tags).map(t=>t.trim()).filter(Boolean) : ['כללי'];
  const description = req.body.description || '';
  const doctype     = req.body.doctype || '';
  const hidden      = req.body.hidden === 'true';
  const createdDocs = [];
  for (const file of req.files) {
    const ext = path.extname(file.originalname).replace('.','').toLowerCase();
    const key = r2KeyFor(file.originalname);
    await uploadBuffer(file.buffer, key, file.mimetype);
    const doc = await prisma.document.create({
      data: {
        title: file.originalname.replace(/\.[^.]+$/,''), description, docType: doctype, docExt: ext,
        sizeBytes: file.size, tags: [...tags], hidden, fileUrl: key, uploadedById: req.user.id || null,
      },
    });
    createdDocs.push(doc);
  }
  const ctx = await batchDocContext(createdDocs.map(d => d.id));
  res.status(201).json(createdDocs.map(d => docOut(d, ctx)));
}));

/* ── PATCH ── */
app.patch('/api/docs/:id', requireAssistant, ah(async (req, res) => {
  const id  = parseInt(req.params.id);
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
  const { name, description, tags, doctype, hidden, skus, expiry_date, production_date, approvalStatus, kashrutLevel, isRawMaterial } = req.body;
  const updates = {};
  if (name            !== undefined) updates.title          = name;
  if (description      !== undefined) updates.description   = description;
  if (tags            !== undefined) updates.tags           = tags.map(t=>t.trim()).filter(Boolean);
  if (doctype         !== undefined) updates.docType        = doctype;
  if (hidden          !== undefined) updates.hidden         = hidden;
  if (expiry_date     !== undefined) updates.expiryDate     = expiry_date ? new Date(expiry_date) : null;
  if (production_date !== undefined) updates.productionDate = production_date ? new Date(production_date) : null;
  const updated = await prisma.document.update({ where: { id }, data: updates });

  if (skus !== undefined) {
    // replacing the sku list always recreates the links -- callers that care
    // about approval tracking (the raw-material screen) update the SkuLink
    // row directly via PATCH /api/sku-links/:id instead of touching skus[].
    await prisma.skuLink.deleteMany({ where: { docType: 'DOCUMENT', documentId: id } });
    for (const s of skus) {
      const sku = await prisma.sku.findUnique({ where: { code: String(s.id) } });
      if (sku) await prisma.skuLink.create({
        data: {
          skuId: sku.id, docType: 'DOCUMENT', documentId: id, visibleToCustomer: false,
          approvalStatus: approvalStatus || 'APPROVED',
          kashrutLevel: kashrutLevel || null,
          isRawMaterial: isRawMaterial === 'true',
        },
      });
    }
  }
  res.json(docOut(updated, await batchDocContext([updated.id])));
}));

/* ── DELETE ── */
app.delete('/api/docs/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  const id  = parseInt(req.params.id);
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
  await prisma.skuLink.deleteMany({ where: { docType: 'DOCUMENT', documentId: id } });
  await prisma.document.delete({ where: { id } });
  res.json({ ok: true });
  // note: intentionally not deleting the R2 object -- keep it recoverable; a
  // separate cleanup pass can reap orphaned keys later if storage cost matters.
}));

/* ── RAW MATERIAL APPROVALS (ניהול אישור חמרי גלם) ──
 * A raw-material entry is a photographed label (a Document) linked to an
 * existing SKU via a SkuLink flagged isRawMaterial:true, tracked through
 * approvalStatus (PENDING/APPROVED/REJECTED) and a free-text kashrutLevel
 * as correspondence with the kashrut body (בד"ץ) progresses. Reuses the
 * regular document upload (POST /api/docs) for the photo itself -- this is
 * just the read/status-update side. */
function rawMaterialOut(link) {
  return {
    linkId: link.id,
    skuId: link.sku.code, skuName: link.sku.name,
    docId: link.document.id, docName: link.document.title, docExt: link.document.docExt || '',
    approvalStatus: link.approvalStatus, kashrutLevel: link.kashrutLevel || '',
    createdAt: link.createdAt,
  };
}

app.get('/api/raw-materials', requireAssistant, ah(async (req, res) => {
  const { status, q } = req.query;
  const where = { isRawMaterial: true };
  if (status) where.approvalStatus = status;
  const links = await prisma.skuLink.findMany({
    where, include: { sku: true, document: true }, orderBy: { createdAt: 'desc' },
  });
  let out = links.filter(l => l.sku && l.document).map(rawMaterialOut);
  if (q) {
    const ql = q.toLowerCase();
    out = out.filter(r => r.skuId.includes(q) || r.skuName.toLowerCase().includes(ql));
  }
  res.json(out);
}));

app.patch('/api/sku-links/:id', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const link = await prisma.skuLink.findUnique({ where: { id }, include: { sku: true, document: true } });
  if (!link) return res.status(404).json({ error: 'רשומה לא נמצאה' });
  const { approvalStatus, kashrutLevel } = req.body;
  if (approvalStatus !== undefined && !['PENDING','APPROVED','REJECTED'].includes(approvalStatus))
    return res.status(400).json({ error: 'סטטוס לא תקין' });
  const updates = { reviewedById: req.user.id || null, reviewedAt: new Date() };
  if (approvalStatus !== undefined) updates.approvalStatus = approvalStatus;
  if (kashrutLevel   !== undefined) updates.kashrutLevel   = kashrutLevel;
  const updated = await prisma.skuLink.update({
    where: { id }, data: updates, include: { sku: true, document: true },
  });
  res.json(rawMaterialOut(updated));
}));

/* ── send a raw-material label by email, recipient chosen per-send (no fixed contact list) ── */
app.post('/api/sku-links/:id/send-email', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const { to, message } = req.body;
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'כתובת מייל לא תקינה' });
  const mailer = getMailer();
  if (!mailer) return res.status(400).json({ error: 'שליחת מייל לא הוגדרה בשרת (חסר EMAIL_APP_PASSWORD)' });
  const link = await prisma.skuLink.findUnique({ where: { id }, include: { sku: true, document: true } });
  if (!link || !link.sku || !link.document) return res.status(404).json({ error: 'רשומה לא נמצאה' });
  const { stream, contentType } = await getObjectStream(link.document.fileUrl);
  const ext = link.document.docExt ? '.' + link.document.docExt : '';
  const filename = (link.document.title || 'תווית') + ext;
  const defaultBody = `שלום,\n\nמצורפת תווית עבור מק"ט ${link.sku.code} - ${link.sku.name}.\n${link.kashrutLevel ? 'רמת כשרות: ' + link.kashrutLevel + '\n' : ''}\nבברכה,\nאחים כהן`;
  await mailer.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject: `אישור כשרות - מק"ט ${link.sku.code} - ${link.sku.name}`,
    text: message || defaultBody,
    attachments: [{ filename, content: stream, contentType }],
  });
  res.json({ ok: true });
}));

/* ── CONTACTS (for the send-to-email/whatsapp flow) ──
 * Not a fixed predefined list -- people save whichever contacts they
 * actually deal with (kashrut-body reps etc.), then pick from those
 * instead of retyping the same address/number every time. */
app.get('/api/contacts', requireAssistant, ah(async (req, res) => {
  const contacts = await prisma.contact.findMany({ orderBy: { name: 'asc' } });
  res.json(contacts);
}));

app.post('/api/contacts', requireAssistant, ah(async (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'נא להזין שם' });
  if (!email && !phone) return res.status(400).json({ error: 'נא להזין מייל או טלפון' });
  const contact = await prisma.contact.create({
    data: { name: name.trim(), email: email || null, phone: phone || null },
  });
  res.status(201).json(contact);
}));

app.delete('/api/contacts/:id', requireAssistant, ah(async (req, res) => {
  await prisma.contact.delete({ where: { id: parseInt(req.params.id) } }).catch(() => {});
  res.json({ ok: true });
}));

/* ── ROLE CODES ── */
app.get('/api/role-code/check', ah(async (req, res) => {
  const { code } = req.query;
  const ac = await getSetting('assistant_code');
  const vc = await getSetting('viewer_code');
  if (code === ac) return res.json({ ok: true, role: 'assistant' });
  if (code === vc) return res.json({ ok: true, role: 'viewer' });
  res.json({ ok: false });
}));

app.patch('/api/role-codes', requireAuth, requireAdmin, ah(async (req, res) => {
  const { assistant_code, viewer_code } = req.body;
  if (assistant_code !== undefined) await setSetting('assistant_code', assistant_code);
  if (viewer_code    !== undefined) await setSetting('viewer_code', viewer_code);
  res.json({ ok: true });
}));

/* ── VIEW CODE ── */
app.get('/api/view-code/check', ah(async (req, res) => {
  const { code } = req.query;
  const stored = await getSetting('view_code');
  res.json({ ok: code === stored });
}));

app.patch('/api/view-code', requireAuth, requireAdmin, ah(async (req, res) => {
  const { code } = req.body;
  if (!code || code.length < 2) return res.status(400).json({ error: 'קוד קצר מדי' });
  await setSetting('view_code', code);
  res.json({ ok: true });
}));

/* ── DOWNLOAD ── */
app.get('/api/docs/:id/download', ah(async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
  if (doc.hidden && !isAssistantReq(req)) return res.status(403).json({ error: 'אין גישה' });
  try {
    const { stream, contentType } = await getObjectStream(doc.fileUrl);
    const ext = doc.docExt ? '.'+doc.docExt : path.extname(doc.fileUrl);
    const safeName = (doc.title || path.basename(doc.fileUrl)) + ext;
    const encoded = encodeURIComponent(safeName);
    const inline = req.query.inline === '1';
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`);
    if (contentType) res.setHeader('Content-Type', contentType);
    stream.pipe(res);
  } catch (e) {
    res.status(404).json({ error: 'הקובץ לא נמצא' });
  }
}));

/* ── IDENTIFY BY DOC ID ── */
app.post('/api/identify-by-id/:id', requireAssistant, ah(async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: parseInt(req.params.id) } });
  if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
  const ext = (doc.docExt || '').toLowerCase();
  let mediaType = 'application/pdf';
  if (['jpg','jpeg'].includes(ext)) mediaType = 'image/jpeg';
  else if (ext === 'png') mediaType = 'image/png';
  else if (!['pdf'].includes(ext)) return res.status(400).json({ error: 'סוג קובץ לא נתמך לזיהוי' });

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'מפתח API חסר' });

    const { stream } = await getObjectStream(doc.fileUrl);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const fileData = Buffer.concat(chunks).toString('base64');

    const skus = await prisma.sku.findMany({ take: 800 });
    const skuList = skus.map(s => `${s.code}: ${s.name}`).join('\n');
    const prompt = `אתה מסייע לארכיון מסמכי כשרות של חברת יבוא מזון ישראלית.

קרא את המסמך המצורף בקפידה וענה בדיוק בפורמט JSON הבא בלבד:
{
  "doctype": "סוג המסמך — אחד מ: תעודות בדצים / תעודות רבנות / בקשות לרבנות / דוחות בדצים ואישורי תויות / תויות / מכתבים אחרים",
  "name": "שם קצר ומתאר של המסמך בעברית",
  "expiry_date": "תאריך תוקף (Valid Until / Expiry / תוקף עד / Valid through) בפורמט YYYY-MM-DD. חפש בכל חלקי המסמך. אם לא מופיע — null",
  "production_date": "תאריך יצור (Production Date / Date of Issue / תאריך הנפקה) בפורמט YYYY-MM-DD. אם לא מופיע — null",
  "description": "תיאור קצר של המסמך בעברית — כולל שם היצרן אם מופיע",
  "suggested_skus": ["מספרי מקטים מהרשימה שתואמים למוצרים במסמך — עד 5 מקטים"]
}
רשימת המקטים: ${skuList}
ענה רק ב-JSON.`;

    const contentBlock = ext === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileData } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileData } };

    const body = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }]
    };
    const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    if (ext === 'pdf') headers['anthropic-beta'] = 'pdfs-2024-09-25';

    const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'שגיאת API');

    let result = {};
    const text = data.content?.find(c => c.type === 'text')?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    try { result = JSON.parse(clean); } catch { result = {}; }

    const suggested = [];
    for (const id of (result.suggested_skus || [])) {
      const sku = await prisma.sku.findUnique({ where: { code: String(id) } });
      suggested.push(sku ? skuOut(sku) : { id: String(id), name: '', supplier: '' });
    }
    result.suggested_skus = suggested;
    res.json({ ok: true, ...result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}));

app.get('*', (_req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => {
  console.log(`\n מאגר מסמכים פועל על http://localhost:${PORT}`);
  console.log(`  כניסת מנהל: admin / 1234 (אם זו הרצה ראשונה)\n`);
});

/* ── AI IDENTIFY ── */
app.post('/api/identify', requireAssistant, upload.single('file'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY לא מוגדר' });
  try {
    const fileData = req.file.buffer.toString('base64');
    const skus = await prisma.sku.findMany({ take: 800 });
    const skuList = skus.map(s => `${s.code}: ${s.name}`).join('\n');
    const prompt = `אתה מסייע לארכיון מסמכי כשרות של חברת יבוא מזון ישראלית.

קרא את המסמך המצורף בקפידה וענה בדיוק בפורמט JSON הבא בלבד:
{
  "doctype": "סוג המסמך — אחד מ: תעודות בדצים / תעודות רבנות / בקשות לרבנות / דוחות בדצים ואישורי תויות / תויות / מכתבים אחרים",
  "name": "שם קצר ומתאר של המסמך בעברית",
  "expiry_date": "תאריך תוקף (Valid Until / Expiry / תוקף עד / Valid through) בפורמט YYYY-MM-DD. חפש בכל חלקי המסמך. אם לא מופיע — null",
  "production_date": "תאריך יצור (Production Date / Date of Issue / תאריך הנפקה / Manufactured) בפורמט YYYY-MM-DD. אם לא מופיע — null",
  "description": "תיאור קצר של המסמך בעברית — כולל שם היצרן אם מופיע",
  "suggested_skus": ["מספרי מקטים מהרשימה שתואמים למוצרים במסמך — עד 5 מקטים"]
}

הנחיות: המר תאריכים מ-DD/MM/YYYY או MM/DD/YYYY לפורמט YYYY-MM-DD.
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
    const suggested = [];
    for (const id of (result.suggested_skus || [])) {
      const sku = await prisma.sku.findUnique({ where: { code: String(id) } });
      if (sku) suggested.push(skuOut(sku));
    }
    result.suggested_skus = suggested;
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}));
