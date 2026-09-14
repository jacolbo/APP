import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { createSessionToken, isAuthed, sessionCookie, LoginThrottle } from './auth.js';
import { hashPin, isValidPin, verifyPin } from './pin.js';
import {
  GRANT_MAX_AGE_SECONDS,
  createGrant,
  grantCookie,
  hasGrant,
} from './grant.js';
import { isValidWebhookUrl, sendWebhook } from './webhook.js';
import { MAX_DEPTH } from './store.js';
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
  const loginThrottle = new LoginThrottle();
  const pinThrottle = new LoginThrottle({ maxAttempts: 8, windowMs: 15 * 60 * 1000 });
  const handoffThrottle = new LoginThrottle({ maxAttempts: 6, windowMs: 15 * 60 * 1000 });
  const routes = [];

  const route = (method, pattern, handler, { admin = true } = {}) => {
    routes.push({ method, ...compile(pattern), handler, admin });
  };
  const publicRoute = (method, pattern, handler) => route(method, pattern, handler, { admin: false });

  // ---- lookups -----------------------------------------------------------

  const requireFolder = (id) => {
    const folder = store.folder(id);
    if (!folder) throw httpError(404, 'Folder not found');
    return folder;
  };

  const requireTab = (id) => {
    const tab = store.tab(id);
    if (!tab) throw httpError(404, 'Tab not found');
    return tab;
  };

  const requireImage = (id) => {
    const image = store.image(id);
    if (!image) throw httpError(404, 'Image not found');
    return image;
  };

  /** A setting inherited from the nearest ancestor that defines it, self first. */
  const inherited = (folderId, field) => {
    const chain = store.pathOf(folderId).reverse();
    for (const folder of chain) {
      if (folder[field]) return folder[field];
    }
    return null;
  };

  const effectivePinHash = (folderId) => inherited(folderId, 'downloadPinHash');
  const effectiveWebhookUrl = (folderId) => inherited(folderId, 'webhookUrl') || config.webhookUrl || null;

  /** A live download grant for this folder or any folder above it. */
  const unlockedFor = (req, folderId) =>
    hasGrant(req, [folderId, ...store.ancestorIds(folderId)], config.sessionSecret);

  /**
   * Walk down from the link's folder to `targetId`. Every folder on the way,
   * including both ends, has to be published — a draft folder hides itself and
   * everything under it from a parent's link.
   */
  const visibleDescendant = (rootId, targetId) => {
    const path = store.pathOf(targetId);
    const start = path.findIndex((f) => f.id === rootId);
    if (start < 0) return null;
    const branch = path.slice(start);
    return branch.every((f) => f.status === 'published') ? branch[branch.length - 1] : null;
  };

  // ---- client-facing shapes ----------------------------------------------
  //
  // Nothing here emits a stored filename or a path under DATA_DIR. Clients
  // only ever see opaque /i/, /t/ and /d/ routes keyed by image id, which is
  // what keeps the deliverable files off the page until a PIN is accepted.

  const imagePayload = (image) => ({
    id: image.id,
    url: `/i/${image.id}`,
    thumbUrl: image.thumbFile ? `/t/${image.id}` : `/i/${image.id}`,
    fileName: image.originalName || '',
    title: image.title,
    notes: image.notes,
    width: image.width || null,
    height: image.height || null,
  });

  const tabIsOpen = (tab, unlocked) => tab.access === 'open' || unlocked;

  const openTabsIn = (folderId, unlocked) =>
    store.tabsIn(folderId).filter((tab) => tabIsOpen(tab, unlocked));

  const coverUrlFor = (folder, unlocked) => {
    const chosen = folder.coverImageId ? store.image(folder.coverImageId) : null;
    if (chosen && tabIsOpen(store.tab(chosen.tabId) || { access: 'pin' }, unlocked)) {
      return `/i/${chosen.id}`;
    }
    for (const tab of openTabsIn(folder.id, unlocked)) {
      const first = store.imagesIn(tab.id)[0];
      if (first) return `/i/${first.id}`;
    }
    return null;
  };

  const folderCard = (folder, unlocked) => ({
    id: folder.id,
    title: folder.title,
    coverImageUrl: coverUrlFor(folder, unlocked),
    imageCount: openTabsIn(folder.id, unlocked)
      .reduce((total, tab) => total + store.imagesIn(tab.id).length, 0),
    folderCount: store.childFolders(folder.id).filter((f) => f.status === 'published').length,
  });

  /** Every image the client may see right now, keyed by id. */
  const visibleImageIds = (rootId, unlocked) => {
    const ids = new Set();
    for (const folderId of store.subtreeIds(rootId)) {
      const folder = store.folder(folderId);
      if (!folder || !visibleDescendant(rootId, folderId)) continue;
      for (const tab of openTabsIn(folderId, unlocked)) {
        for (const image of store.imagesIn(tab.id)) ids.add(image.id);
      }
    }
    return ids;
  };

  const favouritePayload = (rootFolder, clientSessionId, unlocked) => {
    if (!clientSessionId) return [];
    const visible = visibleImageIds(rootFolder.id, unlocked);
    return store
      .selectionsBy(rootFolder.id, clientSessionId)
      .map((selection) => {
        const image = store.image(selection.imageId);
        if (!image) return null;
        const tab = store.tab(image.tabId);
        const folder = store.folder(image.folderId);
        if (!tab || !folder) return null;
        if (!visible.has(image.id)) {
          // Favourited earlier from a tab that is locked again — keep the count
          // honest without handing back a URL for it.
          return { id: image.id, locked: true, note: selection.note, createdAt: selection.createdAt };
        }
        return {
          ...imagePayload(image),
          locked: false,
          note: selection.note,
          createdAt: selection.createdAt,
          tabTitle: tab.title,
          downloadable: Boolean(tab.downloadable),
          folderPath: store.pathOf(folder.id).map((f) => f.title).join(' / '),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };

  const galleryPayload = ({ rootFolder, currentFolder, req, clientSessionId }) => {
    const unlocked = unlockedFor(req, currentFolder.id);
    const pinHash = effectivePinHash(rootFolder.id);
    const fullPath = store.pathOf(currentFolder.id);
    const breadcrumb = fullPath.slice(fullPath.findIndex((f) => f.id === rootFolder.id));
    return {
      gallery: {
        id: rootFolder.id,
        title: rootFolder.title,
        clientName: rootFolder.clientName,
        description: rootFolder.description,
        coverImageUrl: coverUrlFor(rootFolder, unlocked),
        updatedAt: rootFolder.updatedAt,
        hasPin: Boolean(pinHash),
        unlocked,
        canHandoff: Boolean(effectiveWebhookUrl(rootFolder.id)),
      },
      folder: {
        id: currentFolder.id,
        title: currentFolder.title,
        description: currentFolder.description,
        path: breadcrumb.map((f) => ({ id: f.id, title: f.title })),
      },
      folders: store
        .childFolders(currentFolder.id)
        .filter((f) => f.status === 'published')
        .map((f) => folderCard(f, unlocked)),
      tabs: store.tabsIn(currentFolder.id).map((tab) => {
        const locked = tab.access === 'pin' && !unlocked;
        return {
          id: tab.id,
          title: tab.title,
          downloadable: Boolean(tab.downloadable),
          locked,
          // A locked tab reports its name and how many images are behind it.
          // The ids and URLs stay out of the payload until the PIN is accepted.
          imageCount: store.imagesIn(tab.id).length,
          images: locked ? [] : store.imagesIn(tab.id).map(imagePayload),
        };
      }),
      favorites: favouritePayload(rootFolder, clientSessionId, unlocked),
    };
  };

  // ---- session -----------------------------------------------------------

  publicRoute('GET', '/api/session', ({ req, res }) => {
    sendJson(res, 200, {
      authed: isAuthed(req, config.sessionSecret),
      usingDefaultPassword: Boolean(config.usingDefaultPassword),
      maxUploadMb: Math.round(config.maxUploadBytes / (1024 * 1024)),
      webhookConfigured: Boolean(config.webhookUrl),
      maxDepth: MAX_DEPTH,
    });
  });

  publicRoute('POST', '/api/login', async ({ req, res }) => {
    const key = clientAddress(req);
    if (loginThrottle.blocked(key)) {
      throw httpError(429, `Too many attempts. Try again in ${loginThrottle.retryInSeconds(key)}s.`);
    }
    const body = await readJson(req);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || !secretsMatch(password, config.adminPassword)) {
      loginThrottle.recordFailure(key);
      throw httpError(401, 'Wrong password');
    }
    loginThrottle.clear(key);
    res.setHeader('set-cookie', sessionCookie(req, createSessionToken(config.sessionSecret), SESSION_MAX_AGE_SECONDS));
    sendJson(res, 200, { ok: true });
  });

  publicRoute('POST', '/api/logout', ({ req, res }) => {
    res.setHeader('set-cookie', sessionCookie(req, '', 0));
    sendJson(res, 200, { ok: true });
  });

  // ---- folders (admin) ---------------------------------------------------

  const adminFolder = (folder) => ({
    id: folder.id,
    parentId: folder.parentId,
    title: folder.title,
    clientName: folder.clientName,
    description: folder.description,
    coverImageId: folder.coverImageId,
    coverImageUrl: coverUrlFor(folder, true),
    uniqueLink: folder.uniqueLink,
    status: folder.status,
    hasPin: Boolean(folder.downloadPinHash),
    inheritsPin: !folder.downloadPinHash && Boolean(effectivePinHash(folder.id)),
    webhookUrl: folder.webhookUrl,
    effectiveWebhookUrl: effectiveWebhookUrl(folder.id),
    depth: store.depthOf(folder.id),
    sort: folder.sort,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  });

  const adminFolderSummary = (folder) => {
    const subtree = store.subtreeIds(folder.id);
    return {
      ...adminFolder(folder),
      folderCount: store.childFolders(folder.id).length,
      imageCount: subtree.reduce((total, id) => total + store.imagesInFolder(id).length, 0),
      selectionCount: store.selectionsIn(folder.id).length,
    };
  };

  const adminImage = (image) => ({
    ...imagePayload(image),
    tabId: image.tabId,
    folderId: image.folderId,
    tags: image.tags,
    size: image.size,
    sort: image.sort,
    createdAt: image.createdAt,
  });

  route('GET', '/api/folders', ({ res, url }) => {
    const parentId = text(url.searchParams.get('parentId'), 64) || null;
    if (parentId) requireFolder(parentId);
    sendJson(res, 200, { folders: store.childFolders(parentId).map(adminFolderSummary) });
  });

  route('POST', '/api/folders', async ({ req, res }) => {
    const body = await readJson(req);
    const title = text(body.title, 120);
    if (!title) throw httpError(400, 'Give the folder a name');
    const folder = store.createFolder({
      parentId: text(body.parentId, 64) || null,
      title,
      clientName: text(body.clientName, 80),
      description: text(body.description, 1000),
      withDefaultTabs: body.withDefaultTabs !== false,
    });
    sendJson(res, 201, { folder: adminFolderSummary(folder), tabs: store.tabsIn(folder.id) });
  });

  route('GET', '/api/folders/:id', ({ res, params }) => {
    const folder = requireFolder(params.id);
    const selections = store.selectionsIn(folder.id);
    sendJson(res, 200, {
      folder: adminFolder(folder),
      path: store.pathOf(folder.id).map((f) => ({ id: f.id, title: f.title })),
      folders: store.childFolders(folder.id).map(adminFolderSummary),
      tabs: store.tabsIn(folder.id).map((tab) => ({
        ...tab,
        images: store.imagesIn(tab.id).map(adminImage),
      })),
      selections: selections.map((s) => ({
        id: s.id,
        imageId: s.imageId,
        clientSessionId: s.clientSessionId,
        clientName: s.clientName,
        note: s.note,
        createdAt: s.createdAt,
      })),
    });
  });

  route('PATCH', '/api/folders/:id', async ({ req, res, params }) => {
    const folder = requireFolder(params.id);
    const body = await readJson(req);

    if ('title' in body) {
      const title = text(body.title, 120);
      if (!title) throw httpError(400, 'The folder needs a name');
      folder.title = title;
    }
    if ('clientName' in body) folder.clientName = text(body.clientName, 80);
    if ('description' in body) folder.description = text(body.description, 1000);
    if ('status' in body) {
      const status = text(body.status, 16);
      if (status !== 'draft' && status !== 'published') throw httpError(400, 'Status must be draft or published');
      folder.status = status;
    }
    if ('coverImageId' in body) {
      const coverId = text(body.coverImageId, 64) || null;
      if (coverId) {
        const image = store.image(coverId);
        if (!image) throw httpError(400, 'Unknown cover image');
        if (!store.subtreeIds(folder.id).includes(image.folderId)) {
          throw httpError(400, 'The cover has to be an image from this folder');
        }
      }
      folder.coverImageId = coverId;
    }
    if ('downloadPin' in body) {
      const pin = text(body.downloadPin, 32);
      if (!pin) folder.downloadPinHash = null;
      else if (!isValidPin(pin)) throw httpError(400, 'The PIN must be 4–12 digits');
      else folder.downloadPinHash = hashPin(pin);
    }
    if ('webhookUrl' in body) {
      const webhookUrl = text(body.webhookUrl, 500);
      if (webhookUrl && !isValidWebhookUrl(webhookUrl)) throw httpError(400, 'That is not a valid http(s) URL');
      folder.webhookUrl = webhookUrl || null;
    }
    if ('parentId' in body) store.moveFolder(folder.id, text(body.parentId, 64) || null);

    folder.updatedAt = nowIso();
    store.save();
    sendJson(res, 200, { folder: adminFolderSummary(folder) });
  });

  route('POST', '/api/folders/:id/relink', ({ res, params }) => {
    const folder = requireFolder(params.id);
    folder.uniqueLink = newId('s');
    folder.updatedAt = nowIso();
    store.save();
    sendJson(res, 200, { folder: adminFolderSummary(folder) });
  });

  route('DELETE', '/api/folders/:id', async ({ res, params }) => {
    requireFolder(params.id);
    const images = store.deleteFolder(params.id);
    for (const image of images) await store.removeFiles(image);
    sendJson(res, 200, { ok: true, deletedImages: images.length });
  });

  // ---- tabs (admin) ------------------------------------------------------

  route('POST', '/api/folders/:id/tabs', async ({ req, res, params }) => {
    const folder = requireFolder(params.id);
    const body = await readJson(req);
    const title = text(body.title, 60);
    if (!title) throw httpError(400, 'Give the tab a name');
    const tab = store.createTab({
      folderId: folder.id,
      title,
      access: text(body.access, 8) === 'pin' ? 'pin' : 'open',
      downloadable: bool(body.downloadable, false),
    });
    sendJson(res, 201, { tab: { ...tab, images: [] } });
  });

  route('PATCH', '/api/tabs/:id', async ({ req, res, params }) => {
    const tab = requireTab(params.id);
    const body = await readJson(req);
    if ('title' in body) {
      const title = text(body.title, 60);
      if (!title) throw httpError(400, 'The tab needs a name');
      tab.title = title;
    }
    if ('access' in body) tab.access = text(body.access, 8) === 'pin' ? 'pin' : 'open';
    if ('downloadable' in body) tab.downloadable = bool(body.downloadable, tab.downloadable);
    store.save();
    sendJson(res, 200, { tab: { ...tab, images: store.imagesIn(tab.id).map(adminImage) } });
  });

  route('DELETE', '/api/tabs/:id', async ({ res, params }) => {
    requireTab(params.id);
    const images = store.deleteTab(params.id);
    for (const image of images) await store.removeFiles(image);
    sendJson(res, 200, { ok: true, deletedImages: images.length });
  });

  route('POST', '/api/tabs/:id/order', async ({ req, res, params }) => {
    requireTab(params.id);
    const body = await readJson(req);
    if (!Array.isArray(body.ids)) throw httpError(400, 'Expected an array of image ids');
    store.reorderImages(params.id, body.ids.filter((id) => typeof id === 'string'));
    sendJson(res, 200, { images: store.imagesIn(params.id).map(adminImage) });
  });

  // ---- images (admin) ----------------------------------------------------

  // The browser sends the raw image bytes as the request body, so the server
  // never has to parse multipart form data — and never resizes anything.
  route('POST', '/api/tabs/:id/images', async ({ req, res, params, url }) => {
    const tab = requireTab(params.id);
    const type = contentType(req);
    const ext = IMAGE_TYPES.get(type);
    if (!ext) throw httpError(415, 'That file type is not supported. Use JPEG, PNG, WebP, GIF, AVIF or HEIC.');

    const imageId = newId('img');
    const filename = `${imageId}${ext}`;
    const size = await store.saveStream(req, filename, config.maxUploadBytes);

    const image = store.addImage({
      id: imageId,
      tabId: tab.id,
      folderId: tab.folderId,
      file: filename,
      mime: type === 'image/pjpeg' ? 'image/jpeg' : type,
      size,
      thumbFile: null,
      width: Number(url.searchParams.get('w')) || 0,
      height: Number(url.searchParams.get('h')) || 0,
      originalName: text(req.headers['x-filename'], 160),
      title: '',
      notes: '',
      tags: [],
      sort: store.nextSort(tab.id),
      createdAt: nowIso(),
    });
    const folder = store.folder(tab.folderId);
    if (folder) folder.updatedAt = nowIso();
    store.save();
    sendJson(res, 201, { image: adminImage(image) });
  });

  // Thumbnails are generated in the browser (canvas) and uploaded separately,
  // which keeps the server free of native image libraries.
  route('POST', '/api/images/:id/thumbnail', async ({ req, res, params }) => {
    const image = requireImage(params.id);
    const type = contentType(req);
    if (type !== 'image/jpeg' && type !== 'image/webp') throw httpError(415, 'Thumbnails must be JPEG or WebP');
    const filename = `${image.id}.thumb${type === 'image/webp' ? '.webp' : '.jpg'}`;
    await store.saveStream(req, filename, MAX_THUMB_BYTES);
    if (image.thumbFile && image.thumbFile !== filename) {
      await fsp.rm(store.filePath(image.thumbFile), { force: true });
    }
    image.thumbFile = filename;
    store.save();
    sendJson(res, 200, { image: adminImage(image) });
  });

  route('PATCH', '/api/images/:id', async ({ req, res, params }) => {
    const image = requireImage(params.id);
    const body = await readJson(req);
    if ('title' in body) image.title = text(body.title, 120);
    if ('notes' in body) image.notes = text(body.notes, 1000);
    if ('tags' in body) image.tags = tagList(body.tags);
    if ('width' in body) image.width = Number(body.width) || image.width;
    if ('height' in body) image.height = Number(body.height) || image.height;
    if ('tabId' in body) {
      const tab = requireTab(text(body.tabId, 64));
      image.tabId = tab.id;
      image.folderId = tab.folderId;
      image.sort = store.nextSort(tab.id);
    }
    store.save();
    sendJson(res, 200, { image: adminImage(image) });
  });

  route('DELETE', '/api/images/:id', async ({ res, params }) => {
    const image = requireImage(params.id);
    store.deleteImage(image.id);
    await store.removeFiles(image);
    sendJson(res, 200, { ok: true });
  });

  // ---- client gallery ----------------------------------------------------

  const requirePublished = (link) => {
    const folder = store.folderByLink(link);
    if (!folder || folder.status !== 'published') throw httpError(404, 'This gallery is not available');
    return folder;
  };

  publicRoute('GET', '/api/g/:link', ({ req, res, url, params }) => {
    const rootFolder = requirePublished(params.link);
    const wanted = text(url.searchParams.get('f'), 64) || rootFolder.id;
    const currentFolder = visibleDescendant(rootFolder.id, wanted);
    if (!currentFolder) throw httpError(404, 'That folder is not part of this gallery');
    sendJson(res, 200, galleryPayload({
      rootFolder,
      currentFolder,
      req,
      clientSessionId: text(url.searchParams.get('clientSessionId'), 64),
    }));
  });

  publicRoute('POST', '/api/g/:link/select', async ({ req, res, params }) => {
    const rootFolder = requirePublished(params.link);
    const body = await readJson(req);
    const clientSessionId = text(body.clientSessionId, 64);
    if (!clientSessionId) throw httpError(400, 'Missing client session id');

    const image = store.image(text(body.imageId, 64));
    if (!image) throw httpError(404, 'Image not found');
    // Only images the client can actually see may be favourited, so a guessed
    // id from a locked tab cannot be used to confirm that it exists.
    const unlocked = unlockedFor(req, image.folderId);
    if (!visibleImageIds(rootFolder.id, unlocked).has(image.id)) throw httpError(404, 'Image not found');

    const selection = store.setSelection({
      rootFolderId: rootFolder.id,
      imageId: image.id,
      clientSessionId,
      clientName: text(body.clientName, 80),
      note: typeof body.note === 'string' ? text(body.note, 500) : undefined,
      selected: bool(body.selected, true),
    });
    sendJson(res, 200, {
      selected: Boolean(selection),
      note: selection ? selection.note : '',
      totalSelected: store.selectionsBy(rootFolder.id, clientSessionId).length,
    });
  });

  publicRoute('POST', '/api/g/:link/unlock', async ({ req, res, params }) => {
    const rootFolder = requirePublished(params.link);
    const key = `${clientAddress(req)}:${rootFolder.id}`;
    if (pinThrottle.blocked(key)) {
      throw httpError(429, `Too many tries. Wait ${pinThrottle.retryInSeconds(key)}s and try again.`);
    }
    const pinHash = effectivePinHash(rootFolder.id);
    // No PIN set means nothing can be unlocked: downloads and PIN-only tabs
    // stay closed rather than falling open.
    if (!pinHash) throw httpError(409, 'Your photographer has not set a download PIN for this gallery yet');

    const body = await readJson(req);
    if (!verifyPin(text(body.pin, 32), pinHash)) {
      pinThrottle.recordFailure(key);
      throw httpError(401, 'That PIN is not right');
    }
    pinThrottle.clear(key);
    const token = createGrant(config.sessionSecret, rootFolder.id);
    res.setHeader('set-cookie', grantCookie(req, rootFolder.id, token, GRANT_MAX_AGE_SECONDS));
    sendJson(res, 200, { ok: true, expiresInSeconds: GRANT_MAX_AGE_SECONDS });
  });

  publicRoute('POST', '/api/g/:link/lock', ({ req, res, params }) => {
    const rootFolder = requirePublished(params.link);
    res.setHeader('set-cookie', grantCookie(req, rootFolder.id, '', 0));
    sendJson(res, 200, { ok: true });
  });

  publicRoute('POST', '/api/g/:link/handoff', async ({ req, res, params }) => {
    const rootFolder = requirePublished(params.link);
    const body = await readJson(req);
    const clientSessionId = text(body.clientSessionId, 64);
    if (!clientSessionId) throw httpError(400, 'Missing client session id');

    const key = `${clientAddress(req)}:${rootFolder.id}:${clientSessionId}`;
    if (handoffThrottle.blocked(key)) {
      throw httpError(429, `Already sent a few times. Wait ${handoffThrottle.retryInSeconds(key)}s.`);
    }
    handoffThrottle.recordFailure(key);

    const selections = store.selectionsBy(rootFolder.id, clientSessionId);
    if (!selections.length) throw httpError(400, 'Pick at least one image before sending');

    const url = effectiveWebhookUrl(rootFolder.id);
    if (!url) throw httpError(501, 'No handoff address is configured for this gallery');

    const detailed = selections
      .map((selection) => {
        const image = store.image(selection.imageId);
        if (!image) return null;
        const tab = store.tab(image.tabId);
        return {
          imageId: image.id,
          fileName: image.originalName || image.id,
          folderPath: store.pathOf(image.folderId).map((f) => f.title).join(' / '),
          tab: tab ? tab.title : '',
          note: selection.note,
        };
      })
      .filter(Boolean);

    const result = await sendWebhook({
      url,
      secret: config.webhookSecret,
      payload: {
        galleryId: rootFolder.id,
        galleryTitle: rootFolder.title,
        clientName: text(body.clientName, 80) || selections[0].clientName || '',
        total_selected: detailed.length,
        selected_files: detailed.map((entry) => entry.fileName),
        selections: detailed,
        sentAt: nowIso(),
      },
    });

    // The spec is explicit: the client is told it worked only on a 200.
    if (!result.ok) {
      return sendJson(res, 502, { error: result.error, webhookStatus: result.status });
    }
    handoffThrottle.clear(key);
    sendJson(res, 200, { ok: true, total_selected: detailed.length });
  });

  // ---- image files -------------------------------------------------------

  /**
   * `kind` is 'i' (full, inline), 't' (thumbnail, inline) or 'd' (download).
   *
   * The signed-in studio sees everything. A client sees an image only when its
   * folder is published and its tab is open — or when they hold a live grant
   * from entering the PIN. Downloads always need that grant, so a gallery with
   * no PIN set simply has no working download route.
   */
  async function serveImage(req, res, kind, imageId) {
    const image = store.image(imageId);
    if (!image) return sendError(res, 404, 'Not found');
    const tab = store.tab(image.tabId);
    const folder = store.folder(image.folderId);
    if (!tab || !folder) return sendError(res, 404, 'Not found');

    const admin = isAuthed(req, config.sessionSecret);
    if (!admin) {
      if (folder.status !== 'published') return sendError(res, 404, 'Not found');
      const unlocked = unlockedFor(req, folder.id);
      if (tab.access === 'pin' && !unlocked) return sendError(res, 404, 'Not found');
      if (kind === 'd') {
        if (!tab.downloadable) return sendError(res, 403, 'These images are not available to download');
        if (!unlocked) return sendError(res, 401, 'Enter the gallery PIN to download');
      }
    }

    const filename = kind === 't' && image.thumbFile ? image.thumbFile : image.file;
    const filePath = store.filePath(filename);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return sendError(res, 404, 'File missing on disk');
    }

    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    const safeName = (image.originalName || filename).replace(/[^\w.\- ]/g, '_');
    const etag = `"${crypto.createHash('sha1').update(`${filename}:${stat.size}:${stat.mtimeMs}`).digest('base64url')}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      return res.end();
    }

    res.writeHead(200, {
      'content-type': MIME_BY_EXT.get(ext) || image.mime || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'private, max-age=604800',
      'content-disposition': `${kind === 'd' ? 'attachment' : 'inline'}; filename="${safeName}"`,
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
        if (status >= 500 && status !== 501) console.error('[api]', req.method, url.pathname, err);
        return sendJson(res, status, {
          error: status >= 500 && status !== 501 && status !== 502
            ? 'Something went wrong on the server'
            : err.message,
        });
      }
    }
    return sendError(res, 404, 'Unknown endpoint');
  }

  return { handle, serveImage };
}
