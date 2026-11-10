/* ══════════════════════════════════════════════════════════════════════
 * Raw-Material Registry -- list screen.
 * Phase 4 Step 4.1 (list) + the 3.11.2026 two-track revision's R3
 * (docrepo-phase4-v2-tracks.md) + the same-day R1 follow-up (origin
 * kashrut / origin-Passover fields + the computed-origin-approval badge):
 * a year-round/Passover track switch drives the dots, legend, status
 * filter, counters and the stale-pending filter. A dedicated "מקור" column
 * shows the origin hechsher (year-round) or origin Passover marking
 * (Passover view, colored by status). A body that matches the item's
 * origin kashrut body is shown pre-approved with a small "מ" marker on its
 * dot -- computed here and on the server, never stored, and always
 * overridden by a real approval row the moment one exists.
 *
 * Self-contained: injects its own <style> and page markup at runtime so
 * index.html itself only needs a nav button + an empty container + this
 * <script> tag (index.html has a history of encoding corruption, so it
 * gets the smallest possible edit).
 *
 * Reuses globals already defined in index.html's main inline script:
 * apiFetch(), showToast(), fmtDate(). Talks only to the API
 * (/api/raw-material-registry, /api/kashrut-bodies) -- read-only in this
 * screen, no write calls at all.
 * ══════════════════════════════════════════════════════════════════════ */

const RM_STATUS_LABEL = {
  NOT_SENT: 'לא נשלח', SENT_PENDING: 'ממתין לתשובה', APPROVED: 'מאושר', REJECTED: 'נדחה',
  NEEDS_INFO: 'בקשת פרטים', CONDITIONAL: 'מאושר בתנאים', APPROVED_KITNIYOT: 'מאושר לקטניות',
};
const RM_STATUS_COLOR = {
  NOT_SENT: '#A09D98', SENT_PENDING: '#f59e0b', APPROVED: '#2D5A3D', REJECTED: '#dc2626',
  NEEDS_INFO: '#7c3aed', CONDITIONAL: '#2563eb', APPROVED_KITNIYOT: '#eab308',
};
// which statuses are selectable per track, matching the API's isValidStatusForTrack()
const RM_STATUSES_BY_TRACK = {
  YEAR_ROUND: ['NOT_SENT', 'SENT_PENDING', 'APPROVED', 'REJECTED', 'NEEDS_INFO', 'CONDITIONAL'],
  PASSOVER: ['NOT_SENT', 'SENT_PENDING', 'APPROVED', 'REJECTED', 'NEEDS_INFO', 'APPROVED_KITNIYOT'],
};
const RM_TRACK_LABEL = { YEAR_ROUND: 'ימות השנה', PASSOVER: 'פסח' };
const RM_ORIGIN_PASSOVER_LABEL = { UNKNOWN: '', PASSOVER: 'כשר לפסח', PASSOVER_KITNIYOT: 'כשר לפסח (קטניות)', NOT_PASSOVER: 'לא כשר לפסח' };
const RM_ORIGIN_PASSOVER_COLOR = { UNKNOWN: '#A09D98', PASSOVER: '#2D5A3D', PASSOVER_KITNIYOT: '#eab308', NOT_PASSOVER: '#dc2626' };

const RM_STATE = {
  items: [], allBodies: [], bodyById: new Map(),
  yearRoundBodies: [], passoverBodies: [],
  track: 'YEAR_ROUND', loaded: false,
  lastFilteredIds: [], // R10: the export button exports exactly this set
};

function rmEscapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rmBodiesForTrack(track) {
  return track === 'PASSOVER' ? RM_STATE.passoverBodies : RM_STATE.yearRoundBodies;
}

function rmInjectStyles() {
  if (document.getElementById('rmStyles')) return;
  const style = document.createElement('style');
  style.id = 'rmStyles';
  style.textContent = `
#rawMaterialsPage{max-width:1280px;margin:0 auto;padding:2rem;}
.rm-page-header{display:flex;align-items:center;gap:14px;margin-bottom:1.25rem;flex-wrap:wrap;}
.rm-page-header h1{font-family:'Frank Ruhl Libre',serif;font-size:1.6rem;font-weight:700;color:var(--ink);}
.rm-track-switch{display:flex;gap:4px;background:var(--bg2);border-radius:99px;padding:3px;margin-right:auto;}
.rm-track-btn{padding:6px 16px;border-radius:99px;border:none;background:transparent;font-family:'Heebo',sans-serif;font-size:.85rem;font-weight:500;color:var(--ink2);cursor:pointer;transition:all .15s;}
.rm-track-btn.active{background:var(--accent);color:#fff;}
.rm-summary{display:flex;gap:1.5rem;flex-wrap:wrap;background:var(--bg2);border-radius:var(--radius) var(--radius) 0 0;padding:.9rem 1.2rem;}
.rm-summary .rm-stat{font-size:.85rem;color:var(--ink2);}
.rm-summary .rm-stat strong{color:var(--ink);font-size:1.05rem;margin-left:5px;}
.rm-color-key{display:flex;gap:12px;flex-wrap:wrap;background:var(--bg2);border-radius:0 0 var(--radius) var(--radius);padding:.5rem 1.2rem .7rem;margin-bottom:1.1rem;border-top:1px solid var(--border);}
.rm-color-key span{display:inline-flex;align-items:center;gap:4px;font-size:.72rem;color:var(--ink2);}
.rm-color-key i{width:9px;height:9px;border-radius:50%;display:inline-block;}
.rm-filters{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:1.1rem;}
.rm-filters input[type=search],.rm-filters select{padding:7px 12px;border-radius:var(--radius);border:1px solid var(--border2);background:var(--card);font-family:'Heebo',sans-serif;font-size:.85rem;color:var(--ink);outline:none;}
.rm-filters input[type=search]{flex:1;min-width:200px;}
.rm-filters label{display:flex;align-items:center;gap:6px;font-size:.82rem;color:var(--ink2);white-space:nowrap;}
.rm-filters input[type=number]{width:52px;padding:5px 6px;border-radius:6px;border:1px solid var(--border2);text-align:center;}
.rm-list{display:flex;flex-direction:column;gap:8px;}
.rm-row{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:.9rem 1.1rem;display:flex;align-items:center;gap:14px;flex-wrap:wrap;}
.rm-row-main{flex:1;min-width:220px;}
.rm-row-name{font-weight:600;color:var(--ink);}
.rm-row-sub{font-size:.8rem;color:var(--ink3);margin-top:2px;}
.rm-needs-review{font-size:.7rem;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:99px;font-weight:600;margin-right:6px;}
.rm-origin-col{width:170px;flex-shrink:0;font-size:.78rem;color:var(--ink2);line-height:1.3;}
.rm-origin-col.rm-editable{cursor:pointer;padding:2px 4px;border-radius:6px;}
.rm-origin-col.rm-editable:hover{background:var(--bg2);}
.rm-inline-input,.rm-inline-select{width:100%;font-size:.78rem;padding:2px 4px;border:1px solid var(--accent);border-radius:4px;color:var(--ink);background:var(--card);font-family:'Heebo',sans-serif;}
.rm-inline-select{margin-top:3px;}
.rm-origin-header{width:170px;flex-shrink:0;font-size:12px;color:var(--ink);font-weight:500;text-align:center;}
.rm-legend{display:flex;align-items:flex-end;gap:14px;margin-bottom:8px;position:sticky;top:0;z-index:5;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--border);}
.rm-legend-spacer{flex:1;min-width:220px;}
.rm-dots-grid{display:grid;gap:4px;justify-items:center;}
.rm-legend-label{font-size:12px;color:var(--ink);font-weight:500;text-align:center;line-height:1.2;word-break:break-word;}
.rm-dot-wrap{position:relative;width:14px;height:14px;}
.rm-dot{width:14px;height:14px;border-radius:50%;display:block;cursor:default;}
.rm-origin-badge{position:absolute;bottom:-4px;right:-4px;width:10px;height:10px;border-radius:50%;background:#fff;border:1px solid var(--border2);color:var(--ink2);font-size:7px;font-weight:800;line-height:9px;text-align:center;cursor:default;}
.rm-empty{text-align:center;padding:3rem;color:var(--ink3);}
.rm-import-modal{width:min(900px,100%);max-height:85vh;}
.rm-import-step{margin-bottom:1rem;}
.rm-import-map-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;}
.rm-import-map-row label{width:170px;flex-shrink:0;font-size:.85rem;color:var(--ink2);}
.rm-import-map-row select{flex:1;padding:6px;border-radius:6px;border:1px solid var(--border2);}
.rm-import-table{width:100%;border-collapse:collapse;font-size:.78rem;}
.rm-import-table th,.rm-import-table td{padding:5px 7px;text-align:right;border-bottom:1px solid var(--border);white-space:nowrap;}
.rm-import-table th{background:var(--bg2);position:sticky;top:0;}
.rm-import-table-wrap{max-height:40vh;overflow:auto;border:1px solid var(--border);border-radius:8px;}
.rm-import-badge{font-size:.68rem;padding:2px 8px;border-radius:99px;font-weight:600;white-space:nowrap;}
.rm-import-badge.NEW{background:#dcfce7;color:#166534;}
.rm-import-badge.EXISTING{background:#fef9c3;color:#854d0e;}
.rm-import-badge.ERROR{background:#fee2e2;color:#991b1b;}
.rm-import-counts{display:flex;gap:14px;margin-bottom:10px;font-size:.85rem;}
`;
  document.head.appendChild(style);
}

function rmBuildPageShell() {
  const page = document.getElementById('rawMaterialsPage');
  if (!page || page.dataset.built) return;
  page.dataset.built = '1';
  page.innerHTML = `
    <div class="rm-page-header">
      <button class="btn btn-outline" onclick="closeRawMaterialsRegistry()">→ חזרה למסמכים</button>
      <h1>מאגר חומרי גלם</h1>
      <div class="rm-track-switch" id="rmTrackSwitch">
        <button class="rm-track-btn" id="rmTrackYearRound" onclick="rmSetTrack('YEAR_ROUND')">ימות השנה</button>
        <button class="rm-track-btn" id="rmTrackPassover" onclick="rmSetTrack('PASSOVER')">פסח</button>
      </div>
      <button class="btn btn-outline" onclick="rmExportExcel()">📥 ייצוא לאקסל</button>
      ${rmIsReadOnly() ? '' : `<button class="btn btn-outline" onclick="rmOpenImport()">📤 ייבוא מאקסל</button>`}
    </div>
    <div class="rm-summary" id="rmSummary"></div>
    <div class="rm-color-key" id="rmColorKey"></div>
    <div class="rm-filters">
      <input type="search" id="rmSearchInput" placeholder='חפש לפי שם, ספק, יצרן או מק"ט...' oninput="rmApplyFilters()" autocomplete="off"/>
      <select id="rmBodyFilter" onchange="rmApplyFilters()"></select>
      <select id="rmStatusFilter" onchange="rmApplyFilters()"></select>
      <select id="rmSupplierFilter" onchange="rmApplyFilters()"></select>
      <label><input type="checkbox" id="rmNeedsReviewFilter" onchange="rmApplyFilters()"/> ⚠ לבדוק בלבד</label>
      <label><input type="checkbox" id="rmNoOriginCertFilter" onchange="rmApplyFilters()"/> ללא תעודת מקור</label>
      <label><input type="checkbox" id="rmOriginPassoverFilter" onchange="rmApplyFilters()"/> כשר לפסח במקור</label>
      <label><input type="checkbox" id="rmLastImportFilter" onchange="rmApplyFilters()"/> 📥 מייבוא אחרון</label>
      <label><input type="checkbox" id="rmStaleToggle" onchange="rmApplyFilters()"/> ⏳ ממתין מעל
        <input type="number" id="rmStaleDays" value="14" min="1" onchange="rmApplyFilters()"/> ימים</label>
    </div>
    <div class="rm-legend" id="rmLegend"></div>
    <div class="rm-list" id="rmList"></div>
  `;
}

async function openRawMaterialsRegistry() {
  rmInjectStyles();
  rmBuildPageShell();
  document.querySelector('.hero').style.display = 'none';
  document.getElementById('statsBar').style.display = 'none';
  document.querySelector('main.main').style.display = 'none';
  document.getElementById('rawMaterialsPage').style.display = 'block';
  await rmLoad();
}

function closeRawMaterialsRegistry() {
  document.getElementById('rawMaterialsPage').style.display = 'none';
  document.querySelector('.hero').style.display = '';
  document.getElementById('statsBar').style.display = '';
  document.querySelector('main.main').style.display = '';
}

async function rmLoad() {
  document.getElementById('rmList').innerHTML = '<div class="loading"><div class="spinner"></div>טוען...</div>';
  try {
    const [items, bodies] = await Promise.all([
      apiFetch('/api/raw-material-registry'),
      apiFetch('/api/kashrut-bodies'),
    ]);
    RM_STATE.items = items;
    RM_STATE.allBodies = bodies;
    RM_STATE.bodyById = new Map(bodies.map(b => [b.id, b]));
    RM_STATE.yearRoundBodies = bodies.filter(b => b.active);

    // Passover column set: active handlesPassover bodies, plus any body
    // (even inactive/no-longer-handlesPassover) that has a real PASSOVER
    // approval row on some item -- mirrors the API matrix's own fallback,
    // computed globally here so the legend/dots stay one fixed set of
    // columns across every row.
    const passoverMap = new Map();
    bodies.filter(b => b.active && b.handlesPassover).forEach(b => passoverMap.set(b.id, b));
    for (const item of items) {
      for (const a of item.approvals) {
        if (a.track === 'PASSOVER' && !passoverMap.has(a.kashrutBodyId)) {
          const b = RM_STATE.bodyById.get(a.kashrutBodyId);
          if (b) passoverMap.set(b.id, b);
        }
      }
    }
    RM_STATE.passoverBodies = [...passoverMap.values()].sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));

    RM_STATE.loaded = true;
    rmRenderTrackSwitch();
    rmPopulateFilterOptions();
    rmRenderLegend();
    rmRenderColorKey();
    rmApplyFilters();
  } catch (e) {
    document.getElementById('rmList').innerHTML = `<div class="alert alert-error">${rmEscapeHtml(e.message)}</div>`;
  }
}

function rmRenderTrackSwitch() {
  document.getElementById('rmTrackYearRound').className = 'rm-track-btn' + (RM_STATE.track === 'YEAR_ROUND' ? ' active' : '');
  document.getElementById('rmTrackPassover').className = 'rm-track-btn' + (RM_STATE.track === 'PASSOVER' ? ' active' : '');
}

function rmSetTrack(track) {
  if (track === RM_STATE.track) return;
  RM_STATE.track = track;
  rmRenderTrackSwitch();
  // body/status filters are track-specific selections -- reset rather than
  // carry over a selection that may not exist (or mean something different) in the new track
  document.getElementById('rmBodyFilter').value = '';
  document.getElementById('rmStatusFilter').value = '';
  rmPopulateFilterOptions();
  rmRenderLegend();
  rmRenderColorKey();
  rmApplyFilters();
}

function rmPopulateFilterOptions() {
  const trackBodies = rmBodiesForTrack(RM_STATE.track);
  const bodySel = document.getElementById('rmBodyFilter');
  bodySel.innerHTML = '<option value="">כל גופי הכשרות</option>' +
    trackBodies.map(b => `<option value="${b.id}">${rmEscapeHtml(b.shortName || b.name)}</option>`).join('');

  const statusSel = document.getElementById('rmStatusFilter');
  statusSel.innerHTML = '<option value="">כל הסטטוסים</option>' +
    RM_STATUSES_BY_TRACK[RM_STATE.track].map(s => `<option value="${s}">${RM_STATUS_LABEL[s]}</option>`).join('');

  const suppliers = [...new Set(RM_STATE.items.map(r => r.supplier).filter(Boolean))].sort();
  const supplierSel = document.getElementById('rmSupplierFilter');
  const keepSupplier = supplierSel.value;
  supplierSel.innerHTML = '<option value="">כל הספקים</option>' +
    suppliers.map(s => `<option value="${rmEscapeHtml(s)}">${rmEscapeHtml(s)}</option>`).join('');
  supplierSel.value = keepSupplier;
}

// computed-origin-approval: if this body is the item's origin kashrut body,
// it's treated as pre-approved for YEAR_ROUND, and for PASSOVER only when
// the origin's own Passover marking is positive. Mirrors the API's
// regComputedOriginApproval() exactly -- kept in sync by hand since the
// list screen merges approvals client-side rather than calling the matrix
// endpoint per row. Returns null when no computed status applies.
function rmComputeOriginStatus(item, body, track) {
  if (item.originKashrutBodyId !== body.id) return null;
  if (track === 'YEAR_ROUND') return 'APPROVED';
  if (item.originPassoverStatus === 'PASSOVER') return 'APPROVED';
  if (item.originPassoverStatus === 'PASSOVER_KITNIYOT') return 'APPROVED_KITNIYOT';
  return null;
}

// one status per kashrut body in the CURRENT track's column set -- a real
// RawMaterialApproval row if one exists, else the computed-origin status if
// applicable, else a synthesized NOT_SENT. Mirrors what GET
// /api/raw-materials/:id/approvals computes server-side (done client-side
// here so the list screen needs no dedicated matrix call per row).
function rmStatusByBody(item, track) {
  const byBody = new Map(item.approvals.filter(a => a.track === track).map(a => [a.kashrutBodyId, a]));
  return rmBodiesForTrack(track).map(b => {
    const a = byBody.get(b.id);
    if (a) return { body: b, status: a.status, sentAt: a.sentAt, viaOrigin: false };
    const computed = rmComputeOriginStatus(item, b, track);
    if (computed) return { body: b, status: computed, sentAt: null, viaOrigin: true };
    return { body: b, status: 'NOT_SENT', sentAt: null, viaOrigin: false };
  });
}

// shared column template so the legend header's labels line up exactly
// over each row's dots, regardless of how many bodies the current track has
function rmGridTemplate() {
  return `repeat(${rmBodiesForTrack(RM_STATE.track).length}, 46px)`;
}

function rmRenderLegend() {
  document.getElementById('rmLegend').innerHTML = `
    <div class="rm-legend-spacer"></div>
    <div class="rm-origin-header">מקור</div>
    <div class="rm-dots-grid" style="grid-template-columns:${rmGridTemplate()}">
      ${rmBodiesForTrack(RM_STATE.track).map(b => `<div class="rm-legend-label" title="${rmEscapeHtml(b.name)}">${rmEscapeHtml(b.shortName || b.name)}</div>`).join('')}
    </div>`;
}

function rmRenderColorKey() {
  const statuses = RM_STATUSES_BY_TRACK[RM_STATE.track];
  document.getElementById('rmColorKey').innerHTML = statuses
    .map(s => `<span><i style="background:${RM_STATUS_COLOR[s]}"></i>${RM_STATUS_LABEL[s]}</span>`)
    .join('');
}

function rmDaysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// track-aware "מקור" column content -- year-round shows the hechsher text +
// cert expiry; Passover shows the Passover-specific marking, colored by
// originPassoverStatus. Returns null when there's nothing to show.
function rmOriginLine(item, track) {
  if (track === 'PASSOVER') {
    if (!item.originPassoverText && item.originPassoverStatus === 'UNKNOWN') return null;
    const parts = [];
    if (item.originPassoverText) parts.push(item.originPassoverText);
    const label = RM_ORIGIN_PASSOVER_LABEL[item.originPassoverStatus];
    if (label) parts.push(label);
    if (item.originPassoverValidUntil) parts.push('עד ' + fmtDate(item.originPassoverValidUntil));
    return { text: parts.join(' · '), color: RM_ORIGIN_PASSOVER_COLOR[item.originPassoverStatus] };
  }
  if (!item.originKashrutText && !item.originHasCert) return null;
  const parts = [];
  if (item.originKashrutText) parts.push(item.originKashrutText);
  if (item.originHasCert) parts.push(item.originCertValidUntil ? 'תעודה עד ' + fmtDate(item.originCertValidUntil) : 'יש תעודה');
  return { text: parts.join(' · '), color: null };
}

function rmApplyFilters() {
  if (!RM_STATE.loaded) return;
  const track = RM_STATE.track;
  const q = document.getElementById('rmSearchInput').value.trim().toLowerCase();
  const bodyId = document.getElementById('rmBodyFilter').value;
  const status = document.getElementById('rmStatusFilter').value;
  const supplier = document.getElementById('rmSupplierFilter').value;
  const needsReviewOnly = document.getElementById('rmNeedsReviewFilter').checked;
  const noOriginCertOnly = document.getElementById('rmNoOriginCertFilter').checked;
  const originPassoverOnly = document.getElementById('rmOriginPassoverFilter').checked;
  const staleOn = document.getElementById('rmStaleToggle').checked;
  const staleDays = parseInt(document.getElementById('rmStaleDays').value) || 14;
  const lastImportOnly = document.getElementById('rmLastImportFilter').checked;

  const rows = RM_STATE.items.map(item => ({ item, statuses: rmStatusByBody(item, track) }));
  // R11: "the newest import" is whichever importId is highest among loaded
  // items -- works after a page reload too, since importId persists on the row.
  const lastImportId = RM_STATE.items.reduce((max, it) => (it.importId != null && it.importId > max ? it.importId : max), -1);

  const filtered = rows.filter(({ item, statuses }) => {
    const needsReview = item.approvals.length === 0;
    if (needsReviewOnly && !needsReview) return false;
    if (lastImportOnly && (lastImportId < 0 || item.importId !== lastImportId)) return false;
    if (noOriginCertOnly && item.originHasCert) return false;
    if (originPassoverOnly && !['PASSOVER', 'PASSOVER_KITNIYOT'].includes(item.originPassoverStatus)) return false;
    if (supplier && item.supplier !== supplier) return false;

    if (q) {
      const hay = [item.name, item.supplier, item.manufacturer, ...item.skus.map(s => s.id + ' ' + s.name)]
        .join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }

    if (bodyId) {
      const s = statuses.find(s => s.body.id === parseInt(bodyId));
      if (!s) return false;
      if (status && s.status !== status) return false;
      if (staleOn && !(s.status === 'SENT_PENDING' && rmDaysSince(s.sentAt) >= staleDays)) return false;
    } else {
      if (status && !statuses.some(s => s.status === status)) return false;
      if (staleOn && !statuses.some(s => s.status === 'SENT_PENDING' && rmDaysSince(s.sentAt) >= staleDays)) return false;
    }
    return true;
  });

  rmRenderSummary(rows);
  rmRenderList(filtered);
  RM_STATE.lastFilteredIds = filtered.map(({ item }) => item.id); // R10: export uses exactly this
}

// R10: exports exactly RM_STATE.lastFilteredIds (set by rmApplyFilters on
// every render), so this always matches what's currently on screen.
async function rmExportExcel() {
  try {
    const res = await fetch(API + '/api/raw-material-registry/export', {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: RM_STATE.lastFilteredIds }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'שגיאה בייצוא'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `חומרי גלם - ${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) { showToast(e.message); }
}

/* ══ R11: Excel/CSV import wizard (upload -> column mapping -> preview -> commit) ══
 * Not available for the assistant role or demo mode (button hidden via
 * rmIsReadOnly() in the page shell; the backend also gates every import
 * route with requireAuth, which rejects the assistant-code pseudo-auth). */
const RM_IMPORT_FIELDS = [
  { key: 'name', label: 'שם (חובה)' },
  { key: 'supplier', label: 'ספק' },
  { key: 'manufacturer', label: 'יצרן' },
  { key: 'originKashrutText', label: 'כשרות מקור' },
  { key: 'skuCodes', label: 'מק"טים מקושרים (מופרדים בפסיק)' },
  { key: 'notes', label: 'הערות' },
  { key: 'supplierItemCode', label: 'קוד פריט ספק' },
];
let RM_IMPORT_STATE = null; // { file, headers, rows, mapping, preview, selected: Set }

function rmImportModalShell(bodyHtml) {
  let bg = document.getElementById('rmImportModalBg');
  if (!bg) {
    bg = document.createElement('div');
    bg.id = 'rmImportModalBg';
    bg.className = 'modal-bg';
    document.body.appendChild(bg);
  }
  bg.innerHTML = `
    <div class="modal rm-import-modal">
      <div class="modal-header">
        <div class="modal-title">📤 ייבוא חומרי גלם מאקסל</div>
        <button class="modal-close" onclick="rmCloseImport()">✕</button>
      </div>
      <div id="rmImportBody">${bodyHtml}</div>
    </div>`;
  return bg;
}

function rmOpenImport() {
  RM_IMPORT_STATE = null;
  const bg = rmImportModalShell(`
    <div class="rm-import-step">
      <p style="color:var(--ink2);font-size:.85rem;margin-bottom:10px">העלה קובץ .xlsx או .csv מרשימת רכש/מפעל. העמודות יכולות להיות בכל סדר -- בשלב הבא תוכל לשייך אותן לשדות.</p>
      <input type="file" id="rmImportFileInput" accept=".xlsx,.csv"/>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="rmCloseImport()">ביטול</button>
      <button class="btn btn-accent" onclick="rmImportUpload()">המשך</button>
    </div>`);
  bg.classList.add('open');
}

function rmCloseImport() {
  const bg = document.getElementById('rmImportModalBg');
  if (bg) bg.classList.remove('open');
}

async function rmImportUpload() {
  const input = document.getElementById('rmImportFileInput');
  if (!input.files.length) { showToast('בחר קובץ'); return; }
  const file = input.files[0];
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch(API + '/api/raw-material-registry/import/parse', { method: 'POST', headers: authHeaders(), body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'שגיאה בקריאת הקובץ');
    RM_IMPORT_STATE = { file, headers: body.headers, rows: body.rows, mapping: body.mapping };
    rmImportRenderMappingStep();
  } catch (e) { showToast(e.message); }
}

function rmImportRenderMappingStep() {
  const { headers } = RM_IMPORT_STATE;
  const optionsHtml = `<option value="">— ללא —</option>` + headers.map((h, i) => `<option value="${i}">${rmEscapeHtml(h || '(עמודה ' + (i + 1) + ')')}</option>`).join('');
  const rowsHtml = RM_IMPORT_FIELDS.map(f => `
    <div class="rm-import-map-row">
      <label>${rmEscapeHtml(f.label)}</label>
      <select id="rmImportMap_${f.key}">${optionsHtml}</select>
    </div>`).join('');
  document.getElementById('rmImportBody').innerHTML = `
    <div class="rm-import-step">
      <p style="color:var(--ink2);font-size:.85rem;margin-bottom:10px">${RM_IMPORT_STATE.rows.length} שורות בקובץ. שייך כל שדה לעמודה המתאימה (שויך אוטומטית לפי כותרות העמודות -- אפשר לשנות):</p>
      ${rowsHtml}
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="rmOpenImport()">→ חזרה</button>
      <button class="btn btn-accent" onclick="rmImportPreview()">המשך לתצוגה מקדימה</button>
    </div>`;
  for (const f of RM_IMPORT_FIELDS) {
    const sel = document.getElementById('rmImportMap_' + f.key);
    if (RM_IMPORT_STATE.mapping[f.key] != null) sel.value = String(RM_IMPORT_STATE.mapping[f.key]);
  }
}

async function rmImportPreview() {
  const mapping = {};
  for (const f of RM_IMPORT_FIELDS) {
    const v = document.getElementById('rmImportMap_' + f.key).value;
    if (v !== '') mapping[f.key] = parseInt(v);
  }
  if (mapping.name == null) { showToast('חובה לשייך את שדה השם'); return; }
  RM_IMPORT_STATE.mapping = mapping;
  try {
    const result = await apiFetch('/api/raw-material-registry/import/preview', {
      method: 'POST', body: JSON.stringify({ rows: RM_IMPORT_STATE.rows, mapping }),
    });
    RM_IMPORT_STATE.preview = result.rows;
    // duplicates unticked by default, NEW rows ticked by default, ERROR rows never selectable
    RM_IMPORT_STATE.selected = new Set(result.rows.filter(r => r.classification === 'NEW').map(r => r.rowIndex));
    rmImportRenderPreviewStep(result.counts);
  } catch (e) { showToast(e.message); }
}

function rmImportRenderPreviewStep(counts) {
  const rows = RM_IMPORT_STATE.preview;
  const tableRows = rows.map(r => {
    const disabled = r.classification === 'ERROR';
    const checked = RM_IMPORT_STATE.selected.has(r.rowIndex);
    return `<tr>
      <td><input type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} onchange="rmImportToggleRow(${r.rowIndex}, this.checked)"/></td>
      <td><span class="rm-import-badge ${r.classification}">${r.classification === 'NEW' ? 'חדש' : r.classification === 'EXISTING' ? 'קיים' : 'שגיאה'}</span></td>
      <td>${rmEscapeHtml(r.name)}</td>
      <td>${rmEscapeHtml(r.supplier)}</td>
      <td>${rmEscapeHtml(r.manufacturer)}</td>
      <td>${rmEscapeHtml(r.originKashrutText)}</td>
      <td>${rmEscapeHtml(r.skuCodes.join(', '))}</td>
      <td>${rmEscapeHtml(r.supplierItemCode)}</td>
      <td style="color:var(--ink3)">${rmEscapeHtml(r.reason)}</td>
    </tr>`;
  }).join('');
  document.getElementById('rmImportBody').innerHTML = `
    <div class="rm-import-step">
      <div class="rm-import-counts">
        <span>🆕 חדש: <b>${counts.NEW}</b></span>
        <span>♻ קיים: <b>${counts.EXISTING}</b></span>
        <span>⚠ שגיאה: <b>${counts.ERROR}</b></span>
      </div>
      <label style="display:block;margin-bottom:10px;font-size:.85rem"><input type="checkbox" id="rmImportFillEmpty"/> עדכן שדות ריקים בקיימים (רשומות קיימות לא נדרסות, רק שדות ריקים מתמלאים)</label>
      <div class="rm-import-table-wrap">
        <table class="rm-import-table">
          <thead><tr><th></th><th>סטטוס</th><th>שם</th><th>ספק</th><th>יצרן</th><th>כשרות מקור</th><th>מק"טים</th><th>קוד ספק</th><th>הערה</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="rmImportRenderMappingStep()">→ חזרה למיפוי</button>
      <button class="btn btn-accent" id="rmImportCommitBtn" onclick="rmImportCommit()">✔ ייבא ${RM_IMPORT_STATE.selected.size} רשומות</button>
    </div>`;
}

function rmImportToggleRow(rowIndex, checked) {
  if (checked) RM_IMPORT_STATE.selected.add(rowIndex); else RM_IMPORT_STATE.selected.delete(rowIndex);
  const btn = document.getElementById('rmImportCommitBtn');
  if (btn) btn.textContent = `✔ ייבא ${RM_IMPORT_STATE.selected.size} רשומות`;
}

async function rmImportCommit() {
  const fillEmptyOnExisting = document.getElementById('rmImportFillEmpty').checked;
  const fd = new FormData();
  fd.append('file', RM_IMPORT_STATE.file);
  fd.append('rows', JSON.stringify(RM_IMPORT_STATE.rows));
  fd.append('mapping', JSON.stringify(RM_IMPORT_STATE.mapping));
  fd.append('selectedIndexes', JSON.stringify([...RM_IMPORT_STATE.selected]));
  fd.append('fillEmptyOnExisting', fillEmptyOnExisting ? '1' : '0');
  try {
    const res = await fetch(API + '/api/raw-material-registry/import/commit', { method: 'POST', headers: authHeaders(), body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'שגיאה בייבוא');
    showToast(`יובאו ${body.rowsCreated} רשומות חדשות (${body.rowsSkipped} דולגו)`);
    rmCloseImport();
    await rmLoad();
  } catch (e) { showToast(e.message); }
}

function rmRenderSummary(rows) {
  const total = rows.length;
  const pending = rows.filter(({ statuses }) => statuses.some(s => s.status === 'SENT_PENDING')).length;
  const rejected = rows.filter(({ statuses }) => statuses.some(s => s.status === 'REJECTED')).length;
  const needsInfo = rows.filter(({ statuses }) => statuses.some(s => s.status === 'NEEDS_INFO')).length;
  const needsReview = rows.filter(({ item }) => item.approvals.length === 0).length;
  document.getElementById('rmSummary').innerHTML = `
    <div class="rm-stat">סה"כ <strong>${total}</strong></div>
    <div class="rm-stat">ממתינים לתשובה <strong>${pending}</strong></div>
    <div class="rm-stat">בקשת פרטים <strong>${needsInfo}</strong></div>
    <div class="rm-stat">נדחו <strong>${rejected}</strong></div>
    <div class="rm-stat">⚠ לבדוק <strong>${needsReview}</strong></div>
  `;
}

// gates write affordances in this screen: the assistant role is read-only
// per the spec, and so is demo mode (?demo=1) once that's wired up globally
// -- checked directly here since no shared demo-mode helper exists yet.
function rmIsReadOnly() {
  if (typeof effectiveRole === 'function' && effectiveRole() === 'assistant') return true;
  try { if (new URLSearchParams(location.search).get('demo') === '1') return true; } catch (e) {}
  return false;
}

// click-to-edit on the "מקור" column: year-round edits originKashrutText;
// Passover edits originPassoverText + a status select. Enter/blur saves via
// PATCH, Esc cancels. Re-renders the whole list on save/cancel (simplest
// way to keep every derived view -- dots, computed-origin badges, color,
// filters -- in sync with the edited value).
function rmOriginCellClick(el) {
  if (rmIsReadOnly() || el.dataset.editing) return;
  const id = parseInt(el.dataset.rmId);
  const item = RM_STATE.items.find(i => i.id === id);
  if (!item) return;
  el.dataset.editing = '1';
  el.style.color = '';

  if (RM_STATE.track === 'PASSOVER') {
    el.innerHTML = `
      <input type="text" class="rm-inline-input" id="rmEditText_${id}" value="${rmEscapeHtml(item.originPassoverText || '')}" placeholder="טקסט מקור לפסח"/>
      <select class="rm-inline-select" id="rmEditSelect_${id}">
        ${['UNKNOWN', 'PASSOVER', 'PASSOVER_KITNIYOT', 'NOT_PASSOVER'].map(s => `<option value="${s}" ${item.originPassoverStatus === s ? 'selected' : ''}>${RM_ORIGIN_PASSOVER_LABEL[s] || 'לא ידוע'}</option>`).join('')}
      </select>`;
  } else {
    el.innerHTML = `<input type="text" class="rm-inline-input" id="rmEditText_${id}" value="${rmEscapeHtml(item.originKashrutText || '')}" placeholder="טקסט הכשר"/>`;
  }

  const fields = el.querySelectorAll('input,select');
  fields.forEach(f => f.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); rmOriginCellSave(el); }
    else if (e.key === 'Escape') { e.preventDefault(); rmOriginCellCancel(el); }
  }));
  el.addEventListener('focusout', (e) => {
    if (el.contains(e.relatedTarget)) return; // focus moved within the same cell (text -> select)
    rmOriginCellSave(el);
  });
  fields[0].focus();
  fields[0].select();
}

function rmOriginCellCancel(el) {
  delete el.dataset.editing;
  rmApplyFilters();
}

async function rmOriginCellSave(el) {
  if (!el.dataset.editing || el.dataset.saving) return;
  el.dataset.saving = '1';
  const id = parseInt(el.dataset.rmId);
  const body = RM_STATE.track === 'PASSOVER'
    ? { originPassoverText: document.getElementById('rmEditText_' + id).value.trim(), originPassoverStatus: document.getElementById('rmEditSelect_' + id).value }
    : { originKashrutText: document.getElementById('rmEditText_' + id).value.trim() };
  try {
    const updated = await apiFetch('/api/raw-material-registry/' + id, { method: 'PATCH', body: JSON.stringify(body) });
    const idx = RM_STATE.items.findIndex(i => i.id === id);
    if (idx >= 0) RM_STATE.items[idx] = updated;
    showToast('מקור עודכן');
  } catch (e) {
    showToast(e.message);
  }
  delete el.dataset.editing;
  delete el.dataset.saving;
  rmApplyFilters();
}

function rmRenderList(rows) {
  const el = document.getElementById('rmList');
  if (!rows.length) {
    el.innerHTML = '<div class="rm-empty">לא נמצאו חומרי גלם מתאימים</div>';
    return;
  }
  el.innerHTML = rows.map(({ item, statuses }) => {
    const needsReview = item.approvals.length === 0;
    const skuText = item.skus.length ? item.skus.map(s => rmEscapeHtml(s.id)).join(', ') : 'אין מק"טים מקושרים';
    const origin = rmOriginLine(item, RM_STATE.track);
    const dots = statuses.map(s => {
      const days = s.status === 'SENT_PENDING' ? rmDaysSince(s.sentAt) : null;
      const originNote = s.viaOrigin ? ' (מקור)' : '';
      const title = `${s.body.name}: ${RM_STATUS_LABEL[s.status]}${days != null ? ` (${days} ימים)` : ''}${originNote}`;
      const badge = s.viaOrigin ? `<span class="rm-origin-badge" title="${rmEscapeHtml(title)}">מ</span>` : '';
      return `<div class="rm-dot-cell"><span class="rm-dot-wrap"><span class="rm-dot" style="background:${RM_STATUS_COLOR[s.status]}" title="${rmEscapeHtml(title)}"></span>${badge}</span></div>`;
    }).join('');
    return `
      <div class="rm-row" onclick="rmOpenCard(${item.id})" style="cursor:pointer">
        <div class="rm-row-main">
          <div class="rm-row-name">${needsReview ? '<span class="rm-needs-review">לבדוק</span>' : ''}${rmEscapeHtml(item.name)}</div>
          <div class="rm-row-sub">${rmEscapeHtml(item.supplier || '— ספק לא ידוע —')}${item.manufacturer ? ' · ' + rmEscapeHtml(item.manufacturer) : ''} · ${skuText}</div>
        </div>
        <div class="rm-origin-col${rmIsReadOnly() ? '' : ' rm-editable'}" data-rm-id="${item.id}"${rmIsReadOnly() ? '' : ' onclick="rmOriginCellClick(this);event.stopPropagation()"'}${origin && origin.color ? ` style="color:${origin.color}"` : ''}>${origin ? rmEscapeHtml(origin.text) : '—'}</div>
        <div class="rm-dots-grid" style="grid-template-columns:${rmGridTemplate()}">${dots}</div>
      </div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════════════
 * Raw-material card -- Phase 4 R4 (docrepo-phase4-v2-tracks.md).
 * Opened from a list row. "שלח"/"עדכן תשובה"/"שלח השלמה" are R5/R6's job
 * (show a toast for now, same as the original pre-track-revision Step 4.2
 * approach); "היסטוריה" is real, using the GET /api/approvals/:id/events
 * endpoint added alongside this. Linked-SKU "add" reuses index.html's
 * existing openSkuPicker() via a new 'rmCard' mode (added there) that
 * calls rmCardOnSkuPicked() below.
 * ══════════════════════════════════════════════════════════════════════ */

const RM_DOC_ROLE_LABEL = { LABEL: 'תווית', BACK_LABEL: 'תווית - צד שני', ANALYSIS: 'ניתוח', CERT: 'תעודה', SPEC: 'מפרט', OTHER: 'אחר' };
const RM_DOC_ROLES = ['LABEL', 'BACK_LABEL', 'ANALYSIS', 'CERT', 'SPEC', 'OTHER'];
const RM_IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const RM_EVENT_TYPE_LABEL = { SENT: 'נשלח', REPLY: 'התקבלה תשובה', STATUS_CHANGE: 'שינוי סטטוס', NOTE: 'עדכון' };

let RM_CARD_ID = null, RM_CARD_DATA = null, RM_CARD_MATRIX = null, RM_CARD_EDITING_HEADER = false;

function rmCardInjectStyles() {
  if (document.getElementById('rmCardStyles')) return;
  const style = document.createElement('style');
  style.id = 'rmCardStyles';
  style.textContent = `
.rm-card-page{max-width:900px;margin:0 auto;padding:2rem;}
.rmc-header-row{display:flex;align-items:center;gap:14px;margin-bottom:1.25rem;}
.rmc-section{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:1.25rem;margin-bottom:1.1rem;}
.rmc-section-title{font-weight:700;font-size:1rem;color:var(--ink);margin-bottom:.9rem;}
.rmc-field-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;align-items:center;}
.rmc-field-row label{font-size:.8rem;color:var(--ink2);min-width:110px;}
.rmc-field-row input[type=text],.rmc-field-row select,.rmc-field-row input[type=date]{flex:1;min-width:140px;padding:6px 10px;border-radius:6px;border:1px solid var(--border2);font-family:'Heebo',sans-serif;font-size:.85rem;background:var(--card);color:var(--ink);}
.rmc-origin-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
@media (max-width:700px){.rmc-origin-grid{grid-template-columns:1fr;}}
.rmc-origin-box{border:1px solid var(--border2);border-radius:var(--radius);padding:12px;}
.rmc-origin-box h4{font-size:.85rem;margin-bottom:8px;color:var(--ink);}
.rmc-doc-roles{display:flex;flex-direction:column;gap:14px;}
.rmc-doc-role-title{font-size:.82rem;font-weight:600;color:var(--ink2);margin-bottom:6px;}
.rmc-doc-grid{display:flex;gap:10px;flex-wrap:wrap;}
.rmc-doc-thumb{width:70px;height:70px;border-radius:8px;overflow:hidden;border:1px solid var(--border2);display:flex;align-items:center;justify-content:center;background:var(--bg2);font-size:1.6rem;cursor:pointer;text-decoration:none;color:inherit;}
.rmc-doc-thumb img{width:100%;height:100%;object-fit:cover;}
.rmc-table{width:100%;border-collapse:collapse;font-size:.8rem;}
.rmc-table th{text-align:right;padding:6px 8px;border-bottom:1px solid var(--border2);color:var(--ink2);font-weight:600;white-space:nowrap;}
.rmc-table td{padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:middle;}
.rmc-status-badge{font-size:.72rem;padding:2px 8px;border-radius:99px;color:#fff;display:inline-block;white-space:nowrap;}
.rmc-btn-sm{font-size:.72rem;padding:4px 8px;border-radius:6px;margin-left:4px;}
.rmc-sku-pill{display:inline-flex;align-items:center;gap:6px;background:var(--bg2);border-radius:99px;padding:4px 10px;font-size:.8rem;margin:3px;}
.rmc-sku-pill span{cursor:pointer;color:var(--ink3);}
.rm-hist-row{padding:8px 0;border-bottom:1px solid var(--border);font-size:.82rem;}
.rm-hist-type{font-weight:600;color:var(--ink);}
`;
  document.head.appendChild(style);
}

function rmCardBuildShell() {
  const page = document.getElementById('rawMaterialsCardPage');
  if (!page || page.dataset.built) return;
  page.dataset.built = '1';
  page.innerHTML = `
    <div class="rm-card-page">
      <div class="rmc-header-row">
        <button class="btn btn-outline" onclick="rmCloseCard()">→ חזרה לרשימה</button>
      </div>
      <div id="rmCardBody"></div>
    </div>`;
}

async function rmOpenCard(id) {
  RM_CARD_ID = id;
  RM_CARD_EDITING_HEADER = false;
  rmCardInjectStyles();
  rmCardBuildShell();
  document.getElementById('rawMaterialsPage').style.display = 'none';
  document.getElementById('rawMaterialsCardPage').style.display = 'block';
  await rmLoadCard();
}

function rmCloseCard() {
  document.getElementById('rawMaterialsCardPage').style.display = 'none';
  document.getElementById('rawMaterialsPage').style.display = 'block';
}

async function rmLoadCard() {
  document.getElementById('rmCardBody').innerHTML = '<div class="loading"><div class="spinner"></div>טוען...</div>';
  try {
    const [detail, matrix] = await Promise.all([
      apiFetch('/api/raw-material-registry/' + RM_CARD_ID),
      apiFetch('/api/raw-materials/' + RM_CARD_ID + '/approvals'),
    ]);
    RM_CARD_DATA = detail;
    RM_CARD_MATRIX = matrix;
    rmRenderCard();
  } catch (e) {
    document.getElementById('rmCardBody').innerHTML = `<div class="alert alert-error">${rmEscapeHtml(e.message)}</div>`;
  }
}

function rmRenderCard() {
  document.getElementById('rmCardBody').innerHTML =
    rmCardHeaderHtml() + rmCardOriginBoxHtml() + rmCardDocsHtml() +
    rmCardApprovalsSectionHtml('YEAR_ROUND') + rmCardApprovalsSectionHtml('PASSOVER') + rmCardSkusHtml();
}

/* ── header: name/supplier/manufacturer/notes, toggle-edit ── */
function rmCardHeaderHtml() {
  const d = RM_CARD_DATA;
  if (RM_CARD_EDITING_HEADER) {
    return `
      <div class="rmc-section">
        <div class="rmc-field-row"><label>שם</label><input type="text" id="rmcName" value="${rmEscapeHtml(d.name)}"/></div>
        <div class="rmc-field-row"><label>ספק</label><input type="text" id="rmcSupplier" value="${rmEscapeHtml(d.supplier)}"/></div>
        <div class="rmc-field-row"><label>יצרן</label><input type="text" id="rmcManufacturer" value="${rmEscapeHtml(d.manufacturer)}"/></div>
        <div class="rmc-field-row"><label>הערות</label><input type="text" id="rmcNotes" value="${rmEscapeHtml(d.notes)}"/></div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn btn-accent" onclick="rmCardSaveHeader()">שמור</button>
          <button class="btn btn-outline" onclick="rmCardCancelHeaderEdit()">ביטול</button>
        </div>
      </div>`;
  }
  return `
    <div class="rmc-section">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div>
          <div style="font-size:1.3rem;font-weight:700;color:var(--ink)">${rmEscapeHtml(d.name)}</div>
          <div style="font-size:.85rem;color:var(--ink2);margin-top:4px">${rmEscapeHtml(d.supplier || '— ספק לא ידוע —')}${d.manufacturer ? ' · ' + rmEscapeHtml(d.manufacturer) : ''}</div>
          ${d.notes ? `<div style="font-size:.82rem;color:var(--ink3);margin-top:6px">${rmEscapeHtml(d.notes)}</div>` : ''}
        </div>
        ${rmIsReadOnly() ? '' : `<button class="btn btn-outline rmc-btn-sm" onclick="rmCardEditHeader()">✎ ערוך</button>`}
      </div>
    </div>`;
}
function rmCardEditHeader() { RM_CARD_EDITING_HEADER = true; rmRenderCard(); }
function rmCardCancelHeaderEdit() { RM_CARD_EDITING_HEADER = false; rmRenderCard(); }
async function rmCardSaveHeader() {
  const body = {
    name: document.getElementById('rmcName').value.trim(),
    supplier: document.getElementById('rmcSupplier').value.trim(),
    manufacturer: document.getElementById('rmcManufacturer').value.trim(),
    notes: document.getElementById('rmcNotes').value.trim(),
  };
  try {
    await apiFetch('/api/raw-material-registry/' + RM_CARD_ID, { method: 'PATCH', body: JSON.stringify(body) });
    showToast('נשמר בהצלחה');
    RM_CARD_EDITING_HEADER = false;
    await rmLoadCard();
  } catch (e) { showToast(e.message); }
}

/* ── כשרות המקור: two sections (ימות השנה / פסח), autosave per field ── */
function rmCardDocOptions(selectedId) {
  return (RM_CARD_DATA.documents || []).map(doc =>
    `<option value="${doc.docId}" ${doc.docId === selectedId ? 'selected' : ''}>${rmEscapeHtml(doc.title)} (${RM_DOC_ROLE_LABEL[doc.docRole] || doc.docRole})</option>`
  ).join('');
}

function rmCardOriginBoxHtml() {
  const d = RM_CARD_DATA;
  const ro = rmIsReadOnly();
  const bodies = RM_STATE.allBodies.filter(b => b.active);
  const bodyOptions = '<option value="">— ללא —</option>' +
    bodies.map(b => `<option value="${b.id}" ${d.originKashrutBodyId === b.id ? 'selected' : ''}>${rmEscapeHtml(b.shortName || b.name)}</option>`).join('');
  const passoverStatusOptions = ['UNKNOWN', 'PASSOVER', 'PASSOVER_KITNIYOT', 'NOT_PASSOVER']
    .map(s => `<option value="${s}" ${d.originPassoverStatus === s ? 'selected' : ''}>${RM_ORIGIN_PASSOVER_LABEL[s] || 'לא ידוע'}</option>`).join('');

  return `
    <div class="rmc-section">
      <div class="rmc-section-title">כשרות המקור</div>
      <div class="rmc-origin-grid">
        <div class="rmc-origin-box">
          <h4>ימות השנה</h4>
          <div class="rmc-field-row"><label>טקסט הכשר</label><input type="text" value="${rmEscapeHtml(d.originKashrutText)}" onblur="rmCardSaveOriginField('originKashrutText', this.value)" ${ro ? 'disabled' : ''}/></div>
          <div class="rmc-field-row"><label>גוף (אופציונלי)</label><select onchange="rmCardSaveOriginField('originKashrutBodyId', this.value)" ${ro ? 'disabled' : ''}>${bodyOptions}</select></div>
          <div class="rmc-field-row"><label>יש תעודה</label><input type="checkbox" ${d.originHasCert ? 'checked' : ''} onchange="rmCardSaveOriginField('originHasCert', this.checked)" ${ro ? 'disabled' : ''}/></div>
          <div class="rmc-field-row"><label>תעודה (קובץ קיים)</label><select onchange="rmCardSaveOriginField('originCertDocId', this.value)" ${ro ? 'disabled' : ''}><option value="">— ללא —</option>${rmCardDocOptions(d.originCertDocId)}</select></div>
          ${ro ? '' : `<div class="rmc-field-row"><label>או העלה חדש</label><input type="file" onchange="rmCardUploadOriginCert(this,'year')"/></div>`}
          <div class="rmc-field-row"><label>תוקף עד</label><input type="date" value="${d.originCertValidUntil ? d.originCertValidUntil.slice(0, 10) : ''}" onchange="rmCardSaveOriginField('originCertValidUntil', this.value)" ${ro ? 'disabled' : ''}/></div>
        </div>
        <div class="rmc-origin-box">
          <h4>פסח</h4>
          <div class="rmc-field-row"><label>טקסט מקור לפסח</label><input type="text" value="${rmEscapeHtml(d.originPassoverText)}" onblur="rmCardSaveOriginField('originPassoverText', this.value)" ${ro ? 'disabled' : ''}/></div>
          <div class="rmc-field-row"><label>סטטוס</label><select onchange="rmCardSaveOriginField('originPassoverStatus', this.value)" ${ro ? 'disabled' : ''}>${passoverStatusOptions}</select></div>
          <div class="rmc-field-row"><label>תעודה (קובץ קיים)</label><select onchange="rmCardSaveOriginField('originPassoverCertDocId', this.value)" ${ro ? 'disabled' : ''}><option value="">— ללא —</option>${rmCardDocOptions(d.originPassoverCertDocId)}</select></div>
          ${ro ? '' : `<div class="rmc-field-row"><label>או העלה חדש</label><input type="file" onchange="rmCardUploadOriginCert(this,'passover')"/></div>`}
          <div class="rmc-field-row"><label>תוקף עד</label><input type="date" value="${d.originPassoverValidUntil ? d.originPassoverValidUntil.slice(0, 10) : ''}" onchange="rmCardSaveOriginField('originPassoverValidUntil', this.value)" ${ro ? 'disabled' : ''}/></div>
        </div>
      </div>
    </div>`;
}

async function rmCardSaveOriginField(field, value) {
  const body = {};
  if (field === 'originHasCert') body[field] = !!value;
  else if (field === 'originKashrutBodyId' || field === 'originCertDocId' || field === 'originPassoverCertDocId') body[field] = value ? parseInt(value) : null;
  else body[field] = value || null;
  try {
    RM_CARD_DATA = await apiFetch('/api/raw-material-registry/' + RM_CARD_ID, { method: 'PATCH', body: JSON.stringify(body) });
    showToast('נשמר');
  } catch (e) {
    showToast(e.message);
    rmRenderCard();
  }
}

async function rmCardUploadOriginCert(inputEl, which) {
  const file = inputEl.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  fd.append('docRole', 'CERT');
  fd.append('name', which === 'passover' ? 'תעודת מקור - פסח' : 'תעודת מקור');
  try {
    const res = await fetch(API + '/api/raw-material-registry/' + RM_CARD_ID + '/documents', { method: 'POST', headers: authHeaders(), body: fd });
    const doc = await res.json();
    if (!res.ok) throw new Error(doc.error || 'שגיאה בהעלאה');
    const patch = which === 'passover' ? { originPassoverCertDocId: doc.docId } : { originCertDocId: doc.docId, originHasCert: true };
    await apiFetch('/api/raw-material-registry/' + RM_CARD_ID, { method: 'PATCH', body: JSON.stringify(patch) });
    showToast('הקובץ הועלה והוגדר כתעודת מקור');
    await rmLoadCard();
  } catch (e) { showToast(e.message); }
}

/* ── documents gallery by role ── */
function rmCardDocThumb(doc) {
  const isImg = RM_IMAGE_EXT.includes((doc.ext || '').toLowerCase());
  const href = `/api/docs/${doc.docId}/download?inline=1`;
  const inner = isImg ? `<img src="${href}" alt="${rmEscapeHtml(doc.title)}"/>` : '📄';
  return `<a class="rmc-doc-thumb" href="${href}" target="_blank" title="${rmEscapeHtml(doc.title)}">${inner}</a>`;
}

function rmCardDocsHtml() {
  const docs = RM_CARD_DATA.documents || [];
  const byRole = {};
  RM_DOC_ROLES.forEach(r => byRole[r] = docs.filter(d => d.docRole === r));
  return `
    <div class="rmc-section">
      <div class="rmc-section-title">מסמכים ותמונות</div>
      <div class="rmc-doc-roles">
        ${RM_DOC_ROLES.map(role => `
          <div>
            <div class="rmc-doc-role-title">${RM_DOC_ROLE_LABEL[role]}${byRole[role].length ? ' (' + byRole[role].length + ')' : ''}</div>
            <div class="rmc-doc-grid">${byRole[role].map(rmCardDocThumb).join('') || '<span style="font-size:.78rem;color:var(--ink3)">—</span>'}</div>
          </div>`).join('')}
      </div>
      ${rmIsReadOnly() ? '' : `
        <div style="display:flex;gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap">
          <select id="rmcUploadRole">${RM_DOC_ROLES.map(r => `<option value="${r}">${RM_DOC_ROLE_LABEL[r]}</option>`).join('')}</select>
          <input type="file" id="rmcUploadFile"/>
          <button class="btn btn-accent rmc-btn-sm" onclick="rmCardUploadDoc()">⬆ העלה</button>
        </div>`}
    </div>`;
}

async function rmCardUploadDoc() {
  const fileInput = document.getElementById('rmcUploadFile');
  const file = fileInput.files[0];
  if (!file) { showToast('נא לבחור קובץ'); return; }
  const role = document.getElementById('rmcUploadRole').value;
  const fd = new FormData();
  fd.append('file', file);
  fd.append('docRole', role);
  try {
    const res = await fetch(API + '/api/raw-material-registry/' + RM_CARD_ID + '/documents', { method: 'POST', headers: authHeaders(), body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'שגיאה בהעלאה');
    showToast('הקובץ הועלה');
    await rmLoadCard();
  } catch (e) { showToast(e.message); }
}

/* ── approvals table, two sections ── */
function rmCardApprovalsSectionHtml(track) {
  const rows = (RM_CARD_MATRIX || []).filter(a => a.track === track);
  const cols = track === 'PASSOVER'
    ? ['גוף', 'סטטוס', 'איש קשר', 'נשלח', 'תשובה', 'קובץ תשובה', 'תנאי/הערה', 'שנה', '']
    : ['גוף', 'סטטוס', 'איש קשר', 'נשלח', 'תשובה', 'קובץ תשובה', 'תנאי/הערה', ''];
  return `
    <div class="rmc-section">
      <div class="rmc-section-title">אישורים — ${track === 'PASSOVER' ? 'פסח' : 'ימות השנה'}</div>
      <div style="overflow-x:auto">
        <table class="rmc-table">
          <thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>
          <tbody>${rows.map(a => rmCardApprovalRowHtml(a, track)).join('')}</tbody>
        </table>
      </div>
    </div>`;
}

function rmCardApprovalRowHtml(a, track) {
  const replyFile = a.replyDocId ? `<a href="/api/docs/${a.replyDocId}/download?inline=1" target="_blank">📄</a>` : '—';
  const buttons = rmIsReadOnly() ? '' : `
    <button class="btn btn-outline rmc-btn-sm" onclick="rmOpenSendModal(${a.kashrutBodyId},'${a.track}',false)">שלח</button>
    ${a.id ? `<button class="btn btn-outline rmc-btn-sm" onclick="rmOpenReplyModal(${a.id})">עדכן תשובה</button>` : ''}
    ${a.status === 'NEEDS_INFO' ? `<button class="btn btn-outline rmc-btn-sm" onclick="rmOpenSendModal(${a.kashrutBodyId},'${a.track}',true)">שלח השלמה</button>` : ''}
    ${a.status === 'SENT_FOR_REVIEW' ? `<button class="btn btn-accent rmc-btn-sm" onclick="rmCardConfirmForward(${a.id})">✔ הועבר לגוף</button>` : ''}
    ${a.id ? `<button class="btn btn-outline rmc-btn-sm" onclick="rmCardOpenHistory(${a.id})">היסטוריה</button>` : ''}`;
  return `
    <tr>
      <td>${rmEscapeHtml(a.kashrutBodyName)}${a.viaOrigin ? ` <span title="מקור" style="color:var(--ink3)">(מקור)</span>` : ''}</td>
      <td><span class="rmc-status-badge" style="background:${RM_STATUS_COLOR[a.status]}">${RM_STATUS_LABEL[a.status]}</span></td>
      <td>${rmEscapeHtml(a.contactName || '—')}</td>
      <td>${a.sentAt ? fmtDate(a.sentAt) : '—'}</td>
      <td>${a.replyAt ? fmtDate(a.replyAt) : '—'}</td>
      <td>${replyFile}</td>
      <td>${rmEscapeHtml(a.conditionText || a.notes || '—')}</td>
      ${track === 'PASSOVER' ? `<td>${rmEscapeHtml(a.seasonYear || '—')}</td>` : ''}
      <td style="white-space:nowrap">${buttons}</td>
    </tr>`;
}

function rmCardStub(what) {
  showToast(what + ' תתווסף בשלב מאוחר יותר (R5/R6)');
}

/* ── history modal (real -- the one R4 piece that doesn't need R5/R6) ── */
function rmCardInjectHistoryModal() {
  if (document.getElementById('rmHistoryModal')) return;
  const div = document.createElement('div');
  div.className = 'modal-bg';
  div.id = 'rmHistoryModal';
  div.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">היסטוריית אישור</div>
        <button class="modal-close" onclick="document.getElementById('rmHistoryModal').classList.remove('open')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div id="rmHistoryBody" style="max-height:400px;overflow-y:auto"></div>
    </div>`;
  document.body.appendChild(div);
}

async function rmCardOpenHistory(approvalId) {
  rmCardInjectHistoryModal();
  document.getElementById('rmHistoryBody').innerHTML = '<div class="loading"><div class="spinner"></div>טוען...</div>';
  document.getElementById('rmHistoryModal').classList.add('open');
  try {
    const events = await apiFetch('/api/approvals/' + approvalId + '/events');
    document.getElementById('rmHistoryBody').innerHTML = events.length ? events.map(e => `
      <div class="rm-hist-row">
        <div class="rm-hist-type">${RM_EVENT_TYPE_LABEL[e.type] || e.type}</div>
        <div style="font-size:.78rem;color:var(--ink3)">${fmtDate(e.at)}${e.byUserName ? ' · ' + rmEscapeHtml(e.byUserName) : ''}</div>
        ${e.fromStatus || e.toStatus ? `<div style="font-size:.8rem;margin-top:3px">${e.fromStatus ? (RM_STATUS_LABEL[e.fromStatus] || e.fromStatus) : '—'} ← ${e.toStatus ? (RM_STATUS_LABEL[e.toStatus] || e.toStatus) : '—'}</div>` : ''}
        ${e.payload ? `<div style="font-size:.74rem;color:var(--ink3);margin-top:3px">${rmEscapeHtml(JSON.stringify(e.payload))}</div>` : ''}
      </div>`).join('') : '<div style="padding:1rem;text-align:center;color:var(--ink3)">אין היסטוריה</div>';
  } catch (e) {
    document.getElementById('rmHistoryBody').innerHTML = `<div class="alert alert-error">${rmEscapeHtml(e.message)}</div>`;
  }
}

/* ── linked SKUs: add/remove ── */
function rmCardSkusHtml() {
  const skus = RM_CARD_DATA.skus || [];
  return `
    <div class="rmc-section">
      <div class="rmc-section-title">מק"טים מקושרים</div>
      <div>
        ${skus.length ? skus.map(s => `
          <span class="rmc-sku-pill">${rmEscapeHtml(s.id)} — ${rmEscapeHtml(s.name)}
            ${rmIsReadOnly() ? '' : `<span onclick="rmCardRemoveSku('${jsAttr(s.id)}')">✕</span>`}
          </span>`).join('') : '<span style="font-size:.82rem;color:var(--ink3)">אין מק"טים מקושרים</span>'}
      </div>
      ${rmIsReadOnly() ? '' : `<button class="btn btn-outline rmc-btn-sm" style="margin-top:8px" onclick="openSkuPicker('rmCard')">+ הוסף מק"ט</button>`}
    </div>`;
}

async function rmCardRemoveSku(skuCode) {
  if (!confirm('להסיר את מק"ט ' + skuCode + '?')) return;
  try {
    await apiFetch('/api/raw-material-registry/' + RM_CARD_ID + '/skus/' + encodeURIComponent(skuCode), { method: 'DELETE' });
    showToast('המק"ט הוסר');
    await rmLoadCard();
  } catch (e) { showToast(e.message); }
}

async function rmCardOnSkuPicked(chosen) {
  for (const sku of chosen) {
    try { await apiFetch('/api/raw-material-registry/' + RM_CARD_ID + '/skus', { method: 'POST', body: JSON.stringify({ skuCode: sku.id }) }); }
    catch (e) { showToast(e.message); }
  }
  showToast('מק"טים נוספו');
  await rmLoadCard();
}

/* ── confirm-forward: "✔ הועבר לגוף" on a SENT_FOR_REVIEW row (R1 rule:
 * email always goes to the user first; this is the step where he confirms
 * he actually forwarded it to the kashrut body). sentAt is editable --
 * asked via a simple prompt rather than a full date-picker widget. ── */
async function rmCardConfirmForward(approvalId) {
  if (!confirm('לאשר שהמייל הועבר בפועל לגוף הכשרות?')) return;
  const dateStr = prompt('תאריך השליחה בפועל (YYYY-MM-DD, השאר ריק = היום):', '');
  const body = {};
  if (dateStr && dateStr.trim()) body.sentAt = dateStr.trim();
  try {
    await apiFetch('/api/approvals/' + approvalId + '/confirm-forward', { method: 'POST', body: JSON.stringify(body) });
    showToast('סומן כנשלח לגוף הכשרות');
    await rmLoadCard();
  } catch (e) { showToast(e.message); }
}

/* ══════════════════════════════════════════════════════════════════════
 * Send modal -- Phase 4 R5 (docrepo-phase4-v2-tracks.md), with the
 * review-first email rule (same file, "Rule for all sending" section):
 * EMAIL never reaches the kashrut body directly -- the server always
 * redirects to REVIEW_EMAIL and records SENT_FOR_REVIEW. This modal just
 * calls the existing /send endpoint; the user confirms the real forward
 * afterward via the "✔ הועבר לגוף" button added above.
 * WhatsApp is unchanged: client-side share/wa.me (same approach as the
 * legacy "ניהול אישור חמרי גלם" screen), then recordOnly=true.
 * ══════════════════════════════════════════════════════════════════════ */

const RM_SEND = {
  bodyIds: new Set(), tracks: new Set(), docIds: new Set(),
  contactByBody: {}, channel: 'EMAIL', followUp: false, contacts: [],
};
let RM_SEND_MESSAGE_DIRTY = false;

function rmSendInjectModal() {
  if (document.getElementById('rmSendModal')) return;
  const div = document.createElement('div');
  div.className = 'modal-bg';
  div.id = 'rmSendModal';
  div.innerHTML = `
    <div class="modal" style="max-width:560px">
      <div class="modal-header">
        <div class="modal-title">שליחה לאישור</div>
        <button class="modal-close" onclick="document.getElementById('rmSendModal').classList.remove('open')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div id="rmSendBody" style="max-height:70vh;overflow-y:auto"></div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="document.getElementById('rmSendModal').classList.remove('open')">ביטול</button>
        <button class="btn btn-accent" id="rmSendSubmitBtn" onclick="rmSendSubmit()">שלח</button>
      </div>
    </div>`;
  document.body.appendChild(div);
}

async function rmOpenSendModal(preselectBodyId, preselectTrack, followUp) {
  rmSendInjectModal();
  RM_SEND.bodyIds = new Set(preselectBodyId ? [preselectBodyId] : []);
  RM_SEND.tracks = new Set(preselectTrack ? [preselectTrack] : ['YEAR_ROUND']);
  RM_SEND.docIds = new Set();
  RM_SEND.contactByBody = {};
  RM_SEND.channel = 'EMAIL';
  RM_SEND.followUp = !!followUp;
  RM_SEND_MESSAGE_DIRTY = false;

  // pre-check the label + the relevant origin certificate
  const docs = RM_CARD_DATA.documents || [];
  docs.filter(d => d.docRole === 'LABEL').forEach(d => RM_SEND.docIds.add(d.docId));
  if (RM_SEND.tracks.has('YEAR_ROUND') && RM_CARD_DATA.originCertDocId) RM_SEND.docIds.add(RM_CARD_DATA.originCertDocId);
  if (RM_SEND.tracks.has('PASSOVER') && RM_CARD_DATA.originPassoverCertDocId) RM_SEND.docIds.add(RM_CARD_DATA.originPassoverCertDocId);

  try { RM_SEND.contacts = await apiFetch('/api/contacts'); } catch (e) { RM_SEND.contacts = []; }
  if (preselectBodyId) rmSendAutoPickContact(preselectBodyId);

  document.getElementById('rmSendModal').classList.add('open');
  rmSendRender();
}

function rmSendAutoPickContact(bodyId) {
  const body = RM_STATE.bodyById.get(bodyId);
  const channelField = RM_SEND.channel === 'EMAIL' ? 'email' : 'phone';
  let contact = null;
  if (body && body.defaultContactId) contact = RM_SEND.contacts.find(c => c.id === body.defaultContactId);
  if (!contact) contact = RM_SEND.contacts.find(c => c.kashrutBodyId === bodyId && c[channelField]);
  if (contact) RM_SEND.contactByBody[bodyId] = contact.id;
}

function rmSendMessageTemplate() {
  const tracks = [...RM_SEND.tracks];
  const tracksText = tracks.length === 2 ? 'לימות השנה ולפסח' : RM_TRACK_LABEL[tracks[0]] || '';
  const followUpLine = RM_SEND.followUp ? 'בהמשך לבקשתכם לפרטים נוספים, ' : '';
  return `שלום,\n\n${followUpLine}מצורפים מסמכים עבור חומר הגלם ${RM_CARD_DATA.name}, בנושא ${tracksText}.\n\nבברכה,\nאחים כהן`;
}

function rmSendToggleBody(bodyId, checked) {
  if (checked) { RM_SEND.bodyIds.add(bodyId); rmSendAutoPickContact(bodyId); }
  else RM_SEND.bodyIds.delete(bodyId);
  rmSendRender();
}
function rmSendToggleTrack(track, checked) {
  if (checked) RM_SEND.tracks.add(track); else RM_SEND.tracks.delete(track);
  if (!RM_SEND.tracks.size) RM_SEND.tracks.add(track); // keep at least one
  rmSendRender();
}
function rmSendToggleDoc(docId, checked) {
  if (checked) RM_SEND.docIds.add(docId); else RM_SEND.docIds.delete(docId);
}
function rmSendSetChannel(channel) {
  RM_SEND.channel = channel;
  rmSendRender();
}
function rmSendPickContact(bodyId, contactId) {
  RM_SEND.contactByBody[bodyId] = contactId ? parseInt(contactId) : null;
}
async function rmSendAddContact(bodyId) {
  const name = prompt('שם איש הקשר:');
  if (!name || !name.trim()) return;
  const value = prompt(RM_SEND.channel === 'EMAIL' ? 'כתובת מייל:' : 'מספר טלפון:');
  if (!value || !value.trim()) return;
  const body = { name: name.trim(), kashrutBodyId: bodyId };
  body[RM_SEND.channel === 'EMAIL' ? 'email' : 'phone'] = value.trim();
  try {
    const contact = await apiFetch('/api/contacts', { method: 'POST', body: JSON.stringify(body) });
    RM_SEND.contacts.push(contact);
    RM_SEND.contactByBody[bodyId] = contact.id;
    showToast('איש הקשר נשמר');
    rmSendRender();
  } catch (e) { showToast(e.message); }
}

function rmSendRender() {
  const channelField = RM_SEND.channel === 'EMAIL' ? 'email' : 'phone';
  const bodies = RM_STATE.allBodies.filter(b => b.active).sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));
  const docs = RM_CARD_DATA.documents || [];
  const el = document.getElementById('rmSendBody');
  // every toggle (body/track/channel) re-renders this whole block -- if the
  // user already edited the message, keep their text instead of
  // regenerating the template and silently discarding it
  const existingMsgEl = document.getElementById('rmSendMessage');
  const messageValue = (RM_SEND_MESSAGE_DIRTY && existingMsgEl) ? existingMsgEl.value : rmSendMessageTemplate();
  el.innerHTML = `
    ${RM_SEND.followUp ? `<div class="alert" style="background:#ede9fe;color:#5b21b6;padding:8px 12px;border-radius:8px;margin-bottom:10px;font-size:.82rem">שליחת השלמת מידע לבקשה קיימת (NEEDS_INFO)</div>` : ''}
    <div class="form-group">
      <label class="form-label">מסלול</label>
      <div style="display:flex;gap:10px">
        <label style="font-size:.85rem"><input type="checkbox" ${RM_SEND.tracks.has('YEAR_ROUND') ? 'checked' : ''} onchange="rmSendToggleTrack('YEAR_ROUND',this.checked)"/> ימות השנה</label>
        <label style="font-size:.85rem"><input type="checkbox" ${RM_SEND.tracks.has('PASSOVER') ? 'checked' : ''} onchange="rmSendToggleTrack('PASSOVER',this.checked)"/> פסח</label>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">ערוץ</label>
      <div style="display:flex;gap:8px">
        <button type="button" class="btn ${RM_SEND.channel === 'EMAIL' ? 'btn-accent' : 'btn-outline'}" style="flex:1" onclick="rmSendSetChannel('EMAIL')">✉ מייל</button>
        <button type="button" class="btn ${RM_SEND.channel === 'WHATSAPP' ? 'btn-accent' : 'btn-outline'}" style="flex:1" onclick="rmSendSetChannel('WHATSAPP')">💬 וואטסאפ</button>
      </div>
      ${RM_SEND.channel === 'EMAIL' ? `<p style="font-size:.74rem;color:var(--ink3);margin-top:4px">המייל יישלח אליך לבדיקה, לא ישירות לגוף הכשרות. תוכל לאשר העברה בפועל אחרי ששלחת אותו.</p>` : ''}
    </div>
    <div class="form-group">
      <label class="form-label">גופי כשרות ואנשי קשר</label>
      <div style="max-height:180px;overflow-y:auto;border:1px solid var(--border2);border-radius:8px;padding:6px">
        ${bodies.map(b => {
          const checked = RM_SEND.bodyIds.has(b.id);
          const contactOptions = RM_SEND.contacts.filter(c => c.kashrutBodyId === b.id && c[channelField]);
          return `
            <div style="padding:5px 4px;${checked ? '' : 'opacity:.6'}">
              <label style="display:flex;align-items:center;gap:8px;font-size:.84rem;cursor:pointer">
                <input type="checkbox" ${checked ? 'checked' : ''} onchange="rmSendToggleBody(${b.id},this.checked)"/>
                ${rmEscapeHtml(b.shortName || b.name)}
              </label>
              ${checked ? `
                <div style="display:flex;gap:6px;margin:4px 0 0 22px">
                  <select style="flex:1;font-size:.78rem" onchange="rmSendPickContact(${b.id}, this.value)">
                    <option value="">— בחר איש קשר —</option>
                    ${contactOptions.map(c => `<option value="${c.id}" ${RM_SEND.contactByBody[b.id] === c.id ? 'selected' : ''}>${rmEscapeHtml(c.name)} — ${rmEscapeHtml(c[channelField])}</option>`).join('')}
                  </select>
                  <button type="button" class="btn btn-outline" style="font-size:.72rem;padding:3px 7px" onclick="rmSendAddContact(${b.id})">+ חדש</button>
                </div>` : ''}
            </div>`;
        }).join('')}
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">מסמכים לצירוף</label>
      <div style="max-height:150px;overflow-y:auto;border:1px solid var(--border2);border-radius:8px;padding:6px">
        ${docs.length ? docs.map(d => `
          <label style="display:flex;align-items:center;gap:8px;padding:4px;font-size:.82rem;cursor:pointer">
            <input type="checkbox" ${RM_SEND.docIds.has(d.docId) ? 'checked' : ''} onchange="rmSendToggleDoc(${d.docId},this.checked)"/>
            ${rmEscapeHtml(d.title)} <span style="color:var(--ink3);font-size:.72rem">(${RM_DOC_ROLE_LABEL[d.docRole] || d.docRole})</span>
          </label>`).join('') : '<div style="font-size:.8rem;color:var(--ink3);padding:4px">אין מסמכים לחומר גלם זה</div>'}
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">הודעה</label>
      <textarea class="form-input" id="rmSendMessage" rows="5" style="resize:vertical" oninput="RM_SEND_MESSAGE_DIRTY=true">${rmEscapeHtml(messageValue)}</textarea>
    </div>`;
}

async function rmSendSubmit() {
  if (!RM_SEND.bodyIds.size) { showToast('נא לבחור גוף כשרות אחד לפחות'); return; }
  if (!RM_SEND.docIds.size) { showToast('נא לבחור מסמך אחד לפחות'); return; }
  const message = document.getElementById('rmSendMessage').value;
  const tracks = [...RM_SEND.tracks];
  const bodyIds = [...RM_SEND.bodyIds];
  const btn = document.getElementById('rmSendSubmitBtn');
  btn.disabled = true;

  if (RM_SEND.channel === 'EMAIL') {
    for (const bodyId of bodyIds) {
      if (!RM_SEND.contactByBody[bodyId]) { showToast('נא לבחור איש קשר עם כתובת מייל לכל גוף שנבחר'); btn.disabled = false; return; }
    }
    try {
      await apiFetch('/api/raw-materials/' + RM_CARD_ID + '/send', {
        method: 'POST',
        body: JSON.stringify({
          kashrutBodyIds: bodyIds, tracks, contactIds: RM_SEND.contactByBody,
          docIds: [...RM_SEND.docIds], message, via: 'EMAIL', followUp: RM_SEND.followUp,
        }),
      });
      showToast('המייל נשלח אליך לבדיקה -- אחרי שתעביר אותו לגוף הכשרות, אשר זאת בכרטיס עם "✔ הועבר לגוף"');
      document.getElementById('rmSendModal').classList.remove('open');
      await rmLoadCard();
    } catch (e) { showToast(e.message); }
    btn.disabled = false;
    return;
  }

  // WhatsApp: client-side share/wa.me per body (same approach as the
  // legacy screen), one body at a time since each has its own phone number
  for (const bodyId of bodyIds) {
    const contactId = RM_SEND.contactByBody[bodyId];
    const contact = contactId ? RM_SEND.contacts.find(c => c.id === contactId) : null;
    const body = RM_STATE.bodyById.get(bodyId);
    if (!contact || !contact.phone) { showToast(`נא לבחור איש קשר עם טלפון לגוף ${body ? body.name : bodyId}`); continue; }

    try {
      const fetchedFiles = await Promise.all([...RM_SEND.docIds].map(async (docId) => {
        const res = await fetch(API + '/api/docs/' + docId + '/download', { headers: authHeaders() });
        if (!res.ok) throw new Error('שגיאה בטעינת קובץ');
        const blob = await res.blob();
        const doc = (RM_CARD_DATA.documents || []).find(d => d.docId === docId);
        return new File([blob], (doc ? doc.title : 'מסמך') + (doc && doc.ext ? '.' + doc.ext : ''), { type: blob.type || 'application/octet-stream' });
      }));
      if (navigator.canShare && navigator.canShare({ files: fetchedFiles })) {
        try { await navigator.share({ files: fetchedFiles, text: message }); }
        catch (shareErr) { if (shareErr.name !== 'AbortError') throw shareErr; }
      } else {
        fetchedFiles.forEach((file) => {
          const url = URL.createObjectURL(file);
          const a = document.createElement('a'); a.href = url; a.download = file.name; a.click();
          URL.revokeObjectURL(url);
        });
        window.open('https://wa.me/?text=' + encodeURIComponent(message), '_blank');
      }
      if (!confirm(`נשלח בוואטסאפ לגוף ${body.name}?`)) continue;
      await apiFetch('/api/raw-materials/' + RM_CARD_ID + '/send', {
        method: 'POST',
        body: JSON.stringify({
          kashrutBodyIds: [bodyId], tracks, contactIds: { [bodyId]: contactId },
          docIds: [...RM_SEND.docIds], message, via: 'WHATSAPP', recordOnly: true, followUp: RM_SEND.followUp,
        }),
      });
    } catch (e) { showToast(e.message); }
  }
  showToast('נרשם בהצלחה');
  document.getElementById('rmSendModal').classList.remove('open');
  btn.disabled = false;
  await rmLoadCard();
}

/* ══════════════════════════════════════════════════════════════════════
 * Reply modal -- Phase 4 R6 (docrepo-phase4-v2-tracks.md): pick the body
 * (fixed to whichever row's "עדכן תשובה" was clicked), then show both of
 * that body's tracks, each with its own status selector. Backend already
 * supports exactly this via alsoApprovalId on POST /api/approvals/:id/reply
 * (added alongside R2), so this is frontend only -- except one small
 * backend symmetry fix (notes now shared onto the also-track too, it
 * previously only landed on the primary one).
 * ══════════════════════════════════════════════════════════════════════ */

const RM_REPLY_STATUSES_BY_TRACK = {
  YEAR_ROUND: ['APPROVED', 'REJECTED', 'NEEDS_INFO', 'CONDITIONAL'],
  PASSOVER: ['APPROVED', 'REJECTED', 'NEEDS_INFO', 'APPROVED_KITNIYOT'],
};

let RM_REPLY = { tracks: {} }; // { YEAR_ROUND?: {approvalId,included,status}, PASSOVER?: {...} }

function rmReplyInjectModal() {
  if (document.getElementById('rmReplyModal')) return;
  const div = document.createElement('div');
  div.className = 'modal-bg';
  div.id = 'rmReplyModal';
  div.innerHTML = `
    <div class="modal" style="max-width:520px">
      <div class="modal-header">
        <div class="modal-title">עדכון תשובה</div>
        <button class="modal-close" onclick="document.getElementById('rmReplyModal').classList.remove('open')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div id="rmReplyBody"></div>
      <div class="modal-footer">
        <button class="btn btn-outline" onclick="document.getElementById('rmReplyModal').classList.remove('open')">ביטול</button>
        <button class="btn btn-accent" id="rmReplySubmitBtn" onclick="rmReplySubmit()">שמור תשובה</button>
      </div>
    </div>`;
  document.body.appendChild(div);
}

function rmOpenReplyModal(approvalId) {
  const clicked = (RM_CARD_MATRIX || []).find(a => a.id === approvalId);
  if (!clicked) return;
  rmReplyInjectModal();
  RM_REPLY.tracks = {};
  for (const track of ['YEAR_ROUND', 'PASSOVER']) {
    const row = RM_CARD_MATRIX.find(a => a.kashrutBodyId === clicked.kashrutBodyId && a.track === track);
    if (!row || !row.id) continue; // no real row for this track -- nothing to reply to
    const isDecisionStatus = RM_REPLY_STATUSES_BY_TRACK[track].includes(row.status);
    RM_REPLY.tracks[track] = {
      approvalId: row.id,
      included: row.id === approvalId || row.status === 'SENT_PENDING',
      status: isDecisionStatus ? row.status : RM_REPLY_STATUSES_BY_TRACK[track][0],
    };
  }
  document.getElementById('rmReplyModal').classList.add('open');
  rmReplyRender();
}

function rmReplyToggleTrack(track, checked) {
  if (RM_REPLY.tracks[track]) RM_REPLY.tracks[track].included = checked;
  rmReplyRender();
}
function rmReplySetStatus(track, status) {
  if (RM_REPLY.tracks[track]) RM_REPLY.tracks[track].status = status;
  rmReplyRender();
}

function rmReplyRender() {
  const el = document.getElementById('rmReplyBody');
  // preserve any already-typed values across re-renders (same issue as the send modal)
  const keep = (id) => { const e = document.getElementById(id); return e ? e.value : ''; };
  const conditionText = keep('rmReplyCondition');
  const seasonYear = keep('rmReplySeasonYear');
  const notes = keep('rmReplyNotes');
  const approvalSourceDetail = keep('rmReplySourceDetail');
  const replyAt = document.getElementById('rmReplyDate') ? document.getElementById('rmReplyDate').value : new Date().toISOString().slice(0, 10);
  const approvalSource = document.getElementById('rmReplySource') ? document.getElementById('rmReplySource').value : '';
  const hasFile = document.getElementById('rmReplyFile') && document.getElementById('rmReplyFile').files.length > 0;

  const trackRows = Object.entries(RM_REPLY.tracks).map(([track, t]) => `
    <div class="form-group" style="border:1px solid var(--border2);border-radius:8px;padding:10px">
      <label style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:.86rem">
        <input type="checkbox" ${t.included ? 'checked' : ''} onchange="rmReplyToggleTrack('${track}',this.checked)"/>
        ${RM_TRACK_LABEL[track]}
      </label>
      ${t.included ? `
        <select class="form-select" style="margin-top:6px" onchange="rmReplySetStatus('${track}',this.value)">
          ${RM_REPLY_STATUSES_BY_TRACK[track].map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${RM_STATUS_LABEL[s]}</option>`).join('')}
        </select>
        ${track === 'YEAR_ROUND' ? `<input type="text" class="form-input" id="rmReplyCondition" placeholder="תנאי (אם מאושר בתנאים)" value="${rmEscapeHtml(conditionText)}" style="margin-top:6px"/>` : ''}
        ${track === 'PASSOVER' ? `<input type="text" class="form-input" id="rmReplySeasonYear" placeholder='שנה עברית, למשל תשפ"ז' value="${rmEscapeHtml(seasonYear)}" style="margin-top:6px"/>` : ''}
      ` : ''}
    </div>`).join('');

  el.innerHTML = `
    <div id="rmReplyAlert"></div>
    ${trackRows}
    <div class="form-group">
      <label class="form-label">קובץ תשובה (אופציונלי)</label>
      <input type="file" id="rmReplyFile" onchange="rmReplyRender()"/>
    </div>
    <div class="form-group">
      <label class="form-label">תאריך תשובה</label>
      <input type="date" class="form-input" id="rmReplyDate" value="${replyAt}"/>
    </div>
    ${!hasFile ? `
      <div class="form-group">
        <label class="form-label">מקור האישור (חובה כשאין קובץ)</label>
        <select class="form-select" id="rmReplySource">
          <option value="">— בחר —</option>
          ${['PHONE', 'EMAIL', 'WHATSAPP', 'LETTER', 'PREVIOUS_YEAR', 'BODY_LIST', 'OTHER'].map(s => `<option value="${s}" ${approvalSource === s ? 'selected' : ''}>${RM_APPROVAL_SOURCE_LABEL[s]}</option>`).join('')}
        </select>
        <input type="text" class="form-input" id="rmReplySourceDetail" placeholder="פרטים (מי אמר / איזה מייל / איזו שנה...)" value="${rmEscapeHtml(approvalSourceDetail)}" style="margin-top:6px"/>
      </div>` : ''}
    <div class="form-group">
      <label class="form-label">הערות</label>
      <textarea class="form-input" id="rmReplyNotes" rows="3">${rmEscapeHtml(notes)}</textarea>
    </div>`;
}

const RM_APPROVAL_SOURCE_LABEL = { PHONE: 'טלפון', EMAIL: 'מייל', WHATSAPP: 'וואטסאפ', LETTER: 'מכתב', PREVIOUS_YEAR: 'שנה קודמת', BODY_LIST: 'רשימת גוף', OTHER: 'אחר' };

async function rmReplySubmit() {
  const included = Object.entries(RM_REPLY.tracks).filter(([, t]) => t.included);
  if (!included.length) { showToast('נא לבחור מסלול אחד לפחות'); return; }

  const file = document.getElementById('rmReplyFile').files[0];
  const replyAt = document.getElementById('rmReplyDate').value;
  const notes = document.getElementById('rmReplyNotes').value.trim();
  const sourceEl = document.getElementById('rmReplySource');
  const approvalSource = sourceEl ? sourceEl.value : undefined;
  const approvalSourceDetailEl = document.getElementById('rmReplySourceDetail');
  const approvalSourceDetail = approvalSourceDetailEl ? approvalSourceDetailEl.value.trim() : undefined;

  const [primaryTrack, primary] = included[0];
  const also = included[1]; // [track, data] or undefined

  const fd = new FormData();
  if (file) fd.append('file', file);
  fd.append('status', primary.status);
  if (replyAt) fd.append('replyAt', replyAt);
  if (notes) fd.append('notes', notes);
  if (primaryTrack === 'YEAR_ROUND') {
    const ct = document.getElementById('rmReplyCondition');
    if (ct && ct.value.trim()) fd.append('conditionText', ct.value.trim());
  } else {
    const sy = document.getElementById('rmReplySeasonYear');
    if (sy && sy.value.trim()) fd.append('seasonYear', sy.value.trim());
  }
  if (!file) {
    if (!approvalSource) { showToast('נא לבחור מקור לאישור כשאין קובץ'); return; }
    fd.append('approvalSource', approvalSource);
    if (approvalSourceDetail) fd.append('approvalSourceDetail', approvalSourceDetail);
  }
  if (also) {
    const [alsoTrack, alsoData] = also;
    fd.append('alsoApprovalId', String(alsoData.approvalId));
    fd.append('alsoStatus', alsoData.status);
    if (alsoTrack === 'YEAR_ROUND') {
      const ct = document.getElementById('rmReplyCondition');
      if (ct && ct.value.trim()) fd.append('alsoConditionText', ct.value.trim());
    } else {
      const sy = document.getElementById('rmReplySeasonYear');
      if (sy && sy.value.trim()) fd.append('alsoSeasonYear', sy.value.trim());
    }
  }

  const btn = document.getElementById('rmReplySubmitBtn');
  btn.disabled = true;
  try {
    // raw fetch, not apiFetch -- apiFetch forces Content-Type: application/json,
    // which would break this multipart FormData body (no boundary set)
    const res = await fetch(API + '/api/approvals/' + primary.approvalId + '/reply', { method: 'POST', headers: authHeaders(), body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'שגיאה בשמירת התשובה');
    showToast('התשובה נשמרה');
    document.getElementById('rmReplyModal').classList.remove('open');
    await rmLoadCard();
  } catch (e) {
    document.getElementById('rmReplyAlert').innerHTML = `<div class="alert alert-error">${rmEscapeHtml(e.message)}</div>`;
  }
  btn.disabled = false;
}
