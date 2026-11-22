import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const COOKIE = 'jm_staff';
const SESSION_MS = 12 * 60 * 60 * 1000;

export function loadSecret(dataDir: string): Buffer {
  const file = path.join(dataDir, 'secret.key');
  try {
    return fs.readFileSync(file);
  } catch {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(file, key, { mode: 0o600 });
    return key;
  }
}

export function pinMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function makeStaffCookie(secret: Buffer, now = Date.now()): string {
  const exp = String(now + SESSION_MS);
  const sig = crypto.createHmac('sha256', secret).update(exp).digest('base64url');
  return `${exp}.${sig}`;
}

export function verifyStaffCookie(secret: Buffer, value: string | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const [exp, sig] = value.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  const expected = crypto.createHmac('sha256', secret).update(exp).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return false;
  }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export function readCookie(header: string | undefined, name = COOKIE): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

export function setCookieHeader(value: string): string {
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
}

export function clearCookieHeader(): string {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * PIN attempt limiter: 5 wrong PINs per device address locks it for 15 minutes,
 * and 30 wrong PINs across all devices locks staff sign-in for 15 minutes.
 */
export class PinLimiter {
  private perIp = new Map<string, { fails: number; until: number; first: number }>();
  private global = { fails: 0, first: 0 };
  constructor(
    private maxPerIp = 5,
    private maxGlobal = 30,
    private windowMs = 15 * 60 * 1000,
  ) {}

  /** Milliseconds until this address may try again (0 = allowed now). */
  blockedFor(ip: string, now = Date.now()): number {
    if (this.global.fails >= this.maxGlobal && now - this.global.first < this.windowMs) {
      return this.windowMs - (now - this.global.first);
    }
    const e = this.perIp.get(ip);
    return e && e.until > now ? e.until - now : 0;
  }

  fail(ip: string, now = Date.now()): void {
    if (now - this.global.first > this.windowMs) this.global = { fails: 0, first: now };
    this.global.fails++;
    let e = this.perIp.get(ip);
    if (!e || now - e.first > this.windowMs) e = { fails: 0, until: 0, first: now };
    e.fails++;
    if (e.fails >= this.maxPerIp) e.until = now + this.windowMs;
    this.perIp.set(ip, e);
  }

  succeed(ip: string): void {
    this.perIp.delete(ip);
  }
}
