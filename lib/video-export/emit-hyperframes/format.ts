/**
 * Shared text formatting for the Hyperframes emitter: HTML escaping and the
 * ms→seconds conversion used by both the composition HTML ({@link ./index}) and
 * the effect tweens ({@link ./effects}). One definition each so the two layers
 * can't drift — e.g. two escapers with different rule sets emitting into the same
 * document, or two `sec` helpers with different rounding.
 *
 * Pure: string/number formatting only.
 */

/**
 * Escape a string for embedding in HTML text or a double-quoted attribute value.
 * Covers `& < > "` — the full set, so it is safe for both element text and
 * attribute values (colors, asset URLs, titles, diagnostic reasons).
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Millisecond offset → seconds on the composition clock, trimmed to 4 decimals. */
export function sec(ms: number): number {
  return Number((ms / 1000).toFixed(4));
}
