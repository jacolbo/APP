// End-to-end API test. Starts its own server on a free port with a temporary
// data directory, exercises every endpoint, then cleans up after itself.
//   node test/smoke.mjs
import { startServer } from './helpers/server.mjs';

const server = await startServer();
const BASE = server.base;
const PASSWORD = server.password;

let cookie = '';
let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${detail}`); }
}

async function call(path, { method = 'GET', body, raw, headers = {}, auth = true } = {}) {
  const h = { ...headers };
  if (auth && cookie) h.cookie = cookie;
  let payload = raw;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json().catch(() => ({})) : null;
  return { status: res.status, data, res };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

console.log('\n— health & session —');
check('GET /health', (await call('/health', { auth: false })).status === 200);
const session = await call('/api/session', { auth: false });
check('session starts signed out', session.data.authed === false, JSON.stringify(session.data));

console.log('\n— auth —');
check('static admin page served', (await call('/', { auth: false })).status === 200);
check('collections blocked when signed out', (await call('/api/collections', { auth: false })).status === 401);
check('wrong password rejected', (await call('/api/login', { method: 'POST', body: { password: 'nope' }, auth: false })).status === 401);
const login = await call('/api/login', { method: 'POST', body: { password: PASSWORD }, auth: false });
check('correct password accepted', login.status === 200 && cookie.startsWith('pose_session='), cookie);
check('session now authed', (await call('/api/session')).data.authed === true);

console.log('\n— collections —');
check('empty title rejected', (await call('/api/collections', { method: 'POST', body: { title: '  ' } })).status === 400);
const created = await call('/api/collections', { method: 'POST', body: { title: 'Maternity — studio', clientName: 'Sarah', description: 'Golden hour ideas' } });
check('collection created', created.status === 201 && created.data.collection.id.startsWith('col_'));
const col = created.data.collection;
check('new collection is a draft', col.published === false);
check('share id generated', typeof col.shareId === 'string' && col.shareId.startsWith('s_'));

console.log('\n— uploads —');
const badType = await call(`/api/collections/${col.id}/photos`, { method: 'POST', raw: Buffer.from('hello'), headers: { 'content-type': 'text/plain' } });
check('non-image upload rejected (415)', badType.status === 415, String(badType.status));
const up1 = await call(`/api/collections/${col.id}/photos?w=1&h=1`, { method: 'POST', raw: PNG, headers: { 'content-type': 'image/png', 'x-filename': 'pose-one.png' } });
check('photo uploaded', up1.status === 201 && up1.data.photo.id.startsWith('ph_'), JSON.stringify(up1.data));
const photo1 = up1.data.photo;
check('original filename kept', photo1.originalName === 'pose-one.png');
check('size recorded', photo1.size === PNG.length, `${photo1.size} vs ${PNG.length}`);
const thumb = await call(`/api/photos/${photo1.id}/thumbnail`, { method: 'POST', raw: JPEG, headers: { 'content-type': 'image/jpeg' } });
check('thumbnail attached', thumb.status === 200 && thumb.data.photo.hasThumb === true);
const up2 = await call(`/api/collections/${col.id}/photos`, { method: 'POST', raw: PNG, headers: { 'content-type': 'image/png', 'x-filename': 'pose-two.png' } });
const photo2 = up2.data.photo;
check('second photo uploaded', up2.status === 201);
check('sort order increments', photo2.sort === photo1.sort + 1, `${photo1.sort} → ${photo2.sort}`);

console.log('\n— image access control —');
check('owner can fetch full image', (await call(`/f/${photo1.id}`)).status === 200);
check('owner can fetch thumbnail', (await call(`/t/${photo1.id}`)).status === 200);
check('draft image hidden from public', (await call(`/f/${photo1.id}`, { auth: false })).status === 404);

console.log('\n— editing —');
const edited = await call(`/api/photos/${photo1.id}`, { method: 'PATCH', body: { title: 'Hands in pockets', notes: 'Shoot from the left', tags: ['Standing', 'standing', 'outdoor'] } });
check('photo metadata saved', edited.data.photo.title === 'Hands in pockets');
check('tags normalised + de-duplicated', JSON.stringify(edited.data.photo.tags) === JSON.stringify(['standing', 'outdoor']), JSON.stringify(edited.data.photo.tags));
const reordered = await call(`/api/collections/${col.id}/order`, { method: 'POST', body: { ids: [photo2.id, photo1.id] } });
check('reorder applied', reordered.data.photos[0].id === photo2.id);

console.log('\n— sharing —');
check('draft gallery not viewable', (await call(`/api/share/${col.shareId}`, { auth: false })).status === 404);
await call(`/api/collections/${col.id}`, { method: 'PATCH', body: { published: true } });
const shared = await call(`/api/share/${col.shareId}`, { auth: false });
check('published gallery viewable', shared.status === 200 && shared.data.photos.length === 2);
check('gallery respects custom order', shared.data.photos[0].id === photo2.id);
check('client payload hides internals', shared.data.photos[0].originalName === undefined && shared.data.collection.pin === undefined);
check('published image now public', (await call(`/f/${photo1.id}`, { auth: false })).status === 200);
check('unknown share id 404s', (await call('/api/share/s_nope', { auth: false })).status === 404);

console.log('\n— client picks —');
const pick = await call(`/api/share/${col.shareId}/pick`, { method: 'POST', auth: false, body: { photoId: photo1.id, clientKey: 'key-abc', clientName: 'Sarah', picked: true, note: 'Love this one' } });
check('pick saved', pick.status === 200 && pick.data.picked === true, JSON.stringify(pick.data));
const mine = await call(`/api/share/${col.shareId}?clientKey=key-abc`, { auth: false });
check('client sees own pick', mine.data.picks.length === 1 && mine.data.picks[0].note === 'Love this one');
const others = await call(`/api/share/${col.shareId}?clientKey=someone-else`, { auth: false });
check('picks are per client', others.data.picks.length === 0);
const adminView = await call(`/api/collections/${col.id}`);
check('studio sees the pick', adminView.data.picks.length === 1 && adminView.data.picks[0].clientName === 'Sarah');
const foreign = await call(`/api/share/${col.shareId}/pick`, { method: 'POST', auth: false, body: { photoId: 'ph_doesnotexist', clientKey: 'key-abc', picked: true } });
check('pick on unknown photo 404s', foreign.status === 404);
const unpick = await call(`/api/share/${col.shareId}/pick`, { method: 'POST', auth: false, body: { photoId: photo1.id, clientKey: 'key-abc', clientName: 'Sarah', picked: false } });
check('un-pick works', unpick.data.picked === false);
await call(`/api/share/${col.shareId}/pick`, { method: 'POST', auth: false, body: { photoId: photo1.id, clientKey: 'key-abc', clientName: 'Sarah', picked: true, note: 'back on' } });

console.log('\n— PIN gate —');
check('bad PIN format rejected', (await call(`/api/collections/${col.id}`, { method: 'PATCH', body: { pin: 'abcd' } })).status === 400);
await call(`/api/collections/${col.id}`, { method: 'PATCH', body: { pin: '4821' } });
const noPin = await call(`/api/share/${col.shareId}`, { auth: false });
check('PIN required without it', noPin.status === 401 && noPin.data.pinRequired === true);
check('wrong PIN rejected', (await call(`/api/share/${col.shareId}?pin=0000`, { auth: false })).status === 401);
check('right PIN opens gallery', (await call(`/api/share/${col.shareId}?pin=4821`, { auth: false })).status === 200);
check('PIN accepted as a header', (await call(`/api/share/${col.shareId}`, { auth: false, headers: { 'x-gallery-pin': '4821' } })).status === 200);
check('wrong PIN header rejected', (await call(`/api/share/${col.shareId}`, { auth: false, headers: { 'x-gallery-pin': '9999' } })).status === 401);
check('PIN never leaked to client', (await call('/api/collections')).data.collections[0].pin === true);

console.log('\n— resetting the link —');
const reshared = await call(`/api/collections/${col.id}/reshare`, { method: 'POST' });
check('share id changes', reshared.data.collection.shareId !== col.shareId);
check('old link stops working', (await call(`/api/share/${col.shareId}?pin=4821`, { auth: false })).status === 404);

console.log('\n— deleting —');
const del = await call(`/api/photos/${photo2.id}`, { method: 'DELETE' });
check('photo deleted', del.status === 200);
check('deleted image gone', (await call(`/f/${photo2.id}`)).status === 404);
const afterDelete = await call(`/api/collections/${col.id}`);
check('photo removed from collection', afterDelete.data.photos.length === 1);
const delCol = await call(`/api/collections/${col.id}`, { method: 'DELETE' });
check('collection deleted', delCol.status === 200 && delCol.data.deletedPhotos === 1);
check('collection list empty again', (await call('/api/collections')).data.collections.length === 0);

console.log('\n— hardening —');
check('path traversal blocked', (await call('/../server.js', { auth: false })).status === 404);
check('unknown endpoint 404s', (await call('/api/nope')).status === 404);
check('bad JSON rejected', (await call('/api/collections', { method: 'POST', raw: '{oops', headers: { 'content-type': 'application/json' } })).status === 400);
await call('/api/logout', { method: 'POST' });
check('logout clears the session', (await call('/api/collections')).status === 401);

await server.stop();

console.log(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures ? 1 : 0);
