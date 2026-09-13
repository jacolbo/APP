import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { newId, nowIso } from './util.js';

const EMPTY_DB = { version: 1, collections: [], photos: [], picks: [] };

/**
 * Tiny JSON-file database. The whole dataset is held in memory and written
 * back atomically (temp file + rename) through a serialised write chain, so a
 * crash mid-write cannot leave a half-written db.json behind.
 *
 * This is deliberately dependency-free and is sized for one photographer's
 * library (thousands of photos), not for high-concurrency multi-tenant use.
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
      const raw = await fsp.readFile(this.dbPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        version: 1,
        collections: Array.isArray(parsed.collections) ? parsed.collections : [],
        photos: Array.isArray(parsed.photos) ? parsed.photos : [],
        picks: Array.isArray(parsed.picks) ? parsed.picks : [],
      };
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

  // ---- collections -------------------------------------------------------

  collections() {
    return [...this.data.collections].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  collection(id) {
    return this.data.collections.find((c) => c.id === id) || null;
  }

  collectionByShareId(shareId) {
    return this.data.collections.find((c) => c.shareId === shareId) || null;
  }

  createCollection({ title, clientName = '', description = '' }) {
    const collection = {
      id: newId('col'),
      title,
      clientName,
      description,
      shareId: newId('s'),
      pin: null,
      published: false,
      coverPhotoId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.data.collections.push(collection);
    this.save();
    return collection;
  }

  deleteCollection(id) {
    const photos = this.photosIn(id);
    this.data.collections = this.data.collections.filter((c) => c.id !== id);
    this.data.photos = this.data.photos.filter((p) => p.collectionId !== id);
    this.data.picks = this.data.picks.filter((p) => p.collectionId !== id);
    this.save();
    return photos;
  }

  // ---- photos ------------------------------------------------------------

  photo(id) {
    return this.data.photos.find((p) => p.id === id) || null;
  }

  photosIn(collectionId) {
    return this.data.photos
      .filter((p) => p.collectionId === collectionId)
      .sort((a, b) => a.sort - b.sort || a.createdAt.localeCompare(b.createdAt));
  }

  nextSort(collectionId) {
    const photos = this.photosIn(collectionId);
    return photos.length ? photos[photos.length - 1].sort + 1 : 0;
  }

  addPhoto(photo) {
    this.data.photos.push(photo);
    this.save();
    return photo;
  }

  deletePhoto(id) {
    const photo = this.photo(id);
    if (!photo) return null;
    this.data.photos = this.data.photos.filter((p) => p.id !== id);
    this.data.picks = this.data.picks.filter((p) => p.photoId !== id);
    for (const collection of this.data.collections) {
      if (collection.coverPhotoId === id) collection.coverPhotoId = null;
    }
    this.save();
    return photo;
  }

  reorderPhotos(collectionId, orderedIds) {
    const inCollection = new Set(this.photosIn(collectionId).map((p) => p.id));
    let sort = 0;
    for (const id of orderedIds) {
      if (!inCollection.has(id)) continue;
      this.photo(id).sort = sort++;
      inCollection.delete(id);
    }
    // Anything the client did not mention keeps its relative order at the end.
    for (const id of inCollection) this.photo(id).sort = sort++;
    this.save();
  }

  // ---- client picks ------------------------------------------------------

  picksIn(collectionId) {
    return this.data.picks.filter((p) => p.collectionId === collectionId);
  }

  picksBy(collectionId, clientKey) {
    return this.data.picks.filter((p) => p.collectionId === collectionId && p.clientKey === clientKey);
  }

  setPick({ collectionId, photoId, clientKey, clientName, note, picked }) {
    const existing = this.data.picks.find((p) => p.photoId === photoId && p.clientKey === clientKey);
    if (!picked) {
      if (existing) {
        this.data.picks = this.data.picks.filter((p) => p !== existing);
        this.save();
      }
      return null;
    }
    if (existing) {
      existing.clientName = clientName || existing.clientName;
      if (typeof note === 'string') existing.note = note;
      existing.updatedAt = nowIso();
      this.save();
      return existing;
    }
    const pick = {
      id: newId('pick'),
      collectionId,
      photoId,
      clientKey,
      clientName,
      note: typeof note === 'string' ? note : '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.data.picks.push(pick);
    this.save();
    return pick;
  }

  // ---- files -------------------------------------------------------------

  /** Absolute path for a stored file. basename() keeps it inside filesDir. */
  filePath(filename) {
    return path.join(this.filesDir, path.basename(filename));
  }

  async removeFiles(photo) {
    if (!photo) return;
    for (const name of [photo.file, photo.thumbFile]) {
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
