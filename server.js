import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Store } from './lib/store.js';
import { createApi } from './lib/api.js';
import { isValidWebhookUrl } from './lib/webhook.js';
import { sendError, sendJson } from './lib/util.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

const STATIC_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.webmanifest', 'application/manifest+json'],
]);

const config = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  maxUploadBytes: Math.max(1, Number(process.env.MAX_UPLOAD_MB || 25)) * 1024 * 1024,
  webhookUrl: process.env.WEBHOOK_URL || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  usingDefaultPassword: false,
};

if (!config.adminPassword) {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to start: set ADMIN_PASSWORD before running in production.');
    process.exit(1);
  }
  config.adminPassword = 'changeme';
  config.usingDefaultPassword = true;
}

if (config.webhookUrl && !isValidWebhookUrl(config.webhookUrl)) {
  console.error(`Refusing to start: WEBHOOK_URL is not a valid http(s) URL (${config.webhookUrl}).`);
  process.exit(1);
}

/** Persisted so that signing in survives a restart. Delete it to sign out everywhere. */
async function loadSessionSecret(dataDir) {
  const keyPath = path.join(dataDir, 'session.key');
  try {
    const existing = await fsp.readFile(keyPath, 'utf8');
    if (existing.trim().length >= 32) return existing.trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  await fsp.writeFile(keyPath, secret, { mode: 0o600 });
  return secret;
}

/**
 * `no-cache` does not mean "do not cache" — it means "revalidate before
 * reusing". Paired with an ETag, an unchanged file costs a 304 and a few
 * hundred bytes, and a changed one is picked up immediately.
 *
 * This matters more than it looks. The page, its stylesheet and its script
 * are one unit: a release changes all three together. Caching the CSS and JS
 * for an hour while the HTML revalidated meant that after every deploy, for
 * up to an hour, browsers paired new markup with the previous release's
 * stylesheet — which renders as an unstyled page, not as a subtle glitch.
 *
 * Long-lived caching belongs on URLs that never change meaning. The image
 * routes are exactly that (an opaque id per file) and set their own headers.
 */
function serveFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = STATIC_TYPES.get(ext);
  if (!type) return sendError(res, 404, 'Not found');

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendError(res, 404, 'Not found');

    const etag = `"${crypto
      .createHash('sha1')
      .update(`${filePath}:${stat.size}:${stat.mtimeMs}`)
      .digest('base64url')}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache' });
      return res.end();
    }

    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'cache-control': 'no-cache',
      etag,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
  });
}

function serveStatic(req, res, pathname) {
  const target = path.join(PUBLIC_DIR, path.normalize(decodeURIComponent(pathname)));
  // normalize() + this prefix check keeps `../` out of the public directory.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return sendError(res, 404, 'Not found');
  }
  return serveFile(req, res, target);
}

async function main() {
  await fsp.mkdir(config.dataDir, { recursive: true });
  config.sessionSecret = await loadSessionSecret(config.dataDir);

  const store = await new Store(config.dataDir).init();
  const api = createApi({ store, config });

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendError(res, 400, 'Bad request');
    }

    try {
      if (url.pathname.startsWith('/api/')) return await api.handle(req, res, url);

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
        if (url.pathname === '/') return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
        // `/s/` is where links generated before the folder rewrite pointed.
        if (/^\/(g|s)(\/|$)/.test(url.pathname)) {
          return serveFile(req, res, path.join(PUBLIC_DIR, 'gallery.html'));
        }
        const image = /^\/(i|t|d)\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
        if (image) return await api.serveImage(req, res, image[1], image[2]);
        const logo = /^\/logo\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
        if (logo) return await api.serveLogo(req, res, logo[1]);
        return serveStatic(req, res, url.pathname);
      }

      return sendError(res, 405, 'Method not allowed');
    } catch (err) {
      console.error('[server]', req.method, url.pathname, err);
      if (!res.headersSent) sendError(res, 500, 'Something went wrong on the server');
      else res.destroy();
    }
  });

  server.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
    console.log('');
    console.log(`  Pose Board is running → http://${shown}:${config.port}`);
    console.log(`  Photos and data       → ${config.dataDir}`);
    console.log(`  Max upload per photo  → ${Math.round(config.maxUploadBytes / (1024 * 1024))} MB`);
    console.log(`  Handoff webhook       → ${config.webhookUrl || 'not set (per-folder URLs still work)'}`);
    if (config.usingDefaultPassword) {
      console.log('');
      console.log('  ⚠  ADMIN_PASSWORD is not set, so the password is "changeme".');
      console.log('     Start it like this instead:  ADMIN_PASSWORD="your-password" npm start');
    }
    console.log('');
  });

  // An expired gallery closes itself the moment anyone tries the link, but the
  // studio's software should hear about it whether or not someone does — so
  // sweep on start and hourly after that.
  api.sweepExpired();
  const expirySweep = setInterval(() => api.sweepExpired(), 60 * 60 * 1000);
  expirySweep.unref();

  const shutdown = () => {
    clearInterval(expirySweep);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start Pose Board:', err);
  process.exit(1);
});
