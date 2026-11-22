import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export type Variant = 'thumb' | 'preview';

const SIZES: Record<Variant, { px: number; quality: number }> = {
  thumb: { px: 480, quality: 72 },
  preview: { px: 2048, quality: 84 },
};

sharp.cache(false);
sharp.concurrency(1);

/**
 * Makes and caches resized copies in <dataDir>/cache. Originals are only ever read.
 * A small queue limits how many images are processed at once so the NAS stays responsive.
 */
export class ImageCache {
  private dir: string;
  private inflight = new Map<string, Promise<string>>();
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(dataDir: string, private maxParallel = 2) {
    this.dir = path.join(dataDir, 'cache');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private keyFor(absFile: string, size: number, mtimeMs: number, variant: Variant): string {
    return crypto.createHash('sha1').update(`${absFile}|${size}|${mtimeMs}|${variant}`).digest('hex');
  }

  private async slot<T>(fn: () => Promise<T>, urgent: boolean): Promise<T> {
    if (this.running >= this.maxParallel) {
      await new Promise<void>((resolve) => (urgent ? this.waiting.unshift(resolve) : this.waiting.push(resolve)));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** Returns the path of a cached JPEG for this variant, generating it if needed. */
  async get(absFile: string, variant: Variant, urgent = true): Promise<string> {
    const st = await fsp.stat(absFile);
    const key = this.keyFor(absFile, st.size, st.mtimeMs, variant);
    const out = path.join(this.dir, key.slice(0, 2), `${key}.jpg`);
    try {
      await fsp.access(out);
      return out;
    } catch {
      /* not cached yet */
    }
    const existing = this.inflight.get(out);
    if (existing) return existing;
    const job = this.slot(async () => {
      const { px, quality } = SIZES[variant];
      await fsp.mkdir(path.dirname(out), { recursive: true });
      const tmp = `${out}.${process.pid}.${Date.now()}.tmp`;
      await sharp(absFile, { failOn: 'none' })
        .rotate() // apply EXIF orientation
        .resize(px, px, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: variant === 'thumb' })
        .toFile(tmp);
      await fsp.rename(tmp, out);
      return out;
    }, urgent).finally(() => this.inflight.delete(out));
    this.inflight.set(out, job);
    return job;
  }

  private warmQueue: string[] = [];
  private warming = false;

  /**
   * Pre-generate thumbnails in the background, one at a time, so photos a client
   * is actually looking at are always processed first.
   */
  warm(absFiles: string[]): void {
    const queued = new Set(this.warmQueue);
    for (const f of absFiles) if (!queued.has(f)) this.warmQueue.push(f);
    if (this.warming) return;
    this.warming = true;
    void (async () => {
      while (this.warmQueue.length) {
        const f = this.warmQueue.shift()!;
        // Let client requests go first.
        while (this.running > 0 || this.waiting.length > 0) await new Promise((r) => setTimeout(r, 50));
        await this.get(f, 'thumb', false).catch(() => {});
      }
      this.warming = false;
    })();
  }
}
