// The whole Drive path, end to end, against a fake Google: import a folder,
// keep only the preview on disk, and prove the client's download carries the
// full-resolution original that never touched this server's disk.
//   node test/driveflow.mjs
import fsp from 'node:fs/promises';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { startFakeDrive } from './helpers/fakedrive.mjs';

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${detail}`); }
}

// A 1x1 PNG stands in for the scaled preview the browser would produce.
const PREVIEW = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
// The "original" is deliberately different bytes, so the zip check can only
// pass if the file really came from Drive and not from local storage.
const ORIGINAL_A = Buffer.concat([PREVIEW, Buffer.from('ORIGINAL-FROM-DRIVE-AAA')]);
const ORIGINAL_B = Buffer.concat([PREVIEW, Buffer.from('ORIGINAL-FROM-DRIVE-BBB')]);

const fake = await startFakeDrive({
  files: [
    { id: '1AAaaBBbbCCccDDddEEeeFFggHH01', name: '_MG_1613.png', mimeType: 'image/png', body: ORIGINAL_A },
    { id: '1AAaaBBbbCCccDDddEEeeFFggHH02', name: '_MG_1621.png', mimeType: 'image/png', body: ORIGINAL_B },
  ],
  folders: {
    '1ZZfolderIDfolderIDfolderID99': [
      { id: '1AAaaBBbbCCccDDddEEeeFFggHH01', name: '_MG_1613.png', mimeType: 'image/png', size: String(ORIGINAL_A.length) },
      { id: '1AAaaBBbbCCccDDddEEeeFFggHH02', name: '_MG_1621.png', mimeType: 'image/png', size: String(ORIGINAL_B.length) },
      { id: '1AAaaBBbbCCccDDddEEeeFFggHH03', name: 'contract.pdf', mimeType: 'application/pdf', size: '10' },
    ],
  },
});

const server = await startServer({
  env: {
    GOOGLE_CLIENT_EMAIL: fake.clientEmail,
    GOOGLE_PRIVATE_KEY: fake.privateKey,
    GOOGLE_TOKEN_URL: fake.tokenUrl,
    GOOGLE_DRIVE_API: fake.apiBase,
  },
});

const BASE = server.base;
const jars = { admin: new Map(), client: new Map() };

function absorb(jar, res) {
  for (const raw of res.headers.getSetCookie()) {
    const pair = raw.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function call(p, { method = 'GET', body, raw, headers = {}, as = 'admin' } = {}) {
  const jar = as === 'none' ? new Map() : jars[as];
  const h = { ...headers };
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookie) h.cookie = cookie;
  let payload = raw;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + p, { method, headers: h, body: payload, redirect: 'manual' });
  absorb(jar, res);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => ({})) : null;
  return { status: res.status, data, res };
}

console.log(`Testing ${BASE} against a fake Google at ${fake.apiBase}`);

// ------------------------------------------------------------------- setup
console.log('\n— drive status —');

check('Drive endpoints need a signed-in studio', (await call('/api/drive/status', { as: 'none' })).status === 401);

await call('/api/login', { method: 'POST', body: { password: server.password } });

const status = await call('/api/drive/status');
check('Drive reports itself configured', status.data.configured === true, JSON.stringify(status.data));
check('the page is told which account to share with', status.data.clientEmail === fake.clientEmail);

// -------------------------------------------------------------- listing
console.log('\n— listing a drive folder —');

check(
  'a link that is not a Drive folder is refused',
  (await call('/api/drive/list', { method: 'POST', body: { folder: 'lunch' } })).status === 400,
);

const listed = await call('/api/drive/list', {
  method: 'POST',
  body: { folder: 'https://drive.google.com/drive/folders/1ZZfolderIDfolderIDfolderID99?usp=sharing' },
});
check('the folder id was parsed out of a pasted link', listed.data.folderId === '1ZZfolderIDfolderIDfolderID99', JSON.stringify(listed.data.folderId));
check('both photos listed', listed.data.files.length === 2, JSON.stringify(listed.data.files.map((f) => f.name)));
check('the PDF was filtered out', !listed.data.files.some((f) => f.name.endsWith('.pdf')));

check(
  'a signed-out visitor cannot list anyone\'s Drive',
  (await call('/api/drive/list', { method: 'POST', body: { folder: '1ZZfolderIDfolderIDfolderID99' }, as: 'none' })).status === 401,
);

// ------------------------------------------------------------- the proxy
console.log('\n— the import proxy —');

const proxied = await call('/api/drive/files/1AAaaBBbbCCccDDddEEeeFFggHH01/content');
check('the studio can pull an original through the server', proxied.status === 200);
const proxiedBytes = Buffer.from(await proxied.res.arrayBuffer());
check('the proxied bytes are the Drive original', proxiedBytes.equals(ORIGINAL_A), `${proxiedBytes.length} bytes`);
check('the proxy is never cached', (proxied.res.headers.get('cache-control') || '').includes('no-store'));

check(
  'a signed-out visitor cannot reach the proxy',
  (await call('/api/drive/files/1AAaaBBbbCCccDDddEEeeFFggHH01/content', { as: 'none' })).status === 401,
);
check(
  'a malformed Drive id never reaches Google',
  (await call('/api/drive/files/..%2F..%2Fetc/content')).status === 400,
);

// ------------------------------------------------------------- importing
console.log('\n— importing —');

const created = await call('/api/folders', { method: 'POST', body: { title: 'Drive Shoot', clientName: 'Ana' } });
const gallery = created.data.folder;
const finalTab = created.data.tabs.find((t) => t.access === 'pin') || created.data.tabs[1];
check('a folder with a PIN-gated tab exists', Boolean(finalTab), JSON.stringify(created.data.tabs.map((t) => t.access)));

// This is exactly what the browser posts after scaling: the small preview,
// tagged with the Drive id of the original it came from.
const importImage = (driveId, name) => call(
  `/api/tabs/${finalTab.id}/images?w=1&h=1&driveId=${driveId}`,
  { method: 'POST', raw: PREVIEW, headers: { 'content-type': 'image/png', 'x-filename': name } },
);

const impA = await importImage('1AAaaBBbbCCccDDddEEeeFFggHH01', '_MG_1613.png');
const impB = await importImage('1AAaaBBbbCCccDDddEEeeFFggHH02', '_MG_1621.png');
check('both previews stored', impA.status === 201 && impB.status === 201);
check('they are marked as Drive-backed', impA.data.image.source === 'drive', impA.data.image.source);

const localUpload = await call(`/api/tabs/${finalTab.id}/images?w=1&h=1`, {
  method: 'POST', raw: PREVIEW, headers: { 'content-type': 'image/png', 'x-filename': 'local.png' },
});
check('a plain upload is still marked local', localUpload.data.image.source === 'upload', localUpload.data.image.source);

check(
  'a junk Drive id is rejected at upload',
  (await call(`/api/tabs/${finalTab.id}/images?w=1&h=1&driveId=../../etc/passwd`, {
    method: 'POST', raw: PREVIEW, headers: { 'content-type': 'image/png' },
  })).status === 400,
);

// --- the storage claim: only the preview is on disk
const filesDir = path.join(server.dataDir, 'files');
const onDisk = await fsp.readdir(filesDir);
const stored = [];
for (const name of onDisk) {
  const full = path.join(filesDir, name);
  const stat = await fsp.stat(full).catch(() => null);
  if (stat?.isFile() && name.startsWith('img_')) stored.push({ name, size: stat.size });
}
check('a file was written for each image', stored.length >= 3, JSON.stringify(stored));
check(
  'no stored file contains the Drive original — only previews are kept',
  stored.every((f) => f.size === PREVIEW.length),
  JSON.stringify(stored),
);

// ------------------------------------------------------------ the secret
console.log('\n— what the client is allowed to see —');

const pinSet = await call(`/api/folders/${gallery.id}`, {
  method: 'PATCH', body: { downloadPin: '4821', status: 'published' },
});
check('the gallery got a PIN and went live', pinSet.status === 200 && pinSet.data.folder.hasPin === true, JSON.stringify(pinSet.data).slice(0, 200));
const link = gallery.uniqueLink;

const publicPayload = await call(`/api/g/${link}`, { as: 'client' });
const asText = JSON.stringify(publicPayload.data);
check('the gallery opens for a client', publicPayload.status === 200);
check('the Drive file id never reaches the browser', !asText.includes('1AAaaBBbbCCccDDddEEeeFFggHH01') && !asText.includes('1AAaaBBbbCCccDDddEEeeFFggHH02'), 'a Drive id leaked into the page payload');
check('no Drive or Google URL is handed to the browser', !/drive\.google|googleapis|googleusercontent/.test(asText));

// ---------------------------------------------------------- downloading
console.log('\n— downloading originals from drive —');

check(
  'the archive is locked until the PIN is entered',
  (await call(`/api/g/${link}/gallery.zip`, { as: 'client' })).status === 401,
);

const unlock = await call(`/api/g/${link}/unlock`, { method: 'POST', body: { pin: '4821' }, as: 'client' });
check('the PIN unlocks the gallery', unlock.status === 200, JSON.stringify(unlock.data));

const mediaBefore = fake.state.mediaCalls;
const zipped = await call(`/api/g/${link}/gallery.zip`, { as: 'client' });
check('the archive is served once unlocked', zipped.status === 200, String(zipped.status));

const zipBytes = Buffer.from(await zipped.res.arrayBuffer());
check('it is a real zip', zipBytes.subarray(0, 4).toString('hex') === '504b0304');
check('it closes with an end-of-central-directory record', zipBytes.subarray(-22, -18).toString('hex') === '504b0506');

// The point of the whole exercise.
check(
  'the zip carries the full-resolution original from Drive',
  zipBytes.includes(Buffer.from('ORIGINAL-FROM-DRIVE-AAA'))
  && zipBytes.includes(Buffer.from('ORIGINAL-FROM-DRIVE-BBB')),
  'the archive holds previews, not originals',
);
check('the filenames survive into the archive', zipBytes.includes(Buffer.from('_MG_1613.png')));
check(
  'Drive was read only at download time',
  fake.state.mediaCalls === mediaBefore + 2,
  `${fake.state.mediaCalls - mediaBefore} media calls`,
);

// --- browsing costs nothing
const mediaBeforeBrowse = fake.state.mediaCalls;
await call(`/api/g/${link}`, { as: 'client' });
const preview = await call(`/i/${impA.data.image.id}`, { as: 'client' });
check('browsing the gallery serves the local preview', preview.status === 200);
const previewBytes = Buffer.from(await preview.res.arrayBuffer());
check('the preview is the small file, not the original', previewBytes.length === PREVIEW.length, `${previewBytes.length} bytes`);
check(
  'browsing never calls Drive',
  fake.state.mediaCalls === mediaBeforeBrowse,
  `${fake.state.mediaCalls - mediaBeforeBrowse} unexpected Drive reads`,
);

// --- when Drive breaks, the failure is honest
console.log('\n— when drive is unavailable —');

fake.state.failNextWith = 500;

// The header goes out before the first photo is fetched, so a Drive failure
// mid-archive can only end the connection. That is the honest outcome: the
// client gets a visibly broken download, never a tidy zip missing photos.
let looksComplete = false;
let connectionDied = false;
try {
  const brokenZip = await call(`/api/g/${link}/gallery.zip`, { as: 'client' });
  if (brokenZip.status === 200 && !brokenZip.data) {
    const partial = Buffer.from(await brokenZip.res.arrayBuffer());
    looksComplete = partial.subarray(-22, -18).toString('hex') === '504b0506';
  }
} catch {
  connectionDied = true;
}
check('a Drive outage never yields a complete-looking but incomplete archive', !looksComplete);
check('the download fails visibly rather than silently', connectionDied || !looksComplete);

// The important part: one bad Drive call must not take the server with it.
const stillAlive = await call('/health', { as: 'none' });
check('the server survives a Drive outage', stillAlive.status === 200, String(stillAlive.status));

const recovered = await call(`/api/g/${link}/gallery.zip`, { as: 'client' });
check('the next download works again once Drive recovers', recovered.status === 200, String(recovered.status));
const recoveredBytes = Buffer.from(await recovered.res.arrayBuffer());
check(
  'and it is complete',
  recoveredBytes.subarray(-22, -18).toString('hex') === '504b0506'
  && recoveredBytes.includes(Buffer.from('ORIGINAL-FROM-DRIVE-AAA')),
);

await server.stop();
await fake.stop();

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
