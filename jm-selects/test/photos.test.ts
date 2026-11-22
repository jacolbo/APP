import { beforeAll, describe, expect, it } from 'vitest';
import { browse, isJpeg, listJpegs } from '../server/photos.js';
import { makePhotoTree } from './helpers.js';

let tree: Awaited<ReturnType<typeof makePhotoTree>>;
beforeAll(async () => {
  tree = await makePhotoTree();
});

describe('isJpeg', () => {
  it.each(['a.jpg', 'a.JPG', 'a.jpeg', 'A.JPEG', 'a.JpG', 'my photo 1.jpg'])('accepts %s', (n) => expect(isJpeg(n)).toBe(true));
  it.each(['a.CR3', 'a.ARW', 'a.NEF', 'a.png', 'a.heic', 'a.jpg.xmp', 'a.tif', 'jpg', 'a.jpgx', '._a.jpg', '.a.jpg'])(
    'rejects %s',
    (n) => expect(isJpeg(n)).toBe(false),
  );
});

describe('listJpegs', () => {
  it('lists only JPEGs, skips RAW/other/hidden/empty, sorts naturally', async () => {
    const names = (await listJpegs(tree.client)).map((p) => p.name);
    // linked.jpg is a symlink (not a regular file entry) so it is skipped too.
    expect(names).toEqual(['JM_0001.jpeg', 'JM_0002.JPG', 'JM_0010.jpg']);
  });
});

describe('browse', () => {
  it('lists years newest first at the root', async () => {
    expect((await browse(tree.root, '', 'backup')).map((e) => e.name)).toEqual(['2026', '2025']);
  });
  it('shows only "backup" week folders inside a year', async () => {
    expect((await browse(tree.root, '2026', 'backup')).map((e) => e.name)).toEqual(['Week 12 backup']);
  });
  it('lists client folders with JPEG counts and hides unsafe links', async () => {
    const entries = await browse(tree.root, '2026/Week 12 backup', 'backup');
    expect(entries.map((e) => [e.name, e.jpegCount])).toEqual([
      ['Other Client', 1],
      ['Smith Family', 4], // quick count: includes the empty file, excludes the symlink
    ]);
  });
});
