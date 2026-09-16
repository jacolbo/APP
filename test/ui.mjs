// Browser test: drives the real UI in Chromium — sign in, build a folder tree,
// upload, publish, then open the client gallery and favourite, unlock, download
// and hand off. Needs Playwright:
//   npm install --no-save playwright
//   node test/ui.mjs            (set SHOTS=/some/dir to keep screenshots)
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './helpers/server.mjs';
import { startWebhookReceiver } from './helpers/webhook.mjs';
import { png } from './helpers/png.mjs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('\nSkipped: Playwright is not installed.');
  console.log('  npm install --no-save playwright\n');
  process.exit(0);
}

const server = await startServer();
const hook = await startWebhookReceiver();
const BASE = server.base;

const IMAGES = await fsp.mkdtemp(path.join(os.tmpdir(), 'poseboard-fixtures-'));
const files = [];
for (const [index, colour] of [[210, 150, 110], [120, 160, 200], [170, 190, 140]].entries()) {
  const file = path.join(IMAGES, `shot-${index + 1}.png`);
  await fsp.writeFile(file, png(900, 1200, colour));
  files.push(file);
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
const studio = await browser.newContext({
  viewport: { width: 1320, height: 950 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await studio.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(`studio: ${err.message}`));

console.log('\n— studio —');
await page.goto(BASE);
await page.fill('#login-password', server.password);
await page.click('#login-form button[type=submit]');
await page.waitForSelector('#app-view:not([hidden])');
check('signed in', await page.isVisible('#root-view'));

await page.click('#empty-new-folder');
await page.fill('.modal-card input[type=text]', 'Smith Wedding');
await page.click('.modal-card button[type=submit]');
await page.waitForSelector('#folder-view:not([hidden])');
check('folder created and opened', (await page.textContent('#folder-title')) === 'Smith Wedding');

const tabNames = await page.$$eval('#admin-tabbar .tab', (nodes) => nodes.map((n) => n.textContent.replace(/\d+$/, '').trim()));
check('two default tabs appear', tabNames.length === 2, JSON.stringify(tabNames));
check('the final tab is marked private', tabNames.some((name) => name.includes('🔒')), JSON.stringify(tabNames));

await page.setInputFiles('#file-input', files.slice(0, 2));
await page.waitForFunction(() => document.querySelectorAll('#admin-grid .tile').length === 2, null, { timeout: 20000 });
check('two images uploaded into Previews', (await page.$$('#admin-grid .tile')).length === 2);

// Switch to the PIN-gated tab and put the deliverable in it.
await page.click('#admin-tabbar .tab:nth-child(2)');
await page.setInputFiles('#file-input', files.slice(2));
await page.waitForFunction(() => document.querySelectorAll('#admin-grid .tile').length === 1, null, { timeout: 20000 });
check('deliverable uploaded into the private tab', (await page.$$('#admin-grid .tile')).length === 1);

await page.click('#new-subfolder');
await page.fill('.modal-card input[type=text]', 'Ceremony');
await page.click('.modal-card button[type=submit]');
await page.waitForFunction(() => document.querySelector('#folder-title')?.textContent === 'Ceremony');
check('sub-folder created inside the gallery', (await page.textContent('#folder-title')) === 'Ceremony');
await page.click('#publish-toggle');
await page.waitForTimeout(300);
await page.click('#admin-crumbs .crumb:nth-child(3)');
await page.waitForFunction(() => document.querySelector('#folder-title')?.textContent === 'Smith Wedding');
check('breadcrumb walks back up the tree', (await page.textContent('#folder-title')) === 'Smith Wedding');
check('the sub-folder is listed', (await page.$$('#child-cards .card')).length === 1);

// Settings: PIN and the handoff address.
await page.click('#folder-settings');
await page.waitForSelector('.modal-card');
await page.fill('.modal-card input[inputmode=numeric]', '4821');
await page.fill('.modal-card input[placeholder^="https://studio"]', hook.url);
await page.fill('.modal-card input[placeholder="Your Studio Name"]', 'Ana & Tom Studio');
await page.$eval('.modal-card input[type=color]', (el) => { el.value = '#2f6f4f'; });
await page.click('.modal-card .btn-primary');
await page.waitForSelector('.modal-card', { state: 'detached' });
await page.waitForTimeout(300);
check('PIN and webhook saved', (await page.textContent('#share-hint')).includes('No handoff address') === false);

await page.click('#publish-toggle');
await page.waitForTimeout(400);
const shareUrl = await page.inputValue('#share-url');
check('share link points at /g/', /\/g\/s_/.test(shareUrl), shareUrl);
check('gallery is live', (await page.textContent('#folder-status')) === 'Live');
await page.screenshot({ path: path.join(SHOTS, 'studio-folder.png'), fullPage: true });

console.log('\n— client gallery —');
const clientContext = await browser.newContext({ viewport: { width: 1320, height: 950 } });
const client = await clientContext.newPage();
client.on('pageerror', (err) => errors.push(`client: ${err.message}`));
await client.goto(shareUrl);
await client.waitForSelector('#gallery-view:not([hidden])');
check('cover page shows the title', (await client.textContent('#cover-title')) === 'Smith Wedding');
check('favourites start empty', await client.isVisible('#favorites-empty'));
check('sub-folder card is offered', (await client.$$('#folder-cards .card')).length === 1);

const clientTabs = await client.$$eval('#tabbar .tab', (nodes) => nodes.map((n) => n.textContent.trim()));
check('both tabs listed', clientTabs.length === 2, JSON.stringify(clientTabs));
check('the private tab shows as locked', clientTabs.some((name) => name.includes('🔒')));
await client.screenshot({ path: path.join(SHOTS, 'client-cover.png'), fullPage: true });

// The whole point: the deliverable must not be in the page at all yet.
const leaked = await client.evaluate(() => document.body.innerHTML.includes('shot-3'));
check('the private image is absent from the page', leaked === false);

await client.click('#image-grid .tile:first-child .tile-open');
await client.waitForFunction(() => document.querySelectorAll('#favorites-strip .fav-chip').length === 1);
check('clicking an image favourites it', (await client.$$('#favorites-strip .fav-chip')).length === 1);

// The first pick asks who it belongs to — optional, but it is what turns an
// anonymous session into something the studio can act on.
await client.waitForSelector('.modal-card input[autocomplete=name]', { timeout: 10000 });
check('asked who the picks belong to, after the first one', true);
await client.fill('.modal-card input[autocomplete=name]', 'Ana');
await client.fill('.modal-card input[autocomplete=email]', 'ana@example.com');
await client.click('.modal-card button[type=submit]');
await client.waitForSelector('.modal-card', { state: 'detached' });
check('send button appears with a favourite', await client.isVisible('#send-button'));

await client.reload();
await client.waitForSelector('#gallery-view:not([hidden])');
await client.waitForFunction(() => document.querySelectorAll('#favorites-strip .fav-chip').length === 1);
check('the favourite survives a refresh', (await client.$$('#favorites-strip .fav-chip')).length === 1);

await client.click('#favorites-strip .fav-remove');
await client.waitForFunction(() => document.querySelectorAll('#favorites-strip .fav-chip').length === 0);
check('a favourite can be removed from the favourites strip', (await client.$$('#favorites-strip .fav-chip')).length === 0);
await client.click('#image-grid .tile:first-child .tile-open');
await client.waitForFunction(() => document.querySelectorAll('#favorites-strip .fav-chip').length === 1);
const askedTwice = await client.$('.modal-card input[autocomplete=name]');
check('it does not ask a second time', askedTwice === null);

console.log('\n— picking up on another device —');
const otherDevice = await browser.newContext({ viewport: { width: 1320, height: 950 } });
const other = await otherDevice.newPage();
other.on('pageerror', (err) => errors.push(`restore: ${err.message}`));
await other.goto(shareUrl);
await other.waitForSelector('#gallery-view:not([hidden])');
check('a fresh browser starts with no favourites', (await other.$$('#favorites-strip .fav-chip')).length === 0);
check('it offers to find earlier picks', await other.isVisible('#restore-button'));
await other.click('#restore-button');
await other.waitForSelector('.modal-card input[autocomplete=email]');
await other.fill('.modal-card input[autocomplete=email]', 'nobody@example.test');
await other.click('.modal-card button[type=submit]');
await other.waitForSelector('.modal-card .hint[style*="danger"]:not([hidden])');
check('an unknown email is refused', true);
await other.fill('.modal-card input[autocomplete=email]', 'ana@example.com');
await other.click('.modal-card button[type=submit]');
await other.waitForFunction(() => document.querySelectorAll('#favorites-strip .fav-chip').length === 1, null, { timeout: 10000 });
check('the same email brings the picks back on another device', (await other.$$('#favorites-strip .fav-chip')).length === 1);
await otherDevice.close();

console.log('\n— the studio sees who picked —');
await page.reload();
await page.waitForSelector('#app-view:not([hidden])');
await page.click('#root-cards .card:first-child');
await page.waitForSelector('#folder-view:not([hidden])');
const whoPicked = await page.textContent('#selections-summary');
check('the studio shows the name and email, not a session id', whoPicked.includes('Ana') && whoPicked.includes('ana@example.com'), whoPicked.slice(0, 120));
// The whole point of this button is the exact shape of what lands on the
// clipboard, so read it back rather than trusting the call site.
await page.click('#picks-copy-all');
const copied = (await page.evaluate(() => navigator.clipboard.readText())).trim();
check('copied names carry no file extension', !/\.(png|jpe?g)/i.test(copied), copied);
check('copied names are comma separated', /^[^,]+(, [^,]+)*$/.test(copied), copied);
check('copied names are the picked files', copied.split(', ').every((n) => /^shot-\d+$/.test(n)), copied);

const statsText = await page.textContent('#folder-stats');
check('the studio sees views and downloads', /Views/i.test(statsText) && /Downloads/i.test(statsText), statsText.slice(0, 80));

console.log('\n— the PIN gate —');
await client.click('#tabbar .tab:nth-child(2)');
await client.waitForSelector('#grid-empty:not([hidden])');
check('locked tab explains itself', (await client.textContent('#grid-empty')).includes('protected'));
await client.click('#grid-empty .btn-primary');
await client.waitForSelector('#pin-input');
await client.fill('#pin-input', '0000');
await client.click('.modal-card button[type=submit]');
await client.waitForSelector('.modal-card .hint[style*="danger"]:not([hidden])');
check('a wrong PIN is refused in the UI', true);
await client.fill('#pin-input', '4821');
await client.click('.modal-card button[type=submit]');
await client.waitForFunction(() => document.querySelectorAll('#image-grid .tile').length === 1, null, { timeout: 10000 });
check('the right PIN reveals the private tab', (await client.$$('#image-grid .tile')).length === 1);
await client.screenshot({ path: path.join(SHOTS, 'client-unlocked.png'), fullPage: true });

const download = await Promise.all([
  client.waitForEvent('download', { timeout: 15000 }),
  client.click('#image-grid .tile:first-child .tile-actions button:last-child'),
]).then(([event]) => event).catch(() => null);
check('the download button actually downloads', Boolean(download), 'no download event fired');
if (download) check('the file keeps its name', download.suggestedFilename() === 'shot-3.png', download.suggestedFilename());

console.log('\n— branding, stars and a comment —');
const accent = await client.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
check('the studio accent colour reaches the client page', accent === '#2f6f4f', accent);

await client.click('#image-grid .tile:first-child .tile-actions button:nth-child(2)');
await client.waitForSelector('.lightbox-card .stars');
check('a rating control is offered', (await client.$$('.lightbox-card .star')).length === 5);
await client.click('.lightbox-card .star:nth-child(4)');
await client.waitForFunction(() => document.querySelectorAll('.lightbox-card .star.on').length === 4);
check('four stars stick', (await client.$$('.lightbox-card .star.on')).length === 4);
await client.fill('.lightbox-card textarea', 'This one for the album please');
await client.waitForFunction(
  () => document.querySelector('.lightbox-card .hint')?.textContent === 'Saved',
  null,
  { timeout: 10000 },
);
check('the comment saves on its own', true);

await client.keyboard.press('Escape');
await client.waitForSelector('.lightbox-card', { state: 'detached' });

// Favourite straight from the grid — a tile click toggles it — so nothing is
// overlaying the favourites panel when the archive button is clicked.
await client.click('#image-grid .tile:first-child .tile-open');
await client.waitForSelector('#download-picks:not([hidden])', { timeout: 10000 });
check('the archive is offered once a downloadable pick exists', true);

const picksZip = await Promise.all([
  client.waitForEvent('download', { timeout: 15000 }),
  client.click('#download-picks'),
]).then(([event]) => event).catch(() => null);
check('the whole selection downloads as one zip', Boolean(picksZip) && /\.zip$/.test(picksZip.suggestedFilename()), picksZip ? picksZip.suggestedFilename() : 'no download');

// Put it back so the handoff section below starts from the count it expects.
await client.click('#image-grid .tile:first-child .tile-open');
await client.waitForFunction(
  () => document.querySelectorAll('#favorites-strip .fav-chip').length === 1,
  null,
  { timeout: 10000 },
);

console.log('\n— handing the selection over —');
await client.click('#image-grid .tile:first-child .tile-open');
await client.waitForFunction(() => document.querySelectorAll('#favorites-strip .fav-chip').length === 2);
await client.click('#send-button');
await client.waitForFunction(
  () => document.querySelector('#send-status')?.textContent.startsWith('Sent'),
  null,
  { timeout: 15000 },
);
check('success message shown after the webhook answered 200', true);
const payload = hook.last()?.body;
check('the webhook got both picks', payload?.total_selected === 2, JSON.stringify(payload?.total_selected));
check('the webhook got the file names', payload?.selected_files?.includes('shot-3.png'), JSON.stringify(payload?.selected_files));

hook.answerWith(500);
await client.click('#send-button');
await client.waitForFunction(
  () => document.querySelector('#send-status')?.textContent.includes('Nothing was sent'),
  null,
  { timeout: 15000 },
);
check('a failed webhook never claims success', true);

console.log('\n— phone layout —');
const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const phone = await phoneContext.newPage();
phone.on('pageerror', (err) => errors.push(`phone: ${err.message}`));
await phone.goto(shareUrl);
await phone.waitForSelector('#gallery-view:not([hidden])');
const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('no horizontal scroll at 390px', overflow <= 1, `${overflow}px of overflow`);
// Hover does not exist on a phone, so the per-image buttons have to be on screen.
const actionsVisible = await phone.evaluate(
  () => getComputedStyle(document.querySelector('#image-grid .tile-actions')).opacity,
);
check('image buttons are reachable without hover', Number(actionsVisible) === 1, `opacity ${actionsVisible}`);
await phone.screenshot({ path: path.join(SHOTS, 'client-phone.png'), fullPage: true });

check('no uncaught JavaScript errors', errors.length === 0, errors.join(' | '));

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(`Screenshots: ${SHOTS}`);
await browser.close();
await hook.stop();
await server.stop();
await fsp.rm(IMAGES, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
