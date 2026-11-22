import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isHiddenName, isWithin } from './paths.js';
import { naturalCompare } from './photos.js';

/** Camera RAW extensions (lower case, no dot). */
export const RAW_EXTENSIONS = new Set([
  'cr3', 'cr2', 'crw', // Canon
  'nef', 'nrw', // Nikon
  'arw', 'srf', 'sr2', // Sony
  'raf', // Fujifilm
  'dng', // Adobe / Leica / phones
  'orf', // Olympus / OM System
  'rw2', 'rwl', // Panasonic / Leica
  'pef', // Pentax
  'srw', // Samsung
  'x3f', // Sigma
  '3fr', 'fff', // Hasselblad
  'iiq', // Phase One
  'erf', 'mef', 'mos', 'mrw', 'kdc', 'dcr',
]);

export function rawExtension(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return RAW_EXTENSIONS.has(ext) ? ext : null;
}

/** Base name used for matching: everything before the last dot, case-insensitive. */
export const matchKey = (name: string) => {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
};

export interface RawFile {
  abs: string;
  /** Path relative to the client folder, e.g. "RAW/JM_0001.CR3". */
  rel: string;
  name: string;
  size: number;
}

/**
 * Index all RAW files in a client folder and its subfolders (hidden/NAS system folders
 * skipped, symlinks not followed). Read-only.
 */
export async function indexRaws(clientDir: string, maxDepth = 6): Promise<Map<string, RawFile[]>> {
  const index = new Map<string, RawFile[]>();
  const walk = async (dir: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (isHiddenName(e.name)) continue;
      const abs = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(abs, childRel, depth + 1);
      } else if (e.isFile() && rawExtension(e.name)) {
        try {
          const st = await fsp.stat(abs);
          if (st.size === 0) continue;
          const key = matchKey(e.name);
          const list = index.get(key) ?? [];
          list.push({ abs, rel: childRel, name: e.name, size: st.size });
          index.set(key, list);
        } catch {
          /* vanished */
        }
      }
    }
  };
  await walk(clientDir, '', 0);
  // Prefer the RAW next to the JPEG (top of the client folder), then shallowest, then by name.
  for (const list of index.values()) {
    list.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || naturalCompare(a.rel, b.rel));
  }
  return index;
}

export interface MatchResult {
  matched: { jpeg: string; raw: RawFile; alternatives: number }[];
  missing: string[];
}

export function matchRaws(jpegNames: string[], index: Map<string, RawFile[]>): MatchResult {
  const matched: MatchResult['matched'] = [];
  const missing: string[] = [];
  for (const jpeg of [...jpegNames].sort(naturalCompare)) {
    const list = index.get(matchKey(jpeg));
    if (list?.length) matched.push({ jpeg, raw: list[0], alternatives: list.length - 1 });
    else missing.push(jpeg);
  }
  return { matched, missing };
}

/** Make a folder name safe on the NAS and on Windows (SMB). Never empty, never "." or "..". */
export function safeSegment(input: string): string {
  const cleaned = input
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120)
    .trim();
  if (!cleaned || isHiddenName(cleaned) || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)) {
    return `_${cleaned.replace(/^[.@#$]+/, '') || 'unnamed'}`;
  }
  return cleaned;
}

/**
 * Work out <projects>/<year>/<week>/<client name> for a session.
 * The " backup" suffix is dropped from the week name ("Week 47 backup" → "Week 47").
 */
export function projectSegments(sessionFolder: string, clientName: string, backupSuffix = 'backup'): string[] {
  const parts = sessionFolder.split('/');
  const year = parts[0] ?? 'Unsorted';
  let week = parts[1] ?? 'Unsorted';
  const re = new RegExp(`[\\s_-]*${backupSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  week = week.replace(re, '') || week;
  return [safeSegment(year), safeSegment(week), safeSegment(clientName)];
}

export class UnsafeDestination extends Error {}

/**
 * Create (if needed) and return the destination folder, refusing anything that would
 * resolve outside the projects root — including through symlinks.
 */
export async function ensureProjectDir(projectsRoot: string, segments: string[]): Promise<string> {
  const realRoot = await fsp.realpath(projectsRoot);
  let current = realRoot;
  for (const seg of segments) {
    if (seg !== safeSegment(seg)) throw new UnsafeDestination(`Unsafe folder name: ${seg}`);
    const next = path.join(current, seg);
    if (!isWithin(realRoot, next)) throw new UnsafeDestination('Destination outside projects folder');
    try {
      await fsp.mkdir(next);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const real = await fsp.realpath(next);
    if (!isWithin(realRoot, real) || !(await fsp.stat(real)).isDirectory()) {
      throw new UnsafeDestination('Destination outside projects folder');
    }
    current = real;
  }
  return current;
}

export type CopyOutcome =
  | { status: 'copied'; bytes: number }
  | { status: 'exists' } // same name and size already there
  | { status: 'conflict'; message: string } // same name, different size: left alone
  | { status: 'failed'; message: string };

const PARTIAL_PREFIX = '.jm-partial-';

/**
 * Copy one file into destDir without ever overwriting. Copies to a hidden temp file,
 * checks the size matches the original, then publishes it under its real name with an
 * exclusive create. The original is only read.
 */
export async function copyOne(src: string, destDir: string, name: string, expectedSize: number): Promise<CopyOutcome> {
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.includes('\0')) {
    return { status: 'failed', message: 'Unsafe file name' };
  }
  const final = path.join(destDir, name);
  if (path.dirname(final) !== destDir) return { status: 'failed', message: 'Unsafe file name' };

  try {
    const st = await fsp.lstat(final);
    if (st.isFile() && st.size === expectedSize) return { status: 'exists' };
    return { status: 'conflict', message: `${name} already exists in the project folder with a different size; left untouched` };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { status: 'failed', message: String(e) };
  }

  const tmp = path.join(destDir, `${PARTIAL_PREFIX}${process.pid}-${Date.now()}-${name}`);
  try {
    await fsp.copyFile(src, tmp, fs.constants.COPYFILE_EXCL);
    const [a, b] = await Promise.all([fsp.stat(src), fsp.stat(tmp)]);
    if (a.size !== b.size || b.size !== expectedSize) {
      await fsp.rm(tmp, { force: true });
      return { status: 'failed', message: `${name}: copy size check failed` };
    }
    try {
      await fsp.link(tmp, final); // fails if `final` exists: never overwrites
      await fsp.rm(tmp, { force: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        await fsp.rm(tmp, { force: true });
        return { status: 'exists' };
      }
      // File system without hard links: exclusive copy instead (still never overwrites).
      await fsp.copyFile(tmp, final, fs.constants.COPYFILE_EXCL);
      await fsp.rm(tmp, { force: true });
      if ((await fsp.stat(final)).size !== expectedSize) {
        return { status: 'failed', message: `${name}: copy size check failed` };
      }
    }
    return { status: 'copied', bytes: expectedSize };
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return { status: 'exists' };
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      return { status: 'failed', message: 'The projects folder is not writable by the app (see README: Folder permissions)' };
    }
    if (code === 'ENOSPC') return { status: 'failed', message: 'The NAS disk is full' };
    return { status: 'failed', message: `${name}: ${(e as Error).message}` };
  }
}

/** Remove leftovers of our own interrupted copies (hidden ".jm-partial-" files only). */
export async function cleanPartials(destDir: string): Promise<void> {
  const entries = await fsp.readdir(destDir).catch(() => [] as string[]);
  await Promise.all(
    entries.filter((n) => n.startsWith(PARTIAL_PREFIX)).map((n) => fsp.rm(path.join(destDir, n), { force: true })),
  );
}

/** Can the app create files in this folder? */
export async function isWritable(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.jm-write-test-${process.pid}-${Date.now()}`);
  try {
    await fsp.writeFile(probe, '');
    await fsp.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}
