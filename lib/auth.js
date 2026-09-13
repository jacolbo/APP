import crypto from 'node:crypto';
import { parseCookies } from './util.js';

export const COOKIE_NAME = 'pose_session';
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Stateless signed session token: base64url(payload).hmac
 * Sessions survive a server restart because the signing key is persisted,
 * but every token can be invalidated at once by deleting data/session.key.
 */
export function createSessionToken(secret, ttlMs = DEFAULT_TTL_MS) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ttlMs })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(token, secret) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payload, secret);
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof claims.exp === 'number' && claims.exp > Date.now();
  } catch {
    return false;
  }
}

export function isAuthed(req, secret) {
  return verifySessionToken(parseCookies(req)[COOKIE_NAME], secret);
}

function isHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || Boolean(req.socket?.encrypted);
}

export function sessionCookie(req, token, maxAgeSeconds) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Small in-memory throttle so the admin password cannot be brute forced
 * from a single address. Resets when the process restarts.
 */
export class LoginThrottle {
  constructor({ maxAttempts = 8, windowMs = 15 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.attempts = new Map();
  }

  #entry(key) {
    const entry = this.attempts.get(key);
    if (!entry || Date.now() > entry.resetAt) {
      const fresh = { count: 0, resetAt: Date.now() + this.windowMs };
      this.attempts.set(key, fresh);
      return fresh;
    }
    return entry;
  }

  blocked(key) {
    return this.#entry(key).count >= this.maxAttempts;
  }

  retryInSeconds(key) {
    return Math.max(1, Math.ceil((this.#entry(key).resetAt - Date.now()) / 1000));
  }

  recordFailure(key) {
    this.#entry(key).count += 1;
  }

  clear(key) {
    this.attempts.delete(key);
  }
}
