# Putting Pose Board online

Running it on your own computer is fine for trying it out, but `localhost` only
exists on your machine — a client clicking that link gets nothing. To send real
links you need it hosted somewhere always-on.

**The one thing that matters:** your photos are files on disk, so the host must
give the app a **persistent disk** (also called a volume). Hosts that reset the
filesystem on every restart or deploy will silently delete your library. Every
option below uses a real volume.

You will also set one secret, `ADMIN_PASSWORD`. The app refuses to start in
production without it, so there is no way to accidentally publish a site whose
password is "changeme".

| Option | Command line needed? | Good when |
| --- | --- | --- |
| [Render](#option-a--render-no-command-line) | No | You want to click through a web dashboard. **Start here.** |
| [Fly.io](#option-b--flyio-command-line) | Yes | You're comfortable in a terminal and want fine control. |
| [Your own server, Docker](#option-c--your-own-server-with-docker) | Yes | You already have a VPS. |
| [Your own server, no Docker](#option-d--your-own-server-without-docker) | Yes | You want plain Node + systemd. |

This repo already contains the config each one needs: `render.yaml`, `fly.toml`,
`Dockerfile`, `deploy/poseboard.service` and `deploy/Caddyfile`.

---

## Option A — Render (no command line)

1. Create an account at [render.com](https://render.com) and connect your GitHub
   account so it can see `jacolbo/APP`.
2. **New → Blueprint**, pick the `jacolbo/APP` repository. Render finds
   `render.yaml` in the repo and shows a service called **pose-board**.
3. It will ask you for **ADMIN_PASSWORD** — this is the password you'll use to
   sign in to the studio. Pick a strong one; you can change it later in the
   service's Environment settings.
4. Apply the blueprint. The first build takes a few minutes (it builds the
   Docker image).
5. When it goes live, Render shows a URL like
   `https://pose-board-xxxx.onrender.com`. That's your app. Open it, sign in
   with your password, and everything else happens inside the app.
6. Optional: add your own domain (e.g. `poses.yourstudio.com`) under the
   service's **Settings → Custom Domains**.

What `render.yaml` sets up for you: a Docker web service, a 10 GB disk mounted
at `/data` for photos, a health check on `/health`, and auto-deploy when the
branch changes.

Worth knowing, from Render's own docs:

- **A persistent disk requires a paid instance type.** Free instances cannot
  have disks, and without a disk your photos would not survive a restart. The
  blueprint requests the smallest paid size (`0.5c-512mb`); check Render's
  current pricing yourself before applying.
- **A service with a disk runs as a single instance and cannot autoscale.**
  That's correct for this app — one instance owns the photo library.
- **Deploys have a few seconds of downtime** (Render stops the old instance
  before starting the new one, to protect the disk). Harmless here.

If you later rename the branch or merge to `main`, update the `branch:` line in
`render.yaml` to match, or change it in the service settings.

---

## Option B — Fly.io (command line)

```bash
# one-time: install flyctl from https://fly.io/docs/flyctl/install/ then
fly auth login

git clone -b claude/photo-pose-upload-app-7gnots https://github.com/jacolbo/APP.git
cd APP

# Pick your own app name and nearest region; keeps the committed fly.toml.
fly launch --no-deploy --copy-config

# The photo library. 10 GB is a lot of pose references; size it as you like.
fly volumes create pose_data --size 10

fly secrets set ADMIN_PASSWORD="your-password"
fly deploy
fly open
```

Two Fly-specific points:

- **Keep this app on exactly one machine** (`fly scale count 1`). Each machine
  gets its own volume, so a second machine would serve a second, empty library.
- `auto_stop_machines = "stop"` in `fly.toml` lets the machine sleep when nobody
  is looking at a gallery and wake on the next request. That saves money but
  adds a short delay on the first click. Set `min_machines_running = 1` if you'd
  rather it always be warm.

---

## Option C — Your own server with Docker

```bash
git clone -b claude/photo-pose-upload-app-7gnots https://github.com/jacolbo/APP.git
cd APP
docker build -t pose-board .

docker volume create pose-data

docker run -d --name pose-board \
  --restart unless-stopped \
  -p 127.0.0.1:4000:8080 \
  -e ADMIN_PASSWORD="your-password" \
  -v pose-data:/data \
  pose-board
```

The container listens on 8080 internally; this maps it to port 4000 on the
server's loopback interface only, so it is not exposed to the internet directly.
Put Caddy (or nginx) in front for HTTPS — see `deploy/Caddyfile`, which also
raises the request body limit so large photos can be uploaded:

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain first
sudo systemctl reload caddy
```

The image runs the server as an unprivileged user and handles volume ownership
itself, so there is nothing else to configure.

---

## Option D — Your own server without Docker

Node 18.17+ is the only requirement — there are no dependencies to install.
`deploy/poseboard.service` is a ready systemd unit; its header comments contain
the exact commands (create a user, clone to `/opt/pose-board`, put
`ADMIN_PASSWORD` in `/etc/pose-board.env`, enable the service). Then put Caddy
in front exactly as in Option C.

```bash
sudo systemctl status poseboard      # is it running?
sudo journalctl -u poseboard -f      # live logs
```

---

## Once it's live

1. Open your URL and sign in with `ADMIN_PASSWORD`.
2. Create a folder, drop some images into a tab, set a download PIN.
3. Flip **Gallery is live**, copy the link, and open it in a private window to
   see exactly what your client sees.

To check a fresh deployment end to end from your own machine:

```bash
BASE=https://your-app-url ADMIN_PASSWORD=your-password npm test
```

That runs the same 54 checks against the live instance. It creates a test
folder and deletes it again — run it on a fresh deployment, not on a library
full of real work.

## Backups

Everything you care about is in the `/data` volume: `db.json`, `session.key` and
`files/`. Copy that folder somewhere safe on a schedule you're comfortable with.

- **Fly:** `fly ssh sftp get /data/db.json` for the database, or
  `fly ssh console -C "tar czf - /data" > pose-backup.tar.gz` for everything.
- **Render:** paid services have a **Shell** tab in the dashboard you can use to
  inspect `/data`; Render also offers disk snapshots on supported plans. Check
  what your plan includes rather than assuming.
- **Your own server:** `rsync -av /var/lib/pose-board/ backup-host:/backups/` or
  `docker run --rm -v pose-data:/data -v "$PWD:/out" alpine tar czf /out/pose-backup.tar.gz /data`.

Restoring is copying the folder back and restarting.

## Updating later

Render deploys automatically when the branch changes (`autoDeploy: true`). On
Fly, run `fly deploy` again. On your own server, `git pull` then restart the
service or rebuild the image. Your `/data` volume is untouched by updates.

## When something goes wrong

| Symptom | Cause and fix |
| --- | --- |
| Logs say `Refusing to start: set ADMIN_PASSWORD` | The secret isn't set on the host. Add it and redeploy — this is the safety check working. |
| Photos disappeared after a deploy | No persistent disk mounted, or `DATA_DIR` doesn't point at it. Check the volume is mounted at `/data` and `DATA_DIR=/data`. |
| Large uploads fail with 413 | Something in front of the app caps request size. Raise it in your proxy (`request_body max_size` in Caddy, `client_max_body_size` in nginx). Cloudflare's free plan also caps uploads. Or lower `MAX_UPLOAD_MB`. |
| A client says the link doesn't work | The folder is a draft, or the link was reset. Check the **Gallery is live** switch, then copy the link again. |
| A client can't download | No download PIN is set on the folder (or any folder above it). Set one in **Settings** — without a PIN nothing downloads, by design. |
| No **Send to photographer** button | No webhook URL is set on the folder and no `WEBHOOK_URL` on the server. |
| You forgot the password | Change `ADMIN_PASSWORD` on the host and redeploy. Nothing in your library is lost. |
| Everyone got signed out | `session.key` was recreated, which means the data volume was replaced. Sign in again — but check that the volume is really persisting. |
