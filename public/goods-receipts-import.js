/* S2 (docrepo-sprint-8.11.md) -- "📦 קליטת דוחות קבלה" upload+preview screen.
 * Self-contained, like sku-master-import.js: index.html only got a nav
 * button, one empty container, and this <script> tag.
 * PREVIEW ONLY -- this screen never writes GoodsReceipt rows or creates
 * SKUs. The real import (apply) endpoint does not exist yet.
 */

let GRI_PREVIEW = null;

function griInjectStyles() {
  if (document.getElementById('griStyles')) return;
  const style = document.createElement('style');
  style.id = 'griStyles';
  style.textContent = `
    .gri-wrap{max-width:1100px;margin:0 auto;padding:20px}
    .gri-upload{background:#fff;padding:20px;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:16px}
    .gri-counters{display:flex;gap:14px;margin-bottom:16px;flex-wrap:wrap}
    .gri-counter{padding:10px 16px;border-radius:8px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.08);font-size:14px}
    .gri-counter b{font-size:20px;display:block}
    .gri-section{background:#fff;border-radius:10px;padding:16px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    .gri-sku-block{border-top:1px solid #eee;padding-top:10px;margin-top:10px}
    .gri-sku-block:first-child{border-top:none;margin-top:0}
    .gri-sku-title{font-weight:700;margin-bottom:6px}
    .gri-sku-new{color:#c0612f}
    .gri-table{width:100%;border-collapse:collapse;font-size:13px}
    .gri-table th,.gri-table td{padding:6px 8px;text-align:right;border-bottom:1px solid #eee}
    .gri-table th{color:#666;font-weight:600;background:#fafafa}
    .gri-flag{color:#c0612f;font-weight:600}
    .gri-apply-bar{display:flex;align-items:center;gap:12px;padding:14px;background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    .gri-hint{color:#888;font-size:12px}
  `;
  document.head.appendChild(style);
}

function griBuildPageShell() {
  const page = document.getElementById('goodsReceiptsImportPage');
  if (page.dataset.built) return;
  page.dataset.built = '1';
  page.innerHTML = `
    <div class="gri-wrap">
      <h2 style="margin-bottom:16px">📦 קליטת דוחות קבלה <button class="btn btn-outline" style="margin-right:12px;padding:4px 10px;font-size:13px" onclick="closeGoodsReceiptsImport()">✕ סגור</button></h2>
      <div class="gri-upload">
        <input type="file" id="griFileInput" accept=".csv,.txt" multiple/>
        <button class="btn btn-accent" onclick="griUploadAndPreview()">העלה ותצוגה מקדימה</button>
        <div class="gri-hint">ניתן לבחור כמה קבצים (CSV מ-Priority/WMS). אין צורך בקידוד מסוים -- UTF-16 ו-UTF-8 נתמכים.</div>
      </div>
      <div id="griResults"></div>
    </div>`;
}

async function openGoodsReceiptsImport() {
  griInjectStyles();
  griBuildPageShell();
  document.querySelector('.hero') && (document.querySelector('.hero').style.display = 'none');
  document.getElementById('statsBar') && (document.getElementById('statsBar').style.display = 'none');
  document.querySelector('main.main') && (document.querySelector('main.main').style.display = 'none');
  document.getElementById('goodsReceiptsImportPage').style.display = 'block';
}

function closeGoodsReceiptsImport() {
  document.getElementById('goodsReceiptsImportPage').style.display = 'none';
  document.querySelector('.hero') && (document.querySelector('.hero').style.display = '');
  document.getElementById('statsBar') && (document.getElementById('statsBar').style.display = '');
  document.querySelector('main.main') && (document.querySelector('main.main').style.display = '');
}

async function griUploadAndPreview() {
  const input = document.getElementById('griFileInput');
  if (!input.files.length) { showToast('בחר קובץ אחד או יותר'); return; }
  const fd = new FormData();
  for (const f of input.files) fd.append('files', f);
  document.getElementById('griResults').innerHTML = '<p style="padding:20px;color:#888">מעבד...</p>';
  try {
    const res = await fetch(API + '/api/goods-receipts/preview', { method: 'POST', headers: authHeaders(), body: fd });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'שגיאה'); }
    GRI_PREVIEW = await res.json();
    griRenderResults();
  } catch (e) {
    document.getElementById('griResults').innerHTML = `<p style="padding:20px;color:#c0612f">שגיאה: ${jsAttr(e.message)}</p>`;
  }
}

function griFmt(v) { return (v === null || v === undefined || v === '') ? '—' : String(v); }

function griRenderResults() {
  const p = GRI_PREVIEW;
  const el = document.getElementById('griResults');
  let html = `
    <div class="gri-counters">
      <div class="gri-counter"><b>${p.filesProcessed}</b>קבצים</div>
      <div class="gri-counter"><b>${p.rowsParsed}</b>שורות שנותחו</div>
      <div class="gri-counter"><b>${p.receiptGroups}</b>קבוצות קבלה (מק"ט+קליטה+תוקף)</div>
      <div class="gri-counter"><b>${p.skuCount}</b>מק"טים</div>
      <div class="gri-counter"><b>${p.newSkuCount}</b>מק"טים חדשים (לא קיימים)</div>
      <div class="gri-counter"><b class="gri-flag">${p.uncoveredCount}</b>ייצורים לא מכוסים (מק"טי יבוא)</div>
    </div>`;

  html += `<div class="gri-section"><h3 style="margin-bottom:10px">תצוגה מקדימה לפי מק"ט</h3>`;
  for (const sku of p.bySku) {
    html += `<div class="gri-sku-block">
      <div class="gri-sku-title">${sku.isNew ? '<span class="gri-sku-new">🆕 </span>' : ''}${jsAttr(sku.skuCode)} -- ${jsAttr(sku.skuName)}${sku.isNew ? ' (מק"ט חדש, לא קיים במערכת)' : ''}</div>
      <table class="gri-table"><thead><tr>
        <th>קליטה</th><th>תאריך קליטה</th><th>תוקף</th><th>כמות</th><th>אצווה</th><th>תאריך יצור</th><th>תאריך יצור משוער</th><th>כיסוי</th><th>קובץ</th>
      </tr></thead><tbody>`;
    for (const r of sku.receipts) {
      let coverageCell = '<span class="gri-hint">לא רלוונטי (לא מק"ט יבוא)</span>';
      if (r.coverageApplicable) {
        coverageCell = r.covered
          ? `<span style="color:#2e9e4a">✔ מכוסה (${jsAttr(griFmt(r.coverageVia))} / ${jsAttr(griFmt(r.coverageMatchedBy))})</span>`
          : '<span class="gri-flag">✘ לא מכוסה</span>';
      }
      html += `<tr>
        <td>${jsAttr(griFmt(r.receiptNo))}</td><td>${jsAttr(griFmt(r.receiptDate))}</td><td>${jsAttr(griFmt(r.expiry))}</td>
        <td>${jsAttr(griFmt(r.quantity))}</td><td>${jsAttr(griFmt(r.batch))}</td><td>${jsAttr(griFmt(r.productionDate))}</td>
        <td>${r.flag ? `<span class="gri-flag" title="${jsAttr(r.flag)}">${jsAttr(griFmt(r.estimatedProductionDate))} ⚠ ${jsAttr(r.flag)}</span>` : jsAttr(griFmt(r.estimatedProductionDate))}</td>
        <td>${coverageCell}</td>
        <td>${jsAttr(r.sourceFile)}</td>
      </tr>`;
    }
    html += '</tbody></table></div>';
  }
  if (!p.bySku.length) html += '<p style="color:#888">אין נתונים.</p>';
  html += '</div>';

  html += `<div class="gri-apply-bar">
    ${isReadOnlyMode() ? '' : `<button class="btn btn-accent" onclick="griConfirmStub()">✔ קלוט דוחות קבלה</button>`}
    <span class="gri-hint">שום דבר לא נכתב למסד הנתונים -- תצוגה מקדימה בלבד, הקליטה בפועל טרם מופעלת</span>
  </div>`;

  el.innerHTML = html;
}

function griConfirmStub() {
  showToast('הקליטה בפועל טרם מופעלת -- תצוגה מקדימה בלבד, מחכה לאישורך');
}
