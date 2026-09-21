/**
 * The audio element discussion playback reuses for every line.
 *
 * Mobile autoplay policies only cover an element that a user gesture has
 * reached, so an element minted per line gets its programmatic `play()` refused
 * with NotAllowedError from the second line on: the discussion goes silent
 * while the lesson keeps advancing. One element, handed every line, stays
 * playable for the rest of the lesson — but only if that element was reached
 * inside the gesture. Creating it after the TTS fetch is too late for a strict
 * per-element policy; `primeDiscussionAudioElement` does the unlock while the
 * click is still on the stack.
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

/**
 * A short silent WAV. `play()` with no source rejects and does not unlock the
 * element, and assigning `src = ''` would point it at the page URL.
 */
const UNLOCK_SRC =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

/** The discussion element, created on first use and reused by every line. */
export function getDiscussionAudioElement(): HTMLAudioElement {
  if (!element) {
    element = new Audio();
    element.preload = 'auto';
  }
  return element;
}

/**
 * Unlocks the shared element during the user gesture that starts discussion.
 *
 * Call it synchronously, before any `await`. The `play()` invocation itself is
 * what a strict per-element policy remembers; the clip is muted, paused, and
 * released before this returns so it cannot be heard and cannot leave a source
 * for the next line. A line already loaded on the element is left alone —
 * replacing `src` would drop audio that is playing or waiting to resume.
 */
export function primeDiscussionAudioElement(): void {
  const audio = getDiscussionAudioElement();
  if (audio.src) return;

  const previousMuted = audio.muted;
  audio.muted = true;
  audio.src = UNLOCK_SRC;
  try {
    const pending = audio.play();
    audio.pause();
    // Immediate pause aborts the unlock clip. Outside a gesture `play()` is
    // refused; either way the rejection must not escape the click handler.
    void Promise.resolve(pending).catch(() => {});
  } catch {
    // Synchronous rejection: nothing started.
  } finally {
    audio.muted = previousMuted;
    if (audio.src === UNLOCK_SRC) {
      releaseDiscussionAudioLine(audio);
    }
  }
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
