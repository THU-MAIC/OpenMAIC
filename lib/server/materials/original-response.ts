/**
 * The headers an owner material's original is served with, for the library
 * page's "open the original" (RFC #1716 §7).
 *
 * A type is served inline only when the asset pool would serve it inline
 * (`DEFAULT_RENDERABLE_TYPES`: images, audio, video); everything else -- PDF,
 * HTML, SVG and Office files included -- is labelled
 * `application/octet-stream` and downloaded, as the pool's own byte responses
 * are. The response is private to the requesting owner and never sniffed.
 */
import { extname } from 'node:path';

import { DEFAULT_RENDERABLE_TYPES } from '@openmaic/storage';

const INLINE_TYPES = new Set(DEFAULT_RENDERABLE_TYPES.map((type) => type.toLowerCase()));

/**
 * Whether an original of this type is served inline (opened in the tab)
 * rather than downloaded. The one decision behind both the response's
 * disposition and the library view's `opensInline`, so the page's
 * "Open" / "Download original" says what the response does.
 */
export function opensInline(mime: string | null | undefined): boolean {
  return INLINE_TYPES.has((mime ?? '').toLowerCase());
}

/** The name without control characters (CR/LF included) or path separators. */
function safeFileName(name: string | null, fallback: string): string {
  const cleaned = Array.from(name ?? '')
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .replace(/[\\/]/g, '_')
    .trim();
  return cleaned || fallback;
}

/** RFC 6266 disposition: an ASCII `filename` fallback and the UTF-8 `filename*`. */
export function contentDisposition(
  disposition: 'inline' | 'attachment',
  name: string | null,
  fallback: string,
): string {
  const fileName = safeFileName(name, fallback);
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * The name an original is served as: what the teacher calls it now, with
 * the uploaded file's extension added when that name dropped it, so the
 * file still opens as its type. Never renamed, it is the uploaded name.
 */
export function originalDownloadName(
  displayName: string | null,
  originalName: string | null,
): string | null {
  const name = displayName ?? originalName;
  if (!name) return name;
  const extension = extname(originalName ?? '');
  return extension && !name.toLowerCase().endsWith(extension.toLowerCase())
    ? `${name}${extension}`
    : name;
}

export function originalResponseHeaders(input: {
  materialId: string;
  mime: string | null;
  originalName: string | null;
  byteLength: number;
}): Headers {
  const mime = (input.mime ?? '').toLowerCase();
  const inline = opensInline(mime);
  return new Headers({
    'Content-Type': inline ? mime : 'application/octet-stream',
    'Content-Length': String(input.byteLength),
    'Content-Disposition': contentDisposition(
      inline ? 'inline' : 'attachment',
      input.originalName,
      input.materialId,
    ),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
}
