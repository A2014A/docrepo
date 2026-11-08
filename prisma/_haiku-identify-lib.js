// Shared Haiku field-extraction call (no SKU list -- fields only). Used by
// run-l1-identification.js (main pipeline) and backfill-empty-fields.js
// (5.11 item 4 correction pass), so both call Haiku identically.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';

const FIELD_INSTRUCTIONS = `אתה מסייע לארכיון מסמכי כשרות של חברת יבוא מזון ישראלית.

קרא את המסמך המצורף בקפידה וענה בדיוק בפורמט JSON הבא בלבד, ללא הסברים נוספים:
{
  "docKind": "סוג המסמך -- אחד מ: תעודת רבנות / תעודת בד\\"ץ / בקשה לרבנות / דוח ייצור / תווית / מכתב / חשבונית / אחר",
  "certNo": "מספר תעודה אם מופיע, אחרת null",
  "requestNo": "מספר בקשה אם מופיע, אחרת null",
  "products": ["שמות המוצרים המופיעים במסמך, כפי שכתובים"],
  "manufacturer": "שם היצרן אם מופיע, אחרת null",
  "kashrutBody": "גוף הכשרות המנפיק (למשל בד\\"ץ עדה חרדית, הרבנות הראשית וכו') אם מופיע, אחרת null",
  "track": "ימות השנה / פסח / פסח-קטניות -- רק אם מצוין במסמך, אחרת null",
  "validUntil": "תאריך תוקף בפורמט YYYY-MM-DD, אחרת null",
  "productionDate": "תאריך יצור/הנפקה בפורמט YYYY-MM-DD, אחרת null",
  "lots": ["מספרי אצווה/LOT אם מופיעים"]
}
הנחיות: המר תאריכים מ-DD/MM/YYYY או MM/DD/YYYY לפורמט YYYY-MM-DD. אם שדה אינו גלוי במסמך -- ערכו null. אל תנחש לעולם.
חשוב לתקינות ה-JSON: בתוך מחרוזות (למשל שמות רבנים/גופי כשרות), אם יש קיצור עברי עם גרש או גרשיים (כגון שליט"א, בד"ץ, אב"ד) -- השתמש בתו הגרשיים העברי ״ (Unicode U+05F4) ולא במירכאות ASCII רגילות ("), כדי שהמחרוזת תישאר תקינה כ-JSON.
ענה רק ב-JSON.`;

// Safety net: a stray literal " inside a string value (e.g. Hebrew שליט"א)
// breaks JSON.parse even though the prompt asks the model to use ״ instead.
function repairStrayQuotes(text) {
  let inString = false;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '"') { out += ch; continue; }
    if (!inString) { inString = true; out += '"'; continue; }
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    const next = text[j];
    if (next === ':' || next === ',' || next === '}' || next === ']' || j === text.length) {
      inString = false;
      out += '"';
    } else {
      out += '״';
    }
  }
  return out;
}

async function callHaiku(contentBlock) {
  const body = {
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: 'text', text: FIELD_INSTRUCTIONS, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [contentBlock] }],
  };
  const headers = { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };
  if (contentBlock.type === 'document') headers['anthropic-beta'] = 'pdfs-2024-09-25';
  const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
  const text = (data.content?.find(c => c.type === 'text')?.text || '').replace(/```json|```/g, '').trim();
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    try {
      parsed = JSON.parse(repairStrayQuotes(text));
    } catch (e2) {
      throw new Error(`JSON parse failed (stop_reason=${data.stop_reason}, text length=${text.length}): ${text.slice(0, 1500)}`);
    }
  }
  return { parsed, usage: data.usage || {} };
}

module.exports = { callHaiku, FIELD_INSTRUCTIONS, repairStrayQuotes, ANTHROPIC_API_KEY, MODEL };
