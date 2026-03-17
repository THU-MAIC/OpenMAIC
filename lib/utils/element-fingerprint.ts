import type { PPTElement } from '@/lib/types/slides';

/**
 * Generate a fingerprint string for a list of whiteboard elements.
 * Used for change detection and deduplication in history snapshots.
 *
 * Includes id, position, and size so that drag/resize changes are detected,
 * not just element additions/removals.
 *
 * Note: PPTLineElement omits `height` from PPTBaseElement, so we use
 * a type guard instead of a direct property access.
 */
export function elementFingerprint(els: PPTElement[]): string {
  return els
    .map(
      (e) =>
        `${e.id}:${e.left ?? 0},${e.top ?? 0},${'width' in e ? e.width : 0},${'height' in e && e.height != null ? e.height : 0}`,
    )
    .join('|');
}
