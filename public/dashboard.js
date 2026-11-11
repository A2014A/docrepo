/* S3 (docrepo-sprint-8.11.md) -- "🏠 לוח טיפול" dashboard home screen.
 * Self-contained, like the other S and L screens: index.html only got a nav
 * button, one empty container, and this <script> tag.
 * Read-only (except "הסר סימון חדש", which reuses the existing PATCH
 * /api/skus/:code that already sets reviewedAt). NOT yet wired as the
 * actual home screen -- reachable via the nav, per the spec's "this
 * replaces [the Sheet dashboard] later, once I approve."
 */

let DASH_DATA = null;
let DASH_OPEN_CARD = null;
let DASH_SELECTED_CATEGORIES = new Set();
let DASH_CARD1_QUICK_FILTER = 'ALL'; // ALL | NO_DOCUMENT | PENDING_SUGGESTION | OTHER

// Document preview panel (task: "document preview in the dashboard lists").
// Reuses the existing /api/link-suggestions/:id GET and .../:id/link POST --
// no new write route. ACCEPTED/REJECTED are local toggle state; REJECTED by
// itself never writes anything (the existing /link endpoint requires a
// non-empty skuIds array), it only shapes what the *next* ✔ submit excludes.
let DASH_PREVIEW_DOC_LIST = [];
let DASH_PREVIEW_CURRENT_ID = null;
let DASH_PREVIEW_DATA = null;
let DASH_PREVIEW_SOURCE_CARD = null;
let DASH_PREVIEW_ACCEPTED = new Set();
let DASH_PREVIEW_REJECTED = new Set();

const DASH_COL_LABELS = {
  code: 'מק"ט', name: 'תיאור', skuCode: 'מק"ט', skuName: 'תיאור',
  categoryName: 'קטגוריה', kashrutBodyRef: 'כשרות', buyer: 'איש רכש', supplier: 'ספק',
  bestPendingConfidence: 'הצעת קישור ממתינה', bucket: 'מצב',
  docType: 'סוג מסמך', expiryDate: 'תוקף',
  receiptNo: 'קליטה', receiptDate: 'תאריך קליטה',
  refNumber: 'סימוכין', product: 'מוצר', daysWaiting: 'ימי המתנה',
  rawMaterialName: 'חומר גלם', kashrutBodyName: 'גוף כשרות', status: 'סטטוס',
  origin: 'מקור', id: 'מזהה', title: 'כותרת', createdAt: 'נוצר',
};
const DASH_BUCKET_LABEL = { NO_DOCUMENT: 'אין שום מסמך', PENDING_SUGGESTION: 'יש הצעה ממתינה', OTHER: 'אחר' };
// Columns hidden from the on-screen table (used internally for actions, e.g. bestPendingDocumentId).
const DASH_HIDDEN_COLS = new Set(['bestPendingDocumentId', 'rawMaterialId']);

function dashInjectStyles() {
  if (document.getElementById('dashStyles')) return;
  const style = document.createElement('style');
  style.id = 'dashStyles';
  style.textContent = `
    .dash-wrap{max-width:1200px;margin:0 auto;padding:20px}
    .dash-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
    .dash-cat-wrap{position:relative}
    .dash-cat-menu{position:absolute;top:100%;right:0;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.15);padding:10px;max-height:280px;overflow-y:auto;z-index:20;min-width:220px}
    .dash-cat-menu label{display:block;padding:3px 0;font-size:13px;white-space:nowrap}
    .dash-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-bottom:16px}
    .dash-card{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.08);cursor:pointer;transition:box-shadow .15s}
    .dash-card:hover{box-shadow:0 2px 10px rgba(0,0,0,.15)}
    .dash-card.active{border:2px solid var(--accent,#2e6e9e)}
    .dash-card b{font-size:28px;display:block;margin-bottom:4px}
    .dash-card b.zero{color:#999}
    .dash-card b.nonzero{color:#c0612f}
    .dash-card .dash-title{font-size:13px;color:#555}
    .dash-detail{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:16px;overflow-x:auto}
    .dash-detail-head{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
    .dash-quick-filters{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
    .dash-quick-filters button{font-size:12px;padding:4px 10px;border-radius:14px;border:1px solid #ccc;background:#fafafa;cursor:pointer}
    .dash-quick-filters button.active{background:var(--accent,#2e6e9e);color:#fff;border-color:transparent}
    .dash-table{width:100%;border-collapse:collapse;font-size:13px;min-width:600px}
    .dash-table th,.dash-table td{padding:6px 8px;text-align:right;border-bottom:1px solid #eee;white-space:nowrap}
    .dash-table th{color:#666;font-weight:600;background:#fafafa}
    .dash-conf{display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap}
    .dash-conf span{padding:4px 10px;border-radius:10px;font-size:12px;color:#fff}
    .dash-conf .CERTAIN{background:#2e9e4a}.dash-conf .LIKELY{background:#d9a429}.dash-conf .POSSIBLE{background:#c0612f}
    .dash-row-actions{display:flex;gap:4px;flex-wrap:wrap}
    .dash-row-actions button{font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;white-space:nowrap}
    .dash-row-actions button:hover{background:#f0f0f0}
    @media (max-width:600px){.dash-grid{grid-template-columns:repeat(2,1fr)}.dash-card b{font-size:22px}}

    .dash-preview-overlay{position:fixed;inset:0;background:#fff;z-index:100;display:flex;flex-direction:column}
    .dash-preview-topbar{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid #eee;flex-shrink:0}
    .dash-preview-body{flex:1;display:flex;overflow:hidden}
    .dash-preview-left{width:380px;flex-shrink:0;overflow-y:auto;padding:16px;border-left:1px solid #eee}
    .dash-preview-right{flex:1;background:#525659;display:flex;align-items:center;justify-content:center}
    .dash-preview-right iframe,.dash-preview-right img{width:100%;height:100%;border:none;object-fit:contain}
    .dash-field{margin-bottom:6px;font-size:13px}
    .dash-cand-card{border:1px solid #eee;border-radius:8px;padding:8px;margin-bottom:8px}
    .dash-cand-card.accepted{border-color:#2e9e4a;background:#f3fbf5}
    .dash-cand-card.rejected{opacity:.45;text-decoration:line-through}
    .dash-cand-actions{display:flex;gap:6px;margin-top:6px}
    .dash-cand-actions button{font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer}
    @media (max-width:800px){
      .dash-preview-body{flex-direction:column}
      .dash-preview-left{width:auto;border-left:none;border-bottom:1px solid #eee;max-height:50vh}
      .dash-preview-right{flex:1}
    }
  `;
  document.head.appendChild(style);
}

function dashBuildPageShell() {
  const page = document.getElementById('dashboardPage');
  if (page.dataset.built) return;
  page.dataset.built = '1';
  page.innerHTML = `
    <div class="dash-wrap">
      <h2 style="margin-bottom:16px">🏠 לוח טיפול <button class="btn btn-outline" style="margin-right:12px;padding:4px 10px;font-size:13px" onclick="closeDashboard()">✕ סגור</button></h2>
      <div class="dash-toolbar">
        <div class="dash-cat-wrap">
          <button class="btn btn-outline" onclick="dashToggleCatMenu()">קטגוריות <span id="dashCatLabel">(הכל)</span></button>
          <div class="dash-cat-menu" id="dashCatMenu" style="display:none"></div>
        </div>
        <span class="dash-hint" style="color:#888;font-size:12px">הסינון חל רק על כרטיסים מבוססי מק"ט (מסומן ליד השם)</span>
      </div>
      <div id="dashGrid" class="dash-grid"><p style="color:#888">טוען...</p></div>
      <div id="dashDetail"></div>
    </div>`;
  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('dashCatWrap') || document.querySelector('.dash-cat-wrap');
    if (wrap && !wrap.contains(e.target)) { const m = document.getElementById('dashCatMenu'); if (m) m.style.display = 'none'; }
  });
}

async function openDashboard() {
  dashInjectStyles();
  dashBuildPageShell();
  document.querySelector('.hero') && (document.querySelector('.hero').style.display = 'none');
  document.getElementById('statsBar') && (document.getElementById('statsBar').style.display = 'none');
  document.querySelector('main.main') && (document.querySelector('main.main').style.display = 'none');
  document.getElementById('dashboardPage').style.display = 'block';
  await dashLoad();
}

function closeDashboard() {
  document.getElementById('dashboardPage').style.display = 'none';
  document.querySelector('.hero') && (document.querySelector('.hero').style.display = '');
  document.getElementById('statsBar') && (document.getElementById('statsBar').style.display = '');
  document.querySelector('main.main') && (document.querySelector('main.main').style.display = '');
}

function dashToggleCatMenu() {
  const m = document.getElementById('dashCatMenu');
  m.style.display = m.style.display === 'none' ? 'block' : 'none';
}

async function dashLoad() {
  try {
    const params = new URLSearchParams();
    if (DASH_SELECTED_CATEGORIES.size) params.set('categories', [...DASH_SELECTED_CATEGORIES].join(','));
    const res = await fetch(API + '/api/dashboard/cards?' + params.toString(), { headers: authHeaders() });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'שגיאה'); }
    DASH_DATA = await res.json();
    dashRenderCatMenu();
    dashRenderGrid();
  } catch (e) {
    document.getElementById('dashGrid').innerHTML = `<p style="color:#c0612f">שגיאה: ${jsAttr(e.message)}</p>`;
  }
}

function dashRenderCatMenu() {
  const menu = document.getElementById('dashCatMenu');
  menu.innerHTML = DASH_DATA.allCategories.map(c => `
    <label><input type="checkbox" value="${jsAttr(c)}" ${DASH_SELECTED_CATEGORIES.has(c) ? 'checked' : ''} onchange="dashToggleCategory('${jsAttr(c)}')"/> ${jsAttr(c)}</label>
  `).join('') || '<span style="color:#888;font-size:12px">אין קטגוריות</span>';
  document.getElementById('dashCatLabel').textContent = DASH_SELECTED_CATEGORIES.size
    ? `(${DASH_SELECTED_CATEGORIES.size} נבחרו)` : '(הכל)';
}

function dashToggleCategory(cat) {
  if (DASH_SELECTED_CATEGORIES.has(cat)) DASH_SELECTED_CATEGORIES.delete(cat);
  else DASH_SELECTED_CATEGORIES.add(cat);
  dashLoad();
}

function dashRenderGrid() {
  const el = document.getElementById('dashGrid');
  el.innerHTML = DASH_DATA.cards.map(c => `
    <div class="dash-card ${DASH_OPEN_CARD === c.id ? 'active' : ''}" onclick="dashToggleCard('${jsAttr(c.id)}')">
      <b class="${c.count ? 'nonzero' : 'zero'}">${c.count}</b>
      <div class="dash-title">${jsAttr(c.title)}${c.categoryFilterApplicable ? ' 🏷' : ''}</div>
    </div>`).join('');
  dashRenderDetail();
}

function dashToggleCard(id) {
  DASH_OPEN_CARD = (DASH_OPEN_CARD === id) ? null : id;
  DASH_CARD1_QUICK_FILTER = 'ALL';
  dashRenderGrid();
}

function dashFmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toISOString().slice(0, 10);
}
function dashFmtVal(col, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (col === 'bucket') return DASH_BUCKET_LABEL[v] || v;
  if (col.toLowerCase().includes('date') || col === 'createdAt') return dashFmtDate(v);
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function dashSetQuickFilter(f) { DASH_CARD1_QUICK_FILTER = f; dashRenderDetail(); }

function dashVisibleItems(card) {
  if (card.id !== 'import-no-cert' || DASH_CARD1_QUICK_FILTER === 'ALL') return card.items;
  return card.items.filter(it => it.bucket === DASH_CARD1_QUICK_FILTER);
}

// Per-row action buttons, matching the spec's three actions plus a couple of
// screen-specific ones (card 7's "remove new flag", built on the existing
// reviewedAt-setting PATCH /api/skus/:code -- no new backend needed for it).
function dashRowActions(cardId, it) {
  const btns = [];
  if (it.code) btns.push(`<button onclick='dashOpenSku("${jsAttr(it.code)}")'>פתח מק"ט</button>`);
  if (it.skuCode) btns.push(`<button onclick='dashOpenSku("${jsAttr(it.skuCode)}")'>פתח מק"ט</button>`);
  if (cardId === 'import-no-cert') {
    if (it.bucket === 'PENDING_SUGGESTION' && it.bestPendingDocumentId) {
      btns.push(`<button onclick='dashOpenDocPreview(${it.bestPendingDocumentId})'>👁 צפה</button>`);
    } else {
      btns.push(`<button onclick='dashRequestCert("${jsAttr(it.code)}","${jsAttr(it.name || '')}")'>בקש תעודה מגוף כשרות</button>`);
    }
  }
  if (cardId === 'expiring-60' || cardId === 'uncovered-receipts') {
    btns.push(`<button onclick='dashRequestCert("${jsAttr(it.skuCode)}","${jsAttr(it.skuName || '')}")'>בקש תעודה מגוף כשרות</button>`);
  }
  if (cardId === 'rm-pending-rejected' && it.rawMaterialId) {
    btns.push(`<button onclick='dashOpenRawMaterial(${it.rawMaterialId})'>קשר מסמך</button>`);
  }
  if (cardId === 'unprocessed-docs') {
    btns.push(`<button onclick='dashOpenDocPreview(${it.id})'>👁 צפה</button>`);
  }
  if (cardId === 'new-skus' && !isReadOnlyMode()) {
    btns.push(`<button onclick='dashUnmarkNew("${jsAttr(it.code)}")'>הסר סימון חדש</button>`);
  }
  return btns.join('');
}

function dashOpenSku(code) {
  openSkuManager();
  const input = document.getElementById('skuListSearch');
  if (input) { input.value = code; loadSkuList(); }
}
async function dashOpenRawMaterial(rawMaterialId) {
  await openRawMaterialsRegistry();
  rmOpenCard(rawMaterialId);
}
function dashRequestCert(code, name) {
  // D3b ("כל מה שחסר לגוף...") is a future flow per docrepo-sprint-8.11.md,
  // not built yet -- this is an honest stub, not a fake send.
  showToast(`בקשת תעודה אוטומטית לגוף כשרות עדיין לא נבנתה (D3b). מק"ט: ${code}${name ? ' — ' + name : ''}`);
}
async function dashUnmarkNew(code) {
  try {
    await fetch(API + '/api/skus/' + encodeURIComponent(code), { method: 'PATCH', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    showToast('הוסר סימון "חדש" למק"ט ' + code);
    await dashLoad();
  } catch (e) { showToast(e.message); }
}

function dashRenderDetail() {
  const el = document.getElementById('dashDetail');
  if (!DASH_OPEN_CARD) { el.innerHTML = ''; return; }
  const card = DASH_DATA.cards.find(c => c.id === DASH_OPEN_CARD);
  if (!card) { el.innerHTML = ''; return; }

  const items = dashVisibleItems(card);
  let html = `<div class="dash-detail">
    <div class="dash-detail-head">
      <h3 style="margin:0">${jsAttr(card.title)} (${items.length}${items.length !== card.count ? ' / ' + card.count : ''})</h3>
      <button class="btn btn-outline" style="margin-right:auto;font-size:12px;padding:4px 10px" onclick='dashExport("${jsAttr(card.id)}")'>📊 ייצוא לאקסל</button>
    </div>`;

  if (card.byConfidence) {
    html += '<div class="dash-conf">' + card.byConfidence.map(g => `<span class="${g.confidence}">${g.confidence}: ${g.count}</span>`).join('') + '</div>';
  }

  if (card.id === 'import-no-cert') {
    const b = { NO_DOCUMENT: 0, PENDING_SUGGESTION: 0, OTHER: 0 };
    for (const it of card.items) b[it.bucket] = (b[it.bucket] || 0) + 1;
    html += `<div class="dash-quick-filters">
      <button class="${DASH_CARD1_QUICK_FILTER === 'ALL' ? 'active' : ''}" onclick="dashSetQuickFilter('ALL')">הכל (${card.items.length})</button>
      <button class="${DASH_CARD1_QUICK_FILTER === 'NO_DOCUMENT' ? 'active' : ''}" onclick="dashSetQuickFilter('NO_DOCUMENT')">אין שום מסמך (${b.NO_DOCUMENT})</button>
      <button class="${DASH_CARD1_QUICK_FILTER === 'PENDING_SUGGESTION' ? 'active' : ''}" onclick="dashSetQuickFilter('PENDING_SUGGESTION')">יש הצעה ממתינה (${b.PENDING_SUGGESTION})</button>
      <button class="${DASH_CARD1_QUICK_FILTER === 'OTHER' ? 'active' : ''}" onclick="dashSetQuickFilter('OTHER')">אחר (${b.OTHER})</button>
    </div>`;
  }

  if (!items.length) {
    html += '<p style="color:#888">אין פריטים.</p>';
  } else {
    const cols = Object.keys(items[0]).filter(k => !DASH_HIDDEN_COLS.has(k));
    const hasActions = ['import-no-cert', 'expiring-60', 'uncovered-receipts', 'rm-pending-rejected', 'unprocessed-docs', 'new-skus'].includes(card.id);
    html += `<table class="dash-table"><thead><tr>${cols.map(c => `<th>${jsAttr(DASH_COL_LABELS[c] || c)}</th>`).join('')}${hasActions ? '<th>פעולות</th>' : ''}</tr></thead><tbody>`;
    for (const it of items) {
      html += '<tr>' + cols.map(c => `<td>${jsAttr(dashFmtVal(c, it[c]))}</td>`).join('');
      if (hasActions) html += `<td><div class="dash-row-actions">${dashRowActions(card.id, it)}</div></td>`;
      html += '</tr>';
    }
    html += '</tbody></table>';
  }
  html += '</div>';
  el.innerHTML = html;
}

async function dashExport(cardId) {
  try {
    const params = new URLSearchParams();
    if (DASH_SELECTED_CATEGORIES.size) params.set('categories', [...DASH_SELECTED_CATEGORIES].join(','));
    const res = await fetch(API + '/api/dashboard/cards/' + cardId + '/export?' + params.toString(), { headers: authHeaders() });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'שגיאה'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `dashboard-${cardId}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) { showToast(e.message); }
}

/* ---------- document preview panel ---------- */
// Side-by-side on a wide screen, full screen with a "→ חזרה" back button on
// a phone (see .dash-preview-overlay / .dash-preview-left media query).
// Arrow up/down navigates the SAME list the row was opened from (respecting
// the active quick filter), scoped per source card.

function dashPreviewBuildNavList() {
  const card = DASH_DATA.cards.find(c => c.id === DASH_OPEN_CARD);
  if (!card) return [];
  const items = dashVisibleItems(card);
  if (card.id === 'import-no-cert') return items.filter(it => it.bucket === 'PENDING_SUGGESTION').map(it => it.bestPendingDocumentId);
  if (card.id === 'unprocessed-docs') return items.map(it => it.id);
  return [];
}

function dashBuildPreviewOverlay() {
  if (document.getElementById('dashPreviewOverlay')) return;
  const ov = document.createElement('div');
  ov.id = 'dashPreviewOverlay';
  ov.className = 'dash-preview-overlay';
  ov.innerHTML = `
    <div class="dash-preview-topbar">
      <button class="btn btn-outline" onclick="dashClosePreview()">→ חזרה</button>
      <span id="dashPreviewPos" style="color:#888;font-size:13px"></span>
      <span style="margin-right:auto"></span>
      ${isReadOnlyMode() ? '' : `<button class="btn btn-outline" onclick="dashOpenArchivePanel()">🗄 העבר לארכיון</button>
      <button class="btn btn-outline" onclick="dashTrashCurrent()">🗑 העבר לפח</button>`}
      <button class="btn btn-outline" onclick="dashPreviewPrev()" title="הקודם (↑)">↑</button>
      <button class="btn btn-outline" onclick="dashPreviewNext()" title="הבא (↓)">↓</button>
    </div>
    <div class="dash-preview-body">
      <div class="dash-preview-left" id="dashPreviewLeft"></div>
      <div class="dash-preview-right" id="dashPreviewRight"></div>
    </div>`;
  document.body.appendChild(ov);
}

async function dashOpenDocPreview(documentId) {
  DASH_PREVIEW_SOURCE_CARD = DASH_OPEN_CARD;
  DASH_PREVIEW_DOC_LIST = dashPreviewBuildNavList();
  if (!DASH_PREVIEW_DOC_LIST.includes(documentId)) DASH_PREVIEW_DOC_LIST.unshift(documentId);
  dashBuildPreviewOverlay();
  if (!window._dashPreviewKeyBound) { document.addEventListener('keydown', dashPreviewKeyHandler); window._dashPreviewKeyBound = true; }
  await dashLoadPreviewDoc(documentId);
}

function dashClosePreview() {
  const ov = document.getElementById('dashPreviewOverlay');
  if (ov) ov.remove();
  DASH_PREVIEW_DATA = null;
  DASH_PREVIEW_CURRENT_ID = null;
}

async function dashLoadPreviewDoc(documentId) {
  DASH_PREVIEW_CURRENT_ID = documentId;
  DASH_PREVIEW_ACCEPTED = new Set();
  DASH_PREVIEW_REJECTED = new Set();
  try {
    const res = await fetch(API + '/api/link-suggestions/' + documentId, { headers: authHeaders() });
    if (res.status === 404) {
      // No L1 identification yet (e.g. "מסמכים חדשים לא מעובדים" -- by
      // definition never run through L1). Fall back to a bare document view;
      // manual linking still works through the same /link route below.
      const doc = await fetch(API + '/api/link-suggestions/doc-lookup/' + documentId, { headers: authHeaders() }).then(r => r.json());
      DASH_PREVIEW_DATA = { document: doc, identification: null, candidates: [] };
    } else if (!res.ok) {
      throw new Error('שגיאה בטעינת המסמך');
    } else {
      DASH_PREVIEW_DATA = await res.json();
    }
  } catch (e) { showToast(e.message); dashClosePreview(); return; }
  for (const c of DASH_PREVIEW_DATA.candidates) if (c.preChecked) DASH_PREVIEW_ACCEPTED.add(c.skuId);
  const idx = DASH_PREVIEW_DOC_LIST.indexOf(documentId);
  const posEl = document.getElementById('dashPreviewPos');
  if (posEl) posEl.textContent = idx >= 0 ? `${idx + 1} / ${DASH_PREVIEW_DOC_LIST.length}` : '';
  dashPreviewRenderLeft();
  dashPreviewRenderRight();
}

// Best-effort validity: L1's validUntil, else a date pattern found in the
// title/filename, else "unknown". Red badge when the date is in the past.
function dashExtractDateFromTitle(title) {
  if (!title) return null;
  const m = title.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = '20' + y;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  return isNaN(dt) ? null : dt;
}
function dashPreviewValidityHtml() {
  const d = DASH_PREVIEW_DATA;
  const id = d.identification;
  let validUntil = id && id.validUntil ? new Date(id.validUntil) : null;
  let guessed = false;
  if (!validUntil) { validUntil = dashExtractDateFromTitle(d.document.title); guessed = true; }
  if (!validUntil) return `<div style="font-size:20px;font-weight:700;margin-bottom:10px;color:#888">תוקף לא ידוע</div>`;
  const isPast = validUntil < new Date();
  return `<div style="font-size:20px;font-weight:700;margin-bottom:10px">
    תוקף: ${dashFmtDate(validUntil)}${guessed ? ' <span style="font-size:12px;color:#888;font-weight:400">(משוער משם הקובץ)</span>' : ''}
    ${isPast ? '<span style="background:#c0612f;color:#fff;font-size:12px;font-weight:700;padding:2px 10px;border-radius:10px;margin-right:8px">⚠ פג תוקף</span>' : ''}
  </div>`;
}

function dashPreviewRenderLeft() {
  const d = DASH_PREVIEW_DATA;
  const id = d.identification;
  const left = document.getElementById('dashPreviewLeft');
  const idHtml = !id ? `
    <div class="dash-field" style="color:#c0612f">⚠ מסמך זה עדיין לא עבר זיהוי אוטומטי (L1) -- אין הצעות קישור אוטומטיות. אפשר לקשר ידנית למק"ט בעזרת החיפוש שלמטה.</div>` : (() => {
    const products = Array.isArray(id.products) ? id.products.join(', ') : '';
    const lots = Array.isArray(id.lots) ? id.lots.join(', ') : '';
    return `
    <div class="dash-field"><b>סוג מסמך:</b> ${jsAttr(id.docKind || '—')}</div>
    <div class="dash-field"><b>מספר תעודה:</b> ${jsAttr(id.certNo || '—')}</div>
    <div class="dash-field"><b>מספר בקשה:</b> ${jsAttr(id.requestNo || '—')}</div>
    <div class="dash-field"><b>מוצר:</b> ${jsAttr(products || '—')}</div>
    <div class="dash-field"><b>יצרן:</b> ${jsAttr(id.manufacturer || '—')}</div>
    <div class="dash-field"><b>גוף כשרות:</b> ${jsAttr(id.kashrutBody || '—')}</div>
    <div class="dash-field"><b>מסלול:</b> ${jsAttr(id.track || '—')}</div>
    <div class="dash-field"><b>תאריך יצור:</b> ${dashFmtDate(id.productionDate)}</div>
    ${lots ? `<div class="dash-field"><b>LOT:</b> ${jsAttr(lots)}</div>` : ''}`;
  })();
  left.innerHTML = `
    <h3 style="margin-bottom:6px">${jsAttr(d.document.title || '')}</h3>
    ${dashPreviewValidityHtml()}
    ${idHtml}
    <h4 style="margin:14px 0 8px">מק"טים מועמדים</h4>
    <div id="dashPreviewCands"></div>
    ${isReadOnlyMode() ? '' : `<div style="margin-top:10px;padding:10px;background:#f7f7f7;border-radius:8px">${skuSearchWidgetHtml('dashprev')}</div>
    <div style="margin-top:8px;color:#888;font-size:11px">✘ דחה הוא סימון מקומי בלבד -- אין נתיב כתיבה נפרד לדחייה. ברגע שתלחצו "✓ קשר", כל מה שלא סומן ✔ יסומן כנדחה בפועל (זו ההתנהגות הקיימת של /link, בדיוק כמו במסך "הצעות קישור").</div>`}
    <div id="dashArchivePanel"></div>`;
  if (!isReadOnlyMode()) skuSearchBind('dashprev', dashPreviewPickManualSku);
  dashPreviewRenderCandidates();
}

function dashPreviewRenderCandidates() {
  const el = document.getElementById('dashPreviewCands');
  const cands = DASH_PREVIEW_DATA.candidates;
  const confColor = { CERTAIN: '#2e9e4a', LIKELY: '#d9a429', POSSIBLE: '#c0612f' };
  const ro = isReadOnlyMode();
  const cardsHtml = cands.length ? cands.map(c => {
    const accepted = DASH_PREVIEW_ACCEPTED.has(c.skuId);
    const rejected = DASH_PREVIEW_REJECTED.has(c.skuId);
    return `<div class="dash-cand-card ${accepted ? 'accepted' : ''} ${rejected ? 'rejected' : ''}">
      <div><b>${jsAttr(c.code)}</b> — ${jsAttr(c.name)} <span style="font-size:11px;padding:2px 8px;border-radius:10px;color:#fff;background:${confColor[c.confidence] || '#999'}">${jsAttr(c.confidence)}</span></div>
      <div style="font-size:12px;color:#666">${jsAttr(c.supplier || '')}${c.supplier && c.kashrutBodyRef ? ' · ' : ''}${jsAttr(c.kashrutBodyRef || '')}</div>
      ${ro ? '' : `<div class="dash-cand-actions">
        <button onclick="dashPreviewToggleAccept(${c.skuId})">${accepted ? '✓ מסומן (לחיצה לביטול)' : '✔ קשר'}</button>
        <button onclick="dashPreviewReject(${c.skuId})">✘ דחה</button>
      </div>`}
    </div>`;
  }).join('') : '<p style="color:#888">אין הצעות אוטומטיות למסמך זה. אפשר להוסיף ידנית בעזרת החיפוש שלמטה.</p>';

  const n = DASH_PREVIEW_ACCEPTED.size;
  const submitLabel = n === 0 ? '✓ קשר (לא סומנו מק"טים)' : n === 1 ? '✓ קשר למק"ט אחד' : `✓ קשר ל-${n} מק"טים`;
  el.innerHTML = cardsHtml + (ro ? '' : `
    <button class="btn btn-accent" style="width:100%;margin-top:10px" ${n ? '' : 'disabled'} onclick="dashPreviewSubmitAll()">${submitLabel}</button>`);
}

// One ticked chip per click -- multiple SKUs can be queued before a single
// "✓ קשר" submits all of them together in one /link call (one cert can
// cover several products).
function dashPreviewPickManualSku(sku) {
  if (DASH_PREVIEW_DATA.candidates.some(c => c.skuId === sku.skuId)) { showToast('מק"ט זה כבר ברשימת המועמדים'); return; }
  DASH_PREVIEW_DATA.candidates.push({ skuId: sku.skuId, code: sku.code, name: sku.name, supplier: '', kashrutBodyRef: sku.kashrutBodyRef || '', confidence: 'POSSIBLE', reasons: { manual: true } });
  DASH_PREVIEW_ACCEPTED.add(sku.skuId);
  DASH_PREVIEW_REJECTED.delete(sku.skuId);
  const input = document.getElementById('sks_input_dashprev');
  if (input) { input.value = ''; input.focus(); }
  const results = document.getElementById('sks_results_dashprev');
  if (results) results.innerHTML = '';
  dashPreviewRenderCandidates();
}

function dashPreviewToggleAccept(skuId) {
  if (DASH_PREVIEW_ACCEPTED.has(skuId)) DASH_PREVIEW_ACCEPTED.delete(skuId);
  else { DASH_PREVIEW_ACCEPTED.add(skuId); DASH_PREVIEW_REJECTED.delete(skuId); }
  dashPreviewRenderCandidates();
}

function dashPreviewReject(skuId) {
  DASH_PREVIEW_REJECTED.add(skuId);
  DASH_PREVIEW_ACCEPTED.delete(skuId);
  dashPreviewRenderCandidates();
}

async function dashPreviewSubmitAll() {
  if (!DASH_PREVIEW_ACCEPTED.size) return;
  try {
    const result = await fetch(API + '/api/link-suggestions/' + DASH_PREVIEW_CURRENT_ID + '/link', {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ skuIds: [...DASH_PREVIEW_ACCEPTED] }),
    }).then(r => r.json());
    showToast(`קושרו ${result.linksCreated} מק"טים`);
    await dashPreviewAfterSubmit();
  } catch (e) { showToast(e.message); }
}

function dashOpenArchivePanel() {
  const panel = document.getElementById('dashArchivePanel');
  if (!panel) return;
  const reasons = ['תעודה ישנה', 'כפילות', 'לא רלוונטי לחברה'];
  panel.innerHTML = `
    <div style="margin-top:10px;padding:10px;background:#fff7ed;border-radius:8px">
      <div style="margin-bottom:6px;font-size:13px">העברה לארכיון -- בחר סיבה (אופציונלי):</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
        ${reasons.map(r => `<button class="btn btn-outline" onclick='dashArchiveCurrent("${jsAttr(r)}")'>${jsAttr(r)}</button>`).join('')}
      </div>
      <input id="dashArchiveReasonInput" placeholder="או כתוב סיבה חופשית (לא חובה)..." style="width:100%;padding:6px;margin-bottom:6px"/>
      <button class="btn btn-accent" onclick="dashArchiveCurrent(document.getElementById('dashArchiveReasonInput').value)">אשר העברה לארכיון</button>
      <button class="btn btn-outline" onclick="document.getElementById('dashArchivePanel').innerHTML=''">ביטול</button>
    </div>`;
}

async function dashArchiveCurrent(reason) {
  try {
    await fetch(API + '/api/docs/' + DASH_PREVIEW_CURRENT_ID + '/archive', {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason || null }),
    });
    showToast('המסמך הועבר לארכיון');
    await dashPreviewAfterSubmit();
  } catch (e) { showToast(e.message); }
}

async function dashTrashCurrent() {
  if (!confirm('להעביר את המסמך לפח? ניתן לשחזר מאוחר יותר ממסך "🗑 פח".')) return;
  try {
    await fetch(API + '/api/docs/' + DASH_PREVIEW_CURRENT_ID + '/trash', { method: 'POST', headers: authHeaders() });
    showToast('המסמך הועבר לפח');
    await dashPreviewAfterSubmit();
  } catch (e) { showToast(e.message); }
}

function dashPreviewRemoveCurrentFromList() {
  const removedId = DASH_PREVIEW_CURRENT_ID;
  const card = DASH_DATA.cards.find(c => c.id === DASH_PREVIEW_SOURCE_CARD);
  if (card) {
    if (card.id === 'import-no-cert') card.items = card.items.filter(it => it.bestPendingDocumentId !== removedId);
    else if (card.id === 'unprocessed-docs') card.items = card.items.filter(it => it.id !== removedId);
    card.count = card.items.length;
  }
  const idx = DASH_PREVIEW_DOC_LIST.indexOf(removedId);
  if (idx >= 0) DASH_PREVIEW_DOC_LIST.splice(idx, 1);
  return idx;
}

async function dashPreviewAfterSubmit() {
  const idx = dashPreviewRemoveCurrentFromList();
  dashRenderGrid(); // updates the underlying card/list counts behind the overlay
  if (!DASH_PREVIEW_DOC_LIST.length) { showToast('אין עוד מסמכים ברשימה'); dashClosePreview(); return; }
  const nextIdx = Math.min(Math.max(idx, 0), DASH_PREVIEW_DOC_LIST.length - 1);
  await dashLoadPreviewDoc(DASH_PREVIEW_DOC_LIST[nextIdx]);
}

function dashPreviewRenderRight() {
  const right = document.getElementById('dashPreviewRight');
  const d = DASH_PREVIEW_DATA.document;
  const ext = (d.docExt || '').toLowerCase();
  right.innerHTML = '<p style="color:#fff">טוען...</p>';
  fetch(API + '/api/docs/' + d.id + '/download?inline=1', { headers: authHeaders() })
    .then(r => r.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      if (ext === 'pdf') right.innerHTML = `<iframe src="${url}#toolbar=1&navpanes=0"></iframe>`;
      else if (['png', 'jpg', 'jpeg', 'gif'].includes(ext)) right.innerHTML = `<img src="${url}"/>`;
      else right.innerHTML = `<div style="color:#fff;padding:20px">תצוגה מקדימה לא נתמכת לסוג קובץ זה (.${ext}). <a href="${url}" target="_blank" style="color:#9cf">הורדה</a></div>`;
    })
    .catch(() => { right.innerHTML = '<div style="color:#fff;padding:20px">שגיאה בטעינת המסמך</div>'; });
}

function dashPreviewNext() {
  const idx = DASH_PREVIEW_DOC_LIST.indexOf(DASH_PREVIEW_CURRENT_ID);
  if (idx >= 0 && idx + 1 < DASH_PREVIEW_DOC_LIST.length) dashLoadPreviewDoc(DASH_PREVIEW_DOC_LIST[idx + 1]);
  else showToast('הגעת לסוף הרשימה');
}
function dashPreviewPrev() {
  const idx = DASH_PREVIEW_DOC_LIST.indexOf(DASH_PREVIEW_CURRENT_ID);
  if (idx > 0) dashLoadPreviewDoc(DASH_PREVIEW_DOC_LIST[idx - 1]);
}
function dashPreviewKeyHandler(e) {
  if (!document.getElementById('dashPreviewOverlay')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (e.key === 'ArrowUp') { e.preventDefault(); dashPreviewPrev(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); dashPreviewNext(); }
  else if (e.key === 'Escape') { dashClosePreview(); }
}
