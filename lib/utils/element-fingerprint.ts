import type { PPTElement } from '@/lib/types/slides';

/**
 * Extract the semantic payload for each element type.
 * Used by elementFingerprint to detect content-only changes
 * (same id/position but different text, chart data, media src, etc.).
 */
function semanticPart(e: PPTElement): unknown {
  switch (e.type) {
    case 'text':
      return { content: e.content };
    case 'image':
      return { src: e.src };
    case 'shape':
      return {
        path: e.path,
        fill: e.fill,
        text: e.text?.content ?? '',
        gradient: e.gradient ?? null,
        pattern: e.pattern ?? null,
      };
    case 'line':
      return {
        start: e.start,
        end: e.end,
        color: e.color,
        style: e.style,
        points: e.points,
      };
    case 'chart':
      return {
        chartType: e.chartType,
        data: e.data,
        themeColors: e.themeColors,
      };
    case 'table':
      return {
        data: e.data.map((row) => row.map((c) => c.text)),
        colWidths: e.colWidths,
        theme: e.theme ?? null,
      };
    case 'latex':
      return { latex: e.latex };
    case 'video':
      return { src: e.src, poster: e.poster ?? '' };
    case 'audio':
      return { src: e.src };
    default: {
      const exhaustiveCheck: never = e;
      return exhaustiveCheck;
    }
  }
}

/**
 * Generate a fingerprint string for a list of whiteboard elements.
 * Used for change detection and deduplication in history snapshots.
 *
 * Covers both geometry (id, position, size) AND semantic content
 * via structured JSON.stringify — avoids delimiter-collision issues
 * that hand-concatenated strings would have with rich-text HTML content.
 */
export function elementFingerprint(els: PPTElement[]): string {
  return JSON.stringify(
    els.map((e) => ({
      id: e.id,
      left: e.left ?? 0,
      top: e.top ?? 0,
      width: 'width' in e ? e.width : 0,
      height: 'height' in e && e.height != null ? e.height : 0,
      sem: semanticPart(e),
    })),
  );
}
