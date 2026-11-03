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

## Order
L1 dry-run estimate → stop (I approve cost) → L1 run → L2 → stop with counts per confidence → L3 → stop → L4 + L5 → stop.
