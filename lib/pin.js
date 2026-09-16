import crypto from 'node:crypto';

/**
 * Download PINs are stored as scrypt hashes, never in the clear, so a leaked
 * db.json does not hand over every gallery's PIN.
 *
 * Be clear-eyed about the limit: a 4-digit PIN has 10,000 possible values, so
 * anyone holding the hash can brute force it in seconds. The hash protects
 * against casual reading of db.json; the per-gallery rate limit in api.js is
 * what protects against guessing over the network.
 */
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

export const PIN_PATTERN = /^[0-9]{4,12}$/;

export function isValidPin(pin) {
  return typeof pin === 'string' && PIN_PATTERN.test(pin);
}

export function hashPin(pin) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = crypto.scryptSync(String(pin), salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Constant-time. Returns false for anything malformed rather than throwing. */
export function verifyPin(pin, stored) {
  if (typeof stored !== 'string' || typeof pin !== 'string' || !pin) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'base64url');
    const expected = Buffer.from(parts[2], 'base64url');
    if (salt.length !== SALT_BYTES || expected.length !== KEY_LENGTH) return false;
    const actual = crypto.scryptSync(pin, salt, KEY_LENGTH);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
