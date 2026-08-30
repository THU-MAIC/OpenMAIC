/**
 * Minimal HTTP `Range` header parsing (RFC 9110 §14) for single byte ranges.
 *
 * Multi-range sets and non-byte units are deliberately not supported: media
 * elements only ever issue single byte ranges, and anything we do not
 * understand falls back to a plain `200` full-body response, which is always
 * a legal answer to a range request.
 */

export type RangeParseResult =
  /** Serve the inclusive byte range with a 206 Partial Content response. */
  | { readonly kind: 'range'; readonly start: number; readonly end: number }
  /** No overlap with the representation — answer 416 Range Not Satisfiable. */
  | { readonly kind: 'unsatisfiable' }
  /** Header absent or unsupported — ignore it and serve the full body (200). */
  | { readonly kind: 'ignored' };

export function parseRangeHeader(header: string | null, size: number): RangeParseResult {
  if (!header) return { kind: 'ignored' };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return { kind: 'ignored' };
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return { kind: 'ignored' };

  // An empty representation cannot satisfy any range.
  if (size <= 0) return { kind: 'unsatisfiable' };

  if (!startRaw) {
    // Suffix range: the last N bytes. A zero-length suffix is invalid.
    const suffixLength = Number(endRaw);
    if (suffixLength <= 0) return { kind: 'unsatisfiable' };
    return {
      kind: 'range',
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(startRaw);
  const end = endRaw ? Math.min(Number(endRaw), size - 1) : size - 1;
  if (start >= size || start > end) return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
}
