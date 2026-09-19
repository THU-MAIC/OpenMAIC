/**
 * Inline media below this decoded-byte limit stays visible to the model. Small
 * icons are cheap and occasionally useful; larger payloads are opaque token
 * waste and are represented by a read-only placeholder instead.
 */
export const READ_SCENE_INLINE_MEDIA_BYTE_LIMIT = 2 * 1024;

export const PLACEHOLDER_PREFIX = '<';
export const PLACEHOLDER_MARKER = ' bytes omitted:';
export const PLACEHOLDER_SUFFIX =
  'read-only placeholder; to replace it, write a new media src/URL at this path>';

export interface OmittedMediaBytes {
  path: string;
  placeholder: string;
}

interface InlineMedia {
  mime: string;
  /** Decoded byte length, computed arithmetically — never a full decode. */
  byteLength: number;
  /**
   * Pixel dimensions read from a FIXED header prefix (PNG/GIF) when the
   * format and payload allow; null when unavailable (e.g. JPEG's variable
   * marker walk, or a non-image mime).
   */
  dimensions: [number, number] | null;
}

function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x46) || // A-F
    (code >= 0x61 && code <= 0x66) // a-f
  );
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return code - 0x61 + 10; // a-f
}

/**
 * Arithmetic decoded-byte length of a base64 payload, WITHOUT decoding it.
 * Valid base64 encodes 3 bytes per 4 chars; each trailing `=` pads 0 bytes,
 * so the length is `floor(chars * 3 / 4) - padding` — exactly what
 * `Buffer.from(payload, 'base64').byteLength` returns, minus the full-buffer
 * allocation (cr#7 R7-P2-3: the grep/read projection previously decoded every
 * inline media byte before its budget check even started).
 *
 * The regex validity scan is kept verbatim from the old decoder: it is a pure
 * string scan with no large allocation. Whitespace is stripped only when
 * actually present, so a whitespace-free megabyte payload stays zero-copy.
 */
function base64ByteLength(payload: string): number | null {
  const compact = /\s/.test(payload) ? payload.replace(/\s/g, '') : payload;
  if (compact.length === 0 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact)) return null;
  let padding = 0;
  for (let i = compact.length - 1; i >= 0 && compact.charCodeAt(i) === 0x3d; i--) padding += 1;
  return Math.floor((compact.length * 3) / 4) - padding;
}

/**
 * Arithmetic UTF-8 byte length of a percent-encoded (non-base64) data-URI
 * payload, WITHOUT materializing the decoded string: each `%XX` escape is one
 * byte, every other code point counts its UTF-8 length (surrogate pairs count
 * the 4 bytes they encode to).
 *
 * The `%XX` escapes must ALSO decode to valid UTF-8, exactly as
 * `decodeURIComponent` verifies them before the old decoder saw the string:
 * the old implementation fell back to the raw length when that call threw,
 * and counting `%FF`/truncated/overlong escapes as 1 byte each would
 * undercount by up to 3× and silently bypass the omission limit (cr#8 P2).
 * An allocation-free UTF-8 state machine therefore validates the decoded
 * percent byte stream — consecutive escapes form one run, a literal character
 * ends it — and ANY violation (orphan continuation byte, overlong encoding,
 * surrogate encoding, > U+10FFFF, or a sequence truncated at a literal or the
 * end of the payload) returns the raw UTF-8 length immediately: the exact
 * old catch-fallback, conservative because it can only overestimate.
 */
export function percentDecodedUtf8Length(payload: string): number {
  let length = 0;
  // In-flight multi-byte sequence state: continuation bytes still expected,
  // and the per-sequence bounds of its first continuation byte (stricter than
  // 0x80-0xbf for E0/F0 overlongs and ED/F4 surrogate/out-of-range guards).
  let need = 0;
  let secondMin = 0x80;
  let secondMax = 0xbf;

  function feedPercentByte(byte: number): boolean {
    if (need > 0) {
      // The per-sequence bounds apply ONLY to the first continuation byte;
      // reset them right after, so later continuations use the plain
      // 0x80-0xbf range.
      if ((byte & 0xc0) !== 0x80 || byte < secondMin || byte > secondMax) return false;
      need -= 1;
      secondMin = 0x80;
      secondMax = 0xbf;
      return true;
    }
    if (byte < 0x80) return true; // ASCII
    if (byte >= 0xc2 && byte <= 0xdf) {
      need = 1;
      return true;
    }
    if (byte >= 0xe0 && byte <= 0xef) {
      need = 2;
      if (byte === 0xe0)
        secondMin = 0xa0; // reject overlong U+0000..U+07FF
      else if (byte === 0xed) secondMax = 0x9f; // reject surrogates U+D800..U+DFFF
      return true;
    }
    if (byte >= 0xf0 && byte <= 0xf4) {
      need = 3;
      if (byte === 0xf0)
        secondMin = 0x90; // reject overlong U+0000..U+FFFF
      else if (byte === 0xf4) secondMax = 0x8f; // reject > U+10FFFF
      return true;
    }
    return false; // orphan continuation 0x80-0xbf, overlong 0xc0/0xc1, 0xf5+
  }

  for (let i = 0; i < payload.length; i++) {
    const code = payload.charCodeAt(i);
    if (code === 0x25) {
      if (
        i + 2 < payload.length &&
        isHexDigit(payload.charCodeAt(i + 1)) &&
        isHexDigit(payload.charCodeAt(i + 2))
      ) {
        const byte =
          (hexValue(payload.charCodeAt(i + 1)) << 4) | hexValue(payload.charCodeAt(i + 2));
        if (!feedPercentByte(byte)) {
          // decodeURIComponent would throw URIError: mirror the old
          // catch-fallback to the raw string. Buffer.byteLength allocates
          // nothing.
          return Buffer.byteLength(payload, 'utf8');
        }
        length += 1;
        i += 2;
        continue;
      }
      // Malformed escape: decodeURIComponent would throw; mirror the old
      // catch-fallback to the raw string. Buffer.byteLength allocates nothing.
      return Buffer.byteLength(payload, 'utf8');
    }
    // A literal character ends the percent byte run; an in-flight sequence at
    // that point is the truncated error decodeURIComponent raises for
    // e.g. '%E4%B8a'.
    if (need > 0) return Buffer.byteLength(payload, 'utf8');
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code < 0xd800 || code > 0xdfff) length += 3;
    else if (code < 0xdc00 && i + 1 < payload.length) {
      const next = payload.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        i += 1;
      } else {
        length += 3; // lone high surrogate
      }
    } else {
      length += 3; // lone low surrogate
    }
  }
  // Truncated multi-byte sequence at the end of the payload: '%E4%B8'.
  if (need > 0) return Buffer.byteLength(payload, 'utf8');
  return length;
}

/**
 * Decode only a FIXED header prefix of a base64 payload (≤ 32 chars → 24
 * bytes) — enough for the PNG/GIF dimension fields without materializing the
 * whole payload. The caller has already validated the payload; the prefix is
 * chunk-aligned (a multiple of 4 chars), so the slice is always well-formed.
 */
function decodeBase64Prefix(payload: string, byteCount: number): Uint8Array | null {
  const chars = Math.ceil(byteCount / 3) * 4;
  if (payload.length < chars) return null;
  return Buffer.from(payload.slice(0, chars), 'base64').subarray(0, byteCount);
}

function decodedDataUri(value: string): InlineMedia | null {
  const match = /^data:([^;,]+)?((?:;[^,]*)*),([\s\S]*)$/i.exec(value);
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const metadata = match[2] ?? '';
  const payload = match[3] ?? '';
  if (/;base64(?:;|$)/i.test(metadata)) {
    const byteLength = base64ByteLength(payload);
    return byteLength === null
      ? null
      : { mime, byteLength, dimensions: mediaDimensions(mime, payload) };
  }
  return { mime, byteLength: percentDecodedUtf8Length(payload), dimensions: null };
}

function pngDimensions(bytes: Uint8Array | null): [number, number] | null {
  if (
    !bytes ||
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

function gifDimensions(bytes: Uint8Array | null): [number, number] | null {
  if (!bytes || bytes.length < 10 || String.fromCharCode(...bytes.slice(0, 3)) !== 'GIF') {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint16(6, true), view.getUint16(8, true)];
}

/**
 * Pixel dimensions of an image payload, reading ONLY fixed-offset headers:
 * PNG (24-byte header, dimensions at 16–23) and GIF (10-byte header,
 * dimensions at 6–9). The JPEG marker walk needs a VARIABLE-length header
 * read, so JPEG dimensions are omitted — the placeholder carries mime and the
 * byte count either way (cr#7 R7-P2-3 ruling: read a fixed header, omit the
 * dimensions when they cannot be obtained from one).
 */
function mediaDimensions(mime: string, payload: string): [number, number] | null {
  if (!mime.toLowerCase().startsWith('image/')) return null;
  return (
    pngDimensions(decodeBase64Prefix(payload, 24)) ?? gifDimensions(decodeBase64Prefix(payload, 10))
  );
}

function mediaKind(mime: string): string {
  const kind = mime.split('/', 1)[0]?.toLowerCase();
  return kind === 'image' || kind === 'video' || kind === 'audio' ? kind : 'media';
}

function placeholderFor(media: InlineMedia): string {
  const parts = [media.mime];
  if (media.dimensions) parts.push(`${media.dimensions[0]}×${media.dimensions[1]}`);
  parts.push(`${media.byteLength} bytes`);
  return `${PLACEHOLDER_PREFIX}${mediaKind(media.mime)}${PLACEHOLDER_MARKER} ${parts.join(
    ', ',
  )}; ${PLACEHOLDER_SUFFIX}`;
}

function inferredMime(key: string | undefined, parentType: unknown, path: string): string {
  if (key === 'poster' || /\/background\/image\/src$/.test(path)) return 'image/unknown';
  if (parentType === 'image' || /image(?:Data|Bytes|Base64)/i.test(key ?? '')) {
    return 'image/unknown';
  }
  if (parentType === 'video' || key === 'mediaRef') return 'video/unknown';
  if (parentType === 'audio') return 'audio/unknown';
  return 'application/octet-stream';
}

function isMediaByteField(key: string | undefined, parentType: unknown, path: string): boolean {
  if (/\/background\/image\/src$/.test(path)) return true;
  if (['src', 'mediaRef', 'poster'].includes(key ?? '')) {
    return ['image', 'video', 'audio'].includes(String(parentType)) || key === 'poster';
  }
  return /(?:base64|b64|bytesBase64Encoded|imageData|imageBytes|videoData|audioData)/i.test(
    key ?? '',
  );
}

const EMBEDDED_BASE64_DATA_URI =
  /data:([a-z]+\/[a-z0-9.+-]+)((?:;[^,;\s"')}]*)*;base64),([A-Za-z0-9+/_=-]+)/gi;

function omitString(
  value: string,
  key: string | undefined,
  parentType: unknown,
  path: string,
  omitted: OmittedMediaBytes[],
): string {
  const exactDataUri = decodedDataUri(value);
  if (exactDataUri && exactDataUri.byteLength > READ_SCENE_INLINE_MEDIA_BYTE_LIMIT) {
    const placeholder = placeholderFor(exactDataUri);
    omitted.push({ path, placeholder });
    return placeholder;
  }

  if (isMediaByteField(key, parentType, path)) {
    const byteLength = base64ByteLength(value);
    if (byteLength !== null && byteLength > READ_SCENE_INLINE_MEDIA_BYTE_LIMIT) {
      const mime = inferredMime(key, parentType, path);
      const placeholder = placeholderFor({
        mime,
        byteLength,
        dimensions: mediaDimensions(mime, value),
      });
      omitted.push({ path, placeholder });
      return placeholder;
    }
  }

  return value.replace(
    EMBEDDED_BASE64_DATA_URI,
    (match, mime: string, _metadata: string, payload: string) => {
      const byteLength = base64ByteLength(payload);
      if (byteLength === null || byteLength <= READ_SCENE_INLINE_MEDIA_BYTE_LIMIT) return match;
      const placeholder = placeholderFor({
        mime,
        byteLength,
        dimensions: mediaDimensions(mime, payload),
      });
      omitted.push({ path, placeholder });
      return placeholder;
    },
  );
}

/**
 * Build a read-only JSON projection with large inline media bytes omitted.
 * The input is never mutated, so persisted scenes and their JSON Pointer
 * address space remain byte-for-byte unchanged.
 */
export function omitReadSceneMediaBytes<T>(input: T): {
  value: T;
  omitted: OmittedMediaBytes[];
} {
  const omitted: OmittedMediaBytes[] = [];

  function visit(value: unknown, path: string, key?: string, parentType?: unknown): unknown {
    if (typeof value === 'string') return omitString(value, key, parentType, path, omitted);
    if (Array.isArray(value)) {
      return value.map((item, index) => visit(item, `${path}/${index}`, String(index)));
    }
    if (value === null || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([childKey, childValue]) => [
        childKey,
        visit(
          childValue,
          `${path}/${escapePointerToken(childKey)}`,
          childKey,
          record.type ?? parentType,
        ),
      ]),
    );
  }

  return { value: visit(input, '') as T, omitted };
}

/** Reject copying any read-only omission placeholder into a persisted patch. */
export function containsReadSceneMediaPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') {
    return (
      value.includes(PLACEHOLDER_PREFIX) &&
      value.includes(PLACEHOLDER_MARKER) &&
      value.includes(PLACEHOLDER_SUFFIX)
    );
  }
  if (Array.isArray(value)) return value.some(containsReadSceneMediaPlaceholder);
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some(containsReadSceneMediaPlaceholder);
}

/**
 * Detect the `<… bytes omitted` signature of a read-side media omission
 * placeholder even when only a fragment of the placeholder text is present.
 * An anchor built from a placeholder fragment cannot exist in the stored
 * value; flag it before the generic occurrence check so the model gets the
 * actionable "choose an anchor outside omitted regions" error.
 */
export function containsReadScenePlaceholderFragment(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(PLACEHOLDER_PREFIX) && value.includes(PLACEHOLDER_MARKER);
  }
  if (Array.isArray(value)) return value.some(containsReadScenePlaceholderFragment);
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some(containsReadScenePlaceholderFragment);
}
