import jsQR from 'jsqr';
import path from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { deviceLabel, escapeWifi, namesMatch, normalizeName, qrSvg, wifiQrText } from '../server/access.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { jpeg, tempDir } from './helpers.js';

/** Render a QR SVG and read it back the way a phone camera would. */
async function decodeQr(svg: string): Promise<string | null> {
  const { data, info } = await sharp(Buffer.from(svg)).resize(600).flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
}

describe('name matching', () => {
  it.each([
    ['Thandi Nkosi', 'Thandi Nkosi'],
    ['thandi nkosi', 'Thandi Nkosi'],
    ['  THANDI    nkosi  ', 'Thandi Nkosi'],
    ['Zoë Müller', 'Zoe Muller'],
    ['zoe muller', 'Zoë Müller'],
    ['Renée Botha-Smit', 'renee botha smit'],
    ["Sean O'Neil", 'Sean ONeil'],
    ['Sean O’Neil', "sean o'neil"],
    ['François  du Plessis', 'Francois Du Plessis'],
  ])('%j matches %j', (typed, booked) => expect(namesMatch(typed, booked)).toBe(true));

  it.each([
    ['Thandi', 'Thandi Nkosi'], // first name only
    ['Thandi Nkosi Jr', 'Thandi Nkosi'],
    ['Nkosi Thandi', 'Thandi Nkosi'], // order matters
    ['', 'Thandi Nkosi'],
    ['   ', 'Thandi Nkosi'],
  ])('%j does not match %j', (typed, booked) => expect(namesMatch(typed, booked)).toBe(false));

  it('rejects non-text and absurdly long input', () => {
    expect(namesMatch(undefined, 'A')).toBe(false);
    expect(namesMatch(['A'], 'A')).toBe(false);
    expect(namesMatch('a'.repeat(500), 'a'.repeat(500))).toBe(false);
  });

  it('normalises', () => {
    expect(normalizeName('  Ñandú  ÉLAN-Smith ')).toBe('nandu elan smith');
  });
});

describe('Wi-Fi QR format', () => {
  it('uses the standard WIFI: format', () => {
    expect(wifiQrText('Jepson Myles Studio', 'secret123')).toBe('WIFI:T:WPA;S:Jepson Myles Studio;P:secret123;;');
  });
  it('escapes special characters', () => {
    expect(escapeWifi('a;b,c:d\\e"f')).toBe('a\\;b\\,c\\:d\\\\e\\"f');
    expect(wifiQrText('JM;Guest', 'p:a,s"s\\')).toBe(String.raw`WIFI:T:WPA;S:JM\;Guest;P:p\:a\,s\"s\\;;`);
  });
  it('open network without a password', () => {
    expect(wifiQrText('Open Net', '')).toBe('WIFI:T:nopass;S:Open Net;;');
  });
  it('the QR image decodes to exactly that text', async () => {
    const text = wifiQrText('Jepson Myles Studio', 'p@ss;word');
    expect(await decodeQr(await qrSvg(text))).toBe(text);
  });
});

describe('device labels', () => {
  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148', 'iPhone'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'iPad'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Mobile/15E148', 'iPad'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari', 'Android phone'],
    ['Mozilla/5.0 (Linux; Android 13; SM-X710) Safari', 'Android tablet'],
    [undefined, 'Device'],
  ])('%s → %s', (ua, label) => expect(deviceLabel(ua)).toBe(label));
});

describe('session links, names and devices', () => {
  const PIN = '482916';
  let app: ReturnType<typeof createApp>['app'];
  let staff: string;
  let s: { id: number; token: string };

  beforeAll(async () => {
    const root = tempDir('jm-acc-');
    await jpeg(path.join(root, '2026', 'W1 backup', 'Nkosi', 'A_1.jpg'));
    app = createApp(
      loadConfig({
        STAFF_PIN: PIN,
        PHOTOS_ROOT: root,
        DATA_DIR: tempDir(),
        WEB_DIR: '/x',
        WIFI_SSID: 'Jepson Myles Studio',
        WIFI_PASSWORD: 'Sup3r;Secret',
        PUBLIC_URL: 'http://192.168.101.153:8080/',
      }),
    ).app;
    staff = String((await request(app).post('/api/staff/login').send({ pin: PIN })).headers['set-cookie']).split(';')[0];
    s = (await request(app).post('/api/staff/sessions').set('Cookie', staff).send({ clientName: 'Thandi Nkosi', packageSize: 5, folder: '2026/W1 backup/Nkosi' })).body;
  });

  const join = (token: string, name: string) => request(app).post(`/api/c/${token}/join`).send({ name });
  const cookieOf = (r: request.Response) => String(r.headers['set-cookie']).split(';')[0];

  it('a new phone must confirm the name and learns nothing before that', async () => {
    const r = await request(app).get(`/api/c/${s.token}`).expect(401);
    expect(r.body).toMatchObject({ needName: true, locked: false, attemptsLeft: 5 });
    expect(JSON.stringify(r.body)).not.toContain('Nkosi');
    await request(app).get(`/img/c/${s.token}/thumb/A_1.jpg`).expect(401);
    await request(app).put(`/api/c/${s.token}/picks/A_1.jpg`).send({ selected: true }).expect(401);
    await request(app).post(`/api/c/${s.token}/done`).expect(401);
  });

  it('two phones join with the name, and see the same selections', async () => {
    const phone = cookieOf(await join(s.token, 'THANDI  nkosi').expect(200));
    const partner = cookieOf(await join(s.token, 'thandi nkosi').expect(200));
    expect(phone).not.toBe(partner);
    await request(app).put(`/api/c/${s.token}/picks/A_1.jpg`).set('Cookie', phone).send({ selected: true }).expect(200);
    const seen = await request(app).get(`/api/c/${s.token}`).set('Cookie', partner).expect(200);
    expect(seen.body.picks['A_1.jpg']).toEqual({ selected: true, stars: 0 });
    await request(app).get(`/img/c/${s.token}/thumb/A_1.jpg`).set('Cookie', partner).expect(200);
    const acc = await request(app).get(`/api/staff/sessions/${s.id}/access`).set('Cookie', staff).expect(200);
    expect(acc.body.devices).toHaveLength(2);
  });

  it('a revoked device is refused everywhere', async () => {
    const phone = cookieOf(await join(s.token, 'Thandi Nkosi').expect(200));
    const acc = await request(app).get(`/api/staff/sessions/${s.id}/access`).set('Cookie', staff);
    const dev = acc.body.devices.at(-1);
    await request(app).post(`/api/staff/sessions/${s.id}/devices/${dev.id}/revoke`).set('Cookie', staff).expect(200);
    const r = await request(app).get(`/api/c/${s.token}`).set('Cookie', phone).expect(403);
    expect(r.body.revoked).toBe(true);
    await request(app).get(`/img/c/${s.token}/preview/A_1.jpg`).set('Cookie', phone).expect(403);
    await request(app).put(`/api/c/${s.token}/picks/A_1.jpg`).set('Cookie', phone).send({ selected: false }).expect(403);
    await request(app).get(`/api/c/${s.token}/events`).set('Cookie', phone).expect(403);
  });

  it('regenerating the QR kills the old link, and old devices must join again', async () => {
    const phone = cookieOf(await join(s.token, 'Thandi Nkosi').expect(200));
    const old = s.token;
    const fresh = (await request(app).post(`/api/staff/sessions/${s.id}/regenerate`).set('Cookie', staff).expect(200)).body;
    expect(fresh.token).not.toBe(old);
    await request(app).get(`/api/c/${old}`).set('Cookie', phone).expect(404);
    await request(app).get(`/img/c/${old}/thumb/A_1.jpg`).set('Cookie', phone).expect(404);
    await join(old, 'Thandi Nkosi').expect(404);
    const r = await request(app).get(`/api/c/${fresh.token}`).set('Cookie', phone).expect(401);
    expect(r.body.needName).toBe(true);
    s = fresh;
  });

  it('wrong names: a few tries, then locked until staff reset it', async () => {
    const tries = [];
    for (let i = 0; i < 4; i++) tries.push((await join(s.token, 'Someone Else').expect(401)).body.attemptsLeft);
    expect(tries).toEqual([4, 3, 2, 1]);
    const last = await join(s.token, 'Someone Else').expect(423);
    expect(last.body).toMatchObject({ locked: true, attemptsLeft: 0 });
    await join(s.token, 'Thandi Nkosi').expect(423); // even the right name, until staff step in
    expect((await request(app).get(`/api/c/${s.token}`).expect(401)).body.locked).toBe(true);
    await request(app).post(`/api/staff/sessions/${s.id}/reset-attempts`).set('Cookie', staff).expect(200);
    await join(s.token, 'Thandi Nkosi').expect(200);
  });

  it('handing over the tablet lets it in without typing the name', async () => {
    const r = await request(app).post(`/api/staff/sessions/${s.id}/handoff`).set('Cookie', staff).expect(200);
    const cookies = r.headers['set-cookie'] as unknown as string[];
    const dev = cookies.find((c) => c.startsWith('jm_c'))!.split(';')[0];
    expect(cookies.some((c) => c.startsWith('jm_staff=;'))).toBe(true);
    await request(app).get(`/api/c/${s.token}`).set('Cookie', dev).expect(200);
  });

  it('QR codes: staff only; Wi-Fi password never sent as text; both decode correctly', async () => {
    await request(app).get('/api/staff/wifi.svg').expect(401);
    await request(app).get(`/api/staff/sessions/${s.id}/qr.svg`).expect(401);
    const info = await request(app).get('/api/staff/wifi').set('Cookie', staff).expect(200);
    expect(info.body).toEqual({ configured: true, ssid: 'Jepson Myles Studio', open: false });
    expect(JSON.stringify(info.body)).not.toContain('Secret');
    expect((await request(app).get('/api/config')).text).not.toContain('Secret');

    const wifi = await request(app).get('/api/staff/wifi.svg').set('Cookie', staff).buffer(true).parse((res, cb) => {
      let d = '';
      res.on('data', (c: Buffer) => (d += c));
      res.on('end', () => cb(null, d));
    });
    expect(await decodeQr(wifi.body as string)).toBe('WIFI:T:WPA;S:Jepson Myles Studio;P:Sup3r\\;Secret;;');

    const link = await request(app).get(`/api/staff/sessions/${s.id}/qr.svg`).set('Cookie', staff).buffer(true).parse((res, cb) => {
      let d = '';
      res.on('data', (c: Buffer) => (d += c));
      res.on('end', () => cb(null, d));
    });
    expect(await decodeQr(link.body as string)).toBe(`http://192.168.101.153:8080/c/${s.token}`);
  });
});
