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

/** The leading bytes of the raster formats an extracted image may come in. */
const IMAGE_SIGNATURES: ReadonlyArray<(bytes: Buffer) => boolean> = [
  (bytes) => bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), // PNG
  (bytes) => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), // JPEG
  (bytes) => bytes.subarray(0, 3).toString('latin1') === 'GIF',
  (bytes) =>
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP',
  (bytes) => bytes.subarray(0, 2).toString('latin1') === 'BM',
  (bytes) =>
    bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
    bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])), // TIFF
];

/**
 * Whether `payload` is base64 of an image (PNG, JPEG, GIF, WebP, BMP or TIFF),
 * judged by the leading bytes only: a path or a name made of base64
 * characters (`images/foo`) is base64 too, but not of an image.
 */
export function isBase64Image(payload: string): boolean {
  if (!isBase64Payload(payload)) return false;
  // 32 characters decode to 24 bytes: past every signature above.
  const head = Buffer.from(payload.replace(/\s/g, '').slice(0, 32), 'base64');
  return IMAGE_SIGNATURES.some((matches) => matches(head));
}
