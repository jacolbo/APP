import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  photosRoot: string;
  dataDir: string;
  staffPin: string;
  packageSizes: number[];
  backupSuffix: string;
  webDir: string;
  /** Writable folder for RAW project copies (null = feature off). */
  projectsRoot: string | null;
  /** How the projects folder is shown to staff (the NAS path). */
  projectsLabel: string;
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

  return {
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
    webDir: path.resolve(env.WEB_DIR ?? path.join(import.meta.dirname, '..', 'web')),
  };
}
