import type { Action } from '@/lib/types/action';
import { useCanvasStore } from '@/lib/store/canvas';

/**
 * Which canvas effect a cue glyph replays on hover.
 * `none` = tooltip only, no canvas effect (the cue has no bound slide element).
 */
export type CuePreview =
  | { kind: 'spotlight'; elementId: string }
  | { kind: 'laser'; elementId: string }
  | { kind: 'none' };

/**
 * Decide how a cue should replay on the edit canvas.
 *
 * A `laser` cue must replay as the real laser pointer — NOT a spotlight (the
 * original ActionsBar fired `setSpotlight` for every cue, so laser cues were
 * wrongly rendered as a spotlight). Every other element-bound cue (spotlight,
 * play_video, whiteboard draws that carry a slide elementId) keeps the
 * spotlight highlight. A cue with no bound element gets no canvas preview.
 */
export function cuePreviewFor(action: Action): CuePreview {
  const elementId = (action as { elementId?: string }).elementId;
  if (!elementId) return { kind: 'none' };
  if (action.type === 'laser') return { kind: 'laser', elementId };
  return { kind: 'spotlight', elementId };
}

// ---- canvas-side effect (single home for the setSpotlight/setLaser dance) ----

/** Clear any spotlight/laser preview from the canvas. */
export function clearCuePreview(): void {
  const cs = useCanvasStore.getState();
  cs.setSpotlight('');
  cs.clearLaser();
}

/**
 * Replay a cue effect for an explicit cue type + element on the canvas, clearing
 * the sibling effect first so a previous hover never lingers. `laser` drives the
 * laser pointer, anything else drives the spotlight.
 */
export function previewCueEffect(cueType: string, elementId: string): void {
  clearCuePreview();
  if (!elementId) return;
  if (cueType === 'laser') useCanvasStore.getState().setLaser(elementId);
  else useCanvasStore.getState().setSpotlight(elementId);
}

/** Apply the preview decided by {@link cuePreviewFor}. */
export function applyCuePreview(preview: CuePreview): void {
  if (preview.kind === 'none') {
    clearCuePreview();
    return;
  }
  previewCueEffect(preview.kind, preview.elementId);
}
