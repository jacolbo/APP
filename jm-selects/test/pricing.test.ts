import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { extrasFor, formatRand, parsePrice } from '../shared/pricing.js';
import { jpeg, tempDir } from './helpers.js';

describe('extrasFor', () => {
  it('no extras up to the package size', () => {
    expect(extrasFor(0, 20, 250)).toEqual({ selected: 0, included: 20, extra: 0, price: 250, total: 0 });
    expect(extrasFor(20, 20, 250)).toMatchObject({ extra: 0, total: 0 });
  });
  it('counts and prices every picture over the package', () => {
    expect(extrasFor(21, 20, 250)).toMatchObject({ extra: 1, total: 250 });
    expect(extrasFor(23, 20, 250)).toEqual({ selected: 23, included: 20, extra: 3, price: 250, total: 750 });
    expect(extrasFor(70, 20, 250)).toMatchObject({ extra: 50, total: 12500 });
  });
  it('goes back down when pictures are unhearted', () => {
    expect(extrasFor(22, 20, 300).total).toBe(600);
    expect(extrasFor(21, 20, 300).total).toBe(300);
    expect(extrasFor(19, 20, 300).total).toBe(0);
  });
  it('handles a free price and odd input safely', () => {
    expect(extrasFor(25, 20, 0)).toMatchObject({ extra: 5, total: 0 });
    expect(extrasFor(-3, 20, 250)).toMatchObject({ selected: 0, extra: 0, total: 0 });
  });
});

describe('formatRand', () => {
  it.each([
    [0, 'R0'],
    [250, 'R250'],
    [750, 'R750'],
    [1250, 'R1,250'],
    [12500, 'R12,500'],
    [1250000, 'R1,250,000'],
  ])('%d → %s', (n, s) => expect(formatRand(n)).toBe(s));
});

describe('parsePrice', () => {
  it.each([
    ['250', 250],
    [' R1,250 ', 1250],
    ['r300', 300],
    [0, 0],
    ['0', 0],
  ])('%j → %d', (i, o) => expect(parsePrice(i)).toBe(o));
  it.each(['', 'abc', '-5', '2.50', '9999999', null, undefined, 1.5, -1])('%j is rejected', (i) =>
    expect(parsePrice(i)).toBeNull(),
  );
});

describe('extras through the API', () => {
  const PIN = '482916';
  let app: ReturnType<typeof createApp>['app'];
  let cookie: string;
  beforeAll(async () => {
    const root = tempDir('jm-price-');
    for (let i = 1; i <= 6; i++) await jpeg(path.join(root, '2026', 'W1 backup', 'C', `P_${i}.jpg`));
    app = createApp(
      loadConfig({ STAFF_PIN: PIN, PHOTOS_ROOT: root, DATA_DIR: tempDir(), WEB_DIR: '/x', EXTRA_IMAGE_PRICE: '300' }),
    ).app;
    cookie = String((await request(app).post('/api/staff/login').send({ pin: PIN })).headers['set-cookie']).split(';')[0];
  });

  it('uses EXTRA_IMAGE_PRICE as the default, staff can override per session', async () => {
    expect((await request(app).get('/api/config')).body.extraImagePrice).toBe(300);
    const a = await request(app).post('/api/staff/sessions').set('Cookie', cookie).send({ clientName: 'A', packageSize: 2, folder: '2026/W1 backup/C' });
    expect(a.body.extraPrice).toBe(300);
    const b = await request(app).post('/api/staff/sessions').set('Cookie', cookie).send({ clientName: 'B', packageSize: 2, folder: '2026/W1 backup/C', extraPrice: 'R1,250' });
    expect(b.body.extraPrice).toBe(1250);
    await request(app).post('/api/staff/sessions').set('Cookie', cookie).send({ clientName: 'X', packageSize: 2, folder: '2026/W1 backup/C', extraPrice: '-1' }).expect(400);
  });

  it('never caps selections, and staff see included/extra/total', async () => {
    const s = (await request(app).post('/api/staff/sessions').set('Cookie', cookie).send({ clientName: 'Dlamini', packageSize: 2, folder: '2026/W1 backup/C', extraPrice: 250 })).body;
    for (let i = 1; i <= 5; i++) await request(app).put(`/api/c/${s.token}/picks/P_${i}.jpg`).send({ selected: true }).expect(200);
    const client = (await request(app).get(`/api/c/${s.token}`)).body;
    expect(client.extraPrice).toBe(250);
    expect(Object.values(client.picks).filter((p: any) => p.selected)).toHaveLength(5);

    const d = (await request(app).get(`/api/staff/sessions/${s.id}`).set('Cookie', cookie)).body;
    expect(d.extras).toEqual({ selected: 5, included: 2, extra: 3, price: 250, total: 750 });

    await request(app).put(`/api/c/${s.token}/picks/P_5.jpg`).send({ selected: false }).expect(200);
    const list = (await request(app).get('/api/staff/sessions').set('Cookie', cookie)).body;
    expect(list.find((x: any) => x.id === s.id).extras).toMatchObject({ extra: 2, total: 500 });

    await request(app).patch(`/api/staff/sessions/${s.id}`).set('Cookie', cookie).send({ extraPrice: 300 }).expect(200);
    const csv = (await request(app).get(`/api/staff/sessions/${s.id}/export.csv`).set('Cookie', cookie)).text;
    expect(csv).toContain('"Client","Dlamini"');
    expect(csv).toContain('"Included in package","2"');
    expect(csv).toContain('"Extra pictures","2"');
    expect(csv).toContain('"Price per extra picture","R300"');
    expect(csv).toContain('"Extra total","R600"');
    expect(csv).toContain('"P_1.jpg","yes","0"');
  });
});
