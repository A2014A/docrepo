# docrepo – Linking every document to its SKUs ("הצעות קישור")

**Goal:** bring the "מסמכים לא מקושרים למק"ט" count (≈840 now) down to zero. Every document ends up either linked to the right SKU(s) or explicitly marked as not needing a SKU.

Same rules as before:
- branch `raw-materials-registry`;
- back up the DB first;
- additive schema only;
- never delete documents;
- no push/merge/deploy;
- stop after each step.

**Rule: nothing is linked without the user's approval.** The only exception is the explicit "אשר את כל הוודאיים" button.

## L0 – Archive old documents first (decided 3.11)
- **Each document's own date:** valid-until, else issue/production date. Take it from the free PDF text layer, the title, or the cert-number lookup. **Not** the upload date, because most documents were bulk-uploaded on 4.6.2026.
- **Always keep active, regardless of age:**
  - labels and product photos (needed for new Rabbinate requests);
  - the most recent Rabbinate request per manufacturer+product (it is the template for the next request);
  - the most recent certificate per product, even if expired.
- **Archive** (`Document.archived = true`, `archivedReason`): everything else whose own date (valid-until, else issue/production) is **more than 2 years before today**.
  - **Age is the only reason to archive.** A certificate is **never** archived just because a newer certificate exists, because stock from the previous production may still be sold under the old certificate.
  - **Duplicates are different:** identical files (same ETag), or the same certNo/requestNo stored twice, keep one copy and mark the others `duplicateOfId`, whatever their age.
  - **Excluded** from Haiku, from the unlinked count, from the review queue and from Priority upload.
  - **Never deleted** and still searchable, behind an "הצג ארכיון" filter.
  - A free, CERTAIN match (SKU code or cert number) may still link an archived document, for history.
- **Haiku:** only keep-active documents, plus documents with no date found. The prompt has **no SKU list**: the model only extracts fields, and L2 does the SKU matching.

## L1 – Content identification for all unlinked documents (batch)
- **What it runs:** a background job that calls the **existing `/api/identify` logic** (Claude Haiku reads the PDF or image) on every document that has no SKU link. It skips documents that already have a stored identification.
- **New table `DocIdentification`:** { documentId (unique), docKind (תעודת רבנות / בקשה לרבנות / תעודת בד"ץ / דוח ייצור / תווית / מכתב / חשבונית / אחר), certNo, requestNo, products (json list of product names as written), manufacturer, kashrutBody, track (ימות השנה / פסח / פסח-קטניות), validUntil, productionDates/LOTs, rawText (first ~2,000 chars), model, costTokens, createdAt }.
- **Running it:**
  - concurrency 2;
  - pause/resume;
  - a progress counter on an admin page;
  - **dry-run cost estimate first:** count the documents and the expected tokens, then **stop and ask me** before running.
- **Prompt:** must return strict JSON. If a field is not visible in the document, it is null. **Never guess.**

## L2 – Suggestion engine (rules, no AI)
For each identified document, compute candidate SKUs with a confidence level, and store them in `LinkSuggestion` { documentId, skuId, confidence: CERTAIN | LIKELY | POSSIBLE, reasons (json), status: PENDING | APPROVED | REJECTED, decidedById, decidedAt }.

**Signals:**
1. **SKU code** appears in the title or text → +strong.
2. **certNo / requestNo** is already linked to a SKU through another, approved document → +strong.
3. **Product name** similarity to the SKU description: normalized Hebrew, ignore "כהן", sizes handled separately.
4. **Manufacturer** equals the SKU supplier or a known manufacturer alias → +medium.
   - Also add a small table `SupplierAlias` { supplierName, manufacturerName }, e.g. PRIMA FOOD INGREDIENTS → AFFCO, MONARI FEDERZONI → ANTICHE FATTORIE VANDELLI, TIANJIN BLISS → TIANJIN SHINHOO, SEGEV → ECOVINAL. It is editable in the UI.
5. **Kashrut body equals the SKU כשרות body** → required for CERTAIN. **A mismatch caps the suggestion at POSSIBLE.** For example, a Landau cert never auto-matches an עדה חרדית SKU.
6. **Track:** a Passover cert prefers the SKU marked פסח (e.g. 17381), a year-round cert prefers the regular SKU (17183).
7. **Pack size** in the cert or label (e.g. 400 גרם, 2.2 ק"ג, 5 ל') must not contradict the SKU description.

**Confidence levels:**
- **CERTAIN:** (1), or (2) + 5, or 3 + 4 + 5 + 7 all agree.
- **LIKELY:** 3 + 5.
- **POSSIBLE:** anything else.

## L3 – Review screen "🔗 הצעות קישור" (main nav)
- **Queue:** documents ordered CERTAIN → LIKELY → POSSIBLE → no suggestion.
- **Split view:**
  - **right:** the document preview (PDF/image inline, zoom, page switch);
  - **left:** identification (kind, cert no, products, manufacturer, body, track, valid until) and the candidate SKUs as cards (code, description, supplier, body, Passover), each with a checkbox. CERTAIN ones are pre-ticked.
- **Actions:**
  - **"✔ קשר"** (selected SKUs);
  - **"חפש מק"ט אחר"** (search box, multi-select);
  - **"⏭ דלג"**;
  - **"🚫 לא דורש מק"ט"**: sets `Document.noSkuNeeded = true`, with a reason (מכתב / חשבונית / כפילות / לא רלוונטי);
  - **"כפילות של…"**: marks `duplicateOfId`. Never delete.
- **Keyboard:** Enter = קשר, S = דלג, N = לא דורש מק"ט, arrows = next/previous.
- **Bulk:** "אשר את כל הוודאיים", with a summary first ("120 מסמכים → 180 קישורים").
- **Filters:** kind, body, manufacturer, confidence, uploaded-date range.
- **Linking** uses the same SkuLink shape the app already uses (docType DOCUMENT, isRawMaterial=false).

## L4 – Fixing the source data shown during review
- **On a SKU card,** if the body in the SKU list differs from the body on approved certs, show "גוף הכשרות של המק"ט לא תואם לתעודות – לעדכן?". A click updates the SKU כשרות field and writes an event.
  - Example: 33003 is listed as OU, but its certs are בד"ץ קהילות.
- **Unlinked counter:** the "מסמכים לא מקושרים" counter excludes `noSkuNeeded` and duplicates.

## L5 – Stop new unlinked documents
- **Upload form:** the SKU becomes required unless "לא דורש מק"ט" is ticked. The 🤖 identify step pre-fills SKU suggestions using the L2 engine.
- **Automatic imports** (email/Drive sync, e.g. titles like "אישור_ללא-מספר_לא-ידוע", "צרופה 1"):
  - run L1 + L2 on arrival;
  - auto-link only CERTAIN;
  - put the rest in the review queue;
  - **rename the title** from the identification: "<kind> <certNo> <product> <body> עד <valid>".

## L6 – Permanent, repeatable process (decided 4.11)
The one-off L1 script becomes a **server-side job inside docrepo**, so the whole pipeline can be re-run at any time.
- **Admin button "🔄 עבד מסמכים חדשים":** on the "הצעות קישור" screen and on the admin menu. It runs, in order, only on documents that are new or changed since the last run:
  1. L1 (free text layer first, Haiku only for what remains);
  2. L0 rules (archive candidates, duplicates; shown as proposals, never applied silently);
  3. L2 suggestions.
- **While it runs:** progress bar ("מעבד 12 / 40"), and a result summary when done ("40 מסמכים: 12 קושרו אוטומטית (ודאי), 20 ממתינים לאישור, 3 כפילויות מוצעות, 5 ללא זיהוי").
- **Optional schedule:** run automatically once a day at night, on/off in the admin settings, plus on every new upload or email import (the L5 auto flow).
- **Safety:**
  - only one run at a time (lock);
  - resumable; a crash marks the rows FAILED and the next run retries them;
  - every run is logged in `JobRun` { id, startedAt, finishedAt, trigger: BUTTON | SCHEDULE | UPLOAD, docsProcessed, freeCount, haikuCount, autoLinked, pending, failed, costTokensIn, costTokensOut, byUserId };
  - a monthly Haiku token cap from env, e.g. `IDENTIFY_MONTHLY_TOKEN_CAP`; above the cap, documents stay at the free step and are marked PENDING_HAIKU.
- **Dashboard badge on the home screen:** "📄 X מסמכים חדשים לא מעובדים · Y הצעות קישור ממתינות", with a click to the review screen.
- **Same code path:** the job uses the same functions as the one-off script, moved into `lib/identify/`. No duplicated logic.
- **Fixes along the way:**
  - the `/api/identify` button stops sending the SKU list (it currently sends 800 of 2,218 SKUs) and uses the field extraction + L2 instead;
  - the ח.פ-substring regex fix (`\b` boundaries) applies everywhere.

## Order
L1 dry-run estimate → stop (I approve cost) → L1 run → L2 → stop with counts per confidence → L3 → stop → L4 + L5 → stop.
