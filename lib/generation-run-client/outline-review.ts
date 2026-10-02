/**
 * The classic outline review, as the browser keeps it for a run that waits
 * for its outline to be confirmed: the review editor when the learner asked
 * for it (always-review, or by opening the streaming card), else a 2.5 s beat
 * on the outline-ready card before generation continues on its own. The beat
 * belongs to the tab whose composer started the run only: any other tab (one
 * opened from the course card, another device, a second tab that watched the
 * outline stream) shows the review, so two tabs never both confirm on a timer.
 */
export const OUTLINE_REVIEW_AUTO_CONTINUE_MS = 2500;

function startedHereKey(runId: string): string {
  return `generationRunStartedHere:${runId}`;
}

/**
 * Remember that this tab's composer started the run: its preview is the page
 * that started generation, not one opened on a waiting run, even when the
 * outline was ready before the preview attached.
 */
export function markRunStartedHere(runId: string): void {
  try {
    sessionStorage.setItem(startedHereKey(runId), '1');
  } catch {
    /* sessionStorage unavailable: the preview treats the run as opened later */
  }
}

export function wasRunStartedHere(runId: string): boolean {
  try {
    return sessionStorage.getItem(startedHereKey(runId)) === '1';
  } catch {
    return false;
  }
}

export function forgetRunStartedHere(runId: string): void {
  try {
    sessionStorage.removeItem(startedHereKey(runId));
  } catch {
    /* ignore */
  }
}

export type PreviewPhase = 'progress' | 'outline-ready' | 'review';

export interface PreviewPhaseInput {
  phase: PreviewPhase;
  state: string;
  /** The outline is still streaming (no outline is ready yet). */
  outlineStreaming: boolean;
  hasOutline: boolean;
  /** This is the first time the page caught up with the run. */
  firstAttach: boolean;
  /** This tab's composer started the run. */
  startedHere: boolean;
  reviewOutlineEnabled: boolean;
  /** The learner opened the review (and has not collapsed it). */
  reviewIntent: boolean;
  /** This page's confirmation lost to one made elsewhere; its edits are still shown. */
  confirmConflict: boolean;
}

/** What the preview shows for the run's outline, and whether the auto-continue beat starts or stops. */
export function nextPreviewPhase(input: PreviewPhaseInput): {
  phase: PreviewPhase;
  armAutoContinue: boolean;
  cancelAutoContinue: boolean;
} {
  let phase = input.phase;
  // A reload while the learner had the review open mid-stream.
  if (input.firstAttach && input.outlineStreaming && input.reviewIntent) phase = 'review';
  if (input.state !== 'awaiting_outline_confirmation') {
    if (input.confirmConflict && phase === 'review') {
      return { phase, armAutoContinue: false, cancelAutoContinue: true };
    }
    // A failure shows on the progress card with its Retry; a confirmed outline
    // (here or elsewhere) moves on to generation.
    if (phase === 'outline-ready' || input.state === 'paused') phase = 'progress';
    if (phase === 'review' && !input.outlineStreaming && input.hasOutline) phase = 'progress';
    return { phase, armAutoContinue: false, cancelAutoContinue: true };
  }
  if (phase !== 'progress') return { phase, armAutoContinue: false, cancelAutoContinue: false };
  const review = !input.startedHere || input.reviewOutlineEnabled || input.reviewIntent;
  return review
    ? { phase: 'review', armAutoContinue: false, cancelAutoContinue: true }
    : { phase: 'outline-ready', armAutoContinue: true, cancelAutoContinue: false };
}

/** The auto-continue countdown: one pending confirmation (of the payload armed last) at a time. */
export function createAutoContinue<T>(
  confirm: (payload: T) => void,
  delayMs = OUTLINE_REVIEW_AUTO_CONTINUE_MS,
): { arm: (payload: T) => void; cancel: () => void; armed: () => boolean } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    arm: (payload: T) => {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        confirm(payload);
      }, delayMs);
    },
    cancel,
    armed: () => timer !== null,
  };
}
