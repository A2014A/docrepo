# docrepo – Document requests to kashrut bodies ("בקשת מסמכים מגוף כשרות")

A **separate flow** from raw-material approvals.
- **When:** the user needs a **kosher certificate (תעודת כשרות)** and/or a **production report (דוח ייצור)** from a kashrut body (e.g. בד"ץ קהילות) for imported SKUs.
- **Why:** usually so he can submit a request to the Chief Rabbinate.
- **Example:** 3 truffle products (SKUs 32008, 32009, 32010, SELEKTIA ITALIA) → ask בד"ץ קהילות for an updated certificate + production report.

Same rules as the raw-materials work:
- branch `raw-materials-registry`;
- back up the DB first;
- additive schema only;
- TEST- data cleaned up;
- no real emails in tests;
- no push/merge/deploy;
- stop after each step;
- update `progress.md`.

## Rule: every outgoing email goes to the user first
The system **never emails a kashrut body directly**. Every outgoing email is sent to the user's own address, `a0527613684@gmail.com` (configurable in env as `REVIEW_EMAIL`).
- **Subject:** `[לבדיקה והעברה] → <body> / <contact name> <contact email> – <short subject>`.
- **Body:** starts with a short header block saying who it is intended for and listing the attachments. The ready-to-forward message follows, with all attachments attached.
- **Status:** after the system sends, the status is **"נשלח אליך לבדיקה"** (`SENT_FOR_REVIEW`).
- **Forwarding:** after the user checks the email and forwards it himself, he clicks **"✔ הועבר לגוף"** in the app. That sets `SENT_PENDING` with sentAt = now (editable) and writes a SENT event.
- **WhatsApp** stays as is: open wa.me / share, then ask "נשלח?".
- **Applies to:**
  - doc requests (here), including reminders;
  - raw-material sends (R5, R12) in `docrepo-phase4-v2-tracks.md`.

**Reuse the existing pieces:**
- the email sending (nodemailer);
- contacts with `kashrutBodyId`;
- the KashrutBody list;
- the SKU picker;
- document upload to R2;
- the demo/read-only rules.

## D1 – Schema
- **`DocRequest`:**
  - `id`
  - `kashrutBodyId` → KashrutBody
  - `contactId?` → Contact
  - `requestTypes` (Json array of `CERT | PRODUCTION_REPORT | OTHER`)
  - `forPassover` Boolean, default false
  - `productionInfo` String? (production date / LOT / PO / "ייצור קרוב")
  - `purpose` String? (default "הגשה לרבנות")
  - `message` String
  - `via` (`EMAIL | WHATSAPP`)
  - `sentAt`
  - `status` (`DRAFT | SENT_FOR_REVIEW | SENT_PENDING | PARTIAL | RECEIVED | CANCELLED`, default `DRAFT`)
  - `dueReminderAt?`
  - `notes`
  - `createdById`
  - `createdAt`, `updatedAt`
- **`DocRequestSku`** { id, docRequestId, skuId; unique pair }
- **`DocRequestDocument`** { id, docRequestId, documentId → Document, kind: `CERT | PRODUCTION_REPORT | OTHER`, receivedAt }
- **`DocRequestEvent`** { id, docRequestId, type: `CREATED | SENT | REMINDER | RECEIVED | STATUS_CHANGE | NOTE`, payload Json, byUserId, at }

## D2 – API
- **List:** filters for status, body, SKU and text.
- **Get one:** includes SKUs, documents and events.
- **Create** (as DRAFT) and **update**.
- **Send** `POST /api/doc-requests/:id/send`:
  - EMAIL goes through nodemailer to the contact; WHATSAPP is recordOnly, as in the raw-material flow.
  - Sets SENT_PENDING and sentAt, and writes a SENT event.
- **Receive** `POST /api/doc-requests/:id/receive`:
  - Upload one or more files, each with a kind (cert / production report).
  - The file is stored as a regular Document, **linked to all the request's SKUs**.
  - Fields: expiry date (cert), production date / LOT (report), and the reference number if the cert has one.
  - Status becomes RECEIVED when every requested type has arrived, otherwise PARTIAL.
  - Writes a RECEIVED event.
- **Remind** `POST /api/doc-requests/:id/remind`: sends a follow-up email and writes a REMINDER event.

## D3 – Screens
- **New top-level nav item "📄 בקשות מגוף כשרות"**, beside "חומרי גלם".
- **List:**
  - one row per request: date, body, SKUs (codes + short names), what was requested (תעודה / דוח ייצור / פסח), status badge, days waiting;
  - filters: status, body, "ממתין מעל X ימים" (default 7).
- **"➕ בקשה חדשה"** modal:
  1. Pick SKUs: search, multi-select, or paste a list of codes. When the picked SKUs share one kashrut body, pre-select that body (from the SKU כשרות field).
  2. Pick the body and contact (default contact first; can add a new contact linked to the body).
  3. Tick what is needed: ☐ תעודת כשרות ☐ דוח ייצור ☐ גם לפסח.
  4. Production info (free text).
  5. Message: a Hebrew template built from the above, editable, signed "יהודה קורץ – אחים כהן". The template is below.
  6. Buttons:
     - "שמור טיוטה";
     - "שלח במייל";
     - "שלח בווטסאפ" (opens wa.me, then asks "נשלח?").
- **Also reachable from the SKU manager:** select SKUs → "📄 בקש תעודה / דוח ייצור" opens the same modal with the SKUs pre-filled.
- **Request card:**
  - details, SKUs and timeline (events);
  - "📥 קבלת מסמכים" opens the receive modal (upload + kind + expiry/production date);
  - "🔔 שלח תזכורת", "בטל", "הערה";
  - received documents shown inline. PDFs open in the viewer, not as a download.

## Default Hebrew message template
```
שלום רב,

אבקש לקבל עבור המוצרים הבאים, המיובאים ע"י אחים כהן ד.א. יבוא ושיווק מזון בע"מ:
{רשימה: מק"ט – שם מוצר – יצרן}

{אם תעודה}• תעודת כשרות בתוקף
{אם דוח}• דוח ייצור (שאלון דוח ייצור לרבנות){אם פרטי ייצור} עבור {productionInfo}
{אם פסח}• כולל כשרות לפסח

המסמכים נדרשים לצורך הגשת בקשה לרבנות הראשית.

בברכה,
יהודה קורץ
אחים כהן ד.א. יבוא ושיווק מזון בע"מ
```

## D3b – "All missing for a body" (existing process, must be carried over)
Today the tracking sheet already does this:
- Tab **"לטיפול"** (columns: עדיפות, סוג בעיה, מק"ט, תיאור, איש רכש, גוף כשרות, ספק יבוא, מצב, מה לעשות / מה חסר, קבלה אחרונה, …, סטטוס טיפול, תאריך עדכון, הערות).
  - Problem types: חסר תעודה, חידוש שנתית, ייצורים לא מכוסים, החלפת ספק.
- Status values: לא התחיל, נשאל איש רכש, ממתין למסמכים מהספק, **לשלוח לגוף הכשרות**, נשלח לגוף הכשרות - ממתין, הוגשה בקשה לרבנות, נדחה - לטפל מחדש, אושר ברבנות, טופל - יש תעודה, לא נדרש.
- Every row with status "לשלוח לגוף הכשרות" is listed in tab **"לגוף הכשרות"**, grouped by kashrut body.

In docrepo:
- **Button "📄 כל מה שחסר לגוף…":** pick a body, e.g. בד"ץ קהילות. It shows every open item for that body's SKUs, grouped by problem type, with "מה חסר" and the last receipt. The user ticks the items (all are ticked by default) and creates **one DocRequest** with all of them.
  - **Message:** the template lists the items **grouped by problem type**: "חסרה תעודה", "תעודה שנתית שפגה – נא תעודה מחודשת", "ייצורים שלא כוסו – נא תעודה ודוח ייצור לקבלות: <dates>", "החלפת ספק".
- **Source of the open items:**
  - phase 1: read the tracking sheet tab "לטיפול" (read-only, via the Google Sheets API with a service account, or a CSV export URL; choose the simplest secure option and ask me);
  - later: compute them inside docrepo.
- **Status sync:** when the request moves to SENT_PENDING ("✔ הועבר לגוף"), set those rows' "סטטוס טיפול" to "נשלח לגוף הכשרות - ממתין" in the sheet. Only if write access is set up; otherwise show a reminder to update the sheet.

## D4 – Tie-ins (small)
- **SKU manager:** a column/badge "בקשה פתוחה" when a SKU has a non-RECEIVED request.
- **Excel export** of the requests list: same style as R10, Hebrew, RTL.
- **Later (do not build now):** "הכן בקשה לרבנות" from a RECEIVED request, and automatic reminders.

## Order
D1 + D2 (+ regression tests) → stop. D3 → stop. D4 → stop.
