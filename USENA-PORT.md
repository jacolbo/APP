# Porting into Usena

Notes for whoever (or whatever) does the merge into `jacolbo/usenaflow`.

## Do not port the app

Usena already has a client gallery, and in several respects a better one than
this repo's. It has `galleries`, `gallery_sets`, `gallery_photos`,
`gallery_fav_lists` (per-client-email favourite lists with selection limits —
which this app never had), `gallery_selections` with notes, `gallery_downloads`,
`gallery_auth_tokens`, CSV export, GCS storage with signed URLs, and a
`settings` JSONB column that is already the full Pixieset settings panel.

It also already has `server/services/googleDriveService.ts` with
`checkFolderIsPublicLink()`, `makeFolderPublic()`, `countImagesInFolder()` and
`getImageThumbnails()`, plus `gmailService.ts` for sending mail.

Replacing that with this repo would throw away working, more mature code and
force a stack change from TypeScript/React/Drizzle/Postgres to vanilla JS and a
JSON file. **Port the three gaps instead.**

Everything below is verified against the repo at the commit that was cloned, not
assumed.

---

## Gap 1 — sets do not nest

**Verified:** `gallery_sets` has no parent reference (`grep -c parent` over the
table definition returns 0). The hierarchy is galleries → sets → photos, one
level, flat.

The requirement was unbounded nesting: a folder inside a folder inside a folder.

### Schema

```ts
export const gallerySets = pgTable("gallery_sets", {
  // … existing columns …
  parentSetId: varchar("parent_set_id").references((): AnyPgColumn => gallerySets.id, {
    onDelete: "cascade",
  }),
  depth: integer("depth").notNull().default(0),
});
```

`AnyPgColumn` is required for the self-reference or TypeScript cannot infer the
type. `onDelete: "cascade"` gives you subtree deletion for free.

### The three rules that must be enforced server-side

These are not optional polish. Each one is a way the tree corrupts:

1. **A set cannot become its own ancestor.** Walk the parent chain on every
   re-parent and reject if you meet the set being moved. Without this, a cycle
   makes every later tree walk hang.
2. **Cap the depth.** This app used 20. Store `depth` denormalised and
   recompute it for the whole subtree on a move, or every render costs a
   recursive query.
3. **A gallery must keep at least one client-visible set.** Otherwise a client
   opens the link to an empty page with no way to tell whether that is a bug.

### Rendering

Load the whole set tree for a gallery in one query and assemble it in memory.
Do not query per level — a five-deep tree becomes five round trips per page.

---

## Gap 2 — photos are never Drive-backed

**Verified:** `driveFileId` appears 0 times in `shared/schema.ts`. Every photo is
copied into GCS.

The model that is missing: **the preview lives in your storage, the
full-resolution original stays in Drive and is fetched only at download.** No
duplicated storage, and deleting from Drive does not silently leave a stale copy
being delivered as final.

### Schema

```ts
export const galleryPhotos = pgTable("gallery_photos", {
  // … existing columns …
  // Null means storageKey holds the deliverable, as today.
  driveFileId: text("drive_file_id"),
});
```

Make `storageKey` nullable only if you want Drive-only photos with no preview.
Recommended: always keep a preview in GCS so browsing never touches Drive.

### Where it plugs in

One place, because Usena already funnels client image reads through a single
route — `server/galleryRoutes.ts:1228`, `GET /api/g/:slug/image/:photoId`:

```ts
// Browsing always serves the local preview: never a Drive call per page view.
const file = await objectStorage.getObjectEntityFile(photo.storageKey);
await objectStorage.downloadObject(file, res, 86400);
```

Leave that exactly as it is. Add the Drive branch only on the **download** path,
after the PIN check in `POST /api/g/:slug/download/verify-pin` and wherever the
zip is built. That split is the whole point:

| | Source | Drive calls |
| --- | --- | --- |
| Browsing | GCS preview | **0** |
| Download | Drive original | one per file, once |

### Import

Usena already has `listFilesInFolder()` and `getImageThumbnails()`. What it needs
is the resize step. Two options, and the second is better:

1. Server-side with `sharp`. Usena is a normal Node app with dependencies, so
   unlike this repo that is allowed. Straightforward, costs CPU on Replit.
2. In the browser, which is what this app does — the admin page pulls the
   original through an admin-only proxy, scales it on a canvas, and uploads only
   the scaled result. Usena already has Uppy; a preprocessor plugin fits here.
   Costs the server no CPU at all.

Either way: **always downscale on import.** Storing the Drive original in GCS
recreates the duplication this is meant to remove.

### Do not hand Drive URLs to the browser

A Drive link that works in a browser works for anyone who has it. If the page
carries one, the gallery's PIN is decorative. Fetch server-side, always.

This repo has a test that greps the entire client payload for Drive file ids and
Google URLs (`test/driveflow.mjs`). Port that test. It is exactly the kind of
property that breaks silently in a refactor six months from now.

---

## Gap 3 — copy filenames in Lightroom format

Usena has CSV export (`galleryRoutes.ts:736`). What is missing is the one-click
string you paste into Lightroom's filter:

```
_MG_1613, _MG_1621, _MG_1626, _MG_1651, _MG_1705
```

Reference implementation is `pickedNames()` in `public/admin.js`. Three details
that matter and are easy to miss:

- **strip the extension** — `_MG_1613.CR2` becomes `_MG_1613`
- **de-duplicate** — the same frame picked in two sets appears once
- **stable order** — sort by selection time, not by however the rows came back

---

## The release gate (optional, recommended)

Also in this repo, and worth taking: downloads stay shut until the studio
releases the gallery. Per-gallery trigger, one of:

- `always` — no release step. **Make this the default** so existing galleries
  keep working unchanged.
- `manual` — a switch in the app. Nothing in Drive is made public.
- `drive-public` — follows the Drive folder's sharing state, via the
  `checkFolderIsPublicLink()` Usena already has.

**It must fail closed.** When Google will not report a folder's sharing state,
that is *unknown*, not *private* — return null and treat it as locked, but tell
the client "try again shortly" rather than "these photos have not been
released". Those are different facts. See `releaseState()` in `lib/api.js` and
`test/release.mjs`.

Note that in Usena the `manual` trigger is strictly better than `drive-public`:
downloads already go through the app, so making the Drive folder public unlocks
nothing technically — it only creates a public link that exists whether or not
anyone is sent it.

---

## Worth keeping from this repo regardless

The tests, as specifications. They encode properties that are easy to state and
easy to break:

| File | Property |
| --- | --- |
| `test/driveflow.mjs` | No Drive id reaches the client. Browsing makes zero Drive calls. Only previews on disk. A Drive outage never yields a complete-looking but short zip. |
| `test/release.mjs` | Unknown sharing state fails closed. Galleries with no delivery configured are unaffected. |
| `test/drive.mjs` | Service-account auth, against a fake Google that verifies the signature with a real key. |
| `test/migrate.mjs` | A schema migration that keeps old share links working. |

`test/helpers/fakedrive.mjs` is portable as-is and needs no Google account, no
network and no credential in CI.
