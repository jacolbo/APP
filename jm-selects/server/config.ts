import fs from 'node:fs';
import path from 'node:path';
import { parsePrice } from '../shared/pricing.js';

export interface Config {
  port: number;
  photosRoot: string;
  dataDir: string;
  staffPin: string;
  packageSizes: number[];
  /** Default price per extra picture, whole rand. */
  extraImagePrice: number;
  backupSuffix: string;
  webDir: string;
  /** Writable folder for RAW project copies (null = feature off). */
  projectsRoot: string | null;
  /** How the projects folder is shown to staff (the NAS path). */
  projectsLabel: string;
  /** Studio Wi-Fi for the join QR code (empty = not set up). */
  wifiSsid: string;
  wifiPassword: string;
  /** Address put in session QR codes, e.g. http://192.168.101.153:8080 (empty = use the address staff opened). */
  publicUrl: string;
  /** Wrong-name attempts allowed per session link before it locks. */
  maxJoinAttempts: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const staffPin = (env.STAFF_PIN ?? '').trim();
  if (!/^\d{4,12}$/.test(staffPin)) {
    throw new Error('STAFF_PIN must be set to 4–12 digits (e.g. in .env).');
  }
  if (['0000', '1234', '1111', '123456'].includes(staffPin)) {
    throw new Error('STAFF_PIN is too easy to guess. Choose a different one.');
  }
  const packageSizes = (env.PACKAGE_SIZES ?? '10,20,30,50')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 10000);

  const extraImagePrice = parsePrice(env.EXTRA_IMAGE_PRICE ?? '250');
  if (extraImagePrice === null) {
    throw new Error('EXTRA_IMAGE_PRICE must be a whole rand amount, e.g. 250.');
  }

  return {
    extraImagePrice,
    port: Number.parseInt(env.PORT ?? '8080', 10),
    photosRoot: path.resolve(env.PHOTOS_ROOT ?? '/photos'),
    dataDir: path.resolve(env.DATA_DIR ?? '/data'),
    staffPin,
    packageSizes,
    backupSuffix: (env.BACKUP_SUFFIX ?? 'backup').toLowerCase(),
    projectsRoot: env.PROJECTS_ROOT
      ? path.resolve(env.PROJECTS_ROOT)
      : fs.existsSync('/projects')
        ? '/projects'
        : null,
    projectsLabel: (env.PROJECTS_LABEL ?? '').trim() || 'Projects',
    wifiSsid: (env.WIFI_SSID ?? '').trim(),
    wifiPassword: env.WIFI_PASSWORD ?? '',
    publicUrl: cleanPublicUrl(env.PUBLIC_URL),
    maxJoinAttempts: 5,
    webDir: path.resolve(env.WEB_DIR ?? path.join(import.meta.dirname, '..', 'web')),
  };
}

function cleanPublicUrl(v: string | undefined): string {
  const t = (v ?? '').trim().replace(/\/+$/, '');
  if (!t) return '';
  if (!/^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(t)) {
    throw new Error('PUBLIC_URL must look like http://192.168.101.153:8080');
  }
  return t;
}
