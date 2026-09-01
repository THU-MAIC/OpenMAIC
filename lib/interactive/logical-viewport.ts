import type { ClientBox } from '@/lib/edit/visible-client-rect';

export interface FittedGenUiViewport {
  readonly box: ClientBox;
  readonly scale: number;
}

/** Give generated HTML the real learner slot so its responsive CSS can run. */
export function fitGenUiViewport(slot: ClientBox): FittedGenUiViewport {
  return {
    scale: 1,
    box: slot,
  };
}
