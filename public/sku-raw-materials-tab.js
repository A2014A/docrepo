/* R8 (docrepo-phase4-v2-tracks.md) -- "SKU tab" inside the SKU edit
 * modal: the SKU's linked raw materials, with the approval status for
 * the SKU's required kashrut body on BOTH tracks, plus one summary badge
 * per track. Self-contained (own styles, own small label/color maps) --
 * index.html only got one empty container inside the existing modal, one
 * call at the end of the existing openEditSku(), and this <script> tag.
 * Calls GET /api/skus/:code/raw-materials (fixed 11.11.2026 to actually
 * split by track -- it used to pick whichever approval came first).
 */

const SKU_RM_STATUS_LABEL = {
  NOT_SENT: 'לא נשלח', SENT_PENDING: 'ממתין לתשובה', APPROVED: 'מאושר', REJECTED: 'נדחה',
  NEEDS_INFO: 'בקשת פרטים', CONDITIONAL: 'מאושר בתנאים', APPROVED_KITNIYOT: 'מאושר לקטניות',
  SENT_FOR_REVIEW: 'נשלח לבדיקה',
};
const SKU_RM_STATUS_COLOR = {
  NOT_SENT: '#A09D98', SENT_PENDING: '#f59e0b', APPROVED: '#2D5A3D', REJECTED: '#dc2626',
  NEEDS_INFO: '#7c3aed', CONDITIONAL: '#2563eb', APPROVED_KITNIYOT: '#eab308', SENT_FOR_REVIEW: '#fdba74',
};
const SKU_RM_SUMMARY_LABEL = { NONE: 'ללא חומרי גלם', ALL_APPROVED: 'הכל מאושר', HAS_REJECTED: 'יש דחייה', MISSING: 'ממתין' };
const SKU_RM_SUMMARY_COLOR = { NONE: '#A09D98', ALL_APPROVED: '#2D5A3D', HAS_REJECTED: '#dc2626', MISSING: '#f59e0b' };

function skuRmInjectStyles() {
  if (document.getElementById('skuRmTabStyles')) return;
  const style = document.createElement('style');
  style.id = 'skuRmTabStyles';
  style.textContent = `
    .sku-rm-tab{margin-top:16px;border-top:1px solid var(--border2);padding-top:12px}
    .sku-rm-tab h4{font-size:.9rem;margin-bottom:8px}
    .sku-rm-badges{display:flex;gap:8px;margin-bottom:10px}
    .sku-rm-badge{font-size:.76rem;padding:3px 10px;border-radius:99px;color:#fff;white-space:nowrap}
    .sku-rm-row{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:.8rem}
    .sku-rm-row-name{flex:1;min-width:0}
    .sku-rm-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-left:4px}
  `;
  document.head.appendChild(style);
}

async function skuRmTabOpen(skuCode) {
  skuRmInjectStyles();
  const el = document.getElementById('skuEditRawMaterialsTab');
  if (!el) return;
  el.innerHTML = '<div class="sku-rm-tab"><p style="color:var(--ink3);font-size:.8rem">טוען חומרי גלם...</p></div>';
  try {
    const data = await apiFetch('/api/skus/' + encodeURIComponent(skuCode) + '/raw-materials');
    skuRmTabRender(data);
  } catch (e) {
    el.innerHTML = `<div class="sku-rm-tab"><p style="color:#dc2626;font-size:.8rem">שגיאה בטעינת חומרי גלם: ${e.message}</p></div>`;
  }
}

function skuRmBadgeHtml(summary) {
  return `<span class="sku-rm-badge" style="background:${SKU_RM_SUMMARY_COLOR[summary] || '#999'}">${SKU_RM_SUMMARY_LABEL[summary] || summary}</span>`;
}

function skuRmStatusCellHtml(approval) {
  if (!approval) return '<span style="color:var(--ink3)">—</span>';
  return `<span class="sku-rm-dot" style="background:${SKU_RM_STATUS_COLOR[approval.status] || '#999'}" title="${(SKU_RM_STATUS_LABEL[approval.status] || approval.status).replace(/"/g, '')}"></span>${SKU_RM_STATUS_LABEL[approval.status] || approval.status}`;
}

function skuRmTabRender(data) {
  const el = document.getElementById('skuEditRawMaterialsTab');
  const items = data.items.filter(it => !it.archived);
  el.innerHTML = `
    <div class="sku-rm-tab">
      <h4>חומרי גלם${data.requiredKashrutBody ? ` -- גוף נדרש: ${data.requiredKashrutBody}` : ''}</h4>
      <div class="sku-rm-badges">
        <span>ימות השנה: ${skuRmBadgeHtml(data.summaryBadgeYearRound)}</span>
        <span>פסח: ${skuRmBadgeHtml(data.summaryBadgePassover)}</span>
      </div>
      ${items.length ? items.map(it => `
        <div class="sku-rm-row">
          <div class="sku-rm-row-name">${it.name}${it.supplier ? ` <span style="color:var(--ink3)">(${it.supplier})</span>` : ''}</div>
          <div>${skuRmStatusCellHtml(it.requiredApprovalYearRound)}</div>
          <div>${skuRmStatusCellHtml(it.requiredApprovalPassover)}</div>
          <button class="btn btn-outline" style="font-size:.7rem;padding:2px 8px" onclick="skuRmOpenMaterial(${it.rawMaterialId})">פתח</button>
        </div>`).join('') : '<p style="color:var(--ink3);font-size:.8rem">אין חומרי גלם מקושרים למק"ט זה.</p>'}
    </div>`;
}

function skuRmOpenMaterial(rawMaterialId) {
  closeSkuEdit();
  closeSkuManager();
  openRawMaterialsRegistry().then(() => rmOpenCard(rawMaterialId));
}
