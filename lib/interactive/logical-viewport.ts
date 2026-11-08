import type { ClientBox } from '@/lib/edit/visible-client-rect';

/**
 * The minimum CSS viewport every generated interactive page is authored against.
 * The frame never gets smaller than this; it grows along whichever axis the
 * slot has to spare, so a page always fills its slot.
 */
export const GENUI_LOGICAL_WIDTH = 1280;
export const GENUI_LOGICAL_HEIGHT = 720;

export interface FittedGenUiViewport {
  /** Screen box the scaled frame covers. Always the whole slot. */
  readonly box: ClientBox;
  /** Screen pixels per logical CSS pixel. */
  readonly scale: number;
  /** Logical CSS width of the page's viewport (at least {@link GENUI_LOGICAL_WIDTH}). */
  readonly width: number;
  /** Logical CSS height of the page's viewport (at least {@link GENUI_LOGICAL_HEIGHT}). */
  readonly height: number;
}

/**
 * Fit a GenUI frame to an arbitrary screen slot with no letterboxing.
 *
 * The scale keeps the 1280×720 minimum fully on screen; the logical viewport
 * then takes the slot's own aspect, so one side stays at its minimum and the
 * other grows. A slot with no measurable size collapses to scale 0 at the
 * minimum logical size.
 */
export function fitGenUiViewport(slot: ClientBox): FittedGenUiViewport {
  const scale = Math.max(
    0,
    Math.min(slot.width / GENUI_LOGICAL_WIDTH, slot.height / GENUI_LOGICAL_HEIGHT),
  );
  const width = scale > 0 ? Math.max(GENUI_LOGICAL_WIDTH, slot.width / scale) : GENUI_LOGICAL_WIDTH;
  const height =
    scale > 0 ? Math.max(GENUI_LOGICAL_HEIGHT, slot.height / scale) : GENUI_LOGICAL_HEIGHT;
  return {
    scale,
    width,
    height,
    box: {
      left: slot.left,
      top: slot.top,
      width: scale > 0 ? slot.width : 0,
      height: scale > 0 ? slot.height : 0,
    },
  };
}
