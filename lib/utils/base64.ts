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
