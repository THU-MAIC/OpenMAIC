/**
 * A minimal ZIP writer for the standalone export's media-folder variant:
 * every entry is stored (no compression) and the archive is returned as a
 * Blob built from the entries' own Blobs.
 *
 * Why not JSZip (used by the classroom `.maic.zip` export): JSZip reads every
 * input Blob into an ArrayBuffer when it is added and concatenates its output
 * into one ArrayBuffer before wrapping it in a Blob, so a large archive sits
 * in the tab's memory several times over. The media here is already
 * compressed (MP3, MP4, ...), so storing it loses nothing, and a stored entry
 * needs only its CRC-32: the bytes are read once, a slice at a time, to
 * compute it, and the archive Blob then references the original Blobs
 * instead of copying them.
 *
 * Plain ZIP (no ZIP64): every 16- and 32-bit field must hold its value below
 * the all-ones sentinel that announces a ZIP64 record (fewer than 65,535
 * entries, sizes and offsets below 0xFFFFFFFF), and the writer refuses
 * anything larger rather than emit an archive readers misinterpret.
 */

export interface StoredZipEntry {
  /** Relative path inside the archive, `/`-separated (e.g. `media/clip.mp4`). */
  path: string;
  data: Blob | string;
}

export interface StoredZipOptions {
  /** Modification time recorded for every entry; defaults to now. */
  date?: Date;
  /** Bytes read at a time while computing an entry's CRC-32 (default 8 MiB). */
  crcChunkBytes?: number;
}

/**
 * Largest archive the writer emits: every size and offset field, the end
 * record's included, then stays below the ZIP64 sentinel 0xFFFFFFFF.
 */
export const STORED_ZIP_MAX_BYTES = 0xfffffffe;

/** Most entries a plain ZIP holds: 0xFFFF in the end record means ZIP64. */
export const STORED_ZIP_MAX_ENTRIES = 0xfffe;

const DEFAULT_CRC_CHUNK_BYTES = 8 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Update a running CRC-32 (start with 0) with more bytes. */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let index = 0; index < bytes.length; index++) {
    c = CRC_TABLE[(c ^ bytes[index]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

async function blobCrc32(blob: Blob, chunkBytes: number): Promise<number> {
  let crc = 0;
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    const chunk = blob.slice(offset, offset + chunkBytes);
    crc = crc32(new Uint8Array(await chunk.arrayBuffer()), crc);
  }
  return crc;
}

/**
 * Whether `path` is a plain relative archive path: `/`-separated, no empty,
 * `.` or `..` segment, no backslash, drive letter or control character. An
 * entry that could land outside the extraction folder is refused.
 */
export function isSafeArchivePath(path: string): boolean {
  if (!path || /[\\:\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** General purpose flag bit 11: names are UTF-8. */
const FLAG_UTF8 = 0x0800;
/** Version 2.0: what a stored entry needs; "made by" Unix so permissions apply. */
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED;
/** Regular file, rw-r--r--. */
const UNIX_FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;

/**
 * Build a stored ZIP of `entries`, in order. The returned Blob references each
 * entry's Blob; nothing larger than one CRC chunk is copied.
 */
export async function buildStoredZip(
  entries: readonly StoredZipEntry[],
  options: StoredZipOptions = {},
): Promise<Blob> {
  if (entries.length > STORED_ZIP_MAX_ENTRIES) throw new Error('Stored ZIP: too many entries');
  const chunkBytes = options.crcChunkBytes ?? DEFAULT_CRC_CHUNK_BYTES;
  const encoder = new TextEncoder();
  const stamp = dosDateTime(options.date ?? new Date());
  const seen = new Set<string>();
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (!isSafeArchivePath(entry.path)) {
      throw new Error(`Stored ZIP: unsafe entry path ${JSON.stringify(entry.path)}`);
    }
    if (seen.has(entry.path)) throw new Error(`Stored ZIP: duplicate entry ${entry.path}`);
    seen.add(entry.path);
    const data = typeof entry.data === 'string' ? new Blob([entry.data]) : entry.data;
    const name = encoder.encode(entry.path);
    // The name length field holds UTF-8 bytes, not UTF-16 units.
    if (name.length > 0xffff) throw new Error('Stored ZIP: entry path too long');
    // Covers this entry's size and the next offset (the central directory's
    // included), all of which stay below the sentinel.
    if (offset + 30 + name.length + data.size > STORED_ZIP_MAX_BYTES) {
      throw new Error('Stored ZIP: archive exceeds 4 GiB');
    }
    const crc = await blobCrc32(data, chunkBytes);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, VERSION_NEEDED, true);
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.size, true);
    lv.setUint32(22, data.size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const header = new Uint8Array(46 + name.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, VERSION_MADE_BY, true);
    cv.setUint16(6, VERSION_NEEDED, true);
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.size, true);
    cv.setUint32(24, data.size, true);
    cv.setUint16(28, name.length, true);
    // Extra field, comment, disk number and internal attributes stay 0.
    cv.setUint32(38, UNIX_FILE_ATTRIBUTES, true);
    cv.setUint32(42, offset, true);
    header.set(name, 46);
    central.push(header);

    parts.push(local, data);
    offset += local.length + data.size;
  }

  const centralSize = central.reduce((sum, header) => sum + header.length, 0);
  if (offset + centralSize + 22 > STORED_ZIP_MAX_BYTES) {
    throw new Error('Stored ZIP: archive exceeds 4 GiB');
  }
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
