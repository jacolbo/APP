import crypto from 'node:crypto';
import { parseCookies } from './util.js';

/**
 * A download grant is what a client gets back for entering the right PIN: a
 * short-lived, HMAC-signed token naming one folder. It unlocks `access: 'pin'`
 * tabs and the /d/ download route for that folder's subtree, and nothing else.
 *
 * Nothing is stored server side, so grants cannot be enumerated, and every
 * outstanding grant dies at once if data/session.key is deleted.
 */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createGrant(secret, folderId, ttlMs = DEFAULT_TTL_MS) {
  const payload = Buffer.from(JSON.stringify({ f: folderId, exp: Date.now() + ttlMs }))
    .toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the folder id the token unlocks, or null if it is bad or expired. */
export function readGrant(token, secret) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payload, secret);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof claims.exp !== 'number' || claims.exp <= Date.now()) return null;
    return typeof claims.f === 'string' ? claims.f : null;
  } catch {
    return null;
  }
}

export function grantCookieName(folderId) {
  return `dl_${folderId}`;
}

export const GRANT_MAX_AGE_SECONDS = DEFAULT_TTL_MS / 1000;

function isHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || Boolean(req.socket?.encrypted);
}

export function grantCookie(req, folderId, token, maxAgeSeconds) {
  const parts = [
    `${grantCookieName(folderId)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

/**
 * True when the request carries a live grant for any of `folderIds` — the
 * folder itself or one of its ancestors, since the client unlocks at the
 * gallery they opened and that unlock should hold as they browse into it.
 */
export function hasGrant(req, folderIds, secret) {
  const cookies = parseCookies(req);
  for (const id of folderIds) {
    const token = cookies[grantCookieName(id)];
    if (token && readGrant(token, secret) === id) return true;
  }
  return false;
}
