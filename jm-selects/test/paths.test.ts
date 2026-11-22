import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PathError, cleanFileName, cleanRelPath, resolveInside } from '../server/paths.js';
import { makePhotoTree } from './helpers.js';

let tree: Awaited<ReturnType<typeof makePhotoTree>>;
beforeAll(async () => {
  tree = await makePhotoTree();
});

describe('cleanRelPath', () => {
  it('normalises ordinary paths', () => {
    expect(cleanRelPath('2026/Week 12 backup/Smith Family')).toBe('2026/Week 12 backup/Smith Family');
    expect(cleanRelPath('/2026//Week 12 backup/./')).toBe('2026/Week 12 backup');
    expect(cleanRelPath('2026\\Week 12 backup')).toBe('2026/Week 12 backup');
    expect(cleanRelPath(undefined)).toBe('');
  });

  it.each(['..', '../etc', '2026/../../etc', 'a/../../b', '.ssh', '2026/@eaDir', 'C:/Windows', 'a\0b', '#recycle'])(
    'rejects %j',
    (p) => {
      expect(() => cleanRelPath(p)).toThrow(PathError);
    },
  );

  it('rejects non-strings', () => {
    expect(() => cleanRelPath(['2026'])).toThrow(PathError);
    expect(() => cleanRelPath({})).toThrow(PathError);
  });
});

describe('resolveInside', () => {
  it('resolves folders inside the root', () => {
    expect(resolveInside(tree.root, '2026/Week 12 backup/Smith Family')).toBe(fs.realpathSync(tree.client));
  });

  it('rejects escaping the root', () => {
    expect(() => resolveInside(tree.root, '../')).toThrow(PathError);
    expect(() => resolveInside(tree.root, '/etc/passwd')).toThrow(PathError); // treated as relative → not found
  });

  it('rejects symlinks that point outside the root', () => {
    expect(() => resolveInside(tree.root, '2026/Week 12 backup/Sneaky Link')).toThrow(PathError);
    expect(() => resolveInside(tree.root, '2026/Week 12 backup/Smith Family/linked.jpg')).toThrow(PathError);
  });

  it('reports missing paths as not found', () => {
    expect(() => resolveInside(tree.root, '2026/nope')).toThrow('Not found');
  });
});

describe('cleanFileName', () => {
  it('accepts plain names', () => {
    expect(cleanFileName('JM_0001.jpg')).toBe('JM_0001.jpg');
  });
  it.each(['', '..', 'a/b.jpg', 'a\\b.jpg', '.hidden.jpg', 'x\0.jpg', 'x'.repeat(300)])('rejects %j', (n) => {
    expect(() => cleanFileName(n)).toThrow(PathError);
  });
  it('rejects non-strings', () => {
    expect(() => cleanFileName(5)).toThrow(PathError);
  });
});

it('the fixture really has a file outside the root', () => {
  expect(fs.existsSync(path.join(tree.outside, 'secret.jpg'))).toBe(true);
});
