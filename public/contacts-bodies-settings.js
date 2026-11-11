/* R9 (docrepo-phase4-v2-tracks.md) -- contacts + bodies settings screen.
 * Self-contained, like the other S/L/R screens: index.html only got a
 * nav button, one empty container, and this <script> tag.
 * Contacts: manage contacts and assign each one to a body. No delete
 * button anywhere here -- "do not delete existing contacts".
 * Bodies settings: admin only (enforced server-side by PATCH
 * /api/kashrut-bodies/:id; the section is always shown, same convention
 * as the existing "🔑 ניהול קודי גישה" admin screen -- a non-admin simply
 * gets a 403 toast on save).
 */

const CBS_ROLE_OPTIONS = ['איש קשר ראשי', 'מזכירות', 'משגיח', 'אחר'];
let CBS_CONTACTS = [];
let CBS_BODIES = [];

function cbsInjectStyles() {
  if (document.getElementById('cbsStyles')) return;
  const style = document.createElement('style');
  style.id = 'cbsStyles';
  style.textContent = `
    #cbsPage{max-width:1000px;margin:0 auto;padding:20px}
    .cbs-section{background:#fff;border-radius:10px;padding:16px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
    .cbs-table{width:100%;border-collapse:collapse;font-size:13px}
    .cbs-table th,.cbs-table td{padding:6px 8px;text-align:right;border-bottom:1px solid #eee;vertical-align:middle}
    .cbs-table th{color:#666;font-weight:600;background:#fafafa}
    .cbs-table input[type=text],.cbs-table select{width:100%;padding:4px 6px;border:1px solid #ddd;border-radius:6px;font-size:12px}
    .cbs-table input[type=number]{width:60px;padding:4px 6px;border:1px solid #ddd;border-radius:6px;font-size:12px}
    .cbs-add-row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
    .cbs-add-row input,.cbs-add-row select{padding:6px;border:1px solid #ddd;border-radius:6px;font-size:13px}
  `;
  document.head.appendChild(style);
}

function cbsBuildPageShell() {
  const page = document.getElementById('cbsPage');
  if (page.dataset.built) return;
  page.dataset.built = '1';
  page.innerHTML = `
    <h2 style="margin-bottom:16px">👥 אנשי קשר וגופי כשרות <button class="btn btn-outline" style="margin-right:12px;padding:4px 10px;font-size:13px" onclick="closeContactsBodiesSettings()">✕ סגור</button></h2>
    <div class="cbs-section">
      <h3 style="margin-bottom:10px">אנשי קשר</h3>
      <div id="cbsContactsTable"></div>
      <div class="cbs-add-row">
        <input type="text" id="cbsNewName" placeholder="שם"/>
        <input type="text" id="cbsNewEmail" placeholder="מייל"/>
        <input type="text" id="cbsNewPhone" placeholder="טלפון"/>
        <select id="cbsNewBody"></select>
        <select id="cbsNewRole"><option value="">— תפקיד —</option>${CBS_ROLE_OPTIONS.map(r => `<option value="${r}">${r}</option>`).join('')}</select>
        <button class="btn btn-accent" onclick="cbsAddContact()">+ הוסף איש קשר</button>
      </div>
    </div>
    <div class="cbs-section">
      <h3 style="margin-bottom:10px">הגדרות גופי כשרות (מנהל בלבד)</h3>
      <div id="cbsBodiesTable"></div>
    </div>`;
}

async function openContactsBodiesSettings() {
  cbsInjectStyles();
  cbsBuildPageShell();
  document.querySelector('.hero') && (document.querySelector('.hero').style.display = 'none');
  document.getElementById('statsBar') && (document.getElementById('statsBar').style.display = 'none');
  document.querySelector('main.main') && (document.querySelector('main.main').style.display = 'none');
  document.getElementById('cbsPage').style.display = 'block';
  await cbsLoad();
}

function closeContactsBodiesSettings() {
  document.getElementById('cbsPage').style.display = 'none';
  document.querySelector('.hero') && (document.querySelector('.hero').style.display = '');
  document.getElementById('statsBar') && (document.getElementById('statsBar').style.display = '');
  document.querySelector('main.main') && (document.querySelector('main.main').style.display = '');
}

async function cbsLoad() {
  try {
    [CBS_CONTACTS, CBS_BODIES] = await Promise.all([apiFetch('/api/contacts'), apiFetch('/api/kashrut-bodies')]);
    cbsRenderContacts();
    cbsRenderBodies();
  } catch (e) { showToast(e.message); }
}

function cbsBodyOptionsHtml(selectedId) {
  return `<option value="">— ללא —</option>` + CBS_BODIES.map(b => `<option value="${b.id}" ${selectedId === b.id ? 'selected' : ''}>${jsAttr(b.shortName || b.name)}</option>`).join('');
}

function cbsRenderContacts() {
  const el = document.getElementById('cbsContactsTable');
  el.innerHTML = `<table class="cbs-table"><thead><tr>
      <th>שם</th><th>מייל</th><th>טלפון</th><th>גוף כשרות</th><th>תפקיד</th><th></th>
    </tr></thead><tbody>
    ${CBS_CONTACTS.map(c => `
      <tr>
        <td><input type="text" id="cbsName_${c.id}" value="${jsAttr(c.name)}"/></td>
        <td><input type="text" id="cbsEmail_${c.id}" value="${jsAttr(c.email || '')}"/></td>
        <td><input type="text" id="cbsPhone_${c.id}" value="${jsAttr(c.phone || '')}"/></td>
        <td><select id="cbsBody_${c.id}">${cbsBodyOptionsHtml(c.kashrutBodyId)}</select></td>
        <td><select id="cbsRole_${c.id}"><option value="">— תפקיד —</option>${CBS_ROLE_OPTIONS.map(r => `<option value="${r}" ${c.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
        <td><button class="btn btn-outline" style="font-size:12px;padding:3px 10px" onclick="cbsSaveContact(${c.id})">שמור</button></td>
      </tr>`).join('')}
    </tbody></table>`;
  document.getElementById('cbsNewBody').innerHTML = cbsBodyOptionsHtml(null);
}

async function cbsSaveContact(id) {
  try {
    await apiFetch('/api/contacts/' + id, {
      method: 'PATCH',
      body: JSON.stringify({
        name: document.getElementById('cbsName_' + id).value,
        email: document.getElementById('cbsEmail_' + id).value,
        phone: document.getElementById('cbsPhone_' + id).value,
        kashrutBodyId: document.getElementById('cbsBody_' + id).value || null,
        role: document.getElementById('cbsRole_' + id).value,
      }),
    });
    showToast('איש הקשר נשמר');
    await cbsLoad();
  } catch (e) { showToast(e.message); }
}

async function cbsAddContact() {
  const name = document.getElementById('cbsNewName').value.trim();
  if (!name) { showToast('נא להזין שם'); return; }
  try {
    await apiFetch('/api/contacts', {
      method: 'POST',
      body: JSON.stringify({
        name,
        email: document.getElementById('cbsNewEmail').value.trim(),
        phone: document.getElementById('cbsNewPhone').value.trim(),
        kashrutBodyId: document.getElementById('cbsNewBody').value || null,
        role: document.getElementById('cbsNewRole').value,
      }),
    });
    showToast('איש הקשר נוסף');
    document.getElementById('cbsNewName').value = '';
    document.getElementById('cbsNewEmail').value = '';
    document.getElementById('cbsNewPhone').value = '';
    await cbsLoad();
  } catch (e) { showToast(e.message); }
}

function cbsContactOptionsHtml(bodyId, selectedId) {
  const relevant = CBS_CONTACTS.filter(c => c.kashrutBodyId === bodyId);
  return `<option value="">— ללא —</option>` + relevant.map(c => `<option value="${c.id}" ${selectedId === c.id ? 'selected' : ''}>${jsAttr(c.name)}</option>`).join('');
}

function cbsRenderBodies() {
  const el = document.getElementById('cbsBodiesTable');
  el.innerHTML = `<table class="cbs-table"><thead><tr>
      <th>גוף</th><th>שם קצר</th><th>פעיל</th><th>מטפל בפסח</th><th>סדר</th><th>איש קשר ברירת מחדל</th><th></th>
    </tr></thead><tbody>
    ${CBS_BODIES.map(b => `
      <tr>
        <td>${jsAttr(b.name)}</td>
        <td><input type="text" id="cbsBodyShort_${b.id}" value="${jsAttr(b.shortName || '')}"/></td>
        <td><input type="checkbox" id="cbsBodyActive_${b.id}" ${b.active ? 'checked' : ''}/></td>
        <td><input type="checkbox" id="cbsBodyPassover_${b.id}" ${b.handlesPassover ? 'checked' : ''}/></td>
        <td><input type="number" id="cbsBodySort_${b.id}" value="${b.sortOrder}"/></td>
        <td><select id="cbsBodyContact_${b.id}">${cbsContactOptionsHtml(b.id, b.defaultContactId)}</select></td>
        <td><button class="btn btn-outline" style="font-size:12px;padding:3px 10px" onclick="cbsSaveBody(${b.id})">שמור</button></td>
      </tr>`).join('')}
    </tbody></table>`;
}

async function cbsSaveBody(id) {
  try {
    await apiFetch('/api/kashrut-bodies/' + id, {
      method: 'PATCH',
      body: JSON.stringify({
        shortName: document.getElementById('cbsBodyShort_' + id).value,
        active: document.getElementById('cbsBodyActive_' + id).checked,
        handlesPassover: document.getElementById('cbsBodyPassover_' + id).checked,
        sortOrder: document.getElementById('cbsBodySort_' + id).value,
        defaultContactId: document.getElementById('cbsBodyContact_' + id).value || null,
      }),
    });
    showToast('הגוף עודכן');
    await cbsLoad();
  } catch (e) { showToast(e.message); }
}
