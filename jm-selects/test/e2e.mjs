// End-to-end run in a real browser (Playwright, iPad emulation).
// Usage: start the server first, then: BASE=http://localhost:8080 PIN=482916 node test/e2e.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// Playwright is not a project dependency: use a local or globally installed copy.
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const BASE = process.env.BASE ?? 'http://localhost:8080';
const PIN = process.env.PIN ?? '482916';
const SHOTS = process.env.SHOTS;
const browser = await chromium.launch();
const errors = [];
const watch = (page) => {
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
};
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const step = (s) => console.log('✓', s);
/** Wait until the client summary reads e.g. "12 selected · 10 included · 2 extra · R500". */
const summaryIs = (page, text) =>
  page.waitForFunction(
    (want) => document.querySelector('.client-top .summary')?.textContent.replace(/\s+/g, ' ').trim() === want,
    text,
    { timeout: 10000 },
  );

const tablet = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
const t = await tablet.newPage();
watch(t);

await t.goto(BASE + '/');
await t.waitForURL(/\/staff$/);
for (const d of PIN) await t.getByRole('button', { name: d, exact: true }).click();
await t.getByRole('button', { name: 'OK' }).click();
await t.getByRole('heading', { name: 'Sessions' }).waitFor();
step('staff PIN sign-in on tablet');

await t.getByRole('button', { name: 'New session' }).click();
await t.getByRole('button', { name: '2026' }).click();
await t.getByRole('button', { name: 'Week 47 backup' }).click();
assert.equal(await t.getByText('Week 47', { exact: true }).count(), 0, 'plain week folder must be hidden');
await shot(t, '01-browse');
await t.locator('li', { hasText: 'Naidoo Family' }).getByRole('button', { name: 'Start session' }).click();
await t.getByRole('button', { name: '10', exact: true }).click();
assert.equal(await t.getByLabel('Price per extra picture in rand').inputValue(), process.env.PRICE ?? '250');
await shot(t, '01b-start-form');
await t.getByRole('button', { name: 'Start session' }).click();
await t.getByRole('heading', { name: 'Naidoo Family' }).waitFor();
step('browse year → backup week → client, start session (package 10)');
await shot(t, '02-session');

await t.getByRole('button', { name: 'Hand this tablet to the client' }).click();
await t.waitForURL(/\/c\//);
const clientUrl = t.url();
await summaryIs(t, '0 selected · 10 included · 0 extra · R0');
await t.locator('.tile img').first().waitFor();
assert.equal(await t.locator('.tile').count(), 60);
step('handoff → client grid shows 60 JPEGs, no RAWs');
await t.waitForTimeout(1500);
await shot(t, '03-client-grid');

const hearts = t.locator('.tile .heart');
for (const i of [0, 2, 5]) await hearts.nth(i).click();
await t.locator('.tile').nth(2).getByRole('button', { name: '5 stars' }).click();
await summaryIs(t, '3 selected · 10 included · 0 extra · R0');
await t.getByText('All changes saved').waitFor();
step('heart + stars on tiles');

await t.locator('.tile-img').nth(0).click();
await t.locator('.viewer-img').waitFor();
await t.getByText('1 / 60').waitFor();
// Swipe left with touch events.
const stage = t.locator('.viewer-stage');
const box = await stage.boundingBox();
const y = box.y + box.height / 2;
await stage.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: box.x + box.width * 0.8, clientY: y }] });
await stage.dispatchEvent('touchmove', { touches: [{ identifier: 1, clientX: box.x + box.width * 0.3, clientY: y }] });
await stage.dispatchEvent('touchend', { touches: [] });
await t.getByText('2 / 60').waitFor();
await t.locator('.viewer-bottom .heart').click();
await t.locator('.viewer-bottom').getByRole('button', { name: '4 stars' }).click();
await t.waitForTimeout(800);
await shot(t, '04-viewer');
await t.getByRole('button', { name: 'Close' }).click();
await summaryIs(t, '4 selected · 10 included · 0 extra · R0');
step('full-screen viewer, swipe, heart, stars');

await t.reload();
await summaryIs(t, '4 selected · 10 included · 0 extra · R0');
step('selections survive a reload');

await t.getByRole('button', { name: /Selected/ }).click();
assert.equal(await t.locator('.tile').count(), 4);
await t.getByRole('button', { name: /^★★★★\+/ }).click();
assert.equal(await t.locator('.tile').count(), 2);
await t.getByRole('button', { name: /All photos/ }).click();
step('filters: selected / 4★+');

await t.getByRole('button', { name: 'Compare', exact: true }).click();
await t.locator('.tile-img').nth(0).click();
await t.locator('.tile-img').nth(1).click();
await t.locator('.compare-pane').nth(1).waitFor();
await t.waitForTimeout(1000);
await shot(t, '05-compare');
await t.getByRole('button', { name: 'Close' }).click();
step('side-by-side compare');

let notices = 0;
for (let i = 6; i < 14; i++) {
  await hearts.nth(i).click();
  if (await t.locator('.modal').isVisible()) {
    notices++;
    const msg = await t.locator('.extra-msg').innerText();
    assert.equal(msg, 'You’ve chosen more than your package includes – extra pictures are R250 each.');
    await shot(t, '06a-extra-notice');
    await t.getByRole('button', { name: 'Continue choosing' }).click();
  }
}
assert.equal(notices, 1, 'extra notice shows exactly once');
await summaryIs(t, '12 selected · 10 included · 2 extra · R500');
await hearts.nth(13).click(); // unheart: total goes down live
await summaryIs(t, '11 selected · 10 included · 1 extra · R250');
await hearts.nth(13).click();
await summaryIs(t, '12 selected · 10 included · 2 extra · R500');
assert.equal(await t.locator('.modal').count(), 0, 'notice does not repeat');
await t.getByText('All changes saved').waitFor();
await shot(t, '06-over-package');
step('extra pictures: not capped, one gentle notice, live total R500');

await t.getByRole('button', { name: 'I’m done' }).click();
await shot(t, '07-confirm-done');
await t.getByRole('button', { name: 'Yes, I’m done' }).click();
await t.getByText('Selection sent').waitFor();
assert.equal(await hearts.first().isDisabled(), true);
await shot(t, '08-locked');
step('"I\'m done" locks the session');

await t.goto(BASE + '/staff');
await t.getByText('Studio staff · enter PIN').waitFor();
step('after handoff, the tablet needs the PIN again for the staff area');

await t.goto(BASE + '/');
await t.waitForURL(clientUrl);
step('home-screen start URL returns to the client session');

// Staff on the studio PC.
const pc = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const p = await pc.newPage();
watch(p);
await p.goto(BASE + '/staff');
await p.getByLabel('Staff PIN').fill(PIN);
await p.keyboard.press('Enter');
await p.getByText('Naidoo Family').first().click();
await p.locator('.section-head .chip', { hasText: /^Done / }).waitFor();
const stats = (await p.locator('.stat-row').innerText()).replace(/\s+/g, ' ');
assert.match(stats, /12 selected 10 included 2 extra × R250 R500 extra total/i, stats);
const ta = p.locator('.copy-card textarea');
await p.waitForFunction(() => document.querySelector('.copy-card textarea')?.value.length > 0);
const list = await ta.inputValue();
assert.equal(list, 'JM_0001,JM_0002,JM_0003,JM_0006,JM_0007,JM_0008,JM_0009,JM_0010,JM_0011,JM_0012,JM_0013,JM_0014');
await p.getByRole('button', { name: /Copy list/ }).click();
await p.getByText('Copied 12 file names').waitFor();
await p.getByText('★ Stars').click();
await p.getByLabel('Minimum stars').selectOption('4');
await p.getByLabel(/Include file extension/).check();
await p.waitForFunction(() => document.querySelector('.copy-card textarea')?.value === 'JM_0002.jpg,JM_0003.jpg');
await shot(p, '09-staff-session');
step('staff copy list (hearted / 4★+ with extension), copy button');

// RAW project copies (only when the server has a projects folder).
if (process.env.EXPECT_RAWS) {
  const card = p.locator('.raw-card');
  await card.getByText(/copied/).waitFor({ timeout: 30000 });
  const text = await card.innerText();
  assert.match(text, new RegExp(`${process.env.EXPECT_RAWS} copied`), text);
  assert.match(text, /2026\/Week 47\/Naidoo Family/);
  await card.getByText(/with no RAW found/).click();
  await card.getByText('JM_0006.jpg').waitFor();
  await shot(p, '11-raw-card');
  step('RAWs copied after "I\'m done", missing RAW listed');
}

const [dl] = await Promise.all([p.waitForEvent('download'), p.getByText('Export CSV').click()]);
const csv = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8');
assert.match(csv, /"JM_0003.jpg","yes","5"/);
assert.match(csv, /"Extra pictures","2"/);
assert.match(csv, /"Extra total","R500"/);
step('CSV export with included / extra / total');

await p.getByRole('button', { name: 'Unlock for changes' }).click();
await p.getByText('In progress').first().waitFor();
await t.reload();
await t.getByRole('button', { name: 'I’m done' }).waitFor();
step('staff unlock re-opens the client tablet');

if (process.env.EXPECT_RAWS) {
  await t.locator('.tile .heart').nth(14).click(); // JM_0015
  await t.getByText('All changes saved').waitFor();
  await p.getByRole('button', { name: 'Re-copy RAWs' }).click();
  await p.locator('.raw-card').getByText(/1 copied, \d+ already there/).waitFor({ timeout: 30000 });
  await shot(p, '12-raw-recopy');
  step('Re-copy RAWs adds only the new pick');
}

await p.getByText('‹ All sessions').click();
await shot(p, '10-staff-list');

await browser.close();
const relevant = errors.filter((e) => !/favicon/.test(e));
assert.deepEqual(relevant, [], 'browser console errors');
console.log('\nAll end-to-end checks passed, no console errors.');
