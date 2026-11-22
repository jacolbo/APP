# JM Selects

In-studio photo selection for **Jepson Myles Studio**. After a shoot the client sits
with a tablet, browses their photos, hearts and star-rates their favourites, and taps
**I’m done**. Staff then press **Copy list** and paste the file names into Capture One.

- Runs on the studio NAS in Docker. Works on studio Wi-Fi with **no internet**.
- The photos folder is mounted **read-only**: the app cannot change, move or delete photos.
- Shows **JPEGs only**. RAW files have the same base name, so the list matches them in Capture One.

---

## 1. Before you start

You need:

- The NAS (UGOS Pro with the **Docker** app installed).
- This `jm-selects` folder.
- The NAS path of your photos folder, the one that holds the year folders (`2025`, `2026` …).

Folder layout the app expects:

```
Photos/
  2026/
    Week 47 backup/      ← clients' photos live here (these are shown)
      Naidoo Family/     ← one folder per client, holds the JPEGs (+ RAWs)
    Week 47/             ← card copies (ignored by the app)
```

Only week folders whose name **ends in “backup”** are offered when starting a session.

---

## 2. Put the project on the NAS

1. On the studio PC, open the mapped NAS drive in File Explorer.
2. Make a folder for Docker projects if you don’t have one, e.g. `docker`.
3. Copy the whole `jm-selects` folder into it (e.g. `docker\jm-selects`).
   You don’t need the `node_modules`, `dist`, `data` or `sample-photos` folders; skip them if present.

## 3. Fill in the settings (`.env`)

1. In `jm-selects`, copy `.env.example` and name the copy `.env`.
   *Tip: in Notepad use “Save as”, set “Save as type” to **All files**, and type `.env`,
   otherwise Windows saves it as `.env.txt`.*
2. Open `.env` in Notepad and set:

| Setting | What to put |
| --- | --- |
| `STAFF_PIN` | A 4–12 digit PIN for staff. Not `1234`/`0000`. |
| `PHOTOS_PATH` | The photos folder **as the NAS sees it**, e.g. `/volume1/Photos`. In the UGOS Pro **Files** app, open the folder’s properties/details to see its full path. |
| `APP_PORT` | The port tablets will use. `8080` is fine unless something else on the NAS already uses it. |
| `PACKAGE_SIZES` | Your package sizes, e.g. `10,20,30,50`. They become quick buttons; staff can also type any number. |

Leave the rest as they are.

## 4. Deploy in the UGOS Pro Docker app

1. Open **Docker** on the NAS → **Project** → **Create**.
2. Name it `jm-selects`.
3. For the path, choose the `jm-selects` folder you copied. UGOS should pick up the
   `docker-compose.yml` inside it. If it asks you to paste the compose file instead, paste
   the contents of `docker-compose.yml`.
4. Deploy / Start. **The first build needs internet** (it downloads Node and the app’s
   libraries) and takes a few minutes. After that the app needs no internet.
5. When it shows **running**, open `http://192.168.101.153:8080` on the studio PC
   (use your `APP_PORT` if you changed it). You should see the staff PIN screen.

I couldn’t test the UGOS Pro screens themselves. The exact button names may differ
slightly between UGOS versions.

**Read-only check:** the compose file mounts the photos with `:ro`. In the Docker app’s
container details, the `/photos` volume should show as read-only.

## 5. Set up the tablet

1. Join the studio Wi-Fi, open the browser and go to `http://192.168.101.153:8080`.
2. Add it to the home screen:
   - **iPad (Safari):** Share button → **Add to Home Screen**.
   - **Android (Chrome):** ⋮ menu → **Add to Home screen**.
3. Open it from the home-screen icon from now on.

The app runs over plain `http://` on your own network, so Android may add it as a
shortcut that opens in Chrome rather than as a full-screen app. On iPad it opens full screen.

## 6. Everyday use

**Start a session (staff)**
1. Open the app and enter the staff PIN.
2. **New session** → year → week backup → **Start session** next to the client’s folder.
3. Check the client name, choose the package size, then **Start session**.
4. Tap **Hand this tablet to the client**. This signs staff out on the tablet and opens
   the client view. The client sees only their own folder.

**The client**
- Tap a photo to open it full screen; swipe left/right. Tap ♥ to select, tap stars to rate
  (tap the same star again to clear it).
- Filters: All photos / Selected / by stars.
- **Compare**: tap two photos to see them side by side.
- The counter shows “12 of 20 selected”. Going over shows a gentle note but is allowed.
- Every tap saves straight away. If the Wi-Fi drops, the tablet keeps the taps and sends
  them when it reconnects.
- **I’m done** locks the selection.

**Afterwards (staff, on the PC)**
1. Open the session.
2. **Copy list for Capture One**: choose **♥ Hearted** or **★ Stars** (minimum rating),
   with or without the `.jpg` extension, then **Copy list** and paste into Capture One.
3. **Export CSV** gives a spreadsheet of every photo with selected/stars.
4. **Unlock for changes** if the client wants to change something.
   **Reset selections** clears hearts/stars. **Delete session** removes the session.
   Neither touches the photos.

New JPEGs copied into the client’s folder appear within about 5 seconds (or press **Refresh**).

---

## 7. Updating later

1. Replace the files in the `jm-selects` folder on the NAS with the new version.
   **Keep your `.env` file and the `data` folder.**
2. In Docker → Project → `jm-selects`, choose **Rebuild** (or Stop, then build/start again).

Your sessions and selections are in the `data` folder, so they carry over.

## 8. Backups

Everything the app stores is in `jm-selects/data`:
`jm-selects.sqlite` (sessions and selections) and `cache/` (thumbnails, which can be deleted
and are rebuilt automatically). Back up `jm-selects.sqlite` if you want to keep selection history.

## 9. If something goes wrong

| Problem | Fix |
| --- | --- |
| Container stops straight away | Check the project log. “STAFF_PIN must be set” means fix `.env`. “Photos folder not found” means `PHOTOS_PATH` is wrong. |
| Tablet can’t open the page | Same Wi-Fi as the NAS? Right port? Try the address on the PC first. |
| No year folders listed | `PHOTOS_PATH` points at the wrong level; it must be the folder that holds `2025`, `2026` … |
| A week isn’t listed | Its folder name must end in “backup”. |
| “Too many wrong PINs” | Wait 15 minutes (5 wrong tries per device, 30 in total). |
| Thumbnails slow the first time | They’re being made; once made they load instantly. Starting a session makes them in the background. |

---

## Security, plainly

- Photos are mounted read-only. The app only reads JPEGs inside the photos folder; every
  path is checked against that folder (including links pointing elsewhere).
- Staff area needs the PIN. Wrong PINs are rate-limited. The sign-in cookie lasts 12 hours;
  **Lock** signs out.
- A client link (`/c/…`) contains a long random code that can’t be guessed. It shows only that
  client’s JPEGs, never other folders. **Anyone who has the link and is on the studio network
  can open it**, so treat it like a key; deleting the session kills the link.
- It runs over plain `http://` on your local network. Anyone on the same Wi-Fi could
  technically watch the traffic. If you have a guest Wi-Fi for visitors, keep it separate
  from the network the NAS is on.
- The container runs as a normal user with a read-only system, no extra privileges.
- Not built for exposure to the internet. Don’t forward the port on the router.

---

## For developers

TypeScript throughout: Express + better-sqlite3 + sharp on the server, React (Vite) front end.

```
server/        API, path safety, JPEG listing, image cache, PIN auth, SQLite
web/           React app (client screen, staff screens), PWA manifest + icons
test/          unit + API tests (vitest), browser end-to-end run (Playwright)
scripts/       sample-folder generator, icon generator
```

Run locally (Windows PowerShell, Node 22 installed):

```powershell
npm install
npm run build
node scripts/make-sample.mjs sample-photos 60
$env:STAFF_PIN="482916"; $env:PHOTOS_ROOT="$PWD\sample-photos"; $env:DATA_DIR="$PWD\data"; npm start
```

Then open <http://localhost:8080>. To point at the real photos read-only, set
`PHOTOS_ROOT` to the mapped drive (e.g. `Z:\Photos`). The app never writes there, but
Windows can’t enforce read-only for a local run the way Docker’s `:ro` does.

Tests:

```bash
npm test                     # 72 unit + API tests (path safety, JPEG filter, copy list, API)
BASE=http://localhost:8080 PIN=482916 node test/e2e.mjs   # browser run; needs Playwright installed
```
