import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import {
  createSessionToken,
  isAuthed,
  sessionCookie,
  LoginThrottle,
} from './auth.js';
import {
  bool,
  httpError,
  newId,
  nowIso,
  readJson,
  secretsMatch,
  sendError,
  sendJson,
  text,
} from './util.js';

const IMAGE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/pjpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/avif', '.avif'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif'],
]);

const MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.avif', 'image/avif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
]);

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;
const MAX_THUMB_BYTES = 4 * 1024 * 1024;

function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      keys.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

function contentType(req) {
  return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

function clientAddress(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function tagList(value) {
  if (!Array.isArray(value)) return [];
  const tags = [];
  for (const entry of value) {
    const tag = text(entry, 24).toLowerCase();
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= 8) break;
  }
  return tags;
}

export function createApi({ store, config }) {
  const throttle = new LoginThrottle();
  const routes = [];

  const route = (method, pattern, handler, { admin = true } = {}) => {
    routes.push({ method, ...compile(pattern), handler, admin });
  };
  const publicRoute = (method, pattern, handler) => route(method, pattern, handler, { admin: false });

  // ---- helpers -----------------------------------------------------------

  const publicPhoto = (photo) => ({
    id: photo.id,
    title: photo.title,
    notes: photo.notes,
    tags: photo.tags,
    sort: photo.sort,
    width: photo.width || null,
    height: photo.height || null,
    hasThumb: Boolean(photo.thumbFile),
  });

  const adminPhoto = (photo) => ({
    ...publicPhoto(photo),
    collectionId: photo.collectionId,
    originalName: photo.originalName,
    size: photo.size,
    createdAt: photo.createdAt,
  });

  const requireCollection = (id) => {
    const collection = store.collection(id);
    if (!collection) throw httpError(404, 'Collection not found');
    return collection;
  };

  const requirePhoto = (id) => {
    const photo = store.photo(id);
    if (!photo) throw httpError(404, 'Photo not found');
    return photo;
  };

  /**
   * Share links are open to anyone holding the link; a PIN can add a second
   * gate. The PIN is read from a header first so it stays out of access logs,
   * falling back to the query string for anyone hitting the API by hand.
   */
  const requireShared = (shareId, url, req) => {
    const collection = store.collectionByShareId(shareId);
    if (!collection || !collection.published) throw httpError(404, 'This gallery is not available');
    if (collection.pin) {
      const given = text(req.headers['x-gallery-pin'] || url.searchParams.get('pin'), 32);
      if (!given) throw Object.assign(httpError(401, 'This gallery needs a PIN'), { pinRequired: true });
      if (!secretsMatch(given, collection.pin)) {
        throw Object.assign(httpError(401, 'That PIN is not right'), { pinRequired: true });
      }
    }
    return collection;
  };

  // ---- session -----------------------------------------------------------

  publicRoute('GET', '/api/session', ({ req, res }) => {
    sendJson(res, 200, {
      authed: isAuthed(req, config.sessionSecret),
      usingDefaultPassword: Boolean(config.usingDefaultPassword),
      maxUploadMb: Math.round(config.maxUploadBytes / (1024 * 1024)),
    });
  });

  publicRoute('POST', '/api/login', async ({ req, res }) => {
    const key = clientAddress(req);
    if (throttle.blocked(key)) {
      throw httpError(429, `Too many attempts. Try again in ${throttle.retryInSeconds(key)}s.`);
    }
    const body = await readJson(req);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || !secretsMatch(password, config.adminPassword)) {
      throttle.recordFailure(key);
      throw httpError(401, 'Wrong password');
    }
    throttle.clear(key);
    const token = createSessionToken(config.sessionSecret);
    res.setHeader('set-cookie', sessionCookie(req, token, SESSION_MAX_AGE_SECONDS));
    sendJson(res, 200, { ok: true });
  });

  publicRoute('POST', '/api/logout', ({ req, res }) => {
    res.setHeader('set-cookie', sessionCookie(req, '', 0));
    sendJson(res, 200, { ok: true });
  });

  // ---- collections (admin) ----------------------------------------------

  route('GET', '/api/collections', ({ res }) => {
    const collections = store.collections().map((collection) => {
      const photos = store.photosIn(collection.id);
      const picks = store.picksIn(collection.id);
      return {
        ...collection,
        pin: collection.pin ? true : false,
        photoCount: photos.length,
        pickCount: picks.length,
        pickedBy: [...new Set(picks.map((p) => p.clientName).filter(Boolean))],
        coverPhotoId: collection.coverPhotoId || (photos[0] ? photos[0].id : null),
      };
    });
    sendJson(res, 200, { collections });
  });

  route('POST', '/api/collections', async ({ req, res }) => {
    const body = await readJson(req);
    const title = text(body.title, 120);
    if (!title) throw httpError(400, 'Give the collection a name');
    const collection = store.createCollection({
      title,
      clientName: text(body.clientName, 80),
      description: text(body.description, 1000),
    });
    sendJson(res, 201, { collection: { ...collection, pin: false, photoCount: 0, pickCount: 0 } });
  });

  route('GET', '/api/collections/:id', ({ res, params }) => {
    const collection = requireCollection(params.id);
    const picks = store.picksIn(collection.id);
    sendJson(res, 200, {
      collection: { ...collection, pin: collection.pin ? true : false },
      photos: store.photosIn(collection.id).map(adminPhoto),
      picks: picks.map((pick) => ({
        id: pick.id,
        photoId: pick.photoId,
        clientName: pick.clientName,
        note: pick.note,
        createdAt: pick.createdAt,
      })),
    });
  });

  route('PATCH', '/api/collections/:id', async ({ req, res, params }) => {
    const collection = requireCollection(params.id);
    const body = await readJson(req);

    if ('title' in body) {
      const title = text(body.title, 120);
      if (!title) throw httpError(400, 'The collection needs a name');
      collection.title = title;
    }
    if ('clientName' in body) collection.clientName = text(body.clientName, 80);
    if ('description' in body) collection.description = text(body.description, 1000);
    if ('published' in body) collection.published = bool(body.published, collection.published);
    if ('coverPhotoId' in body) {
      const coverId = text(body.coverPhotoId, 64) || null;
      if (coverId && !store.photo(coverId)) throw httpError(400, 'Unknown cover photo');
      collection.coverPhotoId = coverId;
    }
    if ('pin' in body) {
      const pin = text(body.pin, 32);
      if (pin && !/^[0-9]{4,12}$/.test(pin)) throw httpError(400, 'The PIN must be 4–12 digits');
      collection.pin = pin || null;
    }
    collection.updatedAt = nowIso();
    store.save();
    sendJson(res, 200, { collection: { ...collection, pin: collection.pin ? true : false } });
  });

  route('POST', '/api/collections/:id/reshare', ({ res, params }) => {
    const collection = requireCollection(params.id);
    collection.shareId = newId('s');
    collection.updatedAt = nowIso();
    store.save();
    sendJson(res, 200, { collection: { ...collection, pin: collection.pin ? true : false } });
  });

  route('DELETE', '/api/collections/:id', async ({ res, params }) => {
    requireCollection(params.id);
    const photos = store.deleteCollection(params.id);
    for (const photo of photos) await store.removeFiles(photo);
    sendJson(res, 200, { ok: true, deletedPhotos: photos.length });
  });

  route('POST', '/api/collections/:id/order', async ({ req, res, params }) => {
    requireCollection(params.id);
    const body = await readJson(req);
    if (!Array.isArray(body.ids)) throw httpError(400, 'Expected an array of photo ids');
    store.reorderPhotos(params.id, body.ids.filter((id) => typeof id === 'string'));
    sendJson(res, 200, { photos: store.photosIn(params.id).map(adminPhoto) });
  });

  // ---- photos (admin) ----------------------------------------------------

  // The browser sends the raw image bytes as the request body, so the server
  // never has to parse multipart form data.
  route('POST', '/api/collections/:id/photos', async ({ req, res, params, url }) => {
    const collection = requireCollection(params.id);
    const type = contentType(req);
    const ext = IMAGE_TYPES.get(type);
    if (!ext) throw httpError(415, 'That file type is not supported. Use JPEG, PNG, WebP, GIF, AVIF or HEIC.');

    const photoId = newId('ph');
    const filename = `${photoId}${ext}`;
    const size = await store.saveStream(req, filename, config.maxUploadBytes);

    const photo = store.addPhoto({
      id: photoId,
      collectionId: collection.id,
      file: filename,
      thumbFile: null,
      mime: type === 'image/pjpeg' ? 'image/jpeg' : type,
      size,
      width: Number(url.searchParams.get('w')) || 0,
      height: Number(url.searchParams.get('h')) || 0,
      originalName: text(req.headers['x-filename'], 160),
      title: '',
      notes: '',
      tags: [],
      sort: store.nextSort(collection.id),
      createdAt: nowIso(),
    });
    collection.updatedAt = nowIso();
    store.save();
    sendJson(res, 201, { photo: adminPhoto(photo) });
  });

  // Thumbnails are generated in the browser (canvas) and uploaded separately,
  // which keeps the server free of native image libraries.
  route('POST', '/api/photos/:id/thumbnail', async ({ req, res, params }) => {
    const photo = requirePhoto(params.id);
    const type = contentType(req);
    if (type !== 'image/jpeg' && type !== 'image/webp') throw httpError(415, 'Thumbnails must be JPEG or WebP');
    const filename = `${photo.id}.thumb${type === 'image/webp' ? '.webp' : '.jpg'}`;
    await store.saveStream(req, filename, MAX_THUMB_BYTES);
    if (photo.thumbFile && photo.thumbFile !== filename) {
      await fsp.rm(store.filePath(photo.thumbFile), { force: true });
    }
    photo.thumbFile = filename;
    store.save();
    sendJson(res, 200, { photo: adminPhoto(photo) });
  });

  route('PATCH', '/api/photos/:id', async ({ req, res, params }) => {
    const photo = requirePhoto(params.id);
    const body = await readJson(req);
    if ('title' in body) photo.title = text(body.title, 120);
    if ('notes' in body) photo.notes = text(body.notes, 1000);
    if ('tags' in body) photo.tags = tagList(body.tags);
    if ('width' in body) photo.width = Number(body.width) || photo.width;
    if ('height' in body) photo.height = Number(body.height) || photo.height;
    store.save();
    sendJson(res, 200, { photo: adminPhoto(photo) });
  });

  route('DELETE', '/api/photos/:id', async ({ res, params }) => {
    const photo = requirePhoto(params.id);
    store.deletePhoto(photo.id);
    await store.removeFiles(photo);
    sendJson(res, 200, { ok: true });
  });

  // ---- client-facing gallery --------------------------------------------

  publicRoute('GET', '/api/share/:shareId', ({ req, res, url, params }) => {
    const collection = requireShared(params.shareId, url, req);
    const clientKey = text(url.searchParams.get('clientKey'), 64);
    const myPicks = clientKey ? store.picksBy(collection.id, clientKey) : [];
    sendJson(res, 200, {
      collection: {
        title: collection.title,
        clientName: collection.clientName,
        description: collection.description,
        updatedAt: collection.updatedAt,
      },
      photos: store.photosIn(collection.id).map(publicPhoto),
      picks: myPicks.map((pick) => ({ photoId: pick.photoId, note: pick.note })),
    });
  });

  publicRoute('POST', '/api/share/:shareId/pick', async ({ req, res, url, params }) => {
    const collection = requireShared(params.shareId, url, req);
    const body = await readJson(req);
    const photoId = text(body.photoId, 64);
    const photo = store.photo(photoId);
    if (!photo || photo.collectionId !== collection.id) throw httpError(404, 'Photo not found');

    const clientKey = text(body.clientKey, 64);
    if (!clientKey) throw httpError(400, 'Missing client key');
    const pick = store.setPick({
      collectionId: collection.id,
      photoId,
      clientKey,
      clientName: text(body.clientName, 80) || 'Guest',
      note: typeof body.note === 'string' ? text(body.note, 500) : undefined,
      picked: bool(body.picked, true),
    });
    sendJson(res, 200, { picked: Boolean(pick), note: pick ? pick.note : '' });
  });

  // ---- image files -------------------------------------------------------

  /**
   * `kind` is 'f' (full size) or 't' (thumbnail). A photo is readable when the
   * signed-in owner asks for it, or when its collection is published — the
   * share id and photo id are both unguessable, so published photos are
   * effectively "anyone with the link".
   */
  async function serveImage(req, res, kind, photoId) {
    const photo = store.photo(photoId);
    if (!photo) return sendError(res, 404, 'Not found');
    const collection = store.collection(photo.collectionId);
    const allowed = isAuthed(req, config.sessionSecret) || (collection && collection.published);
    if (!allowed) return sendError(res, 404, 'Not found');

    const filename = kind === 't' && photo.thumbFile ? photo.thumbFile : photo.file;
    const filePath = store.filePath(filename);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return sendError(res, 404, 'File missing on disk');
    }

    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    const etag = `"${crypto.createHash('sha1').update(`${filename}:${stat.size}:${stat.mtimeMs}`).digest('base64url')}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      return res.end();
    }

    res.writeHead(200, {
      'content-type': MIME_BY_EXT.get(ext) || photo.mime || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'private, max-age=604800',
      'content-disposition': `inline; filename="${(photo.originalName || filename).replace(/[^\w.\- ]/g, '_')}"`,
      etag,
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
  }

  // ---- dispatch ----------------------------------------------------------

  async function handle(req, res, url) {
    for (const entry of routes) {
      if (entry.method !== req.method) continue;
      const match = entry.regex.exec(url.pathname);
      if (!match) continue;
      if (entry.admin && !isAuthed(req, config.sessionSecret)) {
        return sendError(res, 401, 'Please sign in again');
      }
      const params = {};
      entry.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1]);
      });
      try {
        return await entry.handler({ req, res, url, params });
      } catch (err) {
        const status = Number(err.status) || 500;
        if (status >= 500) console.error('[api]', req.method, url.pathname, err);
        const payload = { error: status >= 500 ? 'Something went wrong on the server' : err.message };
        if (err.pinRequired) payload.pinRequired = true;
        return sendJson(res, status, payload);
      }
    }
    return sendError(res, 404, 'Unknown endpoint');
  }

  return { handle, serveImage };
}
