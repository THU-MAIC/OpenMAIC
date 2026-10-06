/**
 * QR code → PNG data URL for the PPTX export.
 *
 * The QR matrix comes from `uqr` (dependency-free, MIT), loaded on demand so it
 * stays out of the main bundle. The PNG is written by hand: a 1-bit grayscale
 * image with stored (uncompressed) deflate blocks. That avoids a canvas, works
 * the same in the browser and in Node tests, and stays small (~20 KB) because
 * each pixel is a single bit. SVG is not an option: pptxgenjs needs a canvas
 * to make the PNG fallback PowerPoint requires for SVG images.
 */

/** Modules of white margin around the code, as the QR spec requires. */
export const QR_QUIET_ZONE = 4;
/** Pixels per module. Large enough that viewers never need to upscale. */
const QR_PIXELS_PER_MODULE = 8;

/** QR modules (true = dark), including the quiet zone. */
export async function qrMatrix(text: string): Promise<boolean[][]> {
  const { encode } = await import('uqr');
  return encode(text, { ecc: 'M', border: QR_QUIET_ZONE }).data;
}

/** PNG data URL of a dark-on-white QR code for `text`. */
export async function qrPngDataUrl(text: string): Promise<string> {
  const png = encodeMonochromePng(await qrMatrix(text), QR_PIXELS_PER_MODULE);
  let binary = '';
  for (let i = 0; i < png.length; i += 0x8000) {
    binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

// ── Minimal PNG writer ──

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib stream made of stored (uncompressed) deflate blocks. */
function zlibStored(data: Uint8Array): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(data.length / 0xffff));
  const out = new Uint8Array(2 + data.length + blockCount * 5 + 4);
  const view = new DataView(out.buffer);
  out[0] = 0x78;
  out[1] = 0x01;
  let pos = 2;
  for (let block = 0; block < blockCount; block++) {
    const start = block * 0xffff;
    const len = Math.min(0xffff, data.length - start);
    out[pos++] = block === blockCount - 1 ? 1 : 0;
    view.setUint16(pos, len, true);
    view.setUint16(pos + 2, ~len & 0xffff, true);
    pos += 4;
    out.set(data.subarray(start, start + len), pos);
    pos += len;
  }
  view.setUint32(pos, adler32(data));
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode a module matrix (true = black) as a 1-bit grayscale PNG. */
export function encodeMonochromePng(modules: boolean[][], scale: number): Uint8Array {
  const size = modules.length * scale;
  const rowBytes = Math.ceil(size / 8);
  const raw = new Uint8Array((rowBytes + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = modules[Math.floor(y / scale)];
    const offset = y * (rowBytes + 1); // first byte: filter type 0 (none)
    for (let x = 0; x < size; x++) {
      // Grayscale 1-bit: 1 is white, so set the bit for light modules.
      if (!row[Math.floor(x / scale)]) raw[offset + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, size);
  hv.setUint32(4, size);
  header[8] = 1; // bit depth
  header[9] = 0; // color type: grayscale

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    png.set(p, pos);
    pos += p.length;
  }
  return png;
}
