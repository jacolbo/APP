import fs from 'node:fs';
import fsp from 'node:fs/promises';

/**
 * A minimal ZIP writer, because "one click downloads all my picks" should not
 * cost the project its only real property — that it has no dependencies.
 *
 * Entries are STOREd, not deflated. These are JPEGs and PNGs: already
 * compressed, so deflate would spend CPU to save a percent or two, and STORE
 * lets us write a correct local header up front instead of falling back to
 * data descriptors.
 *
 * Scope, stated so nobody is surprised later: no ZIP64. That caps an archive
 * at 65,535 entries and 4 GB, per entry and in total. A client gallery
 * selection is tens of files; `limits` below refuses anything near the edge
 * rather than writing a subtly corrupt archive.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

export const ZIP_MAX_ENTRIES = 2000;
export const ZIP_MAX_TOTAL_BYTES = 3.5 * 1024 * 1024 * 1024; // safely under the 4 GB ceiling

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/**
 * MS-DOS date/time, which is what the format stores. Two-second resolution and
 * no timezone — that is the format, not a shortcut.
 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Keeps names portable, and keeps a crafted filename from escaping the archive. */
export function safeEntryName(name, fallback) {
  const cleaned = String(name || '')
    .replace(/[\\/]+/g, '_')
    .replace(/[^\w.\- ()]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/** Appends " (2)", " (3)" … so two IMG_0041.jpg from different folders both survive. */
export function uniqueName(name, taken) {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  const last = `${stem} (${Date.now()})${ext}`;
  taken.add(last);
  return last;
}

/**
 * Streams a ZIP to `out` (an http.ServerResponse or any writable).
 *
 * Each file is read whole before being written, so peak memory is one image,
 * not the archive. Nothing is buffered across entries.
 */
export class ZipWriter {
  constructor(out) {
    this.out = out;
    this.entries = [];
    this.offset = 0;
    this.bytesWritten = 0;
  }

  #write(buf) {
    this.offset += buf.length;
    this.bytesWritten += buf.length;
    // Respect backpressure: a slow client must not make us buffer a gallery.
    if (!this.out.write(buf)) {
      return new Promise((resolve) => this.out.once('drain', resolve));
    }
    return null;
  }

  async add(filePath, entryName, modifiedAt = new Date()) {
    if (this.entries.length >= ZIP_MAX_ENTRIES) {
      throw Object.assign(new Error('Too many files for one archive'), { status: 413 });
    }
    const body = await fsp.readFile(filePath);
    if (this.bytesWritten + body.length > ZIP_MAX_TOTAL_BYTES) {
      throw Object.assign(new Error('That selection is too large to zip'), { status: 413 });
    }

    const name = Buffer.from(entryName, 'utf8');
    const crc = crc32(body);
    const { time, date } = dosDateTime(modifiedAt);
    const localOffset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER, 0);
    header.writeUInt16LE(20, 4);          // version needed
    header.writeUInt16LE(0x0800, 6);      // UTF-8 filename flag
    header.writeUInt16LE(0, 8);           // method 0 = stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);          // no extra field

    await this.#write(Buffer.concat([header, name]));
    await this.#write(body);

    this.entries.push({ name, crc, size: body.length, time, date, localOffset });
  }

  /** Central directory + end record. Nothing may be added afterwards. */
  async finish() {
    const centralStart = this.offset;

    for (const entry of this.entries) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(CENTRAL_HEADER, 0);
      record.writeUInt16LE(20, 4);        // version made by
      record.writeUInt16LE(20, 6);        // version needed
      record.writeUInt16LE(0x0800, 8);    // UTF-8 filename flag
      record.writeUInt16LE(0, 10);        // stored
      record.writeUInt16LE(entry.time, 12);
      record.writeUInt16LE(entry.date, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.size, 20);
      record.writeUInt32LE(entry.size, 24);
      record.writeUInt16LE(entry.name.length, 28);
      record.writeUInt16LE(0, 30);        // extra
      record.writeUInt16LE(0, 32);        // comment
      record.writeUInt16LE(0, 34);        // disk number
      record.writeUInt16LE(0, 36);        // internal attrs
      record.writeUInt32LE(0, 38);        // external attrs
      record.writeUInt32LE(entry.localOffset, 42);
      await this.#write(Buffer.concat([record, entry.name]));
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL, 0);
    end.writeUInt16LE(0, 4);              // this disk
    end.writeUInt16LE(0, 6);              // disk with central directory
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - centralStart, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);             // no archive comment
    await this.#write(end);

    this.out.end();
  }
}

/** Exported for the tests; the archive itself uses it internally. */
export const _crc32 = crc32;

export function fileExists(filePath) {
  return fs.promises.access(filePath).then(() => true, () => false);
}
