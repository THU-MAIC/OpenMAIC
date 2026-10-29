/** Base64 characters (standard or URL-safe alphabet), padding and whitespace. */
const BASE64_PAYLOAD = /^[A-Za-z0-9+/=_\-\s]*$/;

/**
 * Whether `payload` is base64. Node's decoder skips characters outside the
 * alphabet, so a value that is something else (a URL, a path) would decode to
 * garbage bytes instead of failing: check before decoding.
 */
export function isBase64Payload(payload: string): boolean {
  return BASE64_PAYLOAD.test(payload);
}

const startsWith = (bytes: Buffer, signature: readonly number[]) =>
  bytes.subarray(0, signature.length).equals(Buffer.from(signature));

/** The leading bytes of the raster formats an extracted image may come in, and their type. */
const IMAGE_SIGNATURES: ReadonlyArray<{ mimeType: string; matches: (bytes: Buffer) => boolean }> = [
  { mimeType: 'image/png', matches: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) },
  { mimeType: 'image/jpeg', matches: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  { mimeType: 'image/gif', matches: (bytes) => bytes.subarray(0, 3).toString('latin1') === 'GIF' },
  {
    mimeType: 'image/webp',
    matches: (bytes) =>
      bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
      bytes.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  { mimeType: 'image/bmp', matches: (bytes) => bytes.subarray(0, 2).toString('latin1') === 'BM' },
  {
    mimeType: 'image/tiff',
    matches: (bytes) =>
      startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]),
  },
  {
    // A boxed JP2 file opens with its signature box (`jP  `); a raw codestream
    // (`.j2k`) with its SOC and SIZ markers. Both are JPEG 2000, `image/jp2`.
    mimeType: 'image/jp2',
    matches: (bytes) =>
      startsWith(bytes, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]) ||
      startsWith(bytes, [0xff, 0x4f, 0xff, 0x51]),
  },
];

/**
 * The image type of `payload` when it is base64 of an image (PNG, JPEG, GIF,
 * WebP, BMP, TIFF or JPEG 2000), else `null`, judged by the leading bytes
 * only: a path or a name made of base64 characters (`images/foo`) is base64
 * too, but not of an image.
 */
export function base64ImageMimeType(payload: string): string | null {
  if (!isBase64Payload(payload)) return null;
  // 32 characters decode to 24 bytes: past every signature above.
  const head = Buffer.from(payload.replace(/\s/g, '').slice(0, 32), 'base64');
  return IMAGE_SIGNATURES.find((signature) => signature.matches(head))?.mimeType ?? null;
}

/** Whether `payload` is base64 of an image (see {@link base64ImageMimeType}). */
export function isBase64Image(payload: string): boolean {
  return base64ImageMimeType(payload) !== null;
}
