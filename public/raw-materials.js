/* ══════════════════════════════════════════════════════════════════════
 * Raw-Material Registry -- list screen.
 * Phase 4 Step 4.1 (list) + the 3.11.2026 two-track revision's R3
 * (docrepo-phase4-v2-tracks.md): a year-round/Passover track switch now
 * drives the dots, legend, status filter, counters and the stale-pending
 * filter. The old single-row "פ" badge + "מאושר לפסח (גוף)" filter from
 * the superseded same-day Passover-fields attempt are removed -- the
 * Passover track view replaces both.
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

const RM_STATE = {
  items: [], allBodies: [], bodyById: new Map(),
  yearRoundBodies: [], passoverBodies: [],
  track: 'YEAR_ROUND', loaded: false,
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
#rawMaterialsPage{max-width:1200px;margin:0 auto;padding:2rem;}
.rm-page-header{display:flex;align-items:center;gap:14px;margin-bottom:1.25rem;flex-wrap:wrap;}
.rm-page-header h1{font-family:'Frank Ruhl Libre',serif;font-size:1.6rem;font-weight:700;color:var(--ink);}
.rm-track-switch{display:flex;gap:4px;background:var(--bg2);border-radius:99px;padding:3px;margin-right:auto;}
.rm-track-btn{padding:6px 16px;border-radius:99px;border:none;background:transparent;font-family:'Heebo',sans-serif;font-size:.85rem;font-weight:500;color:var(--ink2);cursor:pointer;transition:all .15s;}
.rm-track-btn.active{background:var(--accent);color:#fff;}
.rm-summary{display:flex;gap:1.5rem;flex-wrap:wrap;background:var(--bg2);border-radius:var(--radius);padding:.9rem 1.2rem;margin-bottom:1.1rem;}
.rm-summary .rm-stat{font-size:.85rem;color:var(--ink2);}
.rm-summary .rm-stat strong{color:var(--ink);font-size:1.05rem;margin-left:5px;}
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
.rm-row-origin{font-size:.78rem;color:var(--ink2);margin-top:2px;}
.rm-needs-review{font-size:.7rem;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:99px;font-weight:600;margin-right:6px;}
.rm-legend{display:flex;align-items:flex-end;gap:14px;margin-bottom:8px;position:sticky;top:0;z-index:5;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--border);}
.rm-legend-spacer{flex:1;min-width:220px;}
.rm-dots-grid{display:grid;gap:4px;}
.rm-legend-label{font-size:12px;color:var(--ink);font-weight:500;text-align:center;line-height:1.2;word-break:break-word;}
.rm-dot-cell{display:flex;justify-content:center;}
.rm-dot{width:14px;height:14px;border-radius:50%;display:block;cursor:default;}
.rm-empty{text-align:center;padding:3rem;color:var(--ink3);}
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
    </div>
    <div class="rm-summary" id="rmSummary"></div>
    <div class="rm-filters">
      <input type="search" id="rmSearchInput" placeholder='חפש לפי שם, ספק, יצרן או מק"ט...' oninput="rmApplyFilters()" autocomplete="off"/>
      <select id="rmBodyFilter" onchange="rmApplyFilters()"></select>
      <select id="rmStatusFilter" onchange="rmApplyFilters()"></select>
      <select id="rmSupplierFilter" onchange="rmApplyFilters()"></select>
      <label><input type="checkbox" id="rmNeedsReviewFilter" onchange="rmApplyFilters()"/> ⚠ לבדוק בלבד</label>
      <label><input type="checkbox" id="rmNoOriginCertFilter" onchange="rmApplyFilters()"/> ללא תעודת מקור</label>
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

// one status per kashrut body in the CURRENT track's column set -- a real
// RawMaterialApproval row if one exists, else a synthesized NOT_SENT,
// mirroring what GET /api/raw-materials/:id/approvals computes server-side
// (done client-side here so the list screen needs no dedicated matrix call
// per row).
function rmStatusByBody(item, track) {
  const byBody = new Map(item.approvals.filter(a => a.track === track).map(a => [a.kashrutBodyId, a]));
  return rmBodiesForTrack(track).map(b => {
    const a = byBody.get(b.id);
    return a ? { body: b, status: a.status, sentAt: a.sentAt } : { body: b, status: 'NOT_SENT', sentAt: null };
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
    <div class="rm-dots-grid" style="grid-template-columns:${rmGridTemplate()}">
      ${rmBodiesForTrack(RM_STATE.track).map(b => `<div class="rm-legend-label" title="${rmEscapeHtml(b.name)}">${rmEscapeHtml(b.shortName || b.name)}</div>`).join('')}
    </div>`;
}

function rmDaysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function rmOriginLine(item) {
  if (!item.originKashrutText && !item.originHasCert) return null;
  const parts = [];
  if (item.originKashrutText) parts.push(item.originKashrutText);
  if (item.originHasCert) parts.push(item.originCertValidUntil ? 'תעודה עד ' + fmtDate(item.originCertValidUntil) : 'יש תעודה');
  return 'מקור: ' + parts.join(' · ');
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
  const staleOn = document.getElementById('rmStaleToggle').checked;
  const staleDays = parseInt(document.getElementById('rmStaleDays').value) || 14;

  const rows = RM_STATE.items.map(item => ({ item, statuses: rmStatusByBody(item, track) }));

  const filtered = rows.filter(({ item, statuses }) => {
    const needsReview = item.approvals.length === 0;
    if (needsReviewOnly && !needsReview) return false;
    if (noOriginCertOnly && item.originHasCert) return false;
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

function rmRenderList(rows) {
  const el = document.getElementById('rmList');
  if (!rows.length) {
    el.innerHTML = '<div class="rm-empty">לא נמצאו חומרי גלם מתאימים</div>';
    return;
  }
  el.innerHTML = rows.map(({ item, statuses }) => {
    const needsReview = item.approvals.length === 0;
    const skuText = item.skus.length ? item.skus.map(s => rmEscapeHtml(s.id)).join(', ') : 'אין מק"טים מקושרים';
    const originLine = rmOriginLine(item);
    const dots = statuses.map(s => {
      const days = s.status === 'SENT_PENDING' ? rmDaysSince(s.sentAt) : null;
      const title = `${s.body.name}: ${RM_STATUS_LABEL[s.status]}${days != null ? ` (${days} ימים)` : ''}`;
      return `<div class="rm-dot-cell"><span class="rm-dot" style="background:${RM_STATUS_COLOR[s.status]}" title="${rmEscapeHtml(title)}"></span></div>`;
    }).join('');
    return `
      <div class="rm-row">
        <div class="rm-row-main">
          <div class="rm-row-name">${needsReview ? '<span class="rm-needs-review">לבדוק</span>' : ''}${rmEscapeHtml(item.name)}</div>
          <div class="rm-row-sub">${rmEscapeHtml(item.supplier || '— ספק לא ידוע —')}${item.manufacturer ? ' · ' + rmEscapeHtml(item.manufacturer) : ''} · ${skuText}</div>
          ${originLine ? `<div class="rm-row-origin">${rmEscapeHtml(originLine)}</div>` : ''}
        </div>
        <div class="rm-dots-grid" style="grid-template-columns:${rmGridTemplate()}">${dots}</div>
      </div>`;
  }).join('');
}
