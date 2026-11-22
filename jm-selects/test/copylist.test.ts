import { describe, expect, it } from 'vitest';
import { buildCopyList, buildCsv, stripExtension } from '../server/copylist.js';

const picks = [
  { file_name: 'JM_0010.jpg', selected: 1, stars: 5 },
  { file_name: 'JM_0002.JPG', selected: 1, stars: 2 },
  { file_name: 'JM_0003.jpg', selected: 0, stars: 4 },
  { file_name: 'JM_0001.jpeg', selected: 0, stars: 0 },
  { file_name: 'Old_0001.jpg', selected: 1, stars: 5 },
];
const existing = new Set(['JM_0010.jpg', 'JM_0002.JPG', 'JM_0003.jpg', 'JM_0001.jpeg']);

describe('buildCopyList', () => {
  it('hearted, no extension, comma-separated, natural order', () => {
    expect(buildCopyList(picks, { filter: 'hearted', includeExtension: false }, existing)).toBe('JM_0002,JM_0010');
  });
  it('hearted with extension keeps original case', () => {
    expect(buildCopyList(picks, { filter: 'hearted', includeExtension: true }, existing)).toBe('JM_0002.JPG,JM_0010.jpg');
  });
  it('minimum star rating', () => {
    expect(buildCopyList(picks, { filter: 'stars', minStars: 4, includeExtension: false }, existing)).toBe('JM_0003,JM_0010');
    expect(buildCopyList(picks, { filter: 'stars', minStars: 1, includeExtension: false }, existing)).toBe(
      'JM_0002,JM_0003,JM_0010',
    );
  });
  it('optional comma + space separator', () => {
    expect(buildCopyList(picks, { filter: 'hearted', includeExtension: false, separator: ', ' }, existing)).toBe(
      'JM_0002, JM_0010',
    );
  });
  it('drops files no longer in the folder', () => {
    expect(buildCopyList(picks, { filter: 'hearted', includeExtension: false })).toContain('Old_0001');
    expect(buildCopyList(picks, { filter: 'hearted', includeExtension: false }, existing)).not.toContain('Old_0001');
  });
  it('de-duplicates names that collide without extension', () => {
    const dup = [
      { file_name: 'A.jpg', selected: 1, stars: 0 },
      { file_name: 'A.JPEG', selected: 1, stars: 0 },
    ];
    expect(buildCopyList(dup, { filter: 'hearted', includeExtension: false })).toBe('A');
    expect(buildCopyList(dup, { filter: 'hearted', includeExtension: true })).toBe('A.JPEG,A.jpg');
  });
  it('empty when nothing matches', () => {
    expect(buildCopyList([], { filter: 'hearted', includeExtension: false })).toBe('');
  });
});

describe('stripExtension', () => {
  it('removes only the last extension', () => {
    expect(stripExtension('a.b.jpg')).toBe('a.b');
    expect(stripExtension('noext')).toBe('noext');
  });
});

describe('buildCsv', () => {
  it('lists every photo with selected and stars, and neutralises formulas', () => {
    const csv = buildCsv(['JM_0002.JPG', 'JM_0010.jpg', '=cmd.jpg'], picks);
    expect(csv.split('\r\n')).toEqual([
      '"File name","Selected","Stars"',
      `"'=cmd.jpg","no","0"`,
      '"JM_0002.JPG","yes","2"',
      '"JM_0010.jpg","yes","5"',
      '',
    ]);
  });
});
