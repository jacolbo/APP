import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

export async function jpeg(file: string, w = 64, h = 48, orientation?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let img = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 170, b: 120 } } }).jpeg();
  if (orientation) img = img.withMetadata({ orientation });
  await img.toFile(file);
}

/** Builds a fake NAS tree in a temp folder and returns its root. */
export async function makePhotoTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-photos-'));
  const client = path.join(root, '2026', 'Week 12 backup', 'Smith Family');
  await jpeg(path.join(client, 'JM_0010.jpg'));
  await jpeg(path.join(client, 'JM_0002.JPG'));
  await jpeg(path.join(client, 'JM_0001.jpeg'), 64, 48, 6);
  fs.writeFileSync(path.join(client, 'JM_0001.CR3'), 'raw');
  fs.writeFileSync(path.join(client, 'JM_0002.ARW'), 'raw');
  fs.writeFileSync(path.join(client, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(client, '._JM_0010.jpg'), 'mac junk');
  fs.writeFileSync(path.join(client, 'empty.jpg'), '');
  fs.mkdirSync(path.join(client, '@eaDir'));
  await jpeg(path.join(root, '2026', 'Week 12 backup', 'Other Client', 'X_1.jpg'));
  await jpeg(path.join(root, '2026', 'Week 12', 'Card A', 'first copy', 'C_1.jpg'));
  fs.mkdirSync(path.join(root, '2025', 'Week 50 backup'), { recursive: true });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-outside-'));
  await jpeg(path.join(outside, 'secret.jpg'));
  fs.symlinkSync(outside, path.join(root, '2026', 'Week 12 backup', 'Sneaky Link'));
  fs.symlinkSync(path.join(outside, 'secret.jpg'), path.join(client, 'linked.jpg'));
  return { root, client, outside };
}

export function tempDir(prefix = 'jm-data-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
