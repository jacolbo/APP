// Browser test: drives the real UI in Chromium — sign in, upload, edit, share,
// pick, PIN gate, mobile layout. Needs Playwright:
//   npm install --no-save playwright && npx playwright install chromium
//   node test/ui.mjs            (set SHOTS=/some/dir to keep screenshots)
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { png } from './helpers/png.mjs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('\nSkipped: Playwright is not installed.');
  console.log('  npm install --no-save playwright && npx playwright install chromium\n');
  process.exit(0);
}

const server = await startServer();
const BASE = server.base;

const IMAGES = await fsp.mkdtemp(path.join(os.tmpdir(), 'poseboard-fixtures-'));
for (const [index, colour] of [[210, 150, 110], [120, 160, 200], [170, 190, 140]].entries()) {
  await fsp.writeFile(path.join(IMAGES, `pose-${index + 1}.png`), png(900, 1200, colour));
}
const SHOTS = process.env.SHOTS || await fsp.mkdtemp(path.join(os.tmpdir(), 'poseboard-shots-'));

let failures = 0, checks = 0;
const check = (name, ok, detail = '') => {
  checks++;
  console.log(ok ? `  ✓ ${name}` : `  ✗ ${name} ${detail}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
});
const studio = await browser.newContext({ viewport: { width: 1320, height: 950 } });
const page = await studio.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(`studio: ${err.message}`));
page.on('console', (msg) => {
  // The test signs in with a wrong password on purpose; that 401 is expected.
  if (msg.type() === 'error' && !msg.text().includes('401')) errors.push(`studio console: ${msg.text()}`);
});
page.on('response', (res) => {
  if (res.status() >= 400 && !(res.status() === 401 && res.url().endsWith('/api/login'))) {
    errors.push(`studio HTTP ${res.status()} ${new URL(res.url()).pathname}`);
  }
});

console.log('\n— studio: sign in —');
await page.goto(BASE);
await page.waitForSelector('#login-view:not([hidden])');
check('login screen shown', true);
await page.fill('#login-password', 'wrong-one');
await page.click('#login-form button[type=submit]');
await page.waitForSelector('#login-error:not([hidden])');
check('wrong password shows an error', (await page.textContent('#login-error')).length > 0);
await page.fill('#login-password', server.password);
await page.click('#login-form button[type=submit]');
await page.waitForSelector('#app-view:not([hidden])');
check('signed in', await page.isVisible('#dashboard-view'));
check('empty state offered', await page.isVisible('#dashboard-empty'));

console.log('\n— studio: create a collection —');
await page.click('#empty-new-collection');
await page.waitForSelector('.modal');
await page.fill('.modal input[type=text]', 'Maternity — golden hour');
await page.fill('.modal input[placeholder*="Sarah"]', 'Sarah & Tom');
await page.fill('.modal textarea', 'Ideas for our sunset session — heart the ones you like.');
await page.click('.modal button[type=submit]');
await page.waitForSelector('#collection-view:not([hidden])');
check('collection view opened', (await page.textContent('#collection-title')).includes('Maternity'));
check('url carries the collection', page.url().includes('#/c/col_'));

console.log('\n— studio: upload —');
await page.setInputFiles('#file-input', [`${IMAGES}/pose-1.png`, `${IMAGES}/pose-2.png`, `${IMAGES}/pose-3.png`]);
await page.waitForFunction(() => document.querySelectorAll('#photo-grid .tile').length === 3, null, { timeout: 20000 });
check('three photos uploaded', (await page.locator('#photo-grid .tile').count()) === 3);
const thumbSrc = await page.getAttribute('#photo-grid .tile img', 'src');
check('grid uses browser-made thumbnails', thumbSrc.startsWith('/t/'), thumbSrc);
const thumbOk = await page.evaluate(async () => {
  const res = await fetch(document.querySelector('#photo-grid .tile img').src);
  return { status: res.status, type: res.headers.get('content-type'), size: (await res.blob()).size };
});
check('thumbnail is a real JPEG', thumbOk.status === 200 && thumbOk.type === 'image/jpeg' && thumbOk.size > 500, JSON.stringify(thumbOk));
const naturalWidth = await page.evaluate(() => document.querySelector('#photo-grid .tile img').naturalWidth);
check('thumbnail renders in the grid', naturalWidth > 0, String(naturalWidth));

console.log('\n— studio: edit a pose —');
await page.click('#photo-grid .tile:first-child .tile-open');
await page.waitForSelector('.lightbox-card');
await page.fill('.lightbox-side input[placeholder*="Standing"]', 'Hands on bump, looking away');
await page.fill('.lightbox-side textarea', 'Shoot from her left, backlit.');
await page.fill('.lightbox-side input[placeholder*="seated"]', 'standing, outdoor');
await page.click('.lightbox-side button:has-text("Save")');
await page.waitForFunction(() => document.querySelector('.toast')?.textContent === 'Saved', null, { timeout: 10000 });
check('pose details saved', true);
await page.click('.lightbox-side button:has-text("Make cover")');
await page.waitForFunction(() => document.querySelector('.lightbox-side .btn')?.textContent.includes('★') ||
  [...document.querySelectorAll('.lightbox-side button')].some((b) => b.textContent.includes('★')));
check('cover photo set', true);
await page.keyboard.press('Escape');
await page.waitForSelector('.modal', { state: 'detached' });
check('caption shows the title', (await page.textContent('#photo-grid .tile:first-child .tile-caption')).includes('Hands on bump'));

console.log('\n— studio: publish —');
await page.check('#publish-toggle');
await page.waitForFunction(() => document.querySelector('#collection-status').textContent === 'Live');
const shareUrl = await page.inputValue('#share-url');
check('share link generated', /\/s\/s_[A-Za-z0-9_-]+$/.test(shareUrl), shareUrl);
await page.screenshot({ path: `${SHOTS}/studio-collection.png`, fullPage: true });

console.log('\n— client: the shared gallery —');
const clientContext = await browser.newContext({ viewport: { width: 1320, height: 950 } });
const client = await clientContext.newPage();
client.on('pageerror', (err) => errors.push(`client: ${err.message}`));
client.on('console', (msg) => { if (msg.type() === 'error') errors.push(`client console: ${msg.text()}`); });
client.on('dialog', (dialog) => dialog.accept('Sarah'));
await client.goto(shareUrl);
await client.waitForSelector('#gallery-view:not([hidden])');
check('gallery opens for the client', (await client.textContent('#gallery-title')).includes('Maternity'));
check('intro note shown', (await client.textContent('#gallery-subtitle')).includes('sunset session'));
check('all three poses visible', (await client.locator('#photo-grid .tile').count()) === 3);

await client.click('#photo-grid .tile:first-child .icon-btn');
await client.waitForFunction(() => document.querySelector('#pick-count').textContent.includes('1'));
check('client can heart a pose', (await client.textContent('#pick-count')).includes('♥ 1'));
check('name captured from the prompt', (await client.textContent('#change-name')).includes('Sarah'));

await client.click('#photo-grid .tile:nth-child(2) .tile-open');
await client.waitForSelector('.lightbox-card');
check('lightbox opens on the right pose', (await client.textContent('.lightbox-side')).includes('2 of 3'));
await client.click('.lightbox-side button:has-text("Add to my picks")');
await client.waitForFunction(() => document.querySelector('#pick-count').textContent.includes('2'));
await client.fill('.lightbox-side textarea', 'This is my favourite');
await client.click('.lightbox-side button:has-text("Save note")');
await client.waitForSelector('.toast');
check('note saved without losing the pick', (await client.textContent('#pick-count')).includes('♥ 2'));
await client.keyboard.press('Escape');
await client.waitForSelector('.modal', { state: 'detached' });
check('Escape closes the client lightbox', true);
await client.check('#only-mine');
await client.waitForFunction(() => document.querySelectorAll('#photo-grid .tile').length === 2);
check('"only my picks" filter works', (await client.locator('#photo-grid .tile').count()) === 2);
await client.uncheck('#only-mine');
await client.screenshot({ path: `${SHOTS}/client-gallery.png`, fullPage: true });

console.log('\n— client: picks survive a reload —');
await client.reload();
await client.waitForSelector('#gallery-view:not([hidden])');
check('picks remembered for this client', (await client.textContent('#pick-count')).includes('♥ 2'));

console.log('\n— studio: sees the picks —');
await page.reload();
await page.waitForSelector('#collection-view:not([hidden])');
await page.waitForSelector('#picks-panel:not([hidden])');
const picksText = await page.textContent('#picks-summary');
check('picks panel lists the client', picksText.includes('Sarah') && picksText.includes('♥ 2'), picksText.slice(0, 90));
check('client note is visible to the studio', picksText.includes('This is my favourite'));
await page.check('#only-picked');
await page.waitForFunction(() => document.querySelectorAll('#photo-grid .tile').length === 2);
check('studio can filter to picked poses', true);
await page.uncheck('#only-picked');

console.log('\n— studio: PIN gate —');
await page.click('#collection-settings');
await page.waitForSelector('.modal');
await page.fill('.modal input[inputmode=numeric]', '4821');
await page.click('.modal button[type=submit]');
await page.waitForSelector('.modal', { state: 'detached' });
const pinClient = await browser.newContext();
const pinPage = await pinClient.newPage();
await pinPage.goto(shareUrl);
await pinPage.waitForSelector('#pin-view:not([hidden])');
check('a new visitor is asked for the PIN', true);
await pinPage.fill('#pin-input', '0000');
await pinPage.click('#pin-form button[type=submit]');
await pinPage.waitForSelector('#pin-error:not([hidden])');
check('wrong PIN refused', true);
await pinPage.fill('#pin-input', '4821');
await pinPage.click('#pin-form button[type=submit]');
await pinPage.waitForSelector('#gallery-view:not([hidden])');
check('right PIN opens the gallery', true);
await pinPage.screenshot({ path: `${SHOTS}/client-pin.png` });

console.log('\n— mobile layout —');
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const phonePage = await phone.newPage();
await phonePage.goto(shareUrl);
await phonePage.fill('#pin-input', '4821');
await phonePage.click('#pin-form button[type=submit]');
await phonePage.waitForSelector('#gallery-view:not([hidden])');
const overflow = await phonePage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal scroll on a phone', overflow <= 0, `overflow ${overflow}px`);
await phonePage.screenshot({ path: `${SHOTS}/client-mobile.png`, fullPage: true });

console.log('\n— draft galleries go dark —');
await page.uncheck('#publish-toggle');
await page.waitForFunction(() => document.querySelector('#collection-status').textContent === 'Draft');
await pinPage.reload();
await pinPage.waitForSelector('#gone-view:not([hidden])');
check('unpublished gallery is unavailable to clients', true);

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' | '));

await browser.close();
await server.stop();
await fsp.rm(IMAGES, { recursive: true, force: true });
if (!process.env.SHOTS) await fsp.rm(SHOTS, { recursive: true, force: true });
else console.log(`\nScreenshots: ${SHOTS}`);

console.log(`\n${checks - failures}/${checks} browser checks passed\n`);
process.exit(failures ? 1 : 0);
