// End-to-end API test. Starts its own server on a free port with a temporary
// data directory, exercises every endpoint including the PIN gate, the
// download grant and the handoff webhook, then cleans up after itself.
//   node test/smoke.mjs
// Set BASE to test a server that is already running (a fresh deployment, say):
//   BASE=https://poses.example.com ADMIN_PASSWORD=... node test/smoke.mjs
import { startServer } from './helpers/server.mjs';
import { startWebhookReceiver } from './helpers/webhook.mjs';

const server = process.env.BASE
  ? { base: process.env.BASE, password: process.env.ADMIN_PASSWORD || '', stop: async () => {} }
  : await startServer();

if (process.env.BASE && !server.password) {
  console.error('Set ADMIN_PASSWORD as well as BASE so the test can sign in.');
  process.exit(1);
}

const BASE = server.base;
const PASSWORD = server.password;
const hook = await startWebhookReceiver();

console.log(`Testing ${BASE}${process.env.BASE ? ' (already running)' : ' (temporary instance)'}`);

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${detail}`); }
}

// Two cookie jars: the studio's signed-in session, and a client who only ever
// holds a download grant. Keeping them apart is what makes the "a client
// cannot see this" checks meaningful.
const jars = { admin: new Map(), client: new Map() };

function absorb(jar, res) {
  for (const raw of res.headers.getSetCookie()) {
    const pair = raw.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (/max-age=0/i.test(raw) || !value) jar.delete(name);
    else jar.set(name, value);
  }
}

async function call(path, { method = 'GET', body, raw, headers = {}, as = 'admin' } = {}) {
  const jar = jars[as] || new Map();
  const h = { ...headers };
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookie) h.cookie = cookie;
  let payload = raw;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
  absorb(jar, res);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => ({})) : null;
  return { status: res.status, data, res };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const upload = (tabId, name) => call(`/api/tabs/${tabId}/images?w=1&h=1`, {
  method: 'POST', raw: PNG, headers: { 'content-type': 'image/png', 'x-filename': name },
});

console.log('\n— health & session —');
check('GET /health', (await call('/health', { as: 'none' })).status === 200);
const session = await call('/api/session', { as: 'none' });
check('session starts signed out', session.data.authed === false, JSON.stringify(session.data));
check('session reports the folder depth cap', session.data.maxDepth === 20, String(session.data.maxDepth));

console.log('\n— auth —');
check('admin page served', (await call('/', { as: 'none' })).status === 200);
check('folders blocked when signed out', (await call('/api/folders', { as: 'none' })).status === 401);
check('wrong password rejected', (await call('/api/login', { method: 'POST', body: { password: 'nope' }, as: 'none' })).status === 401);
const login = await call('/api/login', { method: 'POST', body: { password: PASSWORD } });
check('correct password accepted', login.status === 200 && jars.admin.has('pose_session'));
check('session now authed', (await call('/api/session')).data.authed === true);

console.log('\n— folders and default tabs —');
const created = await call('/api/folders', { method: 'POST', body: { title: 'Smith Wedding', clientName: 'Ana' } });
const gallery = created.data.folder;
check('folder created', created.status === 201 && gallery.title === 'Smith Wedding');
check('starts as a draft', gallery.status === 'draft', gallery.status);
check('gets a unique link', typeof gallery.uniqueLink === 'string' && gallery.uniqueLink.length > 10);
const tabs = created.data.tabs;
check('two default tabs', tabs.length === 2, JSON.stringify(tabs.map((t) => t.title)));
const previewTab = tabs.find((t) => t.access === 'open');
const finalTab = tabs.find((t) => t.access === 'pin');
check('Previews tab is open and not downloadable', previewTab?.title === 'Previews' && previewTab.downloadable === false);
check('Final images tab is PIN-gated and downloadable', finalTab?.title === 'Final images' && finalTab.downloadable === true);

console.log('\n— nesting —');
const ceremony = (await call('/api/folders', { method: 'POST', body: { parentId: gallery.id, title: 'Ceremony' } })).data.folder;
check('sub-folder created', ceremony.parentId === gallery.id && ceremony.depth === 2);
const hidden = (await call('/api/folders', { method: 'POST', body: { parentId: gallery.id, title: 'Draft corner' } })).data.folder;
check('second sub-folder created', hidden.depth === 2);

let deepest = gallery.id;
let deepestDepth = 1;
for (let i = 0; i < 25; i += 1) {
  const next = await call('/api/folders', { method: 'POST', body: { parentId: deepest, title: `Level ${i + 2}`, withDefaultTabs: false } });
  if (next.status !== 201) {
    check('depth cap refuses level 21', next.status === 400 && deepestDepth === 20, `${next.status} at depth ${deepestDepth}: ${next.data?.error}`);
    break;
  }
  deepest = next.data.folder.id;
  deepestDepth = next.data.folder.depth;
}
check('nesting reached 20 levels', deepestDepth === 20, String(deepestDepth));
const cycle = await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { parentId: ceremony.id } });
check('a folder cannot be moved inside itself', cycle.status === 400, JSON.stringify(cycle.data));

console.log('\n— images —');
const preview1 = (await upload(previewTab.id, 'preview-01.png')).data.image;
const preview2 = (await upload(previewTab.id, 'preview-02.png')).data.image;
const deliverable = (await upload(finalTab.id, 'FINAL-0041.png')).data.image;
const proofTab = (await call(`/api/folders/${gallery.id}/tabs`, { method: 'POST', body: { title: 'Proofs', access: 'open', downloadable: true } })).data.tab;
const proof = (await upload(proofTab.id, 'proof-07.png')).data.image;
check('images uploaded', Boolean(preview1?.id && preview2?.id && deliverable?.id && proof?.id));
check('an open tab can also be downloadable', proofTab.access === 'open' && proofTab.downloadable === true);
check('image payload has no stored file path', !('file' in preview1) && preview1.url === `/i/${preview1.id}`);
const badType = await call(`/api/tabs/${previewTab.id}/images`, { method: 'POST', raw: 'x', headers: { 'content-type': 'text/plain' } });
check('non-image upload rejected', badType.status === 415);
const reorder = await call(`/api/tabs/${previewTab.id}/order`, { method: 'POST', body: { ids: [preview2.id, preview1.id] } });
check('images reorder', reorder.data.images[0].id === preview2.id);

console.log('\n— every folder keeps a public tab —');
const rules = (await call('/api/folders', { method: 'POST', body: { title: 'Tab rules' } })).data;
const onlyOpen = rules.tabs.find((t) => t.access === 'open');
check('cannot lock the last open tab', (await call(`/api/tabs/${onlyOpen.id}`, { method: 'PATCH', body: { access: 'pin' } })).status === 400);
check('cannot delete the last open tab', (await call(`/api/tabs/${onlyOpen.id}`, { method: 'DELETE' })).status === 400);
check('a second open tab is allowed', (await call(`/api/folders/${rules.folder.id}/tabs`, { method: 'POST', body: { title: 'More', access: 'open' } })).status === 201);
check('with two open, the first can be locked', (await call(`/api/tabs/${onlyOpen.id}`, { method: 'PATCH', body: { access: 'pin' } })).status === 200);
const bare = (await call('/api/folders', { method: 'POST', body: { title: 'Bare', withDefaultTabs: false } })).data.folder;
check('a first tab cannot be PIN-only', (await call(`/api/folders/${bare.id}/tabs`, { method: 'POST', body: { title: 'Secret', access: 'pin' } })).status === 400);
await call(`/api/folders/${rules.folder.id}`, { method: 'DELETE' });
await call(`/api/folders/${bare.id}`, { method: 'DELETE' });

console.log('\n— publishing —');
const link = gallery.uniqueLink;
check('draft gallery is not reachable', (await call(`/api/g/${link}`, { as: 'client' })).status === 404);
await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { status: 'published' } });
await call(`/api/folders/${ceremony.id}`, { method: 'PATCH', body: { status: 'published' } });
const view = await call(`/api/g/${link}?clientSessionId=sess-a`, { as: 'client' });
check('published gallery is reachable', view.status === 200);
check('title comes through', view.data.gallery.title === 'Smith Wedding');
check('published sub-folder listed', view.data.folders.some((f) => f.id === ceremony.id));
check('draft sub-folder hidden', !view.data.folders.some((f) => f.id === hidden.id));

console.log('\n— the locked tab —');
const viewTabs = view.data.tabs;
const clientPreviewTab = viewTabs.find((t) => t.id === previewTab.id);
const clientFinalTab = viewTabs.find((t) => t.id === finalTab.id);
check('open tab lists its images', clientPreviewTab.images.length === 2 && clientPreviewTab.locked === false);
check('PIN tab reports itself locked', clientFinalTab.locked === true);
check('PIN tab hands back no images', clientFinalTab.images.length === 0);
check('PIN tab still reports its count', clientFinalTab.imageCount === 1);
const rawView = JSON.stringify(view.data);
check('deliverable id absent from page load', !rawView.includes(deliverable.id), 'the locked image id leaked');
check('no on-disk filename in the payload', !rawView.includes(`${preview1.id}.png`) && !rawView.includes(`${deliverable.id}.png`));
check('no data directory path in the payload', !rawView.includes('data/files') && !rawView.includes('/files/'));
check('gallery says a PIN has not been set yet', view.data.gallery.hasPin === false);

console.log('\n— favourites —');
const pick = await call(`/api/g/${link}/select`, { method: 'POST', as: 'client', body: { imageId: preview1.id, clientSessionId: 'sess-a', selected: true } });
check('image favourited', pick.status === 200 && pick.data.selected === true && pick.data.totalSelected === 1);
const afterPick = await call(`/api/g/${link}?clientSessionId=sess-a`, { as: 'client' });
check('favourite survives a reload', afterPick.data.favorites.length === 1 && afterPick.data.favorites[0].id === preview1.id);
check('favourite carries its folder path', afterPick.data.favorites[0].folderPath === 'Smith Wedding');
const otherSession = await call(`/api/g/${link}?clientSessionId=sess-b`, { as: 'client' });
check('another session sees its own empty list', otherSession.data.favorites.length === 0);
const sneaky = await call(`/api/g/${link}/select`, { method: 'POST', as: 'client', body: { imageId: deliverable.id, clientSessionId: 'sess-a', selected: true } });
check('locked image cannot be favourited', sneaky.status === 404, String(sneaky.status));
const unpick = await call(`/api/g/${link}/select`, { method: 'POST', as: 'client', body: { imageId: preview1.id, clientSessionId: 'sess-a', selected: false } });
check('favourite removed', unpick.data.selected === false && unpick.data.totalSelected === 0);
await call(`/api/g/${link}/select`, { method: 'POST', as: 'client', body: { imageId: preview1.id, clientSessionId: 'sess-a', selected: true } });

console.log('\n— who picked —');
const badEmail = await call(`/api/g/${link}/identify`, { method: 'POST', as: 'client', body: { clientSessionId: 'sess-a', clientEmail: 'not-an-email' } });
check('a malformed email is refused', badEmail.status === 400, String(badEmail.status));
const identified = await call(`/api/g/${link}/identify`, { method: 'POST', as: 'client', body: { clientSessionId: 'sess-a', clientName: 'Ana', clientEmail: '  Ana@Example.COM ' } });
check('identity lands on picks already made', identified.status === 200 && identified.data.updated >= 1, JSON.stringify(identified.data));
const studioView = await call(`/api/folders/${gallery.id}`);
check('the studio sees the email, normalised', studioView.data.selections.some((s) => s.clientEmail === 'ana@example.com'));
check('restore refuses an email that never picked', (await call(`/api/g/${link}/restore`, { method: 'POST', as: 'client', body: { clientEmail: 'someone@else.test' } })).status === 404);
const restored = await call(`/api/g/${link}/restore`, { method: 'POST', as: 'client', body: { clientEmail: 'ana@example.com' } });
check('restore hands back the original session', restored.status === 200 && restored.data.clientSessionId === 'sess-a', JSON.stringify(restored.data));
check('restore reports how many picks are waiting', restored.data.total >= 1);

console.log('\n— downloads and the PIN —');
check('preview is viewable', (await call(`/i/${preview1.id}`, { as: 'client' })).status === 200);
check('locked image is not viewable', (await call(`/i/${deliverable.id}`, { as: 'client' })).status === 404);
check('download refused with no PIN set', (await call(`/d/${deliverable.id}`, { as: 'client' })).status === 404);
const noPinUnlock = await call(`/api/g/${link}/unlock`, { method: 'POST', as: 'client', body: { pin: '1234' } });
check('unlock refused while no PIN exists', noPinUnlock.status === 409, String(noPinUnlock.status));
check('short PIN rejected', (await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { downloadPin: '12' } })).status === 400);
const setPin = await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { downloadPin: '4821' } });
check('PIN set', setPin.status === 200 && setPin.data.folder.hasPin === true);
check('PIN never comes back from the API', !JSON.stringify(setPin.data).includes('4821'));
check('wrong PIN rejected', (await call(`/api/g/${link}/unlock`, { method: 'POST', as: 'client', body: { pin: '0000' } })).status === 401);
check('locked image still 404s before unlocking, not 401', (await call(`/d/${deliverable.id}`, { as: 'client' })).status === 404);
check('visible downloadable image asks for the PIN', (await call(`/d/${proof.id}`, { as: 'client' })).status === 401);
const unlock = await call(`/api/g/${link}/unlock`, { method: 'POST', as: 'client', body: { pin: '4821' } });
check('right PIN accepted', unlock.status === 200 && [...jars.client.keys()].some((k) => k.startsWith('dl_')));

const unlockedView = await call(`/api/g/${link}?clientSessionId=sess-a`, { as: 'client' });
const unlockedFinal = unlockedView.data.tabs.find((t) => t.id === finalTab.id);
check('locked tab opens after the PIN', unlockedFinal.locked === false && unlockedFinal.images.length === 1);
check('gallery reports itself unlocked', unlockedView.data.gallery.unlocked === true);
const download = await call(`/d/${deliverable.id}`, { as: 'client' });
check('download authorised after the PIN', download.status === 200);
check('download is sent as an attachment', /attachment/.test(download.res.headers.get('content-disposition') || ''));
check('preview tab is still not downloadable', (await call(`/d/${preview1.id}`, { as: 'client' })).status === 403);
check('open downloadable tab downloads after the PIN', (await call(`/d/${proof.id}`, { as: 'client' })).status === 200);
await call(`/api/g/${link}/select`, { method: 'POST', as: 'client', body: { imageId: deliverable.id, clientSessionId: 'sess-a', selected: true } });

console.log('\n— zipping a selection —');
const zipped = await call(`/api/g/${link}/selection.zip?clientSessionId=sess-a`, { as: 'client' });
check('archive served while unlocked', zipped.status === 200, String(zipped.status));
check('served as a zip attachment',
  (zipped.res.headers.get('content-type') || '').includes('application/zip')
  && /attachment/.test(zipped.res.headers.get('content-disposition') || ''));
const zipBytes = Buffer.from(await zipped.res.arrayBuffer());
check('starts with the local file header magic', zipBytes.subarray(0, 4).toString('hex') === '504b0304', zipBytes.subarray(0, 4).toString('hex'));
check('ends with an end-of-central-directory record', zipBytes.subarray(-22, -18).toString('hex') === '504b0506', zipBytes.subarray(-22, -18).toString('hex'));
// One favourite sits in a downloadable tab; the other does not, and must not
// be smuggled into the archive.
check('only the downloadable pick is inside', zipBytes.includes(Buffer.from('FINAL-0041.png')) && !zipBytes.includes(Buffer.from('preview-01.png')));
check('an empty tab has no archive', (await call(`/api/tabs/${finalTab.id}/images.zip`)).status === 200);
const emptyTab = (await call(`/api/folders/${gallery.id}/tabs`, { method: 'POST', body: { title: 'Nothing here' } })).data.tab;
check('zipping an empty tab is refused', (await call(`/api/tabs/${emptyTab.id}/images.zip`)).status === 404);
check('a signed-out visitor cannot zip a tab', (await call(`/api/tabs/${finalTab.id}/images.zip`, { as: 'client' })).status === 401);

console.log('\n— handoff webhook —');
const noHook = await call(`/api/g/${link}/handoff`, { method: 'POST', as: 'client', body: { clientSessionId: 'sess-a' } });
check('handoff refused with nowhere to send', noHook.status === 501, String(noHook.status));
check('bad webhook URL rejected', (await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { webhookUrl: 'javascript:alert(1)' } })).status === 400);
await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { webhookUrl: hook.url } });
const sent = await call(`/api/g/${link}/handoff`, { method: 'POST', as: 'client', body: { clientSessionId: 'sess-a', clientName: 'Ana' } });
check('handoff succeeds on a 200', sent.status === 200 && sent.data.ok === true, JSON.stringify(sent.data));
const payload = hook.last()?.body;
check('webhook carries the gallery id', payload?.galleryId === gallery.id);
check('webhook carries total_selected', payload?.total_selected === 2, JSON.stringify(payload?.total_selected));
check('webhook carries the selected file names', Array.isArray(payload?.selected_files)
  && payload.selected_files.includes('preview-01.png')
  && payload.selected_files.includes('FINAL-0041.png'), JSON.stringify(payload?.selected_files));
check('webhook names the tab each file came from', payload?.selections?.some((s) => s.tab === 'Final images'));
check('webhook carries the client email', payload?.clientEmail === 'ana@example.com', JSON.stringify(payload?.clientEmail));

hook.answerWith(500);
const failed = await call(`/api/g/${link}/handoff`, { method: 'POST', as: 'client', body: { clientSessionId: 'sess-a' } });
check('a non-200 webhook is reported as a failure', failed.status === 502 && failed.data.webhookStatus === 500, JSON.stringify(failed.data));
hook.answerWith(201);
const not201 = await call(`/api/g/${link}/handoff`, { method: 'POST', as: 'client', body: { clientSessionId: 'sess-a' } });
check('even a 201 counts as not delivered', not201.status === 502, String(not201.status));
hook.answerWith(200);
const emptyHandoff = await call(`/api/g/${link}/handoff`, { method: 'POST', as: 'client', body: { clientSessionId: 'sess-empty' } });
check('handoff with nothing picked is refused', emptyHandoff.status === 400);

console.log('\n— branding —');
check('a bad colour is refused', (await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { brandColor: 'reddish' } })).status === 400);
const branded = await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { brandColor: '#2f6f4f', watermarkText: 'Ana & Tom Studio' } });
check('accent colour saved', branded.data.folder.brandColor === '#2f6f4f');
check('watermark text saved', branded.data.folder.watermarkText === 'Ana & Tom Studio');
const PNG_LOGO = PNG;
const logoUp = await call(`/api/folders/${gallery.id}/logo`, { method: 'POST', raw: PNG_LOGO, headers: { 'content-type': 'image/png' } });
check('logo uploaded', logoUp.status === 200 && logoUp.data.folder.logoUrl === `/logo/${gallery.id}`);
check('logo is served', (await call(`/logo/${gallery.id}`, { as: 'client' })).status === 200);
check('a text file is not accepted as a logo', (await call(`/api/folders/${gallery.id}/logo`, { method: 'POST', raw: 'x', headers: { 'content-type': 'text/plain' } })).status === 415);
const brandedView = await call(`/api/g/${link}?clientSessionId=sess-a`, { as: 'client' });
check('the client gallery carries the branding', brandedView.data.gallery.brandColor === '#2f6f4f' && brandedView.data.gallery.logoUrl === `/logo/${gallery.id}`);

console.log('\n— ratings and comments —');
// Rating a photo you have not hearted must not heart it for you.
const untouched = (await call(`/api/g/${link}/select`, { method: 'POST', as: 'client', body: { imageId: preview2.id, clientSessionId: 'sess-rate', rating: 3 } })).data;
check('a rating alone does not favourite the photo', untouched.selected === false && untouched.rating === 3, JSON.stringify(untouched));
check('but it is remembered', (await call(`/api/g/${link}?clientSessionId=sess-rate`, { as: 'client' })).data.feedback.some((f) => f.id === preview2.id && f.rating === 3));
const rated = await call(`/api/g/${link}/select`, { method: 'POST', as: 'client', body: { imageId: preview1.id, clientSessionId: 'sess-a', rating: 4, note: 'love the light here' } });
check('rating and note saved together', rated.data.rating === 4 && rated.data.note === 'love the light here');
check('a rating is clamped to 0–5', (await call(`/api/g/${link}/select`, { method: 'POST', as: 'client', body: { imageId: preview1.id, clientSessionId: 'sess-a', rating: 99 } })).data.rating === 5);
const withNote = await call(`/api/g/${link}?clientSessionId=sess-a`, { as: 'client' });
check('the favourite carries its note and stars back', withNote.data.favorites.some((f) => f.note === 'love the light here' && f.rating === 5));
const unhearted = await call(`/api/g/${link}/select`, { method: 'POST', as: 'client', body: { imageId: preview1.id, clientSessionId: 'sess-a', selected: false } });
check('un-hearting drops it from the favourites', unhearted.data.selected === false);
const studioSees = await call(`/api/folders/${gallery.id}`);
check('but the studio still has the comment', studioSees.data.selections.some((s) => s.imageId === preview1.id && s.note === 'love the light here'));
await call(`/api/g/${link}/select`, { method: 'POST', as: 'client', body: { imageId: preview1.id, clientSessionId: 'sess-a', selected: true } });

console.log('\n— more webhook events —');
await new Promise((r) => setTimeout(r, 300));
const before = hook.received.length;
const childFolder = (await call('/api/folders', { method: 'POST', body: { parentId: gallery.id, title: 'Portraits' } })).data.folder;
await new Promise((r) => setTimeout(r, 400));
check('gallery.created fires', hook.received.slice(before).some((r) => r.body?.event === 'gallery.created'), JSON.stringify(hook.received.slice(before).map((r) => r.body?.event)));
const beforePublish = hook.received.length;
await call(`/api/folders/${childFolder.id}`, { method: 'PATCH', body: { status: 'published' } });
await new Promise((r) => setTimeout(r, 400));
check('gallery.published fires', hook.received.slice(beforePublish).some((r) => r.body?.event === 'gallery.published'));
const beforeComment = hook.received.length;
await call(`/api/g/${link}/select`, { method: 'POST', as: 'client', body: { imageId: preview1.id, clientSessionId: 'sess-a', note: 'second thought' } });
await new Promise((r) => setTimeout(r, 400));
check('comment.posted fires', hook.received.slice(beforeComment).some((r) => r.body?.event === 'comment.posted'));
const beforeUpload = hook.received.length;
await upload(previewTab.id, 'quiet.png');
await new Promise((r) => setTimeout(r, 400));
check('file.uploaded stays off unless asked for', !hook.received.slice(beforeUpload).some((r) => r.body?.event === 'file.uploaded'));
await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { webhookEvents: ['file.uploaded'] } });
const beforeOptIn = hook.received.length;
await upload(previewTab.id, 'noisy.png');
await new Promise((r) => setTimeout(r, 400));
check('file.uploaded fires once opted in', hook.received.slice(beforeOptIn).some((r) => r.body?.event === 'file.uploaded'));
await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { webhookEvents: null } });

console.log('\n— analytics —');
const stats = (await call(`/api/folders/${gallery.id}`)).data.folder;
check('views were counted', stats.views > 0, String(stats.views));
check('downloads were counted', stats.downloads > 0, String(stats.downloads));

console.log('\n— expiry —');
check('a nonsense date is refused', (await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { expiresAt: 'whenever' } })).status === 400);
await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { expiresAt: '2020-01-01T00:00:00Z' } });
const gone = await call(`/api/g/${link}?clientSessionId=sess-a`, { as: 'client' });
check('an expired gallery closes its link', gone.status === 410, String(gone.status));
await new Promise((r) => setTimeout(r, 400));
check('gallery.expired fires', hook.received.some((r) => r.body?.event === 'gallery.expired'));
await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { expiresAt: '' } });
check('clearing the date reopens it', (await call(`/api/g/${link}?clientSessionId=sess-a`, { as: 'client' })).status === 200);

console.log('\n— locking again —');
await call(`/api/g/${link}/lock`, { method: 'POST', as: 'client' });
const relocked = await call(`/api/g/${link}?clientSessionId=sess-a`, { as: 'client' });
check('tab locks again after signing out of the PIN', relocked.data.tabs.find((t) => t.id === finalTab.id).locked === true);
check('a favourite in a locked tab is kept but URL-free', relocked.data.favorites.some((f) => f.locked === true && !f.url));
check('locked image hidden again', (await call(`/d/${deliverable.id}`, { as: 'client' })).status === 404);
check('visible download asks for the PIN again', (await call(`/d/${proof.id}`, { as: 'client' })).status === 401);
check('the archive closes with the lock', (await call(`/api/g/${link}/selection.zip?clientSessionId=sess-a`, { as: 'client' })).status === 401);

console.log('\n— PIN use limit —');
check('a silly limit is refused', (await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { downloadPinMaxUses: -3 } })).status === 400);
const capped = await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { downloadPinMaxUses: 1 } });
check('limit set, and the earlier unlock already counted', capped.data.folder.pinMaxUses === 1 && capped.data.folder.pinUses === 1, JSON.stringify(capped.data.folder.pinUses));
const spent = await call(`/api/g/${link}/unlock`, { method: 'POST', as: 'client', body: { pin: '4821' } });
check('the right PIN is refused once its limit is spent', spent.status === 429, String(spent.status));
await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { resetPinUses: true } });
const afterReset = await call(`/api/g/${link}/unlock`, { method: 'POST', as: 'client', body: { pin: '4821' } });
check('resetting the counter lets it through again', afterReset.status === 200 && afterReset.data.usesLeft === 0, JSON.stringify(afterReset.data));
const newPin = await call(`/api/folders/${gallery.id}`, { method: 'PATCH', body: { downloadPin: '5678' } });
check('a new PIN starts on a fresh count', newPin.data.folder.pinUses === 0);
check('the old PIN stops working', (await call(`/api/g/${link}/unlock`, { method: 'POST', as: 'client', body: { pin: '4821' } })).status === 401);

console.log('\n— resetting the link —');
const relink = await call(`/api/folders/${gallery.id}/relink`, { method: 'POST' });
check('link changes', relink.data.folder.uniqueLink !== link);
check('old link stops working', (await call(`/api/g/${link}`, { as: 'client' })).status === 404);

console.log('\n— deleting —');
check('image deleted', (await call(`/api/images/${preview2.id}`, { method: 'DELETE' })).status === 200);
check('deleted image no longer served', (await call(`/i/${preview2.id}`)).status === 404);
const deleted = await call(`/api/folders/${gallery.id}`, { method: 'DELETE' });
check('folder tree deleted', deleted.status === 200 && deleted.data.deletedImages >= 2, JSON.stringify(deleted.data));
check('descendants went with it', (await call(`/api/folders/${ceremony.id}`)).status === 404);
check('folder list empty again', (await call('/api/folders')).data.folders.length === 0);

console.log('\n— assets never go stale —');
// A release changes the page, its stylesheet and its script together. If any
// of them can be served from cache while the others are fresh, the app renders
// broken — so all three must revalidate.
for (const asset of ['/', '/app.css', '/admin.js', '/gallery.js']) {
  const first = await call(asset, { as: 'none' });
  const cache = first.res.headers.get('cache-control') || '';
  check(`${asset} revalidates rather than caching`, cache.includes('no-cache'), cache);
}
const styled = await call('/app.css', { as: 'none' });
const tag = styled.res.headers.get('etag');
check('the stylesheet carries an ETag', Boolean(tag), String(tag));
const again = await call('/app.css', { as: 'none', headers: { 'if-none-match': tag } });
check('an unchanged stylesheet costs a 304', again.status === 304, String(again.status));

console.log('\n— hardening —');
check('path traversal blocked', (await call('/../package.json', { as: 'none' })).status === 404);
check('unknown endpoint 404s', (await call('/api/nope', { as: 'none' })).status === 404);
check('bad JSON rejected', (await call('/api/folders', { method: 'POST', raw: '{oops', headers: { 'content-type': 'application/json' } })).status === 400);
check('logout clears the session', (await call('/api/logout', { method: 'POST' })).status === 200 && !jars.admin.has('pose_session'));

console.log(`\n${checks - failures}/${checks} checks passed`);
await hook.stop();
await server.stop();
process.exit(failures ? 1 : 0);
