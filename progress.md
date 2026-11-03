# Raw-Material Approval Registry — Progress

Status as of 2026-11-03. Spec: `docrepo-raw-materials-spec.md`. **Nothing in this
work has been committed to git or deployed to Render** — all changes are
local working-tree edits only, and all testing ran against the local
`node server.js` process (hitting the live Neon DB directly, since no
separate dev database exists).

## Phase 1 — Schema (done)

- Full pre-migration backup taken: `backups/2026-11-01T14-35-46-382Z/`
  (per-table JSON dump of all 11 pre-existing tables + a `prisma db pull`
  snapshot of the live schema for drift-checking). Gitignored.
- `prisma/schema.prisma`: purely additive. Added enums `RawMaterialDocRole`,
  `RawMaterialApprovalStatus`, `RawMaterialEventType`; added models
  `KashrutBody`, `RawMaterial`, `RawMaterialDocument`, `RawMaterialApproval`,
  `RawMaterialApprovalEvent`, `SkuRawMaterial`; extended `Contact` with
  optional `kashrutBodyId`/`role`. Nothing existing was dropped or renamed.
- Applied to the live DB via `prisma db push` (no `--accept-data-loss`
  needed — Prisma reported no data-loss warnings, confirming the change was
  purely additive).
- Seeded 11 `KashrutBody` rows (`prisma/seed-kashrut-bodies.js`).
- Verified: all 11 pre-existing tables' row counts matched the backup
  exactly after the push.

## Phase 2 — Data migration (done)

- `prisma/migrate-raw-materials-dryrun.js`: read-only mapping of the 12
  legacy `SkuLink` (isRawMaterial=true) rows → 7 proposed `RawMaterial`
  groups, with an alias table for `Sku.kashrutBodyRef` → `KashrutBody.name`
  and conflict/no-value flags. Reviewed and approved before any write.
- Decisions applied in the real run (`prisma/migrate-raw-materials-run.js`,
  executed in one transaction):
  - SKU 11267's conflicting APPROVED/PENDING links → one `RawMaterialApproval`
    row, `APPROVED` (from the approved link's kashrutLevel).
  - Alias table: עדה חרדית→בד"ץ העדה החרדית, רבנות→הרבנות הראשית,
    לנדא/הרב לנדא ב"ב→הרב לנדא, חתם סופר→חתם סופר ב"ב, קהילות→בד"ץ קהילות.
  - SKUs with no כשרות value (3199, 8455): `RawMaterial` + documents created,
    **no** `RawMaterialApproval` row (flagged לבדוק, no fallback body).
  - Old `PENDING` (no conflict) → new `NOT_SENT` (the old schema never
    recorded whether anything was actually sent).
- Result: 7 `RawMaterial`, 12 `RawMaterialDocument`, 7 `SkuRawMaterial`,
  5 `RawMaterialApproval` (+ 5 `RawMaterialApprovalEvent` logging the
  migration). Verified existing tables unchanged again after the run.
- Legacy `SkuLink`/`isRawMaterial`/`approvalStatus` rows were **not** touched
  — the old "ניהול אישור חמרי גלם" screen keeps working exactly as before.

## Phase 3 — API (done)

Added to `server.js` (419 new lines), all behind `requireAssistant` (or
`requireAuth`+`requireAdmin` for delete, matching the existing convention):

- **Raw materials CRUD** — new base path `/api/raw-material-registry`
  (*not* `/api/raw-materials`, which Express already routes to the legacy
  SkuLink list — reusing it would have silently shadowed that handler):
  `GET` (list, filters `q`/`supplier`/`kashrutBodyId`/`status`), `POST`
  (create), `GET /:id` (detail), `PATCH /:id`, `DELETE /:id`.
- **Documents**: `POST /api/raw-material-registry/:id/documents` — upload a
  new file (R2) or link an existing `Document` id, with a `docRole`.
- **Approvals matrix**: `GET /api/raw-materials/:id/approvals` — one row per
  *active* `KashrutBody`, synthesizing a `NOT_SENT` placeholder for any body
  that has no `RawMaterialApproval` row yet.
- **Approval update**: `PATCH /api/approvals/:id` — status/level/condition/
  notes/validUntil, writes a `RawMaterialApprovalEvent`.
- **Send**: `POST /api/raw-materials/:id/send` — `EMAIL` sends a real email
  via the existing nodemailer/Gmail setup *unless* `recordOnly:true`;
  `WHATSAPP` **requires** `recordOnly:true` (no server-side WhatsApp API
  exists — the client does the actual send via share/wa.me, then calls this
  to log it). Either way, upserts the `RawMaterialApproval` to
  `SENT_PENDING` and writes a `SENT` event.
- **Reply**: `POST /api/approvals/:id/reply` — uploads the reply file to R2,
  sets `replyDocId`/`status`/`replyAt`, writes a `REPLY` event.
- **SKU view**: `GET /api/skus/:id/raw-materials` — this SKU's raw
  materials, each with the approval for the SKU's required kashrut body
  (resolved via the same alias table as Phase 2) and a summary
  (`ALL_APPROVED`/`MISSING`/`HAS_REJECTED`/`NONE`).
- **Impact view**: `GET /api/raw-materials/:id/skus` — which SKUs use this
  raw material.
- **Export**: `GET /api/export/raw-materials`, gated by `x-api-key` ==
  `EXPORT_API_KEY` env var. **`EXPORT_API_KEY` is not set in `.env`**, so
  this endpoint currently fails closed (401) for everyone — intentional
  until the kosher-dashboard integration needs it; I didn't invent a key.

Two small additions beyond the spec's literal bullet list, done because the
explicitly-requested endpoints were unusable without them:
- `GET /api/kashrut-bodies` — read-only list (Phase 4 pickers need it; no
  create/edit API, bodies stay a fixed seeded set for now).
- `POST /api/raw-material-registry/:id/skus` — the spec defines two
  *read* endpoints for the raw-material↔SKU link but no way to *create* a
  new link after the one-time Phase 2 migration; added so that's possible
  going forward.

**Known gap, intentionally not built now**: `POST`/`PATCH /api/contacts`
still don't accept the new `kashrutBodyId`/`role` fields (schema supports
them since Phase 1, API doesn't expose them yet) — spec assigns the
contacts-management screen to Phase 4 (bullet 6), so left for then.

## Testing

`prisma/test-raw-material-registry-api.js` — exercises every new endpoint
above plus a legacy-route sanity check, against a locally-run
`node server.js`. Runs directly against the live Neon DB (no local DB
exists) but is fully self-cleaning:
- Creates a throwaway `TEST-`-prefixed `RawMaterial`, two test `Document`
  uploads, a throwaway admin `User` (needed because `DELETE
  /api/raw-material-registry/:id` correctly requires a real admin JWT, not
  just the assistant-code header) — all deleted at the end, including their
  R2 objects.
- Snapshots row counts (`document`, `rawMaterial`, `rawMaterialDocument`,
  `rawMaterialApproval`, `rawMaterialApprovalEvent`, `skuRawMaterial`,
  `user`) before and after and asserts they match.
- All `/send` calls use `recordOnly:true` — never sends a real email.

**Latest run: 24/24 passed**, including the final count-equality check.
Independently re-verified after the run (outside the script): `User` table
has exactly 1 row (`admin`), zero `TEST-`-prefixed rows remain anywhere.

One real bug this testing caught and fixed: the first test run left a
`RawMaterial` + 2 `RawMaterialDocument` + 2 `RawMaterialApproval` + 4
`RawMaterialApprovalEvent` + 1 `Document` + 1 R2 object behind, because the
test was only authenticating as "assistant" and the delete endpoint
(correctly) requires admin. Fixed by having the test create and use a
throwaway admin user. All of that leftover test data has since been
deleted (DB rows + the R2 object), confirmed row-by-row.

## Current live DB counts (2026-11-03)

| table | count |
|---|---|
| user | 1 |
| customer | 0 |
| category | 12 |
| sku | 2218 |
| rabbinateCert | 55 |
| badatzDoc | 11 |
| document | 1047 |
| skuLink | 411 |
| certRequest | 0 |
| syncState | 3 |
| contact | 3 |
| kashrutBody | 11 |
| rawMaterial | 7 |
| rawMaterialDocument | 12 |
| rawMaterialApproval | 5 |
| rawMaterialApprovalEvent | 5 |
| skuRawMaterial | 7 |

`document` grew from 1044 (Phase 1 backup) to 1047 organically — confirmed
these are 3 real production documents (Drive/rabbanut imports dated
2026-11-01 to 2026-11-03), not test leftovers; zero `TEST-`-titled documents
remain. The app is live on Render and receiving real uploads concurrently
with this work.

## Files changed (all uncommitted)

Modified (tracked):
- `.gitignore` — added `backups/`
- `prisma/schema.prisma` — Phase 1 additive models/enums
- `server.js` — Phase 3 routes (+419 lines)

New (untracked):
- `docrepo-raw-materials-spec.md` — the spec itself
- `prisma/backup-db.js` — reusable full-table JSON backup script
- `prisma/seed-kashrut-bodies.js` — idempotent KashrutBody seeder
- `prisma/migrate-raw-materials-dryrun.js` — Phase 2 dry-run report
- `prisma/migrate-raw-materials-run.js` — Phase 2 real migration (already run once)
- `prisma/test-raw-material-registry-api.js` — Phase 3 self-cleaning API test
- `progress.md` — this file
- `backups/2026-11-01T14-35-46-382Z/` — Phase 1 backup (gitignored)

## Next: Phase 4 — Screens (not started)

Per spec, Hebrew/RTL, mobile-friendly PWA:
1. **"מאגר חומרי גלם"** — searchable list, status-dot strip per kashrut
   body (gray/orange/green/red/blue), "ממתין לתשובה מעל X ימים" filter.
2. **Raw-material card** — photos/docs by role, approvals table (status,
   contact, sent/reply dates, reply file, condition, notes + שלח/עדכן
   תשובה/היסטוריה buttons), linked SKUs.
3. **"הוסף חומר גלם"** — keep today's capture/attach/SKU-picker flow, add
   the "🤖 זהה מהתווית" button wired to `/api/identify` with a raw-material
   prompt (name/manufacturer/kashrut symbol/allergens, user confirms each
   field).
4. **Send modal** — pick kashrut body → its contacts first (+ add new
   contact linked to that body), pick documents, Hebrew message template
   signed "אחים כהן", email or WhatsApp, always recorded via the Phase 3
   `/send` endpoint.
5. **SKU page** — "חומרי גלם" tab using `GET /api/skus/:id/raw-materials`.
6. **Contacts screen** — manage contacts, assign each to a kashrut body.
   Needs a small Phase-3-ish follow-up first: extend `POST`/`PATCH
   /api/contacts` to accept `kashrutBodyId`/`role` (schema already supports
   it, API doesn't yet).

Phase 5 (explicitly deferred per spec, not for now): automatic reply
detection from Gmail, reminders for requests pending >N days.

## Phase 4 — Screens (in progress, per `docrepo-phase4-spec.md`)

All committed on branch `raw-materials-registry` (not main, not pushed, not
deployed).

### Step 4.1 — registry list screen (done)
- `public/raw-materials.js` (new, self-injects its own `<style>` and markup
  at runtime) + a 4-line `index.html` edit (nav button, empty container
  div, script tag). Entirely client-side against the Phase 3 API.
- Search (name/supplier/manufacturer/SKU), filters (kashrut body, status,
  supplier, "לבדוק", stale-pending-days), summary counters, per-row
  status-dot strip with a column legend above it (`KashrutBody.shortName`).
- Fixed after review: legend header aligned to dot columns via a shared
  CSS-grid template; summary counters got a space + switched to the
  codebase's `"` convention instead of `״`.

### Pre-4.2 change — inactive bodies + Pesach fields (done, additive)
Backed up all 17 tables first (`backups/2026-11-03T10-24-30-121Z/`).
Schema additions via `prisma db push` (no data loss, verified clean):
- `KashrutBody.handlesPassover Boolean @default(false)`,
  `KashrutBody.sortOrder Int @default(100)`.
- `RawMaterialApproval.passoverStatus` (new enum `PassoverStatus`:
  `NOT_ASKED|PASSOVER|PASSOVER_KITNIYOT|NOT_PASSOVER`, default `NOT_ASKED`),
  `.passoverYear String?`, `.passoverNote String?`.

Data (via updated `prisma/seed-kashrut-bodies.js`, idempotent):
- `active=false` for אגודה, OU, הרבנות הראשית (not deleted — existing
  approval rows pointing at them are untouched, just hidden from the
  active-only matrix/legend/dots/filters; reactivatable by flipping the flag).
- `handlesPassover=true` for בית יוסף, חתם סופר ב"ב, הרב מחפוד,
  מחזיקי הדת בעלז.
- `sortOrder`: בית יוסף=1, חתם סופר ב"ב=2, everyone else=100 (tie-broken by
  name) — puts those two first in the legend/dots/pickers.

API (`server.js`): `kashrutBodyOut`/`regApprovalOut`/`regNotSentPlaceholder`
now carry `handlesPassover`/`sortOrder`/`passoverStatus`/`passoverYear`/
`passoverNote`; `GET /api/kashrut-bodies` and the approvals-matrix query
both order by `sortOrder` then `name`. `PATCH /api/approvals/:id` and
`POST /api/approvals/:id/reply` both accept the three passover fields now,
each writing its own `STATUS_CHANGE` event with
`payload:{field:'passover', from, to}` — separate from the existing
general status/reply event, and only when the passover value actually
changes (also fixed a pre-existing quirk where the general PATCH event
fired even when nothing in it changed; now guarded).

Frontend (`raw-materials.js`, Step 4.1 screen only so far): inactive bodies
already disappear automatically (client already filtered `b.active`);
small "פ" badge on the dot for `handlesPassover` bodies, colored by
`passoverStatus` (green/orange/red, no badge for `NOT_ASKED`), folded into
the existing tooltip; new filter "מאושר לפסח (גוף)" (pick one
Pesach-handling body, show only materials that body marked fully
`PASSOVER` for). Step 4.2 card and the future 4.4 reply modal still need to
surface these fields for `handlesPassover` bodies — not built yet.

Also added (small, in the same "necessary gap-filling" category as the two
flagged in Phase 3, done while starting on 4.2 before this interrupted it):
`DELETE /api/raw-material-registry/:id/skus/:skuCode` (spec's "add or
remove" linked SKUs had no remove endpoint yet).

Regression: `prisma/test-raw-material-registry-api.js` extended with
passover-specific checks (matrix placeholder defaults, PATCH, reply) and
fixed to use an active body instead of the now-inactive OU for its WhatsApp
case. **28/28 passing**, self-cleanup independently re-verified (row counts
before/after match across all touched tables).

### Still to do in Step 4.2 (card screen) — not started
Header+edit, documents gallery by role, approvals table (now needs a
Pesach sub-row/columns for `handlesPassover` bodies), linked-SKU add/remove
UI (reusing `openSkuPicker` with one new mode), and a `GET
/api/approvals/:id/events` read endpoint for the "היסטוריה" button (doesn't
exist yet — writes exist, no read).
