# JM Selects

In-studio photo selection for **Jepson Myles Studio**. After a shoot the client sits
with a tablet, browses their photos, hearts and star-rates their favourites, and taps
**I’m done**. Staff then press **Copy list** and paste the file names into Capture One.

- Runs on the studio NAS in Docker. Works on studio Wi-Fi with **no internet**.
- The photos folder is mounted **read-only**: the app cannot change, move or delete photos.
- Shows **JPEGs only**. RAW files have the same base name, so the list matches them in Capture One.
- When the client taps **I’m done**, the matching RAW files are **copied** into a project folder
  (`<Projects>/<year>/<week>/<client name>/`) ready for Capture One. Originals are never moved,
  renamed or deleted, and nothing is ever overwritten.

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
| `PROJECTS_PATH` | The folder the RAW copies go into, **as the NAS sees it**, e.g. `/volume1/Projects/JM Selects`. Create it from the studio PC first (see **Folder permissions** below). |
| `APP_PORT` | The port tablets will use. `8080` is fine unless something else on the NAS already uses it. |
| `EXTRA_IMAGE_PRICE` | Price per extra picture beyond the package, in whole rand (default `250`). Staff can change it per session. |
| `PACKAGE_SIZES` | Your package sizes, e.g. `10,20,30,50`. They become quick buttons; staff can also type any number. |
| `WIFI_SSID` | The studio Wi-Fi name, exactly as phones see it, in single quotes: `WIFI_SSID='Jepson Myles Studio'`. |
| `WIFI_PASSWORD` | The studio Wi-Fi password, **in single quotes**: `WIFI_PASSWORD='your password'`. Without quotes, a password containing `$`, `#` or spaces gets cut short and the QR code won’t connect. (If the password itself contains a `'`, ask me.) |
| `PUBLIC_URL` | The address phones use to open the app: `http://192.168.101.153:8080` (use your `APP_PORT`). It goes inside the session QR codes. |

Leave the rest as they are.

**Phones must be on the studio Wi-Fi.** The app only exists on your studio network, with no
internet involved, so a phone on mobile data, or on a Wi-Fi network that can’t reach the NAS at
`192.168.101.153`, can’t open it. That’s why the QR sheet has two steps: Wi-Fi first, then the
gallery. *Note:* many routers’ “guest” networks are deliberately cut off from the NAS; if you
use one for clients, check a phone on it can open `http://192.168.101.153:8080` first.

## Folder permissions (read this once)

The app runs as an ordinary NAS user, never as administrator ("root"). It needs to be able
to write to two folders: its own **data** folder and the **projects** folder. If Docker has to
create a missing folder itself, Docker makes it owned by the administrator, and the app can’t
write there. That is what causes **“unable to open database file”**.

The simple fix is to **create both folders yourself from your computer** (Finder on the Mac,
or File Explorer on a PC, on the mounted NAS share) *before* deploying:

1. Inside the `jm-selects` folder on the NAS, create a folder called **`data`**.
2. Create the projects folder, e.g. a folder **`JM Selects`** inside your **`Projects`** share.
   Use that folder’s NAS path for `PROJECTS_PATH`.

Folders you create from your computer belong to your NAS user. When the app starts, it checks who
owns the projects folder and runs as that same user. That means:
- it can write its copies there, and
- the copied RAWs belong to you, so Capture One on the PC can open and work with them.

The app also hands its own `data` folder to that user automatically, so an old
administrator-owned `data` folder is fixed on the next start. (If you already ran
`chmod 777` on `/Volumes/docker/jm-selects/data` from the Mac, that's fine. Leave it.)

**If the projects folder still isn’t writable** (the staff screen says “The app cannot
write to the projects folder”, and the container log says the same): in the UGOS Pro
**Files** app, right-click the projects folder → permissions, and give your user (or
“Everyone”) **read & write**. Then restart the project. *I couldn’t see the UGOS Pro
permission screens, so the wording there may differ.*

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
3. Check the client name, choose the package size, check the **extra picture price**
   (pre-filled from `EXTRA_IMAGE_PRICE`, change it for this client if needed), then **Start session**.
4. Make sure the **client name is their full name, exactly as booked** (e.g. *Thandi Nkosi*,
   not *Nkosi family*). Clients type it on their phones to get in.
5. Choose how they’ll look at their photos:
   - **Hand this tablet to the client**: signs staff out on the tablet and opens the client
     view straight away (no name needed, because you’re handing it over).
   - **Show QR code**: shows two codes for their phone.
     **Step 1** joins the studio Wi-Fi. **Step 2** opens this client’s gallery. The first time,
     the phone asks for their full name. Capitals, extra spaces and accents don’t matter
     (*thandi  NKOSI* and *Thandi Nkosi* both work). After that the phone remembers them.
   You can do both: the client on the tablet and their partner on a phone. Everyone sees the same
   selections, updated live.

**Who’s connected (staff, on the session screen)**
- **Connected devices** lists every tablet/phone in the session, with a green dot while it’s open.
- **Remove** shuts that device out immediately.
- **Show QR code → New QR code** makes a fresh link. The old link and code stop working at once,
  and every phone has to scan the new code and type the name again. Use this if a code was
  photographed or shared by mistake.
- After **5 names that don’t match**, the link locks and the phone says *“Please ask the
  studio”*. Check the client name on the session, then press **Allow new attempts**.

**Wi-Fi poster for the wall**
- Staff screen → **Wi-Fi poster** → **Print**. It’s in the Jepson Myles style, with the Wi-Fi QR
  code and network name. The password is never printed as text.

**The client**
- Tap a photo to open it full screen; swipe left/right. Tap ♥ to select, tap stars to rate
  (tap the same star again to clear it).
- Filters: All photos / Selected / by stars.
- **Compare**: tap two photos to see them side by side.
- Works on phones as well as the tablet (two photos per row on a phone; tap a photo for full screen).
- The top of the screen always shows, live: **“23 selected · 20 included · 3 extra · R750”**.
- There is no limit. The first time a client goes past their package they see one gentle
  note: *“You’ve chosen more than your package includes – extra pictures are R250 each.”*
  (using that session's price). It doesn't appear again on that tablet for that session.
- Every tap saves straight away. If the Wi-Fi drops, the tablet keeps the taps and sends
  them when it reconnects.
- **I’m done** locks the selection.

**RAW project folder (automatic)**
- When the client taps **I’m done**, the app looks for the RAW file that matches each
  **hearted** photo (same file name, any RAW type: .CR3, .CR2, .NEF, .ARW, .RAF, .DNG …,
  upper or lower case), in the client folder **and its subfolders**.
- It **copies** them in the background to `<projects folder>/<year>/<week>/<client name>/`,
  e.g. `Projects/JM Selects/2026/Week 47/Naidoo Family/` (the word “backup” is left off the week).
- The session screen shows progress, then **Done**. Photos with **no matching RAW** are
  listed so you can check them. The session list shows “RAWs copied” / “RAWs: check”.
- Each copy is checked (its size must match the original) before it appears under its real name.
- If the client changes their picks after you **unlock**, press **Re-copy RAWs**. It adds
  the new picks and skips files that are already there. Photos that were *unselected* keep
  their copy in the project folder; delete those yourself if you don’t want them.
- A file that already exists in the project folder is **never overwritten**. If one with the
  same name but a different size is there, it’s left alone and listed as a problem.
- If two RAWs in the client folder have the same name (e.g. one in a subfolder), the one
  next to the JPEG is used.

**Afterwards (staff, on the PC)**
1. Open the session.
2. **Copy list for Capture One**: choose **♥ Hearted** or **★ Stars** (minimum rating),
   with or without the `.jpg` extension, then **Copy list** and paste into Capture One.
3. The session screen shows **selected, included, extra and the extra total**. Use
   **Change package / price** if needed.
4. **Export CSV** gives a spreadsheet: a summary at the top (client, selected, included,
   extra pictures, price each, extra total), then every photo with selected/stars.
5. **Unlock for changes** if the client wants to change something.
   **Reset selections** clears hearts/stars. **Delete session** removes the session.
   Neither touches the photos.

New JPEGs copied into the client’s folder appear within about 5 seconds (or press **Refresh**).

---

## 7. Updating later (redeploying) – from the Mac

Your NAS `docker` share is mounted on the Mac at `/Volumes/docker`, and the app lives in
`/Volumes/docker/jm-selects`. **Your `.env` file and `data` folder stay as they are.**

1. **Download** the new `jm-selects.zip` from Google Drive and double-click it. You get a
   `jm-selects` folder in **Downloads**.
2. **Copy the new files over the old ones.** Don't drag the folder onto the NAS in Finder:
   Finder would *replace the whole folder* and delete your `.env` and `data`. Instead, open
   **Terminal** and paste:
   ```bash
   rsync -av --exclude '.env' --exclude 'data/' ~/Downloads/jm-selects/ /Volumes/docker/jm-selects/
   ```
   This only adds and updates app files. It never deletes anything, and never touches `.env` or `data`.
3. **Add any new settings to `.env`.** Open it with:
   ```bash
   open -e /Volumes/docker/jm-selects/.env
   ```
   Compare it with `.env.example` in the same folder and add the lines you're missing. This
   update needs:
   ```
   PROJECTS_PATH=/volume1/…your projects folder…
   EXTRA_IMAGE_PRICE=250
   WIFI_SSID='Jepson Myles Studio'
   WIFI_PASSWORD='your-wifi-password'
   PUBLIC_URL=http://192.168.101.153:8080
   ```
   Keep the single quotes around the Wi-Fi name and password.
   Save and close TextEdit.
4. **Re-import the compose file.** On this NAS the compose file was imported by hand, so UGOS
   keeps its own copy. In the UGOS Pro **Docker** app: **Project → jm-selects** → edit the
   compose file and replace its contents with the new
   `/Volumes/docker/jm-selects/docker-compose.yml`. If your UGOS version has no edit option,
   delete the *project* (this doesn't delete your files or `data`), then
   **Project → Create → Import docker-compose.yml**, pick the same folder, and import again.
5. **Rebuild:** **Project → jm-selects → Rebuild.** It needs internet for a few minutes.
6. **Sessions already in progress:** tablets that were handed over before this update will
   ask for the client’s name. Either type it, or press **Hand this tablet to the client** again.
7. **Check the log** (Project → jm-selects → container → Log). You should see
   `RAW project copies: /projects (…)` and no “NOT writable” warning. Then open the app on the
   tablet; your sessions are still there.

## 8. Backups

Everything the app stores is in `jm-selects/data`:
`jm-selects.sqlite` (sessions and selections) and `cache/` (thumbnails, which can be deleted
and are rebuilt automatically). Back up `jm-selects.sqlite` if you want to keep selection history.

## 9. If something goes wrong

| Problem | Fix |
| --- | --- |
| Container stops straight away | Check the project log. “STAFF_PIN must be set” means fix `.env`. “Photos folder not found” means `PHOTOS_PATH` is wrong. “Set PROJECTS_PATH” means add it to `.env`. |
| “unable to open database file” / “cannot write to its data folder” | See **Folder permissions**: create the `data` folder from the PC, then Rebuild. |
| RAW copy says “cannot write to the projects folder” | See **Folder permissions**, then press **Re-copy RAWs**. |
| Phone says “can’t reach” / page won’t load | The phone isn’t on the studio Wi-Fi (or is on a guest network that can’t reach the NAS). Scan Step 1 first. |
| QR code opens `localhost` or the wrong address | Set `PUBLIC_URL=http://192.168.101.153:8080` in `.env` and Rebuild. |
| Wi-Fi QR doesn’t connect | Check `WIFI_SSID`/`WIFI_PASSWORD` in `.env` are exact and in single quotes, then Rebuild. |
| “Please ask the studio” on a phone | 5 names didn’t match. Check the session’s client name, then **Allow new attempts**. |
| “Stopped when the app restarted” | The NAS or app restarted mid-copy. Press **Re-copy RAWs**; finished files are skipped. |
| A photo is listed with “no RAW found” | Check its RAW exists in the client folder with exactly the same name (only the extension may differ). |
| Tablet can’t open the page | Same Wi-Fi as the NAS? Right port? Try the address on the PC first. |
| No year folders listed | `PHOTOS_PATH` points at the wrong level; it must be the folder that holds `2025`, `2026` … |
| A week isn’t listed | Its folder name must end in “backup”. |
| “Too many wrong PINs” | Wait 15 minutes (5 wrong tries per device, 30 in total). |
| Thumbnails slow the first time | They’re being made; once made they load instantly. Starting a session makes them in the background. |

---

## Security, plainly

- Photos are mounted read-only. The app only reads files inside the photos folder; every
  path is checked against that folder (including links pointing elsewhere).
- The projects folder is the only place the app writes photo files. It only ever *creates*
  new files there: no overwriting, moving, renaming or deleting. Every folder it creates is
  checked to be inside the projects folder (client names like `../..` are made safe).
- The app runs as a normal NAS user with no special privileges. A tiny start-up step runs as
  administrator only to fix the owner of the app’s own `data` folder, then switches user.
- Staff area needs the PIN. Wrong PINs are rate-limited. The sign-in cookie lasts 12 hours;
  **Lock** signs out.
- A client link (`/c/…`) contains a long random code that can’t be guessed, and on top of
  that each phone must type the client’s full name once (5 wrong names lock the link). It shows
  only that client’s JPEGs, never other folders or other clients. Nothing about the client,
  not even their name, is shown before the name is confirmed.
- **New QR code** kills the old link immediately. **Remove** shuts out one device. A removed
  phone may still have photos it already viewed in its browser’s cache, so if that matters, ask the
  client to close the tab. Deleting the session kills the link too.
- **The Wi-Fi QR code contains the Wi-Fi password.** Anyone who scans or photographs the
  poster can join that Wi-Fi network. Only put up the poster for a network you’re happy for
  visitors to use. The password is never shown as text in the app, but it is stored in `.env`
  and is visible to NAS administrators in the container’s settings.
- It runs over plain `http://` on your local network. Anyone on the same Wi-Fi could
  technically watch the traffic. If you have a guest Wi-Fi for visitors, keep it separate
  from the network the NAS is on.
- The container runs as a normal user with a read-only system, no extra privileges.
- Not built for exposure to the internet. Don’t forward the port on the router.

---

## For developers

TypeScript throughout: Express + better-sqlite3 + sharp on the server, React (Vite) front end.
The look follows jepsonmyles.co.za (same colours, Bodoni Moda + Jost, frosted glass panels).
The fonts are bundled in `web/public/fonts` under the SIL Open Font Licence (licence files
included), so the app needs no internet.

```
server/        API, path safety, JPEG listing, image cache, PIN auth, SQLite, RAW copier
docker/        start-up script (picks the NAS user, fixes data folder owner)
web/           React app (client screen, staff screens), PWA manifest, icons, bundled fonts
shared/        extra-picture pricing used by both server and screens
test/          unit + API tests (vitest), browser end-to-end run (Playwright)
scripts/       sample-folder generator, icon generator
```

Run locally (Windows PowerShell, Node 22 installed):

```powershell
npm install
npm run build
node scripts/make-sample.mjs sample-photos 60
$env:STAFF_PIN="482916"; $env:PHOTOS_ROOT="$PWD\sample-photos"; $env:DATA_DIR="$PWD\data"; $env:PROJECTS_ROOT="$PWD\projects"; npm start
```

Then open <http://localhost:8080>. To point at the real photos read-only, set
`PHOTOS_ROOT` to the mapped drive (e.g. `Z:\Photos`). The app never writes there, but
Windows can’t enforce read-only for a local run the way Docker’s `:ro` does.

Tests:

```bash
npm test                     # 172 unit + API tests (incl. name matching, removed/old links refused, Wi-Fi QR decoded, extra count/total, path safety, JPEG filter, copy list, RAW matching, writes only inside projects, API)
BASE=http://localhost:8080 PIN=482916 node test/e2e.mjs   # browser run; needs Playwright installed
```
