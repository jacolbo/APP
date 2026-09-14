import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { newId, nowIso } from './util.js';
import { hashPin } from './pin.js';

/**
 * Folders nest without a fixed limit, but not literally without end: tree
 * walks recurse, breadcrumbs have to render, and the whole dataset lives in
 * memory. Twenty levels is far past anything a studio will build by hand and
 * keeps a runaway tree from taking the process down.
 */
export const MAX_DEPTH = 20;

const EMPTY_DB = { version: 2, folders: [], tabs: [], images: [], selections: [] };

/** Tabs a new folder starts with: one to show, one to hand over. */
const DEFAULT_TABS = [
  { title: 'Previews', access: 'open', downloadable: false },
  { title: 'Final images', access: 'pin', downloadable: true },
];

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Fields added after the first v2 release. Filling them in on load keeps the
 * rest of the code free of `?? 0` and means an older file needs no migration.
 */
function withFolderDefaults(folder) {
  return {
    downloadPinMaxUses: null,
    downloadPinUses: 0,
    ...folder,
  };
}

function withSelectionDefaults(selection) {
  return { clientEmail: '', ...selection };
}

/**
 * v1 stored flat `collections` / `photos` / `picks`. Every collection becomes
 * a root folder with a single open tab holding its photos, so an existing
 * library keeps working — same files on disk, same share links, same picks.
 * The old view-PIN becomes the download PIN, hashed on the way in.
 */
function migrateV1(parsed) {
  const db = structuredClone(EMPTY_DB);
  const tabByCollection = new Map();

  for (const collection of arrayOf(parsed.collections)) {
    db.folders.push({
      id: collection.id,
      parentId: null,
      title: collection.title || 'Untitled',
      clientName: collection.clientName || '',
      description: collection.description || '',
      coverImageId: collection.coverPhotoId || null,
      uniqueLink: collection.shareId || newId('s'),
      downloadPinHash: collection.pin ? hashPin(String(collection.pin)) : null,
      downloadPinMaxUses: null,
      downloadPinUses: 0,
      status: collection.published ? 'published' : 'draft',
      webhookUrl: null,
      sort: 0,
      createdAt: collection.createdAt || nowIso(),
      updatedAt: collection.updatedAt || nowIso(),
    });
    const tab = {
      id: newId('tab'),
      folderId: collection.id,
      title: 'Photos',
      access: 'open',
      downloadable: true,
      sort: 0,
      createdAt: nowIso(),
    };
    db.tabs.push(tab);
    tabByCollection.set(collection.id, tab.id);
  }

  for (const photo of arrayOf(parsed.photos)) {
    const tabId = tabByCollection.get(photo.collectionId);
    if (!tabId) continue; // orphan photo: its collection is gone
    db.images.push({
      id: photo.id,
      tabId,
      folderId: photo.collectionId,
      file: photo.file,
      mime: photo.mime || 'application/octet-stream',
      size: photo.size || 0,
      thumbFile: photo.thumbFile || null,
      width: photo.width || 0,
      height: photo.height || 0,
      originalName: photo.originalName || '',
      title: photo.title || '',
      notes: photo.notes || '',
      tags: arrayOf(photo.tags),
      sort: photo.sort || 0,
      createdAt: photo.createdAt || nowIso(),
    });
  }

  for (const pick of arrayOf(parsed.picks)) {
    db.selections.push({
      id: pick.id,
      rootFolderId: pick.collectionId,
      imageId: pick.photoId,
      clientSessionId: pick.clientKey,
      clientName: pick.clientName || '',
      clientEmail: '',
      note: pick.note || '',
      createdAt: pick.createdAt || nowIso(),
      updatedAt: pick.updatedAt || nowIso(),
    });
  }

  return db;
}

/**
 * Tiny JSON-file database. The whole dataset is held in memory and written
 * back atomically (temp file + rename) through a serialised write chain, so a
 * crash mid-write cannot leave a half-written db.json behind.
 *
 * Deliberately dependency-free and sized for one studio's library, not for
 * high-concurrency multi-tenant use — it is a single process holding one file.
 */
export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'db.json');
    this.filesDir = path.join(dataDir, 'files');
    this.data = structuredClone(EMPTY_DB);
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.filesDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fsp.readFile(this.dbPath, 'utf8'));
      if (parsed.version === 2) {
        this.data = {
          version: 2,
          folders: arrayOf(parsed.folders).map(withFolderDefaults),
          tabs: arrayOf(parsed.tabs),
          images: arrayOf(parsed.images),
          selections: arrayOf(parsed.selections).map(withSelectionDefaults),
        };
      } else {
        // Keep the v1 file around; the migration is one-way.
        await fsp.copyFile(this.dbPath, `${this.dbPath}.v1.bak`);
        this.data = migrateV1(parsed);
        await this.save();
        console.log('[store] migrated db.json to v2 (v1 kept as db.json.v1.bak)');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this.save();
    }
    return this;
  }

  save() {
    this.writeChain = this.writeChain
      .then(async () => {
        const tmp = `${this.dbPath}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2));
        await fsp.rename(tmp, this.dbPath);
      })
      .catch((err) => {
        console.error('[store] failed to write db.json:', err);
      });
    return this.writeChain;
  }

  // ---- folders -----------------------------------------------------------

  folder(id) {
    return this.data.folders.find((f) => f.id === id) || null;
  }

  folderByLink(uniqueLink) {
    if (!uniqueLink) return null;
    return this.data.folders.find((f) => f.uniqueLink === uniqueLink) || null;
  }

  childFolders(parentId) {
    return this.data.folders
      .filter((f) => f.parentId === (parentId || null))
      .sort((a, b) => a.sort - b.sort || a.createdAt.localeCompare(b.createdAt));
  }

  /** Root first, the folder itself last. Bounded so bad data cannot loop. */
  pathOf(id) {
    const chain = [];
    let current = this.folder(id);
    for (let hops = 0; current && hops <= MAX_DEPTH + 2; hops += 1) {
      chain.unshift(current);
      current = current.parentId ? this.folder(current.parentId) : null;
    }
    return chain;
  }

  ancestorIds(id) {
    return this.pathOf(id).slice(0, -1).map((f) => f.id);
  }

  depthOf(id) {
    return this.pathOf(id).length;
  }

  /** The folder plus every folder beneath it, breadth first. */
  subtreeIds(id) {
    const ids = [];
    const queue = [id];
    while (queue.length) {
      const current = queue.shift();
      if (ids.includes(current)) continue; // defensive: a cycle in stored data
      ids.push(current);
      for (const child of this.childFolders(current)) queue.push(child.id);
    }
    return ids;
  }

  createFolder({ parentId = null, title, clientName = '', description = '', withDefaultTabs = true }) {
    if (parentId) {
      const parent = this.folder(parentId);
      if (!parent) throw Object.assign(new Error('That parent folder does not exist'), { status: 404 });
      if (this.depthOf(parentId) >= MAX_DEPTH) {
        throw Object.assign(
          new Error(`Folders can only be nested ${MAX_DEPTH} levels deep`),
          { status: 400 },
        );
      }
    }
    const siblings = this.childFolders(parentId);
    const folder = {
      id: newId('fld'),
      parentId: parentId || null,
      title,
      clientName,
      description,
      coverImageId: null,
      uniqueLink: newId('s'),
      downloadPinHash: null,
      downloadPinMaxUses: null,
      downloadPinUses: 0,
      status: 'draft',
      webhookUrl: null,
      sort: siblings.length ? siblings[siblings.length - 1].sort + 1 : 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.data.folders.push(folder);
    if (withDefaultTabs) {
      for (const [index, tab] of DEFAULT_TABS.entries()) {
        this.createTab({ folderId: folder.id, ...tab, sort: index, defer: true });
      }
    }
    this.save();
    return folder;
  }

  /** Rejects a move that would put a folder inside its own subtree, or too deep. */
  moveFolder(id, newParentId) {
    const folder = this.folder(id);
    if (!folder) throw Object.assign(new Error('Folder not found'), { status: 404 });
    const target = newParentId || null;
    if (target === id) throw Object.assign(new Error('A folder cannot contain itself'), { status: 400 });
    if (target) {
      if (!this.folder(target)) throw Object.assign(new Error('That parent folder does not exist'), { status: 404 });
      if (this.subtreeIds(id).includes(target)) {
        throw Object.assign(new Error('A folder cannot be moved inside itself'), { status: 400 });
      }
      const deepest = Math.max(...this.subtreeIds(id).map((sub) => this.depthOf(sub)));
      const heightBelow = deepest - this.depthOf(id);
      if (this.depthOf(target) + 1 + heightBelow > MAX_DEPTH) {
        throw Object.assign(
          new Error(`That move would nest folders more than ${MAX_DEPTH} levels deep`),
          { status: 400 },
        );
      }
    }
    folder.parentId = target;
    folder.updatedAt = nowIso();
    this.save();
    return folder;
  }

  /** Removes the folder and everything under it. Returns the images so the caller can unlink files. */
  deleteFolder(id) {
    const ids = this.subtreeIds(id);
    const images = this.data.images.filter((img) => ids.includes(img.folderId));
    const imageIds = images.map((img) => img.id);
    this.data.folders = this.data.folders.filter((f) => !ids.includes(f.id));
    this.data.tabs = this.data.tabs.filter((t) => !ids.includes(t.folderId));
    this.data.images = this.data.images.filter((img) => !ids.includes(img.folderId));
    this.data.selections = this.data.selections.filter(
      (s) => !ids.includes(s.rootFolderId) && !imageIds.includes(s.imageId),
    );
    this.save();
    return images;
  }

  // ---- tabs --------------------------------------------------------------

  tab(id) {
    return this.data.tabs.find((t) => t.id === id) || null;
  }

  tabsIn(folderId) {
    return this.data.tabs
      .filter((t) => t.folderId === folderId)
      .sort((a, b) => a.sort - b.sort || a.createdAt.localeCompare(b.createdAt));
  }

  createTab({ folderId, title, access = 'open', downloadable = false, sort = null, defer = false }) {
    const siblings = this.tabsIn(folderId);
    const tab = {
      id: newId('tab'),
      folderId,
      title,
      access: access === 'pin' ? 'pin' : 'open',
      downloadable: Boolean(downloadable),
      sort: sort === null ? (siblings.length ? siblings[siblings.length - 1].sort + 1 : 0) : sort,
      createdAt: nowIso(),
    };
    this.data.tabs.push(tab);
    if (!defer) this.save();
    return tab;
  }

  deleteTab(id) {
    const images = this.data.images.filter((img) => img.tabId === id);
    const imageIds = images.map((img) => img.id);
    this.data.tabs = this.data.tabs.filter((t) => t.id !== id);
    this.data.images = this.data.images.filter((img) => img.tabId !== id);
    this.data.selections = this.data.selections.filter((s) => !imageIds.includes(s.imageId));
    for (const folder of this.data.folders) {
      if (imageIds.includes(folder.coverImageId)) folder.coverImageId = null;
    }
    this.save();
    return images;
  }

  // ---- images ------------------------------------------------------------

  image(id) {
    return this.data.images.find((img) => img.id === id) || null;
  }

  imagesIn(tabId) {
    return this.data.images
      .filter((img) => img.tabId === tabId)
      .sort((a, b) => a.sort - b.sort || a.createdAt.localeCompare(b.createdAt));
  }

  imagesInFolder(folderId) {
    return this.data.images.filter((img) => img.folderId === folderId);
  }

  nextSort(tabId) {
    const images = this.imagesIn(tabId);
    return images.length ? images[images.length - 1].sort + 1 : 0;
  }

  addImage(image) {
    this.data.images.push(image);
    this.save();
    return image;
  }

  deleteImage(id) {
    const image = this.image(id);
    if (!image) return null;
    this.data.images = this.data.images.filter((img) => img.id !== id);
    this.data.selections = this.data.selections.filter((s) => s.imageId !== id);
    for (const folder of this.data.folders) {
      if (folder.coverImageId === id) folder.coverImageId = null;
    }
    this.save();
    return image;
  }

  reorderImages(tabId, orderedIds) {
    const remaining = new Set(this.imagesIn(tabId).map((img) => img.id));
    let sort = 0;
    for (const id of orderedIds) {
      if (!remaining.has(id)) continue;
      this.image(id).sort = sort++;
      remaining.delete(id);
    }
    // Anything the client did not mention keeps its relative order at the end.
    for (const id of remaining) this.image(id).sort = sort++;
    this.save();
  }

  // ---- selections --------------------------------------------------------

  selectionsIn(rootFolderId) {
    return this.data.selections.filter((s) => s.rootFolderId === rootFolderId);
  }

  selectionsBy(rootFolderId, clientSessionId) {
    return this.data.selections.filter(
      (s) => s.rootFolderId === rootFolderId && s.clientSessionId === clientSessionId,
    );
  }

  /** Upsert or remove one favourite. (imageId, clientSessionId) is unique. */
  setSelection({ rootFolderId, imageId, clientSessionId, clientName, clientEmail, note, selected }) {
    const existing = this.data.selections.find(
      (s) => s.imageId === imageId && s.clientSessionId === clientSessionId,
    );
    if (!selected) {
      if (existing) {
        this.data.selections = this.data.selections.filter((s) => s !== existing);
        this.save();
      }
      return null;
    }
    if (existing) {
      if (clientName) existing.clientName = clientName;
      if (clientEmail) existing.clientEmail = clientEmail;
      if (typeof note === 'string') existing.note = note;
      existing.updatedAt = nowIso();
      this.save();
      return existing;
    }
    const selection = {
      id: newId('sel'),
      rootFolderId,
      imageId,
      clientSessionId,
      clientName: clientName || '',
      clientEmail: clientEmail || '',
      note: typeof note === 'string' ? note : '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.data.selections.push(selection);
    this.save();
    return selection;
  }

  /**
   * Name and email are recorded against every selection this visitor has already
   * made, so identifying yourself after picking a few still labels them all.
   */
  identify(rootFolderId, clientSessionId, { clientName, clientEmail }) {
    let touched = 0;
    for (const selection of this.selectionsBy(rootFolderId, clientSessionId)) {
      if (clientName) selection.clientName = clientName;
      if (clientEmail) selection.clientEmail = clientEmail;
      selection.updatedAt = nowIso();
      touched += 1;
    }
    if (touched) this.save();
    return touched;
  }

  /** The session id an email already picked under in this gallery, if any. */
  sessionForEmail(rootFolderId, clientEmail) {
    const wanted = String(clientEmail).trim().toLowerCase();
    if (!wanted) return null;
    const match = this.selectionsIn(rootFolderId)
      .filter((s) => (s.clientEmail || '').toLowerCase() === wanted)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    return match ? match.clientSessionId : null;
  }

  /** How many tabs in this folder are open to anyone holding the link. */
  openTabCount(folderId, { exceptTabId = null, plusAccess = null } = {}) {
    let count = this.tabsIn(folderId)
      .filter((tab) => tab.id !== exceptTabId && tab.access === 'open')
      .length;
    if (plusAccess === 'open') count += 1;
    return count;
  }

  // ---- files -------------------------------------------------------------

  /** Absolute path for a stored file. basename() keeps it inside filesDir. */
  filePath(filename) {
    return path.join(this.filesDir, path.basename(filename));
  }

  async removeFiles(image) {
    if (!image) return;
    for (const name of [image.file, image.thumbFile]) {
      if (!name) continue;
      await fsp.rm(this.filePath(name), { force: true });
    }
  }

  /** Stream a request body straight to disk, aborting if it exceeds `limit`. */
  async saveStream(req, filename, limit) {
    const dest = this.filePath(filename);
    const tmp = `${dest}.part`;
    const out = fs.createWriteStream(tmp);
    let size = 0;
    try {
      await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > limit) {
            out.destroy();
            req.destroy();
            reject(Object.assign(new Error('File is larger than the upload limit'), { status: 413 }));
          }
        });
        req.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        req.pipe(out);
      });
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    if (size === 0) {
      await fsp.rm(tmp, { force: true });
      throw Object.assign(new Error('Empty upload'), { status: 400 });
    }
    await fsp.rename(tmp, dest);
    return size;
  }
}
