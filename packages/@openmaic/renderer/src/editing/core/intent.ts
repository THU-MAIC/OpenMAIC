import type { EditIntent } from '../types';

/**
 * Build the `element.update` intent for a completed move gesture: the host
 * applies `props` (the element's new `left`/`top`) and owns undo. Pure
 * construction — no React, no store, no `@/` imports.
 */
export function moveIntent(id: string, props: { left: number; top: number }): EditIntent {
  return { type: 'element.update', id, props };
}
