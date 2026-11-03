# docrepo – Phase 4: Raw-Material Screens (inside the unified "לוח טיפול")

Read `progress.md` (Phases 1–3) and `docrepo-raw-materials-spec.md` first.
Work on branch `raw-materials-registry`. **Do not push, do not merge to main, and do not deploy.** Commit locally at the end of each step.
UI: Hebrew, RTL, mobile-friendly (the app is a PWA). Reuse the existing look: header, colors and buttons from `public/index.html`.

## Big picture (decided 1.11.2026)
docrepo becomes the **single system**. The kosher dashboard ("לוח טיפול יבוא כשר") will later move into docrepo as its own section.
So build the raw-material screens as **a self-contained section with its own top-level navigation entry "חומרי גלם"**, structured so that more sections can sit beside it later:
- "לוח טיפול" (dashboard)
- "תעודות"
- "בקשות לרבנות"
- "העלאה לפריוריטי"

Keep the code modular. Put the screens in a separate file, e.g. `public/raw-materials.js` plus a CSS block, rather than growing `index.html` further. `index.html` is ~189 KB and has a history of encoding corruption, so make minimal, careful edits to it.

## Step 4.1 – Registry list "מאגר חומרי גלם"
- Searchable list: name, supplier, manufacturer and linked SKUs.
- Per row, a compact **status strip: one dot per active kashrut body**, with a tooltip showing the body name and status:
  - gray = NOT_SENT
  - orange = SENT_PENDING
  - green = APPROVED
  - red = REJECTED
  - blue = CONDITIONAL
- Filters:
  - kashrut body;
  - status;
  - supplier;
  - flag "לבדוק" (the 2 migrated items without approvals);
  - "ממתין לתשובה מעל X ימים" (default 14).
- Summary counters at the top: total, pending, rejected, "לבדוק".
- Read-only role (`assistant`): view only, with no edit buttons.

## Step 4.2 – Raw-material card
- **Header:** name, supplier, manufacturer and notes, with an edit button.
- **Documents gallery** grouped by role: label, back label, analysis, cert, spec, other.
  - Upload with role selection; reuse the existing upload and R2 flow.
  - Image preview, and PDFs open inline (not forced download).
- **Approvals table:** one row per active kashrut body, including NOT_SENT. Columns: status, contact, sent date, reply date, reply file, condition, notes.
  - Buttons per row: **"שלח"**, **"עדכן תשובה"**, **"היסטוריה"** (events log).
- **Linked SKUs:** add or remove, with an SKU picker that reuses the existing one.

## Step 4.3 – Send modal
- Pick a kashrut body. Its contacts are listed first, with an option to add a new contact linked to that body (`/api/contacts` must now accept `kashrutBodyId` and `role`; close the gap noted in progress.md).
- Pick documents: checkboxes over this raw material's documents.
- Message template in Hebrew, editable, signed "אחים כהן".
- Send:
  - **Email:** server sends and records the send.
  - **WhatsApp:** open share or wa.me as today, then ask "האם נשלח?" and record with `recordOnly=true`.

## Step 4.4 – Reply modal
- Upload the reply file.
- Status: approved / rejected / conditional (with condition text) / still pending.
- Reply date, defaulting to today.
- Optional validUntil and notes.
- Writes the reply event.

## Step 4.5 – "Add raw material" flow
- Keep today's flow: photo capture, attach files, SKU picker.
- Add a **"🤖 זהה מהתווית"** button that calls the existing `/api/identify` with a raw-material prompt. It suggests name, manufacturer/supplier, kashrut symbol/body and allergens. Every suggested field must be confirmed by the user before it is saved.

## Step 4.6 – SKU page tab "חומרי גלם"
- For an SKU: its raw materials and, for the SKU's required kashrut body (from the SKU כשרות field via the aliases table), whether each is approved.
- Summary badge: all approved / missing / rejected.

## Step 4.7 – Contacts screen
- Manage contacts and assign each one to a kashrut body.
- Only one real contact exists today: הרב אוריאל צרפתי (משרד הרב לנדא, phone only). Do **not** delete the existing test-like contacts. List them, and the user will decide.

## Demo / read-only mode (needed later for showing the owner)
- Add a global flag (e.g. a `?demo=1` query string, or a "demo" user role).
- When it is on, every write button shows a friendly message and does nothing: "במצב הצגה – הפעולה מושבתת". No data changes are possible.

## Rules
- Keep the legacy "ניהול אישור חומרי גלם" screen working until the new one is approved; then hide its menu entry, but do not delete it.
- Test locally. If you create test data in the live DB, prefix it with `TEST-` and delete it at the end (as in Phase 3).
- Never send a real email in tests.
- **After each step:** stop, show screenshots (local server plus Playwright or a browser), and wait for approval before continuing.
- Update `progress.md` at the end.
