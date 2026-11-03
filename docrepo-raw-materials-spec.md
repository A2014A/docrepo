# docrepo – Raw-Material Approval Registry (build spec)

Hand this file to Claude Code **in the docrepo project**. Work in phases. After each phase: stop, show what changed, and wait for approval. UI text in Hebrew (RTL).

## Context (from the audit of 1.11.2026)
- Live data: Postgres (Neon) via Prisma. `data/db.json` is an old snapshot — do not use it.
- Today a "raw material" is just a `SkuLink` row with `isRawMaterial=true`, plus `approvalStatus` (PENDING/APPROVED/REJECTED) and a free-text `kashrutLevel`. Each photo creates a separate row.
- Sending email works (nodemailer, Gmail SMTP, from a0527613684@gmail.com). It writes nothing to the DB.
- WhatsApp is client-side only (navigator.share or a wa.me link). There is no server log.
- `Contact` is a free list (name/email/phone) with no kashrut body. `CertRequest` exists in the schema but is unused.
- The AI label-identification endpoint (`/api/identify`) exists but is not wired into the raw-material screen.
- Live data today: 12 raw-material SkuLinks (11 PENDING, 1 APPROVED) across 7 SKUs, with duplicates (SKU 35026 ×2, 21129 ×2).

## Hard rules
1. **Back up first.** Take a `pg_dump` of the Neon DB, or create a Neon branch, before any migration. Report where the backup is.
2. **Additive migrations only.** Do not drop or rename existing tables or columns. `SkuLink`, `isRawMaterial`, `approvalStatus` and `Contact` keep working until the new screens fully replace them.
3. **Data migration must be dry-run first.** Print the planned mapping (old SkuLink → new RawMaterial, duplicates detected) and wait for approval. **Never delete** duplicates. Mark them `duplicateOf` or report them.
4. Test locally against a Neon branch. Deploy to Render only after I approve.
5. Do not touch regular document or certificate flows.

## Phase 1 – Schema (Prisma migration)
Use the model proposed in the audit, with these decisions:

- `RawMaterial` { id, name, supplier, manufacturer?, defaultDocId → Document?, notes, createdAt, updatedAt }
- `RawMaterialDocument` { id, rawMaterialId, documentId → Document, docRole: label | back_label | analysis | cert | spec | other, uploadedAt }
- `KashrutBody` { id, name (unique), shortName?, active, defaultContactId → Contact? }
  - Seed the following bodies. Hebrew names must be exact, they match the SKU "כשרות" column:
    - הרב לנדא
    - בד"ץ העדה החרדית
    - חתם סופר ב"ב
    - בד"ץ קהילות
    - הרב רובין
    - הרב מחפוד
    - בית יוסף
    - מחזיקי הדת בעלז
    - אגודה
    - OU
    - הרבנות הראשית
- `Contact`: **add** an optional `kashrutBodyId` and an optional `role`. Existing contacts keep working.
- `RawMaterialApproval` { id, rawMaterialId, kashrutBodyId, contactId?, status: NOT_SENT | SENT_PENDING | APPROVED | REJECTED | CONDITIONAL, kashrutLevel (free text), sentAt?, sentVia: EMAIL | WHATSAPP?, sentDocIds (json array), replyAt?, replyDocId → Document?, conditionText?, validUntil?, notes, updatedById → User, createdAt, updatedAt; @@unique([rawMaterialId, kashrutBodyId]) }
- `RawMaterialApprovalEvent` (full history log) { id, approvalId, type: SENT | REPLY | STATUS_CHANGE | NOTE, fromStatus?, toStatus?, payload json, byUserId, at }
- `SkuRawMaterial` { id, skuId, rawMaterialId, notes?; @@unique([skuId, rawMaterialId]) }

## Phase 2 – Migrate existing raw-material rows (dry-run → approval → run)
- For each `SkuLink` with `isRawMaterial=true`:
  - group by SKU and document into one `RawMaterial`, with a name proposed from the SKU or the document;
  - attach the photos as `RawMaterialDocument`;
  - create one `SkuRawMaterial` link;
  - turn the old `approvalStatus` into a `RawMaterialApproval`. For the kashrut body, use the body from the SKU's כשרות field. If there is none, use "הרב לנדא" and flag the row.
- Show the duplicates (35026, 21129) and **wait for my decision**.

## Phase 3 – API
- **Raw materials:**
  - CRUD for raw materials;
  - upload or link documents with a role;
  - list with filters: text, supplier, kashrut body, status.
- **Approvals:**
  - `GET /api/raw-materials/:id/approvals` returns the matrix: all active kashrut bodies, including NOT_SENT ones.
  - `PATCH /api/approvals/:id` changes status or level, adds a condition, notes or validUntil, and writes an Event.
- **Send:** `POST /api/raw-materials/:id/send`
  - Input: { kashrutBodyId, contactId, docIds, message, via }.
  - EMAIL: send via the existing nodemailer and **record it**: status=SENT_PENDING, sentAt, sentDocIds, contact, plus a SENT event.
  - WHATSAPP: the client opens share or wa.me as today, then calls `.../send` with `via=WHATSAPP, recordOnly=true` after the user confirms "נשלח".
- **Reply:** `POST /api/approvals/:id/reply`
  - Input: { file, status, replyAt, conditionText?, notes }.
  - Uploads the reply as a Document to R2, sets replyDocId, status and replyAt, and writes a REPLY event.
- **SKU view:** `GET /api/skus/:id/raw-materials`
  - Returns the SKU's raw materials. For each one, the approval for the SKU's required kashrut body (from the SKU כשרות field) and a summary: all approved / missing / rejected.
- **Impact view:** `GET /api/raw-materials/:id/skus` returns the SKUs that use this raw material.
- **Read-only export for the kosher dashboard:** `GET /api/export/raw-materials`
  - Protected by an API key in env (`EXPORT_API_KEY`).
  - Returns: raw materials, approvals matrix, SKU links, file links.

## Phase 4 – Screens (Hebrew, mobile-friendly, PWA as today)
1. **"מאגר חומרי גלם":**
   - Searchable list. Each row shows a small status strip per kashrut body (color dots: gray = not sent, orange = pending, green = approved, red = rejected, blue = conditional).
   - Filter "ממתין לתשובה מעל X ימים".
2. **Raw-material card:**
   - Photos and documents by role.
   - **Approvals table:** one row per kashrut body with status, contact, sent date, reply date, reply file, condition and notes, plus buttons "שלח", "עדכן תשובה" and "היסטוריה".
   - Linked SKUs.
3. **"הוסף חומר גלם":** keep today's flow: photo capture, attach files, SKU picker. **Add** an "🤖 זהה מהתווית" button that calls the existing `/api/identify` with a raw-material prompt. It suggests the product name, manufacturer or supplier, the kashrut symbol or body seen on the label, and allergens if visible. The user confirms every suggested field.
4. **Send modal:**
   - Choose a kashrut body; its contacts come first, with an option to add a new contact linked to that body.
   - Choose documents.
   - Message template in Hebrew, signed "אחים כהן".
   - Email or WhatsApp. Either way, the send is recorded.
5. **SKU page:** a "חומרי גלם" tab with the per-SKU approval summary.
6. **Contacts:** a screen to manage contacts and assign each one to a kashrut body.

## Phase 5 – Later (do not build now)
- Automatic reply detection from Gmail (watch the inbox or a label, match the thread to the sent request).
- Reminders for requests pending more than N days.

## Deliverables per phase
- What changed: files and migration names.
- How to test.
- Screenshots of the new screens (Phase 4).
- Confirmation that existing flows still work.
