import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  UnsafeDestination,
  copyOne,
  ensureProjectDir,
  indexRaws,
  matchKey,
  matchRaws,
  projectSegments,
  rawExtension,
  safeSegment,
} from '../server/raws.js';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (f: string, body: string | Buffer = 'raw-bytes') => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
};

/** Every file/folder under dir with size + mtime, to prove nothing changed. */
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      out.push(`${path.relative(dir, p)}|${st.size}|${st.mtimeMs}|${st.mode}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

describe('RAW extensions', () => {
  it.each(['a.CR3', 'a.cr2', 'a.NEF', 'a.arw', 'a.RAF', 'a.dng', 'a.Orf', 'a.RW2', 'a.iiq'])('%s is RAW', (n) =>
    expect(rawExtension(n)).not.toBeNull(),
  );
  it.each(['a.jpg', 'a.JPEG', 'a.xmp', 'a.cr3.xmp', 'a.tif', 'cr3', 'a.cos'])('%s is not RAW', (n) =>
    expect(rawExtension(n)).toBeNull(),
  );
  it('matches base names case-insensitively', () => {
    expect(matchKey('JM_0001.jpg')).toBe(matchKey('jm_0001.CR3'));
    expect(matchKey('a.b.jpg')).toBe('a.b');
  });
});

describe('indexRaws + matchRaws', () => {
  let client: string;
  beforeEach(() => {
    client = tmp('jm-client-');
    write(path.join(client, 'JM_0001.CR3'));
    write(path.join(client, 'jm_0002.cr3'));
    write(path.join(client, 'RAW', 'JM_0003.NEF'));
    write(path.join(client, 'RAW', 'deeper', 'JM_0004.ARW'));
    write(path.join(client, 'RAW', 'JM_0001.CR3')); // duplicate name in a subfolder
    write(path.join(client, 'JM_0005.cr3.xmp')); // sidecar, not RAW
    write(path.join(client, '@eaDir', 'JM_0006.CR3')); // NAS system folder: ignored
    write(path.join(client, '.hidden', 'JM_0007.CR3'));
    write(path.join(client, 'JM_0008.DNG'), ''); // empty file: ignored
  });

  it('finds RAWs in the folder and subfolders, any case, any RAW extension', async () => {
    const idx = await indexRaws(client);
    const r = matchRaws(['JM_0001.jpg', 'JM_0002.JPG', 'JM_0003.jpeg', 'JM_0004.jpg', 'JM_0005.jpg', 'JM_0006.jpg', 'JM_0007.jpg', 'JM_0008.jpg'], idx);
    expect(r.matched.map((m) => [m.jpeg, m.raw.rel])).toEqual([
      ['JM_0001.jpg', 'JM_0001.CR3'], // the one next to the JPEG wins over RAW/JM_0001.CR3
      ['JM_0002.JPG', 'jm_0002.cr3'],
      ['JM_0003.jpeg', 'RAW/JM_0003.NEF'],
      ['JM_0004.jpg', 'RAW/deeper/JM_0004.ARW'],
    ]);
    expect(r.matched[0].alternatives).toBe(1);
    expect(r.missing).toEqual(['JM_0005.jpg', 'JM_0006.jpg', 'JM_0007.jpg', 'JM_0008.jpg']);
  });

  it('does not follow symlinks out of the client folder', async () => {
    const outside = tmp('jm-out-');
    write(path.join(outside, 'JM_0009.CR3'));
    fs.symlinkSync(outside, path.join(client, 'link'));
    const r = matchRaws(['JM_0009.jpg'], await indexRaws(client));
    expect(r.missing).toEqual(['JM_0009.jpg']);
  });
});

describe('project folder names', () => {
  it('uses <year>/<week without "backup">/<client>', () => {
    expect(projectSegments('2026/Week 47 backup/Naidoo Family', 'Naidoo Family')).toEqual(['2026', 'Week 47', 'Naidoo Family']);
    expect(projectSegments('2026/W12_Backup/x', 'Smith')).toEqual(['2026', 'W12', 'Smith']);
  });
  it.each([
    ['../../etc', 'etc'],
    ['..', '_unnamed'],
    ['.', '_unnamed'],
    ['a/b\\c', 'a b c'],
    ['C:', 'C'],
    ['  Mr. & Mrs. Dlamini.  ', 'Mr. & Mrs. Dlamini'],
    ['CON', '_CON'],
    ['@eaDir', '_eaDir'],
    ['Zoë <3', 'Zoë 3'],
  ])('safeSegment(%j) = %j', (input, out) => {
    expect(safeSegment(input)).toBe(out);
  });
});

describe('writing only inside the projects folder', () => {
  let projects: string;
  let photos: string;
  let sibling: string;
  beforeEach(() => {
    const base = tmp('jm-nas-');
    projects = path.join(base, 'Projects');
    photos = path.join(base, 'Photos');
    sibling = path.join(base, 'Other');
    fs.mkdirSync(projects);
    fs.mkdirSync(sibling);
    write(path.join(photos, '2026', 'Week 1 backup', 'A', 'X_1.CR3'), Buffer.alloc(5000, 7));
  });

  it('creates the folder chain inside the projects folder', async () => {
    const dest = await ensureProjectDir(projects, ['2026', 'Week 1', 'A']);
    expect(dest).toBe(path.join(fs.realpathSync(projects), '2026', 'Week 1', 'A'));
  });

  it('rejects hostile names before touching the disk', async () => {
    const outsideProjects = () =>
      snapshot(path.dirname(projects))
        .split('\n')
        .filter((l) => !l.startsWith('Projects'))
        .join('\n');
    const before = outsideProjects();
    for (const seg of ['..', '../Other', 'a/b', '.', '']) {
      await expect(ensureProjectDir(projects, ['2026', seg])).rejects.toBeInstanceOf(UnsafeDestination);
    }
    expect(outsideProjects()).toBe(before);
    // Only the harmless "2026" folder was created, inside Projects.
    expect(fs.readdirSync(projects)).toEqual(['2026']);
    expect(fs.readdirSync(path.join(projects, '2026'))).toEqual([]);
  });

  it('refuses a symlink inside projects that points elsewhere', async () => {
    fs.symlinkSync(sibling, path.join(projects, '2026'));
    await expect(ensureProjectDir(projects, ['2026', 'Week 1', 'A'])).rejects.toBeInstanceOf(UnsafeDestination);
    expect(fs.readdirSync(sibling)).toEqual([]);
  });

  it('copies with a size check, never overwrites, never changes the original', async () => {
    const src = path.join(photos, '2026', 'Week 1 backup', 'A', 'X_1.CR3');
    const photosBefore = snapshot(photos);
    const siblingBefore = snapshot(sibling);
    const dest = await ensureProjectDir(projects, ['2026', 'Week 1', 'A']);

    expect(await copyOne(src, dest, 'X_1.CR3', 5000)).toEqual({ status: 'copied', bytes: 5000 });
    expect(fs.readFileSync(path.join(dest, 'X_1.CR3'))).toEqual(fs.readFileSync(src));
    expect(await copyOne(src, dest, 'X_1.CR3', 5000)).toEqual({ status: 'exists' });

    // A different file with the same name is left exactly as it is.
    write(path.join(dest, 'Y.CR3'), 'staff edit');
    const r = await copyOne(src, dest, 'Y.CR3', 5000);
    expect(r.status).toBe('conflict');
    expect(fs.readFileSync(path.join(dest, 'Y.CR3'), 'utf8')).toBe('staff edit');

    // Hostile file names are refused.
    for (const bad of ['../X.CR3', '..', 'a/b.CR3', 'a\\b.CR3']) {
      expect((await copyOne(src, dest, bad, 5000)).status).toBe('failed');
    }

    // No temp files left behind, originals and other folders untouched.
    expect(fs.readdirSync(dest).sort()).toEqual(['X_1.CR3', 'Y.CR3']);
    expect(snapshot(photos)).toBe(photosBefore);
    expect(snapshot(sibling)).toBe(siblingBefore);
  });

  it('reports a size mismatch instead of publishing a bad copy', async () => {
    const src = path.join(photos, '2026', 'Week 1 backup', 'A', 'X_1.CR3');
    const dest = await ensureProjectDir(projects, ['x']);
    const r = await copyOne(src, dest, 'X_1.CR3', 4999); // pretend the original was a different size
    expect(r.status).toBe('failed');
    expect(fs.readdirSync(dest)).toEqual([]);
  });
});
