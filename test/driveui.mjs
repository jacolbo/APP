// Browser test: drives the real Import-from-Drive UI in Chromium against a
// fake Google. Needs Playwright:
//   npm install --no-save playwright
//   node test/driveui.mjs
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { startFakeDrive } from './helpers/fakedrive.mjs';
import { png } from './helpers/png.mjs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('\nSkipped: Playwright is not installed.');
  console.log('  npm install --no-save playwright\n');
  process.exit(0);
}

const shotDir = process.env.SHOTS || await fsp.mkdtemp(path.join(os.tmpdir(), 'poseboard-drive-shots-'));
const shotPath = path.join(shotDir, 'drive-import.png');

const A = png(1400, 1000, [200, 120, 90]);
const B = png(1400, 1000, [90, 140, 200]);
const FOLDER = '1ZZfolderIDfolderIDfolderID99';

const fake = await startFakeDrive({
  files: [
    { id: '1AAaaBBbbCCccDDddEEeeFFggHH01', name: '_MG_1613.png', mimeType: 'image/png', body: A },
    { id: '1AAaaBBbbCCccDDddEEeeFFggHH02', name: '_MG_1621.png', mimeType: 'image/png', body: B },
  ],
  folders: {
    [FOLDER]: [
      { id: '1AAaaBBbbCCccDDddEEeeFFggHH01', name: '_MG_1613.png', mimeType: 'image/png', size: String(A.length) },
      { id: '1AAaaBBbbCCccDDddEEeeFFggHH02', name: '_MG_1621.png', mimeType: 'image/png', size: String(B.length) },
    ],
  },
});

const server = await startServer({ env: {
  GOOGLE_CLIENT_EMAIL: fake.clientEmail,
  GOOGLE_PRIVATE_KEY: fake.privateKey,
  GOOGLE_TOKEN_URL: fake.tokenUrl,
  GOOGLE_DRIVE_API: fake.apiBase,
}});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let checks = 0, failures = 0;
const check = (n, c, d='') => { checks++; console.log(c ? `  ✓ ${n}` : `  ✗ ${n} ${d}`); if(!c) failures++; };

await page.goto(server.base);
await page.fill('#login-password', server.password);
await page.click('#login-form button[type=submit]');
await page.waitForSelector('#app-view:not([hidden])');

// Creating a folder opens it straight away.
await page.click('#empty-new-folder');
await page.fill('.modal-card input[type=text]', 'Drive Shoot');
await page.click('.modal-card button[type=submit]');
await page.waitForSelector('#folder-view:not([hidden])');

check('the Import from Drive button is visible', await page.isVisible('#drive-open'));

await page.click('#drive-open');
await page.waitForSelector('#drive-folder');
check('the import dialog opened', await page.isVisible('#drive-folder'));

await page.fill('#drive-folder', `https://drive.google.com/drive/folders/${FOLDER}`);
await page.click('.drive-card .share-link button');
await page.waitForSelector('.drive-row:not(.drive-all)');

const rows = await page.locator('.drive-row:not(.drive-all)').count();
check('both Drive photos are listed', rows === 2, String(rows));
check('the filenames are shown', (await page.locator('.drive-name').first().textContent()) === '_MG_1613.png');
check('the import button counts them', /Import 2 photos/.test(await page.locator('#drive-import').textContent()));

await page.screenshot({ path: path.join(shotDir, 'drive-picker.png') });

// Untick one, confirm the count follows.
await page.locator('.drive-row:not(.drive-all) input').first().uncheck();
check('unticking updates the count', /Import 1 photo\b/.test(await page.locator('#drive-import').textContent()));
await page.locator('.drive-row:not(.drive-all) input').first().check();

const mediaBefore = fake.state.mediaCalls;
await page.click('#drive-import');
await page.waitForSelector('#admin-grid .tile', { timeout: 20000 });
await page.waitForFunction(() => document.querySelectorAll('#admin-grid .tile').length === 2, null, { timeout: 20000 });

const tiles = await page.locator('#admin-grid .tile').count();
check('both photos landed in the tab', tiles === 2, String(tiles));
check('each original was read from Drive exactly once', fake.state.mediaCalls === mediaBefore + 2, String(fake.state.mediaCalls - mediaBefore));
check('no uncaught JavaScript errors', errors.length === 0, errors.join(' | '));

await page.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/drive-import.png` : shotPath, fullPage: false });

await browser.close();
await server.stop();
await fake.stop();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
