import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { PinLimiter } from '../server/auth.js';
import { loadConfig } from '../server/config.js';
import { jpeg, makePhotoTree, tempDir } from './helpers.js';

const PIN = '482916';
let tree: Awaited<ReturnType<typeof makePhotoTree>>;
let app: ReturnType<typeof createApp>['app'];
let cookie: string;
let token: string;
let id: number;
let dev = '';

function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out.push(`${path.relative(dir, p)}|${st.size}|${st.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort().join('\n');
}
let before: string;

beforeAll(async () => {
  tree = await makePhotoTree();
  before = snapshot(tree.root);
  const config = loadConfig({ STAFF_PIN: PIN, PHOTOS_ROOT: tree.root, DATA_DIR: tempDir(), WEB_DIR: '/nonexistent' });
  app = createApp(config, { limiter: new PinLimiter(3, 100) }).app;
});

describe('config', () => {
  it('refuses to start without a proper PIN', () => {
    expect(() => loadConfig({})).toThrow(/STAFF_PIN/);
    expect(() => loadConfig({ STAFF_PIN: '1234' })).toThrow(/easy/);
    expect(() => loadConfig({ STAFF_PIN: 'abcd' })).toThrow(/STAFF_PIN/);
  });
});

describe('staff PIN', () => {
  it('blocks the staff area without a PIN', async () => {
    await request(app).get('/api/staff/sessions').expect(401);
    await request(app).get('/api/staff/browse').expect(401);
  });

  it('rate-limits wrong PINs per device', async () => {
    const agent = request(app);
    for (let i = 0; i < 3; i++) {
      await agent.post('/api/staff/login').set('X-Forwarded-For', '1.2.3.4').send({ pin: '000000' }).expect(401);
    }
    const r = await agent.post('/api/staff/login').send({ pin: PIN });
    expect(r.status).toBe(429); // same socket address is now locked, even with the right PIN
  });
});

describe('with a staff login', () => {
  beforeAll(async () => {
    // Fresh app so the limiter from the previous block doesn't apply.
    const config = loadConfig({ STAFF_PIN: PIN, PHOTOS_ROOT: tree.root, DATA_DIR: tempDir(), WEB_DIR: '/nonexistent' });
    app = createApp(config).app;
    const r = await request(app).post('/api/staff/login').send({ pin: PIN }).expect(200);
    cookie = String(r.headers['set-cookie']).split(';')[0];
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly/);
  });

  it('browses years, backup weeks and client folders', async () => {
    const years = await request(app).get('/api/staff/browse').set('Cookie', cookie).expect(200);
    expect(years.body.entries.map((e: { name: string }) => e.name)).toEqual(['2026', '2025']);
    const weeks = await request(app).get('/api/staff/browse?path=2026').set('Cookie', cookie).expect(200);
    expect(weeks.body.entries.map((e: { name: string }) => e.name)).toEqual(['Week 12 backup']);
  });

  it('rejects traversal in browse and session folders', async () => {
    await request(app).get('/api/staff/browse?path=../').set('Cookie', cookie).expect(400);
    await request(app).get('/api/staff/browse?path=2026/../..').set('Cookie', cookie).expect(400);
    await request(app)
      .post('/api/staff/sessions')
      .set('Cookie', cookie)
      .send({ clientName: 'X', packageSize: 10, folder: '2026/Week 12 backup/Sneaky Link' })
      .expect(400);
    await request(app)
      .post('/api/staff/sessions')
      .set('Cookie', cookie)
      .send({ clientName: 'X', packageSize: 10, folder: '2026' })
      .expect(400);
  });

  it('starts a session', async () => {
    const r = await request(app)
      .post('/api/staff/sessions')
      .set('Cookie', cookie)
      .send({ clientName: 'Smith Family', packageSize: 2, folder: '2026/Week 12 backup/Smith Family' })
      .expect(201);
    token = r.body.token;
    id = r.body.id;
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    // The client confirms their name on their device.
    const j = await request(app).post(`/api/c/${token}/join`).send({ name: '  smith   FAMILY ' }).expect(200);
    dev = String(j.headers['set-cookie']).split(';')[0];
    expect(dev).toMatch(/^jm_c\d+=/);
  });

  it('client sees only JPEGs in their folder', async () => {
    const r = await request(app).get(`/api/c/${token}`).set('Cookie', dev).expect(200);
    expect(r.body.photos.map((p: { name: string }) => p.name)).toEqual(['JM_0001.jpeg', 'JM_0002.JPG', 'JM_0010.jpg']);
    expect(r.body).not.toHaveProperty('folder');
    expect(r.body.packageSize).toBe(2);
  });

  it('serves thumbnails with EXIF orientation applied', async () => {
    const r = await request(app).get(`/img/c/${token}/thumb/JM_0001.jpeg`).set('Cookie', dev).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(r.body as Buffer).metadata();
    // Original is 64x48 with orientation 6 (rotate 90°) → displayed 48x64.
    expect([meta.width, meta.height]).toEqual([48, 64]);
  });

  it('refuses images outside the folder, RAWs and junk', async () => {
    for (const f of ['..%2F..%2Fsecret.jpg', 'linked.jpg', 'JM_0001.CR3', 'notes.txt', '._JM_0010.jpg', 'nope.jpg']) {
      const r = await request(app).get(`/img/c/${token}/thumb/${f}`).set('Cookie', dev);
      expect([400, 404]).toContain(r.status);
    }
    await request(app).get(`/img/c/${token}/original/JM_0010.jpg`).set('Cookie', dev).expect(404);
    await request(app).get(`/img/c/notarealtoken12345/thumb/JM_0010.jpg`).set('Cookie', dev).expect(404);
  });

  it('saves hearts and stars instantly', async () => {
    await request(app).put(`/api/c/${token}/picks/JM_0010.jpg`).set('Cookie', dev).send({ selected: true }).expect(200);
    await request(app).put(`/api/c/${token}/picks/JM_0010.jpg`).set('Cookie', dev).send({ stars: 5 }).expect(200);
    await request(app).put(`/api/c/${token}/picks/JM_0002.JPG`).set('Cookie', dev).send({ selected: true, stars: 3 }).expect(200);
    await request(app).put(`/api/c/${token}/picks/JM_0001.jpeg`).set('Cookie', dev).send({ stars: 4 }).expect(200);
    await request(app).put(`/api/c/${token}/picks/JM_0001.jpeg`).set('Cookie', dev).send({ stars: 9 }).expect(400);
    await request(app).put(`/api/c/${token}/picks/JM_0001.CR3`).set('Cookie', dev).send({ selected: true }).expect(404);
    await request(app).put(`/api/c/${token}/picks/..%2Fx.jpg`).set('Cookie', dev).send({ selected: true }).expect(400);
    const r = await request(app).get(`/api/c/${token}`).set('Cookie', dev).expect(200);
    expect(r.body.picks['JM_0010.jpg']).toEqual({ selected: true, stars: 5 });
  });

  it('copy list for Capture One', async () => {
    const a = await request(app).get(`/api/staff/sessions/${id}/copylist?filter=hearted&ext=0`).set('Cookie', cookie);
    expect(a.body.text).toBe('JM_0002,JM_0010');
    const b = await request(app).get(`/api/staff/sessions/${id}/copylist?filter=stars&minStars=4&ext=1`).set('Cookie', cookie);
    expect(b.body.text).toBe('JM_0001.jpeg,JM_0010.jpg');
    await request(app).get(`/api/staff/sessions/${id}/copylist`).expect(401);
  });

  it('exports CSV', async () => {
    const r = await request(app).get(`/api/staff/sessions/${id}/export.csv`).set('Cookie', cookie).expect(200);
    expect(r.headers['content-disposition']).toMatch(/JM-Selects-Smith-Family/);
    expect(r.text).toContain('"JM_0010.jpg","yes","5"');
  });

  it('new JPEGs appear on refresh', async () => {
    await jpeg(path.join(tree.client, 'JM_0003.jpg'));
    const r = await request(app).get(`/api/c/${token}?refresh=1`).set('Cookie', dev).expect(200);
    expect(r.body.photos).toHaveLength(4);
    fs.rmSync(path.join(tree.client, 'JM_0003.jpg'));
    before = snapshot(tree.root); // our own test edit; the app itself must not change anything
  });

  it('"I\'m done" locks changes until staff unlock', async () => {
    await request(app).post(`/api/c/${token}/done`).set('Cookie', dev).expect(200);
    await request(app).put(`/api/c/${token}/picks/JM_0010.jpg`).set('Cookie', dev).send({ selected: false }).expect(409);
    await request(app).post(`/api/staff/sessions/${id}/unlock`).set('Cookie', cookie).expect(200);
    await request(app).put(`/api/c/${token}/picks/JM_0010.jpg`).set('Cookie', dev).send({ selected: false }).expect(200);
  });

  it('lists sessions with counts', async () => {
    const r = await request(app).get('/api/staff/sessions').set('Cookie', cookie).expect(200);
    expect(r.body[0]).toMatchObject({ clientName: 'Smith Family', status: 'in_progress', selectedCount: 1 });
  });

  it('handoff signs staff out', async () => {
    const r = await request(app).post(`/api/staff/sessions/${id}/handoff`).set('Cookie', cookie).expect(200);
    expect(r.body.url).toBe(`/c/${token}`);
    expect(String(r.headers['set-cookie'])).toMatch(/Max-Age=0/);
  });

  it('reset and delete touch app data only', async () => {
    await request(app).post(`/api/staff/sessions/${id}/reset`).set('Cookie', cookie).expect(200);
    const r = await request(app).get(`/api/c/${token}`).set('Cookie', dev).expect(200);
    expect(r.body.picks).toEqual({});
    await request(app).delete(`/api/staff/sessions/${id}`).set('Cookie', cookie).expect(200);
    await request(app).get(`/api/c/${token}`).set('Cookie', dev).expect(404);
    expect(snapshot(tree.root)).toBe(before);
  });
});
