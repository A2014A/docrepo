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

**⚠ SUPERSEDED same day by the two-track revision below** — the
`passoverStatus`/`passoverYear`/`passoverNote` single-row approach above
didn't survive contact with how the work actually happens (one body can be
asked about year-round and Passover separately, with independent
statuses). Columns were kept (never dropped, held no real data) but are no
longer read or written anywhere.

## Phase 4 revision — two approval tracks (per `docrepo-phase4-v2-tracks.md`)

This **replaces Steps 4.2–4.8** of `docrepo-phase4-spec.md`. Step 4.1
(list) stays, to be updated in R3. Still on branch `raw-materials-registry`,
not pushed, not deployed.

### R1 — Schema (done, additive; one accepted data-loss warning)
Backed up all 17 tables first (`backups/2026-11-03T11-04-35-930Z/`).
- `RawMaterialApproval.track` (new enum `ApprovalTrack: YEAR_ROUND|PASSOVER`,
  default `YEAR_ROUND` — all 5 pre-existing rows became `YEAR_ROUND`
  automatically) and `.seasonYear String?`.
- Unique key changed `(rawMaterialId, kashrutBodyId)` →
  `(rawMaterialId, kashrutBodyId, track)`. **`prisma db push` warned**
  ("might be data loss... if there are existing duplicate values") —
  stopped and reported it rather than auto-accepting, per instruction.
  Verified empirically first (5 rows, 5 distinct old-key pairs, so the new
  3-column constraint can't fail), explained that reasoning, then the user
  explicitly said to proceed with `--accept-data-loss`. Applied clean, row
  count unchanged (5), all defaulted to `YEAR_ROUND` as expected.
- `RawMaterialApprovalStatus` gained `NEEDS_INFO` and `APPROVED_KITNIYOT`
  (the latter valid only for `track=PASSOVER`; `CONDITIONAL` valid only for
  `YEAR_ROUND` — enforced in the API via `isValidStatusForTrack()`, not a DB
  constraint).
- `RawMaterial` origin-kashrut fields: `originKashrutText`,
  `originKashrutBodyId` → `KashrutBody`, `originCertDocId` → `Document`,
  `originCertValidUntil`, `originHasCert`.
- `passoverStatus`/`passoverYear`/`passoverNote` marked deprecated in a
  schema comment, left in place (not dropped), zero reads/writes left in
  `server.js`.
- **Addition mid-step (user request before R1 finished):**
  `RawMaterialApproval.approvalSource` (new enum `ApprovalSource: PHONE|
  EMAIL|WHATSAPP|LETTER|PREVIOUS_YEAR|BODY_LIST|OTHER`, nullable) and
  `.approvalSourceDetail String?` — pushed separately, no warning (nullable
  additive). Queued for the R10 export's "מקור אישור" column later.

### R2 — API (done)
- **Matrix** `GET /api/raw-materials/:id/approvals`: one row per active
  body for `YEAR_ROUND`, plus one row per `handlesPassover` body for
  `PASSOVER` (both with `NOT_SENT` placeholders), plus any stray
  `PASSOVER` row for a body that isn't/no-longer-is `handlesPassover`/active.
- **List/detail**: approvals now carry `track`/`seasonYear`/
  `approvalSource`/`approvalSourceDetail`; `RawMaterial` output carries the
  origin-kashrut fields (read-only exposure — editing them is R4's job).
- **Send** `POST /api/raw-materials/:id/send`: rewritten for multi-body ×
  multi-track (`{kashrutBodyIds, tracks, contactIds: {bodyId: contactId},
  docIds, message, via, recordOnly?, followUp?}`, one email per body
  mentioning which track(s)). **Old single-body shape
  (`kashrutBodyId`+`contactId`) still works unchanged** — treated as one
  body × `YEAR_ROUND`. The old upsert's compound-key reference
  (`rawMaterialId_kashrutBodyId`) had to be updated to the new 3-column key
  name or every send would have thrown.
- **Reply** `POST /api/approvals/:id/reply`: validates status against the
  approval's own track; takes `seasonYear`; optional `alsoApprovalId` (+
  `alsoStatus`/`alsoConditionText`/`alsoSeasonYear`) to close both tracks
  of the same body with one letter/file — validated to be the *other*
  track of the *same* material+body. Response becomes a 2-element array
  when `alsoApprovalId` is used, otherwise unchanged (single object).
- **PATCH** `/api/approvals/:id`: same per-track status validation; takes
  `seasonYear`/`approvalSource`/`approvalSourceDetail`. Also fixed: the
  general-fields event used to fire even when nothing in it changed — now
  guarded.
- **New, not in the spec's literal R2 bullets but required to make the
  rest work:** `POST /api/raw-material-registry/:id/approvals`
  (`{kashrutBodyId, track}`) — get-or-creates a `NOT_SENT` row with a real
  id. Without it, `NOT_SENT` only ever existed as a synthesized matrix
  placeholder (`id: null`), so there was no row to `PATCH` to record a
  manual approval (e.g. a phone call) that was never preceded by a `/send`.
- **approvalSource rule** (same-day addition): any `PATCH` or `/reply` that
  changes `status` with no reply file attached (new or pre-existing)
  requires `approvalSource` — enforced in both endpoints; the file itself
  counts as evidence when present, so a filed reply never needs a source.

### Regression
`prisma/test-raw-material-registry-api.js` substantially extended:
multi-body/multi-track send, per-track status validation (both directions),
the get-or-create endpoint + idempotency, manual-approve-from-NOT_SENT with
`source=PHONE`/no file (and the 400 when the source is missing),
`alsoApprovalId` closing two tracks with one reply. All passover-specific
assertions from the superseded approach removed.
**40/40 passing**, self-cleanup independently re-verified (DB row counts
+ zero leftover `TEST-`/`test-admin` rows, checked outside the script too).

### R3 — List screen update (done, frontend only, no backend changes needed)
`public/raw-materials.js` rewritten for the two-track model:
- **Track switch** ("ימות השנה | פסח" pill buttons) at the top. Switching
  resets the body/status filter selections (they're track-specific) and
  re-renders the legend/dots/filter-options/counters/list for that track.
- **Body column sets are track-dependent**: `YEAR_ROUND` = all active
  bodies; `PASSOVER` = active `handlesPassover` bodies **plus** any body
  with a real `PASSOVER` approval row on *any* item (computed once across
  the whole dataset after load, so the legend/dots stay one fixed column
  set — not per-row — even for a stray body that no longer handles
  Passover or went inactive).
- **Colors**: NOT_SENT gray, SENT_PENDING orange, APPROVED green, REJECTED
  red, `NEEDS_INFO` purple, CONDITIONAL blue, `APPROVED_KITNIYOT` yellow.
  The status-filter dropdown only offers the statuses valid for the
  current track (mirrors the API's `isValidStatusForTrack`).
- **Counters**: added "בקשת פרטים" (NEEDS_INFO count, track-aware like the
  rest).
- **Origin kashrut**: small line per row, e.g. "מקור: OK · תעודה עד
  06/2027" (or "יש תעודה" without a date, or nothing if there's no origin
  data at all). New "ללא תעודת מקור" filter checkbox.
- **Legend**: 12px dark text (was .62rem light gray), `position:sticky;
  top:0` so it stays visible on scroll, same grid as the dots (unchanged
  mechanism, just now per-track).
- **Removed**: the "פ" badge and "מאושר לפסח (גוף)" filter from the
  superseded single-row Passover attempt — the track switch replaces both.

No backend changes were needed for R3 (origin fields and `track` were
already in the list API response from R2); verified the existing 40/40
regression suite still passes unchanged, and spot-checked via HTTP that
real data (7 raw materials, currently all `YEAR_ROUND` only — nothing's
been sent for Passover yet in production data) shapes correctly for the
new UI. Local server left running for manual browser verification.

### R1 follow-up — origin-Passover fields + computed-origin-approval (done)
Added directly to `docrepo-phase4-v2-tracks.md` on disk (not via chat) while
R3 was in progress; folded in as instructed. Backed up first
(`backups/2026-11-03T11-54-44-663Z/`).
- **Schema** (additive, no warning — nullable/defaulted): `RawMaterial`
  gains `originPassoverStatus` (new enum `OriginPassoverStatus:
  UNKNOWN|PASSOVER|PASSOVER_KITNIYOT|NOT_PASSOVER`, default `UNKNOWN`),
  `originPassoverText`, `originPassoverCertDocId` → `Document`,
  `originPassoverValidUntil`.
- **API**: `PATCH /api/raw-material-registry/:id` — discovered it didn't
  accept *any* origin fields yet (not even the year-round ones from R1/R2),
  so extended it for both sets now (R4's card will need this). Matrix
  endpoint (`GET /api/raw-materials/:id/approvals`) computes the
  "approved via origin" row: if `originKashrutBodyId` matches a body with
  no real approval row yet, that body's `YEAR_ROUND` row shows `APPROVED`;
  its `PASSOVER` row (if it `handlesPassover`) shows `APPROVED`/
  `APPROVED_KITNIYOT` when `originPassoverStatus` is `PASSOVER`/
  `PASSOVER_KITNIYOT`. **Never stored, never overrides a real row** — the
  moment a real `RawMaterialApproval` exists for that body+track, it wins.
  All approval objects (real, `NOT_SENT` placeholder, computed) now carry
  `viaOrigin: true/false` so the UI can distinguish them.
- **Regression**: 6 new checks (computed YEAR_ROUND/PASSOVER rows, other
  bodies unaffected, real send overriding the computed row).
  **46/46 passing**, self-cleanup re-verified.

### R3 fixes (done, requested alongside the R1 follow-up)
- **Legend centering**: `.rm-dots-grid` now sets `justify-items:center`
  directly (was relying on a flex wrapper per dot-cell, which could drift
  from the legend's plain `text-align:center`) — both dots and legend
  labels now center identically within the same grid columns.
- **Color key line**: a row of small colored dots + labels under the
  counters, track-aware (shows the 6 statuses valid for the current track).

### R1-follow-up UI (list screen)
- New fixed-width "מקור" column before the dots (not a sub-line anymore):
  year-round shows hechsher text + cert expiry; Passover view shows the
  Passover marking, colored by `originPassoverStatus` (green/yellow
  kitniyot/red/gray unknown). Legend gained a matching "מקור" header.
- New "כשר לפסח במקור" filter checkbox.
- Small "מ" badge on any dot that's `viaOrigin` (distinct from, and not to
  be confused with, the removed "פ" badge from the superseded single-row
  Passover attempt — this one marks a *computed* status, not a stored one).

Queued for later, not built now: R10's export needs all the origin fields
(including these Passover ones) in its columns — noted for when R10 comes up.

### R4 prep (started, not finished) + inline "מקור" editing (done)
R4 itself was interrupted by a new request before the card screen was
built. What actually landed in this pass:
- `GET /api/approvals/:id/events` — the first *read* endpoint for the
  approval history log (writes have existed since Phase 3). Needed for
  R4's "היסטוריה" button, built now since it's a small, independent,
  read-only addition. Regression: 2 new checks, returns newest-first with
  `type`/`at`/`byUserName` — **48/48 passing**.
- `openSkuPicker`/`confirmSkuPicker` in `index.html` gained a minimal
  `'rmCard'` mode (one line each) that delegates to a `rmCardOnSkuPicked()`
  function that doesn't exist yet — harmless no-op stub (guarded by
  `typeof ... === 'function'`) until R4's linked-SKUs section is built.
- **Inline editing on the list's "מקור" column** (requested separately,
  done): click the cell (year-round: `originKashrutText`; Passover:
  `originPassoverText` + a status `<select>`) → Enter or blur saves via
  `PATCH /api/raw-material-registry/:id`, Esc cancels. Guarded by
  `rmIsReadOnly()` (assistant role, or `?demo=1` once demo mode exists
  elsewhere — checked directly since no shared demo helper exists yet).
  Race-safety: a cancel deletes the `editing` flag before re-rendering, and
  save/cancel both no-op if that flag is already gone, so the implicit
  blur a DOM-removal causes can't trigger a duplicate/contradictory save.

### R4 — Raw-material card (done)
`public/raw-materials.js` grew a second screen (~380 new lines) + a
2-line `index.html` edit (card page container; the `'rmCard'` SKU-picker
mode from the previous pass is now wired up for real). No backend
changes needed — everything uses endpoints that already existed.
- Clicking any list row (`rmOpenCard`) opens the card; the "מקור" cell's
  click handler now also calls `event.stopPropagation()` so entering
  inline-edit mode on that cell doesn't also open the card underneath it
  (the propagation guard stays attached for the cell's whole edit
  lifetime, not just the initial click, so typing inside the open input
  can't leak a click through to the row either).
- **Header**: name/supplier/manufacturer/notes, toggle-edit (view ↔ inline
  form with שמור/ביטול), matching the spec's "an edit button" framing.
- **"כשרות המקור" box**: two side-by-side sections (ימות השנה / פסח), each
  autosave-per-field (blur for text, change for select/checkbox/date) via
  `PATCH /api/raw-material-registry/:id` — no separate edit-mode toggle
  for this box, since these are direct-reflecting settings fields rather
  than a form you submit. Certificate fields offer *either* picking one of
  the material's own already-uploaded documents from a dropdown, *or*
  uploading a new file directly (which uploads with role `CERT` then
  PATCHes it in as the cert doc — year-round upload also auto-sets
  `originHasCert:true`).
- **Documents gallery** grouped by the 6 roles; image thumbnails preview
  inline, everything (including PDFs) opens via
  `/api/docs/:id/download?inline=1` in a new tab so the browser's own
  viewer renders it instead of forcing a download. Upload control per
  card (file + role select).
- **Approvals table, two sections** (ימות השנה / פסח) from the matrix
  endpoint, columns per spec (body — with a "(מקור)" tag on
  computed-origin rows — status badge, contact, sent/reply dates, reply
  file link, condition/note, and a season-year column only in the
  Passover section). "שלח"/"עדכן תשובה"/"שלח השלמה" (the last only shown
  when status is `NEEDS_INFO`) show a "not built yet, coming in R5/R6"
  toast for now — those are explicitly separate later steps. **"היסטוריה"
  is real**, using the `GET /api/approvals/:id/events` endpoint added in
  the previous pass: opens a modal (reusing the site's existing
  `.modal-bg`/`.modal` CSS) listing every event newest-first. Both
  "עדכן תשובה" and "היסטוריה" only appear on rows with a real approval id
  (`NOT_SENT`/computed-origin placeholders have `id:null` — nothing to
  open yet).
- **Linked SKUs**: pills with a remove "✕" (`DELETE .../skus/:skuCode`);
  "+ הוסף מק"ט" reuses the existing SKU picker via the `'rmCard'` mode
  stub from the previous pass, now implemented (`rmCardOnSkuPicked`
  loops the selection through `POST .../skus`).
- All write affordances (edit buttons, autosave fields, upload, send/reply
  stubs, SKU add/remove) hidden/disabled for `rmIsReadOnly()`
  (assistant role / future demo mode) — "היסטוריה" and document preview
  stay available since they're read-only.

Verified via HTTP against real data (not just the dry test material):
pulled a real card's `documents`/`skus`/matrix shape and a real approval's
event history (from the Phase 2 migration) and confirmed every field the
UI reads is actually present with the expected shape. Existing 48/48
regression suite still passes unchanged (no backend touched this pass).

## Display-name rename (done, between R4 and R5)
App display name changed to "ניהול כשרות – אחים כהן" everywhere a user
sees it: `<title>`, `apple-mobile-web-app-title` meta, header/logo text,
hero `<h1>`, and `manifest.json`'s `name` (`short_name` was already
"ניהול כשרות"). Repo/folders/URLs/`package.json` name/DB/env vars
untouched. Verified byte-level (en dash + Hebrew code points only, no
stray characters) and live via HTTP.

## Review-first email rule (done, added before R5 -- schema + API)
New rule, applies to all future sending (R5, R12, and the separate
doc-requests feature in `docrepo-doc-requests-spec.md`): **the app never
emails a kashrut body directly.** Backed up first
(`backups/2026-11-03T13-30-38-147Z/`).
- Schema: `RawMaterialApprovalStatus` gained `SENT_FOR_REVIEW` (additive,
  no warning).
- `POST /api/raw-materials/:id/send`: when `via=EMAIL`, the real email
  (unless `recordOnly`) now goes to `REVIEW_EMAIL` (env, default
  `a0527613684@gmail.com`) instead of the body's contact, wrapped with
  subject `[לבדיקה והעברה] → <body> / <contact> <email> – <original
  subject>` and a header block naming the intended recipient + attachment
  list, followed by the original ready-to-forward message. Resulting
  status is `SENT_FOR_REVIEW` with `sentAt` left **unset** (it isn't
  actually sent to the body yet). `WHATSAPP` is completely unchanged
  (still client-side, still `recordOnly=true`, still goes straight to
  `SENT_PENDING`) -- no review step for it.
- New `POST /api/approvals/:id/confirm-forward` (optional `{sentAt}`,
  defaults to now): the user's "I checked the email and forwarded it
  myself" action. Only valid from `SENT_FOR_REVIEW`; sets `SENT_PENDING`
  + `sentAt` (editable) + a `SENT` event. Rejects (400) if the approval
  isn't currently `SENT_FOR_REVIEW`.
- Regression: 5 new checks (review-send status/sentAt, matrix shows
  exactly 1 `SENT_FOR_REVIEW`, confirm-forward with a custom `sentAt`,
  its event, and double-confirm rejected). One real bug this test suite
  caught before it ever reached the frontend: a contact-required check
  I'd placed outside the `sendRealEmail` guard broke the old
  `recordOnly`+no-contact test path with cascading downstream failures
  (`approvalId` ending up `undefined` in later calls) -- moved back
  inside the guard, matching original behavior. **52/52 passing.**

## Side export (ad hoc, read-only, unrelated to the registry)
`prisma/export-unlinked-docs.js` → `exports/unlinked-docs.csv` (gitignored,
UTF-8 with BOM): every `Document` with zero `SkuLink`s, 917 rows as of
2026-11-03. `originalFileName` is the R2 storage key's basename (the
literal original upload filename was never persisted anywhere); `notes`
maps to `Document.description` (no separate notes column exists).

## R5 — Send modal (done)
Appended to `public/raw-materials.js`. Backend already supported
everything needed (multi-body/multi-track send, the review-first rule
above) -- this is frontend only.
- Opened per-row from the card's "שלח" button (preselects that row's
  body+track) or "שלח השלמה" on a `NEEDS_INFO` row (same modal,
  `followUp=true`) -- both now real, no longer stubs. "עדכן תשובה" is
  still a stub (that's R6).
- **Multi-select bodies** (active bodies, Passover-handling first by
  `sortOrder`), **track checkboxes** (ימות השנה / פסח, both = "שניהם"),
  **contact picker per selected body** (dropdown filtered to contacts
  with `kashrutBodyId` matching + the right channel field, defaulting to
  the body's `defaultContactId` when set) with a "+ חדש" inline
  add-contact action (`POST /api/contacts` with `kashrutBodyId` set).
- **Documents**: checkboxes over the card's own documents; the `LABEL`
  role doc(s) and the relevant origin certificate
  (`originCertDocId`/`originPassoverCertDocId`, whichever track(s) are
  selected) are pre-checked.
- **Message**: Hebrew template that regenerates per selected track(s)
  (and prepends a follow-up line when `followUp`) -- but only while the
  user hasn't touched it. Caught and fixed a real bug here: every toggle
  (body/track/channel) re-renders the whole modal body, which would have
  silently discarded an in-progress message edit each time; now a dirty
  flag preserves the textarea's current value across re-renders once the
  user has typed in it.
- **Email**: calls `/send` with `via=EMAIL` (no `recordOnly` -- the
  server's review-first wrapping handles the rest); toast explains the
  email went to the user's own address first, not the body.
- **WhatsApp**: unchanged approach, reused from the legacy screen --
  fetches the selected documents as blobs, tries `navigator.share`, falls
  back to downloading the files + opening a `wa.me` text-only link; asks
  "נשלח?" per body (since each body has its own phone number, bodies are
  processed one at a time for this channel), then records via `/send`
  with `recordOnly=true`.
- Card's approval rows gained a real **"✔ הועבר לגוף"** button on
  `SENT_FOR_REVIEW` rows, calling `confirm-forward` (prompts for an
  optional custom date).

Verified: existing 52/52 regression suite still passes (no backend
changed in this pass); checked live contact/kashrut-body data shapes
against what the modal reads.

## Side task: link documents to SKUs from exports/link-strict.csv (done)
Backed up first (`backups/2026-11-03T14-45-54-572Z/`). Dry run
(`prisma/link-docs-dryrun.js`) reported 79 rows / 57 distinct docs / 32
distinct SKUs, all resolved, 1 link already existed, 78 would be created
-- stopped and waited for approval as instructed. After approval,
`prisma/link-docs-run.js` re-resolved everything fresh (not trusting the
earlier dry-run JSON, in case anything changed) and created exactly those
78 `SkuLink` rows via the same shape the app itself uses for a regular
document→SKU link (`docType:'DOCUMENT'`, `isRawMaterial:false`,
`approvalStatus:'APPROVED'`, `kashrutLevel:null`) -- additive only, never
touching the 1 pre-existing link or anything else. Verified: `SkuLink`
count went 412→490, exactly +78.

## Side task: download a priority batch's files from R2 (done, read-only)
`prisma/export-priority-batch-files.js` read `exports/priority-batch.csv`
(documentId + priorityFileName columns) and saved each document's file to
`exports/priority-batch-2026-11-03/<priorityFileName>` (exact name,
Hebrew-safe UTF-8). Zero DB writes -- only `Document.findMany` (read) and
an R2 `getObjectStream` per unique document. All 12 rows resolved and
wrote successfully; verified non-zero file sizes on disk.

## Side task: fix one wrong link from the batch-link side task (done)
`exports/link-strict.csv`'s batch created doc 34 (cert 204564, regular
apple vinegar) → SKU 17381 (the *Passover* variant, same display name but
a different SKU id) -- a genuine mistake, not a script bug (both SKUs are
literally named "חומץ תפוחים 1 ליטר - כהן"). Backed up first
(`backups/2026-11-03T15-26-19-917Z/`), showed the exact wrong row
(`SkuLink` id 454) and waited for approval before deleting it. Created
the correct doc 34 → SKU 17183 link (id 532) first (additive, no gate
needed), then deleted id 454 after approval. Net `SkuLink` count
unchanged (490, +1/-1), verified.

## R6 — Reply modal (done)
Appended to `public/raw-materials.js`; backend already supported
everything via the existing `alsoApprovalId` mechanism on `POST
/api/approvals/:id/reply` (built alongside R2) -- one small backend
symmetry fix was needed (below), otherwise frontend only.
- "עדכן תשובה" on any row with a real approval id opens the modal fixed to
  that row's **body** (not re-selectable -- the row already picked it),
  showing **both of that body's tracks** (whichever have a real approval
  row; a track with no row at all, e.g. a body that doesn't
  `handlesPassover`, simply isn't offered). Each track has its own
  checkbox (default-checked if `SENT_PENDING` **or** it's the track the
  button was clicked from) and its own status dropdown, restricted to the
  4-5 "decision" statuses (`APPROVED`/`REJECTED`/`NEEDS_INFO`/
  `CONDITIONAL` for ימות השנה, swapping `CONDITIONAL`→`APPROVED_KITNIYOT`
  for פסח) -- deliberately narrower than the full status set, since
  `NOT_SENT`/`SENT_PENDING`/`SENT_FOR_REVIEW` aren't reply outcomes.
- **Shared across whichever tracks are checked**: one file (optional),
  one reply date (defaults today), notes, and an `approvalSource`
  picker that only appears (and is required) when no file is attached --
  matches the existing backend rule exactly.
- **Per-track**: condition text (ימות השנה only) / season year (פסח
  only), shown only for a checked track of that kind.
- Submitting with both tracks checked sends the first (ימות השנה, if
  present) as the primary reply and the second as `alsoApprovalId` +
  `alsoStatus` (+ its own condition/season field) in the same call --
  one shared file and date closes both tracks at once, as the backend
  already supported.
- **Small backend fix made for this step**: the `also`-track update in
  `POST /api/approvals/:id/reply` only ever set `notes` on the *primary*
  approval, never the also one, even though the spec treats notes as one
  shared field for the whole reply. Fixed to share it onto both. New
  regression check confirms it. **53/53 passing.**
- **Caught and fixed a real bug before it shipped**: the submit handler
  was calling `apiFetch(...)` for the multipart file upload --
  `apiFetch` unconditionally forces `Content-Type: application/json`,
  which would have broken the `FormData` body (no multipart boundary set
  at all). Switched to the same raw-`fetch` + `authHeaders()` pattern
  already used elsewhere in this file for uploads.
- Re-render preserves already-typed values (file selection, condition
  text, season year, notes, source detail) the same way the send modal's
  message field does, since toggling a track checkbox or changing a
  status re-renders the whole modal body.

Verified: 53/53 regression suite passing; confirmed the reply modal's
served JS live over HTTP.

## R10 — Excel export (done)

- **New dependency: `exceljs` (^4.4.0), added with explicit approval.**
  The already-installed `xlsx` (SheetJS Community Edition 0.18.5) cannot
  write cell fill colors or frozen panes -- verified empirically (wrote a
  styled cell, read it back, style was gone). Both are required by this
  step ("cells are colored like the dots", "frozen header row and first
  column"), so I stopped and asked before adding a library, per the
  spec's rule. Confirmed exceljs round-trips fill colors, frozen panes,
  and RTL correctly before building the real export.
- **Refactored, not duplicated:** the matrix row-building logic inside
  `GET /api/raw-materials/:id/approvals` (NOT_SENT placeholders,
  computed-origin-approval, orphaned-Passover-row surfacing) was
  extracted into a standalone `buildApprovalMatrixRows(rm, bodies,
  approvals)`. The export calls the exact same function per raw material,
  so the spreadsheet can never drift from what the live screen shows.
- **`POST /api/raw-material-registry/export`** (body: `{ ids: [...] }`,
  empty/absent = all): returns an .xlsx buffer.
  - **Sheet 1 "סטטוס"**: one row per raw material. Base columns (name,
    supplier, manufacturer, linked SKU codes, origin kashrut text, has
    cert, cert valid-until), then two columns per active body ("<body> –
    שנה" / "<body> – פסח"), each cell holding the Hebrew status label
    with a fill color matching the list screen's dot colors (same
    `RM_STATUS_COLOR` hex values, mirrored server-side since they're
    needed at write time); the Passover cell also appends the season
    year in parens when set. Frozen header row + first column, RTL.
  - **Sheet 2 "פירוט"**: one row per *real* approval activity (a true DB
    row, or a computed-origin row) -- skips the plain NOT_SENT
    placeholders that would otherwise bloat this sheet with mostly-empty
    rows for every body x raw-material combination. Columns: name, body,
    track, status, contact, sent date, reply date, condition/note,
    season year. Frozen header row.
  - Filename: `חומרי גלם - YYYY-MM-DD.xlsx` (RFC 5987 `filename*=UTF-8''`
    + an ASCII fallback, matching the existing doc-download pattern).
- **List screen**: new "📥 ייצוא לאקסל" button. Exports *exactly* the
  currently-filtered set -- `rmApplyFilters()` (all client-side: search,
  body, status, supplier, needs-review, no-origin-cert, origin-Passover,
  stale-days) now also stores `RM_STATE.lastFilteredIds`, which the
  export button sends as `ids`. No server-side re-implementation of the
  filter logic, so there's no risk of the export disagreeing with what's
  on screen.

Regression: `prisma/test-raw-material-registry-api.js` extended with 7
checks (export 200 + xlsx content-type, sheet 1/2 exist with real data,
frozen panes present, a body status column header exists, at least one
status cell has both a label and a fill color) -- scoped to just the
test record via the `ids` filter. **60/60 passing**, table-count
snapshot confirms clean TEST- cleanup.

### Next
R11 (Excel import) → R12 (bulk send) → R7 (add-material flow) → R8 (SKU
tab) → R9 (contacts/bodies settings), stopping after each with a
browser-checkable summary.

## R11 — Excel/CSV import (done)

- **Schema (additive):** `RawMaterial.supplierItemCode String?` +
  `RawMaterial.importId Int?` (-> `RawMaterialImport`); new
  `RawMaterialImport { id, fileDocId -> Document, byUserId -> User, at,
  rowsCreated, rowsSkipped }`. Backed up first:
  `backups/2026-11-10T10-54-59-687Z`. Clean `prisma db push`, no
  data-loss warning.
- **Gating ("not available for the assistant role or in demo mode"):**
  every import route uses `requireAuth` (plain JWT only), not
  `requireAssistant` -- `requireAuth` never looks at the
  `x-assistant-code` header at all, so the assistant pseudo-auth is
  rejected with 401 by construction, not by a special-cased role check.
  Demo mode is gated client-side the same way the rest of this screen
  already does it (`rmIsReadOnly()` hides the "📤 ייבוא מאקסל" button
  entirely).
- **Three-step wizard**, all in one dynamically-built modal
  (`.modal-bg`/`.modal` -- the same classes index.html's static modals
  use, so no new overlay CSS was needed):
  1. **Upload** (`POST .../import/parse`, .xlsx via `exceljs` xlsx.load
     or .csv via `exceljs` csv.read on a buffer-backed stream) -- returns
     headers + every row + a guessed column mapping.
  2. **Column mapping**: a dropdown per field (name/supplier/manufacturer/
     origin kashrut text/SKU codes/notes/supplier item code), pre-filled
     from the guess. The guess keyword table is ordered supplier-item-code
     before SKU-codes on purpose -- a header like "קוד פריט ספק" contains
     the substring "מקט" that the generic SKU-codes keyword would
     otherwise have greedily claimed first.
  3. **Preview** (`POST .../import/preview`): every row classified
     **חדש** / **קיים** (by `supplierItemCode`, else normalized
     name+supplier) / **שגיאה** (missing name, or any unresolvable SKU
     code in the comma-separated list -- one bad code fails the whole
     row, not just that code). חדש rows ticked by default, קיים
     unticked, שגיאה permanently disabled. An "עדכן שדות ריקים בקיימים"
     checkbox controls whether ticking a קיים row fills *only* its empty
     fields on the matched record -- existing values are never
     overwritten either way.
- **Commit** (`POST .../import/commit`, re-sends the same file): creates
  `RawMaterial` rows for ticked חדש rows (+ `SkuRawMaterial` links for
  any SKU codes found), applies empty-field fills for ticked קיים rows
  when the checkbox was on, saves the file itself as a `Document`
  (`docType: 'אחר'`, hidden) linked via a new `RawMaterialImport` row,
  and returns a created/skipped summary. Classification is recomputed
  from the same shared `classifyRegImportRows()` at commit time (not
  trusted from the client), so a stale preview can't create something
  that no longer qualifies.
- **List screen**: new "📥 מייבוא אחרון" filter checkbox -- computed
  purely from the loaded items' `importId` (whichever value is highest),
  so it keeps working correctly after a page reload, with no extra
  endpoint needed.
- Tested with a TEST- prefixed in-memory CSV (4 rows: one new, one
  duplicate-by-name+supplier, one missing name, one unknown SKU code) --
  never written to disk, built and sent directly in the regression test.

Regression: `prisma/test-raw-material-registry-api.js` extended with 18
checks (auth gating, parse/mapping-guess, all three classifications,
commit counts, SKU link creation, fill-empty-without-overwrite, the
import batch + saved Document, list-endpoint exposure for the new
filter). **78/78 passing**, table-count snapshot (now including
`rawMaterialImport`) confirms clean TEST- cleanup, R2 test object
deleted.

### Next
R12 (bulk send) → R7 (add-material flow) → R8 (SKU tab) → R9
(contacts/bodies settings), stopping after each with a browser-checkable
summary.

## Pre-R12 fixes (done)

**A) R11 preview: sort, filters, select-all/none.**
- Click any column header to sort by it (asc/desc toggle, ▲/▼ indicator).
- Filters: supplier, manufacturer (both from the parsed file's own
  values), plus kashrut body / track / status -- clarified with the user
  that these three apply to the **matched existing record's current
  approval matrix** for קיים rows (there's no body/track/status on a
  pre-import row itself). The backend's `classifyRegImportRows()` grew an
  optional third argument that attaches each קיים row's
  `existingApprovals` (via the same `buildApprovalMatrixRows()` R10
  already uses), computed only for the preview call, not for commit.
- "סמן הכל" / "בטל הכל" tick/untick every currently-*visible* (post-filter)
  row, skipping שגיאה rows (never selectable either way).

**B) R10 export color-scheme fix.**
- לא נשלח cells are now left completely blank -- no label text, no fill
  -- instead of the old solid gray "לא נשלח" cell.
- Every other status uses Excel's classic light-fill/dark-text pairs
  instead of the old solid dot colors: approved (incl. מאושר לקטניות)
  #C6EFCE/#006100, rejected #FFC7CE/#9C0006, pending/sent (incl. בקשת
  פרטים, נשלח אליך לבדיקה) #FFEB9C/#9C5700, conditional #FFE0B2/#E65100.

**B, side task) Looked up "אריזת פלסטיק PET לזרם המסחרי" / SKU 8455**
(RawMaterial id 8): supplier is ת.מ.י.ר - תאגיד מחזור יצרנים בישראל בע"מ
(the Israeli packaging-recycling compliance body), 0 approvals, 1 label
photo document. This is a packaging-recycling-fee item, not a food
ingredient awaiting kashrut approval -- which is exactly why it has zero
approval activity and will never generate any. Recommended archiving it
out of the active registry view. **Not done yet**: `RawMaterial` has no
`archived` field at all (unlike `Document`, which already has one from
L0) -- flagged to the user rather than guessing at adding one; no schema
change made, nothing deleted.

Regression: both fixes covered by 2 new checks in
`prisma/test-raw-material-registry-api.js` (a NOT_SENT column is blank
with no fill; every filled cell's color comes from the new palette, never
the old solid dot colors). **80/80 passing.**

## R12 — Bulk send (done)

- **Row checkboxes** on the list (hidden in read-only mode, same gate as
  everything else here), a "בחר הכל (מסוננים)" checkbox that selects every
  currently-*filtered* row (not the whole dataset), a live selected-count,
  and "📨 שלח מסומנים לאישור" once at least one row is checked. Checking a
  single row only re-renders the small toolbar, not the whole list, so
  the scroll position doesn't jump.
- **Modal**: same shape as R5 (track checkboxes, EMAIL/WhatsApp channel,
  body multi-select with a contact picker per body, editable message),
  plus a read-only list of the selected materials' names and a live
  summary line ("N חומרי גלם × M גופים × מסלול = N×M×tracks בקשות").
  Documents are **not** a per-item checklist here -- per the spec they're
  automatic: each selected material's label + its relevant origin
  certificate(s) for the chosen track(s).
- **New `POST /api/raw-material-registry/bulk-send`**: one email per
  body, aggregating every selected raw material into one table (name /
  manufacturer / origin kashrut) with every item's label+cert attached.
  If a body's combined attachments exceed ~20MB, they're split across
  several emails for that body instead of zipped (same aggregated table
  repeated in each, a subset of attachments, "(חלק X/Y)" in the subject)
  -- no new dependency needed for that, and the response's `warnings`
  array surfaces it as a toast. Same REVIEW_EMAIL rule as R5's
  single-item send: EMAIL always goes to `REVIEW_EMAIL` first (status
  `SENT_FOR_REVIEW`, `sentAt` unset), never directly to the body -- the
  **existing, unchanged** `POST /api/approvals/:id/confirm-forward`
  ("✔ הועבר לגוף") is what moves it to `SENT_PENDING`, since it already
  works per-approval-id regardless of whether the row came from a single
  or bulk send. An approval row + a SENT event is written for every
  (raw material × body × track) combination.
- **Before sending**: the live summary line doubles as the required
  confirm step -- the "שלח" button's `confirm()` dialog repeats that
  exact text ("לשלוח?") before the request fires.
- Bulk WhatsApp is simplified to recording-only (no per-item file-share
  dance across potentially many materials' many documents) -- WhatsApp
  already always required `recordOnly=true` in the single-send endpoint
  too, so this doesn't reduce anything that was previously real.

Regression: `prisma/test-raw-material-registry-api.js` extended with 7
checks (2 materials x 2 bodies x 2 tracks = 8 approvals, all
SENT_FOR_REVIEW with sentAt unset, one SENT event each with `bulk: true`,
every combination covered exactly once, missing-ids rejected). Uses
`recordOnly: true` even for the EMAIL channel -- same convention as the
existing single-send test, never calls nodemailer. **87/87 passing**,
clean TEST- cleanup.

## RawMaterial.archived (done)

- **Schema (additive):** `RawMaterial.archived Boolean @default(false)` +
  `archivedReason String?` -- same pattern as `Document.archived`/
  `archivedReason` from L0. Backed up first:
  `backups/2026-11-10T12-19-56-700Z`. Clean push, no data-loss warning.
- **Backend:** `GET /api/raw-material-registry` excludes `archived:true`
  by default (`?includeArchived=1` to include); `POST .../export`
  excludes archived when no `ids` are given (an explicit `ids` list wins,
  same as before); `POST .../bulk-send` hard-rejects (400, names the
  items) if *any* selected raw material is archived, regardless of the
  list toggle; new `POST .../:id/archive` (`{reason}`) and
  `POST .../:id/restore`, both additive, neither ever deletes anything.
- **Frontend:** the list always fetches with `includeArchived=1` and
  applies the hide-by-default rule client-side (same architecture as
  every other filter here), so a new "🗄 הצג גם בארכיון" checkbox affects
  the list, the summary counts, *and* the export in one place -- the
  export already sends exactly `RM_STATE.lastFilteredIds`. An archived
  row shows dimmed with a "🗄 בארכיון" badge (title = the reason) and a
  "↩ שחזר" button instead of the bulk-select checkbox.
- Deliberately did **not** add an "archive" button to the UI -- the
  request only asked for the hide-by-default behavior + a restore action;
  archiving itself happens via the API for now (as done for id 8 below).

**Archived RawMaterial id 8** ("אריזת פלסטיק PET לזרם המסחרי", supplier
ת.מ.י.ר), reason "לא חומר גלם – אריזה" -- confirmed via the API, no
longer in the default list.

Regression: 7 new checks (archive sets the fields, hidden from the
default list, visible with includeArchived=1, excluded from a no-ids
export, bulk-send rejects it by name, restore clears both fields and it
reappears). **94/94 passing**, clean TEST- cleanup.

## R7 — Add raw material (done)

- **New "+ חומר גלם חדש" button** on the registry list (hidden in
  read-only mode). There was no add-material UI in the *new* registry at
  all before this -- only the legacy SkuLink-based screen had one. Kept
  that flow's shape (photo capture, attachments, SKU picker) inside the
  new registry rather than reviving the legacy screen.
- **Schema (additive):** `RawMaterial.allergens String?` (backed up
  first: `backups/2026-11-10T12-52-06-282Z`, clean push). `POST`/`PATCH
  /api/raw-material-registry` now also accept `originKashrutText` +
  `allergens` directly, so the add-material flow doesn't need a separate
  PATCH right after create.
- **"🤖 זהה מהתווית"** -- new `POST
  /api/raw-material-registry/identify-label`: a Haiku call tailored to
  raw-material labels (name, manufacturer, supplier, origin hechsher
  text, allergens), picking the real `media_type` from the file's own
  extension (jpg/png/webp/gif/pdf) instead of hardcoding
  `application/pdf` the way the older `/api/identify` does. Every
  suggested value lands in the form's own editable inputs only --
  nothing is saved until the user reviews/edits/confirms and clicks
  "שמור"; a field Claude couldn't read comes back `null` and is left
  blank rather than invented.
- **SKU picker reuse:** added a third mode (`'rmNew'`) to index.html's
  existing global `openSkuPicker()`/`confirmSkuPicker()` -- 3 minimal,
  targeted edits (an existing-selection lookup, a dispatch branch, a
  toast-suppression check), matching exactly how the `'rmCard'` mode was
  added before. No rewrite of that shared picker.
- **Save**: creates the `RawMaterial` (with `originKashrutText`/
  `allergens` already set), uploads each attached file via the existing
  per-item documents endpoint (role `LABEL`), and links the picked SKU
  via the existing skus endpoint -- three small calls to routes that
  already existed, no new write endpoint needed for the save itself.

Verified the real AI call end-to-end against an existing label photo
already in the system (Document 984, "תויות 12096 — קווקר דק מורנינג שק
ירוק"): correctly extracted name ("Bar Lakol Std 27 Oat Flakes") and
manufacturer ("Richardson Milling (UK) Ltd"), correctly returned `null`
(not invented) for the fields not visible on that particular label.

Regression: `prisma/test-raw-material-registry-api.js` extended with 4
checks (create accepts the two new fields, PATCH updates allergens,
identify-label rejects a missing file and an unsupported file type). The
real Claude call itself is intentionally **not** in the permanent suite
(same precedent as the pre-existing `/api/identify`, also untested here)
to avoid a recurring API cost/flakiness on every run -- verified manually
instead, as above. **98/98 passing**, clean TEST- cleanup.

### Next
R8 (SKU tab) → R9 (contacts/bodies settings), stopping after each with a
browser-checkable summary.

## R8 — SKU tab (done)

- **Found and fixed a real bug before building anything new**: the
  backend endpoint this step needed (`GET /api/skus/:code/raw-materials`)
  already existed from Phase 3, but predated the two-track revision --
  it picked *whichever* approval row for the SKU's required body
  happened to come first, with no regard for track at all. R8 explicitly
  asks for "both tracks" + "a summary badge per track", which this old
  shape couldn't express. Rewrote it: `requiredApprovalYearRound` /
  `requiredApprovalPassover` are now looked up separately, and the
  response grew `summaryBadgeYearRound`/`summaryBadgePassover` -- one
  per track, aggregated across the SKU's (non-archived) linked raw
  materials' status for the required body specifically.
- Kept (and clarified with a comment) the pre-existing per-item
  `summaryYearRound`/`summaryPassover` fields, which deliberately
  summarize a raw material's status across *every* body it's been sent
  to, not just the SKU's required one -- a different, still-useful
  signal (e.g. flags a material whose required body is fine but some
  other body rejected it). Caught my own test asserting the wrong thing
  here on the first run and fixed the assertion, not the code, once I
  traced through why -- the two fields answer different questions on
  purpose.
- **New "SKU tab"** inside the existing SKU edit modal
  (`public/sku-raw-materials-tab.js`, self-contained, own styles): one
  empty container + one call at the end of the existing `openEditSku()`
  + one `<script>` tag were the only edits to `index.html`. Shows the
  SKU's required kashrut body, the two per-track summary badges, and a
  row per linked (non-archived) raw material with a colored dot +
  Hebrew status for each track plus a "פתח" button that closes the SKU
  modal and opens that raw material's card in the registry.

Regression: `prisma/test-raw-material-registry-api.js` extended with 6
checks, using a dedicated test SKU whose required body (via the existing
"לנדא" -> "הרב לנדא" alias) matches real approvals already set earlier in
the test (YEAR_ROUND=APPROVED, PASSOVER=APPROVED_KITNIYOT) -- confirms
both tracks are genuinely split, not just "whichever came first", plus
the alias resolution and both summary-badge levels. **104/104 passing**,
clean TEST- cleanup.

### Next
R9 (contacts/bodies settings), stopping with a browser-checkable summary.

## R9 — Contacts and bodies settings (done, last step of S4)

- **No contacts/bodies management UI existed at all** before this --
  only `GET`/`POST`/`DELETE /api/contacts` and a bare `GET
  /api/kashrut-bodies` existed, with no frontend caller for any of them.
- **Contacts**: `POST /api/contacts` now also accepts `kashrutBodyId` +
  `role`; new `PATCH /api/contacts/:id` edits name/email/phone/body/role
  (rejects clearing both email and phone, same rule as create). **No
  delete button anywhere in the new screen** -- the pre-existing `DELETE
  /api/contacts/:id` is untouched but has no caller here, per "do not
  delete existing contacts."
- **Bodies settings (admin only)**: new `PATCH /api/kashrut-bodies/:id`
  (`requireAuth`+`requireAdmin` -- edits only, never creates/deletes a
  body) for shortName/active/handlesPassover/sortOrder/defaultContactId;
  `kashrutBodyOut()` now also exposes `defaultContactId` (it didn't
  before). The section is always shown in the UI, same convention as the
  existing "🔑 ניהול קודי גישה" admin screen -- a non-admin gets a
  rejection toast on save rather than the section being hidden
  client-side.
- **New self-contained screen**
  (`public/contacts-bodies-settings.js`, "👥 אנשי קשר וגופי כשרות"): one
  table for contacts (editable inline, add-new row at the bottom) and
  one for the 11 seeded bodies (editable inline: short name, active,
  handles-Passover, sort order, and a default-contact dropdown scoped to
  contacts already assigned to that body). One nav button + one empty
  container + one script tag in `index.html`.

Regression: `prisma/test-raw-material-registry-api.js` extended with 6
checks (contact create/reassign/validation, all 5 body-settings fields
update together, `defaultContactId` now exposed, the admin-only PATCH
correctly rejected for assistant-code-only auth -- caught my own test
asserting 403 instead of the real 401, since `requireAuth` rejects a
request with no Bearer token before ever reaching the admin check).
**110/110 passing**, clean TEST- cleanup.

### S4 complete
R1 → R2 → R3 → R4 → R5 → R6 → R10 → R11 → R12 → R7 → R8 → R9, every step
additive, backed up first, stopped after each with a browser-checkable
summary and a `progress.md` update. Nothing pushed, merged, or deployed.
