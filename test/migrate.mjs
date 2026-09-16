// Checks that an existing v1 library survives the move to nested folders:
// same files, same share link, picks intact, and the old view-PIN carried over
// as the download PIN.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let failures = 0, checks = 0;
const check = (name, ok, detail = '') => {
  checks++;
  console.log(ok ? `  ✓ ${name}` : `  ✗ ${name} ${detail}`);
  if (!ok) failures++;
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'poseboard-migrate-'));
await fsp.mkdir(path.join(dataDir, 'files'), { recursive: true });

const V1 = {
  version: 1,
  collections: [{
    id: 'col_legacy', title: 'Old Shoot', clientName: 'Dana', description: 'from before',
    shareId: 's_legacylink', pin: '9134', published: true, coverPhotoId: 'ph_one',
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z',
  }],
  photos: [
    { id: 'ph_one', collectionId: 'col_legacy', file: 'ph_one.png', thumbFile: null, mime: 'image/png',
      size: 70, width: 1, height: 1, originalName: 'old-01.png', title: 'First', notes: '', tags: ['a'],
      sort: 0, createdAt: '2025-01-01T00:00:00.000Z' },
    { id: 'ph_two', collectionId: 'col_legacy', file: 'ph_two.png', thumbFile: null, mime: 'image/png',
      size: 70, width: 1, height: 1, originalName: 'old-02.png', title: '', notes: '', tags: [],
      sort: 1, createdAt: '2025-01-01T00:00:01.000Z' },
    { id: 'ph_orphan', collectionId: 'col_gone', file: 'ph_orphan.png', thumbFile: null, mime: 'image/png',
      size: 70, sort: 0, createdAt: '2025-01-01T00:00:02.000Z' },
  ],
  picks: [{ id: 'pick_1', collectionId: 'col_legacy', photoId: 'ph_one', clientKey: 'legacy-session',
    clientName: 'Dana', note: 'this one', createdAt: '2025-01-03T00:00:00.000Z', updatedAt: '2025-01-03T00:00:00.000Z' }],
};

await fsp.writeFile(path.join(dataDir, 'db.json'), JSON.stringify(V1, null, 2));
for (const name of ['ph_one.png', 'ph_two.png']) {
  await fsp.writeFile(path.join(dataDir, 'files', name), PNG);
}

const port = await freePort();
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_PASSWORD: 'test-password' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (c) => { output += c; });
child.stderr.on('data', (c) => { output += c; });

const BASE = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 10000;
for (;;) {
  try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
  if (Date.now() > deadline) { console.error(output); throw new Error('server did not start'); }
  await new Promise((r) => setTimeout(r, 120));
}

console.log('\n— v1 → v2 migration —');
check('migration was announced', output.includes('migrated db.json to v2'), output.slice(-200));
check('the v1 file was kept as a backup', await fsp.access(path.join(dataDir, 'db.json.v1.bak')).then(() => true, () => false));

const db = JSON.parse(await fsp.readFile(path.join(dataDir, 'db.json'), 'utf8'));
check('db is now version 2', db.version === 2);
check('the collection became a root folder', db.folders.length === 1 && db.folders[0].parentId === null);
check('the share link is unchanged', db.folders[0].uniqueLink === 's_legacylink');
check('published state carried over', db.folders[0].status === 'published');
check('the old PIN is now a hash, not plain text', db.folders[0].downloadPinHash?.startsWith('scrypt$') === true);
check('the plain-text PIN is gone from disk', !JSON.stringify(db).includes('9134'));
check('one tab holds the migrated photos', db.tabs.length === 1 && db.tabs[0].access === 'open');
check('both photos migrated, the orphan dropped', db.images.length === 2);
check('image files are untouched on disk', db.images.every((i) => ['ph_one.png', 'ph_two.png'].includes(i.file)));
check('the pick became a selection', db.selections.length === 1 && db.selections[0].clientSessionId === 'legacy-session');

const view = await (await fetch(`${BASE}/api/g/s_legacylink?clientSessionId=legacy-session`)).json();
check('the old share link still opens the gallery', view.gallery?.title === 'Old Shoot');
check('the migrated photos are visible', view.tabs?.[0]?.images?.length === 2);
check('the old pick shows as a favourite', view.favorites?.length === 1 && view.favorites[0].note === 'this one');
check('the migrated PIN still works', (await fetch(`${BASE}/api/g/s_legacylink/unlock`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '9134' }),
})).status === 200);
check('images still stream', (await fetch(`${BASE}/i/ph_one`)).status === 200);

console.log(`\n${checks - failures}/${checks} checks passed`);
child.kill('SIGTERM');
await new Promise((r) => child.on('exit', r));
await fsp.rm(dataDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
