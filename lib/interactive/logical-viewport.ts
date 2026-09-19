import type { ClientBox } from '@/lib/edit/visible-client-rect';

/** The stable CSS viewport every generated interactive page is authored against. */
export const GENUI_LOGICAL_WIDTH = 1280;
export const GENUI_LOGICAL_HEIGHT = 720;

export interface FittedGenUiViewport {
  readonly box: ClientBox;
  readonly scale: number;
}

/** Center one fixed logical GenUI viewport inside an arbitrary screen slot. */
export function fitGenUiViewport(slot: ClientBox): FittedGenUiViewport {
  const scale = Math.max(
    0,
    Math.min(slot.width / GENUI_LOGICAL_WIDTH, slot.height / GENUI_LOGICAL_HEIGHT),
  );
  const width = GENUI_LOGICAL_WIDTH * scale;
  const height = GENUI_LOGICAL_HEIGHT * scale;
  return {
    scale,
    box: {
      left: slot.left + (slot.width - width) / 2,
      top: slot.top + (slot.height - height) / 2,
      width,
      height,
    },
  };
}
