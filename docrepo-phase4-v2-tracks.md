# docrepo – Phase 4 revision: two approval tracks (year-round / Passover)

This **replaces Steps 4.2–4.8** of `docrepo-phase4-spec.md`. Step 4.1 (list) stays, with the changes below.
Same rules as before:
- branch `raw-materials-registry`;
- no push, merge or deploy;
- back up the DB first (`prisma/backup-db.js`);
- additive changes only;
- TEST- data must be cleaned up, and no real emails in tests;
- stop after each step and wait for approval.

## How the user actually works (the model to build)
1. A raw material arrives with **its own kashrut**: a hechsher symbol on the label, with or without a certificate.
2. He asks **one or more kashrut bodies** whether they approve it. In one go he often asks several bodies, e.g. חתם סופר + בית יוסף + מחפוד.
3. Each question covers **year-round, Passover, or both**. It is common that year-round is already approved and he now asks only about Passover.
4. Each body answers per track:
   - approved;
   - not approved;
   - approved with a condition (year-round only);
   - **approved for kitniyot eaters only (Passover only)**;
   - **a request for more details**. He then sends the additional info and waits again.
5. He must track, per raw material × body, the **year-round** status and, **separately**, the **Passover** status, and export it all to Excel.

## R1 – Schema (additive, then data)
- **`RawMaterial`** – add the origin kashrut:
  - `originKashrutText String?`: the hechsher as printed on the label, free text;
  - `originKashrutBodyId Int?` → KashrutBody, optional, when it matches a known body;
  - `originCertDocId Int?` → Document, the certificate if one exists;
  - `originCertValidUntil DateTime?`;
  - `originHasCert Boolean @default(false)`.
- **`RawMaterialApproval`** – add `track ApprovalTrack @default(YEAR_ROUND)` (enum `YEAR_ROUND | PASSOVER`).
  - Change the unique key from `(rawMaterialId, kashrutBodyId)` to `(rawMaterialId, kashrutBodyId, track)`.
  - Dropping the old unique index loses no data, but **if Prisma warns about anything, stop and show me** before accepting.
  - All existing approval rows become `YEAR_ROUND` (the default).
- **`RawMaterialApprovalStatus`** – add `NEEDS_INFO` and `APPROVED_KITNIYOT`.
  - `APPROVED_KITNIYOT` is valid only when `track = PASSOVER`. Enforce this in the API.
  - `CONDITIONAL` is valid only for `YEAR_ROUND`.
- **Deprecate** the `passoverStatus`, `passoverYear` and `passoverNote` fields added earlier today:
  - stop using them in the API and UI;
  - **do not drop** them.
  - They hold no real data, only test data, which is already cleaned.
- Add `seasonYear String?` to the approval. It is used for PASSOVER rows: the Hebrew year the Passover approval refers to, e.g. תשפ"ז.
- **Manual approvals** (e.g. a body confirmed by phone):
  - add `approvalSource` (enum `PHONE | EMAIL | WHATSAPP | LETTER | PREVIOUS_YEAR | BODY_LIST | OTHER`, nullable) and `approvalSourceDetail String?` (who said it / which email / which year);
  - any status can be set directly, including from NOT_SENT without a prior send, with **no file required**;
  - when there is no file, approvalSource is required;
  - export it in R10 as "מקור אישור";
  - in the UI, show a 📞 / ✍ marker for approvals that have no reply file.
- `KashrutBody.handlesPassover` stays. It decides which bodies get a Passover column by default.

## R2 – API
- **Matrix** `GET /api/raw-material-registry/:id/approvals`:
  - returns **one row per active body for YEAR_ROUND**, plus **one row per handlesPassover body for PASSOVER**;
  - includes NOT_SENT rows, and also any PASSOVER row that exists for a non-handlesPassover body.
- **List endpoint:** returns approvals with `track`, plus the origin kashrut fields.
- **Multi-body send** `POST /api/raw-material-registry/:id/send`:
  - Input: `{ kashrutBodyIds: [..], tracks: ["YEAR_ROUND","PASSOVER"], contactIds: {bodyId: contactId}, docIds, message, via, recordOnly?, followUp? }`.
  - For each body × track: upsert the approval, set status=SENT_PENDING, set sentAt and sentDocIds, and write a SENT event. The payload includes `followUp: true` when answering a NEEDS_INFO.
  - **EMAIL: one email per body.** The email mentions which tracks are asked: "לימות השנה", "לפסח", or "לימות השנה ולפסח".
  - WHATSAPP: recordOnly, as before.
  - Keep the old single-body input working: `kashrutBodyId` + `contactId`.
- **Reply** `POST /api/approvals/:id/reply` – the same as before, plus:
  - an optional `alsoApprovalId`, so **one reply letter can close both tracks of the same body**;
  - each track gets its own status, with the same file and date;
  - status validation per track (see R1).
- **PATCH** `/api/approvals/:id`: same validation; writes an event.

## R3 – List screen (update Step 4.1)
- **Track switch** at the top: **"ימות השנה | פסח"**.
  - **Dots, legend, status filter, counters and the "pending > X days" filter** all follow the selected track.
  - Passover view shows the handlesPassover bodies, plus any body that has a PASSOVER row for some item.
- **Colors:**
  - NOT_SENT gray;
  - SENT_PENDING orange;
  - APPROVED green;
  - REJECTED red;
  - NEEDS_INFO purple;
  - CONDITIONAL blue (year-round);
  - APPROVED_KITNIYOT yellow (Passover).
- **Counters:** add "בקשת פרטים".
- **Origin kashrut:** show it as small text on each row (e.g. "מקור: OK · תעודה עד 06/2027"). Add a filter "ללא תעודת מקור".
- **Legend fixes:**
  - ~12px dark text;
  - the same grid as the dots, so each label sits exactly over its column;
  - sticky at the top when scrolling.
- **Remove** the earlier "פ" badge and the "מאושר לפסח (גוף)" filter. The Passover view replaces them.

## R4 – Raw-material card (was 4.2)
- **Header:** name, supplier, manufacturer, notes. All editable; e.g. remove "- כהן" from migrated names.
- **"כשרות המקור" box:**
  - hechsher text;
  - body picker (optional);
  - "יש תעודה" toggle;
  - upload or pick the certificate document;
  - valid-until.
- **Documents gallery** by role (label, back label, analysis, cert, spec, other), with upload. PDFs open inline.
- **Approvals table with two sections: "ימות השנה" and "פסח".**
  - Columns per row: body, status, contact, sent date, reply date, reply file, condition/note, season year (Passover).
  - Buttons per row:
    - "שלח";
    - "עדכן תשובה";
    - "שלח השלמה" (visible when NEEDS_INFO);
    - "היסטוריה".
- **Linked SKUs:** add or remove.

## R5 – Send modal (was 4.3)
- **Multi-select bodies** (checkboxes, active bodies, Passover bodies first).
- **Track choice:** ימות השנה / פסח / שניהם.
- **Contact per body:** default contact first; can add a new one linked to the body.
- **Documents:** checkboxes over this raw material's documents. The origin certificate and the label are pre-checked.
- **Message:** a Hebrew template that changes with the chosen tracks, editable, signed "אחים כהן".
- **Email or WhatsApp.** Everything sent is recorded per body × track.
- From a NEEDS_INFO row, the same modal opens with that body and track preselected and `followUp=true`.

## R6 – Reply modal (was 4.4)
- **Pick the body, then show both tracks of that body**, each with its own status selector. The tracks shown are the ones that are pending or that the user ticks.
- One file, one reply date, notes, condition text (year-round), and season year (Passover).

## R7 – Add raw material (was 4.5)
- Keep today's flow: photo capture, attachments, SKU picker.
- **"🤖 זהה מהתווית":** suggests name, manufacturer/supplier, **origin hechsher text** and allergens. Every field must be confirmed by the user before saving.

## R8 – SKU tab (was 4.6)
- The SKU's raw materials, with the approval status for the SKU's required body, **both tracks**.
- A summary badge per track.

## R9 – Contacts and bodies settings (was 4.7)
- Contacts screen: manage contacts and assign each one to a body.
- **Bodies settings**, admin only: per body, edit the short name, active, handlesPassover, sort order and default contact.
- Do not delete existing contacts.

## R10 – Excel export (was 4.8)
- Button **"📥 ייצוא לאקסל"** on the list. It exports the **currently filtered** raw materials.
- **Sheet 1 "סטטוס"** (RTL, Hebrew headers, frozen header row and first column):
  - name, supplier, manufacturer, linked SKUs;
  - origin kashrut text, has cert, cert valid-until;
  - then, **for each active body, two columns: "<body> – שנה" and "<body> – פסח"**. Each holds the Hebrew status label. Cells are colored like the dots. The Passover column also shows the season year.
- **Sheet 2 "פירוט":** one row per approval: name, body, track, status, contact, sent date, reply date, condition/note, season year.
- **File name:** `חומרי גלם - YYYY-MM-DD.xlsx`.
- **Library:** use one already in package.json if there is one. Adding a dependency needs my approval first.

## R11 – Excel import of raw materials (lists from purchasing / the factory)
- Button **"📤 ייבוא מאקסל"** on the list screen (not available for the assistant role or in demo mode).
- **Upload** an .xlsx or .csv file. The columns differ from file to file, so show a **column-mapping step**: for each field, a dropdown of the file's columns, auto-guessed from Hebrew/English headers.
  - Fields:
    - name (required);
    - supplier;
    - manufacturer;
    - origin kashrut text;
    - linked SKU code(s), comma separated;
    - notes;
    - the supplier's item code.
  - Add `supplierItemCode String?` to RawMaterial (additive) for that last field.
- **Preview / dry-run table** before saving. Each row is marked:
  - **חדש** (new);
  - **קיים** (likely duplicate): match on supplierItemCode, or on normalized name + supplier;
  - **שגיאה** (error): missing name, or an unknown SKU code.
- The user ticks which rows to import; duplicates are unticked by default.
  - Existing rows are **never overwritten**.
  - An optional "עדכן שדות ריקים בקיימים" fills only empty fields on existing rows.
- **On import:**
  - create the RawMaterial rows, plus the SKU links when the codes are found;
  - save the uploaded file as a Document (role "other") linked to an **import batch**: add `RawMaterialImport { id, fileDocId, byUserId, at, rowsCreated, rowsSkipped }` and `RawMaterial.importId Int?`;
  - show a summary.
- In the list, add a filter **"מייבוא אחרון"** (last import) so the newly imported items can be selected and sent right away (R12).
- Test with a TEST- file and clean up afterwards.

## R12 – Bulk send (many raw materials at once)
- **Row checkboxes** in the list, with a "select all filtered" option, and a button **"📨 שלח מסומנים לאישור"**.
- **Modal:** the same as R5 (bodies multi-select, tracks, contact per body, message). The documents are each item's label and origin certificate, if they exist.
- **One email per body,** listing all selected raw materials in a table:
  - columns: name, manufacturer, origin kashrut;
  - attachments: each item's label and certificate. If there are too many, send a ZIP or several emails, and warn above ~20MB.
- An approval row and a SENT event are recorded for **each raw material × body × track**.
- **Before sending:** show a summary (e.g. "15 חומרי גלם × 3 גופים × פסח = 45 בקשות") and require a confirm click.

## Demo mode (unchanged)
- `?demo=1` (or a demo role) disables every write button, with the message "במצב הצגה – הפעולה מושבתת".

## Order of work
R1+R2 (with backup and the regression test extended for the tracks) → stop.
Then R3 → R4 → R5 → R6 → R10 → R11 → R12 → R7 → R8 → R9. **Stop after each one** with a short summary, so I can check in the browser.
Update `progress.md` at each stop.
