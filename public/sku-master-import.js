/* S1 (docrepo-sprint-8.11.md) -- "📥 ייבוא רשימת מק"טים" preview screen.
 * Self-contained, like raw-materials.js / link-suggestions.js: index.html
 * only got a nav button, one empty container, and this <script> tag.
 * PREVIEW ONLY -- this screen never writes to the SKU table. The import
 * (apply) endpoint does not exist yet; it will be built once explicitly
 * approved, in a later step.
 */

let SMI_PREVIEW = null;
let SMI_SELECTED_NEW = new Set();      // codes of new SKUs ticked for creation
let SMI_SELECTED_CHANGES = new Set();  // "code::field" keys ticked to accept

function smiInjectStyles() {
  if (document.getElementById('smiStyles')) return;
  const style = document.createElement('style');
  style.id = 'smiStyles';
  style.textContent = `
    .smi-wrap{max-width:1100px;margin:0 auto;padding:20px}
    .smi-upload{background:#fff;padding:20px;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:16px}
    .smi-counters{display:flex;gap:14px;margin-bottom:16px;flex-wrap:wrap}
    .smi-counter{padding:10px 16px;border-radius:8px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.08);font-size:14px}
    .smi-counter b{font-size:20px;display:block}
    .smi-section{background:#fff;border-radius:10px;padding:16px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    .smi-table{width:100%;border-collapse:collapse;font-size:13px}
    .smi-table th,.smi-table td{padding:6px 8px;text-align:right;border-bottom:1px solid #eee}
    .smi-table th{color:#666;font-weight:600;background:#fafafa}
    .smi-diff-old{color:#c0612f;text-decoration:line-through}
    .smi-diff-new{color:#2e9e4a;font-weight:600}
    .smi-apply-bar{display:flex;align-items:center;gap:12px;padding:14px;background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    .smi-hint{color:#888;font-size:12px}
  `;
  document.head.appendChild(style);
}

function smiBuildPageShell() {
  const page = document.getElementById('skuMasterImportPage');
  if (page.dataset.built) return;
  page.dataset.built = '1';
  page.innerHTML = `
    <div class="smi-wrap">
      <h2 style="margin-bottom:16px">📥 ייבוא רשימת מק"טים <button class="btn btn-outline" style="margin-right:12px;padding:4px 10px;font-size:13px" onclick="closeSkuMasterImport()">✕ סגור</button></h2>
      <div class="smi-upload">
        <input type="file" id="smiFileInput" accept=".csv"/>
        <button class="btn btn-accent" onclick="smiUploadAndPreview()">העלה ותצוגה מקדימה</button>
        <div class="smi-hint">קובץ CSV מהגיליון "מקטים ראשי" (File → Download → CSV)</div>
      </div>
      <div id="smiResults"></div>
    </div>`;
}

async function openSkuMasterImport() {
  smiInjectStyles();
  smiBuildPageShell();
  document.querySelector('.hero') && (document.querySelector('.hero').style.display = 'none');
  document.getElementById('statsBar') && (document.getElementById('statsBar').style.display = 'none');
  document.querySelector('main.main') && (document.querySelector('main.main').style.display = 'none');
  document.getElementById('skuMasterImportPage').style.display = 'block';
}

function closeSkuMasterImport() {
  document.getElementById('skuMasterImportPage').style.display = 'none';
  document.querySelector('.hero') && (document.querySelector('.hero').style.display = '');
  document.getElementById('statsBar') && (document.getElementById('statsBar').style.display = '');
  document.querySelector('main.main') && (document.querySelector('main.main').style.display = '');
}

async function smiUploadAndPreview() {
  const input = document.getElementById('smiFileInput');
  if (!input.files.length) { showToast('בחר קובץ CSV'); return; }
  const fd = new FormData();
  fd.append('file', input.files[0]);
  document.getElementById('smiResults').innerHTML = '<p style="padding:20px;color:#888">מעבד...</p>';
  try {
    // apiFetch forces JSON headers, which breaks multipart -- raw fetch instead.
    const res = await fetch(API + '/api/sku-master-import/preview', { method: 'POST', headers: authHeaders(), body: fd });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'שגיאה'); }
    SMI_PREVIEW = await res.json();
    SMI_SELECTED_NEW = new Set();
    SMI_SELECTED_CHANGES = new Set();
    smiRenderResults();
  } catch (e) {
    document.getElementById('smiResults').innerHTML = `<p style="padding:20px;color:#c0612f">שגיאה: ${jsAttr(e.message)}</p>`;
  }
}

function smiFmtVal(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (v === true) return 'כן';
  if (v === false) return 'לא';
  return String(v);
}

function smiRenderResults() {
  const p = SMI_PREVIEW;
  const el = document.getElementById('smiResults');
  let html = `
    <div class="smi-counters">
      <div class="smi-counter"><b>${p.totalRows}</b>שורות בקובץ</div>
      <div class="smi-counter"><b>${p.newCount}</b>מק"טים חדשים</div>
      <div class="smi-counter"><b>${p.changedCount}</b>שונו</div>
      <div class="smi-counter"><b>${p.unchangedCount}</b>ללא שינוי</div>
    </div>`;

  html += `<div class="smi-section"><h3 style="margin-bottom:10px">מק"טים חדשים (${p.newSkus.length}) -- לאישור</h3>`;
  if (!p.newSkus.length) {
    html += '<p style="color:#888">אין מק"טים חדשים.</p>';
  } else {
    html += `<table class="smi-table"><thead><tr>
      <th></th><th>מק"ט</th><th>תיאור</th><th>קטגוריה</th><th>סוג פריט</th><th>מקור</th><th>ספק</th><th>איש רכש</th><th>כשרות</th><th>פעיל בפריוריטי</th>
    </tr></thead><tbody>`;
    for (const s of p.newSkus) {
      html += `<tr>
        <td><input type="checkbox" onclick="smiToggleNew('${jsAttr(s.code)}')"/></td>
        <td>${jsAttr(s.code)}</td><td>${jsAttr(s.name)}</td><td>${jsAttr(smiFmtVal(s.categoryName))}</td>
        <td>${jsAttr(s.itemType)}</td><td>${jsAttr(smiFmtVal(s.source))}</td><td>${jsAttr(smiFmtVal(s.supplier))}</td>
        <td>${jsAttr(smiFmtVal(s.buyer))}</td><td>${jsAttr(smiFmtVal(s.kashrutBodyRef))}</td><td>${jsAttr(smiFmtVal(s.priorityActive))}</td>
      </tr>`;
    }
    html += '</tbody></table>';
  }
  html += '</div>';

  html += `<div class="smi-section"><h3 style="margin-bottom:10px">שינויים (${p.changed.length}) -- כל שדה בנפרד, שום דבר לא נכתב בלי לתייק</h3>`;
  if (!p.changed.length) {
    html += '<p style="color:#888">אין שינויים.</p>';
  } else {
    html += `<table class="smi-table"><thead><tr><th></th><th>מק"ט</th><th>תיאור</th><th>שדה</th><th>ישן</th><th>חדש</th></tr></thead><tbody>`;
    for (const row of p.changed) {
      for (const c of row.changes) {
        const key = row.code + '::' + c.field;
        html += `<tr>
          <td><input type="checkbox" onclick="smiToggleChange('${jsAttr(key)}')"/></td>
          <td>${jsAttr(row.code)}</td><td>${jsAttr(row.name)}</td><td>${jsAttr(c.label)}</td>
          <td class="smi-diff-old">${jsAttr(smiFmtVal(c.oldValue))}</td>
          <td class="smi-diff-new">${jsAttr(smiFmtVal(c.newValue))}</td>
        </tr>`;
      }
    }
    html += '</tbody></table>';
  }
  html += '</div>';

  html += `<div class="smi-apply-bar">
    ${isReadOnlyMode() ? '' : `<button class="btn btn-accent" onclick="smiApplyStub()">✔ ייבא את הנבחרים</button>`}
    <span class="smi-hint">שום דבר לא ייכתב למסד הנתונים לפני אישור מפורש</span>
  </div>`;

  el.innerHTML = html;
}

function smiToggleNew(code) { if (SMI_SELECTED_NEW.has(code)) SMI_SELECTED_NEW.delete(code); else SMI_SELECTED_NEW.add(code); }
function smiToggleChange(key) { if (SMI_SELECTED_CHANGES.has(key)) SMI_SELECTED_CHANGES.delete(key); else SMI_SELECTED_CHANGES.add(key); }

function smiApplyStub() {
  // The apply/write endpoint is intentionally not built yet -- preview only,
  // per explicit instruction. This just reports the current selection.
  showToast(`נבחרו ${SMI_SELECTED_NEW.size} מק"טים חדשים ו-${SMI_SELECTED_CHANGES.size} שינויים -- הייבוא בפועל טרם מופעל, מחכה לאישורך`);
}
