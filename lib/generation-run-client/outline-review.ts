/**
 * The classic outline review, as the browser keeps it for a run that waits
 * for its outline to be confirmed: the review editor when the learner asked
 * for it (always-review, or by opening the streaming card), else a 2.5 s beat
 * on the outline-ready card before generation continues on its own. A run
 * already waiting when the page attaches (opened from its course card, or a
 * reload) shows the review: nobody is watching a countdown there.
 */
export const OUTLINE_REVIEW_AUTO_CONTINUE_MS = 2500;

export function outlineReviewPhase(input: {
  /** The run was waiting for confirmation when this page first caught up with it. */
  attachedWaiting: boolean;
  reviewOutlineEnabled: boolean;
  reviewIntent: boolean;
}): 'review' | 'outline-ready' {
  return input.attachedWaiting || input.reviewOutlineEnabled || input.reviewIntent
    ? 'review'
    : 'outline-ready';
}

/** The auto-continue countdown: one pending confirmation at a time. */
export function createAutoContinue(
  confirm: () => void,
  delayMs = OUTLINE_REVIEW_AUTO_CONTINUE_MS,
): { arm: () => void; cancel: () => void; armed: () => boolean } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    arm: () => {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        confirm();
      }, delayMs);
    },
    cancel,
    armed: () => timer !== null,
  };
}
