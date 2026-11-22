import fs from 'node:fs';
import path from 'node:path';

export class PathError extends Error {}

/** Names we never show or allow: hidden files, NAS system folders, recycle bins. */
export function isHiddenName(name: string): boolean {
  return (
    name.startsWith('.') ||
    name.startsWith('@') ||
    name.startsWith('#') ||
    name.startsWith('$') ||
    name.toLowerCase() === 'thumbs.db'
  );
}

/**
 * Turn a user-supplied relative path into a safe, normalised relative path
 * ("2026/Week 12 backup/Smith"). Throws PathError on anything suspicious.
 * Does not touch the disk.
 */
export function cleanRelPath(input: unknown): string {
  if (input === undefined || input === null || input === '') return '';
  if (typeof input !== 'string') throw new PathError('Invalid path');
  if (input.length > 1024 || input.includes('\0')) throw new PathError('Invalid path');
  const parts = input.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..' || isHiddenName(p) || /^[a-zA-Z]:$/.test(p)) throw new PathError('Invalid path');
  }
  return parts.join('/');
}

/**
 * Resolve a relative path inside root, following symlinks, and verify the real
 * location is still inside root. Returns the absolute real path.
 */
export function resolveInside(root: string, rel: unknown): string {
  const clean = cleanRelPath(rel);
  const realRoot = fs.realpathSync(root);
  const candidate = path.resolve(realRoot, clean);
  if (!isWithin(realRoot, candidate)) throw new PathError('Invalid path');
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new PathError('Not found');
  }
  if (!isWithin(realRoot, real)) throw new PathError('Invalid path');
  return real;
}

export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A single file name (no slashes) that is safe to join onto a folder. */
export function cleanFileName(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 255) {
    throw new PathError('Invalid file name');
  }
  if (input.includes('/') || input.includes('\\') || input.includes('\0') || input === '..' || isHiddenName(input)) {
    throw new PathError('Invalid file name');
  }
  return input;
}
