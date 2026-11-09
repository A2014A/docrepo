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
      btns.push(`<button onclick='dashOpenSuggestionDoc(${it.bestPendingDocumentId})'>קשר מסמך</button>`);
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
    btns.push(`<button onclick='dashOpenSuggestionDoc(${it.id})'>קשר מסמך</button>`);
  }
  if (cardId === 'new-skus') {
    btns.push(`<button onclick='dashUnmarkNew("${jsAttr(it.code)}")'>הסר סימון חדש</button>`);
  }
  return btns.join('');
}

function dashOpenSku(code) {
  openSkuManager();
  const input = document.getElementById('skuListSearch');
  if (input) { input.value = code; loadSkuList(); }
}
async function dashOpenSuggestionDoc(documentId) {
  await openLinkSuggestions();
  lsOpenCard(documentId);
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
