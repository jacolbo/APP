import crypto from 'node:crypto';
import QRCode from 'qrcode';

/**
 * Normalise a person's name for comparison: ignore capitals, accents and extra spaces.
 * Hyphens, dots and commas count as spaces; apostrophes are dropped (O’Neil = ONeil).
 */
export function normalizeName(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // accents
    .toLowerCase()
    .replace(/['’‘`´]/g, '')
    .replace(/[\s\-‐‑–—_.,]+/g, ' ')
    .trim();
}

export function namesMatch(typed: unknown, sessionName: string): boolean {
  if (typeof typed !== 'string' || typed.length > 200) return false;
  const a = normalizeName(typed);
  const b = normalizeName(sessionName);
  if (!a || !b) return false;
  // Constant-time compare of fixed-length digests.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Escape a value for the Wi-Fi QR format (\ ; , : " are escaped with a backslash). */
export function escapeWifi(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1');
}

/**
 * Standard Wi-Fi join QR text, understood by iPhone and Android cameras:
 *   WIFI:T:WPA;S:<name>;P:<password>;;
 * With no password it is an open network: WIFI:T:nopass;S:<name>;;
 */
export function wifiQrText(ssid: string, password: string, security: 'WPA' | 'WEP' | 'nopass' = 'WPA'): string {
  if (!password || security === 'nopass') return `WIFI:T:nopass;S:${escapeWifi(ssid)};;`;
  return `WIFI:T:${security};S:${escapeWifi(ssid)};P:${escapeWifi(password)};;`;
}

/** QR code as an SVG, drawn in the Jepson Myles ink colour on a transparent background. */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
    color: { dark: '#171310', light: '#ffffff' },
  });
}

/** A friendly label for a device from its browser's user agent. */
export function deviceLabel(ua: string | undefined): string {
  const u = ua ?? '';
  if (/iPad/.test(u) || (/Macintosh/.test(u) && /Mobile/.test(u))) return 'iPad';
  if (/iPhone/.test(u)) return 'iPhone';
  if (/Android/.test(u)) return /Mobile/.test(u) ? 'Android phone' : 'Android tablet';
  if (/Windows/.test(u)) return 'Windows computer';
  if (/Macintosh/.test(u)) return 'Mac';
  return 'Device';
}

export const newDeviceKey = () => crypto.randomBytes(32).toString('base64url');
export const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');
