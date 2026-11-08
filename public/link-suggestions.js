/* L3 -- "🔗 הצעות קישור" review screen (docrepo-link-suggestions-spec.md).
 * Self-contained, like raw-materials.js: index.html only got a nav button,
 * two empty containers (#linkSuggestionsPage / #linkSuggestionsCardPage),
 * and this <script> tag. Reuses index.html's globals: apiFetch(), showToast(),
 * fmtDate(), authHeaders(), API. Never auto-links/archives/marks anything --
 * every action here is a human click.
 */

let LS_QUEUE = [];
let LS_FILTERS = { confidence: 'all', kind: '', body: '', manufacturer: '', dateFrom: '', dateTo: '' };
let LS_CARD_ID = null;
let LS_CARD_DATA = null;
let LS_SELECTED = new Set();
const LS_NO_SKU_REASONS = ['מכתב', 'חשבונית', 'כפילות', 'לא רלוונטי'];

function lsInjectStyles() {
  if (document.getElementById('lsStyles')) return;
  const style = document.createElement('style');
  style.id = 'lsStyles';
  style.textContent = `
    .ls-wrap{max-width:1200px;margin:0 auto;padding:20px}
    .ls-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:16px;background:#fff;padding:14px;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    .ls-toolbar select,.ls-toolbar input{padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:14px}
    .ls-counters{display:flex;gap:14px;margin-bottom:16px;flex-wrap:wrap}
    .ls-counter{padding:10px 16px;border-radius:8px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.08);font-size:14px;cursor:pointer}
    .ls-counter b{font-size:20px;display:block}
    .ls-counter.certain{border-right:4px solid #2e9e4a}
    .ls-counter.likely{border-right:4px solid #d9a429}
    .ls-counter.possible{border-right:4px solid #c0612f}
    .ls-counter.none{border-right:4px solid #999}
    .ls-row{display:flex;align-items:center;gap:12px;background:#fff;border-radius:8px;padding:12px 14px;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,.06);cursor:pointer}
    .ls-row:hover{background:#f7f9fc}
    .ls-dot{width:12px;height:12px;border-radius:50%;flex:0 0 auto}
    .ls-dot.CERTAIN{background:#2e9e4a}.ls-dot.LIKELY{background:#d9a429}.ls-dot.POSSIBLE{background:#c0612f}.ls-dot.NONE{background:#bbb}
    .ls-row-title{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ls-row-meta{color:#666;font-size:13px}
    .ls-card-shell{display:grid;grid-template-columns:420px 1fr;gap:18px;height:calc(100vh - 40px)}
    .ls-left{overflow-y:auto;background:#fff;border-radius:10px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    .ls-right{background:#1e1e1e;border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
    .ls-right iframe,.ls-right img{width:100%;height:100%;border:none;object-fit:contain;background:#fff}
    .ls-field{margin-bottom:10px;font-size:14px}
    .ls-field b{display:inline-block;min-width:90px;color:#555}
    .ls-sku-card{border:2px solid #eee;border-radius:8px;padding:10px;margin-bottom:8px;cursor:pointer}
    .ls-sku-card.checked{border-color:#2e9e4a;background:#f3fbf5}
    .ls-sku-card .conf-badge{font-size:11px;padding:2px 8px;border-radius:10px;color:#fff}
    .ls-sku-card .conf-badge.CERTAIN{background:#2e9e4a}.ls-sku-card .conf-badge.LIKELY{background:#d9a429}.ls-sku-card .conf-badge.POSSIBLE{background:#c0612f}
    .ls-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:12px;border-top:1px solid #eee}
    .ls-reason-row{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
    .ls-hint{color:#888;font-size:12px;margin-top:10px}
  `;
  document.head.appendChild(style);
}

function lsShowMain(show) {
  document.querySelector('.hero') && (document.querySelector('.hero').style.display = show ? '' : 'none');
  document.getElementById('statsBar') && (document.getElementById('statsBar').style.display = show ? '' : 'none');
  document.querySelector('main.main') && (document.querySelector('main.main').style.display = show ? '' : 'none');
}

/* ---------- list screen ---------- */

function lsBuildPageShell() {
  const page = document.getElementById('linkSuggestionsPage');
  if (page.dataset.built) return;
  page.dataset.built = '1';
  page.innerHTML = `
    <div class="ls-wrap">
      <h2 style="margin-bottom:16px">🔗 הצעות קישור <button class="btn btn-outline" style="margin-right:12px;padding:4px 10px;font-size:13px" onclick="closeLinkSuggestions()">✕ סגור</button></h2>
      <div class="ls-counters" id="lsCounters"></div>
      <div class="ls-toolbar">
        <select id="lsFilterConfidence" onchange="lsApplyFilters()">
          <option value="all">כל רמות הביטחון</option>
          <option value="CERTAIN">ודאי</option>
          <option value="LIKELY">סביר</option>
          <option value="POSSIBLE">אפשרי</option>
          <option value="NONE">אין הצעה</option>
        </select>
        <select id="lsFilterKind" onchange="lsApplyFilters()"><option value="">כל סוגי המסמך</option></select>
        <select id="lsFilterBody" onchange="lsApplyFilters()"><option value="">כל גופי הכשרות</option></select>
        <input id="lsFilterManufacturer" placeholder="יצרן..." oninput="lsApplyFilters()"/>
        <input id="lsFilterDateFrom" type="date" onchange="lsApplyFilters()" title="הועלה מתאריך"/>
        <input id="lsFilterDateTo" type="date" onchange="lsApplyFilters()" title="הועלה עד תאריך"/>
        <button class="btn btn-accent" style="margin-right:auto" onclick="lsBulkCertainClick()">✔ אשר את כל הוודאיים</button>
      </div>
      <div id="lsList"></div>
    </div>`;
}

async function openLinkSuggestions() {
  lsInjectStyles();
  lsBuildPageShell();
  lsShowMain(false);
  document.getElementById('linkSuggestionsCardPage').style.display = 'none';
  document.getElementById('linkSuggestionsPage').style.display = 'block';
  if (!window._lsKeyHandlerBound) { document.addEventListener('keydown', lsKeyHandler); window._lsKeyHandlerBound = true; }
  await lsLoadFilterOptions();
  await lsLoadQueue();
}

function closeLinkSuggestions() {
  document.getElementById('linkSuggestionsPage').style.display = 'none';
  document.getElementById('linkSuggestionsCardPage').style.display = 'none';
  lsShowMain(true);
}

async function lsLoadFilterOptions() {
  const opts = await apiFetch('/api/link-suggestions/filter-options');
  const kindSel = document.getElementById('lsFilterKind');
  const bodySel = document.getElementById('lsFilterBody');
  for (const k of opts.kinds) kindSel.insertAdjacentHTML('beforeend', `<option value="${jsAttr(k)}">${k}</option>`);
  for (const b of opts.bodies) bodySel.insertAdjacentHTML('beforeend', `<option value="${jsAttr(b)}">${b}</option>`);
}

function lsApplyFilters() {
  LS_FILTERS = {
    confidence: document.getElementById('lsFilterConfidence').value,
    kind: document.getElementById('lsFilterKind').value,
    body: document.getElementById('lsFilterBody').value,
    manufacturer: document.getElementById('lsFilterManufacturer').value,
    dateFrom: document.getElementById('lsFilterDateFrom').value,
    dateTo: document.getElementById('lsFilterDateTo').value,
  };
  lsLoadQueue();
}

async function lsLoadQueue() {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(LS_FILTERS)) if (v) params.set(k, v);
  const data = await apiFetch('/api/link-suggestions/queue?' + params.toString());
  LS_QUEUE = data.rows;
  const c = data.counts;
  document.getElementById('lsCounters').innerHTML = `
    <div class="ls-counter certain"><b>${c.CERTAIN}</b>ודאי (CERTAIN)</div>
    <div class="ls-counter likely"><b>${c.LIKELY}</b>סביר (LIKELY)</div>
    <div class="ls-counter possible"><b>${c.POSSIBLE}</b>אפשרי (POSSIBLE)</div>
    <div class="ls-counter none"><b>${c.NONE}</b>אין הצעה</div>`;
  lsRenderList();
}

function lsDisplayLabel(r) {
  // 5.11 item 7: show the identified kind+product+manufacturer+body instead
  // of the raw filename ("אישור_ללא-מספר_לא-ידוע (123)" is unreadable);
  // original title stays available as a tooltip (title attribute).
  const product = Array.isArray(r.products) && r.products.length ? r.products[0] : '';
  const parts = [r.docKind, product, r.manufacturer, r.kashrutBody].filter(Boolean);
  return parts.length ? parts.join(' · ') : (r.title || ('מסמך #' + r.documentId));
}

function lsRenderList() {
  const el = document.getElementById('lsList');
  if (!LS_QUEUE.length) { el.innerHTML = '<p style="color:#888;padding:20px">אין מסמכים התואמים את הסינון.</p>'; return; }
  el.innerHTML = LS_QUEUE.map(r => `
    <div class="ls-row" onclick="lsOpenCard(${r.documentId})">
      <span class="ls-dot ${r.bestConfidence}"></span>
      <span class="ls-row-title" title="${jsAttr(r.title || '')}">${jsAttr(lsDisplayLabel(r))}</span>
      <span class="ls-row-meta">${r.candidateCount} הצעות</span>
    </div>`).join('');
}

async function lsBulkCertainClick() {
  const preview = await apiFetch('/api/link-suggestions/bulk-certain-preview');
  if (!preview.documentCount) { showToast('אין מסמכים ודאיים לאישור כעת'); return; }
  const ok = confirm(`${preview.documentCount} מסמכים → ${preview.linkCount} קישורים.\nלאשר ולקשר את כל ההצעות הוודאיות?`);
  if (!ok) return;
  const result = await apiFetch('/api/link-suggestions/bulk-certain', { method: 'POST' });
  showToast(`קושרו ${result.linksCreated} קישורים ב-${result.documentsLinked} מסמכים`);
  await lsLoadQueue();
}

/* ---------- card (detail) screen ---------- */

function lsBuildCardShell() {
  const page = document.getElementById('linkSuggestionsCardPage');
  if (page.dataset.built) return;
  page.dataset.built = '1';
  page.innerHTML = `
    <div style="padding:20px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <button class="btn btn-outline" onclick="lsCloseCard()">→ חזרה לרשימה</button>
        <span id="lsCardPos" style="color:#888;font-size:13px"></span>
        <span style="margin-right:auto"></span>
        <button class="btn btn-outline" onclick="lsPrev()" title="הקודם (←)">←</button>
        <button class="btn btn-outline" onclick="lsNext()" title="הבא (→)">→</button>
      </div>
      <div class="ls-card-shell">
        <div class="ls-left" id="lsLeftPane"></div>
        <div class="ls-right" id="lsRightPane"></div>
      </div>
    </div>`;
}

async function lsOpenCard(documentId) {
  LS_CARD_ID = documentId;
  lsBuildCardShell();
  document.getElementById('linkSuggestionsPage').style.display = 'none';
  document.getElementById('linkSuggestionsCardPage').style.display = 'block';
  await lsLoadCard();
}

function lsCloseCard() {
  document.getElementById('linkSuggestionsCardPage').style.display = 'none';
  document.getElementById('linkSuggestionsPage').style.display = 'block';
  lsLoadQueue();
}

async function lsLoadCard() {
  LS_CARD_DATA = await apiFetch('/api/link-suggestions/' + LS_CARD_ID);
  LS_SELECTED = new Set(LS_CARD_DATA.candidates.filter(c => c.preChecked).map(c => c.skuId));
  const idx = LS_QUEUE.findIndex(r => r.documentId === LS_CARD_ID);
  document.getElementById('lsCardPos').textContent = idx >= 0 ? `${idx + 1} / ${LS_QUEUE.length}` : '';
  lsRenderLeftPane();
  lsRenderPreview();
}

function lsFmtDate(d) { return d ? new Date(d).toISOString().slice(0, 10) : '—'; }

function lsRenderLeftPane() {
  const id = LS_CARD_DATA.identification;
  const products = Array.isArray(id.products) ? id.products.join(', ') : '';
  const lots = Array.isArray(id.lots) ? id.lots.join(', ') : '';
  const left = document.getElementById('lsLeftPane');
  left.innerHTML = `
    <h3 style="margin-bottom:12px">${jsAttr(LS_CARD_DATA.document.title || '')}</h3>
    <div class="ls-field"><b>סוג מסמך:</b> ${jsAttr(id.docKind || '—')}</div>
    <div class="ls-field"><b>מספר תעודה:</b> ${jsAttr(id.certNo || '—')}</div>
    <div class="ls-field"><b>מספר בקשה:</b> ${jsAttr(id.requestNo || '—')}</div>
    <div class="ls-field"><b>מוצר:</b> ${jsAttr(products || '—')}</div>
    <div class="ls-field"><b>יצרן:</b> ${jsAttr(id.manufacturer || '—')}</div>
    <div class="ls-field"><b>גוף כשרות:</b> ${jsAttr(id.kashrutBody || '—')}</div>
    <div class="ls-field"><b>מסלול:</b> ${jsAttr(id.track || '—')}</div>
    <div class="ls-field"><b>תוקף:</b> ${lsFmtDate(id.validUntil)}</div>
    <div class="ls-field"><b>תאריך יצור:</b> ${lsFmtDate(id.productionDate)}</div>
    ${lots ? `<div class="ls-field"><b>LOT:</b> ${jsAttr(lots)}</div>` : ''}
    <h4 style="margin:16px 0 8px">מק"טים מועמדים</h4>
    <div id="lsSkuCards"></div>
    <button class="btn btn-outline" style="width:100%;margin-top:8px" onclick="lsOpenOtherSkuSearch()">🔍 חפש מק"ט אחר</button>
    <div class="ls-actions">
      <button class="btn btn-accent" onclick="lsSubmitLink()" title="Enter">✔ קשר</button>
      <button class="btn btn-outline" onclick="lsSkip()" title="S">⏭ דלג</button>
      <button class="btn btn-outline" onclick="lsOpenNoSkuPanel()" title="N">🚫 לא דורש מק"ט</button>
      <button class="btn btn-outline" onclick="lsOpenDuplicatePanel()">כפילות של…</button>
    </div>
    <div id="lsExtraPanel"></div>
    <div class="ls-hint">מקשים: Enter=קשר, S=דלג, N=לא דורש מק"ט, ←/→=הקודם/הבא</div>`;
  lsRenderSkuCards();
}

function lsRenderSkuCards() {
  const el = document.getElementById('lsSkuCards');
  if (!LS_CARD_DATA.candidates.length) { el.innerHTML = '<p style="color:#888">אין הצעות אוטומטיות למסמך זה.</p>'; return; }
  el.innerHTML = LS_CARD_DATA.candidates.map(c => `
    <div class="ls-sku-card ${LS_SELECTED.has(c.skuId) ? 'checked' : ''}" onclick="lsToggleCandidate(${c.skuId})">
      <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">
        <input type="checkbox" ${LS_SELECTED.has(c.skuId) ? 'checked' : ''} onclick="event.stopPropagation();lsToggleCandidate(${c.skuId})"/>
        <div style="flex:1">
          <div><b>${jsAttr(c.code)}</b> — ${jsAttr(c.name)} <span class="conf-badge ${c.confidence}">${c.confidence}</span></div>
          <div style="font-size:12px;color:#666">${jsAttr(c.supplier)} · ${jsAttr(c.kashrutBodyRef)}${c.pesachStatusRef ? ' · פסח: ' + jsAttr(c.pesachStatusRef) : ''}</div>
        </div>
      </label>
    </div>`).join('');
}

function lsToggleCandidate(skuId) {
  if (LS_SELECTED.has(skuId)) LS_SELECTED.delete(skuId); else LS_SELECTED.add(skuId);
  lsRenderSkuCards();
}

function lsRenderPreview() {
  const right = document.getElementById('lsRightPane');
  const id = LS_CARD_DATA.document.id;
  const ext = (LS_CARD_DATA.document.docExt || '').toLowerCase();
  apiFetch; // (apiFetch forces JSON headers; use raw fetch with authHeaders() for the binary file, same technique index.html's openViewer uses)
  fetch(API + '/api/docs/' + id + '/download?inline=1', { headers: authHeaders() })
    .then(r => r.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      if (ext === 'pdf') right.innerHTML = `<iframe src="${url}#toolbar=1&navpanes=0"></iframe>`;
      else if (['png', 'jpg', 'jpeg', 'gif'].includes(ext)) right.innerHTML = `<img src="${url}"/>`;
      else right.innerHTML = `<div style="color:#fff;padding:20px">תצוגה מקדימה לא נתמכת לסוג קובץ זה (.${ext}). <a href="${url}" target="_blank" style="color:#9cf">הורדה</a></div>`;
    })
    .catch(() => { right.innerHTML = '<div style="color:#fff;padding:20px">שגיאה בטעינת המסמך</div>'; });
}

/* ---------- actions ---------- */

async function lsSubmitLink() {
  if (!LS_SELECTED.size) { showToast('לא נבחרו מק"טים'); return; }
  const result = await apiFetch('/api/link-suggestions/' + LS_CARD_ID + '/link', { method: 'POST', body: JSON.stringify({ skuIds: [...LS_SELECTED] }) });
  showToast(`קושרו ${result.linksCreated} מק"טים`);
  lsNext();
}

function lsSkip() { lsNext(); }

function lsOpenNoSkuPanel() {
  const panel = document.getElementById('lsExtraPanel');
  panel.innerHTML = `
    <div style="margin-top:10px;padding:10px;background:#f7f7f7;border-radius:8px">
      <div style="margin-bottom:6px">בחר סיבה:</div>
      <div class="ls-reason-row">
        ${LS_NO_SKU_REASONS.map(r => `<button class="btn btn-outline" onclick="lsSubmitNoSku('${r}')">${r}</button>`).join('')}
        <button class="btn btn-outline" onclick="document.getElementById('lsExtraPanel').innerHTML=''">ביטול</button>
      </div>
    </div>`;
}

async function lsSubmitNoSku(reason) {
  await apiFetch('/api/link-suggestions/' + LS_CARD_ID + '/no-sku-needed', { method: 'POST', body: JSON.stringify({ reason }) });
  showToast('סומן כ"לא דורש מק"ט"');
  lsNext();
}

function lsOpenDuplicatePanel() {
  const panel = document.getElementById('lsExtraPanel');
  panel.innerHTML = `
    <div style="margin-top:10px;padding:10px;background:#f7f7f7;border-radius:8px">
      <div style="margin-bottom:6px">מזהה המסמך המקורי (שישאר):</div>
      <input id="lsDupInput" type="number" style="width:120px;padding:4px"/>
      <button class="btn btn-outline" onclick="lsCheckDupTarget()">בדוק</button>
      <div id="lsDupResult" style="margin-top:6px;font-size:13px"></div>
    </div>`;
}

async function lsCheckDupTarget() {
  const id = document.getElementById('lsDupInput').value;
  if (!id) return;
  try {
    const doc = await apiFetch('/api/link-suggestions/doc-lookup/' + id);
    document.getElementById('lsDupResult').innerHTML = `
      <div>${jsAttr(doc.title || '')} (#${doc.id})</div>
      <button class="btn btn-accent" style="margin-top:4px" onclick="lsSubmitDuplicate(${doc.id})">✔ אשר -- מסמך זה הוא כפילות של #${doc.id}</button>`;
  } catch (e) {
    document.getElementById('lsDupResult').textContent = 'מסמך לא נמצא';
  }
}

async function lsSubmitDuplicate(duplicateOfId) {
  await apiFetch('/api/link-suggestions/' + LS_CARD_ID + '/mark-duplicate', { method: 'POST', body: JSON.stringify({ duplicateOfId }) });
  showToast('סומן ככפילות');
  lsNext();
}

function lsOpenOtherSkuSearch() {
  const panel = document.getElementById('lsExtraPanel');
  panel.innerHTML = `
    <div style="margin-top:10px;padding:10px;background:#f7f7f7;border-radius:8px">
      <input id="lsSkuSearchInput" placeholder="חפש לפי מק\\"ט / שם / יצרן..." style="width:100%;padding:6px" oninput="lsRunSkuSearch()"/>
      <div id="lsSkuSearchResults" style="max-height:220px;overflow-y:auto;margin-top:6px"></div>
    </div>`;
  document.getElementById('lsSkuSearchInput').focus();
}

let LS_ALL_SKUS = null;
async function lsRunSkuSearch() {
  if (!LS_ALL_SKUS) LS_ALL_SKUS = await apiFetch('/api/skus?all=1');
  const q = document.getElementById('lsSkuSearchInput').value.trim().toLowerCase();
  const results = document.getElementById('lsSkuSearchResults');
  if (!q) { results.innerHTML = ''; return; }
  const matches = LS_ALL_SKUS.filter(s => (s.id + ' ' + s.name + ' ' + s.supplier).toLowerCase().includes(q)).slice(0, 25);
  results.innerHTML = matches.map(s => `<div style="padding:4px 0;cursor:pointer" onclick="lsAddManualSku('${jsAttr(s.id)}')"><b>${jsAttr(s.id)}</b> ${jsAttr(s.name)} <span style="color:#888">${jsAttr(s.supplier)}</span></div>`).join('') || '<div style="color:#888">אין תוצאות</div>';
}

async function lsAddManualSku(code) {
  // sku.id in the frontend shape is actually the SKU CODE (string); resolve to the real numeric id via the lookup endpoint data already in memory.
  const match = LS_ALL_SKUS.find(s => s.id === code);
  if (!match) return;
  const resolved = await apiFetch('/api/link-suggestions/resolve-sku/' + encodeURIComponent(code)).catch(() => null);
  if (!resolved) { showToast('לא ניתן להוסיף מק"ט זה'); return; }
  LS_CARD_DATA.candidates.push({ skuId: resolved.skuId, code: match.id, name: match.name, supplier: match.supplier, kashrutBodyRef: match.kashrus, pesachStatusRef: match.pesach, confidence: 'POSSIBLE', reasons: { manual: true }, preChecked: false });
  LS_SELECTED.add(resolved.skuId);
  document.getElementById('lsExtraPanel').innerHTML = '';
  lsRenderSkuCards();
}

/* ---------- navigation + keyboard ---------- */

function lsNext() {
  const idx = LS_QUEUE.findIndex(r => r.documentId === LS_CARD_ID);
  if (idx >= 0 && idx + 1 < LS_QUEUE.length) lsOpenCard(LS_QUEUE[idx + 1].documentId);
  else { showToast('הסתיימה התור'); lsCloseCard(); }
}
function lsPrev() {
  const idx = LS_QUEUE.findIndex(r => r.documentId === LS_CARD_ID);
  if (idx > 0) lsOpenCard(LS_QUEUE[idx - 1].documentId);
}

function lsKeyHandler(e) {
  const cardVisible = document.getElementById('linkSuggestionsCardPage').style.display !== 'none';
  if (!cardVisible) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.key === 'Enter') { e.preventDefault(); lsSubmitLink(); }
  else if (e.key === 's' || e.key === 'S') { lsSkip(); }
  else if (e.key === 'n' || e.key === 'N') { lsOpenNoSkuPanel(); }
  else if (e.key === 'ArrowRight') { lsNext(); }
  else if (e.key === 'ArrowLeft') { lsPrev(); }
}
