/**
 * The classic outline review, as the preview shows it. A run started with
 * `outlineReview: "auto"` (the learner did not ask to review outlines)
 * confirms its own outline on the server: the preview shows the outline
 * read-only and never confirms it. A run started with `outlineReview: "wait"`
 * (the learner asked to always review) waits for the learner's confirmation
 * in any tab or page that shows it: the preview shows the review editor once
 * the outline is ready, or while it streams if the learner opened it.
 */
export type PreviewPhase = 'progress' | 'review';

export interface PreviewPhaseInput {
  phase: PreviewPhase;
  state: string;
  /** How the run's outline is confirmed. */
  outlineReview: 'wait' | 'auto';
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

/** What the preview shows for the run's outline: the progress card or the review editor. */
export function nextPreviewPhase(input: PreviewPhaseInput): PreviewPhase {
  // The server confirms the outline: there is nothing to review.
  if (input.outlineReview === 'auto') return 'progress';
  let phase = input.phase;
  // A reload while the learner had the review open mid-stream.
  if (input.firstAttach && input.outlineStreaming && input.reviewIntent) phase = 'review';
  if (input.state === 'awaiting_outline_confirmation') return 'review';
  if (input.confirmConflict && phase === 'review') return phase;
  // A failure shows on the progress card with its Retry; a confirmed outline
  // (here or elsewhere) moves on to generation.
  if (input.state === 'paused') return 'progress';
  if (phase === 'review' && !input.outlineStreaming && input.hasOutline) return 'progress';
  return phase;
}
