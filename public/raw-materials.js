/* ══════════════════════════════════════════════════════════════════════
 * Raw-Material Registry -- Phase 4, Step 4.1 only (registry list screen).
 * Self-contained: injects its own <style> and page markup at runtime so
 * index.html itself only needs a nav button + an empty container + this
 * <script> tag (index.html has a history of encoding corruption, so it
 * gets the smallest possible edit).
 *
 * Reuses globals already defined in index.html's main inline script:
 * apiFetch(), showToast(), fmtDate(). Talks only to the Phase 3 API
 * (/api/raw-material-registry, /api/kashrut-bodies) -- read-only in this
 * step, no write calls at all.
 * ══════════════════════════════════════════════════════════════════════ */

const RM_STATUS_LABEL = {
  NOT_SENT: 'לא נשלח', SENT_PENDING: 'ממתין לתשובה', APPROVED: 'מאושר',
  REJECTED: 'נדחה', CONDITIONAL: 'מאושר בתנאים',
};
const RM_STATUS_COLOR = {
  NOT_SENT: '#A09D98', SENT_PENDING: '#f59e0b', APPROVED: '#2D5A3D',
  REJECTED: '#dc2626', CONDITIONAL: '#2563eb',
};
const RM_PASSOVER_LABEL = {
  NOT_ASKED: 'לא נשאל', PASSOVER: 'כשר לפסח', PASSOVER_KITNIYOT: 'כשר לפסח (קטניות)', NOT_PASSOVER: 'לא כשר לפסח',
};
const RM_PASSOVER_COLOR = {
  PASSOVER: '#2D5A3D', PASSOVER_KITNIYOT: '#f59e0b', NOT_PASSOVER: '#dc2626',
};

const RM_STATE = { items: [], bodies: [], loaded: false };

function rmEscapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rmInjectStyles() {
  if (document.getElementById('rmStyles')) return;
  const style = document.createElement('style');
  style.id = 'rmStyles';
  style.textContent = `
#rawMaterialsPage{max-width:1200px;margin:0 auto;padding:2rem;}
.rm-page-header{display:flex;align-items:center;gap:14px;margin-bottom:1.25rem;}
.rm-page-header h1{font-family:'Frank Ruhl Libre',serif;font-size:1.6rem;font-weight:700;color:var(--ink);}
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
.rm-needs-review{font-size:.7rem;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:99px;font-weight:600;margin-right:6px;}
.rm-legend{display:flex;align-items:flex-end;gap:14px;margin-bottom:6px;}
.rm-legend-spacer{flex:1;min-width:220px;}
.rm-dots-grid{display:grid;gap:4px;}
.rm-legend-label{font-size:.62rem;color:var(--ink3);text-align:center;line-height:1.15;word-break:break-word;}
.rm-dot-cell{display:flex;justify-content:center;}
.rm-dot-wrap{position:relative;width:14px;height:14px;}
.rm-dot{width:14px;height:14px;border-radius:50%;display:block;cursor:default;}
.rm-passover-badge{position:absolute;bottom:-4px;right:-4px;width:10px;height:10px;border-radius:50%;background:#fff;border:1px solid var(--border2);font-size:7px;font-weight:800;line-height:9px;text-align:center;cursor:default;}
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
    </div>
    <div class="rm-summary" id="rmSummary"></div>
    <div class="rm-filters">
      <input type="search" id="rmSearchInput" placeholder='חפש לפי שם, ספק, יצרן או מק"ט...' oninput="rmApplyFilters()" autocomplete="off"/>
      <select id="rmBodyFilter" onchange="rmApplyFilters()"></select>
      <select id="rmStatusFilter" onchange="rmApplyFilters()">
        <option value="">כל הסטטוסים</option>
        <option value="NOT_SENT">לא נשלח</option>
        <option value="SENT_PENDING">ממתין לתשובה</option>
        <option value="APPROVED">מאושר</option>
        <option value="REJECTED">נדחה</option>
        <option value="CONDITIONAL">מאושר בתנאים</option>
      </select>
      <select id="rmSupplierFilter" onchange="rmApplyFilters()"></select>
      <select id="rmPassoverFilter" onchange="rmApplyFilters()"></select>
      <label><input type="checkbox" id="rmNeedsReviewFilter" onchange="rmApplyFilters()"/> ⚠ לבדוק בלבד</label>
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
    RM_STATE.bodies = bodies.filter(b => b.active);
    RM_STATE.loaded = true;
    rmPopulateFilterOptions();
    rmRenderLegend();
    rmApplyFilters();
  } catch (e) {
    document.getElementById('rmList').innerHTML = `<div class="alert alert-error">${rmEscapeHtml(e.message)}</div>`;
  }
}

function rmPopulateFilterOptions() {
  const bodySel = document.getElementById('rmBodyFilter');
  bodySel.innerHTML = '<option value="">כל גופי הכשרות</option>' +
    RM_STATE.bodies.map(b => `<option value="${b.id}">${rmEscapeHtml(b.name)}</option>`).join('');

  const suppliers = [...new Set(RM_STATE.items.map(r => r.supplier).filter(Boolean))].sort();
  const supplierSel = document.getElementById('rmSupplierFilter');
  supplierSel.innerHTML = '<option value="">כל הספקים</option>' +
    suppliers.map(s => `<option value="${rmEscapeHtml(s)}">${rmEscapeHtml(s)}</option>`).join('');

  const passoverBodies = RM_STATE.bodies.filter(b => b.handlesPassover);
  const passoverSel = document.getElementById('rmPassoverFilter');
  passoverSel.innerHTML = '<option value="">מאושר לפסח (גוף)</option>' +
    passoverBodies.map(b => `<option value="${b.id}">מאושר לפסח: ${rmEscapeHtml(b.shortName || b.name)}</option>`).join('');
}

// one status per active kashrut body for this material -- a real
// RawMaterialApproval row if one exists, else a synthesized NOT_SENT,
// mirroring what GET /api/raw-materials/:id/approvals computes server-side
// (done client-side here so Step 4.1 needs no backend changes at all).
function rmStatusByBody(item) {
  const byBody = new Map(item.approvals.map(a => [a.kashrutBodyId, a]));
  return RM_STATE.bodies.map(b => {
    const a = byBody.get(b.id);
    return a
      ? { body: b, status: a.status, sentAt: a.sentAt, passoverStatus: a.passoverStatus, passoverYear: a.passoverYear }
      : { body: b, status: 'NOT_SENT', sentAt: null, passoverStatus: 'NOT_ASKED', passoverYear: '' };
  });
}

// shared column template so the legend header's labels line up exactly
// over each row's dots, regardless of how many active bodies there are
function rmGridTemplate() {
  return `repeat(${RM_STATE.bodies.length}, 46px)`;
}

function rmRenderLegend() {
  document.getElementById('rmLegend').innerHTML = `
    <div class="rm-legend-spacer"></div>
    <div class="rm-dots-grid" style="grid-template-columns:${rmGridTemplate()}">
      ${RM_STATE.bodies.map(b => `<div class="rm-legend-label" title="${rmEscapeHtml(b.name)}">${rmEscapeHtml(b.shortName || b.name)}</div>`).join('')}
    </div>`;
}

function rmDaysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function rmApplyFilters() {
  if (!RM_STATE.loaded) return;
  const q = document.getElementById('rmSearchInput').value.trim().toLowerCase();
  const bodyId = document.getElementById('rmBodyFilter').value;
  const status = document.getElementById('rmStatusFilter').value;
  const supplier = document.getElementById('rmSupplierFilter').value;
  const passoverBodyId = document.getElementById('rmPassoverFilter').value;
  const needsReviewOnly = document.getElementById('rmNeedsReviewFilter').checked;
  const staleOn = document.getElementById('rmStaleToggle').checked;
  const staleDays = parseInt(document.getElementById('rmStaleDays').value) || 14;

  const rows = RM_STATE.items.map(item => ({ item, statuses: rmStatusByBody(item) }));

  const filtered = rows.filter(({ item, statuses }) => {
    const needsReview = item.approvals.length === 0;
    if (needsReviewOnly && !needsReview) return false;
    if (supplier && item.supplier !== supplier) return false;
    if (passoverBodyId) {
      const s = statuses.find(s => s.body.id === parseInt(passoverBodyId));
      if (!s || s.passoverStatus !== 'PASSOVER') return false;
    }

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

  rmRenderSummary(rows.map(r => r.item));
  rmRenderList(filtered);
}

function rmRenderSummary(items) {
  const total = items.length;
  const pending = items.filter(i => i.approvals.some(a => a.status === 'SENT_PENDING')).length;
  const rejected = items.filter(i => i.approvals.some(a => a.status === 'REJECTED')).length;
  const needsReview = items.filter(i => i.approvals.length === 0).length;
  document.getElementById('rmSummary').innerHTML = `
    <div class="rm-stat">סה"כ <strong>${total}</strong></div>
    <div class="rm-stat">ממתינים לתשובה <strong>${pending}</strong></div>
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
    const dots = statuses.map(s => {
      const days = s.status === 'SENT_PENDING' ? rmDaysSince(s.sentAt) : null;
      const passoverLine = s.body.handlesPassover
        ? `\nפסח: ${RM_PASSOVER_LABEL[s.passoverStatus]}${s.passoverYear ? ' (' + s.passoverYear + ')' : ''}` : '';
      const title = `${s.body.name}: ${RM_STATUS_LABEL[s.status]}${days != null ? ` (${days} ימים)` : ''}${passoverLine}`;
      const badge = (s.body.handlesPassover && s.passoverStatus !== 'NOT_ASKED')
        ? `<span class="rm-passover-badge" style="color:${RM_PASSOVER_COLOR[s.passoverStatus]}" title="${rmEscapeHtml(title)}">פ</span>` : '';
      return `<div class="rm-dot-cell"><span class="rm-dot-wrap"><span class="rm-dot" style="background:${RM_STATUS_COLOR[s.status]}" title="${rmEscapeHtml(title)}"></span>${badge}</span></div>`;
    }).join('');
    return `
      <div class="rm-row">
        <div class="rm-row-main">
          <div class="rm-row-name">${needsReview ? '<span class="rm-needs-review">לבדוק</span>' : ''}${rmEscapeHtml(item.name)}</div>
          <div class="rm-row-sub">${rmEscapeHtml(item.supplier || '— ספק לא ידוע —')}${item.manufacturer ? ' · ' + rmEscapeHtml(item.manufacturer) : ''} · ${skuText}</div>
        </div>
        <div class="rm-dots-grid" style="grid-template-columns:${rmGridTemplate()}">${dots}</div>
      </div>`;
  }).join('');
}
