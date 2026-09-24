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
 * 20ms of 16-bit PCM silence. `play()` with no source rejects and does not
 * unlock the element. A WAV whose data chunk is empty (`dataSize = 0`) can be
 * treated as undecodable, which also fails to mark the element user-activated.
 * Assigning `src = ''` would point it at the page URL.
 */
const UNLOCK_SRC = silentWavDataUrl(160);

function silentWavDataUrl(sampleCount: number): string {
  const dataSize = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

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
 * what a strict per-element policy remembers. The clip is muted. Pausing or
 * calling `load()` before that `play()` settles cancels it on iOS Safari:
 * `load()` resets the element to `HAVE_NOTHING`, and the element never counts
 * as user-activated. Pause only runs after `play()` fulfills, and the silent
 * source stays loaded so the first real line replaces it. A rejected `play()`
 * is caught on the play result; the silent source is dropped so a later
 * gesture can try again. A line already loaded on the element is left alone —
 * replacing `src` would drop audio that is playing or waiting to resume.
 */
export function primeDiscussionAudioElement(): void {
  const audio = getDiscussionAudioElement();
  if (audio.src) return;

  const previousMuted = audio.muted;
  audio.muted = true;
  audio.src = UNLOCK_SRC;
  try {
    settleUnlockPlay(audio, audio.play());
  } catch {
    // Synchronous rejection: nothing started.
    releaseUnlockIfCurrent(audio);
  } finally {
    audio.muted = previousMuted;
  }
}

function releaseUnlockIfCurrent(audio: HTMLAudioElement): void {
  if (audio.src === UNLOCK_SRC) releaseDiscussionAudioLine(audio);
}

/**
 * `play()` returns a Promise in browsers. Pause only on fulfillment, and
 * attach `catch` to that same object so a refusal cannot escape the click.
 */
function settleUnlockPlay(audio: HTMLAudioElement, pending: unknown): void {
  if (
    !pending ||
    typeof pending !== 'object' ||
    typeof (pending as { then?: unknown }).then !== 'function'
  ) {
    releaseUnlockIfCurrent(audio);
    return;
  }
  const result = pending as {
    then: (onFulfilled: () => void, onRejected?: (reason: unknown) => void) => unknown;
    catch?: (onRejected: (reason: unknown) => void) => unknown;
  };
  // The rejection handler passed to `then` keeps the derived promise from
  // rejecting unhandled. `catch` is invoked on the play() result itself.
  void result.then(
    () => {
      if (audio.src === UNLOCK_SRC) audio.pause();
    },
    () => {
      releaseUnlockIfCurrent(audio);
    },
  );
  if (typeof result.catch === 'function') {
    void result.catch(() => {
      releaseUnlockIfCurrent(audio);
    });
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
