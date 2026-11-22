import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { jpeg, tempDir } from './helpers.js';

const PIN = '482916';

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

describe('RAW project copies', () => {
  const base = tempDir('jm-nas-');
  const photos = path.join(base, 'Photos');
  const projects = path.join(base, 'Projects');
  const other = path.join(base, 'Other');
  const client = path.join(photos, '2026', 'Week 47 backup', 'Naidoo Family');
  let app: ReturnType<typeof createApp>;
  let cookie: string;
  let id: number;
  let token: string;
  let photosBefore: string;

  beforeAll(async () => {
    for (const n of ['JM_0001', 'JM_0002', 'JM_0003', 'JM_0004']) await jpeg(path.join(client, `${n}.jpg`));
    fs.writeFileSync(path.join(client, 'JM_0001.CR3'), Buffer.alloc(3000, 1));
    fs.mkdirSync(path.join(client, 'RAW'));
    fs.writeFileSync(path.join(client, 'RAW', 'jm_0002.cr3'), Buffer.alloc(4000, 2));
    fs.writeFileSync(path.join(client, 'JM_0004.NEF'), Buffer.alloc(5000, 4));
    // JM_0003 has no RAW.
    fs.mkdirSync(projects);
    fs.mkdirSync(other);
    photosBefore = snapshot(photos);

    app = createApp(
      loadConfig({ STAFF_PIN: PIN, PHOTOS_ROOT: photos, DATA_DIR: tempDir(), WEB_DIR: '/x', PROJECTS_ROOT: projects }),
    );
    const r = await request(app.app).post('/api/staff/login').send({ pin: PIN });
    cookie = String(r.headers['set-cookie']).split(';')[0];
    const s = await request(app.app)
      .post('/api/staff/sessions')
      .set('Cookie', cookie)
      .send({ clientName: 'Naidoo Family', packageSize: 10, folder: '2026/Week 47 backup/Naidoo Family' });
    id = s.body.id;
    token = s.body.token;
  });

  const heart = (f: string, on = true) =>
    request(app.app).put(`/api/c/${token}/picks/${f}`).send({ selected: on }).expect(200);
  const status = async () =>
    (await request(app.app).get(`/api/staff/sessions/${id}/raws`).set('Cookie', cookie).expect(200)).body;
  const dest = () => path.join(projects, '2026', 'Week 47', 'Naidoo Family');

  it('copies matching RAWs when the client taps "I\'m done"', async () => {
    await heart('JM_0001.jpg');
    await heart('JM_0002.jpg');
    await heart('JM_0003.jpg');
    await request(app.app).put(`/api/c/${token}/picks/JM_0004.jpg`).send({ stars: 5 }).expect(200); // rated, not hearted
    await request(app.app).post(`/api/c/${token}/done`).expect(200);
    await app.raws.idle;

    const st = await status();
    expect(st).toMatchObject({
      enabled: true,
      state: 'done_with_issues',
      destination: '2026/Week 47/Naidoo Family',
      totalFiles: 2,
      doneFiles: 2,
      copied: 2,
      alreadyThere: 0,
      missing: ['JM_0003.jpg'],
      problems: [],
    });
    expect(fs.readdirSync(dest()).sort()).toEqual(['JM_0001.CR3', 'jm_0002.cr3']);
    expect(fs.statSync(path.join(dest(), 'jm_0002.cr3')).size).toBe(4000);
  });

  it('shows the state on the session list', async () => {
    const r = await request(app.app).get('/api/staff/sessions').set('Cookie', cookie).expect(200);
    expect(r.body[0].rawState).toBe('done_with_issues');
  });

  it('"Re-copy RAWs" after unlocking adds new picks without duplicating', async () => {
    await request(app.app).post(`/api/staff/sessions/${id}/unlock`).set('Cookie', cookie).expect(200);
    await heart('JM_0004.jpg');
    await heart('JM_0001.jpg', false); // unselected: its RAW copy is left in place, never deleted
    const before = fs.statSync(path.join(dest(), 'jm_0002.cr3')).mtimeMs;
    await request(app.app).post(`/api/staff/sessions/${id}/raws`).set('Cookie', cookie).expect(202);
    await app.raws.idle;

    const st = await status();
    expect(st).toMatchObject({ copied: 1, alreadyThere: 1, totalFiles: 2, missing: ['JM_0003.jpg'] });
    expect(fs.readdirSync(dest()).sort()).toEqual(['JM_0001.CR3', 'JM_0004.NEF', 'jm_0002.cr3']);
    expect(fs.statSync(path.join(dest(), 'jm_0002.cr3')).mtimeMs).toBe(before); // not rewritten
  });

  it('never changes the photos folder and never writes outside the projects folder', () => {
    expect(snapshot(photos)).toBe(photosBefore);
    expect(fs.readdirSync(other)).toEqual([]);
    expect(fs.readdirSync(base).sort()).toEqual(['Other', 'Photos', 'Projects']);
  });

  it('a client name that tries to escape stays inside the projects folder', async () => {
    const s = await request(app.app)
      .post('/api/staff/sessions')
      .set('Cookie', cookie)
      .send({ clientName: '../../Other', packageSize: 5, folder: '2026/Week 47 backup/Naidoo Family' });
    await request(app.app).put(`/api/c/${s.body.token}/picks/JM_0004.jpg`).send({ selected: true }).expect(200);
    await request(app.app).post(`/api/c/${s.body.token}/done`).expect(200);
    await app.raws.idle;
    expect(fs.readdirSync(other)).toEqual([]);
    expect(fs.existsSync(path.join(projects, '2026', 'Week 47', 'Other', 'JM_0004.NEF'))).toBe(true);
  });

  it('staff endpoints need the PIN', async () => {
    await request(app.app).post(`/api/staff/sessions/${id}/raws`).expect(401);
    await request(app.app).get(`/api/staff/sessions/${id}/raws`).expect(401);
  });
});

describe('without a projects folder', () => {
  it('reports the feature as off and "I\'m done" still works', async () => {
    const base = tempDir('jm-nas2-');
    await jpeg(path.join(base, '2026', 'W backup', 'C', 'A.jpg'));
    const app = createApp(loadConfig({ STAFF_PIN: PIN, PHOTOS_ROOT: base, DATA_DIR: tempDir(), WEB_DIR: '/x' }));
    const c = String((await request(app.app).post('/api/staff/login').send({ pin: PIN })).headers['set-cookie']).split(';')[0];
    const s = await request(app.app).post('/api/staff/sessions').set('Cookie', c).send({ clientName: 'C', packageSize: 5, folder: '2026/W backup/C' });
    await request(app.app).post(`/api/c/${s.body.token}/done`).expect(200);
    const st = await request(app.app).get(`/api/staff/sessions/${s.body.id}/raws`).set('Cookie', c).expect(200);
    expect(st.body).toMatchObject({ enabled: false, state: null });
    await request(app.app).post(`/api/staff/sessions/${s.body.id}/raws`).set('Cookie', c).expect(400);
  });
});
