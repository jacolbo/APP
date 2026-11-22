import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  PinLimiter,
  clearCookieHeader,
  loadSecret,
  makeStaffCookie,
  pinMatches,
  readCookie,
  setCookieHeader,
  verifyStaffCookie,
} from './auth.js';
import type { Config } from './config.js';
import { buildCopyList, buildCsv } from './copylist.js';
import { extrasFor, parsePrice } from '../shared/pricing.js';
import { Store, type SessionRow } from './db.js';
import { ImageCache, type Variant } from './images.js';
import { PathError, cleanFileName, cleanRelPath, resolveInside } from './paths.js';
import { FolderCache, browse, isJpeg } from './photos.js';
import { RawCopier } from './rawjobs.js';
import { deviceLabel, hashKey, namesMatch, newDeviceKey, qrSvg, wifiQrText } from './access.js';
import { LiveBus } from './live.js';
import type { DeviceRow } from './db.js';

export interface AppDeps {
  config: Config;
  store: Store;
  images: ImageCache;
  folders: FolderCache;
  limiter: PinLimiter;
  raws: RawCopier;
  live: LiveBus;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const DEVICE_DAYS = 60;
const deviceCookieName = (sessionId: number) => `jm_c${sessionId}`;
const deviceCookie = (sessionId: number, key: string) =>
  `${deviceCookieName(sessionId)}=${key}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DEVICE_DAYS * 86400}`;

type Handler = (req: Request, res: Response) => unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

export function createApp(config: Config, overrides: Partial<AppDeps> = {}) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const store = overrides.store ?? new Store(config.dataDir);
  const images = overrides.images ?? new ImageCache(config.dataDir);
  const folders = overrides.folders ?? new FolderCache();
  const limiter = overrides.limiter ?? new PinLimiter();
  const secret = loadSecret(config.dataDir);
  const live = overrides.live ?? new LiveBus();
  // Wrong names from one address across all sessions (on top of the per-session limit).
  const joinLimiter = new PinLimiter(15, 1000);
  const raws =
    overrides.raws ??
    new RawCopier(store, { photosRoot: config.photosRoot, projectsRoot: config.projectsRoot, backupSuffix: config.backupSuffix });

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', 'weak');
  app.use(express.json({ limit: '16kb' }));

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    next();
  });

  // ---------- helpers ----------
  const isStaff = (req: Request) => verifyStaffCookie(secret, readCookie(req.headers.cookie));
  const requireStaff = (req: Request, _res: Response, next: NextFunction) =>
    isStaff(req) ? next() : next(new HttpError(401, 'Staff PIN required'));

  const sessionById = (req: Request): SessionRow => {
    const id = Number.parseInt(String(req.params.id), 10);
    const s = Number.isInteger(id) ? store.getSession(id) : undefined;
    if (!s) throw new HttpError(404, 'Session not found');
    return s;
  };
  const sessionByToken = (req: Request): SessionRow => {
    const token = String(req.params.token);
    const s = /^[A-Za-z0-9_-]{16,64}$/.test(token) ? store.getSessionByToken(token) : undefined;
    if (!s) throw new HttpError(404, 'This selection link is not valid. Please ask the studio.');
    return s;
  };
  const folderAbs = (s: SessionRow) => {
    try {
      return resolveInside(config.photosRoot, s.folder);
    } catch {
      throw new HttpError(404, 'The photo folder for this session can no longer be found.');
    }
  };
  const photosFor = async (s: SessionRow, force = false) => folders.get(folderAbs(s), force);

  /** Validates that `file` is a JPEG directly inside the session's folder. */
  const photoFile = (s: SessionRow, file: unknown): string => {
    const name = cleanFileName(file);
    if (!isJpeg(name)) throw new HttpError(404, 'Not found');
    const dir = folderAbs(s);
    const abs = resolveInside(config.photosRoot, `${s.folder}/${name}`);
    if (path.dirname(abs) !== dir) throw new HttpError(404, 'Not found');
    return abs;
  };

  /**
   * A client device may use a session only after confirming the client's name on it
   * (or when staff handed over the tablet). Staff, signed in, can always look.
   */
  const clientAccess = (req: Request, s: SessionRow): { device: DeviceRow | null; staff: boolean } => {
    if (isStaff(req)) return { device: null, staff: true };
    const key = readCookie(req.headers.cookie, deviceCookieName(s.id));
    const d = key && key.length < 100 ? store.deviceByKey(s.id, hashKey(key)) : undefined;
    if (!d) {
      const left = Math.max(0, config.maxJoinAttempts - s.join_failures);
      throw new HttpError(401, 'Please confirm your name', { needName: true, locked: left === 0, attemptsLeft: left });
    }
    if (d.revoked_at) {
      throw new HttpError(403, 'The studio has removed this device’s access to the gallery. Please ask the studio team.', {
        revoked: true,
      });
    }
    if (Date.now() - d.last_seen > 30_000) store.touchDevice(d.id);
    return { device: d, staff: false };
  };

  const newDevice = (s: SessionRow, req: Request, via: 'name' | 'tablet') => {
    const key = newDeviceKey();
    store.addDevice(s.id, hashKey(key), deviceLabel(req.headers['user-agent']), via);
    return deviceCookie(s.id, key);
  };

  /** Base address for QR codes: PUBLIC_URL, or the address staff used to open the app. */
  const baseUrl = (req: Request) => {
    if (config.publicUrl) return config.publicUrl;
    const host = String(req.headers.host ?? '');
    return /^[A-Za-z0-9.\-[\]:]{1,100}$/.test(host) ? `http://${host}` : `http://localhost:${config.port}`;
  };
  const sessionLink = (req: Request, s: SessionRow) => `${baseUrl(req)}/c/${s.token}`;

  const sendSvg = (res: Response, svg: string) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('image/svg+xml');
    res.send(svg);
  };

  const sessionJson = (s: SessionRow) => ({
    id: s.id,
    token: s.token,
    clientName: s.client_name,
    folder: s.folder,
    packageSize: s.package_size,
    extraPrice: s.extra_price,
    status: s.status,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    doneAt: s.done_at,
  });

  const rawStatus = (s: SessionRow) => {
    const r = raws.status(s.id);
    return {
      enabled: raws.enabled(),
      projectsLabel: config.projectsLabel,
      ...(r ?? { state: null }),
    };
  };

  const clientPayload = async (s: SessionRow, force = false) => {
    const photos = await photosFor(s, force);
    const picks = store.getPicks(s.id);
    return {
      clientName: s.client_name,
      packageSize: s.package_size,
      extraPrice: s.extra_price,
      status: s.status,
      photos: photos.map((p) => ({ name: p.name, v: Math.round(p.mtimeMs).toString(36) })),
      picks: Object.fromEntries(picks.map((p) => [p.file_name, { selected: !!p.selected, stars: p.stars }])),
    };
  };

  // ---------- public ----------
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/config', (_req, res) => {
    res.json({ packageSizes: config.packageSizes, extraImagePrice: config.extraImagePrice });
  });

  // ---------- staff auth ----------
  app.post(
    '/api/staff/login',
    wrap((req, res) => {
      const ip = req.socket.remoteAddress ?? 'unknown';
      const wait = limiter.blockedFor(ip);
      if (wait > 0) {
        res.setHeader('Retry-After', Math.ceil(wait / 1000));
        throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil(wait / 60000)} min.`);
      }
      if (!pinMatches(req.body?.pin, config.staffPin)) {
        limiter.fail(ip);
        throw new HttpError(401, 'Wrong PIN');
      }
      limiter.succeed(ip);
      res.setHeader('Set-Cookie', setCookieHeader(makeStaffCookie(secret)));
      res.json({ ok: true });
    }),
  );

  app.post('/api/staff/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearCookieHeader());
    res.json({ ok: true });
  });

  app.get('/api/staff/me', (req, res) => {
    res.json({ staff: isStaff(req) });
  });

  // ---------- staff area ----------
  const staff = express.Router();
  staff.use(requireStaff);

  staff.get(
    '/browse',
    wrap(async (req, res) => {
      const rel = cleanRelPath(req.query.path);
      const entries = await browse(config.photosRoot, rel, config.backupSuffix);
      const depth = rel === '' ? 0 : rel.split('/').length;
      res.json({ path: rel, depth, entries });
    }),
  );

  staff.get('/sessions', (_req, res) => {
    const states = store.rawJobStates();
    res.json(
      store.listSessions().map((s) => ({
        ...sessionJson(s),
        selectedCount: s.selected_count,
        ratedCount: s.rated_count,
        extras: extrasFor(s.selected_count, s.package_size, s.extra_price),
        rawState: raws.status(s.id)?.state ?? states.get(s.id) ?? null,
      })),
    );
  });

  staff.get(
    '/sessions/:id/raws',
    wrap((req, res) => {
      res.json(rawStatus(sessionById(req)));
    }),
  );

  /** Copy (or top up) the RAWs for this session's hearted photos into the projects folder. */
  staff.post(
    '/sessions/:id/raws',
    wrap((req, res) => {
      const s = sessionById(req);
      if (!raws.enabled()) throw new HttpError(400, 'No projects folder is set up (PROJECTS_PATH in .env).');
      raws.enqueue(s.id);
      res.status(202).json(rawStatus(s));
    }),
  );

  staff.post(
    '/sessions',
    wrap(async (req, res) => {
      const clientName = String(req.body?.clientName ?? '').trim().slice(0, 120);
      const packageSize = Number.parseInt(String(req.body?.packageSize), 10);
      if (!clientName) throw new HttpError(400, 'Enter the client name');
      if (!Number.isInteger(packageSize) || packageSize < 1 || packageSize > 9999) {
        throw new HttpError(400, 'Enter a package size');
      }
      const folder = cleanRelPath(req.body?.folder);
      if (folder.split('/').length < 2) throw new HttpError(400, 'Choose a client folder');
      const abs = resolveInside(config.photosRoot, folder);
      if (!fs.statSync(abs).isDirectory()) throw new HttpError(400, 'Choose a client folder');
      const extraPrice = req.body?.extraPrice === undefined || req.body?.extraPrice === '' ? config.extraImagePrice : parsePrice(req.body.extraPrice);
      if (extraPrice === null) throw new HttpError(400, 'Enter the extra picture price in whole rand, e.g. 250');
      const s = store.createSession(clientName, folder, packageSize, extraPrice);
      folders.get(abs, true).then((photos) => images.warm(photos.map((p) => path.join(abs, p.name)))).catch(() => {});
      res.status(201).json(sessionJson(s));
    }),
  );

  staff.get(
    '/sessions/:id',
    wrap(async (req, res) => {
      const s = sessionById(req);
      const payload = await clientPayload(s);
      const selected = payload.photos.filter((p) => payload.picks[p.name]?.selected).length;
      res.json({
        session: sessionJson(s),
        ...payload,
        extras: extrasFor(selected, s.package_size, s.extra_price),
        raws: rawStatus(s),
      });
    }),
  );

  staff.patch(
    '/sessions/:id',
    wrap((req, res) => {
      const s = sessionById(req);
      const clientName = req.body?.clientName === undefined ? undefined : String(req.body.clientName).trim().slice(0, 120);
      const packageSize = req.body?.packageSize === undefined ? undefined : Number.parseInt(String(req.body.packageSize), 10);
      if (clientName !== undefined && !clientName) throw new HttpError(400, 'Enter the client name');
      if (packageSize !== undefined && (!Number.isInteger(packageSize) || packageSize < 1 || packageSize > 9999)) {
        throw new HttpError(400, 'Enter a package size');
      }
      const extraPrice = req.body?.extraPrice === undefined ? undefined : parsePrice(req.body.extraPrice);
      if (extraPrice === null) throw new HttpError(400, 'Enter the extra picture price in whole rand, e.g. 250');
      store.updateSession(s.id, { client_name: clientName, package_size: packageSize, extra_price: extraPrice });
      live.notify(s.id);
      res.json(sessionJson(store.getSession(s.id)!));
    }),
  );

  staff.post(
    '/sessions/:id/unlock',
    wrap((req, res) => {
      const s = sessionById(req);
      store.setStatus(s.id, 'in_progress');
      live.notify(s.id);
      res.json(sessionJson(store.getSession(s.id)!));
    }),
  );

  staff.post(
    '/sessions/:id/reset',
    wrap((req, res) => {
      const s = sessionById(req);
      store.resetSession(s.id);
      live.notify(s.id);
      res.json(sessionJson(store.getSession(s.id)!));
    }),
  );

  staff.delete(
    '/sessions/:id',
    wrap((req, res) => {
      const s = sessionById(req);
      live.kickAll(s.id);
      store.deleteSession(s.id); // app data only; photos are never touched
      res.json({ ok: true });
    }),
  );

  staff.get(
    '/sessions/:id/copylist',
    wrap(async (req, res) => {
      const s = sessionById(req);
      const photos = await photosFor(s, true);
      const text = buildCopyList(
        store.getPicks(s.id),
        {
          filter: req.query.filter === 'stars' ? 'stars' : 'hearted',
          minStars: Number.parseInt(String(req.query.minStars ?? '1'), 10) || 1,
          includeExtension: req.query.ext === '1',
          separator: req.query.sep === 'space' ? ', ' : ',',
        },
        new Set(photos.map((p) => p.name)),
      );
      res.json({ text, count: text ? text.split(',').length : 0 });
    }),
  );

  staff.get(
    '/sessions/:id/export.csv',
    wrap(async (req, res) => {
      const s = sessionById(req);
      const photos = await photosFor(s, true);
      const picks = store.getPicks(s.id);
      const names = new Set(photos.map((p) => p.name));
      const selected = picks.filter((p) => p.selected && names.has(p.file_name)).length;
      const csv = buildCsv(
        photos.map((p) => p.name),
        picks,
        { clientName: s.client_name, ...extrasFor(selected, s.package_size, s.extra_price) },
      );
      const safeName = s.client_name.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || 'session';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="JM-Selects-${safeName}-${s.id}.csv"`);
      res.send('﻿' + csv);
    }),
  );

  /** Signs staff out on this device and returns the client's link, so a tablet can be handed over safely. */
  staff.post(
    '/sessions/:id/handoff',
    wrap((req, res) => {
      const s = sessionById(req);
      // Staff are present, so this tablet is let in without typing the name.
      res.setHeader('Set-Cookie', [clearCookieHeader(), newDevice(s, req, 'tablet')]);
      res.json({ url: `/c/${s.token}` });
    }),
  );

  staff.get(
    '/sessions/:id/access',
    wrap((req, res) => {
      const s = sessionById(req);
      const online = live.onlineDevices(s.id);
      res.json({
        link: sessionLink(req, s),
        joinFailures: s.join_failures,
        locked: s.join_failures >= config.maxJoinAttempts,
        maxJoinAttempts: config.maxJoinAttempts,
        devices: store.listDevices(s.id).map((d) => ({
          id: d.id,
          label: d.label,
          via: d.via,
          joinedAt: d.created_at,
          lastSeen: d.last_seen,
          revoked: d.revoked_at !== null,
          online: online.has(d.id),
        })),
      });
    }),
  );

  staff.post(
    '/sessions/:id/devices/:deviceId/revoke',
    wrap((req, res) => {
      const s = sessionById(req);
      const deviceId = Number.parseInt(String(req.params.deviceId), 10);
      if (!Number.isInteger(deviceId) || !store.revokeDevice(s.id, deviceId)) throw new HttpError(404, 'Device not found');
      live.kickDevice(s.id, deviceId);
      res.json({ ok: true });
    }),
  );

  /** New link + QR: the old link stops working and every device must join again. */
  staff.post(
    '/sessions/:id/regenerate',
    wrap((req, res) => {
      const s = sessionById(req);
      live.kickAll(s.id);
      const fresh = store.regenerateToken(s.id)!;
      res.json(sessionJson(fresh));
    }),
  );

  staff.post(
    '/sessions/:id/reset-attempts',
    wrap((req, res) => {
      const s = sessionById(req);
      store.setJoinFailures(s.id, 0);
      res.json({ ok: true });
    }),
  );

  staff.get(
    '/sessions/:id/qr.svg',
    wrap(async (req, res) => {
      const s = sessionById(req);
      sendSvg(res, await qrSvg(sessionLink(req, s)));
    }),
  );

  staff.get('/wifi', (_req, res) => {
    // The password is never sent as text, only inside the QR image.
    res.json({ configured: Boolean(config.wifiSsid), ssid: config.wifiSsid, open: !config.wifiPassword });
  });

  staff.get(
    '/wifi.svg',
    wrap(async (_req, res) => {
      if (!config.wifiSsid) throw new HttpError(404, 'Wi-Fi is not set up (WIFI_SSID in .env)');
      sendSvg(res, await qrSvg(wifiQrText(config.wifiSsid, config.wifiPassword)));
    }),
  );

  app.use('/api/staff', staff);

  // ---------- client ----------
  app.get(
    '/api/c/:token',
    wrap(async (req, res) => {
      const s = sessionByToken(req);
      res.setHeader('Cache-Control', 'no-cache');
      clientAccess(req, s);
      res.json(await clientPayload(s, req.query.refresh === '1'));
    }),
  );

  /** First open on a phone: the client types their full name. */
  app.post(
    '/api/c/:token/join',
    wrap((req, res) => {
      const s = sessionByToken(req);
      const ip = req.socket.remoteAddress ?? 'unknown';
      const lockedMsg = 'For your privacy this gallery is now locked. Please ask a member of the studio team to help you.';
      if (s.join_failures >= config.maxJoinAttempts) {
        throw new HttpError(423, lockedMsg, { needName: true, locked: true, attemptsLeft: 0 });
      }
      if (joinLimiter.blockedFor(ip) > 0) {
        throw new HttpError(429, 'Too many attempts from this device. Please ask the studio team.', { needName: true });
      }
      if (!namesMatch(req.body?.name, s.client_name)) {
        const fails = s.join_failures + 1;
        store.setJoinFailures(s.id, fails);
        joinLimiter.fail(ip);
        const left = Math.max(0, config.maxJoinAttempts - fails);
        if (left === 0) throw new HttpError(423, lockedMsg, { needName: true, locked: true, attemptsLeft: 0 });
        throw new HttpError(401, 'That name doesn’t match the booking.', { needName: true, locked: false, attemptsLeft: left });
      }
      store.setJoinFailures(s.id, 0);
      res.setHeader('Set-Cookie', newDevice(s, req, 'name'));
      live.notify(s.id);
      res.json({ ok: true });
    }),
  );

  /** Live updates for this session (selections from other devices, unlocks, removals). */
  app.get(
    '/api/c/:token/events',
    wrap((req, res) => {
      const s = sessionByToken(req);
      const { device } = clientAccess(req, s);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      const conn = { res, deviceId: device?.id ?? null };
      live.add(s.id, conn);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        live.remove(s.id, conn);
      });
    }),
  );

  app.put(
    '/api/c/:token/picks/:file',
    wrap(async (req, res) => {
      const s = sessionByToken(req);
      clientAccess(req, s);
      if (s.status === 'done') throw new HttpError(409, 'This selection is finished. Ask the studio to unlock it.');
      const abs = photoFile(s, req.params.file);
      if (!fs.existsSync(abs)) throw new HttpError(404, 'Photo not found');
      const change: { selected?: boolean; stars?: number } = {};
      if (req.body?.selected !== undefined) {
        if (typeof req.body.selected !== 'boolean') throw new HttpError(400, 'Invalid value');
        change.selected = req.body.selected;
      }
      if (req.body?.stars !== undefined) {
        const n = req.body.stars;
        if (!Number.isInteger(n) || n < 0 || n > 5) throw new HttpError(400, 'Invalid value');
        change.stars = n;
      }
      const p = store.setPick(s.id, path.basename(abs), change);
      live.notify(s.id);
      res.json({ selected: !!p.selected, stars: p.stars });
    }),
  );

  app.post(
    '/api/c/:token/done',
    wrap((req, res) => {
      const s = sessionByToken(req);
      clientAccess(req, s);
      if (s.status !== 'done') {
        store.setStatus(s.id, 'done');
        if (raws.enabled()) raws.enqueue(s.id); // copy RAWs in the background
        live.notify(s.id);
      }
      res.json({ status: 'done' });
    }),
  );

  app.get(
    '/img/c/:token/:variant/:file',
    wrap(async (req, res) => {
      const s = sessionByToken(req);
      clientAccess(req, s);
      const variant = req.params.variant as Variant;
      if (variant !== 'thumb' && variant !== 'preview') throw new HttpError(404, 'Not found');
      const abs = photoFile(s, req.params.file);
      let out: string;
      try {
        out = await images.get(abs, variant);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'Not found');
        throw e;
      }
      res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
      res.type('image/jpeg');
      res.sendFile(out);
    }),
  );

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use('/img', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // ---------- front end ----------
  if (fs.existsSync(config.webDir)) {
    app.use(express.static(config.webDir, { index: false, maxAge: '1h' }));
    const indexHtml = path.join(config.webDir, 'index.html');
    app.get('/{*splat}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  // ---------- errors ----------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      if (res.headersSent) return res.end();
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    if (err instanceof PathError) return res.status(err.message === 'Not found' ? 404 : 400).json({ error: err.message });
    if ((err as { type?: string }).type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return { app, store, images, folders, raws, live };
}
