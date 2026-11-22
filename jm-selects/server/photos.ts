import fs from 'node:fs/promises';
import path from 'node:path';
import { isHiddenName, resolveInside } from './paths.js';

export function isJpeg(name: string): boolean {
  return /\.jpe?g$/i.test(name) && !isHiddenName(name);
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

export interface PhotoEntry {
  name: string;
  size: number;
  mtimeMs: number;
}

/** JPEG files directly inside a folder (not recursive), naturally sorted. */
export async function listJpegs(absDir: string): Promise<PhotoEntry[]> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const out: PhotoEntry[] = [];
  await Promise.all(
    entries
      .filter((e) => e.isFile() && isJpeg(e.name))
      .map(async (e) => {
        try {
          const st = await fs.stat(path.join(absDir, e.name));
          // Skip zero-byte files: usually a copy still in progress.
          if (st.size > 0) out.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* file vanished between readdir and stat */
        }
      }),
  );
  return out.sort((a, b) => naturalCompare(a.name, b.name));
}

/** Short-lived cache so many tablets polling one folder don't hammer the NAS disks. */
export class FolderCache {
  private cache = new Map<string, { at: number; photos: Promise<PhotoEntry[]> }>();
  constructor(private ttlMs = 3000) {}

  get(absDir: string, force = false): Promise<PhotoEntry[]> {
    const hit = this.cache.get(absDir);
    if (!force && hit && Date.now() - hit.at < this.ttlMs) return hit.photos;
    const photos = listJpegs(absDir);
    this.cache.set(absDir, { at: Date.now(), photos });
    photos.catch(() => this.cache.delete(absDir));
    return photos;
  }
}

export interface BrowseEntry {
  name: string;
  path: string;
  jpegCount?: number;
}

/**
 * Staff folder browser. Level 0 = photos root (years), level 1 = inside a year
 * (only "<week> backup" folders), level 2+ = client folders.
 */
export async function browse(root: string, rel: string, backupSuffix: string): Promise<BrowseEntry[]> {
  const abs = resolveInside(root, rel);
  const depth = rel === '' ? 0 : rel.split('/').length;
  const entries = await fs.readdir(abs, { withFileTypes: true });
  let dirs = entries.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !isHiddenName(e.name));
  if (depth === 1) {
    dirs = dirs.filter((e) => e.name.toLowerCase().trimEnd().endsWith(backupSuffix));
  }
  const out: BrowseEntry[] = [];
  for (const d of dirs) {
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    try {
      const childAbs = resolveInside(root, childRel); // rejects symlinks pointing outside
      const st = await fs.stat(childAbs);
      if (!st.isDirectory()) continue;
      const entry: BrowseEntry = { name: d.name, path: childRel };
      if (depth >= 2) {
        const files = await fs.readdir(childAbs, { withFileTypes: true });
        entry.jpegCount = files.filter((f) => f.isFile() && isJpeg(f.name)).length;
      }
      out.push(entry);
    } catch {
      /* skip unreadable or unsafe entries */
    }
  }
  return out.sort((a, b) => (depth === 0 ? naturalCompare(b.name, a.name) : naturalCompare(a.name, b.name)));
}
