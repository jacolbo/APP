# Pose Board

A small self-hosted web app for client galleries: you upload images into folders,
your client opens a private link, hearts the ones they want, and sends the
shortlist straight back to you.

Two sides, one server:

- **Studio** (`/`) — password protected. Build folders (nested as deep as you
  like), give each one tabs, drop images in, set a download PIN, publish, and
  share the link.
- **Gallery** (`/g/<link>`) — no account, no app. Your client browses, taps to
  favourite, types the PIN to download, and presses **Send to photographer**.

It has **no npm dependencies** — only Node's built-in modules — so there is
nothing to build, no native packages to compile, and nothing to break on a
version bump.

## How it is organised

```
Smith Wedding                folder — publishable, has its own link and PIN
├── Previews         tab     open to anyone with the link, no downloads
├── Final images     tab     🔒 hidden until the PIN is entered, downloadable
└── Ceremony                 folder inside a folder, nested up to 20 levels
    ├── Previews     tab
    └── Final images tab
```

**Tabs are what decide whether an image is a preview or a deliverable.** A tab is
either open to anyone holding the link, or locked behind the gallery PIN — and
separately, downloadable or not. A locked tab is not merely greyed out: its
images are left out of the page entirely until the PIN is accepted.

Any folder at any depth can be published with its own link, so you can share a
whole wedding or just the ceremony.

## Quick start

```bash
git clone <this repo>
cd APP
ADMIN_PASSWORD="something-only-you-know" npm start
```

Then open <http://localhost:4000> and sign in with that password.

Built and tested on Node 22. It uses only built-in modules, so Node 18.17+ should
work, but that older floor is declared rather than tested here.

## How you'd actually use it

1. **New folder** — one per shoot or client. It arrives with two tabs ready:
   *Previews* (open, no downloads) and *Final images* (PIN-only, downloadable).
2. **Drop images in** — pick a tab, then drag a pile of images onto the drop
   zone. JPEG, PNG, WebP, GIF, AVIF and HEIC are accepted. **You resize before
   uploading** — the app never re-processes your files on the server.
3. **Add folders inside** if a shoot has parts ("Ceremony", "Reception"). Each
   one has its own tabs and can be published on its own link.
4. **Set a download PIN** in *Settings*. Without one, nothing downloads and
   PIN-only tabs stay shut — the app fails closed rather than falling open.
5. **Set where selections go** — a webhook URL in *Settings*, or `WEBHOOK_URL`
   for every folder at once.
6. **Publish and share** — flip *Gallery is live*, copy the link, send it.
7. **Read their picks** — hearts show up on your tiles and a panel at the bottom
   lists every pick by client.

Unpublishing takes the link offline immediately. **Reset share link** (in
Settings) issues a new link and permanently kills the old one.

## Configuration

All optional except the password.

| Variable | Default | What it does |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `changeme` (dev only) | Your studio password. **Required** when `NODE_ENV=production` — the server refuses to start without it. |
| `PORT` | `4000` | Port to listen on. |
| `HOST` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` behind a reverse proxy. |
| `DATA_DIR` | `./data` | Where photos and `db.json` are stored. |
| `MAX_UPLOAD_MB` | `25` | Per-image upload limit. Larger files are resized in the browser before upload. |
| `WEBHOOK_URL` | none | Default address for **Send to photographer**. A folder can override it. The server refuses to start if this is not a valid http(s) URL. |
| `WEBHOOK_SECRET` | none | When set, each webhook carries `X-Signature: sha256=<hmac of the body>` so your endpoint can verify it. |

## Your data

Everything lives in `DATA_DIR` (`./data` by default):

```
data/
  db.json        folders, tabs, image metadata, client selections
  db.json.v1.bak the pre-upgrade file, kept once if you came from an older version
  session.key    key that signs your login cookie (delete it to sign out everywhere)
  files/         the uploaded images, plus a small thumbnail for each
```

**Upgrading from an older Pose Board** needs no action: on first start each
collection becomes a root folder with one open tab, share links and files are
untouched, and the old view-PIN becomes the download PIN (hashed on the way in).
The original file is kept as `db.json.v1.bak`.

**Backing up is copying that folder.** It is plain JSON and ordinary image files —
nothing proprietary. `data/` is gitignored, so your photos never end up in the
repository. Deleting a photo or collection in the app deletes the files from disk
straight away, so keep a backup if you might want them back.

## Running it where clients can reach it

`localhost` only exists on your machine, so to send clients a link the app needs
a host that is always on and gives it a **persistent disk** for the photos.

**[docs/DEPLOY.md](docs/DEPLOY.md) walks through four ways to do that** — Render
(no command line needed), Fly.io, your own server with Docker, or plain Node
behind systemd — including backups, updates and troubleshooting. The config each
one needs is already in the repo:

```
Dockerfile                 runs the app as an unprivileged user, data in /data
render.yaml                Render blueprint: web service + 10 GB disk
fly.toml                   Fly.io: volume mount, health check, HTTPS
deploy/poseboard.service   systemd unit for a plain VPS
deploy/Caddyfile           HTTPS + upload size limit in front of the app
```

Whichever you choose, the app speaks plain HTTP and must sit behind something
that terminates TLS, so the links you send are `https://`. It sets the `Secure`
flag on the login cookie automatically when it sees `X-Forwarded-Proto: https`,
so pass that header through.

## Sending selections to your software

When a client presses **Send to photographer**, the server POSTs JSON to the
folder's webhook URL (or `WEBHOOK_URL`):

```json
{
  "galleryId": "fld_xxxxxxxxxxxx",
  "galleryTitle": "Smith Wedding",
  "clientName": "Ana",
  "total_selected": 2,
  "selected_files": ["IMG_0041.jpg", "IMG_0052.jpg"],
  "selections": [
    { "imageId": "img_…", "fileName": "IMG_0041.jpg",
      "folderPath": "Smith Wedding / Ceremony", "tab": "Final images", "note": "" }
  ],
  "sentAt": "2026-01-01T12:00:00.000Z"
}
```

**Only HTTP 200 counts as delivered.** A 201, a redirect, a timeout (10s) or an
unreachable host all show the client an error saying nothing was sent — they are
never told it worked when it did not. There is no automatic retry; the client can
press the button again, and a silent retry risks you seeing the same selection
twice. Handoffs are rate limited to 6 per 15 minutes per client.

## What the security actually is

Stated plainly, so you can decide what to put in it:

- **One password for the studio side.** Compared in constant time, a signed
  cookie keeps you signed in for 14 days, and failed sign-ins from one address
  are throttled (8 tries per 15 minutes). There are no user accounts and no
  password reset — you set it with an environment variable.
- **Share links are unguessable, not secret.** Each link holds a random 96-bit
  id. Nobody will guess one, but anyone who *has* one can open a published
  gallery, and can forward it. Reset the link if that matters.
- **Client payloads never contain a file path.** Every image is served through an
  opaque `/i/`, `/t/` or `/d/` route keyed by id. Nothing under `DATA_DIR` is
  reachable by path, and no stored filename appears in any response.
- **A PIN-only tab is absent, not hidden.** Its image ids and URLs are not in the
  page load at all, so there is nothing in the HTML to dig out. Only after the
  PIN is accepted does a second request return them.
- **Downloads always require the PIN.** Entering it mints a 15-minute,
  HMAC-signed, HttpOnly cookie scoped to one folder subtree. With no PIN set,
  nothing unlocks and nothing downloads — it fails closed.
- **PINs are stored as scrypt hashes**, never in the clear, and guessing is rate
  limited to 8 tries per 15 minutes per gallery per address. Be clear-eyed about
  the limit: a 4-digit PIN is 10,000 possibilities, so if `db.json` itself leaks
  the hash gives way quickly. The rate limit is the real protection, and the PIN
  is "keeps the wrong client out", not "keeps an attacker out".
- **A client who has downloaded a file can re-share it.** Nothing here stops
  that, and nothing can.
- **Images in an open tab of a published folder are readable by anyone with the
  image URL** — an unguessable id, not listed anywhere. Draft folders are only
  readable while signed in, and a draft folder hides everything beneath it.
- **Client selections are not authenticated.** A client is remembered by a random
  id in their browser's local storage. Anyone with the link can heart an image.
  It is a shortlisting tool, not a signature.
- **No HTTPS on its own.** Without a proxy in front, the password and PIN travel
  in the clear. Don't skip the TLS step.
- **No antivirus/content scanning** of uploads, and no EXIF stripping — files are
  stored as you uploaded them (location data included, if your camera wrote it).

This is a single-studio tool. It is not hardened for hostile traffic on the open
internet, and `db.json` is a JSON file held in memory by one process, not a
concurrent database — fine for one person and thousands of images, not for a
multi-tenant service.

## Tests

```bash
npm test          # 85 API checks + 17 migration checks — starts its own server
npm run test:ui   # 34 browser checks — needs Playwright
```

`npm test` covers auth, the folder tree (including the depth cap and the
cannot-move-a-folder-inside-itself rule), tabs, uploads, publishing, favourites,
the PIN gate, downloads and the handoff webhook — the last against a real local
HTTP receiver, not a stub. It asserts directly that a locked tab's image ids
never appear in a page load. A second suite migrates a real v1 `db.json` and
checks the old share link, files and picks all survive.

Point it at a deployed instance to check a fresh install (it creates and deletes
a test folder):

```bash
BASE=https://your-app-url ADMIN_PASSWORD=your-password npm test
```

The browser suite drives the actual UI in Chromium — sign in, build a nested
folder, upload real images into two tabs, publish, then open the gallery as a
client: favourite, refresh to prove it persisted, hit the PIN gate with a wrong
then a right PIN, download a file, hand the selection over, and confirm a failing
webhook never claims success. It also checks the phone layout. It skips itself
with a note if Playwright is not installed:

```bash
npm install --no-save playwright && npx playwright install chromium
npm run test:ui            # SHOTS=/tmp/shots npm run test:ui  keeps screenshots
```

## How it fits together

```
server.js               HTTP server: static files, image routes, shutdown
lib/api.js              every /api route, upload handling, access control
lib/store.js            folder tree, JSON store, atomic writes, v1 migration
lib/auth.js             signed session cookies, login throttle
lib/pin.js              scrypt hashing and constant-time checking of PINs
lib/grant.js            short-lived signed download grants
lib/webhook.js          the handoff POST
lib/util.js             request/response helpers, input trimming
public/index.html+js    the studio
public/gallery.html+js  the client gallery
public/app.css          one stylesheet for both
test/                   API, migration and browser suites
```

Design notes worth knowing if you change things:

- **Uploads are raw bodies, not multipart.** The browser sends the image bytes as
  the request body with the filename in a header, so the server never parses a
  multipart form.
- **Thumbnails are made in the browser** with a canvas and uploaded alongside the
  original. That is why the server needs no image library. If a browser cannot
  decode a format (HEIC outside Safari, for example), the upload still succeeds
  and the grid falls back to the full-size image.
- **Nothing is resized on the server.** You decide what a preview is by which tab
  you put it in.
- **Folder depth is capped at 20.** Not because the schema needs it — tree walks
  recurse, breadcrumbs have to render, and the whole dataset lives in memory.
  Change `MAX_DEPTH` in `lib/store.js` if you truly need more.
