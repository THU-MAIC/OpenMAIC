/**
 * Content-Security-Policy for untrusted, caller-supplied HTML.
 *
 * Both render paths load HTML that was authored outside this service: the
 * interactive HTML in `POST /preview`, and the whole uploaded project in
 * `POST /render`. Each document gets the policy as its first `<meta>` so the
 * parser processes it before any authored markup can run, and a later
 * attacker-supplied `<meta>` cannot loosen it because browsers intersect every
 * policy on a document.
 */

/** Attribute that identifies a policy `<meta>` written by this module. */
export const UNTRUSTED_HTML_CSP_MARKER = 'data-openmaic-untrusted-csp';

/**
 * Policy equivalent to the app packager's interactive-scene policy
 * (`lib/video-export-app/prepare-interactive-html.ts`). Kept byte-for-byte
 * identical so a packaged scene previews under the same rules it is exported
 * with; `test/untrusted-html-csp.test.ts` asserts the equivalence.
 */
export const UNTRUSTED_HTML_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data:",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "worker-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * Policy for a whole uploaded render project. It starts from
 * {@link UNTRUSTED_HTML_CSP} and adds only what a packager-produced export
 * loaded from the producer's loopback file server needs:
 *
 *  - `'self'` on the asset directives, because the export references
 *    project-relative assets (`assets/**`) and the vendored GSAP over
 *    `http://localhost:<producerPort>`; the exact port is random per render.
 *  - `frame-src 'self'`, because every interactive scene is a same-origin
 *    `<iframe src="assets/interactive-*.html">`. `connect-src` stays `'none'`,
 *    so framing another loopback port (for example the render-service API) is
 *    still blocked.
 *  - `form-action 'none'`, because form submission does not fall back to
 *    `default-src` and would otherwise be an unbounded egress channel.
 *
 * `script-src` keeps the packager's `'unsafe-inline'`/`'unsafe-eval'`/`data:`/
 * `blob:`; a scene's own injected policy still tightens a framed scene through
 * intersection.
 */
export const UNTRUSTED_RENDER_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob: 'self'",
  "style-src 'unsafe-inline' data: 'self'",
  "img-src data: blob: 'self'",
  "font-src data: 'self'",
  "media-src data: blob: 'self'",
  "worker-src 'none'",
  "connect-src 'none'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/**
 * The HTML standard's ASCII whitespace only. JavaScript's `\s` also matches
 * NBSP, U+3000, U+2028/9 and U+FEFF, none of which the HTML parser accepts
 * before a doctype; using `\s` here would let the `<meta>` land after a
 * doctype the parser no longer treats as leading, so the page would enter
 * quirks mode and the meta would be parsed into `<body>` where Chromium
 * ignores it.
 */
const LEADING_DOCTYPE = /^[\t\n\f\r ]*<!doctype\b[^>]*>/i;

/** UTF-8 encoding of a single U+FEFF. */
const UTF8_BOM_BYTES = [0xef, 0xbb, 0xbf];
const ASCII_WHITESPACE_BYTES = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DOCTYPE_PREFIX = '<!doctype';

/** The exact `<meta>` tag the injector writes for `policy`. */
export function untrustedCspMetaTag(policy: string = UNTRUSTED_HTML_CSP): string {
  const content = policy.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  return `<meta ${UNTRUSTED_HTML_CSP_MARKER} http-equiv="Content-Security-Policy" content="${content}">`;
}

interface InsertionPoint {
  /** Offset of the first byte after any leading U+FEFF sequences. */
  readonly start: number;
  /** Offset the `<meta>` bytes are inserted at (after a leading doctype). */
  readonly offset: number;
}

function isAsciiWordByte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x5f // _
  );
}

function matchesAsciiDoctypePrefix(bytes: Uint8Array, index: number): boolean {
  if (index + DOCTYPE_PREFIX.length > bytes.length) return false;
  for (let position = 0; position < DOCTYPE_PREFIX.length; position += 1) {
    let byte = bytes[index + position]!;
    if (byte >= 0x41 && byte <= 0x5a) byte += 0x20; // ASCII lowercase
    if (byte !== DOCTYPE_PREFIX.charCodeAt(position)) return false;
  }
  const boundary = bytes[index + DOCTYPE_PREFIX.length];
  return boundary === undefined || !isAsciiWordByte(boundary);
}

/**
 * Locate where the policy `<meta>` must go without decoding the document.
 * Leading U+FEFF sequences are stripped; only HTML ASCII whitespace and a
 * following doctype may move the insertion point past `start`.
 */
function findInsertionPoint(bytes: Uint8Array): InsertionPoint {
  let start = 0;
  while (
    start + UTF8_BOM_BYTES.length <= bytes.length &&
    UTF8_BOM_BYTES.every((byte, index) => bytes[start + index] === byte)
  ) {
    start += UTF8_BOM_BYTES.length;
  }

  let index = start;
  while (index < bytes.length && ASCII_WHITESPACE_BYTES.has(bytes[index]!)) index += 1;

  if (matchesAsciiDoctypePrefix(bytes, index)) {
    let end = index;
    while (end < bytes.length && bytes[end] !== 0x3e) end += 1; // '>'
    if (end < bytes.length) return { start, offset: end + 1 };
  }
  return { start, offset: start };
}

function startsWithBytes(bytes: Uint8Array, offset: number, prefix: Uint8Array): boolean {
  if (offset + prefix.length > bytes.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[offset + index] !== prefix[index]) return false;
  }
  return true;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((length, part) => length + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Byte-image counterpart of {@link injectUntrustedHtmlCsp}. Placement is
 * computed on bytes and only the ASCII `<meta>` bytes are inserted, so a
 * non-UTF-8 document is never decoded and re-encoded (which would corrupt it).
 */
export function injectUntrustedHtmlCspBytes(
  bytes: Uint8Array,
  policy: string = UNTRUSTED_HTML_CSP,
): Uint8Array {
  const meta = new TextEncoder().encode(untrustedCspMetaTag(policy));
  const { start, offset } = findInsertionPoint(bytes);
  if (startsWithBytes(bytes, offset, meta)) {
    return start > 0 ? bytes.subarray(start) : bytes;
  }
  return concatBytes(bytes.subarray(start, offset), meta, bytes.subarray(offset));
}

/**
 * Insert the policy `<meta>` before any authored content the HTML parser can
 * act on: immediately after a leading doctype (so the document keeps its
 * parsing mode), otherwise at the start of the document. Every leading U+FEFF
 * is removed first, because a BOM before the `<meta>` becomes a text token and
 * pushes the meta out of `<head>`. Re-injecting the same policy is a no-op, so
 * the transform is idempotent.
 */
export function injectUntrustedHtmlCsp(html: string, policy: string = UNTRUSTED_HTML_CSP): string {
  const body = html.replace(/^\uFEFF+/, '');
  const meta = untrustedCspMetaTag(policy);
  const doctype = LEADING_DOCTYPE.exec(body);
  const offset = doctype ? doctype[0].length : 0;
  if (body.startsWith(meta, offset)) return body;
  return `${body.slice(0, offset)}${meta}${body.slice(offset)}`;
}
