/* Dashboard preview-panel fix: "🗑 פח" admin screen -- lists soft-deleted
 * documents (Document.trashedAt not null) with a "שחזר" action per row.
 * Self-contained, like the other screens: index.html only got a nav
 * button, one empty container, and this <script> tag.
 */

function trashBuildPageShell() {
  const page = document.getElementById('trashPage');
  if (page.dataset.built) return;
  page.dataset.built = '1';
  page.innerHTML = `
    <div style="max-width:900px;margin:0 auto;padding:20px">
      <h2 style="margin-bottom:16px">🗑 פח <button class="btn btn-outline" style="margin-right:12px;padding:4px 10px;font-size:13px" onclick="closeTrashScreen()">✕ סגור</button></h2>
      <div id="trashList"><p style="color:#888">טוען...</p></div>
    </div>`;
}

async function openTrashScreen() {
  trashBuildPageShell();
  document.querySelector('.hero') && (document.querySelector('.hero').style.display = 'none');
  document.getElementById('statsBar') && (document.getElementById('statsBar').style.display = 'none');
  document.querySelector('main.main') && (document.querySelector('main.main').style.display = 'none');
  document.getElementById('trashPage').style.display = 'block';
  await trashLoad();
}

function closeTrashScreen() {
  document.getElementById('trashPage').style.display = 'none';
  document.querySelector('.hero') && (document.querySelector('.hero').style.display = '');
  document.getElementById('statsBar') && (document.getElementById('statsBar').style.display = '');
  document.querySelector('main.main') && (document.querySelector('main.main').style.display = '');
}

async function trashLoad() {
  const el = document.getElementById('trashList');
  try {
    const docs = await apiFetch('/api/docs/trash');
    if (!docs.length) { el.innerHTML = '<p style="color:#888">הפח ריק.</p>'; return; }
    el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#fafafa"><th style="padding:6px 8px;text-align:right">כותרת</th><th style="padding:6px 8px;text-align:right">הועבר לפח ב-</th><th style="padding:6px 8px;text-align:right">פעולה</th></tr></thead>
      <tbody>${docs.map(d => `
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:6px 8px">${jsAttr(d.name || d.title || ('מסמך #' + d.id))}</td>
          <td style="padding:6px 8px">${d.trashedAt ? new Date(d.trashedAt).toISOString().slice(0, 10) : ''}</td>
          <td style="padding:6px 8px">${isReadOnlyMode() ? '' : `<button class="btn btn-outline" onclick="trashRestore(${d.id})">↩ שחזר</button>`}</td>
        </tr>`).join('')}</tbody></table>`;
  } catch (e) {
    el.innerHTML = `<p style="color:#c0612f">שגיאה: ${jsAttr(e.message)}</p>`;
  }
}

async function trashRestore(id) {
  try {
    await apiFetch('/api/docs/' + id + '/restore', { method: 'POST' });
    showToast('המסמך שוחזר');
    await trashLoad();
  } catch (e) { showToast(e.message); }
}
