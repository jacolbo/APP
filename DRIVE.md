# Delivering from Google Drive

You already put finished photos in Drive. This lets the gallery deliver them
without you uploading everything a second time, and without your clients ever
seeing Drive's interface.

## What actually happens

When you import a Drive folder:

- a **preview** of each photo is made in your browser and stored on the server
- the **original stays in Drive** — it is never copied to the server's disk
- the image row remembers which Drive file it came from

When a client browses the gallery they are served the local previews, so the
gallery is exactly as fast as it was before and **Drive is not called at all**.
Only when a client enters the PIN and downloads does the server fetch the
originals from Drive and stream them into the zip.

```
import   Drive ──▶ server ──▶ your browser ──▶ (scaled preview) ──▶ server
browse                                          preview ──▶ client
download Drive ──▶ server ──▶ zip ──▶ client        (only after the PIN)
```

Two consequences worth knowing up front:

- **Delete a photo in Drive and its download breaks.** The gallery will still
  show the preview, but the zip will fail for that file. Drive is the source of
  truth for originals; treat those folders as delivery archives, not scratch
  space.
- **Download bandwidth passes through your server**, twice over: Drive to the
  server, server to the client. That is the price of keeping the PIN gate real.
  See "Why not just share the Drive link" below.

## One-time setup

You need a **service account** — a Google identity that belongs to the app
rather than to you. It has no password, no inbox, and no login. You share a
Drive folder with its email address exactly as you would with a person.

I'd rather be straight with you about confidence here: the steps below are the
right shape, but **Google renames things in their console regularly, so the
exact button labels may differ from what you see.** The underlying concepts —
project, enabled API, service account, JSON key, shared folder — are stable.

1. Go to <https://console.cloud.google.com/> and create a project. Any name.
2. Enable the **Google Drive API** for that project (search "Drive API" in the
   console, then Enable).
3. Create a **Service account**. Give it a name; you can skip the optional
   role and user-access steps.
4. Open the service account, go to **Keys**, and add a new key of type
   **JSON**. A `.json` file downloads. Treat it like a password.
5. Copy the service account's email address. It looks like
   `something@your-project.iam.gserviceaccount.com`.
6. In Google Drive, right-click the folder you want to deliver from, choose
   Share, and share it with that email address. **Viewer** access is enough —
   the app only ever reads.

Then give the app the key. Two ways, depending on what your host's settings
panel will accept:

**Either** paste the whole JSON file as one environment variable:

```
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":...}
```

If your panel mangles the newlines inside the key, base64-encode the file first
and paste that instead — the app detects and decodes it:

```sh
base64 -w0 your-key.json
```

**Or** set just the two fields that matter:

```
GOOGLE_CLIENT_EMAIL=something@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----
```

Literal `\n` sequences in the key are converted back to real newlines, because
almost every hosting panel turns them into that.

Restart the app. The **Import from Drive** button next to *+ Add media* will
start working; until then it explains that Drive is not set up.

## Using it

1. Open a folder and pick the tab you want the photos in.
2. Click **Import from Drive**.
3. Paste the Drive folder link and press **Look up**.
4. Untick anything you do not want, then **Import**.

Only image files are listed — PDFs, Google Docs and the rest are filtered out.
Sub-folders are **not** walked: the app has its own folder tree, and quietly
flattening yours would be a surprise. Import sub-folders separately into
whichever tab they belong in.

## Why not just share the Drive link

Because it would make the PIN meaningless. A Drive link that works in a browser
works for **anyone** who has it — forwarded, screenshotted, or guessed from a
shared album. If the page handed out Drive URLs, a client could skip the PIN
entirely, and so could anyone they forwarded the link to.

So the app never sends a Drive URL or even a Drive file id to the browser.
Everything is fetched server-side, after the PIN. There is a test that asserts
no Drive id appears in the client payload, because that is the kind of thing
that breaks quietly.

## If it stops working

The error messages are written to tell you which of these it is:

| What you see | What it means |
|---|---|
| "Google Drive is not set up on this server" | No key in the environment, or the app was not restarted after adding it. |
| "Google denied access. Share the Drive folder with the service account email." | The key is fine; the folder is not shared with the service account. |
| "That Drive folder or file was not found" | Wrong link, or again not shared. Sharing is per-folder. |
| "Google refused the service account credentials" | The key is wrong, truncated, or its newlines were mangled. Re-paste it, base64-encoded. |
| "Google is rate-limiting these requests" | Too many at once. Wait a minute. |

## Limits

- One Drive original is capped at **200 MB** when building a zip.
- The existing archive limits still apply: 2,000 files and 3.5 GB per zip.
- A folder listing reads up to 2,000 files.
- The app only ever **reads** Drive. It cannot modify or delete anything, because
  it asks Google for read-only scope. Even a total compromise of the server
  could not delete your photos.

## What this does not do

- It does not watch Drive for changes. Add photos to Drive later and you import
  them again; nothing syncs by itself.
- It does not import videos or RAW files, only the image formats the gallery can
  display.
- It does not use your personal Google login, so there is no consent screen, no
  "unverified app" warning, and no credential that silently expires.
