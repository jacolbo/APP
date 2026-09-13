# Pose Board

A small self-hosted web app for pose references: you upload your pose ideas into
collections, and your clients open a private link to browse them and heart the
ones they want.

Two sides, one server:

- **Studio** (`/`) — password protected. Create collections, drag photos in, add
  a title/notes/tags to each pose, set the order, publish, and share the link.
- **Gallery** (`/s/<link>`) — no account, no app. Your client opens the link,
  browses full-screen, hearts the poses they like and can leave a note on each
  one. You see every pick back in the studio.

It has **no npm dependencies** — only Node's built-in modules — so there is
nothing to build, no native packages to compile, and nothing to break on a
version bump.

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

1. **New collection** — one per shoot, client, or style ("Maternity — golden
   hour", "Sarah & Tom", "Studio headshots"). The intro note you write here is
   shown at the top of your client's gallery.
2. **Drop photos in** — drag a pile of images onto the drop zone, or use *Choose
   files*. JPEG, PNG, WebP, GIF, AVIF and HEIC are accepted.
3. **Annotate** — click a pose to add a title ("Hands in pockets, looking away"),
   notes for the shoot, and tags. Drag tiles to set the order your client sees,
   and mark one as the cover.
4. **Publish and share** — flip *Gallery is live*, copy the link, send it. Add a
   PIN in **Settings** if you want a second gate.
5. **Read their picks** — hearts show up on your tiles, and a panel at the bottom
   of the collection lists every pick by client, with their notes. *Only client
   picks* filters the grid down to the shortlist.

Unpublishing a collection takes the link offline immediately. **Reset share link**
(in Settings) issues a new link and permanently kills the old one — useful if a
link went to the wrong person.

## Configuration

All optional except the password.

| Variable | Default | What it does |
| --- | --- | --- |
| `ADMIN_PASSWORD` | `changeme` (dev only) | Your studio password. **Required** when `NODE_ENV=production` — the server refuses to start without it. |
| `PORT` | `4000` | Port to listen on. |
| `HOST` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` behind a reverse proxy. |
| `DATA_DIR` | `./data` | Where photos and `db.json` are stored. |
| `MAX_UPLOAD_MB` | `25` | Per-photo upload limit. Larger files are resized in the browser before upload. |

## Your data

Everything lives in `DATA_DIR` (`./data` by default):

```
data/
  db.json        collections, photo metadata, client picks
  session.key    key that signs your login cookie (delete it to sign out everywhere)
  files/         the uploaded images, plus a small thumbnail for each
```

**Backing up is copying that folder.** It is plain JSON and ordinary image files —
nothing proprietary. `data/` is gitignored, so your photos never end up in the
repository. Deleting a photo or collection in the app deletes the files from disk
straight away, so keep a backup if you might want them back.

## Running it where clients can reach it

The app speaks plain HTTP. **Put it behind something that terminates TLS**
(Caddy, nginx, a Cloudflare tunnel, Fly.io, a Render/Railway app) so links you
send are `https://`. The server sets the `Secure` flag on the login cookie
automatically when it sees `X-Forwarded-Proto: https`, so pass that header through.

A minimal Caddy config:

```
poses.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

Run it with `HOST=127.0.0.1 NODE_ENV=production ADMIN_PASSWORD=... npm start`, and
keep it alive with systemd, pm2, Docker — whatever you already use.

## What the security actually is

Stated plainly, so you can decide what to put in it:

- **One password for the studio side.** It is compared in constant time, a signed
  cookie keeps you signed in for 14 days, and failed sign-ins from one address
  are throttled (8 tries per 15 minutes). There are no user accounts and no
  password reset — you set it with an environment variable.
- **Share links are unguessable, not secret.** Each link holds a random 96-bit id.
  Nobody will guess one, but anyone who *has* one can open a published gallery,
  and can forward it. Reset the link if that matters.
- **The PIN is a light second gate**, not real authentication. It is sent in a
  request header (so it stays out of access logs), but it is a short number and
  it is not rate-limited. Treat it as "keeps the wrong client out", not "keeps an
  attacker out".
- **Photos in a published collection are readable by anyone with the photo's URL**
  — again an unguessable id, and not listed anywhere. Photos in a draft
  collection are only readable while signed in.
- **Client picks are not authenticated.** A client is remembered by a random key
  in their browser's local storage and types their own name. Anyone with the link
  can heart a pose under any name. It is a shortlisting tool, not a signature.
- **No HTTPS on its own.** Without a proxy in front, the password and PIN travel
  in the clear. Don't skip the TLS step.
- **No antivirus/content scanning** of uploads, and no EXIF stripping — files are
  stored as you uploaded them (location data included, if your camera wrote it).

This is a single-photographer tool. It is not hardened for hostile traffic on the
open internet, and `db.json` is a JSON file, not a concurrent database — fine for
one person and thousands of photos, not for a multi-tenant service.

## Tests

```bash
npm test        # 54 API checks — starts its own server, no dependencies
npm run test:ui # 33 browser checks — needs Playwright
```

`npm test` covers auth, uploads, access control, ordering, sharing, PINs, picks
and deletion, against a real server on a temporary data directory.

The browser suite drives the actual UI in Chromium — sign in, upload three real
images, edit a pose, publish, open the gallery as a client, heart poses, leave a
note, the PIN gate, and the phone layout. It skips itself with a note if
Playwright is not installed:

```bash
npm install --no-save playwright && npx playwright install chromium
npm run test:ui            # SHOTS=/tmp/shots npm run test:ui  keeps screenshots
```

## How it fits together

```
server.js              HTTP server: static files, image routes, shutdown
lib/api.js             every /api route, upload handling, access control
lib/store.js           JSON store + atomic writes + file management
lib/auth.js            signed session cookies, login throttle
lib/util.js            request/response helpers, input trimming
public/index.html+js   the studio
public/share.html+js   the client gallery
public/app.css         one stylesheet for both
test/                  API and browser suites
```

Two design notes worth knowing if you change things:

- **Uploads are raw bodies, not multipart.** The browser sends the image bytes as
  the request body with the filename in a header, so the server never parses a
  multipart form.
- **Thumbnails are made in the browser** with a canvas and uploaded alongside the
  original. That is why the server needs no image library. If a browser cannot
  decode a format (HEIC outside Safari, for example), the upload still succeeds
  and the grid falls back to the full-size image.
