# docrepo – work plan from 8.11.2026: dashboard, receipts, new SKUs, raw materials, going live

Same rules as before:
- branch `raw-materials-registry`;
- back up the DB before every schema change;
- additive schema only;
- TEST- data, cleaned up at the end;
- no real emails;
- no push/merge/deploy without my explicit approval;
- stop after each step and show screenshots (my browser is fine, skip Playwright installs);
- Hebrew RTL, mobile-friendly.

**Priority upload work is paused.** Do not touch priority-erp-sync.

## S0 – Close the current run
- Finish the L2 batched-write fix and the final L2 run.
- Show the final counts per confidence. Show separately how many CERTAIN come from the tracking sheet (signal 9).
- Commit locally and start the local server.

## S1 – Master SKU list → docrepo (replaces C1 of docrepo-categories-spec.md)
The single master SKU list is now the Google Sheet tab "מקטים ראשי" (spreadsheet 1KQDPHIG0h1XtyifYi4FkDxmTygIP9ptvH7aZBdP0R1Q). It has ~2,333 rows and is updated automatically every morning.

Columns:
- A מק"ט
- B תיאור
- C קטגוריה (פריוריטי)
- D טיפוס
- E מקור (יבוא/רכש מקומי)
- F ספק 1
- G ספק 2
- H יצרן
- I איש רכש
- J כשרות ימות השנה
- K כשרות פסח
- L פעיל בפריוריטי
- M סטטוס תעודה
- N מספרי סימוכין
- O תוקף אחרון
- P הערות
- Q מקור הנתונים
- R סוג פריט ("לא מוצר" = not food)
- S onward may hold "קבלה אחרונה" etc.

What to build:
- **Admin import "📥 ייבוא רשימת מק"טים":** upload a CSV export of that tab (I export it: File → Download → CSV).
- **Match on SKU code.**
  - New SKUs are listed for approval.
  - Changed fields (category, kashrut, Passover, supplier, buyer, import/local, active) are shown as a diff with checkboxes. Nothing is overwritten unless I tick it.
- **New SKU fields (additive):** `categoryName`, `itemType` (FOOD | NOT_PRODUCT | REVIEW), `source` (IMPORT | LOCAL | PRIVATE_LABEL), `buyer`, `priorityActive`.
- **NOT_PRODUCT SKUs** are hidden by default everywhere: lists, counts, missing-cert reports and L2 candidates.
- **Category filter:** a multi-select on the SKU manager, plus the "קטגוריה" column in exports (C2, docrepo-categories-spec.md).
- **Missing from a later export:** a SKU that is missing from a later file is never deleted or deactivated automatically.

## S2 – Goods receipts (קבלות סחורה) import
**Source:** Priority/WMS stock exports, one CSV per SKU or many SKUs per file.
- **Encoding:** usually UTF-16 or UTF-8 with values like `="13459"`. Strip the `="…"` wrapper.
- **Real header (sample from 13459.csv):** קוד מאחסן, מטען, שם מאחסן, תיאור סטטוס, סטטוס פעילות, איתור ליקוט, יחידת מידה, פריט, תיאור פריט, LOADUOMDESC, מיקום, סטטוס, פג תוקף, כמות, יתרת מחסן, זמין, מוקפא, לא מאותר, מוקצה, בתהליך, לוקט, קליטה, שורת קליטה, תאריך קליטה, משקל מטען, יחידת ניטול, סוג משטח, נפח מטען, קבוצת פריט, כמות קרטונים, תאריך יצור, מספר סריאלי, אצווה, מידה, משקל, כשר, בציר, מכולה, מיקום יעד, קומה.

**Table `GoodsReceipt`** (additive): skuId, receiptNo (קליטה), receiptDate (תאריך קליטה), expiry (פג תוקף), quantity (sum of כמות per receipt+expiry), batch (אצווה), productionDate (תאריך יצור if present), estimatedProductionDate, warehouseGroup (קבוצת פריט), sourceFile, importedAt.
- **Unique key:** (skuId, receiptNo, expiry), so re-importing the same file updates the row and never duplicates it.

**Estimated production date** (only when the file has no production date): expiry minus the shelf life.
- The shelf life comes from a small editable table `ShelfLifeRule` { category or skuId, months }.
- **Defaults:** canned (שימורים) = 36 months; vacuum products (name contains "וואקום") = 24 months; else empty, meaning unknown.
- **Per-SKU overrides win:** 13460 = 36, 13459 = 24, 13461 = 24 (confirmed by me on 4.11).
- **Flag** an estimate that falls after the receipt date as "חיי מדף שגויים".

**Upload UI "📦 קליטת דוחות קבלה":**
- multi-file upload;
- a preview grouped by SKU (receipt date, expiry, quantity, estimated production date), then a confirm button.

**New SKUs found in receipts:**
- Create them as SKU rows flagged `isNew` with the description from the file.
- Show them in a "מק"טים חדשים" list for me to complete (category, kashrut, supplier).

**Coverage check (the core purpose):** for each receipt of an IMPORT SKU, find a linked document that covers it.
- **Covered:** a Rabbinate certificate valid on the receipt date, or a body cert / production report whose production date or LOT matches.
- **Not covered:** the receipt goes to "ייצורים לא מכוסים", which feeds the dashboard (S3) and the "כל מה שחסר לגוף…" request flow (D3b).

## S3 – The dashboard ("לוח טיפול") as the docrepo home screen
**One screen of cards.** Each card shows a count and opens a filtered list. Every card supports the category filter and works on a phone.
1. **מק"טי יבוא פעילים בלי תעודה בתוקף:** IMPORT SKUs, FOOD only, active, with no valid Rabbinate certificate.
2. **תעודות שפגות ב-60 יום.**
3. **ייצורים לא מכוסים:** from S2.
4. **בקשות לרבנות ממתינות:** from TrackingSheetMap (requests.csv), status starting with "הוגש". Show the days waiting.
5. **חומרי גלם ממתינים לתשובה / נדחו:** from the raw-materials registry.
6. **הצעות קישור ממתינות:** link suggestions, by confidence.
7. **מק"טים חדשים להשלמה:** from S1 and S2.
8. **מסמכים חדשים לא מעובדים:** the L6 badge.

Each list row offers the next action where one exists: "בקש תעודה מגוף כשרות", "קשר מסמך", "פתח מק"ט".

Keep the existing Google-Sheet dashboard untouched. This replaces it later, once I approve.

## S4 – Raw materials (finish docrepo-phase4-v2-tracks.md)
Order: **R10 → R11 → R12 → R7 → R8 → R9**, as specified there. Emphasis:
- **R11, Excel import:**
  - upload a raw-materials Excel file;
  - column mapping with a preview;
  - sort and filter the rows (supplier, manufacturer, kashrut body, track, status);
  - tick which rows to import / send for approval.
- **R12, bulk send to kashrut bodies:**
  - pick the rows and the body;
  - one email per body containing all the picked rows and their documents;
  - **REVIEW_EMAIL rule:** the email goes to my address first, status SENT_FOR_REVIEW, and I click "✔ הועבר לגוף".
- **R10, reports:** approved, not approved, and by classification (body × track × status). Show on screen and export to Excel (Hebrew, RTL), with filters for body, track, supplier and category.

## S5 – Ready to go live (prepare only — deploy only after my explicit "deploy")
**Checklist to show me:**
- all schema changes already applied to the shared DB;
- the env vars Render needs: ANTHROPIC_API_KEY (I set it myself), REVIEW_EMAIL, IDENTIFY_MONTHLY_TOKEN_CAP;
- regression tests;
- every new screen checked at phone width;
- demo / read-only mode works;
- no default admin/1234 left. I will change the admin password myself in the UI. Add a startup warning if any user still has a default password.

**Then:**
- Prepare a merge into main (a PR description), but do not merge.
- Tell me the exact steps, and wait.

## Order
S0 → S1 → S2 → S3 → S4 → S5. Stop after each step with a short summary and screenshots.
