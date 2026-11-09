/* S3 (docrepo-sprint-8.11.md) -- "🏠 לוח טיפול" dashboard home screen.
 * Self-contained, like the other S and L screens: index.html only got a nav
 * button, one empty container, and this <script> tag.
 * Read-only. NOT yet wired as the actual home screen -- reachable via the
 * nav, per the spec's "this replaces [the Sheet dashboard] later, once I
 * approve." Each card shows a count; clicking it expands a capped list
 * in-place with a best-effort "next action" button that opens the most
 * relevant existing screen (not deep-linked to the exact row yet).
 */

let DASH_DATA = null;
let DASH_OPEN_CARD = null;

function dashInjectStyles() {
  if (document.getElementById('dashStyles')) return;
  const style = document.createElement('style');
  style.id = 'dashStyles';
  style.textContent = `
    .dash-wrap{max-width:1100px;margin:0 auto;padding:20px}
    .dash-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-bottom:16px}
    .dash-card{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.08);cursor:pointer;transition:box-shadow .15s}
    .dash-card:hover{box-shadow:0 2px 10px rgba(0,0,0,.15)}
    .dash-card.active{border:2px solid var(--accent,#2e6e9e)}
    .dash-card b{font-size:28px;display:block;margin-bottom:4px}
    .dash-card b.zero{color:#999}
    .dash-card b.nonzero{color:#c0612f}
    .dash-card .dash-title{font-size:13px;color:#555}
    .dash-detail{background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:16px}
    .dash-table{width:100%;border-collapse:collapse;font-size:13px}
    .dash-table th,.dash-table td{padding:6px 8px;text-align:right;border-bottom:1px solid #eee}
    .dash-table th{color:#666;font-weight:600;background:#fafafa}
    .dash-conf{display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap}
    .dash-conf span{padding:4px 10px;border-radius:10px;font-size:12px;color:#fff}
    .dash-conf .CERTAIN{background:#2e9e4a}.dash-conf .LIKELY{background:#d9a429}.dash-conf .POSSIBLE{background:#c0612f}
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
      <div id="dashGrid" class="dash-grid"><p style="color:#888">טוען...</p></div>
      <div id="dashDetail"></div>
    </div>`;
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

async function dashLoad() {
  try {
    const res = await fetch(API + '/api/dashboard/cards', { headers: authHeaders() });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'שגיאה'); }
    DASH_DATA = await res.json();
    dashRenderGrid();
  } catch (e) {
    document.getElementById('dashGrid').innerHTML = `<p style="color:#c0612f">שגיאה: ${jsAttr(e.message)}</p>`;
  }
}

function dashRenderGrid() {
  const el = document.getElementById('dashGrid');
  el.innerHTML = DASH_DATA.cards.map(c => `
    <div class="dash-card ${DASH_OPEN_CARD === c.id ? 'active' : ''}" onclick="dashToggleCard('${jsAttr(c.id)}')">
      <b class="${c.count ? 'nonzero' : 'zero'}">${c.count}</b>
      <div class="dash-title">${jsAttr(c.title)}</div>
    </div>`).join('');
  dashRenderDetail();
}

function dashToggleCard(id) {
  DASH_OPEN_CARD = (DASH_OPEN_CARD === id) ? null : id;
  dashRenderGrid();
}

// Best-effort: not deep-linked to the exact row yet, just opens the most
// relevant existing screen for this card type.
function dashActionFor(cardId) {
  if (cardId === 'import-no-cert' || cardId === 'new-skus') return () => openSkuManager();
  if (cardId === 'rm-pending-rejected') return () => openRawMaterials();
  if (cardId === 'pending-suggestions' || cardId === 'unprocessed-docs' || cardId === 'expiring-60' || cardId === 'uncovered-receipts') return () => openLinkSuggestions();
  return null;
}

function dashFmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toISOString().slice(0, 10);
}

function dashRenderDetail() {
  const el = document.getElementById('dashDetail');
  if (!DASH_OPEN_CARD) { el.innerHTML = ''; return; }
  const card = DASH_DATA.cards.find(c => c.id === DASH_OPEN_CARD);
  if (!card) { el.innerHTML = ''; return; }

  let html = `<div class="dash-detail"><h3 style="margin-bottom:10px">${jsAttr(card.title)} (${card.count})</h3>`;

  if (card.byConfidence) {
    html += '<div class="dash-conf">' + card.byConfidence.map(g => `<span class="${g.confidence}">${g.confidence}: ${g.count}</span>`).join('') + '</div>';
  }

  const action = dashActionFor(card.id);
  const actionBtn = action ? `<button class="btn btn-accent" style="margin-bottom:10px" onclick='dashRunAction("${jsAttr(card.id)}")'>פתח מסך רלוונטי</button>` : '';
  html += actionBtn;

  if (!card.items.length) {
    html += '<p style="color:#888">אין פריטים.</p>';
  } else {
    const cols = Object.keys(card.items[0]).filter(k => k !== 'action');
    html += `<table class="dash-table"><thead><tr>${cols.map(c => `<th>${jsAttr(c)}</th>`).join('')}</tr></thead><tbody>`;
    for (const it of card.items) {
      html += '<tr>' + cols.map(c => {
        let v = it[c];
        if (c.toLowerCase().includes('date')) v = dashFmtDate(v);
        else if (Array.isArray(v)) v = v.join(', ');
        return `<td>${jsAttr(v === null || v === undefined ? '—' : String(v))}</td>`;
      }).join('') + '</tr>';
    }
    html += '</tbody></table>';
  }
  html += '</div>';
  el.innerHTML = html;
}

function dashRunAction(cardId) {
  const fn = dashActionFor(cardId);
  if (fn) fn();
}
