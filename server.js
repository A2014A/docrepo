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
    const allowed = ['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.jpg','.jpeg','.png','.gif','.txt','.csv'];
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
    // never-reviewed SKU that arrived via a Priority goods-receipt report; any edit (PATCH) sets reviewedAt and clears it
    isNew: !s.reviewedAt && (s.origin || []).includes('priority_report'),
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
    trashedAt: d.trashedAt ? d.trashedAt.toISOString() : null,
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

// Rich multi-field SKU search ("SKU search everywhere" -- link-suggestions
// screen + the dashboard document-preview panel). Quotes/gershayim are
// REMOVED (not replaced by a space), so "ק"ג"/"חו"ג" collapse to "קג"/"חוג"
// contiguously -- same collapseMatres normalization as the L2 engine
// (prisma/run-l2-suggestions.js) so "ק"ג" and "קג" are treated the same.
function skuSearchNormalize(s) {
  if (!s) return '';
  let t = s.toString().toLowerCase();
  t = t.replace(/["'״׳]/g, '');          // strip quotes WITHOUT inserting a space
  t = t.replace(/[.,()-]/g, ' ');
  t = t.replace(/יי+/g, 'י').replace(/וו+/g, 'ו'); // collapseMatres, same as L2
  return t.replace(/\s+/g, ' ').trim();
}
app.get('/api/skus/search', requireAuth, ah(async (req, res) => {
  const q = (req.query.q || '').trim();
  const includeNotProduct = req.query.includeNotProduct === '1' || req.query.includeNotProduct === 'true';
  if (q.length < 2) return res.json([]);

  const words = skuSearchNormalize(q).split(' ').filter(Boolean);
  if (!words.length) return res.json([]);

  const [skus, aliases] = await Promise.all([
    prisma.sku.findMany({ where: includeNotProduct ? {} : { itemType: { not: 'NOT_PRODUCT' } } }),
    prisma.supplierAlias.findMany(),
  ]);
  const aliasBySupplier = new Map();
  for (const a of aliases) {
    const key = skuSearchNormalize(a.supplierName);
    if (!aliasBySupplier.has(key)) aliasBySupplier.set(key, []);
    aliasBySupplier.get(key).push(a.manufacturerName);
  }
  function manufacturersFor(sku) {
    const out = [];
    for (const supplierRaw of [sku.supplier, sku.supplier2]) {
      if (!supplierRaw) continue;
      const ns = skuSearchNormalize(supplierRaw);
      for (const [aliasKey, names] of aliasBySupplier) {
        if (aliasKey && (ns.includes(aliasKey) || aliasKey.includes(ns))) out.push(...names);
      }
    }
    return out;
  }

  const qExact = skuSearchNormalize(q);
  const scored = [];
  for (const s of skus) {
    const corpus = skuSearchNormalize([s.code, s.name, s.supplier, s.supplier2, s.categoryName, ...manufacturersFor(s)].filter(Boolean).join(' '));
    // Fallback: also check the whitespace-squashed corpus, so a query word
    // typed without a space ("25קג") still matches a name that has one
    // ("25 ק"ג" -> normalized "25 קג").
    const corpusSquashed = corpus.replace(/\s+/g, '');
    if (!words.every(w => corpus.includes(w) || corpusSquashed.includes(w))) continue;
    const codeNorm = skuSearchNormalize(s.code);
    const nameNorm = skuSearchNormalize(s.name);
    let rank = 3;
    if (codeNorm === qExact) rank = 0;
    else if (codeNorm.startsWith(qExact) || nameNorm.startsWith(qExact)) rank = 1;
    else if (nameNorm.includes(qExact)) rank = 2;
    scored.push({ sku: s, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.sku.code.localeCompare(b.sku.code));

  res.json(scored.slice(0, 20).map(({ sku: s }) => ({
    skuId: s.id, code: s.code, name: s.name, kashrutBodyRef: s.kashrutBodyRef, categoryName: s.categoryName, itemType: s.itemType,
  })));
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

/* documents already linked to one SKU -- powers the "pick which document to
 * send" checklist in the raw-material send flow */
app.get('/api/skus/:id/docs', requireAssistant, ah(async (req, res) => {
  const sku = await prisma.sku.findUnique({ where: { code: req.params.id } });
  if (!sku) return res.status(404).json({ error: 'מקט לא נמצא' });
  const links = await prisma.skuLink.findMany({
    where: { skuId: sku.id, docType: 'DOCUMENT' }, include: { document: true }, orderBy: { createdAt: 'desc' },
  });
  res.json(links.filter(l => l.document).map(l => ({
    id: l.document.id, name: l.document.title, ext: l.document.docExt || '', doctype: l.document.docType || '',
    linkId: l.id, isRawMaterial: l.isRawMaterial, approvalStatus: l.approvalStatus,
  })));
}));

/* Weekly Priority goods-receipt report ("קבלת סחורה מספקים") -> keep the SKU
 * list in step with what actually arrives. Idempotent: brand-new מק"טים are
 * created (reviewedAt left null so they show up as never-reviewed); existing
 * ones only get EMPTY name/supplier filled in -- kashrut, pesach, type,
 * notes and anything edited by hand are never overwritten. */
app.post('/api/skus/import-report', requireAssistant, upload.single('file'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  const XLSX = require('xlsx');
  const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const header = (rows[0] || []).map(h => String(h || '').trim());
  const col = (...names) => header.findIndex(h => names.includes(h));
  const iCode = col("מק'ט", 'מק"ט', 'מקט');
  const iName = col('תאור מוצר', 'תיאור מוצר');
  const iSupplier = col('שם ספק');
  if (iCode < 0 || iName < 0) return res.status(400).json({ error: 'זה לא דוח קבלת סחורה (חסרות עמודות מק"ט / תאור מוצר)' });

  const seen = new Map(); // code -> { name, supplier }
  for (let i = 1; i < rows.length; i++) {
    const code = String(rows[i][iCode] ?? '').trim();
    if (!code || seen.has(code)) continue;
    seen.set(code, {
      name: String(rows[i][iName] ?? '').trim(),
      supplier: iSupplier >= 0 ? String(rows[i][iSupplier] ?? '').trim() : '',
    });
  }

  const existing = await prisma.sku.findMany({ where: { code: { in: [...seen.keys()] } } });
  const byCode = new Map(existing.map(s => [s.code, s]));
  const dry = req.query.dryRun === '1';
  const added = [], filled = [];
  for (const [code, info] of seen) {
    const sku = byCode.get(code);
    if (!sku) {
      if (!info.name) continue;
      if (!dry) await prisma.sku.create({ data: { code, name: info.name, supplier: info.supplier || null, origin: ['priority_report'] } });
      added.push({ id: code, name: info.name });
    } else {
      const upd = {};
      if (!sku.name && info.name) upd.name = info.name;
      if (!sku.supplier && info.supplier) upd.supplier = info.supplier;
      if (Object.keys(upd).length) { if (!dry) await prisma.sku.update({ where: { id: sku.id }, data: upd }); filled.push(code); }
    }
  }
  res.json({ ok: true, dryRun: dry, rowsInReport: seen.size, added: added.length, filledExisting: filled.length, newSkus: added });
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
  const docs = await prisma.document.findMany({ where: { ...(admin ? {} : { hidden: false }), trashedAt: null } });
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
  const docs = await prisma.document.findMany({ where: { ...(admin ? {} : { hidden: false }), trashedAt: null } });
  const map = {};
  docs.forEach(d => (d.tags||[]).forEach(t => { map[t] = (map[t]||0)+1; }));
  res.json(Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([tag,count])=>({ tag, count })));
}));

/* ── DOCTYPES ── */
app.get('/api/doctypes', ah(async (req, res) => {
  const admin = isAdminReq(req);
  const docs = await prisma.document.findMany({ where: { ...(admin ? {} : { hidden: false }), trashedAt: null } });
  const map = {};
  docs.forEach(d => { if (d.docType) map[d.docType] = (map[d.docType]||0)+1; });
  res.json(Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([doctype,count])=>({ doctype, count })));
}));

/* ── GET DOCS ── */
app.get('/api/docs', ah(async (req, res) => {
  const { q, tag, doctype, sort = 'date-desc', unlinked } = req.query;
  const admin = isAdminReq(req);
  const where = { trashedAt: null };
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

/* ── Dashboard preview-panel fix: archive / trash (soft delete) / restore ── */
app.post('/api/docs/:id/archive', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
  const updated = await prisma.document.update({ where: { id }, data: { archived: true, archivedReason: req.body.reason || null } });
  res.json(docOut(updated, await batchDocContext([updated.id])));
}));

// Soft delete only -- never removes the file or the DB row. Excluded from
// the main lists/counts (see trashedAt: null filters below); visible only
// in GET /api/docs/trash, restorable via /restore.
app.post('/api/docs/:id/trash', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
  const updated = await prisma.document.update({ where: { id }, data: { trashedAt: new Date() } });
  res.json(docOut(updated, await batchDocContext([updated.id])));
}));

app.get('/api/docs/trash', requireAuth, requireAdmin, ah(async (req, res) => {
  const docs = await prisma.document.findMany({ where: { trashedAt: { not: null } }, orderBy: { trashedAt: 'desc' } });
  const ctx = await batchDocContext(docs.map(d => d.id));
  res.json(docs.map(d => docOut(d, ctx)));
}));

app.post('/api/docs/:id/restore', requireAuth, requireAdmin, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return res.status(404).json({ error: 'מסמך לא נמצא' });
  const updated = await prisma.document.update({ where: { id }, data: { trashedAt: null } });
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
  const { approvalStatus, kashrutLevel, isRawMaterial } = req.body;
  if (approvalStatus !== undefined && !['PENDING','APPROVED','REJECTED'].includes(approvalStatus))
    return res.status(400).json({ error: 'סטטוס לא תקין' });
  const updates = { reviewedById: req.user.id || null, reviewedAt: new Date() };
  if (approvalStatus !== undefined) updates.approvalStatus = approvalStatus;
  if (kashrutLevel   !== undefined) updates.kashrutLevel   = kashrutLevel;
  if (isRawMaterial  !== undefined) updates.isRawMaterial  = !!isRawMaterial;
  const updated = await prisma.skuLink.update({
    where: { id }, data: updates, include: { sku: true, document: true },
  });
  res.json(rawMaterialOut(updated));
}));

/* ── send a raw-material label by email, recipient chosen per-send (no fixed
 * contact list). Attachments can be a mix of: (a) other documents already
 * linked to the same SKU (picked by id, e.g. an existing kashrut cert), and
 * (b) files uploaded ad-hoc from outside the system for this one send --
 * those are attached directly from memory and never saved to R2/the DB. ── */
app.post('/api/sku-links/:id/send-email', requireAssistant, upload.array('files', 10), ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const { to, message } = req.body;
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'כתובת מייל לא תקינה' });
  const mailer = getMailer();
  if (!mailer) return res.status(400).json({ error: 'שליחת מייל לא הוגדרה בשרת (חסר EMAIL_APP_PASSWORD)' });
  const link = await prisma.skuLink.findUnique({ where: { id }, include: { sku: true, document: true } });
  if (!link || !link.sku || !link.document) return res.status(404).json({ error: 'רשומה לא נמצאה' });

  const docIds = req.body.docIds ? JSON.parse(req.body.docIds).map(Number) : [];
  const extraFiles = req.files || [];
  if (!docIds.length && !extraFiles.length) return res.status(400).json({ error: 'נא לבחור לפחות מסמך אחד לצירוף' });

  const docsToAttach = docIds.length
    ? await prisma.document.findMany({ where: { id: { in: docIds } } })
    : [];
  const attachments = await Promise.all(docsToAttach.map(async (d) => {
    const { stream, contentType } = await getObjectStream(d.fileUrl);
    const ext = d.docExt ? '.' + d.docExt : '';
    return { filename: (d.title || 'מסמך') + ext, content: stream, contentType };
  }));
  for (const f of extraFiles) {
    attachments.push({ filename: f.originalname, content: f.buffer, contentType: f.mimetype });
  }

  const defaultBody = `שלום,\n\nמצורפים מסמכים עבור מק"ט ${link.sku.code} - ${link.sku.name}.\n${link.kashrutLevel ? 'רמת כשרות: ' + link.kashrutLevel + '\n' : ''}\nבברכה,\nאחים כהן`;
  await mailer.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject: `אישור כשרות - מק"ט ${link.sku.code} - ${link.sku.name}`,
    text: message || defaultBody,
    attachments,
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

/* ══════════════════════════════════════════════════════════════════════
 * RAW-MATERIAL REGISTRY (Phase 3, per docrepo-raw-materials-spec.md)
 * The new RawMaterial/RawMaterialDocument/RawMaterialApproval/KashrutBody
 * model from Phase 1+2. This is additive and separate from the legacy
 * SkuLink-based "ניהול אישור חמרי גלם" screen above (isRawMaterial/
 * approvalStatus/kashrutLevel on SkuLink) -- that keeps working unchanged
 * until a future screen replaces it.
 *
 * Route naming note: the bare collection path here is
 * /api/raw-material-registry, NOT /api/raw-materials -- that path is
 * already taken by the legacy GET /api/raw-materials above (SkuLink list),
 * and Express would never reach a second handler on the same path+method.
 * The spec's literal sub-paths (/api/raw-materials/:id/approvals etc.,
 * /api/approvals/:id, /api/skus/:id/raw-materials, /api/export/raw-materials)
 * don't collide since they're different path shapes, so those are kept
 * exactly as written in the spec.
 * ══════════════════════════════════════════════════════════════════════ */

// Same alias table used by the one-time Phase 2 migration
// (prisma/migrate-raw-materials-run.js) -- kept in sync here so newly
// created raw materials resolve a SKU's כשרות free-text the same way.
const KASHRUT_BODY_ALIASES = {
  'עדה חרדית': 'בד"ץ העדה החרדית',
  'רבנות': 'הרבנות הראשית',
  'לנדא': 'הרב לנדא',
  'הרב לנדא ב"ב': 'הרב לנדא',
  'חתם סופר': 'חתם סופר ב"ב',
  'קהילות': 'בד"ץ קהילות',
};
function resolveKashrutBodyName(ref) {
  const r = (ref || '').trim();
  if (!r) return null;
  return KASHRUT_BODY_ALIASES[r] || r;
}

function kashrutBodyOut(b) {
  return {
    id: b.id, name: b.name, shortName: b.shortName || '', active: b.active,
    handlesPassover: b.handlesPassover, sortOrder: b.sortOrder,
  };
}

function regDocOut(rd) {
  return {
    id: rd.id, docId: rd.documentId, title: rd.document.title,
    ext: rd.document.docExt || '', docRole: rd.docRole, uploadedAt: rd.uploadedAt,
  };
}

// Two-track revision (3.11.2026, docrepo-phase4-v2-tracks.md): status is now
// per (rawMaterial, kashrutBody, track). passoverStatus/passoverYear/
// passoverNote are deprecated -- no longer read or written here.
function regApprovalOut(a) {
  return {
    id: a.id, rawMaterialId: a.rawMaterialId,
    kashrutBodyId: a.kashrutBodyId, kashrutBodyName: a.kashrutBody ? a.kashrutBody.name : null,
    handlesPassover: a.kashrutBody ? a.kashrutBody.handlesPassover : false,
    track: a.track, seasonYear: a.seasonYear || '',
    contactId: a.contactId, contactName: a.contact ? a.contact.name : null,
    status: a.status, kashrutLevel: a.kashrutLevel || '',
    sentAt: a.sentAt, sentVia: a.sentVia, sentDocIds: a.sentDocIds || [],
    replyAt: a.replyAt, replyDocId: a.replyDocId,
    conditionText: a.conditionText || '', validUntil: a.validUntil,
    approvalSource: a.approvalSource, approvalSourceDetail: a.approvalSourceDetail || '',
    notes: a.notes || '', createdAt: a.createdAt, updatedAt: a.updatedAt, viaOrigin: false,
  };
}

function regNotSentPlaceholder(rawMaterialId, body, track) {
  return {
    id: null, rawMaterialId, kashrutBodyId: body.id, kashrutBodyName: body.name,
    handlesPassover: body.handlesPassover, track, seasonYear: '',
    contactId: null, contactName: null, status: 'NOT_SENT', kashrutLevel: '',
    sentAt: null, sentVia: null, sentDocIds: [], replyAt: null, replyDocId: null,
    conditionText: '', validUntil: null, approvalSource: null, approvalSourceDetail: '',
    notes: '', createdAt: null, updatedAt: null, viaOrigin: false,
  };
}

// R1 follow-up (3.11.2026): a body that's the raw material's origin kashrut
// body is shown as already approved -- computed here, never written to the
// DB, and only ever used in place of a NOT_SENT placeholder (a real
// approval row, whatever its status, always wins over this).
function regComputedOriginApproval(rawMaterialId, body, track, status) {
  return {
    id: null, rawMaterialId, kashrutBodyId: body.id, kashrutBodyName: body.name,
    handlesPassover: body.handlesPassover, track, seasonYear: '',
    contactId: null, contactName: null, status, kashrutLevel: '',
    sentAt: null, sentVia: null, sentDocIds: [], replyAt: null, replyDocId: null,
    conditionText: '', validUntil: null, approvalSource: null, approvalSourceDetail: '',
    notes: '', createdAt: null, updatedAt: null, viaOrigin: true,
  };
}

const VALID_APPROVAL_SOURCE = ['PHONE', 'EMAIL', 'WHATSAPP', 'LETTER', 'PREVIOUS_YEAR', 'BODY_LIST', 'OTHER'];

// status values valid for a given track (R1: CONDITIONAL only YEAR_ROUND,
// APPROVED_KITNIYOT only PASSOVER; everything else applies to both)
const APPROVAL_STATUS_COMMON = ['NOT_SENT', 'SENT_PENDING', 'APPROVED', 'REJECTED', 'NEEDS_INFO', 'SENT_FOR_REVIEW'];
function isValidStatusForTrack(status, track) {
  if (APPROVAL_STATUS_COMMON.includes(status)) return true;
  if (status === 'CONDITIONAL') return track === 'YEAR_ROUND';
  if (status === 'APPROVED_KITNIYOT') return track === 'PASSOVER';
  return false;
}

function regMaterialOut(rm, extra) {
  const { documents = [], approvals = [], skus = [] } = extra || {};
  return {
    id: rm.id, name: rm.name, supplier: rm.supplier || '', manufacturer: rm.manufacturer || '',
    defaultDocId: rm.defaultDocId, notes: rm.notes || '',
    originKashrutText: rm.originKashrutText || '',
    originKashrutBodyId: rm.originKashrutBodyId,
    originKashrutBodyName: rm.originKashrutBody ? rm.originKashrutBody.name : null,
    originCertDocId: rm.originCertDocId, originCertValidUntil: rm.originCertValidUntil,
    originHasCert: rm.originHasCert,
    originPassoverStatus: rm.originPassoverStatus, originPassoverText: rm.originPassoverText || '',
    originPassoverCertDocId: rm.originPassoverCertDocId, originPassoverValidUntil: rm.originPassoverValidUntil,
    supplierItemCode: rm.supplierItemCode || '', importId: rm.importId,
    archived: rm.archived, archivedReason: rm.archivedReason || '',
    allergens: rm.allergens || '',
    createdAt: rm.createdAt, updatedAt: rm.updatedAt,
    documents: documents.map(regDocOut),
    approvals: approvals.map(regApprovalOut),
    skus: skus.map(s => ({ id: s.sku.code, name: s.sku.name })),
  };
}

const REG_INCLUDE = {
  documents: { include: { document: true } },
  approvals: { include: { kashrutBody: true, contact: true } },
  skus: { include: { sku: true } },
  originKashrutBody: true,
};

/* ── list / CRUD ── */
app.get('/api/raw-material-registry', requireAssistant, ah(async (req, res) => {
  const { q, supplier, kashrutBodyId, status, includeArchived } = req.query;
  const where = {};
  if (!(includeArchived === '1' || includeArchived === 'true')) where.archived = false;
  if (q) where.name = { contains: q, mode: 'insensitive' };
  if (supplier) where.supplier = { contains: supplier, mode: 'insensitive' };
  let items = await prisma.rawMaterial.findMany({ where, include: REG_INCLUDE, orderBy: { createdAt: 'desc' } });
  if (kashrutBodyId) items = items.filter(r => r.approvals.some(a => a.kashrutBodyId === parseInt(kashrutBodyId)));
  if (status) items = items.filter(r => r.approvals.some(a => a.status === status));
  res.json(items.map(r => regMaterialOut(r, r)));
}));

app.post('/api/raw-material-registry', requireAssistant, ah(async (req, res) => {
  const { name, supplier, manufacturer, notes, originKashrutText, allergens } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'נא להזין שם' });
  const rm = await prisma.rawMaterial.create({
    data: {
      name: name.trim(), supplier: supplier || null, manufacturer: manufacturer || null, notes: notes || null,
      // R7: the user may already have confirmed these from "🤖 זהה מהתווית"
      // before the first save, so the add-material flow can set them in
      // the same call instead of a separate PATCH.
      originKashrutText: originKashrutText || null, allergens: allergens || null,
    },
  });
  res.status(201).json(regMaterialOut(rm));
}));

/* ── R7: "🤖 זהה מהתווית" -- suggests name/manufacturer/supplier/origin
 * hechsher text/allergens from a label photo. Returns suggestions only;
 * never writes anything -- every field must be confirmed (and is freely
 * editable) by the user before the actual save. Unlike the older
 * /api/identify, this picks the real media_type from the file extension
 * instead of hardcoding application/pdf, since labels are usually photos. ── */
app.post('/api/raw-material-registry/identify-label', requireAssistant, upload.single('file'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY לא מוגדר' });
  const ext = path.extname(req.file.originalname).replace('.', '').toLowerCase();
  const mediaTypeByExt = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  const mediaType = mediaTypeByExt[ext];
  if (!mediaType) return res.status(400).json({ error: 'סוג קובץ לא נתמך לזיהוי (jpg/png/webp/gif/pdf)' });
  try {
    const fileData = req.file.buffer.toString('base64');
    const prompt = `אתה מסייע לזיהוי תוויות של חומרי גלם לחברת מזון ישראלית.
קרא את התווית המצורפת וענה בדיוק בפורמט JSON הבא, ללא הסברים נוספים:
{
  "name": "שם המוצר כפי שמופיע על התווית, או null",
  "manufacturer": "שם היצרן כפי שמופיע על התווית, או null",
  "supplier": "שם הספק אם מופיע בנפרד מהיצרן, או null",
  "originKashrutText": "סימון הכשרות כפי שמופיע על התווית (למשל OU, OK, בד\\"ץ עדה חרדית), או null",
  "allergens": "רשימת האלרגנים כפי שמופיעה על התווית (למשל: מכיל גלוטן, אגוזים, חלב), או null"
}
אם שדה לא מופיע או לא ניתן לקרוא אותו בבירור -- החזר null עבורו, אל תמציא.`;
    const contentBlock = ext === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: fileData } }
      : { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileData } };
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 512,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: prompt }] }],
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'שגיאת API');
    const text = data.content[0].text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(text);
    res.json({
      name: result.name || null, manufacturer: result.manufacturer || null, supplier: result.supplier || null,
      originKashrutText: result.originKashrutText || null, allergens: result.allergens || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

app.get('/api/raw-material-registry/:id', requireAssistant, ah(async (req, res) => {
  const rm = await prisma.rawMaterial.findUnique({ where: { id: parseInt(req.params.id) }, include: REG_INCLUDE });
  if (!rm) return res.status(404).json({ error: 'חומר גלם לא נמצא' });
  res.json(regMaterialOut(rm, rm));
}));

app.patch('/api/raw-material-registry/:id', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const {
    name, supplier, manufacturer, notes, defaultDocId, allergens,
    originKashrutText, originKashrutBodyId, originCertDocId, originCertValidUntil, originHasCert,
    originPassoverStatus, originPassoverText, originPassoverCertDocId, originPassoverValidUntil,
  } = req.body;
  if (originPassoverStatus !== undefined && !['UNKNOWN', 'PASSOVER', 'PASSOVER_KITNIYOT', 'NOT_PASSOVER'].includes(originPassoverStatus))
    return res.status(400).json({ error: 'סטטוס פסח במקור לא תקין' });

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (supplier !== undefined) updates.supplier = supplier || null;
  if (manufacturer !== undefined) updates.manufacturer = manufacturer || null;
  if (notes !== undefined) updates.notes = notes || null;
  if (allergens !== undefined) updates.allergens = allergens || null;
  if (defaultDocId !== undefined) updates.defaultDocId = defaultDocId ? parseInt(defaultDocId) : null;
  // כשרות המקור -- ימות השנה
  if (originKashrutText !== undefined) updates.originKashrutText = originKashrutText || null;
  if (originKashrutBodyId !== undefined) updates.originKashrutBodyId = originKashrutBodyId ? parseInt(originKashrutBodyId) : null;
  if (originCertDocId !== undefined) updates.originCertDocId = originCertDocId ? parseInt(originCertDocId) : null;
  if (originCertValidUntil !== undefined) updates.originCertValidUntil = originCertValidUntil ? new Date(originCertValidUntil) : null;
  if (originHasCert !== undefined) updates.originHasCert = !!originHasCert;
  // כשרות המקור -- פסח
  if (originPassoverStatus !== undefined) updates.originPassoverStatus = originPassoverStatus;
  if (originPassoverText !== undefined) updates.originPassoverText = originPassoverText || null;
  if (originPassoverCertDocId !== undefined) updates.originPassoverCertDocId = originPassoverCertDocId ? parseInt(originPassoverCertDocId) : null;
  if (originPassoverValidUntil !== undefined) updates.originPassoverValidUntil = originPassoverValidUntil ? new Date(originPassoverValidUntil) : null;

  const rm = await prisma.rawMaterial.update({ where: { id }, data: updates, include: REG_INCLUDE }).catch(() => null);
  if (!rm) return res.status(404).json({ error: 'חומר גלם לא נמצא' });
  res.json(regMaterialOut(rm, rm));
}));

/* ── archive / restore (added 10.11.2026, additive, same pattern as
 * Document.archived/archivedReason from L0). Never deletes anything. ── */
app.post('/api/raw-material-registry/:id/archive', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const rm = await prisma.rawMaterial.findUnique({ where: { id } });
  if (!rm) return res.status(404).json({ error: 'חומר גלם לא נמצא' });
  const updated = await prisma.rawMaterial.update({
    where: { id }, data: { archived: true, archivedReason: req.body.reason || null }, include: REG_INCLUDE,
  });
  res.json(regMaterialOut(updated, updated));
}));

app.post('/api/raw-material-registry/:id/restore', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const rm = await prisma.rawMaterial.findUnique({ where: { id } });
  if (!rm) return res.status(404).json({ error: 'חומר גלם לא נמצא' });
  const updated = await prisma.rawMaterial.update({
    where: { id }, data: { archived: false, archivedReason: null }, include: REG_INCLUDE,
  });
  res.json(regMaterialOut(updated, updated));
}));

app.delete('/api/raw-material-registry/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const rm = await prisma.rawMaterial.findUnique({ where: { id } });
  if (!rm) return res.status(404).json({ error: 'חומר גלם לא נמצא' });
  await prisma.$transaction([
    prisma.rawMaterialApprovalEvent.deleteMany({ where: { approval: { rawMaterialId: id } } }),
    prisma.rawMaterialApproval.deleteMany({ where: { rawMaterialId: id } }),
    prisma.rawMaterialDocument.deleteMany({ where: { rawMaterialId: id } }),
    prisma.skuRawMaterial.deleteMany({ where: { rawMaterialId: id } }),
    prisma.rawMaterial.delete({ where: { id } }),
  ]);
  res.json({ ok: true });
  // note: same convention as DELETE /api/docs/:id -- R2 objects are not reaped here
}));

/* ── R11: Excel/CSV import of raw materials ──
 * requireAuth (not requireAssistant) on every route here -- per spec "not
 * available for the assistant role", and requireAuth's plain-JWT check
 * naturally excludes the x-assistant-code pseudo-auth that requireAssistant
 * also accepts. Demo mode is gated client-side only (rmIsReadOnly()), same
 * as every other write affordance on this screen. */

// Ordered so a more specific header ("קוד ספק"/"מק"ט ספק") is claimed before
// the generic skuCodes keyword ("מק"ט") would otherwise greedily match it.
const REG_IMPORT_FIELD_KEYWORDS = {
  name: ['שם', 'תיאור', 'name', 'description', 'item name'],
  supplier: ['ספק', 'supplier', 'vendor'],
  manufacturer: ['יצרן', 'manufacturer', 'maker'],
  originKashrutText: ['כשרות מקור', 'כשרות', 'הכשר', 'hechsher', 'kashrut', 'kosher'],
  supplierItemCode: ['קוד ספק', 'מקט ספק', 'קוד פריט ספק', 'supplier item code', 'vendor code', 'vendor item'],
  skuCodes: ['מקט', 'מקטים', 'sku', 'skus', 'item code', 'קוד פריט'],
  notes: ['הערות', 'הערה', 'notes', 'note', 'remark'],
};
function regImportNormalizeHeader(s) {
  return (s || '').toString().trim().toLowerCase().replace(/["'״׳]/g, '');
}
function guessRegImportColumnMapping(headers) {
  const mapping = {};
  const used = new Set();
  const normHeaders = headers.map(regImportNormalizeHeader);
  for (const [field, keywords] of Object.entries(REG_IMPORT_FIELD_KEYWORDS)) {
    let best = null;
    for (let i = 0; i < normHeaders.length; i++) {
      if (!normHeaders[i] || used.has(i)) continue;
      if (keywords.some(k => normHeaders[i].includes(regImportNormalizeHeader(k)))) { best = i; break; }
    }
    if (best != null) { mapping[field] = best; used.add(best); }
  }
  return mapping;
}

function regImportCellToString(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(rt => rt.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result); // formula cell
  }
  return String(v);
}

async function parseRegImportFile(buffer, ext) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  let ws;
  if (ext === 'csv') {
    const { Readable } = require('stream');
    let text = buffer.toString('utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    ws = await wb.csv.read(Readable.from([text]));
  } else {
    await wb.xlsx.load(buffer);
    ws = wb.worksheets[0];
  }
  const allRows = [];
  ws.eachRow((row) => {
    allRows.push(row.values.slice(1).map(v => regImportCellToString(v).trim()));
  });
  const width = allRows.reduce((m, r) => Math.max(m, r.length), 0);
  for (const r of allRows) while (r.length < width) r.push('');
  const headers = allRows[0] || [];
  const rows = allRows.slice(1).filter(r => r.some(c => c !== ''));
  return { headers, rows };
}

function regImportNormalizeText(s) { return (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' '); }

// Shared by preview and commit so classification can never drift between
// what the user reviewed and what actually gets written.
async function classifyRegImportRows(rows, mapping, includeExistingApprovals) {
  const get = (row, field) => (mapping[field] != null ? (row[mapping[field]] || '').toString().trim() : '');
  const parsedRows = rows.map(row => ({
    name: get(row, 'name'), supplier: get(row, 'supplier'), manufacturer: get(row, 'manufacturer'),
    originKashrutText: get(row, 'originKashrutText'), notes: get(row, 'notes'),
    supplierItemCode: get(row, 'supplierItemCode'),
    skuCodes: get(row, 'skuCodes').split(',').map(c => c.trim()).filter(Boolean),
  }));

  const allCodes = new Set(parsedRows.flatMap(r => r.skuCodes));
  const foundSkus = allCodes.size ? await prisma.sku.findMany({ where: { code: { in: [...allCodes] } }, select: { code: true } }) : [];
  const foundCodeSet = new Set(foundSkus.map(s => s.code));

  const supplierItemCodes = parsedRows.map(r => r.supplierItemCode).filter(Boolean);
  const existingByItemCode = supplierItemCodes.length
    ? await prisma.rawMaterial.findMany({ where: { supplierItemCode: { in: supplierItemCodes } } }) : [];
  const existingByItemCodeMap = new Map(existingByItemCode.map(e => [e.supplierItemCode, e]));
  const allExisting = await prisma.rawMaterial.findMany();
  const existingByNameSupplier = new Map(
    allExisting.map(e => [regImportNormalizeText(e.name) + '|' + regImportNormalizeText(e.supplier), e])
  );

  const classified = parsedRows.map((r, i) => {
    const unknownCodes = r.skuCodes.filter(c => !foundCodeSet.has(c));
    let classification, matchedExistingId = null, reason = '';
    if (!r.name) { classification = 'ERROR'; reason = 'שם חסר'; }
    else if (unknownCodes.length) { classification = 'ERROR'; reason = 'מק"ט לא ידוע: ' + unknownCodes.join(', '); }
    else {
      const byCode = r.supplierItemCode ? existingByItemCodeMap.get(r.supplierItemCode) : null;
      const byNameSupplier = existingByNameSupplier.get(regImportNormalizeText(r.name) + '|' + regImportNormalizeText(r.supplier));
      const existing = byCode || byNameSupplier;
      if (existing) {
        classification = 'EXISTING'; matchedExistingId = existing.id;
        reason = byCode ? 'התאמה לפי קוד ספק' : 'התאמה לפי שם וספק';
      } else classification = 'NEW';
    }
    return { rowIndex: i, ...r, classification, matchedExistingId, reason };
  });

  // Attach the matched existing record's current approval matrix (R11
  // preview follow-up, 10.11.2026) -- lets the preview show/filter by
  // kashrut body/track/status for קיים rows, to help decide whether to
  // tick them for the fill-empty option. Blank for חדש/שגיאה rows.
  if (includeExistingApprovals) {
    const matchedIds = [...new Set(classified.filter(r => r.matchedExistingId != null).map(r => r.matchedExistingId))];
    if (matchedIds.length) {
      const [bodies, matchedRecords, approvals] = await Promise.all([
        prisma.kashrutBody.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
        prisma.rawMaterial.findMany({ where: { id: { in: matchedIds } } }),
        prisma.rawMaterialApproval.findMany({ where: { rawMaterialId: { in: matchedIds } }, include: { kashrutBody: true, contact: true } }),
      ]);
      const recordsById = new Map(matchedRecords.map(m => [m.id, m]));
      const approvalsByRm = new Map();
      for (const a of approvals) {
        if (!approvalsByRm.has(a.rawMaterialId)) approvalsByRm.set(a.rawMaterialId, []);
        approvalsByRm.get(a.rawMaterialId).push(a);
      }
      for (const r of classified) {
        if (r.matchedExistingId == null) { r.existingApprovals = []; continue; }
        const rm = recordsById.get(r.matchedExistingId);
        r.existingApprovals = rm ? buildApprovalMatrixRows(rm, bodies, approvalsByRm.get(rm.id) || []) : [];
      }
    } else {
      for (const r of classified) r.existingApprovals = [];
    }
  }

  return classified;
}

app.post('/api/raw-material-registry/import/parse', requireAuth, upload.single('file'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  const ext = path.extname(req.file.originalname).replace('.', '').toLowerCase();
  if (!['xlsx', 'csv'].includes(ext)) return res.status(400).json({ error: 'יש להעלות קובץ xlsx או csv' });
  const { headers, rows } = await parseRegImportFile(req.file.buffer, ext);
  if (!rows.length) return res.status(400).json({ error: 'הקובץ ריק' });
  res.json({ headers, rows, mapping: guessRegImportColumnMapping(headers) });
}));

app.post('/api/raw-material-registry/import/preview', requireAuth, ah(async (req, res) => {
  const { rows, mapping } = req.body || {};
  if (!Array.isArray(rows) || !mapping) return res.status(400).json({ error: 'חסרים rows/mapping' });
  const classified = await classifyRegImportRows(rows, mapping, true);
  res.json({
    rows: classified,
    counts: {
      NEW: classified.filter(r => r.classification === 'NEW').length,
      EXISTING: classified.filter(r => r.classification === 'EXISTING').length,
      ERROR: classified.filter(r => r.classification === 'ERROR').length,
    },
  });
}));

app.post('/api/raw-material-registry/import/commit', requireAuth, upload.single('file'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  let rows, mapping, selectedIndexes;
  try {
    rows = JSON.parse(req.body.rows);
    mapping = JSON.parse(req.body.mapping);
    selectedIndexes = new Set(JSON.parse(req.body.selectedIndexes).map(Number));
  } catch (e) { return res.status(400).json({ error: 'נתונים לא תקינים' }); }
  const fillEmptyOnExisting = req.body.fillEmptyOnExisting === '1' || req.body.fillEmptyOnExisting === 'true';

  const classified = await classifyRegImportRows(rows, mapping);

  const ext = path.extname(req.file.originalname).replace('.', '').toLowerCase();
  const key = r2KeyFor(req.file.originalname);
  await uploadBuffer(req.file.buffer, key, req.file.mimetype);
  const fileDoc = await prisma.document.create({
    data: {
      title: req.file.originalname.replace(/\.[^.]+$/, ''),
      docType: 'אחר', docExt: ext, sizeBytes: req.file.size,
      fileUrl: key, hidden: true, uploadedById: req.user.id || null,
    },
  });
  const importBatch = await prisma.rawMaterialImport.create({
    data: { fileDocId: fileDoc.id, byUserId: req.user.id || null },
  });

  let rowsCreated = 0, rowsSkipped = 0;
  for (const r of classified) {
    if (!selectedIndexes.has(r.rowIndex)) { rowsSkipped++; continue; }
    if (r.classification === 'ERROR') { rowsSkipped++; continue; }
    if (r.classification === 'EXISTING') {
      if (fillEmptyOnExisting) {
        const existing = await prisma.rawMaterial.findUnique({ where: { id: r.matchedExistingId } });
        if (existing) {
          const fillUpdates = {};
          if (!existing.supplier && r.supplier) fillUpdates.supplier = r.supplier;
          if (!existing.manufacturer && r.manufacturer) fillUpdates.manufacturer = r.manufacturer;
          if (!existing.originKashrutText && r.originKashrutText) fillUpdates.originKashrutText = r.originKashrutText;
          if (!existing.notes && r.notes) fillUpdates.notes = r.notes;
          if (!existing.supplierItemCode && r.supplierItemCode) fillUpdates.supplierItemCode = r.supplierItemCode;
          if (Object.keys(fillUpdates).length) await prisma.rawMaterial.update({ where: { id: existing.id }, data: fillUpdates });
        }
      }
      rowsSkipped++; // never created as a new row, whether or not fields were filled
      continue;
    }
    // NEW
    const created = await prisma.rawMaterial.create({
      data: {
        name: r.name, supplier: r.supplier || null, manufacturer: r.manufacturer || null,
        notes: r.notes || null, originKashrutText: r.originKashrutText || null,
        supplierItemCode: r.supplierItemCode || null, importId: importBatch.id,
      },
    });
    if (r.skuCodes.length) {
      const skus = await prisma.sku.findMany({ where: { code: { in: r.skuCodes } } });
      for (const sku of skus) {
        await prisma.skuRawMaterial.create({ data: { rawMaterialId: created.id, skuId: sku.id } }).catch(() => {});
      }
    }
    rowsCreated++;
  }

  await prisma.rawMaterialImport.update({ where: { id: importBatch.id }, data: { rowsCreated, rowsSkipped } });
  res.json({ ok: true, importId: importBatch.id, rowsCreated, rowsSkipped });
}));

/* ── documents: upload a new file or link an existing Document, with a role ── */
app.post('/api/raw-material-registry/:id/documents', requireAssistant, upload.single('file'), ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const rm = await prisma.rawMaterial.findUnique({ where: { id } });
  if (!rm) return res.status(404).json({ error: 'חומר גלם לא נמצא' });
  const docRole = (req.body.docRole || 'OTHER').toUpperCase();
  if (!['LABEL', 'BACK_LABEL', 'ANALYSIS', 'CERT', 'SPEC', 'OTHER'].includes(docRole))
    return res.status(400).json({ error: 'תפקיד מסמך לא תקין' });

  let documentId;
  if (req.file) {
    const ext = path.extname(req.file.originalname).replace('.', '').toLowerCase();
    const key = r2KeyFor(req.file.originalname);
    await uploadBuffer(req.file.buffer, key, req.file.mimetype);
    const doc = await prisma.document.create({
      data: {
        title: req.body.name || req.file.originalname.replace(/\.[^.]+$/, ''),
        docType: 'תויות', docExt: ext, sizeBytes: req.file.size,
        fileUrl: key, hidden: true, uploadedById: req.user.id || null,
      },
    });
    documentId = doc.id;
  } else if (req.body.docId) {
    const existing = await prisma.document.findUnique({ where: { id: parseInt(req.body.docId) } });
    if (!existing) return res.status(404).json({ error: 'מסמך לא נמצא' });
    documentId = existing.id;
  } else {
    return res.status(400).json({ error: 'נא לצרף קובץ או לבחור מסמך קיים' });
  }

  const rmd = await prisma.rawMaterialDocument.create({
    data: { rawMaterialId: id, documentId, docRole }, include: { document: true },
  });
  res.status(201).json(regDocOut(rmd));
}));

/* ── get-or-create an approval row for (kashrutBodyId, track) without
 * sending anything. Added 3.11.2026: a status can now be set directly from
 * NOT_SENT (e.g. a phone call that was never preceded by a /send) -- but
 * NOT_SENT only ever existed as a synthesized matrix placeholder (id=null)
 * until now, since /send's upsert always created rows as SENT_PENDING.
 * This gives the caller a real id to PATCH. ── */
app.post('/api/raw-material-registry/:id/approvals', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const rm = await prisma.rawMaterial.findUnique({ where: { id } });
  if (!rm) return res.status(404).json({ error: 'חומר גלם לא נמצא' });
  const { kashrutBodyId } = req.body;
  if (!kashrutBodyId) return res.status(400).json({ error: 'נא לבחור גוף כשרות' });
  const track = req.body.track || 'YEAR_ROUND';
  if (!['YEAR_ROUND', 'PASSOVER'].includes(track)) return res.status(400).json({ error: 'מסלול לא תקין' });
  const body = await prisma.kashrutBody.findUnique({ where: { id: parseInt(kashrutBodyId) } });
  if (!body) return res.status(404).json({ error: 'גוף כשרות לא נמצא' });
  const approval = await prisma.rawMaterialApproval.upsert({
    where: { rawMaterialId_kashrutBodyId_track: { rawMaterialId: id, kashrutBodyId: body.id, track } },
    create: { rawMaterialId: id, kashrutBodyId: body.id, track },
    update: {},
    include: { kashrutBody: true, contact: true },
  });
  res.status(201).json(regApprovalOut(approval));
}));

/* ── approvals matrix: every active kashrut body, NOT_SENT ones included ── */
// Two-track revision: one row per active body for YEAR_ROUND, plus one row
// per handlesPassover body for PASSOVER -- including NOT_SENT placeholders
// for either. Also surfaces any PASSOVER row that exists for a body that
// isn't (or is no longer) handlesPassover/active, so real data is never
// hidden even if a body's flags changed after the row was created.
// Extracted as a shared, pure function (R10, added 10.11.2026) so the
// Excel export computes each raw material's per-body status with EXACTLY
// the same logic as this live matrix endpoint -- no drift between what's
// on screen and what's exported.
function buildApprovalMatrixRows(rm, bodies, approvals) {
  const byKey = new Map(approvals.map(a => [`${a.kashrutBodyId}|${a.track}`, a]));
  const rows = [];
  for (const b of bodies) {
    const yr = byKey.get(`${b.id}|YEAR_ROUND`);
    if (yr) rows.push(regApprovalOut(yr));
    else if (rm.originKashrutBodyId === b.id) rows.push(regComputedOriginApproval(rm.id, b, 'YEAR_ROUND', 'APPROVED'));
    else rows.push(regNotSentPlaceholder(rm.id, b, 'YEAR_ROUND'));

    if (b.handlesPassover) {
      const ps = byKey.get(`${b.id}|PASSOVER`);
      if (ps) rows.push(regApprovalOut(ps));
      else if (rm.originKashrutBodyId === b.id && ['PASSOVER', 'PASSOVER_KITNIYOT'].includes(rm.originPassoverStatus))
        rows.push(regComputedOriginApproval(rm.id, b, 'PASSOVER', rm.originPassoverStatus === 'PASSOVER' ? 'APPROVED' : 'APPROVED_KITNIYOT'));
      else rows.push(regNotSentPlaceholder(rm.id, b, 'PASSOVER'));
    }
  }
  const shownIds = new Set(rows.map(r => r.id).filter(idv => idv != null));
  for (const a of approvals) {
    if (a.track === 'PASSOVER' && !shownIds.has(a.id)) rows.push(regApprovalOut(a));
  }
  return rows;
}

app.get('/api/raw-materials/:id/approvals', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const rm = await prisma.rawMaterial.findUnique({ where: { id } });
  if (!rm) return res.status(404).json({ error: 'חומר גלם לא נמצא' });
  const [bodies, approvals] = await Promise.all([
    prisma.kashrutBody.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.rawMaterialApproval.findMany({ where: { rawMaterialId: id }, include: { kashrutBody: true, contact: true } }),
  ]);
  const rows = buildApprovalMatrixRows(rm, bodies, approvals);
  res.json(rows);
}));

/* ── R10: Excel export of the (currently filtered) raw-material registry ── */
const REG_STATUS_LABEL = {
  NOT_SENT: 'לא נשלח', SENT_PENDING: 'ממתין לתשובה', APPROVED: 'מאושר', REJECTED: 'נדחה',
  NEEDS_INFO: 'בקשת פרטים', CONDITIONAL: 'מאושר בתנאים', APPROVED_KITNIYOT: 'מאושר לקטניות',
  SENT_FOR_REVIEW: 'נשלח אליך לבדיקה',
};
// R10 fix (10.11.2026): לא נשלח is left blank with no fill at all (handled
// separately below, never looked up here). Everything else uses Excel's
// classic light-fill/dark-text pairs; statuses not explicitly specified
// fall into the closest bucket (NEEDS_INFO/SENT_FOR_REVIEW -> pending,
// APPROVED_KITNIYOT -> approved).
const REG_STATUS_FILL = {
  SENT_PENDING: 'FFFFEB9C', SENT_FOR_REVIEW: 'FFFFEB9C', NEEDS_INFO: 'FFFFEB9C',
  APPROVED: 'FFC6EFCE', APPROVED_KITNIYOT: 'FFC6EFCE',
  REJECTED: 'FFFFC7CE',
  CONDITIONAL: 'FFFFE0B2',
};
const REG_STATUS_FONT = {
  SENT_PENDING: 'FF9C5700', SENT_FOR_REVIEW: 'FF9C5700', NEEDS_INFO: 'FF9C5700',
  APPROVED: 'FF006100', APPROVED_KITNIYOT: 'FF006100',
  REJECTED: 'FF9C0006',
  CONDITIONAL: 'FFE65100',
};
const REG_TRACK_LABEL = { YEAR_ROUND: 'ימות השנה', PASSOVER: 'פסח' };

app.post('/api/raw-material-registry/export', requireAssistant, ah(async (req, res) => {
  const ExcelJS = require('exceljs');
  const { ids } = req.body || {};
  // archived hidden from exports by default (same as the list) -- an
  // explicit ids list (the frontend always sends RM_STATE.lastFilteredIds,
  // which already excludes archived unless "הצג גם בארכיון" is on) wins.
  const where = Array.isArray(ids) && ids.length ? { id: { in: ids.map(Number) } } : { archived: false };
  const [items, bodies] = await Promise.all([
    prisma.rawMaterial.findMany({ where, include: REG_INCLUDE, orderBy: { name: 'asc' } }),
    prisma.kashrutBody.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
  ]);

  const wb = new ExcelJS.Workbook();

  // Sheet 1: סטטוס -- one row per raw material, two columns per active body
  const baseCols = ['שם', 'ספק', 'יצרן', 'מק"טים מקושרים', 'כשרות מקור', 'יש תעודת מקור', 'תוקף תעודת מקור'];
  const ws1 = wb.addWorksheet('סטטוס', { views: [{ rightToLeft: true, state: 'frozen', xSplit: 1, ySplit: 1 }] });
  const header1 = [...baseCols, ...bodies.flatMap(b => [`${b.name} – שנה`, `${b.name} – פסח`])];
  ws1.addRow(header1);
  ws1.getRow(1).font = { bold: true };

  for (const rm of items) {
    const rows = buildApprovalMatrixRows(rm, bodies, rm.approvals);
    const byBodyTrack = new Map(rows.map(r => [`${r.kashrutBodyId}|${r.track}`, r]));
    const excelRow = ws1.addRow([
      rm.name, rm.supplier || '', rm.manufacturer || '',
      rm.skus.map(s => s.sku.code).join(', '),
      rm.originKashrutText || '', rm.originHasCert ? 'כן' : 'לא',
      rm.originCertValidUntil ? new Date(rm.originCertValidUntil).toISOString().slice(0, 10) : '',
    ]);
    let col = baseCols.length;
    for (const b of bodies) {
      col++;
      const yr = byBodyTrack.get(`${b.id}|YEAR_ROUND`);
      if (yr && yr.status !== 'NOT_SENT') {
        const cell = excelRow.getCell(col);
        cell.value = REG_STATUS_LABEL[yr.status] || yr.status;
        if (REG_STATUS_FILL[yr.status]) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: REG_STATUS_FILL[yr.status] } };
        if (REG_STATUS_FONT[yr.status]) cell.font = { color: { argb: REG_STATUS_FONT[yr.status] } };
      }
      col++;
      const ps = byBodyTrack.get(`${b.id}|PASSOVER`);
      if (ps && ps.status !== 'NOT_SENT') {
        const cell = excelRow.getCell(col);
        cell.value = (REG_STATUS_LABEL[ps.status] || ps.status) + (ps.seasonYear ? ` (${ps.seasonYear})` : '');
        if (REG_STATUS_FILL[ps.status]) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: REG_STATUS_FILL[ps.status] } };
        if (REG_STATUS_FONT[ps.status]) cell.font = { color: { argb: REG_STATUS_FONT[ps.status] } };
      }
    }
  }
  ws1.getColumn(1).width = 28;
  for (let c = 2; c <= header1.length; c++) ws1.getColumn(c).width = 18;

  // Sheet 2: פירוט -- one row per real approval (skips plain NOT_SENT placeholders)
  const ws2 = wb.addWorksheet('פירוט', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  const header2 = ['שם', 'גוף', 'מסלול', 'סטטוס', 'איש קשר', 'תאריך שליחה', 'תאריך תשובה', 'תנאי/הערה', 'שנה (פסח)'];
  ws2.addRow(header2);
  ws2.getRow(1).font = { bold: true };
  for (const rm of items) {
    const rows = buildApprovalMatrixRows(rm, bodies, rm.approvals).filter(r => r.id != null || r.viaOrigin);
    for (const r of rows) {
      ws2.addRow([
        rm.name, r.kashrutBodyName, REG_TRACK_LABEL[r.track] || r.track, REG_STATUS_LABEL[r.status] || r.status,
        r.contactName || '', r.sentAt ? new Date(r.sentAt).toISOString().slice(0, 10) : '',
        r.replyAt ? new Date(r.replyAt).toISOString().slice(0, 10) : '',
        r.conditionText || r.notes || '', r.seasonYear || '',
      ]);
    }
  }
  for (let c = 1; c <= header2.length; c++) ws2.getColumn(c).width = 18;

  const today = new Date().toISOString().slice(0, 10);
  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent('חומרי גלם - ' + today + '.xlsx')}`);
  res.send(Buffer.from(buf));
}));

/* ── change an approval's status/level/condition/notes/validUntil ── */
app.patch('/api/approvals/:id', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const approval = await prisma.rawMaterialApproval.findUnique({ where: { id } });
  if (!approval) return res.status(404).json({ error: 'רשומת אישור לא נמצאה (חומר גלם שלא נשלח עדיין אין לו רשומה עד שליחה ראשונה)' });
  const { status, kashrutLevel, conditionText, notes, validUntil, seasonYear, approvalSource, approvalSourceDetail } = req.body;
  if (status !== undefined && !isValidStatusForTrack(status, approval.track))
    return res.status(400).json({ error: approval.track === 'YEAR_ROUND' ? 'סטטוס לא תקין (מאושר בתנאים תקף רק למסלול לימות השנה)' : 'סטטוס לא תקין (מאושר לקטניות תקף רק למסלול פסח)' });
  if (approvalSource !== undefined && approvalSource !== null && !VALID_APPROVAL_SOURCE.includes(approvalSource))
    return res.status(400).json({ error: 'מקור אישור לא תקין' });
  // PATCH never carries a file -- any status change here with no reply file
  // (new or pre-existing) needs a source saying how it was actually obtained
  if (status !== undefined && !approval.replyDocId) {
    const effectiveSource = approvalSource !== undefined ? approvalSource : approval.approvalSource;
    if (!effectiveSource) return res.status(400).json({ error: 'נדרש לציין מקור לאישור (טלפון / מייל / וואטסאפ / מכתב / שנה קודמת / רשימת גוף / אחר) כאשר אין קובץ תשובה' });
  }

  const updates = { updatedById: req.user.id || null };
  if (status !== undefined) updates.status = status;
  if (kashrutLevel !== undefined) updates.kashrutLevel = kashrutLevel || null;
  if (conditionText !== undefined) updates.conditionText = conditionText || null;
  if (notes !== undefined) updates.notes = notes || null;
  if (validUntil !== undefined) updates.validUntil = validUntil ? new Date(validUntil) : null;
  if (seasonYear !== undefined) updates.seasonYear = seasonYear || null;
  if (approvalSource !== undefined) updates.approvalSource = approvalSource || null;
  if (approvalSourceDetail !== undefined) updates.approvalSourceDetail = approvalSourceDetail || null;

  const updated = await prisma.rawMaterialApproval.update({
    where: { id }, data: updates, include: { kashrutBody: true, contact: true },
  });
  const generalFieldsTouched = [status, kashrutLevel, conditionText, notes, validUntil, seasonYear, approvalSource, approvalSourceDetail].some(v => v !== undefined);
  if (generalFieldsTouched) {
    await prisma.rawMaterialApprovalEvent.create({
      data: {
        approvalId: id,
        type: (status !== undefined && status !== approval.status) ? 'STATUS_CHANGE' : 'NOTE',
        fromStatus: approval.status, toStatus: status !== undefined ? status : approval.status,
        payload: { kashrutLevel, conditionText, notes, validUntil, seasonYear, approvalSource, approvalSourceDetail },
        byUserId: req.user.id || null,
      },
    });
  }
  res.json(regApprovalOut(updated));
}));

/* ── send: EMAIL never goes to the kashrut body directly (added 3.11.2026)
 * -- it goes to REVIEW_EMAIL (the user's own address) wrapped with a
 * "[לבדיקה והעברה]" subject and a header block naming the intended
 * recipient + attachments, so the user can check it and forward it
 * himself. That sets SENT_FOR_REVIEW, not SENT_PENDING -- sentAt stays
 * unset until the user confirms via POST .../confirm-forward below.
 * WHATSAPP is unchanged: still client-side (share/wa.me), still
 * recordOnly=true, still sets SENT_PENDING directly, no review step.
 * Two-track revision: accepts multiple bodies and/or tracks in one call
 * (one review email per body), while the old single-body shape
 * (kashrutBodyId + contactId) keeps working unchanged -- it just means
 * "one body, YEAR_ROUND". ── */
const TRACK_LABEL = { YEAR_ROUND: 'לימות השנה', PASSOVER: 'לפסח' };
const REVIEW_EMAIL = process.env.REVIEW_EMAIL || 'a0527613684@gmail.com';
app.post('/api/raw-materials/:id/send', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const rm = await prisma.rawMaterial.findUnique({ where: { id } });
  if (!rm) return res.status(404).json({ error: 'חומר גלם לא נמצא' });

  const { docIds, message, via, recordOnly, followUp } = req.body;
  if (!['EMAIL', 'WHATSAPP'].includes(via)) return res.status(400).json({ error: 'ערוץ שליחה לא תקין' });
  const ids = Array.isArray(docIds) ? docIds.map(Number) : [];
  if (!ids.length) return res.status(400).json({ error: 'נא לבחור לפחות מסמך אחד לצירוף' });
  if (via === 'WHATSAPP' && !recordOnly)
    return res.status(400).json({ error: 'שליחת וואטסאפ מתבצעת בצד הלקוח -- יש לקרוא כאן עם recordOnly=true לאחר אישור השליחה' });

  let bodyIds, tracks, contactIdByBody;
  if (Array.isArray(req.body.kashrutBodyIds)) {
    bodyIds = req.body.kashrutBodyIds.map(Number);
    tracks = Array.isArray(req.body.tracks) && req.body.tracks.length ? req.body.tracks : ['YEAR_ROUND'];
    contactIdByBody = req.body.contactIds || {};
  } else if (req.body.kashrutBodyId) {
    bodyIds = [parseInt(req.body.kashrutBodyId)];
    tracks = ['YEAR_ROUND'];
    contactIdByBody = req.body.contactId ? { [req.body.kashrutBodyId]: req.body.contactId } : {};
  } else {
    return res.status(400).json({ error: 'נא לבחור גוף כשרות אחד לפחות' });
  }
  if (!bodyIds.length) return res.status(400).json({ error: 'נא לבחור גוף כשרות אחד לפחות' });
  if (!tracks.every(t => ['YEAR_ROUND', 'PASSOVER'].includes(t))) return res.status(400).json({ error: 'מסלול לא תקין' });

  const bodies = await prisma.kashrutBody.findMany({ where: { id: { in: bodyIds } } });
  if (bodies.length !== bodyIds.length) return res.status(404).json({ error: 'גוף כשרות לא נמצא' });

  const sendRealEmail = via === 'EMAIL' && !recordOnly;
  const mailer = sendRealEmail ? getMailer() : null;
  if (sendRealEmail && !mailer) return res.status(400).json({ error: 'שליחת מייל לא הוגדרה בשרת (חסר EMAIL_APP_PASSWORD)' });
  const docs = sendRealEmail ? await prisma.document.findMany({ where: { id: { in: ids } } }) : [];
  const tracksText = tracks.length === 2 ? 'לימות השנה ולפסח' : TRACK_LABEL[tracks[0]];

  const results = [];
  for (const body of bodies) {
    const contactId = contactIdByBody[body.id] ?? contactIdByBody[String(body.id)] ?? null;
    const contact = contactId ? await prisma.contact.findUnique({ where: { id: parseInt(contactId) } }) : null;

    if (sendRealEmail) {
      if (!contact?.email) return res.status(400).json({ error: `נא לבחור איש קשר עם כתובת מייל לגוף ${body.name}` });
      const attachments = await Promise.all(docs.map(async (d) => {
        const { stream, contentType } = await getObjectStream(d.fileUrl);
        const ext = d.docExt ? '.' + d.docExt : '';
        return { filename: (d.title || 'מסמך') + ext, content: stream, contentType };
      }));
      const defaultBody = `שלום,\n\nמצורפים מסמכים עבור חומר הגלם ${rm.name}, בנושא ${tracksText}.\n\nבברכה,\nאחים כהן`;
      const innerSubject = `אישור כשרות (${tracksText}) — ${rm.name}`;
      const headerBlock = `מיועד ל: ${contact.name} <${contact.email}> (${body.name})\n` +
        `קבצים מצורפים: ${attachments.map(a => a.filename).join(', ')}\n\n` +
        `--- ההודעה המוכנה להעברה לגוף הכשרות ---\n\n`;
      await mailer.sendMail({
        from: process.env.EMAIL_FROM, to: REVIEW_EMAIL,
        subject: `[לבדיקה והעברה] → ${body.name} / ${contact.name} ${contact.email} – ${innerSubject}`,
        text: headerBlock + (message || defaultBody),
        attachments,
      });
    }

    // EMAIL -> SENT_FOR_REVIEW (sentAt stays unset until confirm-forward);
    // WHATSAPP is unchanged -> SENT_PENDING directly, sentAt = now
    const newStatus = via === 'EMAIL' ? 'SENT_FOR_REVIEW' : 'SENT_PENDING';
    const newSentAt = via === 'EMAIL' ? null : new Date();

    for (const track of tracks) {
      const approval = await prisma.rawMaterialApproval.upsert({
        where: { rawMaterialId_kashrutBodyId_track: { rawMaterialId: id, kashrutBodyId: body.id, track } },
        create: { rawMaterialId: id, kashrutBodyId: body.id, track, contactId: contact ? contact.id : null, status: newStatus, sentAt: newSentAt, sentVia: via, sentDocIds: ids },
        update: { contactId: contact ? contact.id : null, status: newStatus, sentAt: newSentAt, sentVia: via, sentDocIds: ids },
        include: { kashrutBody: true, contact: true },
      });
      await prisma.rawMaterialApprovalEvent.create({
        data: {
          approvalId: approval.id, type: 'SENT', toStatus: newStatus,
          payload: { via, docIds: ids, recordOnly: !!recordOnly, contactId: contact ? contact.id : null, followUp: !!followUp, reviewEmail: via === 'EMAIL' ? REVIEW_EMAIL : undefined },
          byUserId: req.user.id || null,
        },
      });
      results.push(regApprovalOut(approval));
    }
  }

  res.json(bodyIds.length === 1 && tracks.length === 1 ? results[0] : results);
}));

/* ── R12: bulk send -- many raw materials x many bodies x many tracks at
 * once. Same REVIEW_EMAIL rule as the single-item /send above: EMAIL always
 * goes to REVIEW_EMAIL first (status SENT_FOR_REVIEW, sentAt unset), never
 * directly to the body -- "✔ הועבר לגוף" (the EXISTING confirm-forward
 * endpoint, unchanged) is what moves it to SENT_PENDING. One email per
 * body, listing every selected raw material in a table; if the combined
 * attachments for a body exceed ~20MB they're split across several emails
 * for that body (same table in each, a subset of attachments, "(חלק X/Y)"
 * in the subject) rather than zipping, so no new dependency was needed. ── */
app.post('/api/raw-material-registry/bulk-send', requireAssistant, ah(async (req, res) => {
  const { rawMaterialIds, message, via, recordOnly } = req.body;
  if (!['EMAIL', 'WHATSAPP'].includes(via)) return res.status(400).json({ error: 'ערוץ שליחה לא תקין' });
  if (via === 'WHATSAPP' && !recordOnly)
    return res.status(400).json({ error: 'שליחת וואטסאפ מתבצעת בצד הלקוח -- יש לקרוא כאן עם recordOnly=true לאחר אישור השליחה' });

  const rmIds = Array.isArray(rawMaterialIds) ? rawMaterialIds.map(Number) : [];
  if (!rmIds.length) return res.status(400).json({ error: 'נא לבחור חומר גלם אחד לפחות' });
  const bodyIds = Array.isArray(req.body.kashrutBodyIds) ? req.body.kashrutBodyIds.map(Number) : [];
  if (!bodyIds.length) return res.status(400).json({ error: 'נא לבחור גוף כשרות אחד לפחות' });
  const tracks = Array.isArray(req.body.tracks) && req.body.tracks.length ? req.body.tracks : ['YEAR_ROUND'];
  if (!tracks.every(t => ['YEAR_ROUND', 'PASSOVER'].includes(t))) return res.status(400).json({ error: 'מסלול לא תקין' });
  const contactIdByBody = req.body.contactIds || {};

  const materials = await prisma.rawMaterial.findMany({ where: { id: { in: rmIds } }, include: { documents: { include: { document: true } } } });
  if (materials.length !== rmIds.length) return res.status(404).json({ error: 'חומר גלם לא נמצא' });
  const archivedInSelection = materials.filter(m => m.archived);
  if (archivedInSelection.length) return res.status(400).json({ error: `לא ניתן לשלוח בקשות עבור חומרי גלם בארכיון: ${archivedInSelection.map(m => m.name).join(', ')}` });
  const bodies = await prisma.kashrutBody.findMany({ where: { id: { in: bodyIds } } });
  if (bodies.length !== bodyIds.length) return res.status(404).json({ error: 'גוף כשרות לא נמצא' });

  const sendRealEmail = via === 'EMAIL' && !recordOnly;
  const mailer = sendRealEmail ? getMailer() : null;
  if (sendRealEmail && !mailer) return res.status(400).json({ error: 'שליחת מייל לא הוגדרה בשרת (חסר EMAIL_APP_PASSWORD)' });
  const tracksText = tracks.length === 2 ? 'לימות השנה ולפסח' : TRACK_LABEL[tracks[0]];

  const results = [];
  const warnings = [];

  for (const body of bodies) {
    const contactId = contactIdByBody[body.id] ?? contactIdByBody[String(body.id)] ?? null;
    const contact = contactId ? await prisma.contact.findUnique({ where: { id: parseInt(contactId) } }) : null;

    if (sendRealEmail) {
      if (!contact?.email) return res.status(400).json({ error: `נא לבחור איש קשר עם כתובת מייל לגוף ${body.name}` });

      const attachmentItems = [];
      for (const m of materials) {
        const label = m.documents.find(d => d.docRole === 'LABEL');
        if (label) attachmentItems.push({ material: m, doc: label.document });
        if (tracks.includes('YEAR_ROUND') && m.originCertDocId) {
          const certDoc = await prisma.document.findUnique({ where: { id: m.originCertDocId } });
          if (certDoc) attachmentItems.push({ material: m, doc: certDoc });
        }
        if (tracks.includes('PASSOVER') && m.originPassoverCertDocId) {
          const certDoc = await prisma.document.findUnique({ where: { id: m.originPassoverCertDocId } });
          if (certDoc) attachmentItems.push({ material: m, doc: certDoc });
        }
      }

      const MAX_BYTES = 20 * 1024 * 1024;
      const buckets = [[]];
      let bucketSize = 0;
      for (const item of attachmentItems) {
        const size = item.doc.sizeBytes || 0;
        if (bucketSize + size > MAX_BYTES && buckets[buckets.length - 1].length) { buckets.push([]); bucketSize = 0; }
        buckets[buckets.length - 1].push(item);
        bucketSize += size;
      }
      if (buckets.length > 1) warnings.push(`${body.name}: הקבצים חולקו ל-${buckets.length} מיילים (מעל 20MB בקובץ אחד)`);

      const tableHeader = 'שם | יצרן | כשרות מקור';
      const tableRows = materials.map(m => `${m.name} | ${m.manufacturer || '—'} | ${m.originKashrutText || '—'}`).join('\n');

      for (let bi = 0; bi < buckets.length; bi++) {
        const bucket = buckets[bi];
        const attachments = await Promise.all(bucket.map(async (item) => {
          const { stream, contentType } = await getObjectStream(item.doc.fileUrl);
          const ext = item.doc.docExt ? '.' + item.doc.docExt : '';
          return { filename: `${item.material.name} - ${item.doc.title || 'מסמך'}${ext}`, content: stream, contentType };
        }));
        const partLabel = buckets.length > 1 ? ` (חלק ${bi + 1}/${buckets.length})` : '';
        const defaultBody = `שלום,\n\nמצורפים מסמכים עבור ${materials.length} חומרי גלם, בנושא ${tracksText}:\n\n${tableHeader}\n${tableRows}\n\nבברכה,\nאחים כהן`;
        const innerSubject = `אישור כשרות (${tracksText}) — ${materials.length} חומרי גלם${partLabel}`;
        const headerBlock = `מיועד ל: ${contact.name} <${contact.email}> (${body.name})\n` +
          `קבצים מצורפים: ${attachments.map(a => a.filename).join(', ')}\n\n` +
          `--- ההודעה המוכנה להעברה לגוף הכשרות ---\n\n`;
        await mailer.sendMail({
          from: process.env.EMAIL_FROM, to: REVIEW_EMAIL,
          subject: `[לבדיקה והעברה] → ${body.name} / ${contact.name} ${contact.email} – ${innerSubject}`,
          text: headerBlock + (message || defaultBody),
          attachments,
        });
      }
    }

    const newStatus = via === 'EMAIL' ? 'SENT_FOR_REVIEW' : 'SENT_PENDING';
    const newSentAt = via === 'EMAIL' ? null : new Date();

    for (const m of materials) {
      for (const track of tracks) {
        const approval = await prisma.rawMaterialApproval.upsert({
          where: { rawMaterialId_kashrutBodyId_track: { rawMaterialId: m.id, kashrutBodyId: body.id, track } },
          create: { rawMaterialId: m.id, kashrutBodyId: body.id, track, contactId: contact ? contact.id : null, status: newStatus, sentAt: newSentAt, sentVia: via, sentDocIds: [] },
          update: { contactId: contact ? contact.id : null, status: newStatus, sentAt: newSentAt, sentVia: via, sentDocIds: [] },
          include: { kashrutBody: true, contact: true },
        });
        await prisma.rawMaterialApprovalEvent.create({
          data: {
            approvalId: approval.id, type: 'SENT', toStatus: newStatus,
            payload: { via, recordOnly: !!recordOnly, bulk: true, contactId: contact ? contact.id : null, reviewEmail: via === 'EMAIL' ? REVIEW_EMAIL : undefined },
            byUserId: req.user.id || null,
          },
        });
        results.push(regApprovalOut(approval));
      }
    }
  }

  res.json({ ok: true, approvalsCreated: results.length, warnings });
}));

/* ── confirm-forward: the user checked the review email and forwarded it
 * himself to the kashrut body -- moves SENT_FOR_REVIEW to SENT_PENDING
 * with an editable sentAt (defaults to now). Added 3.11.2026 alongside
 * the review-first email rule. ── */
app.post('/api/approvals/:id/confirm-forward', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const approval = await prisma.rawMaterialApproval.findUnique({ where: { id } });
  if (!approval) return res.status(404).json({ error: 'רשומת אישור לא נמצאה' });
  if (approval.status !== 'SENT_FOR_REVIEW')
    return res.status(400).json({ error: 'ניתן לאשר העברה רק מתוך סטטוס "נשלח אליך לבדיקה"' });
  const { sentAt } = req.body;

  const updated = await prisma.rawMaterialApproval.update({
    where: { id },
    data: { status: 'SENT_PENDING', sentAt: sentAt ? new Date(sentAt) : new Date(), updatedById: req.user.id || null },
    include: { kashrutBody: true, contact: true },
  });
  await prisma.rawMaterialApprovalEvent.create({
    data: {
      approvalId: id, type: 'SENT', fromStatus: 'SENT_FOR_REVIEW', toStatus: 'SENT_PENDING',
      payload: { confirmedForward: true }, byUserId: req.user.id || null,
    },
  });
  res.json(regApprovalOut(updated));
}));

/* ── reply: upload the reply as a Document, close out the approval. Two-
 * track revision: validates status against the approval's own track, takes
 * an optional seasonYear, and an optional alsoApprovalId so one reply
 * letter can close both tracks of the same body (same file, same date) --
 * that second approval must be the other track of the same material+body. ── */
app.post('/api/approvals/:id/reply', requireAssistant, upload.single('file'), ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const approval = await prisma.rawMaterialApproval.findUnique({ where: { id } });
  if (!approval) return res.status(404).json({ error: 'רשומת אישור לא נמצאה' });
  const { status, replyAt, conditionText, notes, seasonYear, approvalSource, approvalSourceDetail, alsoApprovalId, alsoStatus, alsoConditionText, alsoSeasonYear } = req.body;
  if (!isValidStatusForTrack(status, approval.track))
    return res.status(400).json({ error: 'נא לציין סטטוס תשובה תקין למסלול זה' });
  if (approvalSource !== undefined && approvalSource !== null && !VALID_APPROVAL_SOURCE.includes(approvalSource))
    return res.status(400).json({ error: 'מקור אישור לא תקין' });

  let also = null;
  if (alsoApprovalId) {
    also = await prisma.rawMaterialApproval.findUnique({ where: { id: parseInt(alsoApprovalId) } });
    if (!also) return res.status(404).json({ error: 'רשומת האישור הנוספת לא נמצאה' });
    if (also.rawMaterialId !== approval.rawMaterialId || also.kashrutBodyId !== approval.kashrutBodyId || also.track === approval.track)
      return res.status(400).json({ error: 'רשומת האישור הנוספת חייבת להיות המסלול האחר של אותו חומר גלם ואותו גוף כשרות' });
    if (!isValidStatusForTrack(alsoStatus, also.track))
      return res.status(400).json({ error: 'נא לציין סטטוס תשובה תקין למסלול הנוסף' });
  }

  let replyDocId = approval.replyDocId;
  if (req.file) {
    const ext = path.extname(req.file.originalname).replace('.', '').toLowerCase();
    const key = r2KeyFor(req.file.originalname);
    await uploadBuffer(req.file.buffer, key, req.file.mimetype);
    const doc = await prisma.document.create({
      data: {
        title: req.body.name || req.file.originalname.replace(/\.[^.]+$/, ''),
        docType: 'תעודות בדצים', docExt: ext, sizeBytes: req.file.size,
        fileUrl: key, hidden: true, uploadedById: req.user.id || null,
      },
    });
    replyDocId = doc.id;
  }
  const replyDate = replyAt ? new Date(replyAt) : new Date();

  // no reply file (new or pre-existing) -- a source for how the status was
  // actually obtained is required, for this track and (if present) the also-track
  if (!replyDocId) {
    const effectiveSource = approvalSource !== undefined ? approvalSource : approval.approvalSource;
    if (!effectiveSource) return res.status(400).json({ error: 'נדרש לציין מקור לאישור (טלפון / מייל / וואטסאפ / מכתב / שנה קודמת / רשימת גוף / אחר) כאשר אין קובץ תשובה' });
    if (also) {
      const alsoEffectiveSource = approvalSource !== undefined ? approvalSource : also.approvalSource;
      if (!alsoEffectiveSource) return res.status(400).json({ error: 'נדרש לציין מקור לאישור גם למסלול הנוסף כאשר אין קובץ תשובה' });
    }
  }

  const updated = await prisma.rawMaterialApproval.update({
    where: { id },
    data: {
      status, replyDocId, replyAt: replyDate,
      conditionText: conditionText !== undefined ? (conditionText || null) : approval.conditionText,
      notes: notes !== undefined ? (notes || null) : approval.notes,
      seasonYear: seasonYear !== undefined ? (seasonYear || null) : approval.seasonYear,
      ...(approvalSource !== undefined ? { approvalSource: approvalSource || null } : {}),
      ...(approvalSourceDetail !== undefined ? { approvalSourceDetail: approvalSourceDetail || null } : {}),
      updatedById: req.user.id || null,
    },
    include: { kashrutBody: true, contact: true },
  });
  await prisma.rawMaterialApprovalEvent.create({
    data: {
      approvalId: id, type: 'REPLY', fromStatus: approval.status, toStatus: status,
      payload: { replyDocId, conditionText, notes, seasonYear, approvalSource, approvalSourceDetail }, byUserId: req.user.id || null,
    },
  });

  let updatedAlso = null;
  if (also) {
    updatedAlso = await prisma.rawMaterialApproval.update({
      where: { id: also.id },
      data: {
        status: alsoStatus, replyDocId, replyAt: replyDate,
        conditionText: alsoConditionText !== undefined ? (alsoConditionText || null) : also.conditionText,
        seasonYear: alsoSeasonYear !== undefined ? (alsoSeasonYear || null) : also.seasonYear,
        notes: notes !== undefined ? (notes || null) : also.notes, // one shared reply note across both tracks
        ...(approvalSource !== undefined ? { approvalSource: approvalSource || null } : {}),
        ...(approvalSourceDetail !== undefined ? { approvalSourceDetail: approvalSourceDetail || null } : {}),
        updatedById: req.user.id || null,
      },
      include: { kashrutBody: true, contact: true },
    });
    await prisma.rawMaterialApprovalEvent.create({
      data: {
        approvalId: also.id, type: 'REPLY', fromStatus: also.status, toStatus: alsoStatus,
        payload: { replyDocId, conditionText: alsoConditionText, seasonYear: alsoSeasonYear, notes, approvalSource, approvalSourceDetail, sameLetterAs: id },
        byUserId: req.user.id || null,
      },
    });
  }

  res.json(updatedAlso ? [regApprovalOut(updated), regApprovalOut(updatedAlso)] : regApprovalOut(updated));
}));

/* ── approval history log, for the card screen's "היסטוריה" button (R4).
 * Writes have existed since Phase 3; this is the first read endpoint. ── */
app.get('/api/approvals/:id/events', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const approval = await prisma.rawMaterialApproval.findUnique({ where: { id } });
  if (!approval) return res.status(404).json({ error: 'רשומת אישור לא נמצאה' });
  const events = await prisma.rawMaterialApprovalEvent.findMany({
    where: { approvalId: id }, orderBy: { at: 'desc' }, include: { byUser: true },
  });
  res.json(events.map(e => ({
    id: e.id, type: e.type, fromStatus: e.fromStatus, toStatus: e.toStatus,
    payload: e.payload, byUserId: e.byUserId, byUserName: e.byUser ? (e.byUser.name || e.byUser.email) : null,
    at: e.at,
  })));
}));

/* ── SKU view: this SKU's raw materials + the approval for its own required
 * kashrut body (from the SKU's כשרות field) + a per-material summary ── */
app.get('/api/skus/:id/raw-materials', requireAssistant, ah(async (req, res) => {
  const sku = await prisma.sku.findUnique({ where: { code: req.params.id } });
  if (!sku) return res.status(404).json({ error: 'מקט לא נמצא' });
  const links = await prisma.skuRawMaterial.findMany({
    where: { skuId: sku.id },
    include: { rawMaterial: { include: REG_INCLUDE } },
  });
  const requiredBodyName = resolveKashrutBodyName(sku.kashrutBodyRef);
  res.json(links.map((l) => {
    const rm = l.rawMaterial;
    const requiredApproval = requiredBodyName
      ? rm.approvals.find((a) => a.kashrutBody.name === requiredBodyName) || null
      : null;
    const statuses = rm.approvals.map((a) => a.status);
    const summary = statuses.length === 0 ? 'NONE'
      : statuses.every((s) => s === 'APPROVED') ? 'ALL_APPROVED'
      : statuses.some((s) => s === 'REJECTED') ? 'HAS_REJECTED'
      : 'MISSING';
    return {
      rawMaterialId: rm.id, name: rm.name, supplier: rm.supplier || '',
      documents: rm.documents.map(regDocOut),
      requiredKashrutBody: requiredBodyName,
      requiredApproval: requiredApproval ? regApprovalOut(requiredApproval) : null,
      summary,
    };
  }));
}));

/* ── link this raw material to a SKU. Not called out as its own endpoint in
 * the spec's Phase 3 bullet list, but without it the two read endpoints
 * below (impact view, SKU view) could only ever show the SKUs created by
 * the one-time Phase 2 migration -- added so new links can be created going
 * forward (e.g. an existing raw material used in a newly added SKU). ── */
app.post('/api/raw-material-registry/:id/skus', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const rm = await prisma.rawMaterial.findUnique({ where: { id } });
  if (!rm) return res.status(404).json({ error: 'חומר גלם לא נמצא' });
  const { skuCode } = req.body;
  if (!skuCode) return res.status(400).json({ error: 'נא לבחור מק"ט' });
  const sku = await prisma.sku.findUnique({ where: { code: String(skuCode) } });
  if (!sku) return res.status(404).json({ error: 'מקט לא נמצא' });
  const link = await prisma.skuRawMaterial.upsert({
    where: { skuId_rawMaterialId: { skuId: sku.id, rawMaterialId: id } },
    create: { skuId: sku.id, rawMaterialId: id },
    update: {},
  });
  res.status(201).json({ id: link.id, skuId: sku.code, skuName: sku.name, rawMaterialId: id });
}));

/* ── unlink a SKU from this raw material. Added for Phase 4 Step 4.2 ("add
 * or remove" linked SKUs) -- not in the spec's literal Phase 3 bullet list,
 * same gap-filling category as the POST above. ── */
app.delete('/api/raw-material-registry/:id/skus/:skuCode', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const sku = await prisma.sku.findUnique({ where: { code: String(req.params.skuCode) } });
  if (!sku) return res.status(404).json({ error: 'מקט לא נמצא' });
  await prisma.skuRawMaterial.deleteMany({ where: { rawMaterialId: id, skuId: sku.id } });
  res.json({ ok: true });
}));

/* ── impact view: which SKUs use this raw material ── */
app.get('/api/raw-materials/:id/skus', requireAssistant, ah(async (req, res) => {
  const id = parseInt(req.params.id);
  const rm = await prisma.rawMaterial.findUnique({ where: { id } });
  if (!rm) return res.status(404).json({ error: 'חומר גלם לא נמצא' });
  const links = await prisma.skuRawMaterial.findMany({ where: { rawMaterialId: id }, include: { sku: true } });
  res.json(links.map((l) => skuOut(l.sku)));
}));

/* ── kashrut bodies: read-only list, needed by Phase 4 pickers. Not in the
 * spec's explicit Phase 3 bullet list, but the bodies are a fixed seeded
 * set (Phase 1) with no create/edit API here -- just exposing them. ── */
app.get('/api/kashrut-bodies', requireAssistant, ah(async (req, res) => {
  const bodies = await prisma.kashrutBody.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  res.json(bodies.map(kashrutBodyOut));
}));

/* ── read-only export for the kosher dashboard, API-key protected (not JWT/
 * assistant-code) since this is meant to be called by another system ── */
function requireExportKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!process.env.EXPORT_API_KEY || key !== process.env.EXPORT_API_KEY)
    return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/api/export/raw-materials', requireExportKey, ah(async (req, res) => {
  const rawMaterials = await prisma.rawMaterial.findMany({ include: REG_INCLUDE });
  res.json({
    generatedAt: new Date().toISOString(),
    rawMaterials: rawMaterials.map((rm) => ({
      id: rm.id, name: rm.name, supplier: rm.supplier || '', manufacturer: rm.manufacturer || '',
      documents: rm.documents.map((d) => ({
        id: d.document.id, title: d.document.title, role: d.docRole,
        downloadUrl: `/api/docs/${d.document.id}/download`,
      })),
      approvals: rm.approvals.map((a) => ({
        kashrutBody: a.kashrutBody.name, status: a.status, kashrutLevel: a.kashrutLevel || '',
        sentAt: a.sentAt, replyAt: a.replyAt, validUntil: a.validUntil,
        replyFile: a.replyDocId ? `/api/docs/${a.replyDocId}/download` : null,
      })),
      skus: rm.skus.map((s) => ({ code: s.sku.code, name: s.sku.name })),
    })),
  });
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

/* ── L3: link-suggestions review screen ("🔗 הצעות קישור") ── */
const CONF_RANK = { CERTAIN: 3, LIKELY: 2, POSSIBLE: 1, NONE: 0 };
const NO_SKU_REASONS = ['מכתב', 'חשבונית', 'כפילות', 'לא רלוונטי'];

async function reviewQueueBase() {
  // documents eligible for review: unlinked, not archived, not marked
  // no-sku-needed, not a known duplicate -- per L0/L4 these are excluded
  // from the unlinked count and the review queue.
  const idents = await prisma.docIdentification.findMany({
    where: { document: { links: { none: {} }, archived: false, noSkuNeeded: false, duplicateOfId: null, trashedAt: null } },
    include: { document: { select: { id: true, title: true, docExt: true, createdAt: true } } },
  });
  const suggestions = await prisma.linkSuggestion.groupBy({
    by: ['documentId', 'confidence'],
    _count: true,
    where: { status: 'PENDING' },
  });
  const bestByDoc = new Map(); // documentId -> { confidence, count }
  for (const s of suggestions) {
    const cur = bestByDoc.get(s.documentId);
    const rank = CONF_RANK[s.confidence];
    if (!cur || rank > CONF_RANK[cur.confidence]) bestByDoc.set(s.documentId, { confidence: s.confidence, count: s._count });
    else if (rank === CONF_RANK[cur.confidence]) cur.count += s._count;
  }
  return idents.map((r) => {
    const best = bestByDoc.get(r.documentId);
    return {
      documentId: r.documentId,
      title: r.document.title || '',
      docExt: r.document.docExt || '',
      createdAt: r.document.createdAt,
      docKind: r.docKind, certNo: r.certNo, requestNo: r.requestNo, products: r.products,
      manufacturer: r.manufacturer, kashrutBody: r.kashrutBody, track: r.track,
      validUntil: r.validUntil, productionDate: r.productionDate,
      bestConfidence: best ? best.confidence : 'NONE',
      candidateCount: best ? best.count : 0,
    };
  });
}

app.get('/api/link-suggestions/queue', requireAssistant, ah(async (req, res) => {
  let rows = await reviewQueueBase();
  const { confidence, kind, body, manufacturer, dateFrom, dateTo } = req.query;
  if (confidence && confidence !== 'all') rows = rows.filter(r => r.bestConfidence === confidence);
  if (kind) rows = rows.filter(r => (r.docKind || '') === kind);
  if (body) rows = rows.filter(r => (r.kashrutBody || '').includes(body));
  if (manufacturer) rows = rows.filter(r => (r.manufacturer || '').toLowerCase().includes(String(manufacturer).toLowerCase()));
  if (dateFrom) rows = rows.filter(r => r.createdAt >= new Date(dateFrom));
  if (dateTo) rows = rows.filter(r => r.createdAt <= new Date(dateTo));
  rows.sort((a, b) => CONF_RANK[b.bestConfidence] - CONF_RANK[a.bestConfidence] || a.documentId - b.documentId);
  res.json({
    total: rows.length,
    counts: {
      CERTAIN: rows.filter(r => r.bestConfidence === 'CERTAIN').length,
      LIKELY: rows.filter(r => r.bestConfidence === 'LIKELY').length,
      POSSIBLE: rows.filter(r => r.bestConfidence === 'POSSIBLE').length,
      NONE: rows.filter(r => r.bestConfidence === 'NONE').length,
    },
    rows,
  });
}));

app.get('/api/link-suggestions/filter-options', requireAssistant, ah(async (req, res) => {
  const rows = await reviewQueueBase();
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
  res.json({
    kinds: uniq(rows.map(r => r.docKind)),
    bodies: uniq(rows.map(r => r.kashrutBody)),
  });
}));

app.get('/api/link-suggestions/bulk-certain-preview', requireAssistant, ah(async (req, res) => {
  const rows = (await reviewQueueBase()).filter(r => r.bestConfidence === 'CERTAIN');
  const linkCount = rows.reduce((sum, r) => sum + r.candidateCount, 0);
  res.json({ documentCount: rows.length, linkCount });
}));

app.post('/api/link-suggestions/bulk-certain', requireAssistant, ah(async (req, res) => {
  const rows = (await reviewQueueBase()).filter(r => r.bestConfidence === 'CERTAIN');
  let linked = 0;
  for (const row of rows) {
    const suggs = await prisma.linkSuggestion.findMany({ where: { documentId: row.documentId, confidence: 'CERTAIN', status: 'PENDING' } });
    for (const s of suggs) {
      const existing = await prisma.skuLink.findFirst({ where: { documentId: row.documentId, skuId: s.skuId } });
      if (!existing) {
        await prisma.skuLink.create({ data: {
          skuId: s.skuId, docType: 'DOCUMENT', documentId: row.documentId, visibleToCustomer: false,
          approvalStatus: 'APPROVED', isRawMaterial: false, reviewedById: req.user.id || null, reviewedAt: new Date(),
        }});
        linked++;
      }
      await prisma.linkSuggestion.update({ where: { id: s.id }, data: { status: 'APPROVED', decidedById: req.user.id || null, decidedAt: new Date() } });
    }
  }
  res.json({ ok: true, documentsLinked: rows.length, linksCreated: linked });
}));

app.get('/api/link-suggestions/:id', requireAssistant, ah(async (req, res) => {
  const documentId = parseInt(req.params.id);
  const r = await prisma.docIdentification.findUnique({ where: { documentId }, include: { document: { select: { id: true, title: true, docExt: true, createdAt: true } } } });
  if (!r) return res.status(404).json({ error: 'לא נמצא זיהוי למסמך זה' });
  const suggestions = await prisma.linkSuggestion.findMany({ where: { documentId }, include: { sku: true }, orderBy: { id: 'asc' } });
  const rank = { CERTAIN: 3, LIKELY: 2, POSSIBLE: 1 };
  suggestions.sort((a, b) => rank[b.confidence] - rank[a.confidence]);
  res.json({
    document: { id: r.document.id, title: r.document.title, docExt: r.document.docExt, createdAt: r.document.createdAt },
    identification: {
      docKind: r.docKind, certNo: r.certNo, requestNo: r.requestNo, products: r.products,
      manufacturer: r.manufacturer, kashrutBody: r.kashrutBody, track: r.track,
      validUntil: r.validUntil, productionDate: r.productionDate, lots: r.lots,
    },
    candidates: suggestions.map(s => ({
      skuId: s.skuId, code: s.sku.code, name: s.sku.name, supplier: s.sku.supplier || '',
      kashrutBodyRef: s.sku.kashrutBodyRef || '', pesachStatusRef: s.sku.pesachStatusRef || '',
      confidence: s.confidence, reasons: s.reasons, status: s.status,
      preChecked: s.confidence === 'CERTAIN',
    })),
  });
}));

app.post('/api/link-suggestions/:id/link', requireAssistant, ah(async (req, res) => {
  const documentId = parseInt(req.params.id);
  const skuIds = (req.body.skuIds || []).map(Number).filter(Boolean);
  if (!skuIds.length) return res.status(400).json({ error: 'לא נבחרו מק"טים' });
  let created = 0;
  for (const skuId of skuIds) {
    const existing = await prisma.skuLink.findFirst({ where: { documentId, skuId } });
    if (!existing) {
      await prisma.skuLink.create({ data: {
        skuId, docType: 'DOCUMENT', documentId, visibleToCustomer: false,
        approvalStatus: 'APPROVED', isRawMaterial: false, reviewedById: req.user.id || null, reviewedAt: new Date(),
      }});
      created++;
    }
  }
  const allSuggestions = await prisma.linkSuggestion.findMany({ where: { documentId } });
  for (const s of allSuggestions) {
    await prisma.linkSuggestion.update({
      where: { id: s.id },
      data: { status: skuIds.includes(s.skuId) ? 'APPROVED' : 'REJECTED', decidedById: req.user.id || null, decidedAt: new Date() },
    });
  }
  res.json({ ok: true, linksCreated: created });
}));

app.post('/api/link-suggestions/:id/no-sku-needed', requireAssistant, ah(async (req, res) => {
  const documentId = parseInt(req.params.id);
  const { reason } = req.body;
  if (!NO_SKU_REASONS.includes(reason)) return res.status(400).json({ error: 'סיבה לא חוקית' });
  await prisma.document.update({ where: { id: documentId }, data: { noSkuNeeded: true, noSkuNeededReason: reason } });
  res.json({ ok: true });
}));

app.get('/api/link-suggestions/resolve-sku/:code', requireAssistant, ah(async (req, res) => {
  const sku = await prisma.sku.findUnique({ where: { code: req.params.code } });
  if (!sku) return res.status(404).json({ error: 'מק"ט לא נמצא' });
  res.json({ skuId: sku.id });
}));

app.get('/api/link-suggestions/doc-lookup/:id', requireAssistant, ah(async (req, res) => {
  const d = await prisma.document.findUnique({ where: { id: parseInt(req.params.id) }, select: { id: true, title: true, docExt: true, archived: true } });
  if (!d) return res.status(404).json({ error: 'מסמך לא נמצא' });
  res.json(d);
}));

app.post('/api/link-suggestions/:id/mark-duplicate', requireAssistant, ah(async (req, res) => {
  const documentId = parseInt(req.params.id);
  const duplicateOfId = parseInt(req.body.duplicateOfId);
  if (!duplicateOfId) return res.status(400).json({ error: 'לא צוין מסמך מקור' });
  const original = await prisma.document.findUnique({ where: { id: duplicateOfId } });
  if (!original) return res.status(404).json({ error: 'מסמך המקור לא נמצא' });
  await prisma.document.update({ where: { id: documentId }, data: { duplicateOfId } });
  res.json({ ok: true });
}));

/* ── S1: master SKU list import ("📥 ייבוא רשימת מק"טים") ── */
// RFC4180 CSV parser (handles "" escaped quotes and commas inside quoted fields).
function parseSkuMasterCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}
function mapSkuSource(v) {
  v = (v || '').trim();
  if (v === 'יבוא') return 'IMPORT';
  if (v === 'רכש מקומי') return 'LOCAL';
  if (v === 'מותג פרטי') return 'PRIVATE_LABEL';
  return null;
}
function mapSkuItemType(v) {
  v = (v || '').trim();
  if (v === 'לא מוצר') return 'NOT_PRODUCT';
  if (v === 'לבדיקה') return 'REVIEW';
  return 'FOOD';
}
function mapPriorityActive(v) {
  v = (v || '').trim();
  if (v === 'כן') return true;
  if (v === 'לא נמצא ברשימות') return false;
  return null;
}
function parseSkuMasterRow(header, row) {
  const col = (name) => header.indexOf(name);
  const get = (name) => { const i = col(name); return i === -1 ? '' : (row[i] || '').trim(); };
  return {
    code: get('מק"ט'),
    name: get('תיאור'),
    categoryName: get('קטגוריה (פריוריטי)') || null,
    tipus: get('טיפוס') || null,
    source: mapSkuSource(get('מקור (יבוא/רכש מקומי)')),
    supplier: get('ספק 1') || null,
    supplier2: get('ספק 2') || null,
    buyer: get('איש רכש') || null,
    kashrutBodyRef: get('כשרות ימות השנה') || null,
    pesachStatusRef: get('כשרות פסח') || null,
    priorityActive: mapPriorityActive(get('פעיל בפריוריטי (4.11)')),
    itemType: mapSkuItemType(get('סוג פריט')),
  };
}
// The 7 diffable fields per S1's spec wording: category, kashrut, Passover, supplier, buyer, import/local, active.
const SKU_DIFF_FIELDS = [
  { field: 'categoryName', label: 'קטגוריה' },
  { field: 'kashrutBodyRef', label: 'כשרות (ימות השנה)' },
  { field: 'pesachStatusRef', label: 'כשרות פסח' },
  { field: 'supplier', label: 'ספק' },
  { field: 'buyer', label: 'איש רכש' },
  { field: 'source', label: 'מקור (יבוא/רכש מקומי)' },
  { field: 'priorityActive', label: 'פעיל בפריוריטי' },
];

// decode the HTML entities left over from the old single-row Passover design
function decodeSkuEntities(s) {
  return (s || '').replace(/&quot;/g, '"').replace(/&#8211;/g, '–').replace(/&amp;/g, '&');
}
const KASHRUT_HONORIFICS_RE = /(הרב|שליט"?א|שליט״א|רב אב"?ד|רב אב״ד|רב מוכר)/g;
function normalizeKashrutText(s) {
  if (!s) return '';
  let t = decodeSkuEntities(s).replace(KASHRUT_HONORIFICS_RE, ' ');
  t = t.replace(/[.,'"״׳()–—-]/g, ' ').replace(/\s+/g, ' ').trim();
  return t;
}
function kashrutTextsRelate(a, b) {
  const na = normalizeKashrutText(a), nb = normalizeKashrutText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na));
}
// A kashrutBodyRef replacement is "safe" if the new body + new Passover value
// together contain the same information as the decoded old text -- i.e. the
// old single-row design's embedded "(פסח: ...)" note just moved to the
// separate pesachStatusRef column, rather than being lost or contradicted.
function checkKashrutReplacementSafety(oldValue, newKashrutBodyRef, newPesachStatusRef) {
  const decoded = decodeSkuEntities(oldValue || '');
  const parenMatch = decoded.match(/^(.*?)\(([^)]*)\)\s*$/);
  if (!parenMatch) {
    // no embedded note -- just a plain name; safe iff it relates to the new body
    return { safe: kashrutTextsRelate(decoded, newKashrutBodyRef), oldBase: decoded.trim(), oldInner: null };
  }
  const oldBase = parenMatch[1].trim();
  let oldInner = parenMatch[2].trim().replace(/^פסח\s*:?\s*/, '').trim();
  const baseSafe = kashrutTextsRelate(oldBase, newKashrutBodyRef);
  const innerSafe = !oldInner || kashrutTextsRelate(oldInner, newPesachStatusRef);
  return { safe: baseSafe && innerSafe, oldBase, oldInner: oldInner || null };
}

app.post('/api/sku-master-import/preview', requireAuth, requireAdmin, upload.single('file'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  const text = req.file.buffer.toString('utf8');
  const rows = parseSkuMasterCsv(text);
  if (!rows.length) return res.status(400).json({ error: 'קובץ ריק' });
  const header = rows[0];
  const parsedRows = [];
  for (let i = 1; i < rows.length; i++) {
    const parsed = parseSkuMasterRow(header, rows[i]);
    if (parsed.code) parsedRows.push(parsed);
  }

  const codes = parsedRows.map(r => r.code);
  const existingSkus = await prisma.sku.findMany({ where: { code: { in: codes } } });
  const existingByCode = new Map(existingSkus.map(s => [s.code, s]));

  const newSkus = [];
  const changed = [];
  let unchangedCount = 0;

  for (const r of parsedRows) {
    const existing = existingByCode.get(r.code);
    if (!existing) {
      newSkus.push(r);
      continue;
    }
    const changes = [];
    for (const { field, label } of SKU_DIFF_FIELDS) {
      const oldValue = existing[field] ?? null;
      const newValue = r[field] ?? null;
      if ((oldValue || null) !== (newValue || null)) {
        const changeType = (oldValue === null || oldValue === undefined || oldValue === '') ? 'fill' : 'replace';
        const entry = { field, label, oldValue, newValue, changeType };
        if (field === 'kashrutBodyRef' && changeType === 'replace') {
          entry.safety = checkKashrutReplacementSafety(oldValue, r.kashrutBodyRef, r.pesachStatusRef);
        }
        changes.push(entry);
      }
    }
    if (changes.length) changed.push({ code: r.code, name: r.name, changes });
    else unchangedCount++;
  }

  res.json({
    totalRows: parsedRows.length,
    newCount: newSkus.length,
    changedCount: changed.length,
    unchangedCount,
    newSkus,
    changed,
  });
}));

app.post('/api/sku-master-import/apply', requireAuth, requireAdmin, upload.single('file'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'לא נבחר קובץ' });
  const applyFillEmpty = req.body.applyFillEmpty === '1' || req.body.applyFillEmpty === 'true';
  const applySafeKashrutReplacements = req.body.applySafeKashrutReplacements === '1' || req.body.applySafeKashrutReplacements === 'true';
  const createNewSkus = req.body.createNewSkus === '1' || req.body.createNewSkus === 'true';

  const text = req.file.buffer.toString('utf8');
  const rows = parseSkuMasterCsv(text);
  if (!rows.length) return res.status(400).json({ error: 'קובץ ריק' });
  const header = rows[0];
  const parsedRows = [];
  for (let i = 1; i < rows.length; i++) {
    const parsed = parseSkuMasterRow(header, rows[i]);
    if (parsed.code) parsedRows.push(parsed);
  }
  const codes = parsedRows.map(r => r.code);
  const existingSkus = await prisma.sku.findMany({ where: { code: { in: codes } } });
  const existingByCode = new Map(existingSkus.map(s => [s.code, s]));

  const counts = { fillApplied: 0, safeReplaceApplied: 0, unsafeReplaceSkipped: 0, skusUpdated: 0, newSkusCreated: 0, byField: {} };
  const unsafeDetails = [];

  for (const r of parsedRows) {
    const existing = existingByCode.get(r.code);
    if (!existing) {
      if (createNewSkus) {
        // not implemented in this pass -- explicitly excluded by the caller
      }
      continue;
    }
    const updateData = {};
    for (const { field } of SKU_DIFF_FIELDS) {
      const oldValue = existing[field] ?? null;
      const newValue = r[field] ?? null;
      if ((oldValue || null) === (newValue || null)) continue;
      const changeType = (oldValue === null || oldValue === undefined || oldValue === '') ? 'fill' : 'replace';
      if (changeType === 'fill') {
        if (!applyFillEmpty) continue;
        updateData[field] = newValue;
        counts.fillApplied++;
        counts.byField[field] = (counts.byField[field] || 0) + 1;
      } else if (field === 'kashrutBodyRef') {
        const safety = checkKashrutReplacementSafety(oldValue, r.kashrutBodyRef, r.pesachStatusRef);
        if (applySafeKashrutReplacements && safety.safe) {
          updateData[field] = newValue;
          counts.safeReplaceApplied++;
          counts.byField[field] = (counts.byField[field] || 0) + 1;
        } else {
          counts.unsafeReplaceSkipped++;
          unsafeDetails.push({ code: r.code, name: r.name, oldValue, newValue });
        }
      }
      // other "replace" fields: not requested this pass, left untouched
    }
    if (Object.keys(updateData).length) {
      await prisma.sku.update({ where: { code: r.code }, data: updateData });
      counts.skusUpdated++;
    }
  }

  res.json({ ok: true, counts, unsafeSkipped: unsafeDetails });
}));

/* ── S2: goods receipts import ("📦 קליטת דוחות קבלה") -- PREVIEW ONLY ──
 * WMS/Priority exports are usually UTF-16 with cells wrapped as ="value".
 * Nothing in this block writes to the database -- it only reads existing
 * Sku rows (to detect which receipt SKUs already exist) and computes a
 * preview grouped by SKU. No GoodsReceipt/ShelfLifeRule tables exist yet;
 * those are added when the real import (not just preview) is built. */
function decodeGoodsReceiptBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    const body = Buffer.from(buf.slice(2));
    body.swap16();
    return body.toString('utf16le');
  }
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text;
}
function stripEqualsWrapper(v) {
  if (!v) return v;
  const m = /^="?([^"]*)"?$/.exec(v.trim());
  return m ? m[1] : v;
}
function parseGoodsReceiptRow(header, row) {
  const col = (name) => header.indexOf(name);
  const get = (name) => { const i = col(name); if (i === -1) return ''; return stripEqualsWrapper((row[i] || '').trim()); };
  return {
    skuCode: get('פריט'),
    skuName: get('תיאור פריט'),
    receiptNo: get('קליטה'),
    receiptDate: get('תאריך קליטה'),
    expiry: get('פג תוקף'),
    quantity: parseFloat(get('כמות')) || 0,
    batch: get('אצווה') || null,
    productionDate: get('תאריך יצור') || null,
    warehouseGroup: get('קבוצת פריט') || null,
  };
}
// Accepts DD/MM/YYYY, DD-MM-YYYY or ISO YYYY-MM-DD; returns a Date or null.
function parseWmsDate(s) {
  if (!s) return null;
  s = s.trim();
  let m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(s);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d));
    return isNaN(dt) ? null : dt;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) { const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return isNaN(dt) ? null : dt; }
  return null;
}
// Code-level fallback defaults per docrepo-sprint-8.11.md S2: canned
// (שימורים) = 36mo, vacuum (name contains וואקום) = 24mo, else unknown.
// ShelfLifeRule rows (DB-editable, seeded via prisma/seed-shelf-life-rules.js)
// take priority over these -- per-SKU row first, then category row, then the
// code fallback below (which also covers the name-based וואקום rule, not
// modeled as its own DB row since it's a text pattern, not a category/SKU).
function shelfLifeMonthsFor(sku, fallbackName, ruleBySkuId, ruleByCategory) {
  if (sku && ruleBySkuId.has(sku.id)) return ruleBySkuId.get(sku.id);
  if (sku && sku.categoryName && ruleByCategory.has(sku.categoryName)) return ruleByCategory.get(sku.categoryName);
  if (sku && (sku.categoryName || '').includes('שימורים')) return 36;
  const name = (sku && sku.name) || fallbackName || '';
  if (name.includes('וואקום')) return 24;
  return null;
}

function sameCalendarDate(a, b) {
  if (!a || !b) return false;
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}
function lotMatches(batch, text) {
  if (!batch || !text) return false;
  return String(text).toLowerCase().includes(String(batch).toLowerCase());
}
// S2 coverage check (the feature's core purpose): for a receipt of an IMPORT
// SKU, is there an APPROVED linked document that covers it?
// - RABBINATE: the cert's expiry must still be valid on the receipt date.
// - BADATZ_CERT / BADATZ_REPORT / DOCUMENT: match by production date
//   (generic Document only -- BadatzDoc has none) or by LOT/batch substring.
function checkCoverage(sku, receipt, linksBySkuId) {
  if (!sku || sku.source !== 'IMPORT') return { applicable: false, covered: null };
  const links = linksBySkuId.get(sku.id) || [];
  const receiptDate = parseWmsDate(receipt.receiptDate);
  const prodDate = parseWmsDate(receipt.productionDate) ||
    (receipt.estimatedProductionDate ? new Date(receipt.estimatedProductionDate) : null);
  for (const link of links) {
    if (link.docType === 'RABBINATE' && link.rabbinateCert) {
      if (link.rabbinateCert.expiryDate && receiptDate && link.rabbinateCert.expiryDate >= receiptDate) {
        return { applicable: true, covered: true, via: 'RABBINATE', matchedBy: 'VALID_ON_RECEIPT_DATE' };
      }
    }
    if ((link.docType === 'BADATZ_CERT' || link.docType === 'BADATZ_REPORT') && link.badatzDoc) {
      if (lotMatches(receipt.batch, link.badatzDoc.productsText)) {
        return { applicable: true, covered: true, via: link.docType, matchedBy: 'LOT' };
      }
    }
    if (link.docType === 'DOCUMENT' && link.document) {
      if (prodDate && sameCalendarDate(link.document.productionDate, prodDate)) {
        return { applicable: true, covered: true, via: 'DOCUMENT', matchedBy: 'PRODUCTION_DATE' };
      }
      if (lotMatches(receipt.batch, `${link.document.title || ''} ${link.document.description || ''}`)) {
        return { applicable: true, covered: true, via: 'DOCUMENT', matchedBy: 'LOT' };
      }
    }
  }
  return { applicable: true, covered: false, via: null, matchedBy: null };
}

app.post('/api/goods-receipts/preview', requireAuth, requireAdmin, upload.array('files', 20), ah(async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'לא נבחרו קבצים' });

  const allRows = [];
  for (const file of req.files) {
    const text = decodeGoodsReceiptBuffer(file.buffer);
    const rows = parseSkuMasterCsv(text);
    if (!rows.length) continue;
    const header = rows[0];
    for (let i = 1; i < rows.length; i++) {
      const parsed = parseGoodsReceiptRow(header, rows[i]);
      if (parsed.skuCode) allRows.push({ ...parsed, sourceFile: file.originalname });
    }
  }
  if (!allRows.length) return res.status(400).json({ error: 'לא נמצאו שורות תקינות בקבצים' });

  const codes = [...new Set(allRows.map(r => r.skuCode))];
  const existingSkus = await prisma.sku.findMany({ where: { code: { in: codes } } });
  const byCode = new Map(existingSkus.map(s => [s.code, s]));

  const shelfRules = await prisma.shelfLifeRule.findMany();
  const ruleBySkuId = new Map(shelfRules.filter(r => r.skuId != null).map(r => [r.skuId, r.months]));
  const ruleByCategory = new Map(shelfRules.filter(r => r.categoryName).map(r => [r.categoryName, r.months]));

  const importSkuIds = existingSkus.filter(s => s.source === 'IMPORT').map(s => s.id);
  const linksBySkuId = new Map();
  if (importSkuIds.length) {
    const links = await prisma.skuLink.findMany({
      where: { skuId: { in: importSkuIds }, approvalStatus: 'APPROVED' },
      include: { rabbinateCert: true, badatzDoc: true, document: true },
    });
    for (const l of links) {
      if (!linksBySkuId.has(l.skuId)) linksBySkuId.set(l.skuId, []);
      linksBySkuId.get(l.skuId).push(l);
    }
  }

  // Unique key (skuCode, receiptNo, expiry): sum quantity across rows sharing it.
  const groups = new Map();
  for (const r of allRows) {
    const key = `${r.skuCode}::${r.receiptNo}::${r.expiry}`;
    if (!groups.has(key)) groups.set(key, { ...r, quantity: 0 });
    groups.get(key).quantity += r.quantity;
  }

  const bySkuMap = new Map();
  let uncoveredCount = 0;
  for (const g of groups.values()) {
    const sku = byCode.get(g.skuCode) || null;
    const months = shelfLifeMonthsFor(sku, g.skuName, ruleBySkuId, ruleByCategory);
    const expiryDate = parseWmsDate(g.expiry);
    const receiptDate = parseWmsDate(g.receiptDate);
    let estimatedProductionDate = null, flag = null;
    if (!g.productionDate && months != null && expiryDate) {
      const d = new Date(expiryDate);
      d.setUTCMonth(d.getUTCMonth() - months);
      estimatedProductionDate = d.toISOString().slice(0, 10);
      if (receiptDate && d > receiptDate) flag = 'חיי מדף שגויים';
    }
    const coverage = checkCoverage(sku, { ...g, estimatedProductionDate }, linksBySkuId);
    if (coverage.applicable && !coverage.covered) uncoveredCount++;
    if (!bySkuMap.has(g.skuCode)) {
      bySkuMap.set(g.skuCode, { skuCode: g.skuCode, skuName: g.skuName, existingSkuId: sku ? sku.id : null, isNew: !sku, source: sku ? sku.source : null, receipts: [] });
    }
    bySkuMap.get(g.skuCode).receipts.push({
      receiptNo: g.receiptNo, receiptDate: g.receiptDate, expiry: g.expiry, quantity: g.quantity,
      batch: g.batch, productionDate: g.productionDate, shelfLifeMonthsUsed: months,
      estimatedProductionDate, flag, sourceFile: g.sourceFile,
      coverageApplicable: coverage.applicable, covered: coverage.covered, coverageVia: coverage.via, coverageMatchedBy: coverage.matchedBy,
    });
  }

  const bySku = [...bySkuMap.values()].sort((a, b) => a.skuCode.localeCompare(b.skuCode));
  const newSkus = bySku.filter(s => s.isNew).map(s => ({ code: s.skuCode, name: s.skuName }));

  res.json({
    filesProcessed: req.files.length,
    rowsParsed: allRows.length,
    receiptGroups: groups.size,
    skuCount: bySku.length,
    newSkuCount: newSkus.length,
    uncoveredCount,
    bySku,
    newSkus,
  });
}));

/* ── S3: dashboard ("לוח טיפול") home-screen cards ──
 * Read-only. Reachable as a new screen, not yet wired as the actual home
 * page (docrepo-sprint-8.11.md: "this replaces [the Google-Sheet dashboard]
 * later, once I approve"). computeDashboardCards() returns every card's
 * FULL (uncapped) item list; /cards caps it for display, /export uses the
 * full list for one card. Category filtering only applies to cards with an
 * unambiguous, direct Sku relation (1, 2, 3, 6, 7) -- see categoryFilterApplicable.
 */
const DASHBOARD_LIST_CAP = 500;

async function computeDashboardCards(categories) {
  const today = new Date();
  const in60 = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);
  const catFilter = (categories && categories.length) ? { categoryName: { in: categories } } : {};

  const allCategories = (await prisma.sku.findMany({
    where: { categoryName: { not: null } }, select: { categoryName: true }, distinct: ['categoryName'],
  })).map(r => r.categoryName).sort();

  // 1. מק"טי יבוא פעילים בלי תעודה בתוקף
  const importFoodActive = await prisma.sku.findMany({
    where: { source: 'IMPORT', itemType: 'FOOD', active: true, ...catFilter },
    include: {
      links: { include: { rabbinateCert: true } },
      linkSuggestions: { where: { status: 'PENDING' } }, // re-sorted by real confidence rank below
    },
  });
  const CONF_RANK = { CERTAIN: 0, LIKELY: 1, POSSIBLE: 2 };
  const noValidCert = importFoodActive.filter(s =>
    !s.links.some(l => l.docType === 'RABBINATE' && l.approvalStatus === 'APPROVED' && l.rabbinateCert && l.rabbinateCert.expiryDate && l.rabbinateCert.expiryDate >= today));
  const card1Items = noValidCert.map(s => {
    const pending = s.linkSuggestions.slice().sort((a, b) => CONF_RANK[a.confidence] - CONF_RANK[b.confidence]);
    const best = pending[0] || null;
    const bucket = best ? 'PENDING_SUGGESTION' : (s.links.length === 0 && s.linkSuggestions.length === 0 ? 'NO_DOCUMENT' : 'OTHER');
    return {
      code: s.code, name: s.name, categoryName: s.categoryName, kashrutBodyRef: s.kashrutBodyRef, buyer: s.buyer, supplier: s.supplier,
      bestPendingConfidence: best ? best.confidence : null, bestPendingDocumentId: best ? best.documentId : null, bucket,
    };
  });

  // 2. תעודות שפגות ב-60 יום
  const expiringLinks = await prisma.skuLink.findMany({
    where: {
      approvalStatus: 'APPROVED',
      sku: Object.keys(catFilter).length ? catFilter : undefined,
      OR: [
        { rabbinateCert: { expiryDate: { gte: today, lte: in60 } } },
        { badatzDoc: { expiryDate: { gte: today, lte: in60 } } },
        { document: { expiryDate: { gte: today, lte: in60 }, trashedAt: null } },
      ],
    },
    include: { sku: true, rabbinateCert: true, badatzDoc: true, document: true },
  });
  const card2Items = expiringLinks.map(l => {
    const doc = l.rabbinateCert || l.badatzDoc || l.document;
    return {
      skuCode: l.sku.code, skuName: l.sku.name, categoryName: l.sku.categoryName, kashrutBodyRef: l.sku.kashrutBodyRef, buyer: l.sku.buyer, supplier: l.sku.supplier,
      docType: l.docType, expiryDate: doc && doc.expiryDate,
    };
  });

  // 3. ייצורים לא מכוסים (from S2 -- empty until a real receipt import is approved)
  const uncoveredReceipts = await prisma.goodsReceipt.findMany({
    where: { covered: false, sku: Object.keys(catFilter).length ? catFilter : undefined },
    include: { sku: true },
  });
  const card3Items = uncoveredReceipts.map(r => ({
    skuCode: r.sku.code, skuName: r.sku.name, categoryName: r.sku.categoryName, kashrutBodyRef: r.sku.kashrutBodyRef, buyer: r.sku.buyer, supplier: r.sku.supplier,
    receiptNo: r.receiptNo, receiptDate: r.receiptDate,
  }));

  // 4. בקשות לרבנות ממתינות (from TrackingSheetMap) -- no direct Sku/category relation
  const pendingRequests = await prisma.trackingSheetMap.findMany({
    where: { kind: 'REQUEST', requestStatus: { startsWith: 'הוגש' } },
  });
  const card4Items = pendingRequests.map(r => ({
    refNumber: r.refNumber, product: r.product,
    daysWaiting: r.submittedDate ? Math.floor((today - r.submittedDate) / (24 * 60 * 60 * 1000)) : null,
  }));

  // 5. חומרי גלם ממתינים לתשובה / נדחו -- no direct Sku/category relation (RawMaterial<->Sku is many-to-many)
  const pendingOrRejectedRM = await prisma.rawMaterialApproval.findMany({
    where: { status: { in: ['SENT_PENDING', 'REJECTED'] } },
    include: { rawMaterial: true, kashrutBody: true },
  });
  const card5Items = pendingOrRejectedRM.map(a => ({
    rawMaterialId: a.rawMaterialId, rawMaterialName: a.rawMaterial.name, kashrutBodyName: a.kashrutBody.name, status: a.status,
  }));

  // 6. הצעות קישור ממתינות, by confidence
  const pendingSuggestionsByConfidence = await prisma.linkSuggestion.groupBy({
    by: ['confidence'],
    where: { status: 'PENDING', sku: Object.keys(catFilter).length ? catFilter : undefined },
    _count: true,
  });

  // 7. מק"טים חדשים להשלמה (from S1/S2 origins, plus the pre-existing legacy backlog)
  const newSkusToComplete = await prisma.sku.findMany({
    where: { reviewedAt: null, origin: { hasSome: ['priority_report', 'master_sku_import', 'goods_receipt'] }, ...catFilter },
  });
  const card7Items = newSkusToComplete.map(s => ({
    code: s.code, name: s.name, categoryName: s.categoryName, kashrutBodyRef: s.kashrutBodyRef, buyer: s.buyer, supplier: s.supplier, origin: s.origin,
  }));

  // 8. מסמכים חדשים לא מעובדים (the L6 badge's X -- docs never run through L1) -- no direct category relation
  const unprocessedDocs = await prisma.document.findMany({
    where: { archived: false, hidden: false, trashedAt: null, identification: null },
    select: { id: true, title: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  const card8Items = unprocessedDocs.map(d => ({ id: d.id, title: d.title, createdAt: d.createdAt }));

  return {
    allCategories,
    cards: {
      'import-no-cert': { title: 'מק"טי יבוא פעילים בלי תעודה בתוקף', categoryFilterApplicable: true, items: card1Items },
      'expiring-60': { title: 'תעודות שפגות ב-60 יום', categoryFilterApplicable: true, items: card2Items },
      'uncovered-receipts': { title: 'ייצורים לא מכוסים', categoryFilterApplicable: true, items: card3Items },
      'pending-requests': { title: 'בקשות לרבנות ממתינות', categoryFilterApplicable: false, items: card4Items },
      'rm-pending-rejected': { title: 'חומרי גלם ממתינים לתשובה / נדחו', categoryFilterApplicable: false, items: card5Items },
      'pending-suggestions': {
        title: 'הצעות קישור ממתינות', categoryFilterApplicable: true, items: [],
        byConfidence: pendingSuggestionsByConfidence.map(g => ({ confidence: g.confidence, count: g._count })),
        count: pendingSuggestionsByConfidence.reduce((n, g) => n + g._count, 0),
      },
      'new-skus': { title: 'מק"טים חדשים להשלמה', categoryFilterApplicable: true, items: card7Items },
      'unprocessed-docs': { title: 'מסמכים חדשים לא מעובדים', categoryFilterApplicable: false, items: card8Items },
    },
  };
}

function dashParseCategories(req) {
  const raw = req.query.categories;
  if (!raw) return [];
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

app.get('/api/dashboard/cards', requireAuth, ah(async (req, res) => {
  const categories = dashParseCategories(req);
  const data = await computeDashboardCards(categories);
  const cards = Object.entries(data.cards).map(([id, c]) => ({
    id, title: c.title, categoryFilterApplicable: c.categoryFilterApplicable,
    count: c.count !== undefined ? c.count : c.items.length,
    byConfidence: c.byConfidence,
    items: c.items.slice(0, DASHBOARD_LIST_CAP),
    truncated: c.items.length > DASHBOARD_LIST_CAP,
  }));
  res.json({ allCategories: data.allCategories, appliedCategories: categories, cards });
}));

const DASH_EXPORT_COLUMNS = {
  'import-no-cert': [['code','מק"ט'],['name','תיאור'],['categoryName','קטגוריה'],['kashrutBodyRef','כשרות'],['buyer','איש רכש'],['supplier','ספק'],['bestPendingConfidence','הצעת קישור ממתינה'],['bucket','מצב']],
  'expiring-60': [['skuCode','מק"ט'],['skuName','תיאור'],['categoryName','קטגוריה'],['kashrutBodyRef','כשרות'],['buyer','איש רכש'],['supplier','ספק'],['docType','סוג מסמך'],['expiryDate','תוקף']],
  'uncovered-receipts': [['skuCode','מק"ט'],['skuName','תיאור'],['categoryName','קטגוריה'],['kashrutBodyRef','כשרות'],['buyer','איש רכש'],['supplier','ספק'],['receiptNo','קליטה'],['receiptDate','תאריך קליטה']],
  'pending-requests': [['refNumber','סימוכין'],['product','מוצר'],['daysWaiting','ימי המתנה']],
  'rm-pending-rejected': [['rawMaterialName','חומר גלם'],['kashrutBodyName','גוף כשרות'],['status','סטטוס']],
  'pending-suggestions': [['confidence','רמת ביטחון'],['count','כמות']],
  'new-skus': [['code','מק"ט'],['name','תיאור'],['categoryName','קטגוריה'],['kashrutBodyRef','כשרות'],['buyer','איש רכש'],['supplier','ספק'],['origin','מקור']],
  'unprocessed-docs': [['id','מזהה'],['title','כותרת'],['createdAt','נוצר']],
};

app.get('/api/dashboard/cards/:cardId/export', requireAuth, ah(async (req, res) => {
  const XLSX = require('xlsx');
  const categories = dashParseCategories(req);
  const data = await computeDashboardCards(categories);
  const card = data.cards[req.params.cardId];
  const cols = DASH_EXPORT_COLUMNS[req.params.cardId];
  if (!card || !cols) return res.status(404).json({ error: 'כרטיס לא נמצא' });

  const rows = req.params.cardId === 'pending-suggestions' ? (card.byConfidence || []) : card.items;
  const sheetRows = rows.map(r => {
    const out = {};
    for (const [field, label] of cols) {
      let v = r[field];
      if (Array.isArray(v)) v = v.join(', ');
      if (v instanceof Date) v = v.toISOString().slice(0, 10);
      out[label] = v === null || v === undefined ? '' : v;
    }
    return out;
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheetRows, { header: cols.map(c => c[1]) });
  XLSX.utils.book_append_sheet(wb, ws, card.title.slice(0, 31));
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="dashboard-${req.params.cardId}.xlsx"`);
  res.send(buf);
}));

app.get('*', (_req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, () => {
  console.log(`\n מאגר מסמכים פועל על http://localhost:${PORT}`);
  console.log(`  כניסת מנהל: admin / 1234 (אם זו הרצה ראשונה)\n`);
});
