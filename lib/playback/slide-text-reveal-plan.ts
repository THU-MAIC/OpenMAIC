import { ElementTypes, type PPTElement } from '@/lib/types/slides';
import { htmlPlainTextLength } from '@/lib/utils/html-plain-text-length';

export interface SlideTextRevealRange {
  readonly start: number;
  readonly end: number;
}

/** Ordered character ranges for text-bearing elements (slide element order). */
export function buildSlideTextRevealPlan(elements: PPTElement[]): {
  readonly totalUnits: number;
  readonly unitsById: Readonly<Record<string, SlideTextRevealRange>>;
} {
  let total = 0;
  const unitsById: Record<string, SlideTextRevealRange> = {};

  for (const el of elements) {
    if (el.type === ElementTypes.TEXT) {
      const len = htmlPlainTextLength(el.content || '');
      if (len > 0) {
        unitsById[el.id] = { start: total, end: total + len };
        total += len;
      }
    } else if (el.type === ElementTypes.SHAPE) {
      const html = el.text?.content || '';
      const len = htmlPlainTextLength(html);
      if (len > 0) {
        unitsById[el.id] = { start: total, end: total + len };
        total += len;
      }
    }
  }

  return { totalUnits: total, unitsById };
}

/**
 * Map global narration progress (0–1) to this element's reveal amount (0–1).
 * Returns null when this element has no text in the plan (full visibility).
 */
export function localSlideTextReveal(
  global: number | null,
  totalUnits: number,
  range: SlideTextRevealRange | undefined,
): number | null {
  if (global === null) return null;
  if (!range || totalUnits <= 0) return null;
  const pos = global * totalUnits;
  if (pos <= range.start) return 0;
  if (pos >= range.end) return 1;
  return (pos - range.start) / (range.end - range.start);
}
