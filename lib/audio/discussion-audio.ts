/**
 * The audio element discussion playback reuses for every line.
 *
 * Mobile autoplay policies only cover an element that a user gesture has
 * reached, so an element minted per line gets its programmatic `play()` refused
 * with NotAllowedError from the second line on: the discussion goes silent
 * while the lesson keeps advancing. One element, handed every line, stays
 * playable for the rest of the lesson.
 *
 * Deliberately separate from the narration element in `AudioPlayer`: sharing a
 * single element would let a discussion line cut the narrator off, and vice
 * versa.
 *
 * Module scope means one element per page, so there must be a single consumer:
 * a second mounted hook would overwrite the first one's source and handlers, and
 * the first would then wait forever.
 */
let element: HTMLAudioElement | null = null;

/** The discussion element, created on first use and reused by every line. */
export function getDiscussionAudioElement(): HTMLAudioElement {
  if (!element) {
    element = new Audio();
    element.preload = 'auto';
  }
  return element;
}

/**
 * Drops the element so a test starts from a clean module state. The element is
 * module scoped (one per page, like the narration player), so without this a
 * later test would silently inherit the first test's stubbed element.
 */
export function resetDiscussionAudioElementForTests(): void {
  element = null;
}

/**
 * Releases a line's state from the element without discarding the element.
 *
 * An empty string is not "no source": `src = ''` points the element at the
 * page's own URL and starts a load that fails asynchronously with an `error`
 * event. On a reused element that late error can land on the *next* line's
 * handler and finish it before it is heard. Removing the attribute and calling
 * `load()` leaves the element idle and silent instead — the same shape as
 * `stopAudioElement()` in `lib/utils/audio-player.ts`.
 */
export function releaseDiscussionAudioLine(element: HTMLAudioElement): void {
  element.onended = null;
  element.onerror = null;
  element.pause();
  element.removeAttribute('src');
  element.load?.();
}
