/**
 * The classic outline review, as the preview shows it. The run decides when
 * its outline is confirmed; the preview never confirms on a timer:
 *
 * - a `countdown` run (the learner does not always review outlines) waits a
 *   moment once its outline is ready, then confirms it itself. The preview
 *   shows the outline-ready card meanwhile; opening the review (mid-stream
 *   or on that card) holds the run first, which then waits for the learner;
 * - a `wait` run (the learner always reviews outlines, or held the run)
 *   waits for the learner's confirmation: every tab or page that shows it
 *   shows the review once the outline is ready.
 */
export type PreviewPhase = 'progress' | 'outline-ready' | 'review';

export interface PreviewPhaseInput {
  phase: PreviewPhase;
  state: string;
  /** How the run's outline is confirmed now. */
  outlineReview: 'wait' | 'countdown' | 'auto';
  /** The outline is still streaming (no outline is ready yet). */
  outlineStreaming: boolean;
  hasOutline: boolean;
  /** This is the first time the page caught up with the run. */
  firstAttach: boolean;
  /** The learner opened the review while the outline streamed (and has not collapsed it). */
  reviewIntent: boolean;
  /** This page's confirmation lost to one made elsewhere; its edits are still shown. */
  confirmConflict: boolean;
}

/** What the preview shows for the run's outline: the progress card, the outline-ready card or the review. */
export function nextPreviewPhase(input: PreviewPhaseInput): PreviewPhase {
  let phase = input.phase;
  // A reload while the learner had the review open mid-stream.
  if (input.firstAttach && input.outlineStreaming && input.reviewIntent) phase = 'review';
  if (input.state === 'awaiting_outline_confirmation') {
    if (phase === 'review') return phase;
    return input.outlineReview === 'countdown' ? 'outline-ready' : 'review';
  }
  if (input.confirmConflict && phase === 'review') return phase;
  // A failure shows on the progress card with its Retry; a confirmed outline
  // (here, elsewhere or by the run itself) moves on to generation.
  if (phase === 'outline-ready' || input.state === 'paused') return 'progress';
  if (phase === 'review' && !input.outlineStreaming && input.hasOutline) return 'progress';
  return phase;
}
