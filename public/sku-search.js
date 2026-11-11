/* Shared SKU search widget ("SKU search everywhere") -- used by both the
 * link-suggestions "קשר למק"ט אחר" box and the dashboard document-preview
 * panel. One implementation, bound by instance id so several copies can
 * exist on the page at once. Calls GET /api/skus/search (rich multi-field,
 * multi-word AND match, quote/gershayim + collapseMatres normalization,
 * NOT_PRODUCT hidden unless the checkbox is ticked).
 */

function skuSearchWidgetHtml(instanceId) {
  return `
    <input id="sks_input_${instanceId}" placeholder='חפש לפי מק"ט / שם / ספק / יצרן / קטגוריה...' style="width:100%;padding:6px"/>
    <label style="display:block;margin-top:4px;font-size:12px;color:#666">
      <input type="checkbox" id="sks_notproduct_${instanceId}"/> הצג גם לא מוצר
    </label>
    <div id="sks_results_${instanceId}" style="max-height:220px;overflow-y:auto;margin-top:6px"></div>`;
}

// onPick(sku) receives {skuId, code, name, kashrutBodyRef, categoryName, itemType}
function skuSearchBind(instanceId, onPick) {
  const input = document.getElementById('sks_input_' + instanceId);
  const cb = document.getElementById('sks_notproduct_' + instanceId);
  const results = document.getElementById('sks_results_' + instanceId);
  if (!input) return;
  let debounceTimer = null;
  async function run() {
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ''; return; }
    try {
      const params = new URLSearchParams({ q });
      if (cb && cb.checked) params.set('includeNotProduct', '1');
      const res = await fetch(API + '/api/skus/search?' + params.toString(), { headers: authHeaders() });
      const matches = await res.json();
      results.innerHTML = matches.map(s => `
        <div style="padding:5px 4px;cursor:pointer;border-bottom:1px solid #f0f0f0" onclick='sks_pick_${instanceId}(${s.skuId})'>
          <b>${jsAttr(s.code)}</b> ${jsAttr(s.name)}${s.itemType === 'NOT_PRODUCT' ? ' <span style="color:#c0612f;font-size:11px">(לא מוצר)</span>' : ''}
          <div style="font-size:11px;color:#888">${jsAttr(s.categoryName || '')}${s.categoryName && s.kashrutBodyRef ? ' · ' : ''}${jsAttr(s.kashrutBodyRef || '')}</div>
        </div>`).join('') || '<div style="color:#888;padding:4px">אין תוצאות</div>';
      window['sks_matches_' + instanceId] = matches;
      window['sks_pick_' + instanceId] = (skuId) => {
        const m = matches.find(x => x.skuId === skuId);
        if (m) onPick(m);
      };
    } catch (e) { results.innerHTML = `<div style="color:#c0612f">שגיאה: ${jsAttr(e.message)}</div>`; }
  }
  input.addEventListener('input', () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(run, 150); });
  if (cb) cb.addEventListener('change', run);
  input.focus();
}
